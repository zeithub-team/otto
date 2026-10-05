/**
 * Generate the NSIS installer artwork (apps/desktop/build/*.bmp) in the
 * zeithub.otto brand style: near-black background, emerald accent, two rings.
 *
 *   installerSidebar.bmp  164x314  welcome / finish pages
 *   installerHeader.bmp   150x57   header of the inner pages
 *   installer-splash.bmp  480x240  fade-in splash shown when setup starts
 *
 * Uses headless Edge as a rasterizer and .NET (System.Drawing, via PowerShell)
 * to turn the PNG into the 24-bit BMP that NSIS requires — no npm packages.
 *
 * Usage: node scripts/make-installer-assets.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(desktopDir, 'build');
const workDir = join(desktopDir, 'assets', '.installer-build');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!EDGE) {
  console.error('[installer-assets] Microsoft Edge not found — cannot rasterize');
  process.exit(1);
}

const BG = '#0b0f14';
const ACCENT = '#00f5a0';
const FONT = "'Segoe UI', 'Segoe UI Variable', system-ui, sans-serif";

/** The two-ring logo (same geometry as apps/web/app/icon.svg, without the tile). */
const rings = (size) => `
<svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <circle cx="27" cy="32" r="14.5" fill="none" stroke="#e6edf3" stroke-width="5"/>
  <circle cx="43" cy="32" r="10.5" fill="none" stroke="${ACCENT}" stroke-width="5"/>
  <circle cx="43" cy="32" r="3.4" fill="${ACCENT}"/>
</svg>`;

const base = (w, h, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden;background:${BG};font-family:${FONT};color:#e6edf3}
  /* Edge never makes the window narrower than ~500px: anchor everything to the body box */
  body{position:relative}
  .grid{position:absolute;inset:0;background-image:
    linear-gradient(rgba(0,245,160,.045) 1px,transparent 1px),
    linear-gradient(90deg,rgba(0,245,160,.045) 1px,transparent 1px);
    background-size:18px 18px}
  .abs{position:absolute}
  .word{font-weight:600;letter-spacing:.2px}
  .word b{color:${ACCENT};font-weight:600}
  .tag{font-size:8px;letter-spacing:2.6px;color:${ACCENT};opacity:.85;text-transform:uppercase}
</style></head><body>${body}</body></html>`;

const ART = {
  'installerSidebar.bmp': {
    w: 164,
    h: 314,
    html: base(
      164,
      314,
      `
      <div class="grid"></div>
      <div class="abs" style="inset:0;background:radial-gradient(120px 120px at 100% 100%,rgba(0,245,160,.30),transparent 70%),radial-gradient(90px 90px at 0% 0%,rgba(0,245,160,.10),transparent 70%)"></div>
      <div class="abs" style="left:50px;top:46px">${rings(64)}</div>
      <div class="abs word" style="left:0;right:0;top:122px;text-align:center;font-size:19px">zeithub<b>.otto</b></div>
      <div class="abs tag" style="left:0;right:0;top:150px;text-align:center">AI coding studio</div>
      <div class="abs" style="left:26px;right:26px;top:176px;height:1px;background:linear-gradient(90deg,transparent,${ACCENT},transparent);opacity:.55"></div>
      <div class="abs" style="left:18px;right:18px;top:192px;font-size:9.5px;line-height:15px;color:#8b98a5;text-align:center">Локальные модели.<br>Ваш код остаётся<br>на вашем компьютере.</div>
      <svg class="abs" style="left:0;bottom:0" width="164" height="90" viewBox="0 0 164 90">
        <circle cx="140" cy="86" r="60" fill="none" stroke="rgba(0,245,160,.25)" stroke-width="1.2"/>
        <circle cx="140" cy="86" r="44" fill="none" stroke="rgba(230,237,243,.14)" stroke-width="1.2"/>
        <circle cx="140" cy="86" r="28" fill="none" stroke="rgba(0,245,160,.35)" stroke-width="1.2"/>
      </svg>
      <div class="abs" style="left:14px;bottom:12px;font-size:8.5px;letter-spacing:1.2px;color:#5b6773">zeithub.team</div>`,
    ),
  },
  'installerHeader.bmp': {
    w: 150,
    h: 57,
    html: base(
      150,
      57,
      `
      <div class="grid"></div>
      <div class="abs" style="inset:0;background:radial-gradient(90px 60px at 100% 50%,rgba(0,245,160,.22),transparent 70%)"></div>
      <div class="abs" style="left:14px;top:13px">${rings(30)}</div>
      <div class="abs word" style="left:52px;top:14px;font-size:14px">zeithub<b>.otto</b></div>
      <div class="abs tag" style="left:52px;top:34px;font-size:6.5px;letter-spacing:2px">AI coding studio</div>`,
    ),
  },
  'installer-splash.bmp': {
    w: 480,
    h: 240,
    html: base(
      480,
      240,
      `
      <div class="grid"></div>
      <div class="abs" style="inset:0;background:radial-gradient(260px 160px at 50% 42%,rgba(0,245,160,.20),transparent 70%)"></div>
      <div class="abs" style="left:0;right:0;top:44px;text-align:center">${rings(84)}</div>
      <div class="abs word" style="left:0;right:0;top:144px;text-align:center;font-size:30px">zeithub<b>.otto</b></div>
      <div class="abs tag" style="left:0;right:0;top:184px;text-align:center;font-size:10px;letter-spacing:4px">AI coding studio</div>
      <div class="abs" style="left:150px;right:150px;bottom:22px;height:2px;background:linear-gradient(90deg,transparent,${ACCENT},transparent);opacity:.6"></div>`,
    ),
  },
};

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const PS_CONVERT = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::FromFile($env:OTTO_PNG)
$dst = New-Object System.Drawing.Bitmap($src.Width, $src.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.DrawImage($src, 0, 0, $src.Width, $src.Height)
$dst.Save($env:OTTO_BMP, [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $dst.Dispose(); $src.Dispose()
`;

// ---- wizard artwork: stack badges (24x24) and color-scheme previews (200x64) ----

/** Own simple badges (colored rounded squares with letters) — not vendor logos. */
const BADGES = {
  js: ['JS', '#f7df1e', '#111111'],
  py: ['Py', '#3776ab', '#ffd43b'],
  php: ['php', '#777bb4', '#ffffff'],
  go: ['Go', '#00add8', '#ffffff'],
  rust: ['Rs', '#b7410e', '#ffffff'],
  java: ['Jv', '#e76f00', '#ffffff'],
  net: ['.N', '#512bd4', '#ffffff'],
  git: ['git', '#f05032', '#ffffff'],
  gh: ['GH', '#24292f', '#ffffff'],
  ollama: ['Ol', '#111111', '#ffffff'],
  docker: ['Dk', '#2496ed', '#ffffff'],
};

// id: [bg1, bg2, bg3, text, accent, keyword, string, function] — mirrors apps/web/app/globals.css
const SCHEMES = {
  emerald: ['#070909', '#0d1117', '#161b22', '#e6edf3', '#00f5a0', '#ff7b72', '#a5d6ff', '#d2a8ff'],
  ocean: ['#070b12', '#0d1424', '#141e33', '#e6edf3', '#38bdf8', '#f97583', '#9ecbff', '#b392f0'],
  violet: ['#0a0710', '#140d1f', '#1e1430', '#e6edf3', '#c084fc', '#ff7bd5', '#c3e88d', '#c792ea'],
  amber: ['#0c0a06', '#17130c', '#221c11', '#e6edf3', '#fbbf24', '#ffab70', '#ecc48d', '#ffd580'],
  light: ['#ffffff', '#f4f6f8', '#e9edf1', '#1f2328', '#0f9d70', '#cf222e', '#0a3069', '#8250df'],
  dracula: ['#191a21', '#21222c', '#282a36', '#f8f8f2', '#bd93f9', '#ff79c6', '#f1fa8c', '#50fa7b'],
  nord: ['#242933', '#2e3440', '#3b4252', '#eceff4', '#88c0d0', '#81a1c1', '#a3be8c', '#88c0d0'],
  tokyo: ['#16161e', '#1a1b26', '#24283b', '#c0caf5', '#7aa2f7', '#bb9af7', '#9ece6a', '#7aa2f7'],
  onedark: ['#21252b', '#282c34', '#2c313a', '#d7dae0', '#61afef', '#c678dd', '#98c379', '#61afef'],
  gruvbox: ['#1d2021', '#282828', '#32302f', '#ebdbb2', '#fabd2f', '#fb4934', '#b8bb26', '#8ec07c'],
  catppuccin: ['#11111b', '#181825', '#1e1e2e', '#cdd6f4', '#cba6f7', '#cba6f7', '#a6e3a1', '#89b4fa'],
  solarized: ['#00212b', '#002b36', '#073642', '#d5dede', '#2aa198', '#859900', '#2aa198', '#268bd2'],
  'solarized-light': ['#fdf6e3', '#eee8d5', '#e6dfc8', '#073642', '#268bd2', '#859900', '#2aa198', '#268bd2'],
};

for (const [id, [label, bg, fg]] of Object.entries(BADGES)) {
  ART[`${id}.bmp`] = {
    dir: 'wizard',
    w: 24,
    h: 24,
    // white page background so the rounded corners blend into the wizard page
    html: `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:24px;height:24px;overflow:hidden;background:#fff;position:relative;font-family:${FONT}}
      .b{position:absolute;left:1px;top:1px;width:22px;height:22px;border-radius:6px;background:${bg};color:${fg};
         display:flex;align-items:center;justify-content:center;font-weight:800;font-size:${label.length > 2 ? 8 : 10}px;letter-spacing:-.3px}
    </style></head><body><div class="b">${label}</div></body></html>`,
  };
}

for (const [id, [b1, b2, b3, tx, ac, kw, st, fn]] of Object.entries(SCHEMES)) {
  ART[`theme-${id}.bmp`] = {
    dir: 'wizard',
    w: 200,
    h: 64,
    html: `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:200px;height:64px;overflow:hidden;background:#fff;position:relative}
      .w{position:absolute;left:0;top:0;width:198px;height:62px;background:${b1};border:1px solid ${b3};border-radius:0}
      .a{position:absolute}
    </style></head><body><div class="w">
      <div class="a" style="left:0;top:0;width:198px;height:10px;background:${b2}"></div>
      <div class="a" style="left:5px;top:3px;width:4px;height:4px;border-radius:2px;background:${ac}"></div>
      <div class="a" style="left:0;top:10px;width:38px;height:52px;background:${b2}"></div>
      <div class="a" style="left:6px;top:18px;width:24px;height:3px;background:${ac};border-radius:2px"></div>
      <div class="a" style="left:6px;top:26px;width:20px;height:3px;background:${tx};opacity:.45;border-radius:2px"></div>
      <div class="a" style="left:6px;top:33px;width:26px;height:3px;background:${tx};opacity:.45;border-radius:2px"></div>
      <div class="a" style="left:38px;top:10px;width:160px;height:52px;background:${b3}"></div>
      <div class="a" style="left:48px;top:17px;width:26px;height:4px;background:${kw};border-radius:2px"></div>
      <div class="a" style="left:78px;top:17px;width:36px;height:4px;background:${fn};border-radius:2px"></div>
      <div class="a" style="left:118px;top:17px;width:30px;height:4px;background:${tx};opacity:.7;border-radius:2px"></div>
      <div class="a" style="left:58px;top:27px;width:22px;height:4px;background:${kw};border-radius:2px"></div>
      <div class="a" style="left:84px;top:27px;width:52px;height:4px;background:${st};border-radius:2px"></div>
      <div class="a" style="left:58px;top:37px;width:40px;height:4px;background:${fn};border-radius:2px"></div>
      <div class="a" style="left:102px;top:37px;width:24px;height:4px;background:${tx};opacity:.7;border-radius:2px"></div>
      <div class="a" style="left:150px;top:46px;width:40px;height:11px;background:${ac};border-radius:3px"></div>
    </div></body></html>`,
  };
}

for (const [name, { w, h, html, dir }] of Object.entries(ART)) {
  if (dir) mkdirSync(join(outDir, dir), { recursive: true });
  const htmlPath = join(workDir, name.replace('.bmp', '.html'));
  const pngPath = join(workDir, name.replace('.bmp', '.png'));
  const bmpPath = join(outDir, dir ?? '', name);
  writeFileSync(htmlPath, html, 'utf8');

  spawnSync(
    EDGE,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--screenshot=${pngPath}`,
      `--window-size=${w},${h}`,
      `file:///${htmlPath.split('\\').join('/')}`,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  if (!existsSync(pngPath)) {
    console.error(`[installer-assets] Edge failed to render ${name}`);
    process.exit(1);
  }

  const conv = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_CONVERT], {
    env: { ...process.env, OTTO_PNG: pngPath, OTTO_BMP: bmpPath },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (conv.status !== 0 || !existsSync(bmpPath)) {
    console.error(`[installer-assets] BMP conversion failed for ${name}`);
    process.exit(1);
  }
  console.log(`[installer-assets] ${name} (${w}x${h})`);
}

rmSync(workDir, { recursive: true, force: true });
