#!/usr/bin/env node
/**
 * i18n gate: every `t('key')` / `tr('key')` used in the source must exist in
 * all locale dictionaries, and every locale must define the same keys as
 * English. Exits 1 with a list of what is missing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'lib', 'i18n.tsx'), 'utf8');

const LOCALES = ['en', 'ru', 'az', 'ge', 'it', 'sp'];
const dicts = {};
for (const loc of LOCALES) {
  const start = source.indexOf(`const ${loc}: Dict = {`);
  const end = source.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error(`dictionary not found: ${loc}`);
  dicts[loc] = new Set([...source.slice(start, end).matchAll(/'([\w.]+)':/g)].map((m) => m[1]));
}

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === '.next' || name === 'out') continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?)$/.test(name) && !p.endsWith('i18n.tsx')) files.push(p);
  }
};
for (const d of ['app', 'components', 'hooks', 'lib']) walk(join(root, d));

const used = new Map();
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/\b(?:t|tr)\(\s*'([a-z][\w]*(?:\.[\w]+)+)'/g)) {
    if (!used.has(m[1])) used.set(m[1], relative(root, f));
  }
}
// keys built dynamically (e.g. t(`kind.${type}`)) are checked by prefix
const DYNAMIC = ['kind.', 'tasks.status.'];

const problems = [];
for (const [key, file] of used) {
  for (const loc of LOCALES) {
    if (!dicts[loc].has(key)) problems.push(`missing "${key}" in ${loc}  (used in ${file})`);
  }
}
for (const loc of LOCALES.slice(1)) {
  for (const key of dicts.en) {
    if (!dicts[loc].has(key)) problems.push(`"${key}" is in en but missing in ${loc}`);
  }
  for (const key of dicts[loc]) {
    if (!dicts.en.has(key)) problems.push(`"${key}" is in ${loc} but missing in en`);
  }
}
for (const prefix of DYNAMIC) {
  if (![...dicts.en].some((k) => k.startsWith(prefix))) problems.push(`no keys with prefix "${prefix}"`);
}

// placeholders like {name} must be identical in every locale
const valueRe = /'([\w.]+)': '((?:[^'\\]|\\.)*)'/g;
const values = {};
for (const loc of LOCALES) {
  const start = source.indexOf(`const ${loc}: Dict = {`);
  const end = source.indexOf('\n};', start);
  values[loc] = new Map([...source.slice(start, end).matchAll(valueRe)].map((m) => [m[1], m[2]]));
}
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const loc of LOCALES.slice(1)) {
  for (const [key, val] of values[loc]) {
    const base = values.en.get(key);
    if (base !== undefined && vars(base) !== vars(val)) problems.push(`placeholders differ for "${key}" in ${loc}: en{${vars(base)}} vs {${vars(val)}}`);
  }
}
// the interpolation itself must keep its escaped regex
if (!source.includes('raw.replace(/\\{(\\w+)\\}/g')) problems.push('translate() lost its {name} interpolation regex');

const unique = [...new Set(problems)];
if (unique.length) {
  console.error(`[i18n] ${unique.length} problem(s):`);
  for (const p of unique) console.error('  - ' + p);
  process.exit(1);
}
console.log(`[i18n] ok — ${used.size} keys used, ${dicts.en.size} defined in ${LOCALES.length} locales`);
