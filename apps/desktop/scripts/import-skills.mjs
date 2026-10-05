#!/usr/bin/env node
/**
 * Imports the public skill collections of Anthropic and OpenAI into `skills-library/`:
 *   - only skills under an open licence (Apache 2.0 or MIT) are taken — the licence is copied next to each;
 *   - every skill gets a unique id `<vendor>.<plugin>.<skill>` and an entry in `library.json`
 *     (vendor, source repo, plugin, category) used by the app for grouping;
 *   - library skills are OFF until the user enables them (so they never bloat a request by default).
 * Run: node scripts/import-skills.mjs   (needs git and network)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(desktopDir, 'skills-library');

const SOURCES = [
  { vendor: 'anthropic', repo: 'anthropics/claude-plugins-official' },
  { vendor: 'anthropic', repo: 'anthropics/knowledge-work-plugins' },
  { vendor: 'openai', repo: 'openai/skills' },
];

/** Plugin / folder name → category shown in the skills picker. */
const CATEGORY = {
  engineering: 'code', 'feature-dev': 'code', 'code-review': 'code', 'code-simplifier': 'code', 'code-modernization': 'code',
  'mcp-server-dev': 'code', 'plugin-dev': 'code', 'agent-sdk-dev': 'code', hookify: 'code', 'pr-review-toolkit': 'code',
  'security-guidance': 'code', 'commit-commands': 'workflow', 'claude-md-management': 'workflow', 'claude-code-setup': 'workflow',
  'session-report': 'workflow', 'skill-creator': 'workflow', 'cowork-plugin-management': 'workflow', productivity: 'productivity',
  'enterprise-search': 'productivity', operations: 'productivity', 'small-business': 'business', design: 'design',
  'frontend-design': 'design', playground: 'design', 'project-artifact': 'design', data: 'data', 'bio-research': 'data',
  finance: 'business', sales: 'business', marketing: 'business', legal: 'business', 'human-resources': 'business',
  'customer-support': 'business', 'product-management': 'business', 'partner-built': 'other', 'math-olympiad': 'learning',
  'math-proof': 'learning', receipts: 'business', 'cwc-makers': 'other', discord: 'workflow', telegram: 'workflow', imessage: 'workflow',
  'pdf-viewer': 'writing', 'zoom-plugin': 'productivity', 'common-room': 'business', apollo: 'business', 'brand-voice': 'writing', slack: 'productivity',
};
/** OpenAI skills by name. */
const OPENAI_CATEGORY = {
  playwright: 'testing', 'playwright-interactive': 'testing', screenshot: 'testing', 'gh-fix-ci': 'workflow', 'gh-address-comments': 'workflow',
  yeet: 'workflow', 'define-goal': 'workflow', 'migrate-to-codex': 'workflow', 'skill-creator': 'workflow', 'skill-installer': 'workflow',
  'plugin-creator': 'workflow', 'security-best-practices': 'code', 'security-threat-model': 'code', 'security-ownership-map': 'code',
  'aspnet-core': 'code', 'chatgpt-apps': 'code', 'cli-creator': 'code', 'winui-app': 'code', 'openai-docs': 'code',
  'cloudflare-deploy': 'workflow', 'netlify-deploy': 'workflow', 'render-deploy': 'workflow', 'vercel-deploy': 'workflow', sentry: 'workflow',
  'jupyter-notebook': 'data', imagegen: 'media', speech: 'media', transcribe: 'media', 'hatch-pet': 'media', pdf: 'writing', linear: 'productivity',
  'notion-knowledge-capture': 'productivity', 'notion-meeting-intelligence': 'productivity', 'notion-research-documentation': 'writing', 'notion-spec-to-implementation': 'code',
};

const isOpen = (text) => /Apache License|MIT License|Permission is hereby granted, free of charge/i.test(text);
const SKIP = /(^|\/)(example-plugin|template)(\/|$)/;

function findSkills(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'SKILL.md') out.push(path.dirname(p));
    }
  };
  walk(dir);
  return out;
}

/** The licence file that governs a skill folder: its own, else the nearest one up to the repo root. */
function licenceFor(skillDir, repoDir) {
  for (let d = skillDir; d.startsWith(repoDir); d = path.dirname(d)) {
    const f = fs.readdirSync(d).find((n) => /^licen[cs]e(\.(txt|md))?$/i.test(n));
    if (f) return path.join(d, f);
    if (d === repoDir) break;
  }
  return null;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-skills-'));
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const index = {};
const notice = ['# Skill library', '', 'Imported by scripts/import-skills.mjs from the public repositories below. Each skill keeps its licence file.', ''];
const skipped = [];

for (const src of SOURCES) {
  const repoDir = path.join(tmp, src.repo.replace('/', '__'));
  execFileSync('git', ['clone', '--depth', '1', '-q', `https://github.com/${src.repo}`, repoDir], { stdio: 'inherit' });
  const commit = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  let taken = 0;
  for (const skillDir of findSkills(repoDir)) {
    const rel = path.relative(repoDir, skillDir).replace(/\\/g, '/');
    if (SKIP.test(rel)) continue;
    const lic = licenceFor(skillDir, repoDir);
    const licText = lic ? fs.readFileSync(lic, 'utf8') : '';
    if (!lic || !isOpen(licText)) { skipped.push(`${src.repo}/${rel} — ${lic ? 'not an open licence' : 'no licence'}`); continue; }
    const parts = rel.split('/');
    const skill = parts[parts.length - 1];
    // plugins/<plugin>/skills/<skill> | <plugin>/skills/<skill> | skills/.curated/<skill>
    const si = parts.lastIndexOf('skills');
    const plugin = src.vendor === 'openai' ? '' : (si > 0 ? parts[si - 1] : '');
    const id = [src.vendor, plugin, skill].filter(Boolean).join('.').replace(/[^\w.-]/g, '-');
    if (index[id]) continue;
    const dest = path.join(outDir, id);
    fs.cpSync(skillDir, dest, { recursive: true });
    if (!fs.readdirSync(dest).some((n) => /^licen[cs]e/i.test(n))) fs.copyFileSync(lic, path.join(dest, 'LICENSE.txt'));
    const category = src.vendor === 'openai' ? OPENAI_CATEGORY[skill] ?? 'other' : CATEGORY[plugin] ?? CATEGORY[skill] ?? 'other';
    index[id] = { vendor: src.vendor, repo: src.repo, plugin: plugin || null, skill, category };
    taken++;
  }
  notice.push(`- https://github.com/${src.repo} — commit ${commit} — ${taken} skills`);
}
notice.push('', '## Not imported (licence)', '', ...skipped.map((s) => `- ${s}`), '');
fs.writeFileSync(path.join(outDir, 'library.json'), JSON.stringify(index, null, 1));
fs.writeFileSync(path.join(outDir, 'NOTICE.md'), notice.join('\n'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`[skills] ${Object.keys(index).length} skills imported into skills-library/, ${skipped.length} skipped (licence)`);
