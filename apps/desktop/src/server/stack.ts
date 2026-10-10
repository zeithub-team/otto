/**
 * Starting a whole project: every app of the folder (composition.ts) plus the services they need.
 *
 *   docker — the root compose builds and runs everything (`docker compose up -d --build`)
 *   hybrid — databases / Redis / queues in Docker (the compose infrastructure services, or the project's
 *            Otto services), the apps themselves as local processes (fast reloads, local tools)
 *   local  — only local processes
 *
 * The first app with a UI is the Preview's run (runner.ts, key = project id); the others run under
 * `<project>:<dir>:<process>` keys. Each start waits for its port, so the answer says what really runs.
 */

import { spawn } from 'child_process';
import { callOttoDocker } from './ollama';
import { getRun, portOpen, startRun, stopRun } from './runner';
import { scanComposition, type Composition } from './composition';
import { refreshProcessPath } from './env';

export type StackMode = 'local' | 'hybrid' | 'docker';

interface Started { key: number | string; label: string; unit: string; port: number | null; preview: boolean }
const stacks = new Map<number, { mode: StackMode; root: string; started: Started[]; composeDown: string[] }>();

/** docker when a root compose builds the apps; hybrid when there are services to run (a DB…); else local. */
export function recommendMode(c: Composition): StackMode {
  if (c.dockerReady) return 'docker';
  if (c.compose.some((f) => f.infra.length) || c.units.some((u) => u.needs.length)) return 'hybrid';
  return 'local';
}

/** Runs a one-off command (docker compose up -d…) to its end. */
function runOnce(root: string, command: string, timeoutMs = 15 * 60_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    refreshProcessPath();
    const proc = spawn(command, { cwd: root, shell: true, windowsHide: true });
    let out = '';
    const take = (b: Buffer): void => { out = (out + b.toString('utf8')).slice(-6000); };
    proc.stdout?.on('data', take);
    proc.stderr?.on('data', take);
    const timer = setTimeout(() => { proc.kill(); out += '\n[timed out]'; }, timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `${out}\n${e.message}` }); });
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

async function waitUp(key: number | string, port: number | null, ms = 90_000): Promise<boolean> {
  for (let t = 0; t < ms; t += 1000) {
    const st = getRun(key);
    if (st.url || st.status === 'running') return true;
    if (st.status === 'exited') return false;
    if (port && await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export interface StackReport { mode: StackMode; lines: string[]; previewUrl: string | null; ok: boolean }

/** Start the stack. `only`: the app folders to start (default: all). */
export async function upStack(projectId: number, root: string, mode?: StackMode, only?: string[]): Promise<StackReport> {
  const c = scanComposition(root);
  const m = mode ?? recommendMode(c);
  await downStack(projectId);
  const lines: string[] = [];
  const state = { mode: m, root, started: [] as Started[], composeDown: [] as string[] };
  stacks.set(projectId, state);
  let ok = true;
  let previewUrl: string | null = null;

  if (m === 'docker') {
    const file = c.compose[0]?.file;
    if (!file) return { mode: m, lines: ['No compose file: the stack cannot run in Docker. Use mode hybrid/local, or write a compose.yaml first.'], previewUrl: null, ok: false };
    const r = await runOnce(root, `docker compose -f ${file} up -d --build`);
    lines.push(`docker compose -f ${file} up -d --build → ${r.code === 0 ? 'started' : `FAILED (${r.code})`}`, r.out.split('\n').slice(-25).join('\n'));
    ok = r.code === 0;
    if (ok) state.composeDown.push(`docker compose -f ${file} down`);
    const front = c.compose[0].apps.find((s) => s.ports.length);
    if (ok && front) previewUrl = `http://localhost:${front.ports[0]}/`;
    return { mode: m, lines, previewUrl, ok };
  }

  // services first: compose infrastructure (DB, Redis…) in Docker, then the project's Otto services
  if (m === 'hybrid') {
    for (const cf of c.compose.filter((f) => f.infra.length)) {
      const names = cf.infra.map((s) => s.name).join(' ');
      const r = await runOnce(root, `docker compose -f ${cf.file} up -d ${names}`);
      lines.push(`services ${names} (${cf.file}) → ${r.code === 0 ? 'up' : `FAILED: ${r.out.split('\n').slice(-6).join(' ')}`}`);
      if (r.code === 0) state.composeDown.push(`docker compose -f ${cf.file} stop ${names}`);
      else ok = false;
    }
    const covered = new Set(c.compose.flatMap((f) => f.infra.map((s) => s.name.toLowerCase())));
    const missing = [...new Set(c.units.flatMap((u) => u.needs))].filter((n) => ![...covered].some((s) => s.includes(n.slice(0, 5))));
    if (missing.length) {
      const otto = await callOttoDocker(projectId, 'up');
      lines.push(/unavailable|failed|no services|not found/i.test(otto)
        ? `needed but not declared anywhere: ${missing.join(', ')} — add them in Services (otto.compose.yaml) and set the .env hosts to 127.0.0.1 with the published ports.`
        : `Otto services (otto.compose.yaml) → ${otto.split('\n').slice(-3).join(' ')}`);
    }
  }

  // the apps, all at once; the first UI goes to the Preview
  const units = c.units.filter((u) => !only?.length || only.includes(u.dir) || only.includes(u.name));
  let previewTaken = false;
  const waits: Array<Promise<void>> = [];
  for (const u of units) {
    for (const p of u.processes) {
      const preview = !previewTaken && p.frontend;
      if (preview) previewTaken = true;
      const key = preview ? projectId : `${projectId}:${u.dir || '.'}:${p.id}`;
      if (p.port && await portOpen(p.port)) lines.push(`⚠ port ${p.port} is already taken (another program or an earlier run) — ${u.dir || '(root)'} may fail or use another port.`);
      startRun(key, root, p.command, p.port);
      const s: Started = { key, label: p.label, unit: u.dir || '(root)', port: p.port, preview };
      state.started.push(s);
      waits.push(waitUp(key, p.port).then((up) => {
        const st = getRun(key);
        if (preview && st.url) previewUrl = st.url;
        if (!up) ok = false;
        lines.push(`${up ? '✓' : '✗'} ${s.unit}: ${p.command}${st.url ? ` → ${st.url}` : p.port ? ` (port ${p.port})` : ''}${up ? '' : `\n   last output:\n   ${st.log.slice(-12).join('\n   ')}`}`);
      }));
    }
  }
  await Promise.all(waits);
  if (!state.started.length && m !== 'hybrid') lines.push('No app processes to start.');
  if (c.conflicts.length) lines.push(`Port conflicts: ${c.conflicts.map((x) => `${x.port}: ${x.units.join(' & ')}`).join('; ')}`);
  return { mode: m, lines, previewUrl, ok };
}

export async function downStack(projectId: number): Promise<string[]> {
  const st = stacks.get(projectId);
  if (!st) return [];
  const out: string[] = [];
  for (const s of st.started) { stopRun(s.key); out.push(`stopped ${s.unit}: ${s.label}`); }
  for (const cmd of st.composeDown) {
    const r = await runOnce(st.root, cmd).catch(() => ({ code: -1, out: '' }));
    out.push(`${cmd} → ${r.code === 0 ? 'ok' : 'failed'}`);
  }
  stacks.delete(projectId);
  return out;
}

export function stackStatus(projectId: number): string {
  const st = stacks.get(projectId);
  if (!st) return 'No stack is running for this project (otto_stack action=up starts it).';
  return [`Mode: ${st.mode}`, ...st.started.map((s) => {
    const r = getRun(s.key);
    return `${s.unit}: ${s.label} — ${r.status}${r.url ? ` ${r.url}` : ''}${s.preview ? ' (Preview)' : ''}`;
  })].join('\n');
}

export function stackLogs(projectId: number, unit?: string): string {
  const st = stacks.get(projectId);
  if (!st) return 'No stack is running.';
  return st.started.filter((s) => !unit || s.unit === unit || s.unit.endsWith(`/${unit}`))
    .map((s) => `--- ${s.unit}: ${s.label}\n${getRun(s.key).log.slice(-40).join('\n')}`).join('\n\n');
}
