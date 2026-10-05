/**
 * Generate the Microsoft Store (MSIX) tile images in apps/desktop/build/appx/
 * from the brand SVG (apps/web/app/icon.svg), rasterized with headless Edge
 * like make-icon.mjs. electron-builder's appx target picks them up by name.
 *
 * Usage: node scripts/make-store-assets.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = join(desktopDir, '..', 'web', 'app', 'icon.svg');
const outDir = join(desktopDir, 'build', 'appx');
const workDir = join(outDir, '.build');
const BG = '#070909';

// name, width, height, icon size inside the tile
const TILES = [
  ['StoreLogo.png', 50, 50, 50],
  ['Square44x44Logo.png', 44, 44, 44],
  ['SmallTile.png', 71, 71, 48],
  ['Square150x150Logo.png', 150, 150, 96],
  ['Wide310x150Logo.png', 310, 150, 96],
  ['LargeTile.png', 310, 310, 192],
];

const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
if (!edge) {
  console.error('[store-assets] Microsoft Edge not found — cannot rasterize SVG');
  process.exit(1);
}

const svg = readFileSync(svgPath, 'utf8');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

for (const [name, w, h, icon] of TILES) {
  const scaled = svg.replace('width="64"', `width="${icon}"`).replace('height="64"', `height="${icon}"`);
  const html =
    `<html><body style="margin:0;background:${BG};width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center">` +
    `<div style="width:${icon}px;height:${icon}px">${scaled}</div></body></html>`;
  const htmlPath = join(workDir, `${name}.html`);
  const pngPath = join(outDir, name);
  writeFileSync(htmlPath, html, 'utf8');
  spawnSync(edge, ['--headless', '--disable-gpu', '--hide-scrollbars', `--screenshot=${pngPath}`, `--window-size=${w},${h}`, `file:///${htmlPath.replace(/\\/g, '/')}`], { stdio: 'ignore', windowsHide: true });
  if (!existsSync(pngPath)) {
    console.error(`[store-assets] Edge failed to render ${name}`);
    process.exit(1);
  }
  const data = readFileSync(pngPath);
  if (data.readUInt32BE(16) !== w || data.readUInt32BE(20) !== h) {
    console.error(`[store-assets] ${name}: expected ${w}x${h}, got ${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`);
    process.exit(1);
  }
  console.log(`[store-assets] ${name} ${w}x${h}`);
}
rmSync(workDir, { recursive: true, force: true });
