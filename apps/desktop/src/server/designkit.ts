/**
 * A design base for web pages made by small local models. Left to themselves they write a page with
 * browser-default looks; given this kit they adapt a finished, responsive style instead of inventing
 * CSS. `designGaps` is the check behind the "polish" pass: what a page still lacks to look finished.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Base stylesheet: colours and fonts are variables, so a page changes its look by editing :root only. */
export const BASE_CSS = `:root {
  --bg: #faf7f2; --surface: #ffffff; --text: #2b2420; --muted: #7a6e66;
  --primary: #b5652b; --primary-dark: #8a4a1c; --accent: #f2e6d8; --dark: #2b1d14;
  --radius: 16px; --shadow: 0 10px 30px rgba(43, 29, 20, .08);
  --font: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; --font-head: Georgia, "Times New Roman", serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.6; }
img { max-width: 100%; display: block; }
a { color: var(--primary); text-decoration: none; }
.container { width: min(1120px, 100% - 32px); margin-inline: auto; }
.nav { position: sticky; top: 0; z-index: 10; background: rgba(250, 247, 242, .9); backdrop-filter: blur(8px); border-bottom: 1px solid var(--accent); }
.nav .container { display: flex; align-items: center; justify-content: space-between; height: 64px; }
.nav a { color: var(--text); margin-left: 24px; font-weight: 500; }
.logo { font-family: var(--font-head); font-size: 1.4rem; font-weight: 700; color: var(--dark); }
.hero { padding: 96px 0; background: linear-gradient(135deg, var(--dark), var(--primary)); color: #fff; }
.hero h1 { font-family: var(--font-head); font-size: clamp(2.2rem, 5vw, 3.6rem); line-height: 1.1; max-width: 640px; margin-bottom: 16px; }
.hero p { font-size: 1.15rem; opacity: .9; max-width: 520px; margin-bottom: 32px; }
.section { padding: 80px 0; }
.section.alt { background: var(--accent); }
.section-title { font-family: var(--font-head); font-size: clamp(1.8rem, 3.5vw, 2.4rem); text-align: center; margin-bottom: 12px; }
.section-subtitle { text-align: center; color: var(--muted); margin-bottom: 48px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 24px; }
.card { background: var(--surface); border-radius: var(--radius); padding: 28px; box-shadow: var(--shadow); transition: transform .2s, box-shadow .2s; }
.card:hover { transform: translateY(-4px); box-shadow: 0 16px 40px rgba(43, 29, 20, .12); }
.card h3 { font-size: 1.2rem; margin-bottom: 8px; display: flex; justify-content: space-between; gap: 12px; }
.price { color: var(--primary); font-weight: 700; white-space: nowrap; }
.muted { color: var(--muted); }
.btn { display: inline-block; padding: 14px 32px; border: 0; border-radius: 999px; background: var(--primary); color: #fff; font: 600 1rem var(--font); cursor: pointer; transition: background .2s, transform .2s; }
.btn:hover { background: var(--primary-dark); transform: translateY(-2px); }
.btn-light { background: #fff; color: var(--primary); }
.quote { font-style: italic; margin-bottom: 16px; }
.author { font-weight: 600; color: var(--muted); }
.form { max-width: 560px; margin: 0 auto; background: var(--surface); padding: 32px; border-radius: var(--radius); box-shadow: var(--shadow); display: grid; gap: 16px; }
.field { display: grid; gap: 6px; }
.field label { font-weight: 600; font-size: .95rem; }
.field input, .field select, .field textarea { padding: 12px 14px; border: 1px solid #e3d7ca; border-radius: 10px; font: inherit; background: #fffdf9; }
.field input:focus, .field select:focus, .field textarea:focus { outline: 2px solid var(--primary); border-color: transparent; }
.error { color: #c0392b; font-size: .9rem; }
.success { padding: 14px; border-radius: 10px; background: #e7f6ec; color: #1e7b44; font-weight: 600; text-align: center; }
.footer { background: var(--dark); color: #e9ddd2; padding: 48px 0 24px; }
.footer .grid { margin-bottom: 24px; }
.footer a { color: #f5c89a; }
@media (max-width: 600px) {
  .nav a { margin-left: 12px; font-size: .9rem; }
  .hero { padding: 64px 0; }
  .section { padding: 56px 0; }
  .grid { grid-template-columns: 1fr; }
  .form { padding: 22px; }
}`;

/** What the model is told when it builds a page. */
export const DESIGN_KIT_PROMPT = [
  'Design kit for web pages (use it — pages without real styling are not accepted):',
  '- Start style.css with this base and adapt it: change the :root colours/fonts to fit the topic, add what the page needs. Keep it complete.',
  '- HTML structure with these classes: <nav class="nav"><div class="container">logo + links</div></nav>; <header class="hero"><div class="container"><h1>…</h1><p>…</p><a class="btn">…</a></div></header>;',
  '  each block <section class="section" id="…"><div class="container"><h2 class="section-title">…</h2><p class="section-subtitle">…</p><div class="grid">…<div class="card">…</div>…</div></div></section> (every 2nd section can be "section alt");',
  '  prices <span class="price">…</span>; reviews in cards with <p class="quote"> and <p class="author">; forms <form class="form"> with <div class="field"><label>…</label><input …></div>, messages <p class="error"> / <div class="success">; <footer class="footer">.',
  '- Real, specific texts (not "Lorem ipsum", not "здесь будут отзывы").',
  '```css',
  BASE_CSS,
  '```',
].join('\n');

/** A request that builds or styles a web page. */
export const wantsSite = (prompt: string): boolean =>
  /(сайт|лендинг|landing|website|web ?page|страниц|html|вёрстк|верстк|дизайн|design|красив|оформ|стил|css|макет|mockup|концепт)/i.test(prompt);

/**
 * What the page `htmlRel` still lacks to look finished (empty = fine): real styles, layout, cards,
 * styled buttons / form, responsiveness, no placeholders.
 */
export function designGaps(root: string, htmlRel: string): string[] {
  const read = (rel: string) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };
  const html = read(htmlRel);
  if (!html) return [];
  const dir = path.dirname(htmlRel);
  const linked = [...html.matchAll(/<link[^>]+href=["']([^"']+\.css)["']/gi)].map((m) => read(path.join(dir, m[1])));
  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const css = [...linked, ...inline].join('\n');
  const gaps: string[] = [];
  if (css.replace(/\s+/g, '').length < 1500) gaps.push(`the styles are too thin (${css.replace(/\s+/g, '').length} characters of CSS) — the page looks like browser defaults`);
  if (!/(display:\s*grid|display:\s*flex)/i.test(css)) gaps.push('no layout: blocks are not arranged in a grid / flex (cards side by side)');
  if (!/(box-shadow|border-radius)/i.test(css)) gaps.push('no cards: content is not in styled cards (background, radius, shadow)');
  if (!/@media/i.test(css)) gaps.push('not responsive: no @media rules for phones');
  if (/<button|<form/i.test(html) && !/(\.btn|button)\s*[{,:]/i.test(css)) gaps.push('buttons / form are unstyled');
  if (/(lorem ipsum|здесь будут|placeholder text|todo)/i.test(html)) gaps.push('placeholder texts instead of real ones');
  return gaps;
}

/**
 * A class-less theme: it styles plain semantic HTML (header, nav, section, ul, blockquote, form, footer…),
 * so any page a small model writes looks finished without the model having to write CSS at all.
 * Otto adds it to a page that is still bare (`applyBaseStyle`); the page's own style.css loads after it.
 */
export const CLASSLESS_CSS = `/* otto-base.css — base look added by Otto; your style.css (loaded after it) wins */
:root { --ob-bg: #faf7f2; --ob-surface: #fff; --ob-text: #2b2420; --ob-muted: #7a6e66; --ob-primary: #b5652b; --ob-dark: #2b1d14; --ob-line: #eadfd3; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; line-height: 1.6; color: var(--ob-text); background: var(--ob-bg); }
body > header, body > nav, body > main, body > section, body > footer, body > form, body > h1, body > h2, body > p, body > ul { padding-left: max(16px, calc((100% - 1080px) / 2)); padding-right: max(16px, calc((100% - 1080px) / 2)); }
header { background: linear-gradient(135deg, var(--ob-dark), var(--ob-primary)); color: #fff; padding-top: 72px; padding-bottom: 72px; }
header h1 { font-family: Georgia, "Times New Roman", serif; font-size: clamp(2.1rem, 5vw, 3.4rem); line-height: 1.1; margin: 0 0 12px; }
header p { opacity: .9; font-size: 1.1rem; max-width: 560px; }
header a, header button { margin-top: 12px; }
nav { display: flex; flex-wrap: wrap; gap: 8px 22px; align-items: center; padding-top: 14px; padding-bottom: 14px; }
nav ul { display: flex; flex-wrap: wrap; gap: 8px 22px; list-style: none; margin: 0; padding: 0; }
nav a { color: inherit; text-decoration: none; font-weight: 500; }
header nav { padding: 0 0 24px; }
main { display: block; }
section { padding-top: 56px; padding-bottom: 56px; }
section:nth-of-type(even) { background: #f3eadf; }
h1, h2, h3 { line-height: 1.2; }
h2 { font-family: Georgia, "Times New Roman", serif; font-size: clamp(1.6rem, 3.2vw, 2.2rem); text-align: center; margin: 0 0 28px; }
a { color: var(--ob-primary); }
section ul, section ol { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 18px; }
section li { background: var(--ob-surface); padding: 20px 22px; border-radius: 14px; box-shadow: 0 8px 24px rgba(43, 29, 20, .07); }
section > div, section article { background: var(--ob-surface); padding: 22px; border-radius: 14px; box-shadow: 0 8px 24px rgba(43, 29, 20, .07); margin-bottom: 16px; }
blockquote { margin: 0 0 16px; background: var(--ob-surface); padding: 20px 24px; border-radius: 14px; border-left: 4px solid var(--ob-primary); box-shadow: 0 8px 24px rgba(43, 29, 20, .07); font-style: italic; }
form { display: grid; gap: 14px; max-width: 560px; margin: 0 auto; background: var(--ob-surface); padding: 28px; border-radius: 16px; box-shadow: 0 10px 30px rgba(43, 29, 20, .08); }
body > form { margin: 32px auto; }
label { font-weight: 600; font-size: .95rem; display: grid; gap: 6px; }
input, select, textarea { width: 100%; padding: 11px 13px; border: 1px solid var(--ob-line); border-radius: 10px; font: inherit; background: #fffdf9; }
input:focus, select:focus, textarea:focus { outline: 2px solid var(--ob-primary); border-color: transparent; }
button, input[type=submit], .btn, a.button { display: inline-block; padding: 12px 28px; border: 0; border-radius: 999px; background: var(--ob-primary); color: #fff; font: 600 1rem inherit; cursor: pointer; text-decoration: none; }
button:hover, input[type=submit]:hover { filter: brightness(.92); }
header button, header .btn { background: #fff; color: var(--ob-primary); }
img { max-width: 100%; height: auto; border-radius: 12px; }
table { width: 100%; border-collapse: collapse; background: var(--ob-surface); border-radius: 12px; overflow: hidden; }
th, td { padding: 12px 14px; border-bottom: 1px solid var(--ob-line); text-align: left; }
footer { background: var(--ob-dark); color: #eadfd3; padding-top: 36px; padding-bottom: 36px; margin-top: 0; }
footer a { color: #f5c89a; }
@media (max-width: 600px) {
  header { padding-top: 48px; padding-bottom: 48px; }
  section { padding-top: 40px; padding-bottom: 40px; }
  section ul, section ol { grid-template-columns: 1fr; }
  form { padding: 20px; }
}
`;

/**
 * Give a bare page Otto's class-less base look: writes otto-base.css next to it and links it first in
 * <head> (the page's own styles still win). The content of the page is not touched. False when done already.
 */
export function applyBaseStyle(root: string, htmlRel: string): boolean {
  const file = path.join(root, htmlRel);
  let html: string;
  try { html = fs.readFileSync(file, 'utf8'); } catch { return false; }
  if (/otto-base\.css/.test(html)) return false;
  const dir = path.dirname(file);
  fs.writeFileSync(path.join(dir, 'otto-base.css'), CLASSLESS_CSS, 'utf8');
  const link = '<link rel="stylesheet" href="otto-base.css">';
  const firstStyle = html.search(/<link[^>]+stylesheet|<style\b/i);
  if (firstStyle >= 0) html = `${html.slice(0, firstStyle)}${link}\n    ${html.slice(firstStyle)}`;
  else if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `    ${link}\n</head>`);
  else if (/<body\b/i.test(html)) html = html.replace(/<body\b/i, `${link}\n<body`);
  else html = `${link}\n${html}`;
  if (!/<meta[^>]+viewport/i.test(html)) html = html.replace(link, `<meta name="viewport" content="width=device-width, initial-scale=1">\n    ${link}`);
  fs.writeFileSync(file, html, 'utf8');
  return true;
}
