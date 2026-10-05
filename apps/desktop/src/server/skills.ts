/**
 * Skills: reusable know-how packs the agent can load on demand.
 *
 * A skill is a folder with a `SKILL.md`:
 *
 *   ---
 *   name: web-design
 *   description: one line — when to use it
 *   triggers: лендинг, landing, вёрстка, css
 *   ---
 *   <markdown body>
 *
 * Sources (later ones override earlier by name):
 *   1. built-in   — `apps/desktop/skills/` (shipped with the app)
 *   2. user       — `<dataDir>/skills/`
 *   3. project    — `<project>/.otto/skills/`
 *
 * The system prompt lists the available skills; the body of a skill whose
 * trigger matches the request is injected right away, others are loaded by the
 * agent through the `use_skill` tool.
 */
import * as fs from 'fs';
import * as path from 'path';

export type SkillCategory = 'design' | 'code' | 'testing' | 'writing' | 'media' | 'data' | 'workflow' | 'productivity' | 'business' | 'learning' | 'other';
const CATEGORIES: SkillCategory[] = ['design', 'code', 'testing', 'writing', 'media', 'data', 'workflow', 'productivity', 'business', 'learning', 'other'];

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  /** library = the imported Anthropic / OpenAI collections: off until the user turns a skill on. */
  source: 'builtin' | 'library' | 'user' | 'project';
  /** Who made it, for the badge in the picker. */
  vendor?: 'anthropic' | 'openai';
  /** Kind of work, for grouping in the UI (frontmatter `category:` or the table below). */
  category: SkillCategory;
  /** From the official Anthropic skills repository (Apache 2.0). */
  official: boolean;
  /** Folder of the skill: its extra files (scripts, references) are read with `read_skill_file`. */
  dir: string;
}

/** The Anthropic skills shipped with the app (see skills/NOTICE-anthropic-skills.md). */
const OFFICIAL = new Set([
  'academy-guide', 'algorithmic-art', 'brand-guidelines', 'canvas-design', 'claude-api', 'discernment-nudge', 'frontend-design',
  'internal-comms', 'mcp-builder', 'skill-creator', 'slack-gif-creator', 'theme-factory', 'web-artifacts-builder', 'webapp-testing',
]);

/** Category of the skills that do not declare one. */
const CATEGORY: Record<string, SkillCategory> = {
  'web-design': 'design', 'ux-design': 'design', 'responsive-mobile': 'design', accessibility: 'design', 'frontend-design': 'design',
  'canvas-design': 'design', 'theme-factory': 'design', 'brand-guidelines': 'design',
  'verify-ui': 'testing', testing: 'testing', 'webapp-testing': 'testing', 'code-review': 'code', 'security-review': 'code',
  'mcp-builder': 'code', 'claude-api': 'code', 'web-artifacts-builder': 'code',
  'ux-copy': 'writing', 'internal-comms': 'writing',
  'algorithmic-art': 'media', 'slack-gif-creator': 'media',
  'git-commits': 'workflow', 'skill-creator': 'workflow',
  'academy-guide': 'learning', 'discernment-nudge': 'learning',
};

/**
 * Trigger words for the official skills (they come without any): when one occurs in the request the skill is
 * put into the prompt straight away; otherwise the agent can still load it with `use_skill`.
 */
const TRIGGERS: Record<string, string[]> = {
  'frontend-design': ['frontend design', 'фронтенд-дизайн', 'уникальный дизайн', 'distinctive design', 'визуальный стиль', 'visual identity'],
  'canvas-design': ['poster', 'постер', 'плакат', 'canvas', 'обложк', 'banner', 'баннер'],
  'theme-factory': ['theme', 'тема оформления', 'цветовая схема', 'palette', 'палитр'],
  'brand-guidelines': ['anthropic brand', 'бренд anthropic'],
  'mcp-builder': ['mcp', 'model context protocol', 'mcp server', 'mcp-сервер'],
  'claude-api': ['claude api', 'anthropic api', 'anthropic sdk', '@anthropic-ai', 'messages api'],
  'web-artifacts-builder': ['artifact', 'артефакт'],
  'webapp-testing': ['playwright', 'e2e', 'end-to-end', 'протестируй приложение', 'test the web app'],
  'internal-comms': ['newsletter', 'рассылк', 'status report', 'отчёт для команды', 'internal comms', 'объявление для команды'],
  'algorithmic-art': ['generative art', 'генеративн', 'p5.js', 'p5js', 'algorithmic art'],
  'slack-gif-creator': ['gif', 'гиф', 'slack'],
  'skill-creator': ['skill.md', 'создай скилл', 'новый скилл', 'create a skill', 'навык'],
  'academy-guide': ['anthropic academy', 'курс anthropic'],
  'discernment-nudge': [],
};

let getSetting: (key: string) => string = () => '';
let userDir = '';

export function configureSkills(opts: { getSetting?: (key: string) => string; userDir?: string }): void {
  if (opts.getSetting) getSetting = opts.getSetting;
  if (opts.userDir !== undefined) userDir = opts.userDir;
}

/** `dist/server/skills.js` → `<app>/skills` (also true inside app.asar). */
function builtinDir(): string {
  return path.join(__dirname, '..', '..', 'skills');
}

/** `forceName`: the library uses its own ids (`vendor.plugin.skill`) whatever the file says. */
export function parseSkill(text: string, fallbackName: string, source: Skill['source'], forceName?: string): Skill | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  const meta: Record<string, string> = {};
  let body = text;
  if (match) {
    body = match[2];
    const lines = match[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(lines[i]);
      if (!kv) continue;
      let value = kv[2].trim();
      // a YAML list ("triggers:" then "- word" lines) becomes a comma-separated value
      if (value === '' && i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        const items: string[] = [];
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s*-\s+/, '').trim().replace(/^(["'])(.*)\1$/, '$2'));
        meta[kv[1].toLowerCase()] = items.join(', ');
        continue;
      }
      // a value continued on the indented lines below ("description:" + text, or a block scalar "> / |-")
      if (value === '' && i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) value = '>';
      if (/^[>|][+-]?$/.test(value)) {
        const folded = value.startsWith('>');
        const parts: string[] = [];
        while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) parts.push(lines[++i].trim());
        value = folded ? parts.join(' ').replace(/\s+/g, ' ').trim() : parts.join('\n').trim();
        value = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
      } else {
        value = value.replace(/^(["'])(.*)\1$/s, '$2');
      }
      meta[kv[1].toLowerCase()] = value;
    }
  }
  body = body.trim();
  if (!body) return null;
  const name = (forceName || meta.name || fallbackName).trim();
  if (!/^[\w.-]+$/.test(name)) return null;
  const declared = (meta.triggers || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const category = CATEGORIES.find((c) => c === meta.category && c !== 'other') ?? CATEGORY[name] ?? 'other';
  return {
    name,
    description: meta.description || '',
    triggers: declared.length ? declared : TRIGGERS[name] ?? [],
    body,
    source,
    category,
    official: OFFICIAL.has(name) && source === 'builtin',
    vendor: OFFICIAL.has(name) && source === 'builtin' ? 'anthropic' : undefined,
    dir: '',
  };
}

function readDir(dir: string, source: Skill['source']): Skill[] {
  const found: Skill[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const skill = parseSkill(fs.readFileSync(path.join(dir, entry.name, 'SKILL.md'), 'utf8'), entry.name, source);
      if (skill) found.push({ ...skill, dir: path.join(dir, entry.name) });
    } catch {
      /* folder without SKILL.md */
    }
  }
  return found;
}

/** Setting key of a project + model skills profile (null when either is unknown). */
export function profileKey(projectId: number | null | undefined, model: string | null | undefined): string | null {
  return projectId && model ? `skills_profile:${projectId}:${model}` : null;
}

/** The profile's switched-off skills, or null when that project + model has no profile of its own. */
export function profileDisabled(key: string | null): Set<string> | null {
  if (!key) return null;
  const raw = getSetting(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { disabled?: unknown };
    return Array.isArray(parsed.disabled) || Array.isArray((parsed as { enabled?: unknown }).enabled) ? new Set((Array.isArray(parsed.disabled) ? parsed.disabled : []).map(String)) : null;
  } catch {
    return null;
  }
}

/** Switched-off skills: the project + model profile when there is one, otherwise the global setting. */
export function disabledSkills(profile: string | null = null): Set<string> {
  return profileDisabled(profile) ?? new Set(
    getSetting('skills_disabled')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** `dist/server/skills.js` → `<app>/skills-library` (imported collections, see scripts/import-skills.mjs). */
function libraryDir(): string {
  return path.join(__dirname, '..', '..', 'skills-library');
}

interface LibraryEntry { vendor: 'anthropic' | 'openai'; repo: string; plugin: string | null; skill: string; category: SkillCategory }
let libraryCache: Skill[] | null = null;

/** The imported library: the id (`vendor.plugin.skill`) is the name, so skills of different plugins never clash. */
export function librarySkills(): Skill[] {
  if (libraryCache) return libraryCache;
  let index: Record<string, LibraryEntry> = {};
  try { index = JSON.parse(fs.readFileSync(path.join(libraryDir(), 'library.json'), 'utf8')) as Record<string, LibraryEntry>; } catch { /* no library */ }
  const out: Skill[] = [];
  for (const [id, entry] of Object.entries(index)) {
    const dir = path.join(libraryDir(), id);
    try {
      const parsed = parseSkill(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), id, 'library', id);
      if (parsed) out.push({ ...parsed, name: id, category: CATEGORIES.includes(entry.category) ? entry.category : 'other', vendor: entry.vendor, official: true, dir });
    } catch { /* unreadable entry */ }
  }
  libraryCache = out;
  return out;
}

/** Every known skill (enabled or not): library first, project skills last (later ones win on a name clash). */
export function allSkills(projectRoot?: string | null): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of librarySkills()) byName.set(s.name, s);
  const sources: Array<[string, Skill['source']]> = [[builtinDir(), 'builtin']];
  if (userDir) sources.push([path.join(userDir, 'skills'), 'user']);
  if (projectRoot) sources.push([path.join(projectRoot, '.otto', 'skills'), 'project']);
  for (const [dir, source] of sources) for (const s of readDir(dir, source)) byName.set(s.name, s);
  return [...byName.values()];
}

/** The user's choice: switched-off skills, and library skills switched on (library ones are off by default). */
export interface SkillChoice { disabled: Set<string>; enabled: Set<string> }

const list = (raw: string): Set<string> => new Set(raw.split(',').map((x) => x.trim()).filter(Boolean));

export function skillChoice(profile: string | null = null): SkillChoice {
  if (profile) {
    const raw = getSetting(profile);
    if (raw) {
      try {
        const p = JSON.parse(raw) as { disabled?: unknown; enabled?: unknown };
        if (Array.isArray(p.disabled) || Array.isArray(p.enabled)) {
          return { disabled: new Set((Array.isArray(p.disabled) ? p.disabled : []).map(String)), enabled: new Set((Array.isArray(p.enabled) ? p.enabled : []).map(String)) };
        }
      } catch { /* fall back to the global choice */ }
    }
  }
  return { disabled: list(getSetting('skills_disabled')), enabled: list(getSetting('skills_enabled')) };
}

export const isSkillOn = (skill: Skill, choice: SkillChoice): boolean =>
  skill.source === 'library' ? choice.enabled.has(skill.name) : !choice.disabled.has(skill.name);

export function enabledSkills(projectRoot?: string | null, profile: string | null = null): Skill[] {
  const choice = skillChoice(profile);
  return allSkills(projectRoot).filter((s) => isSkillOn(s, choice));
}

/** Skills whose trigger words occur in the request, best match (most distinct triggers) first. */
export function matchSkills(skills: Skill[], prompt: string): Skill[] {
  const text = prompt.toLowerCase();
  const hits = (s: Skill): number => s.triggers.filter((t) => text.includes(t)).length;
  // on a tie the closer source wins: the project's own skill, then the user's, then Otto's, then the official ones
  const rank = (s: Skill): number => (s.source === 'project' ? 0 : s.source === 'user' ? 1 : s.source === 'library' ? 4 : s.official ? 3 : 2);
  return skills.filter((s) => hits(s) > 0).sort((a, b) => hits(b) - hits(a) || rank(a) - rank(b));
}

/** How many matching skills are pasted into the prompt; the rest stay one `use_skill` call away. */
export const MAX_INJECTED_SKILLS = 2;

/** System-prompt block: injected bodies + the list of others. */
export function skillsPrompt(skills: Skill[], prompt: string, hasUseSkill = true): string {
  if (!skills.length) return '';
  const matched = matchSkills(skills, prompt).slice(0, MAX_INJECTED_SKILLS);
  const rest = skills.filter((s) => !matched.includes(s));
  let out = '';
  for (const s of matched) out += `\n\n=== НАВЫК «${s.name}» (применяй обязательно) ===\n${s.body}\n=== конец навыка ===`;
  if (rest.length && hasUseSkill) {
    out +=
      '\n\nДОСТУПНЫЕ НАВЫКИ (загрузи нужный вызовом use_skill(name), прежде чем делать такую работу):\n' +
      rest.map((s) => `- ${s.name}: ${s.description.length > 160 ? s.description.slice(0, 157) + '…' : s.description}`).join('\n');
  }
  return out;
}

export function skillByName(name: string, projectRoot?: string | null): Skill | undefined {
  return enabledSkills(projectRoot).find((s) => s.name === name.trim());
}

/** Files that come with a skill (scripts, references, templates), relative to its folder. */
export function skillFiles(skill: Skill, limit = 60): string[] {
  if (!skill.dir) return [];
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (r !== 'SKILL.md') out.push(r);
    }
  };
  walk(skill.dir, '');
  return out;
}

/** A text file of a skill (only inside the skill folder; binary files are refused). */
export function readSkillFile(skill: Skill, rel: string, maxChars = 60_000): string {
  const target = path.resolve(skill.dir, rel);
  const inside = path.relative(skill.dir, target);
  if (!skill.dir || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('The path must be inside the skill folder');
  const buf = fs.readFileSync(target);
  if (buf.subarray(0, 4096).includes(0)) throw new Error('Binary file: it is meant to be used by a script, not read');
  const text = buf.toString('utf8');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [cut at ${maxChars} characters]` : text;
}
