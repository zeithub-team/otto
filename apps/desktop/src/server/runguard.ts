/**
 * Guards of one agent run, the same for every model and mode (native tools, guided JSON, text calls).
 *
 * EditSession — rules for changing files that need to know what the run already did: a big existing
 * file is not rewritten unseen, and a rewrite that throws most of a file away must be sent twice.
 *
 * LoopGuard — notices a model going in circles: the same call with the same result, a failing call
 * repeated, steps that bring nothing new, a file flipping between versions. A repeat gets a short
 * refusal instead of running again; when the run stops making progress it is ended with a reason.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const nonBlankLines = (text: string): number => text.split(/\r?\n/).filter((l) => l.trim()).length;
const norm = (rel: string): string => rel.replace(/\\/g, '/').replace(/^\.?\/+/, '');

/** Lines of a file the model must have seen before it may rewrite the whole file. */
const UNSEEN_LIMIT = 30;

export class EditSession {
  private readonly seen = new Set<string>();
  private readonly confirmed = new Set<string>();

  /** The model read this file (or a part of it) in this run. */
  noteRead(rel: string): void {
    this.seen.add(norm(rel));
  }

  /** The run wrote this file: its content is the model's own now. */
  noteWrite(rel: string): void {
    this.seen.add(norm(rel));
  }

  /** A refusal for the model, or null when the write may go ahead. */
  check(tool: string, rel: string, before: string | null, after: string): string | null {
    const key = norm(rel);
    if (before === null || tool === 'append_file') return null;
    const was = nonBlankLines(before);
    if (tool === 'write_file' && was >= UNSEEN_LIMIT && !this.seen.has(key)) {
      return `REJECTED: ${key} has ${was} lines and you have not read it in this run, so the file is NOT changed. ` +
        'Rewriting a file without seeing it loses its content. read_file it first; for a small change use replace_in_file.';
    }
    const now = nonBlankLines(after);
    const lost = lostParts(key, before, after);
    const shrinks = was >= 10 && now < was * 0.5;
    if ((shrinks || lost.length) && !this.confirmed.has(key)) {
      this.confirmed.add(key);
      const what = [shrinks ? `${was} → ${now} lines` : '', lost.length ? `removes ${lost.join(', ')}` : ''].filter(Boolean).join('; ');
      return `REJECTED for now: this ${tool} on ${key} throws away most of the file (${what}); the file is NOT changed. ` +
        'If the user asked only for a part to change, keep everything else (use replace_in_file for small changes). ' +
        'If removing this really is the task, send exactly the same call again to confirm.';
    }
    return null;
  }
}

/** Finished blocks of a page that a rewrite drops (a small model rewriting a page loses the menu, the form…). */
function lostParts(rel: string, before: string, after: string): string[] {
  if (!/\.html?$/i.test(rel)) return [];
  const count = (t: string, re: RegExp) => (t.match(re) ?? []).length;
  const checks: Array<[string, RegExp]> = [
    ['form', /<form\b/gi], ['sections', /<section\b/gi], ['headings', /<h[1-3]\b/gi], ['scripts', /<script\b/gi], ['stylesheets', /<link[^>]+stylesheet/gi],
  ];
  const lost: string[] = [];
  for (const [name, re] of checks) {
    const b = count(before, re);
    const a = count(after, re);
    if (b > a && (b - a >= 2 || a === 0)) lost.push(`${name} ${b}→${a}`);
  }
  return lost;
}

export type ToolKind = 'read' | 'write' | 'exec' | 'other';

const READ = new Set(['list_files', 'read_file', 'read_files', 'search_files', 'web_search', 'fetch_url', 'read_skill_file', 'use_skill', 'preview_page', 'ssh_sessions', 'ssh_list', 'ssh_read_file', 'connector_tools']);
const WRITE = new Set(['write_file', 'append_file', 'replace_in_file', 'delete_file', 'delete_path', 'ssh_write_file']);
const EXEC = new Set(['run_command', 'otto_docker', 'ssh_exec', 'run_in_page']);

export function toolKind(name: string): ToolKind {
  return READ.has(name) ? 'read' : WRITE.has(name) ? 'write' : EXEC.has(name) ? 'exec' : 'other';
}

/** A tool result that reports a failure (nothing was done, or the command failed). */
export function isFailure(result: string): boolean {
  return /^(Tool failed|REJECTED|Ошибка|Usage:|File not found|Text not found|Path not found|Folder not found|Refused|Unknown tool|Otto Docker action failed|The user declined|Running commands is turned off|Commands need|This needs the user|Repeated call|Not run)/.test(result.trimStart()) ||
    /^\$ .*\n\((exit code (?!0\b)|stopped: time limit)/.test(result);
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};
const hash = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16);
/** A result without what changes from run to run (timings, change counters). */
const resultHash = (result: string): string => hash(result.replace(/, [\d.]+ s\)/g, ')').replace(/\[Δ \+\d+ −\d+\]/g, ''));

interface Past {
  hash: string;
  failed: boolean;
  /** How many times in a row this exact call gave this exact failure. */
  sameFailures: number;
  /** Writes done in the run when it happened: a later write can change its result. */
  epoch: number;
  step: number;
  head: string;
}

export interface LoopLimits {
  /** Calls in a row that bring nothing new. */
  idle: number;
  /** Failed calls in a row. */
  failures: number;
  /** Refused repeats in a row. */
  refusals: number;
}

const DEFAULT_LIMITS: LoopLimits = { idle: 6, failures: 5, refusals: 3 };

export class LoopGuard {
  private readonly past = new Map<string, Past>();
  private readonly results = new Set<string>();
  private readonly versions = new Map<string, string[]>();
  private epoch = 0;
  private calls = 0;
  private idle = 0;
  private failures = 0;
  private refusals = 0;
  private reverts = 0;
  private stop: string | null = null;

  constructor(private readonly root: string, private readonly limits: LoopLimits = DEFAULT_LIMITS) {}

  /** Why the run should end now, or null while it is making progress. */
  get stopReason(): string | null {
    return this.stop;
  }

  /** Old results were cut out of the context to make room: the model may need them again. */
  forgetResults(): void {
    this.epoch++;
    this.results.clear();
  }

  /** A refusal to give the model INSTEAD of running the call, or null to run it. */
  before(name: string, args: unknown): string | null {
    const prev = this.past.get(`${name}:${stable(args)}`);
    let refusal: string | null = null;
    if (prev) {
      const kind = toolKind(name);
      if (prev.failed && prev.sameFailures >= 2) {
        refusal = `Repeated call: this exact ${name} call already failed ${prev.sameFailures} times with the same result, so it is not run again:\n${prev.head}\nDo something different: fix the cause, change the arguments, or tell the user what blocks you.`;
      } else if (prev.failed && /^The user declined/.test(prev.head)) {
        refusal = `Repeated call: the user declined this ${name} call; it is not asked again. Go on without it or ask the user what they prefer.`;
      } else if (!prev.failed && name === 'append_file') {
        refusal = 'Repeated call: exactly this text was already appended to this file; appending it again would duplicate it. Go on with the next part or the next step.';
      } else if (!prev.failed && (kind === 'read' || kind === 'exec') && prev.epoch === this.epoch) {
        refusal = `Repeated call: nothing changed since this exact ${name} call (step ${prev.step + 1}), so its result would be the same — it is above in the conversation:\n${prev.head}\nUse it and go on with the next step.`;
      }
    }
    if (refusal) {
      this.refusals++;
      this.idle++;
      if (this.refusals >= this.limits.refusals) this.stop = `the model kept repeating calls that were already done (${this.refusals} in a row)`;
      else if (this.idle >= this.limits.idle) this.stop = `${this.idle} steps in a row brought nothing new`;
    }
    return refusal;
  }

  /** Record what a call returned. */
  after(name: string, args: unknown, result: string): void {
    const key = `${name}:${stable(args)}`;
    const kind = toolKind(name);
    const failed = isFailure(result);
    const h = resultHash(result);
    const prev = this.past.get(key);
    const declined = /^The user declined/.test(result.trimStart());
    this.past.set(key, {
      hash: h,
      failed,
      sameFailures: failed ? (declined ? 2 : prev && prev.failed && prev.hash === h ? prev.sameFailures + 1 : 1) : 0,
      epoch: this.epoch,
      step: this.calls,
      head: result.trim().slice(0, 300),
    });
    this.calls++;
    this.refusals = 0;
    let progress: boolean;
    if (kind === 'write') {
      progress = !failed && !/^No change/.test(result);
      if (progress) {
        this.epoch++;
        this.trackVersion(name, args);
      }
    } else {
      progress = !failed && !this.results.has(h);
    }
    this.results.add(h);
    this.idle = progress ? 0 : this.idle + 1;
    this.failures = failed ? this.failures + 1 : 0;
    if (this.failures >= this.limits.failures) this.stop = `${this.failures} tool calls in a row failed`;
    else if (this.idle >= this.limits.idle) this.stop = `${this.idle} steps in a row brought nothing new`;
    else if (this.reverts >= 2) this.stop = 'files keep switching back to earlier versions';
  }

  /** A file that goes back to a version it already had in this run: the model undoes its own work. */
  private trackVersion(name: string, args: unknown): void {
    const rel = typeof (args as { path?: unknown })?.path === 'string' ? norm((args as { path: string }).path) : '';
    if (!rel || name === 'ssh_write_file') return;
    let content: string;
    try { content = fs.readFileSync(path.resolve(this.root, rel), 'utf8'); } catch { content = '\0deleted'; }
    const h = hash(content);
    const list = this.versions.get(rel) ?? [];
    if (list.slice(0, -1).includes(h)) this.reverts++;
    list.push(h);
    this.versions.set(rel, list);
  }
}
