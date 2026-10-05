/**
 * Generate apps/desktop/assets/icon.ico from the brand SVG (apps/web/app/icon.svg).
 *
 * Uses headless Edge as a rasterizer (no npm dependencies, no native builds):
 * renders the SVG at several sizes and packs the PNGs into a classic ICO
 * container (PNG-compressed entries, supported since Vista).
 *
 * Usage: node scripts/make-icon.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '..', '..');
const svgPath = join(repoRoot, 'apps', 'web', 'app', 'icon.svg');
const outPath = join(desktopDir, 'assets', 'icon.ico');
const workDir = join(desktopDir, 'assets', '.icon-build');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function pngSize(buf) {
  // IHDR width/height sit at bytes 16..23 of a PNG
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  let offset = 6 + pngs.length * 16;
  const entries = [];
  const blobs = [];

  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // width (0 = 256)
    entry[1] = size >= 256 ? 0 : size; // height
    entry[2] = 0; // palette colors
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
    blobs.push(data);
  }

  return Buffer.concat([header, ...entries, ...blobs]);
}

const edge = findEdge();
if (!edge) {
  console.error('[icon] Microsoft Edge not found — cannot rasterize SVG');
  process.exit(1);
}

const svg = readFileSync(svgPath, 'utf8');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const pngs = [];

for (const size of SIZES) {
  const scaled = svg
    .replace('width="64"', `width="${size}"`)
    .replace('height="64"', `height="${size}"`);
  const html =
    '<html><body style="margin:0;background:#070909">' +
    `<div style="width:${size}px;height:${size}px">${scaled}</div>` +
    '</body></html>';

  const htmlPath = join(workDir, `icon-${size}.html`);
  const pngPath = join(workDir, `icon-${size}.png`);
  writeFileSync(htmlPath, html, 'utf8');

  const url = `file:///${htmlPath.replace(/\\/g, '/')}`;
  const res = spawnSync(
    edge,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      `--screenshot=${pngPath}`,
      `--window-size=${size},${size}`,
      url,
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  if (!existsSync(pngPath)) {
    console.error(`[icon] Edge failed to render ${size}px (exit ${res.status})`);
    process.exit(1);
  }

  const data = readFileSync(pngPath);
  const { w, h } = pngSize(data);
  if (w !== size || h !== size) {
    console.error(`[icon] expected ${size}x${size}, got ${w}x${h}`);
    process.exit(1);
  }
  pngs.push({ size, data });
  console.log(`[icon] rendered ${size}x${size} (${data.length} bytes)`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, buildIco(pngs));
rmSync(workDir, { recursive: true, force: true });

console.log(`[icon] wrote ${outPath}`);
