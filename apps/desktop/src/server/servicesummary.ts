/**
 * "How many services of each project are running": one `docker ps -a` for all projects, matched to a
 * project by the Compose working folder. Shown next to every project and on the Services button.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { dockerCliPath } from './env';

export interface ProjectServices {
  running: number;
  total: number;
  services: Array<{ name: string; state: string }>;
}

/** Service names declared in an otto.compose.yaml (the two-space keys under `services:`). */
export function composeServiceNames(yaml: string): string[] {
  const names: string[] = [];
  let inServices = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) { inServices = /^services:\s*$/.test(line); continue; }
    const m = inServices ? /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line) : null;
    if (m) names.push(m[1]);
  }
  return names;
}

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/**
 * `ps` lines are "state|working_dir|service". Containers of a project are the ones Compose started in its
 * folder; services that are declared but have no container yet count as stopped.
 */
export function summarize(
  projects: Array<{ id: number; path: string }>,
  psLines: string[],
  composeOf: (projectPath: string) => string | null,
): Record<number, ProjectServices> {
  const byDir = new Map<string, Map<string, string>>();
  for (const line of psLines) {
    const [state, dir, service] = line.trim().split('|');
    if (!dir || !service) continue;
    const key = norm(dir);
    if (!byDir.has(key)) byDir.set(key, new Map());
    const seen = byDir.get(key)!;
    // one service may have several containers (scale / old runs): running wins
    if (seen.get(service) !== 'running') seen.set(service, state);
  }
  const out: Record<number, ProjectServices> = {};
  for (const p of projects) {
    const states = new Map(byDir.get(norm(p.path)) ?? []);
    const yaml = composeOf(p.path);
    if (yaml) for (const name of composeServiceNames(yaml)) if (!states.has(name)) states.set(name, 'stopped');
    const services = [...states].map(([name, state]) => ({ name, state })).sort((a, b) => a.name.localeCompare(b.name));
    out[p.id] = { running: services.filter((s) => s.state === 'running').length, total: services.length, services };
  }
  return out;
}

let cache: { at: number; value: { docker: boolean; projects: Record<number, ProjectServices> } } | null = null;

export function serviceSummary(projects: Array<{ id: number; path: string }>): { docker: boolean; projects: Record<number, ProjectServices> } {
  if (cache && Date.now() - cache.at < 3000) return cache.value;
  const readCompose = (dir: string) => {
    try { return fs.readFileSync(path.join(dir, 'otto.compose.yaml'), 'utf8'); } catch { return null; }
  };
  const docker = dockerCliPath();
  let lines: string[] = [];
  let ok = false;
  if (docker) {
    const r = spawnSync(docker, ['ps', '-a', '--format', '{{.State}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.service"}}'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    ok = r.status === 0;
    if (ok) lines = String(r.stdout ?? '').split(/\r?\n/).filter(Boolean);
  }
  const value = { docker: ok, projects: summarize(projects, lines, readCompose) };
  cache = { at: Date.now(), value };
  return value;
}

/** After a start / stop the next request must see the change. */
export function forgetServiceSummary(): void { cache = null; }
