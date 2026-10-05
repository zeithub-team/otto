/**
 * Page verification for the AI agent: open a project HTML file in a real
 * (headless) browser and look at what actually happens.
 *
 * Why: models "check" their own work by re-reading the code and then report
 * success — a success message hidden inside a hidden form passes that kind of
 * review. Rendering the page and running a scenario in it does not.
 *
 * No new dependencies: it drives the Microsoft Edge / Chrome that is already
 * installed through the DevTools protocol (websocket via the `ws` package).
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { WebSocket } from 'ws';

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

/** Installed Chromium-based browser (`OTTO_BROWSER` overrides), or null. */
export function findBrowser(): string | null {
  const explicit = process.env.OTTO_BROWSER;
  if (explicit && fs.existsSync(explicit)) return explicit;
  return BROWSER_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

const NO_BROWSER =
  'Браузер для проверки не найден (нужен Microsoft Edge или Google Chrome). Проверить страницу запуском нельзя — не утверждай, что она проверена.';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

interface ConsoleEntry {
  kind: 'error' | 'warning' | 'exception' | 'network';
  text: string;
}

/** One headless browser page driven over the DevTools protocol. */
class Page {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  readonly console: ConsoleEntry[] = [];
  private loadWaiters: Array<() => void> = [];
  private proc: ChildProcess | null = null;
  private profile = '';

  static async open(): Promise<Page> {
    const browser = findBrowser();
    if (!browser) throw new Error(NO_BROWSER);
    const page = new Page();
    const port = await freePort();
    page.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-preview-'));
    page.proc = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--mute-audio',
        `--user-data-dir=${page.profile}`,
        `--remote-debugging-port=${port}`,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true },
    );

    // wait for the DevTools endpoint, then attach to the first page target
    let wsUrl = '';
    for (let i = 0; i < 60 && !wsUrl; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch {
        /* browser still starting */
      }
    }
    if (!wsUrl) {
      page.close();
      throw new Error('Не удалось запустить браузер для проверки.');
    }
    await page.attach(wsUrl);
    return page;
  }

  private attach(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => {
        this.ws.on('message', (raw) => this.onMessage(String(raw)));
        void (async () => {
          await this.send('Page.enable');
          await this.send('Runtime.enable');
          await this.send('Log.enable');
          resolve();
        })().catch(reject);
      });
      this.ws.on('error', reject);
    });
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: any };
    if (msg.id !== undefined) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
      return;
    }
    const p = msg.params ?? {};
    switch (msg.method) {
      case 'Page.loadEventFired':
        this.loadWaiters.splice(0).forEach((fn) => fn());
        break;
      case 'Runtime.consoleAPICalled':
        if (p.type === 'error' || p.type === 'warning') {
          this.console.push({
            kind: p.type === 'error' ? 'error' : 'warning',
            text: (p.args ?? []).map((a: any) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300),
          });
        }
        break;
      case 'Runtime.exceptionThrown':
        this.console.push({
          kind: 'exception',
          text: String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception').slice(0, 300),
        });
        break;
      case 'Log.entryAdded':
        if (p.entry?.level === 'error') this.console.push({ kind: 'network', text: `${p.entry.text} ${p.entry.url ?? ''}`.trim().slice(0, 300) });
        break;
      default:
    }
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async viewport(width: number, height: number): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  }

  async goto(file: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      this.loadWaiters.push(resolve);
      setTimeout(resolve, 15_000);
    });
    await this.send('Page.navigate', { url: pathToFileURL(file).toString() });
    await loaded;
    await new Promise((r) => setTimeout(r, 600));
  }

  /** Evaluate an expression in the page; returns the JSON value or throws the page error. */
  async evaluate<T = unknown>(expression: string, timeoutMs = 20_000): Promise<T> {
    const res = await this.send<{ result?: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
    );
    if (res.exceptionDetails) {
      throw new Error(String(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'script error').split('\n').slice(0, 3).join(' '));
    }
    return res.result?.value as T;
  }

  async screenshot(fullPage = true): Promise<Buffer> {
    let clip: Record<string, number> | undefined;
    if (fullPage) {
      const m = await this.send<{ cssContentSize: { width: number; height: number } }>('Page.getLayoutMetrics');
      clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 6000), scale: 1 };
    }
    const shot = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
    return Buffer.from(shot.data, 'base64');
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    if (this.proc?.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true });
      else this.proc.kill('SIGKILL');
    }
    if (this.profile) {
      const dir = this.profile;
      // Windows keeps the profile locked for a moment after the browser is killed: the check itself
      // succeeded, so a folder we cannot delete yet must not fail it — try again in the background
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {
        setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left in %TEMP% */ } }, 5000).unref();
      }
    }
  }
}

/** Scroll through the page so IntersectionObserver-driven "reveal" content shows up, then back to the top. */
const WARM_UP = `(async () => {
  const h = document.documentElement.scrollHeight;
  for (let y = 0; y <= h; y += Math.max(200, innerHeight / 2)) { scrollTo(0, y); await new Promise(r => setTimeout(r, 90)); }
  scrollTo(0, 0); await new Promise(r => setTimeout(r, 250));
})()`;

/** Structural facts about the rendered page. */
const INSPECT = `(() => {
  const vis = (e) => !!e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getClientRects().length > 0;
  const text = (e) => (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  const anchors = [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href')).filter(h => h.length > 1);
  return {
    title: document.title,
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    scrollWidth: document.documentElement.scrollWidth, innerWidth,
    scrollHeight: document.documentElement.scrollHeight,
    headings: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map(h => h.tagName.toLowerCase() + ': ' + text(h)).slice(0, 14),
    buttons: [...document.querySelectorAll('button, [role=button], input[type=submit]')].filter(vis).length,
    links: document.querySelectorAll('a[href]').length,
    forms: document.forms.length,
    fields: [...document.querySelectorAll('input, textarea, select')].filter(vis).length,
    brokenAnchors: [...new Set(anchors.filter(h => !document.querySelector(h)))].slice(0, 8),
    external: [...document.querySelectorAll('script[src], link[rel=stylesheet][href], img[src], iframe[src]')]
      .map(e => e.src || e.href).filter(u => /^https?:/i.test(u)).slice(0, 6),
    imagesBroken: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
    emptyHidden: document.body.innerText.trim().length,
  };
})()`;

export interface PreviewResult {
  report: string;
  /** Full-page screenshot at the requested width, or null. */
  screenshot: Buffer | null;
  screenshotPath: string | null;
}

interface Inspect {
  title: string;
  overflowX: boolean;
  scrollWidth: number;
  innerWidth: number;
  scrollHeight: number;
  headings: string[];
  buttons: number;
  links: number;
  forms: number;
  fields: number;
  brokenAnchors: string[];
  external: string[];
  imagesBroken: number;
  emptyHidden: number;
}

const rel = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');

/** Render `file` at desktop and phone widths and describe what was found. */
export async function previewPage(root: string, file: string, width = 1280): Promise<PreviewResult> {
  if (!findBrowser()) return { report: NO_BROWSER, screenshot: null, screenshotPath: null };
  const page = await Page.open();
  try {
    await page.viewport(width, 800);
    await page.goto(file);
    await page.evaluate(WARM_UP);
    const desktop = await page.evaluate<Inspect>(INSPECT);
    const shot = await page.screenshot(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-shot-'));
    const shotPath = path.join(dir, `${path.basename(file, path.extname(file))}-${width}.png`);
    fs.writeFileSync(shotPath, shot);

    await page.viewport(375, 812);
    await page.goto(file);
    await page.evaluate(WARM_UP);
    const phone = await page.evaluate<Inspect>(INSPECT);

    const problems: string[] = [];
    if (desktop.overflowX) problems.push(`горизонтальная прокрутка на ${width}px (контент ${desktop.scrollWidth}px)`);
    if (phone.overflowX) problems.push(`горизонтальная прокрутка на 375px (контент ${phone.scrollWidth}px) — сломан адаптив`);
    if (phone.emptyHidden < 20) problems.push('на странице почти нет видимого текста');
    if (desktop.brokenAnchors.length) problems.push(`ссылки-якоря без цели: ${desktop.brokenAnchors.join(', ')}`);
    if (desktop.imagesBroken) problems.push(`битых картинок: ${desktop.imagesBroken}`);
    if (desktop.external.length) problems.push(`внешние ресурсы (в задании их быть не должно): ${desktop.external.join(', ')}`);
    const errors = page.console.filter((c) => c.kind !== 'warning');
    if (errors.length) problems.push(`ошибки консоли/JS: ${errors.slice(0, 5).map((e) => `[${e.kind}] ${e.text}`).join(' | ')}`);

    const report = [
      `Проверка страницы ${rel(root, file)} (реальный браузер, ${width}px и 375px):`,
      `Заголовок: «${desktop.title}» · высота страницы ${desktop.scrollHeight}px`,
      `Структура: ${desktop.headings.join(' · ') || '(нет заголовков)'}`,
      `Интерактив: кнопок ${desktop.buttons}, полей ${desktop.fields}, форм ${desktop.forms}, ссылок ${desktop.links}`,
      problems.length ? `НАЙДЕНЫ ПРОБЛЕМЫ:\n- ${problems.join('\n- ')}` : 'Проблем не найдено: ошибок консоли нет, прокрутки вбок нет, якоря и картинки в порядке.',
      'Сценарии (форма, кнопки, меню) эта проверка НЕ выполняет — для них используй run_in_page.',
      `Скриншот: ${shotPath}`,
    ].join('\n');
    return { report, screenshot: shot, screenshotPath: shotPath };
  } finally {
    page.close();
  }
}

/**
 * Run a scenario script inside the rendered page. The script is the body of an
 * async function: it may `await`, use `$`, `$$`, `visible(el)`, `wait(ms)` and
 * must `return` a JSON-serialisable result. `alert()` is captured, not shown.
 */
export async function runInPage(file: string, script: string, width = 1280, height = 800): Promise<string> {
  if (!findBrowser()) return NO_BROWSER;
  const page = await Page.open();
  try {
    await page.viewport(width, height);
    await page.goto(file);
    const wrapped = `(async () => {
      const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
      const visible = (e) => !!e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).opacity !== '0' && e.getClientRects().length > 0;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const __alerts = []; window.alert = (m) => { __alerts.push(String(m)); };
      let __result;
      try { __result = await (async () => { ${script}\n })(); } catch (e) { __result = { scriptError: String(e && e.message || e) }; }
      return JSON.stringify({ result: __result === undefined ? null : __result, alerts: __alerts });
    })()`;
    let raw: string;
    try {
      raw = await page.evaluate<string>(wrapped);
    } catch (exc) {
      return `Скрипт не выполнился: ${exc instanceof Error ? exc.message : String(exc)}`;
    }
    const errors = page.console.filter((c) => c.kind !== 'warning').slice(0, 5).map((e) => `[${e.kind}] ${e.text}`);
    const out = raw.length > 4000 ? `${raw.slice(0, 4000)}…(обрезано)` : raw;
    return `Результат сценария: ${out}${errors.length ? `\nОшибки консоли: ${errors.join(' | ')}` : ''}`;
  } finally {
    page.close();
  }
}
