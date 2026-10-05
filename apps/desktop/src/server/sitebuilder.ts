/**
 * Site builder: how a small model makes a multi-page site it could never hold in its head at once.
 *
 * All the creative work is the MODEL's — the design idea, style.css, the header and footer, script.js and
 * every page — but in small steps, each a short schema-bound question in a fresh context:
 *   map → design idea → style.css → header + footer → script.js → page 1 … page N
 * Otto only runs the process: it carries the results of earlier steps into the next ones (the design idea,
 * the class names of the model's own CSS, the page list), puts the pages together with the model's shared
 * header and footer, and checks every step (a thin answer is asked again). Otto's own look (otto-base.css)
 * is only a safety net under a stylesheet the model could not write at all.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CLASSLESS_CSS } from './designkit';
import { inspectPage, replaceBrokenImages } from './visualqa';

export interface SitePage { file: string; title: string; purpose: string; sections: string[] }
export interface SiteMap { site: string; tagline: string; pages: SitePage[] }
export interface DesignIdea { style: string; mood: string; palette: Record<string, string>; fonts: string; components: string[] }

/** A request for a site with several pages ("сайт из 5 страниц", "страницы: главная, меню, контакты…"). */
export function wantsMultiPageSite(prompt: string): boolean {
  if (!/(сайт|website|site|лендинг|landing)/i.test(prompt)) return false;
  if (/(\d+|двух|тр[её]х|четыр|пят|шест|сем|восьм|several|multiple|few)\s*-?\s*(страниц|pages)/i.test(prompt)) return true;
  const list = /(страниц[аы]?|pages)\s*[:—-]\s*([^.\n]+)/i.exec(prompt);
  return Boolean(list && list[2].split(/,|;| и | and /).filter((x) => x.trim()).length >= 3);
}

const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const str = { type: 'string' };
const strList = { type: 'array', items: str };
const MAP_SCHEMA = obj({ site: str, tagline: str, pages: { type: 'array', items: obj({ file: str, title: str, purpose: str, sections: strList }) } });
const IDEA_SCHEMA = obj({ style: str, mood: str, palette: obj({ background: str, surface: str, text: str, primary: str, accent: str }), fonts: str, components: strList });

type Chat = (messages: Array<{ role: string; content: string }>, format: unknown, numPredict: number) => Promise<string>;

/** One schema-bound call to an Ollama model. */
export function ollamaChat(baseUrl: string, model: string, timeoutMs = 300_000): Chat {
  return async (messages, format, numPredict) => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, format, messages, options: { temperature: 0.6, num_ctx: 8192, num_predict: numPredict } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${model}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json() as { message?: { content?: string } };
    return data.message?.content ?? '';
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const field = (raw: string, key: string): string => { try { return String((JSON.parse(raw) as Record<string, unknown>)[key] ?? ''); } catch { return ''; } };
const stripFences = (s: string) => s.replace(/```[a-z]*\n?|```/g, '').trim();

/** Clean up the model's page list: index.html first, unique .html names, 2–8 pages. */
export function normalizeMap(map: SiteMap): SiteMap {
  const seen = new Set<string>();
  const pages: SitePage[] = [];
  for (const [i, p] of (map.pages ?? []).entries()) {
    let file = String(p.file || '').trim().toLowerCase().replace(/\\/g, '/').split('/').pop() ?? '';
    if (i === 0) file = 'index.html';
    if (!/\.html$/.test(file)) file = `${slug(file.replace(/\.[a-z]+$/, '') || p.title)}.html`;
    if (!/^[a-z0-9._-]+$/.test(file)) file = `${slug(p.title)}-${i + 1}.html`;
    if (seen.has(file)) continue;
    seen.add(file);
    pages.push({ file, title: String(p.title || file).trim(), purpose: String(p.purpose || '').trim(), sections: (p.sections ?? []).map(String).filter(Boolean).slice(0, 6) });
    if (pages.length >= 8) break;
  }
  return { site: String(map.site || 'Сайт').trim(), tagline: String(map.tagline || '').trim(), pages };
}

/** Class names the model's own stylesheet defines (handed to the later steps). */
export const cssClasses = (css: string): string[] => [...new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)(?=[\s,.:{>+~[)])/g)].map((m) => m[1]))].slice(0, 60);

/** The model's <main> content: strip anything outside it the model added anyway. */
export function cleanMain(html: string): string {
  let h = stripFences(html);
  const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(h);
  if (main) h = main[1];
  else {
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(h);
    if (body) h = body[1];
  }
  return h.replace(/<(header|footer)\b[\s\S]*?<\/\1>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').trim();
}

/** A page body that is too thin to keep. */
export const thinPage = (main: string): boolean => main.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length < 250 || !/<h[1-3]/i.test(main);

/** The model's header with the current page marked. */
function markCurrent(header: string, file: string): string {
  return header.replace(new RegExp(`(<a[^>]+href=["']${file.replace('.', '\\.')}["'])`, 'i'), '$1 aria-current="page"');
}

/** The page as a file: technical head (charset, viewport, stylesheets) + the model's header, page, footer. */
export function renderPage(map: SiteMap, page: SitePage, parts: { header: string; footer: string; main: string; base: boolean }, lang: string): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(page.title)} — ${esc(map.site)}</title>
${parts.base ? '  <link rel="stylesheet" href="otto-base.css">\n' : ''}  <link rel="stylesheet" href="style.css">
</head>
<body>
${markCurrent(parts.header, page.file)}
<main>
${parts.main}
</main>
${parts.footer}
<script src="script.js"></script>
</body>
</html>
`;
}

export interface BuildEvents { status: (text: string) => void; wrote: (file: string, existed: boolean, text: string) => void }

/**
 * Build the site the request describes into `root`. Throws when the model cannot even produce the map
 * (the caller then falls back to the normal agent loop).
 */
export async function buildSite(root: string, request: string, chat: Chat, lang: string, ev: BuildEvents): Promise<SiteMap> {
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    const existed = fs.existsSync(target);
    fs.writeFileSync(target, text, 'utf8');
    ev.wrote(file, existed, text);
  };
  const langNote = `Write all visible texts in the language of the request (${lang}).`;

  // 1. the map
  ev.status('🗺️ Карта сайта…');
  const map = normalizeMap(JSON.parse(await chat([
    { role: 'system', content: `You plan websites. JSON only: site name, a short tagline, and the pages in order (the first is the home page); for each page: english file name (.html), title, one-sentence purpose, 3-5 section titles. ${langNote}` },
    { role: 'user', content: request },
  ], MAP_SCHEMA, 1500)) as SiteMap);
  if (map.pages.length < 2) throw new Error('no site map');
  const pageList = map.pages.map((p) => `${p.title} (${p.file}): ${p.purpose}`).join('\n');

  // 2. the design idea — the model's own
  ev.status('🎨 Дизайн-концепция…');
  const idea = JSON.parse(await chat([
    { role: 'system', content: 'You are a web designer. Invent a distinctive visual concept for this site that fits its topic: style, mood, a palette (hex), fonts (Google-free system / web-safe stacks), and the UI components the pages need (e.g. hero, cards grid, price list, testimonial, booking form, gallery, footer). JSON only.' },
    { role: 'user', content: `${request}\nPages:\n${pageList}` },
  ], IDEA_SCHEMA, 800)) as DesignIdea;
  const ideaText = `Style: ${idea.style}. Mood: ${idea.mood}. Palette: ${Object.entries(idea.palette ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}. Fonts: ${idea.fonts}. Components: ${(idea.components ?? []).join(', ')}.`;

  // 3. style.css — written by the model from its own idea
  ev.status('🖌️ style.css…');
  const askCss = (extra: string) => chat([
    { role: 'system', content: 'You write the complete style.css of a website from its design concept: CSS variables for the palette, typography, a header with navigation, a hero, sections, a responsive grid of cards, buttons, forms (labels, inputs, a submit button, error and success messages), a footer, hover states, and @media rules for phones (max-width 600px). Name classes clearly (e.g. .site-header, .nav, .hero, .section, .grid, .card, .btn, .form, .footer). JSON {"css": "..."} only.' },
    { role: 'user', content: `${request}\nConcept: ${ideaText}${extra}` },
  ], obj({ css: str }), 4500).then((raw) => stripFences(field(raw, 'css')));
  let css = await askCss('').catch(() => '');
  if (css.replace(/\s+/g, '').length < 1200) css = await askCss('\nThe first stylesheet was far too short. Write the FULL stylesheet: every component listed, with real values.').catch(() => css);
  // a stylesheet the model could not write at all: Otto's base look goes under it as a safety net
  const base = css.replace(/\s+/g, '').length < 600;
  write('style.css', css || '/* style.css */\n');
  if (base) write('otto-base.css', CLASSLESS_CSS);
  const classes = cssClasses(css);
  const classNote = classes.length ? `Use these classes from the site's style.css: ${classes.join(', ')}.` : 'Use semantic HTML.';

  // 4. header and footer — the model's, shared by every page
  ev.status('🧭 Шапка и подвал…');
  const layout = await chat([
    { role: 'system', content: `You write the shared header and footer HTML of a website. The header has the site name/logo and a navigation link to EVERY page (href = its file). The footer has contacts or useful links and the copyright. ${classNote} ${langNote} JSON {"header": "<header…>…</header>", "footer": "<footer…>…</footer>"} only.` },
    { role: 'user', content: `${request}\nSite: ${map.site} — ${map.tagline}\nPages:\n${pageList}\nConcept: ${ideaText}` },
  ], obj({ header: str, footer: str }), 1500).then((raw) => ({ header: stripFences(field(raw, 'header')), footer: stripFences(field(raw, 'footer')) })).catch(() => ({ header: '', footer: '' }));
  // links that the model forgot are added to its own nav (navigation must reach every page)
  let header = layout.header || `<header><strong>${esc(map.site)}</strong><nav></nav></header>`;
  const missing = map.pages.filter((p) => !header.includes(`href="${p.file}"`) && !header.includes(`href='${p.file}'`));
  if (missing.length) {
    const links = missing.map((p) => `<a href="${p.file}">${esc(p.title)}</a>`).join(' ');
    header = /<\/nav>/i.test(header) ? header.replace(/<\/nav>/i, `${links}</nav>`) : header.replace(/<\/header>/i, `<nav>${links}</nav></header>`);
  }
  const footer = layout.footer || `<footer><p>© ${new Date().getFullYear()} ${esc(map.site)}</p></footer>`;

  // 5. script.js — the model's, for the interactions its pages need
  ev.status('⚙️ script.js…');
  const js = await chat([
    { role: 'system', content: 'You write script.js for a multi-page website (plain JavaScript, no libraries; it runs on every page, so check that an element exists before using it). Make every interactive part the pages need work: forms validate their fields and show a success or error message without reloading the page (use the form\'s data-success text if present), plus any small effects that fit the concept (mobile menu toggle, smooth scroll, active link…). JSON {"js": "..."} only.' },
    { role: 'user', content: `${request}\nPages:\n${pageList}\nConcept: ${ideaText}\n${classNote}` },
  ], obj({ js: str }), 2500).then((raw) => stripFences(field(raw, 'js'))).catch(() => '');
  write('script.js', js || '// script.js\n');

  // 6. the pages, one by one
  for (const [i, page] of map.pages.entries()) {
    ev.status(`📄 ${i + 1}/${map.pages.length}: ${page.title}`);
    const ask = (extra: string) => chat([
      { role: 'system', content: `You write the content of ONE page of a website — only what goes inside <main> (no <html>, <head>, header, footer or script tags; those are shared). Make it rich and fitting the concept: a strong first block, then every listed section as <section> with an <h2>, real specific texts, items with prices where relevant, quotes, and forms with <label>s, named inputs, a submit button and data-success="…" on the <form>. ${classNote} ${langNote} JSON {"html": "..."} only.` },
      { role: 'user', content: `Site: ${map.site} — ${map.tagline}\nConcept: ${ideaText}\nAll pages: ${map.pages.map((p) => p.title).join(', ')}\nThis page: ${page.title} — ${page.purpose}\nSections: ${page.sections.join('; ')}\nRequest: ${request}${extra}` },
    ], obj({ html: str }), 3500).then((raw) => cleanMain(field(raw, 'html')));
    let main = await ask('').catch(() => '');
    if (thinPage(main)) main = await ask('\nThe first attempt was too short. Write every listed section with several sentences or items.').catch(() => main);
    if (!main.trim()) main = page.sections.map((s) => `<section>\n  <h2>${esc(s)}</h2>\n</section>`).join('\n');
    write(page.file, renderPage(map, page, { header, footer, main, base }, lang));
  }

  // 7. visual check in a real browser: the model fixes its OWN style.css from what is broken on screen
  let placeholders = 0;
  for (const page of map.pages) placeholders += replaceBrokenImages(root, page.file);
  for (let round = 1; round <= 2; round++) {
    ev.status(`👀 Визуальная проверка${round > 1 ? ` (${round})` : ''}…`);
    const report: string[] = [];
    for (const page of map.pages) {
      const problems = await inspectPage(path.join(root, page.file)).catch(() => [] as string[]);
      if (problems.length) report.push(`${page.file}:\n${problems.slice(0, 8).map((x) => `- ${x}`).join('\n')}`);
    }
    if (placeholders && round === 1) report.push(`Images without a file were replaced by <div class="image-placeholder">caption</div> blocks (${placeholders}): style .image-placeholder in the concept (size, background colour or gradient, centred caption, rounded corners).`);
    if (!report.length) break;
    ev.status(`🔧 Исправляю вёрстку: ${report.length} ${report.length === 1 ? 'замечание' : 'замечаний'}…`);
    const current = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
    const fixed = await chat([
      { role: 'system', content: 'You fix the stylesheet of a website. Problems were seen in a real browser (desktop 1280px and phone 375px). Return the FULL corrected style.css: keep everything that already works and the design concept, fix every listed problem in CSS only. JSON {"css": "..."} only.' },
      { role: 'user', content: `Concept: ${ideaText}\nClasses used by the pages: ${classes.join(', ') || '(semantic tags)'}\n\nProblems:\n${report.join('\n\n')}\n\nCurrent style.css:\n${current}` },
    ], obj({ css: str }), 6000).then((raw) => stripFences(field(raw, 'css'))).catch(() => '');
    // a "fix" that throws away most of the stylesheet is not taken
    const balanced = (t: string) => (t.match(/\{/g) ?? []).length === (t.match(/\}/g) ?? []).length;
    if (!fixed || fixed.length < current.length * 0.7 || !balanced(fixed)) break;
    write('style.css', fixed);
  }
  return map;
}
