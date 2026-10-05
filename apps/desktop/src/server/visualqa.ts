/**
 * Visual check of a built site in a real browser: what is broken on screen, in words the model can act on
 * (blocks on top of each other, a footer stuck over the page, menu links glued together, default blue
 * links, sideways scrolling on a phone, missing images). The model then fixes its own style.css.
 */

import * as fs from 'fs';
import * as path from 'path';
import { runInPage } from './preview';

/** Runs inside the page; returns the problems found (plain sentences). */
const INSPECT = `
const out = [];
const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].join('.') : '');
const label = (el) => (el.querySelector('h1,h2,h3')?.textContent || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
// top-level blocks: children of body and main
const blocks = [...document.body.children, ...(document.querySelector('main')?.children ?? [])].filter((el) => el.tagName !== 'MAIN' && el.tagName !== 'SCRIPT' && vis(el));
for (const el of blocks) {
  const pos = getComputedStyle(el).position;
  if ((pos === 'fixed' || pos === 'absolute') && el.tagName !== 'HEADER' && el.tagName !== 'NAV') out.push(name(el) + ' («' + label(el) + '») is position:' + pos + ' — it floats over the page content; it should stay in the normal flow (position: static/relative)');
}
for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
  const a = blocks[i].getBoundingClientRect(), b = blocks[j].getBoundingClientRect();
  if (blocks[i].contains(blocks[j]) || blocks[j].contains(blocks[i])) continue;
  const h = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const v = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (h > 40 && v > 24) out.push(name(blocks[i]) + ' («' + label(blocks[i]) + '») and ' + name(blocks[j]) + ' («' + label(blocks[j]) + '») overlap by ' + Math.round(v) + 'px — check fixed heights, negative margins, absolute positioning');
}
const nav = document.querySelector('header nav, nav, header');
if (nav) {
  const links = [...nav.querySelectorAll('a')].filter(vis);
  for (let i = 1; i < links.length; i++) {
    const p = links[i - 1].getBoundingClientRect(), c = links[i].getBoundingClientRect();
    if (Math.abs(p.top - c.top) < 4 && c.left - p.right < 6 && c.left > p.left) { out.push('navigation links touch each other («' + links[i - 1].textContent.trim() + '|' + links[i].textContent.trim() + '») — add a gap / padding between them'); break; }
  }
  const def = links.find((a) => { const s = getComputedStyle(a); return s.color === 'rgb(0, 0, 238)' || s.color === 'rgb(85, 26, 139)'; });
  if (def) out.push('links in the header have the browser default blue colour and underline — style them with the site palette');
}
const bodyLinks = [...document.querySelectorAll('main a, footer a')].filter(vis).filter((a) => getComputedStyle(a).color === 'rgb(0, 0, 238)');
if (bodyLinks.length) out.push(bodyLinks.length + ' links in the page have the browser default blue colour — style a { … } with the palette');
const unstyledButtons = [...document.querySelectorAll('button, input[type=submit]')].filter(vis).filter((b) => { const s = getComputedStyle(b); return s.backgroundColor === 'rgb(239, 239, 239)' || s.backgroundColor === 'rgb(240, 240, 240)'; });
if (unstyledButtons.length) out.push(unstyledButtons.length + ' buttons look like browser defaults (grey) — style buttons / input[type=submit]');
const plainFields = [...document.querySelectorAll('input:not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea')].filter(vis).filter((f) => { const s = getComputedStyle(f); return parseFloat(s.paddingTop) <= 2 && parseFloat(s.paddingLeft) <= 3 && s.borderTopLeftRadius === '0px'; });
if (plainFields.length) out.push(plainFields.length + ' form fields look like browser defaults (tiny, no padding) — style input, select, textarea: padding, border, border-radius, full width inside the form, and center / style the form block itself');
if (document.documentElement.scrollWidth > innerWidth + 2) out.push('the page scrolls sideways at ' + innerWidth + 'px (content ' + document.documentElement.scrollWidth + 'px wide) — something is wider than the screen');
return out;`;

/** Images whose file does not exist become a placeholder block the model then styles (`.image-placeholder`). */
export function replaceBrokenImages(root: string, file: string): number {
  const full = path.join(root, file);
  let html = fs.readFileSync(full, 'utf8');
  let n = 0;
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /src=["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    if (/^(https?:|data:)/i.test(src) || (src && fs.existsSync(path.join(path.dirname(full), src.split(/[?#]/)[0])))) return tag;
    n++;
    const alt = /alt=["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    return `<div class="image-placeholder" role="img" aria-label="${alt}">${alt}</div>`;
  });
  if (n) fs.writeFileSync(full, html, 'utf8');
  return n;
}

/** Problems of one page at desktop and phone width ("[desktop] …", "[phone] …"). */
export async function inspectPage(file: string): Promise<string[]> {
  const parse = (out: string): string[] => {
    try {
      const m = /\{[\s\S]*\}/.exec(out);
      const obj = m ? JSON.parse(m[0]) as { result?: unknown } : {};
      return Array.isArray(obj.result) ? obj.result.map(String) : [];
    } catch { return []; }
  };
  const desktop = parse(await runInPage(file, INSPECT, 1280, 900).catch(() => ''));
  const phone = parse(await runInPage(file, INSPECT, 375, 800).catch(() => '')).filter((p) => !desktop.includes(p));
  return [...desktop.map((p) => `[desktop] ${p}`), ...phone.map((p) => `[phone 375px] ${p}`)];
}
