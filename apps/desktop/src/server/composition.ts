/**
 * What a project folder is made of. One folder often holds several apps (a Laravel API, a Next.js site,
 * a React admin, a worker…), some with a Dockerfile or their own compose file, each with its ports and
 * credentials in .env. The scanner walks the root and two levels of sub-folders and describes every app:
 * framework, how to start it locally, what Docker can build, its ports and the services it needs
 * (database, Redis…) with the credentials it expects. Ports two apps want at the same time are flagged.
 *
 * Secrets are never handed out: passwords, keys and tokens show only whether they are set.
 */

import * as fs from 'fs';
import * as path from 'path';
import { detectProject, parseCompose, type ComposeService, type RunOption } from './detect';

export type UnitRole = 'frontend' | 'backend' | 'fullstack' | 'static' | 'worker' | 'unknown';

export interface UnitProcess {
  id: string;
  label: string;
  /** Run from the project root (`cd <dir> && …` already included). */
  command: string;
  port: number | null;
  frontend: boolean;
}

export interface EnvEntry { key: string; value: string; secret: boolean }

export interface Unit {
  /** Folder relative to the project root ('' = the root itself). */
  dir: string;
  name: string;
  stacks: string[];
  role: UnitRole;
  processes: UnitProcess[];
  docker: { dockerfile: boolean; compose: string | null; services: ComposeService[]; exposes: number[] };
  ports: Array<{ port: number; source: string }>;
  /** Connection settings from .env (or .env.example): DB, Redis, mail, URLs, ports. */
  env: { file: string | null; entries: EnvEntry[] };
  /** Services the app expects, by its settings (postgres, mysql, redis, mongo, rabbitmq…). */
  needs: string[];
}

export interface Composition {
  root: string;
  units: Unit[];
  /** Compose files and the infrastructure / app services they declare. */
  compose: Array<{ file: string; infra: ComposeService[]; apps: ComposeService[] }>;
  conflicts: Array<{ port: number; units: string[] }>;
  /** A root compose that builds the apps: the whole stack can run in Docker. */
  dockerReady: boolean;
}

const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.next', '.nuxt', 'out', 'target', 'coverage', '.venv', 'venv', '__pycache__', 'storage', 'bootstrap', 'public', 'resources', 'src', 'tests', 'test', 'docs', 'migrations', 'database', 'config', 'routes', 'lib', 'assets', 'static', 'templates', '.idea', '.vscode', '.github', 'docker', '.docker']);
const MARKERS = ['package.json', 'artisan', 'composer.json', 'manage.py', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Gemfile', 'Dockerfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Cargo.toml', 'compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml', 'index.html'];
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const INFRA = /postgres|postgis|mysql|mariadb|redis|valkey|mongo|rabbit|kafka|zookeeper|minio|elastic|opensearch|meili|typesense|mailhog|mailpit|memcached|clickhouse|nats|keycloak|adminer|pgadmin|phpmyadmin|localstack|db$|^db|cache|queue/i;
const SECRET = /pass|secret|token|key|private|credential|salt/i;
const ENV_KEYS = /^(DB_|DATABASE|POSTGRES|PG|MYSQL|MARIADB|MONGO|REDIS|RABBIT|AMQP|KAFKA|ELASTIC|MEILI|MINIO|S3_|AWS_|MAIL_|SMTP|APP_URL|APP_PORT|APP_ENV|PORT$|HOST$|SERVER_PORT|API_URL|BACKEND_URL|FRONTEND_URL|NEXT_PUBLIC_|VITE_|REACT_APP_|NUXT_|CACHE_|QUEUE_|SESSION_DRIVER|BROADCAST|JWT_|SECRET_KEY|DJANGO_)/i;

const read = (file: string): string => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const exists = (p: string): boolean => fs.existsSync(p);
const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** KEY=VALUE lines of a .env file (quotes removed). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** What the settings say the app needs. */
export function needsOf(env: Record<string, string>, deps: string): string[] {
  const all = `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n${deps}`.toLowerCase();
  const out = new Set<string>();
  const conn = (env.DB_CONNECTION ?? '').toLowerCase();
  if (conn === 'pgsql' || /postgres(ql)?:\/\/|psycopg|"pg"|asyncpg|npgsql/.test(all)) out.add('postgres');
  if (conn === 'mysql' || conn === 'mariadb' || /mysql:\/\/|mysql2|pymysql|mysqlclient/.test(all)) out.add('mysql');
  if (/mongodb(\+srv)?:\/\/|mongoose|pymongo|"mongodb"/.test(all)) out.add('mongo');
  if (/redis_host|redis:\/\/|cache_driver=redis|cache_store=redis|queue_connection=redis|ioredis|"redis"/.test(all)) out.add('redis');
  if (/amqp:\/\/|rabbitmq|amqplib/.test(all)) out.add('rabbitmq');
  if (/mail_host=(mailhog|mailpit)|smtp.*1025/.test(all)) out.add('mailpit');
  return [...out];
}

/** Ports an app asks for in its scripts, settings and Dockerfile. */
function portsOf(dir: string, env: Record<string, string>, opts: RunOption[]): Array<{ port: number; source: string }> {
  const out: Array<{ port: number; source: string }> = [];
  const add = (port: number, source: string): void => { if (port > 0 && port < 65536 && !out.some((p) => p.port === port)) out.push({ port, source }); };
  for (const k of ['PORT', 'APP_PORT', 'SERVER_PORT', 'HTTP_PORT']) if (/^\d+$/.test(env[k] ?? '')) add(Number(env[k]), `.env ${k}`);
  const pkg = read(path.join(dir, 'package.json'));
  for (const m of pkg.matchAll(/(?:--port[ =]|-p\s+|PORT=)(\d{2,5})/g)) add(Number(m[1]), 'package.json script');
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) { const m = /port\s*:\s*(\d{2,5})/.exec(read(path.join(dir, f))); if (m) add(Number(m[1]), f); }
  for (const m of read(path.join(dir, 'Dockerfile')).matchAll(/^\s*EXPOSE\s+(\d{2,5})/gim)) add(Number(m[1]), 'Dockerfile EXPOSE');
  for (const o of opts) if (o.port) add(o.port, `${o.label} (default)`);
  return out;
}

const roleOf = (procs: UnitProcess[], stacks: string[], hasIndex: boolean): UnitRole => {
  const ui = procs.some((p) => p.frontend);
  const api = procs.some((p) => !p.frontend);
  if (ui && api) return 'fullstack';
  if (stacks.some((s) => /Laravel|Django|Rails/.test(s))) return 'fullstack';
  if (ui) return 'frontend';
  if (api) return 'backend';
  if (hasIndex) return 'static';
  return 'unknown';
};

/** Extra stacks detect.ts does not run (Java, .NET, Rust): how to start them. */
function extraOptions(dir: string): Array<RunOption & { stack: string }> {
  const at = (n: string): boolean => exists(path.join(dir, n));
  if (at('pom.xml')) return [{ id: 'java', label: 'Spring / Maven', command: at('mvnw') ? './mvnw spring-boot:run' : 'mvn spring-boot:run', port: 8080, kind: 'none', frontend: false, stack: 'Java (Maven)' }];
  if (at('build.gradle') || at('build.gradle.kts')) return [{ id: 'gradle', label: 'Gradle bootRun', command: at('gradlew') ? './gradlew bootRun' : 'gradle bootRun', port: 8080, kind: 'none', frontend: false, stack: 'Java (Gradle)' }];
  if (at('Cargo.toml')) return [{ id: 'rust', label: 'Rust (cargo run)', command: 'cargo run', port: null, kind: 'none', frontend: false, stack: 'Rust' }];
  try {
    if (fs.readdirSync(dir).some((f) => f.endsWith('.csproj'))) return [{ id: 'dotnet', label: '.NET (dotnet run)', command: 'dotnet run', port: 5000, kind: 'none', frontend: false, stack: '.NET' }];
  } catch { /* unreadable */ }
  return [];
}

function unitOf(root: string, rel: string): Unit | null {
  const dir = rel ? path.join(root, rel) : root;
  const d = detectProject(dir);
  const pkg = (() => { try { return JSON.parse(read(path.join(dir, 'package.json'))) as { workspaces?: unknown; name?: string }; } catch { return null; } })();
  // options of sub-folders are units of their own; a workspace root only orchestrates them
  const own = [...d.options.filter((o) => !/^(ws|dir|back):/.test(o.id) && o.kind !== 'docker' && !(o.id === 'root' && pkg?.workspaces)), ...extraOptions(dir)];
  const cd = (cmd: string): string => (rel ? `cd ${rel.split(path.sep).join('/')} && ${cmd}` : cmd);
  const processes: UnitProcess[] = own.map((o) => ({ id: o.id, label: o.label, command: cd(o.command), port: o.port, frontend: o.frontend }));
  const composeName = COMPOSE_FILES.find((f) => exists(path.join(dir, f))) ?? null;
  const dockerfile = exists(path.join(dir, 'Dockerfile'));
  if (!processes.length && !composeName && !dockerfile && !d.hasIndex) return null;
  const envFile = ['.env', '.env.local', '.env.development', '.env.example', '.env.dist'].find((f) => exists(path.join(dir, f))) ?? null;
  const env = envFile ? parseEnv(read(path.join(dir, envFile))) : {};
  const deps = read(path.join(dir, 'package.json')) + read(path.join(dir, 'composer.json')) + read(path.join(dir, 'requirements.txt')) + read(path.join(dir, 'pyproject.toml')) + read(path.join(dir, 'go.mod'));
  const services = composeName ? parseCompose(read(path.join(dir, composeName))) : [];
  const stacks = [...new Set([...d.stacks.filter((s) => !/Docker Compose|Static site/.test(s) || !processes.length), ...extraOptions(dir).map((o) => o.stack)])];
  return {
    dir: rel.split(path.sep).join('/'),
    name: rel ? path.basename(rel) : (pkg?.name ?? path.basename(root)),
    stacks,
    role: roleOf(processes, stacks, d.hasIndex),
    processes,
    docker: { dockerfile, compose: composeName, services, exposes: [...read(path.join(dir, 'Dockerfile')).matchAll(/^\s*EXPOSE\s+(\d{2,5})/gim)].map((m) => Number(m[1])) },
    ports: portsOf(dir, env, own),
    env: {
      file: envFile,
      entries: Object.entries(env).filter(([k]) => ENV_KEYS.test(k)).slice(0, 40).map(([key, value]) => ({ key, value: SECRET.test(key) ? (value ? '••• (set)' : '(empty)') : value, secret: SECRET.test(key) })),
    },
    needs: needsOf(env, deps),
  };
}

/** Folders that may hold an app: the root, its sub-folders and theirs (apps/web, services/api…). */
function candidates(root: string): string[] {
  const out = [''];
  const walk = (rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const child = rel ? path.join(rel, e.name) : e.name;
      if (MARKERS.some((m) => exists(path.join(root, child, m)))) out.push(child);
      if (depth < 2) walk(child, depth + 1);
    }
  };
  walk('', 1);
  return out;
}

export function scanComposition(root: string): Composition {
  const units: Unit[] = [];
  for (const rel of candidates(root)) {
    const u = unitOf(root, rel);
    if (u) units.push(u);
  }
  // the root of a multi-app folder with nothing to run itself (only a README or a compose) is not an app
  const real = units.filter((u) => u.dir === '' ? u.processes.length > 0 || units.length === 1 : true);
  const compose = real.filter((u) => u.docker.compose).map((u) => ({
    file: u.dir ? `${u.dir}/${u.docker.compose}` : u.docker.compose!,
    infra: u.docker.services.filter((s) => INFRA.test(s.name)),
    apps: u.docker.services.filter((s) => !INFRA.test(s.name)),
  }));
  // the root compose may belong to a root "unit" that was dropped above
  const rootCompose = COMPOSE_FILES.find((f) => exists(path.join(root, f)));
  if (rootCompose && !compose.some((c) => c.file === rootCompose)) {
    const services = parseCompose(read(path.join(root, rootCompose)));
    compose.unshift({ file: rootCompose, infra: services.filter((s) => INFRA.test(s.name)), apps: services.filter((s) => !INFRA.test(s.name)) });
  }
  const byPort = new Map<number, string[]>();
  for (const u of real) {
    for (const p of u.processes) if (p.port) byPort.set(p.port, [...new Set([...(byPort.get(p.port) ?? []), u.dir || '(root)'])]);
  }
  const conflicts = [...byPort.entries()].filter(([, us]) => us.length > 1).map(([port, us]) => ({ port, units: us }));
  const rootFile = rootCompose ? read(path.join(root, rootCompose)) : '';
  return { root, units: real, compose, conflicts, dockerReady: Boolean(rootCompose && /^\s+build\s*:/m.test(rootFile)) };
}

/** The composition as text for a model (and the Otto tool's answer). */
export function describeComposition(c: Composition): string {
  if (!c.units.length) return 'Nothing runnable was found in this folder.';
  const lines: string[] = [`Project folder has ${c.units.length} app(s):`];
  for (const u of c.units) {
    lines.push(`\n■ ${u.dir || '(root)'} — ${u.stacks.join(', ') || 'unknown'} [${u.role}]`);
    for (const p of u.processes) lines.push(`  run: ${p.command}${p.port ? `  (port ${p.port})` : ''}${p.frontend ? '  UI' : ''}`);
    const dk = [u.docker.dockerfile ? `Dockerfile${u.docker.exposes.length ? ` (EXPOSE ${u.docker.exposes.join(', ')})` : ''}` : '', u.docker.compose ? `${u.docker.compose}: ${u.docker.services.map((s) => `${s.name}${s.ports.length ? `:${s.ports.join('/')}` : ''}`).join(', ')}` : ''].filter(Boolean);
    if (dk.length) lines.push(`  docker: ${dk.join('; ')}`);
    if (u.ports.length) lines.push(`  ports: ${u.ports.map((p) => `${p.port} (${p.source})`).join(', ')}`);
    if (u.needs.length) lines.push(`  needs: ${u.needs.join(', ')}`);
    if (u.env.entries.length) lines.push(`  ${u.env.file}: ${u.env.entries.map((e) => `${e.key}=${e.value}`).join('; ')}`);
  }
  for (const cf of c.compose) lines.push(`\nCompose ${cf.file}: infrastructure [${cf.infra.map((s) => `${s.name}${s.ports.length ? `:${s.ports.join('/')}` : ''}`).join(', ') || '—'}], apps [${cf.apps.map((s) => s.name).join(', ') || '—'}]`);
  if (c.conflicts.length) lines.push(`\nPORT CONFLICTS: ${c.conflicts.map((x) => `${x.port} wanted by ${x.units.join(' and ')}`).join('; ')} — give each app its own port (PORT / --port / APP_PORT) before starting them together.`);
  return lines.join('\n');
}
