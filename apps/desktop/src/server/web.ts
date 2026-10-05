/**
 * Web tools for the AI agent: `web_search` (DuckDuckGo HTML, no API key) and
 * `fetch_url` (page → readable text).
 *
 * The model chooses the URLs, so every request is treated as untrusted:
 * only http(s), no loopback/private/link-local targets (checked after DNS
 * resolution and on every redirect), bounded time and size.
 */
import * as dns from 'dns';
import * as net from 'net';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_REDIRECTS = 4;
const UA = 'Mozilla/5.0 (compatible; zeithub-otto/0.1)';

export const WEB_TOOLS = new Set(['web_search', 'fetch_url']);

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/** Throws when `raw` is not a public http(s) URL. */
async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host)
    ? [host]
    : (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateIp)) {
    throw new Error('Refusing to access local/private network addresses');
  }
  return url;
}

/** GET with manual redirects (each hop re-validated), timeout and size cap. */
async function safeGet(raw: string): Promise<{ url: string; type: string; body: string }> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size >= MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
    return { url: url.toString(), type, body: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('Too many redirects');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)));
}

/** HTML → plain readable text (scripts/styles/nav dropped, block tags → newlines). */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return (title ? `${decodeEntities(title).trim()}\n\n` : '') + text;
}

export async function fetchUrl(rawUrl: string): Promise<string> {
  const { url, type, body } = await safeGet(rawUrl);
  const text = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body) : body;
  const clipped = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n… (обрезано)` : text;
  return `URL: ${url}\n\n${clipped || '(пустая страница)'}`;
}

export interface SearchHit {
  title: string;
  href: string;
  snippet: string;
}

const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** DuckDuckGo wraps result links as `//duckduckgo.com/l/?uddg=<encoded url>`. */
function unwrapDdg(href: string): string {
  const h = decodeEntities(href);
  const m = /[?&]uddg=([^&]+)/.exec(h);
  return m ? decodeURIComponent(m[1]) : h;
}

/**
 * Result lists are cut into one chunk per result before picking the pieces:
 * a single regex with a lazy gap and an OPTIONAL snippet group never captures
 * the snippet (the lazy gap matches nothing and the optional group is skipped).
 */
export function parseDdgHtml(body: string): SearchHit[] {
  const out: SearchHit[] = [];
  // lookahead split keeps the opening <a …> in its chunk, whatever the attribute order
  for (const chunk of body.split(/(?=<a[^>]*class="result__a")/).filter((c) => c.startsWith('<a'))) {
    const href = /href="([^"]+)"/.exec(chunk);
    const title = />([\s\S]*?)<\/a>/.exec(chunk);
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(chunk);
    if (href && title && stripTags(title[1])) {
      out.push({ title: stripTags(title[1]), href: unwrapDdg(href[1]), snippet: stripTags(snippet?.[1] ?? '') });
    }
    if (out.length >= 8) break;
  }
  return out;
}

/** Result list of DuckDuckGo's lite page. */
export function parseLite(body: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const chunk of body.split(/(?=<a[^>]*class=['"]result-link['"])/).filter((c) => c.startsWith('<a'))) {
    const href = /href="([^"]+)"/.exec(chunk);
    const title = />([\s\S]*?)<\/a>/.exec(chunk);
    const snippet = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/.exec(chunk);
    if (href && title && stripTags(title[1])) {
      out.push({ title: stripTags(title[1]), href: unwrapDdg(href[1]), snippet: stripTags(snippet?.[1] ?? '') });
    }
    if (out.length >= 8) break;
  }
  return out;
}

/** Bing wraps result links as `bing.com/ck/a?…&u=a1<base64url of the real url>`. */
export function unwrapBing(href: string): string {
  const h = decodeEntities(href);
  const m = /[?&]u=a1([^&]+)/.exec(h);
  if (!m) return h;
  try {
    const url = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^https?:\/\//.test(url) ? url : h;
  } catch {
    return h;
  }
}

export function parseBing(body: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const block of body.split('<li class="b_algo"').slice(1)) {
    const link = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const title = stripTags(link[2]);
    if (title) out.push({ title, href: unwrapBing(link[1]), snippet: stripTags(snippet?.[1] ?? '') });
    if (out.length >= 8) break;
  }
  return out;
}

const PROVIDERS: Array<{ name: string; url: (q: string) => string; parse: (body: string) => SearchHit[] }> = [
  { name: 'DuckDuckGo', url: (q) => `https://html.duckduckgo.com/html/?q=${q}`, parse: parseDdgHtml },
  { name: 'DuckDuckGo lite', url: (q) => `https://lite.duckduckgo.com/lite/?q=${q}`, parse: parseLite },
  { name: 'Bing', url: (q) => `https://www.bing.com/search?q=${q}&setlang=en`, parse: parseBing },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Search engines throttle scripted traffic and drop connections at random, so
 * one failure must not fail the tool: two attempts per engine, then the next.
 */
export async function webSearch(query: string): Promise<string> {
  const q = encodeURIComponent(query);
  const errors: string[] = [];
  for (const provider of PROVIDERS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { body } = await safeGet(provider.url(q));
        const hits = provider.parse(body);
        if (hits.length > 0) {
          const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.href}${h.snippet ? `\n   ${h.snippet}` : ''}`);
          return `${lines.join('\n')}\n\nОткрой нужную страницу через fetch_url(url).`;
        }
        await sleep(350); // empty / soft-blocked answer: retry once, then the next engine
      } catch (exc) {
        errors.push(`${provider.name}: ${exc instanceof Error ? exc.message : String(exc)}`);
        await sleep(350);
      }
    }
  }
  return errors.length
    ? `Поиск временно недоступен (${errors.slice(-2).join('; ')}). Попробуй позже или открой известный сайт документации напрямую через fetch_url.`
    : `По запросу «${query}» ничего не найдено.`;
}

/** Entry point used by the agent loop; never throws (errors become tool output). */
export async function runWebTool(name: string, args: unknown): Promise<string> {
  const params = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  try {
    if (name === 'web_search') {
      const query = String(params.query ?? '').trim();
      return query ? await webSearch(query) : "Usage: web_search requires 'query'";
    }
    const url = String(params.url ?? '').trim();
    return url ? await fetchUrl(url) : "Usage: fetch_url requires 'url'";
  } catch (exc) {
    return `Tool failed: ${exc instanceof Error ? exc.message : String(exc)}`;
  }
}
