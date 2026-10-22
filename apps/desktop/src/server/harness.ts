/**
 * Per-model harness profiles (after Google Research's Harness²): the parts of Otto's agent setup
 * that may be tuned for one model — extra system-prompt text, extra guidance on individual tools,
 * and short learned rules ("memory"). Guardrails (approvals, permissions) are NOT part of a profile
 * and can never be changed by one.
 *
 * Profiles are produced by the tuner (bench/tune.ts) from measured runs and applied only after the
 * user accepts them. Stored in <dataDir>/harness/profiles.json, keyed by the exact model id.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface HarnessProfile {
  /** Appended to the system prompt. Keep it short: it is paid for on every request. */
  systemExtra?: string;
  /** Extra guidance appended to a tool's description, by tool name. */
  toolGuidance?: Record<string, string>;
  /** Short rules learned from runs (one line each). */
  memory?: string[];
  /** Where it came from (tuner run, editor model, scores) — for the person deciding. */
  notes?: string;
}

const LIMITS = { systemExtra: 1500, tool: 400, memoryItems: 8, memoryItem: 200 };

let dataDir = '';
export function configureHarness(opts: { dataDir: string }): void { dataDir = opts.dataDir; }

const file = () => path.join(dataDir, 'harness', 'profiles.json');

function readAll(): Record<string, HarnessProfile> {
  if (!dataDir) return {};
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, HarnessProfile>; } catch { return {}; }
}

/** A profile cut to the size limits, with nothing but the editable fields. */
export function sanitizeProfile(p: unknown): HarnessProfile {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const out: HarnessProfile = {};
  const sys = str(o.systemExtra, LIMITS.systemExtra);
  if (sys) out.systemExtra = sys;
  if (o.toolGuidance && typeof o.toolGuidance === 'object') {
    const tg: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.toolGuidance as Record<string, unknown>)) {
      const s = str(v, LIMITS.tool);
      if (s && /^[a-z_]{2,40}$/.test(k)) tg[k] = s;
    }
    if (Object.keys(tg).length) out.toolGuidance = tg;
  }
  if (Array.isArray(o.memory)) {
    const mem = o.memory.map((m) => str(m, LIMITS.memoryItem)).filter(Boolean).slice(0, LIMITS.memoryItems);
    if (mem.length) out.memory = mem;
  }
  const notes = str(o.notes, 4000);
  if (notes) out.notes = notes;
  return out;
}

export function getProfile(model: string | null | undefined): HarnessProfile | null {
  if (!model) return null;
  return readAll()[model] ?? null;
}

export function saveProfile(model: string, p: HarnessProfile | null): void {
  const all = readAll();
  if (p && Object.keys(sanitizeProfile(p)).length) all[model] = sanitizeProfile(p);
  else delete all[model];
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}

export function listProfiles(): Record<string, HarnessProfile> { return readAll(); }

/** System-prompt block for a profile ('' when there is nothing to add). */
export function profileSystemText(p: HarnessProfile | null): string {
  if (!p) return '';
  const parts: string[] = [];
  if (p.systemExtra) parts.push(p.systemExtra);
  if (p.memory?.length) parts.push('Rules learned for this model:\n' + p.memory.map((m) => `- ${m}`).join('\n'));
  return parts.length ? `MODEL-SPECIFIC GUIDANCE\n${parts.join('\n\n')}` : '';
}

/** Tool specs (OpenAI/Ollama function format) with the profile's guidance appended to descriptions. */
export function applyToolGuidance<T>(specs: T[], p: HarnessProfile | null): T[] {
  const tg = p?.toolGuidance;
  if (!tg || !Object.keys(tg).length) return specs;
  return specs.map((s) => {
    const fn = (s as { function?: { name?: string; description?: string } }).function;
    const extra = fn?.name ? tg[fn.name] : undefined;
    return extra && fn ? ({ ...s, function: { ...fn, description: `${fn.description ?? ''} ${extra}`.trim() } } as T) : s;
  });
}
