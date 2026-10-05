'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../types';
import { syncProjectEnv, createProjectFile, createProjectFolder, dockerProjectAction, dockerServiceAction, startServiceStream, saveFileContent, fetchEnvStatus, installTool, fetchFileContent, announceServicesChanged, type ToolStatus } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useConfirm } from '../ui/Confirm';
import { PhpManager } from './PhpManager';
import { Boxes, Database, Play, Square, RefreshCw, ExternalLink, Container, Plus, ChevronDown, ChevronRight, Trash2, X, Settings2, Copy, Check, ScrollText, Loader2, Wrench, Download, Cpu, BookOpen, RotateCw } from 'lucide-react';

type ServiceKey = 'postgres' | 'mysql' | 'mariadb' | 'mongodb' | 'redis' | 'elasticsearch' | 'rabbitmq' | 'mongo-express' | 'pgadmin' | 'adminer' | 'kibana' | 'redisinsight' | 'soketi' | 'centrifugo';
type ServiceDef = { key: ServiceKey; name: string; image: string; port: number; group: 'database' | 'client' | 'realtime'; note: string };
const CATALOG: ServiceDef[] = [
  { key: 'postgres', name: 'PostgreSQL', image: 'postgres:17', port: 5432, group: 'database', note: 'Relational database' },
  { key: 'mysql', name: 'MySQL', image: 'mysql:8.4', port: 3306, group: 'database', note: 'Relational database' },
  { key: 'mariadb', name: 'MariaDB', image: 'mariadb:11', port: 3307, group: 'database', note: 'MySQL-compatible database' },
  { key: 'mongodb', name: 'MongoDB', image: 'mongo:8', port: 27017, group: 'database', note: 'Document database' },
  { key: 'redis', name: 'Redis', image: 'redis:7', port: 6379, group: 'database', note: 'Cache / key-value store' },
  { key: 'elasticsearch', name: 'Elasticsearch', image: 'elasticsearch:8.17.4', port: 9200, group: 'database', note: 'Search and analytics' },
  { key: 'rabbitmq', name: 'RabbitMQ', image: 'rabbitmq:4-management', port: 5672, group: 'database', note: 'Message broker (management UI on +10000)' },
  { key: 'soketi', name: 'Soketi', image: 'quay.io/soketi/soketi:latest-16-alpine', port: 6001, group: 'realtime', note: 'WebSocket server, Pusher-compatible (Laravel Echo, Reverb-like)' },
  { key: 'centrifugo', name: 'Centrifugo', image: 'centrifugo/centrifugo:v6', port: 8000, group: 'realtime', note: 'WebSocket / SSE realtime server with admin UI' },
  { key: 'mongo-express', name: 'Mongo Express', image: 'mongo-express:1', port: 8081, group: 'client', note: 'Web client for MongoDB' },
  { key: 'pgadmin', name: 'pgAdmin', image: 'dpage/pgadmin4:latest', port: 5050, group: 'client', note: 'Web client for PostgreSQL' },
  { key: 'adminer', name: 'Adminer', image: 'adminer:4', port: 8080, group: 'client', note: 'Web client for PostgreSQL, MySQL and MariaDB' },
  { key: 'kibana', name: 'Kibana', image: 'kibana:8.17.4', port: 5601, group: 'client', note: 'Web client for Elasticsearch' },
  { key: 'redisinsight', name: 'Redis Insight', image: 'redis/redisinsight:latest', port: 5540, group: 'client', note: 'Web client for Redis' },
];
const IMAGE_TAGS: Partial<Record<ServiceKey, string[]>> = {
  postgres: ['postgres:16', 'postgres:17', 'postgres:18'],
  mysql: ['mysql:8.0', 'mysql:8.4'],
  mariadb: ['mariadb:10.11', 'mariadb:11'],
  mongodb: ['mongo:7', 'mongo:8'],
  redis: ['redis:7', 'redis:8'],
  elasticsearch: ['elasticsearch:8.17.4', 'elasticsearch:8.18.0', 'elasticsearch:9.0.0'],
  rabbitmq: ['rabbitmq:3-management', 'rabbitmq:4-management'],
};
const SERVICE_DOCS: Record<ServiceKey, string> = {
  postgres: 'https://www.postgresql.org/docs/', mysql: 'https://dev.mysql.com/doc/', mariadb: 'https://mariadb.org/documentation/',
  mongodb: 'https://www.mongodb.com/docs/', redis: 'https://redis.io/docs/latest/', elasticsearch: 'https://www.elastic.co/guide/index.html',
  rabbitmq: 'https://www.rabbitmq.com/docs', 'mongo-express': 'https://github.com/mongo-express/mongo-express',
  pgadmin: 'https://www.pgadmin.org/docs/', adminer: 'https://www.adminer.org/', kibana: 'https://www.elastic.co/guide/en/kibana/current/index.html',
  redisinsight: 'https://redis.io/docs/latest/operate/redisinsight/',
  soketi: 'https://docs.soketi.app/', centrifugo: 'https://centrifugal.dev/docs/getting-started/introduction',
};
const TOOL_DOCS: Record<string, string> = {
  docker: 'https://docs.docker.com/', ollama: 'https://github.com/ollama/ollama/tree/main/docs', git: 'https://git-scm.com/doc', gh: 'https://cli.github.com/manual/',
  node: 'https://nodejs.org/docs/latest/api/', python: 'https://docs.python.org/3/', go: 'https://go.dev/doc/', rust: 'https://doc.rust-lang.org/book/',
  java: 'https://dev.java/learn/', dotnet: 'https://learn.microsoft.com/dotnet/', php: 'https://www.php.net/docs.php',
  composer: 'https://getcomposer.org/doc/', ruby: 'https://www.ruby-lang.org/en/documentation/',
};
const CLIENT_TARGET: Partial<Record<ServiceKey, ServiceKey[]>> = {
  'mongo-express': ['mongodb'], pgadmin: ['postgres'], kibana: ['elasticsearch'],
  redisinsight: ['redis'], adminer: ['postgres', 'mysql', 'mariadb'],
};
const WEB_CLIENTS: ServiceKey[] = ['mongo-express', 'pgadmin', 'adminer', 'kibana', 'redisinsight'];
const RUNTIMES = [
  { key: 'node', name: 'Node.js', versions: ['16', '18', '20', '21', '22', '23', '24'], docs: 'https://nodejs.org/docs/latest/api/' },
  { key: 'python', name: 'Python', versions: ['3.8', '3.9', '3.10', '3.11', '3.12', '3.13'], docs: 'https://docs.python.org/3/' },
  { key: 'go', name: 'Go', versions: ['1.20', '1.21', '1.22', '1.23', '1.24', '1.25'], docs: 'https://go.dev/doc/' },
  { key: 'rust', name: 'Rust', versions: ['1.79', '1.80', '1.82', '1.84', '1.85', '1.86'], docs: 'https://doc.rust-lang.org/book/' },
  { key: 'java', name: 'Java', versions: ['8', '11', '17', '21', '22', '23', '25'], docs: 'https://dev.java/learn/' },
  { key: 'dotnet', name: '.NET SDK', versions: ['6.0', '7.0', '8.0', '9.0', '10.0'], docs: 'https://learn.microsoft.com/dotnet/' },
  { key: 'php', name: 'PHP', versions: ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4'], docs: 'https://www.php.net/docs.php' },
  { key: 'ruby', name: 'Ruby', versions: ['3.0', '3.1', '3.2', '3.3', '3.4'], docs: 'https://www.ruby-lang.org/en/documentation/' },
];
type RuntimeMap = Record<string, string>;

// Curated PHP extensions (enabled in php.ini) and Laravel composer packages.
const PHP_EXTENSIONS = ['gd', 'zip', 'bcmath', 'exif', 'intl', 'mbstring', 'dom', 'pdo_mysql', 'pdo_pgsql', 'redis', 'pcntl', 'imagick', 'opcache', 'soap'];
interface PackageDef { id: string; name: string; composer: string; ext: string[]; note: string }
const LARAVEL_PACKAGES: PackageDef[] = [
  { id: 'dompdf', name: 'PDF (dompdf)', composer: 'barryvdh/laravel-dompdf', ext: ['dom', 'mbstring'], note: 'svc.pkg.dompdf' },
  { id: 'excel', name: 'Excel', composer: 'maatwebsite/excel', ext: ['zip', 'gd'], note: 'svc.pkg.excel' },
  { id: 'image', name: 'Изображения', composer: 'intervention/image', ext: ['gd', 'exif'], note: 'svc.pkg.image' },
  { id: 'sanctum', name: 'Sanctum', composer: 'laravel/sanctum', ext: [], note: 'svc.pkg.sanctum' },
  { id: 'horizon', name: 'Horizon', composer: 'laravel/horizon', ext: ['redis', 'pcntl'], note: 'svc.pkg.horizon' },
  { id: 'telescope', name: 'Telescope', composer: 'laravel/telescope', ext: [], note: 'svc.pkg.telescope' },
  { id: 'permission', name: 'Roles & Permissions', composer: 'spatie/laravel-permission', ext: [], note: 'svc.pkg.permission' },
  { id: 'debugbar', name: 'Debugbar', composer: 'barryvdh/laravel-debugbar', ext: [], note: 'svc.pkg.debugbar' },
  { id: 'sluggable', name: 'Sluggable', composer: 'spatie/laravel-sluggable', ext: [], note: 'svc.pkg.sluggable' },
  { id: 'backup', name: 'Backup', composer: 'spatie/laravel-backup', ext: ['zip'], note: 'svc.pkg.backup' },
];

const phpIniDefaults: Record<string, string> = {
  'memory_limit': '512M', 'upload_max_filesize': '64M', 'post_max_size': '64M',
  'max_execution_time': '120', 'display_errors': 'On', 'error_reporting': 'E_ALL',
};
const runtimeEnvDefaults: Record<string, string> = {
  NODE_ENV: 'development', PYTHONUNBUFFERED: '1', GOPROXY: 'https://proxy.golang.org,direct',
  CARGO_NET_GIT_FETCH_WITH_CLI: 'true', JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
};

// --- service instances (multiple per type, auto-assigned ports) -------------

interface PortMap { host: number; container: number; label?: string }
interface Instance {
  id: string;
  key: ServiceKey;
  name: string;      // compose service name (unique)
  image: string;
  ports: PortMap[];  // ports[0] is primary
  env: Record<string, string>;
}

function randomPassword(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function defaultEnvironment(key: ServiceKey): Record<string, string> {
  const password = randomPassword();
  if (key === 'postgres') return { POSTGRES_USER: 'dev', POSTGRES_PASSWORD: password, POSTGRES_DB: 'app' };
  if (key === 'mysql') return { MYSQL_ROOT_PASSWORD: randomPassword(), MYSQL_DATABASE: 'app', MYSQL_USER: 'dev', MYSQL_PASSWORD: password };
  if (key === 'mariadb') return { MARIADB_ROOT_PASSWORD: randomPassword(), MARIADB_DATABASE: 'app', MARIADB_USER: 'dev', MARIADB_PASSWORD: password };
  if (key === 'mongodb') return { MONGO_INITDB_ROOT_USERNAME: 'dev', MONGO_INITDB_ROOT_PASSWORD: password };
  if (key === 'redis') return { REDIS_PASSWORD: password };
  if (key === 'elasticsearch') return { 'discovery.type': 'single-node', 'xpack.security.enabled': 'false', ES_JAVA_OPTS: '-Xms1g -Xmx1g' };
  if (key === 'rabbitmq') return { RABBITMQ_DEFAULT_USER: 'dev', RABBITMQ_DEFAULT_PASS: password };
  if (key === 'soketi') return { SOKETI_DEFAULT_APP_ID: 'app-id', SOKETI_DEFAULT_APP_KEY: 'app-key', SOKETI_DEFAULT_APP_SECRET: password };
  if (key === 'centrifugo') {
    return {
      CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY: password, CENTRIFUGO_HTTP_API_KEY: randomPassword(),
      CENTRIFUGO_ADMIN_ENABLED: 'true', CENTRIFUGO_ADMIN_PASSWORD: randomPassword(), CENTRIFUGO_ADMIN_SECRET: randomPassword(),
      CENTRIFUGO_CLIENT_ALLOWED_ORIGINS: '*', CENTRIFUGO_CLIENT_INSECURE: 'true',
    };
  }
  if (key === 'pgadmin') return { PGADMIN_DEFAULT_EMAIL: 'dev@example.com', PGADMIN_DEFAULT_PASSWORD: randomPassword() };
  return {};
}

/** Fix settings saved by earlier versions that make the container fail (Elasticsearch security switch, pgAdmin e-mail). */
function migrateInstance(inst: Instance): Instance {
  const env = { ...inst.env };
  if ('XPACK_SECURITY_ENABLED' in env) {
    env['xpack.security.enabled'] = env.XPACK_SECURITY_ENABLED;
    delete env.XPACK_SECURITY_ENABLED;
  }
  if (env.PGADMIN_DEFAULT_EMAIL?.endsWith('.local')) env.PGADMIN_DEFAULT_EMAIL = env.PGADMIN_DEFAULT_EMAIL.replace(/\.local$/, '.com');
  return { ...inst, env };
}

/** Container ports (and their default host base) for a service type. */
function portPlan(key: ServiceKey): { base: number; container: number; label?: string }[] {
  const item = CATALOG.find((e) => e.key === key)!;
  const container = key === 'mariadb' ? 3306 : item.port;
  const plan: { base: number; container: number; label?: string }[] = [{ base: item.port, container }];
  if (key === 'rabbitmq') plan.push({ base: 15672, container: 15672, label: 'management' });
  if (key === 'soketi') plan.push({ base: 9601, container: 9601, label: 'metrics' });
  return plan;
}
const STATEFUL_VOLUME: Partial<Record<ServiceKey, string>> = {
  postgres: '/var/lib/postgresql/data', mysql: '/var/lib/mysql', mariadb: '/var/lib/mysql',
  mongodb: '/data/db', redis: '/data', elasticsearch: '/usr/share/elasticsearch/data', redisinsight: '/data',
};

function nextFreePort(base: number, used: Set<number>): number {
  let p = base;
  while (used.has(p) || p > 65535) { p++; if (p > 65535) p = 1024; }
  return p;
}
function uniqueName(key: ServiceKey, instances: Instance[]): string {
  const names = new Set(instances.map((i) => i.name));
  if (!names.has(key)) return key;
  let n = 2;
  while (names.has(`${key}-${n}`)) n++;
  return `${key}-${n}`;
}
function makeInstance(key: ServiceKey, instances: Instance[]): Instance {
  const used = new Set(instances.flatMap((i) => i.ports.map((p) => p.host)));
  const ports = portPlan(key).map(({ base, container, label }) => {
    const host = nextFreePort(base, used);
    used.add(host);
    return { host, container, label };
  });
  return {
    id: `${key}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    key,
    name: uniqueName(key, instances),
    image: CATALOG.find((e) => e.key === key)!.image,
    ports,
    env: defaultEnvironment(key),
  };
}
const volName = (name: string) => `${name.replace(/[^A-Za-z0-9_]/g, '_')}_data`;

const imageRepo = (image: string) => image.split('@')[0].split(':')[0].split('/').pop() ?? '';
const unquote = (v: string) => {
  const t = v.trim();
  if (t.startsWith('"')) { try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); } }
  return t.replace(/^'(.*)'$/, '$1');
};

/**
 * Services of an existing otto.compose.yaml (written by an agent, another Otto window or by hand), so the
 * list matches what Docker runs. Images that are not in the catalog are left out.
 */
export function instancesFromCompose(yaml: string): Instance[] {
  const out: Instance[] = [];
  let cur: Instance | null = null;
  let section = '';
  let inServices = false;
  for (const raw of yaml.split(/\r?\n/)) {
    if (/^\S/.test(raw)) { inServices = /^services:\s*$/.test(raw); cur = null; continue; }
    if (!inServices || !raw.trim() || raw.trim().startsWith('#')) continue;
    let m = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(raw);
    if (m) {
      cur = { id: '', key: 'postgres', name: m[1], image: '', ports: [], env: {} };
      out.push(cur);
      section = '';
      continue;
    }
    if (!cur) continue;
    m = /^ {4}([A-Za-z_]+):\s*(.*)$/.exec(raw);
    if (m) {
      section = m[1];
      if (section === 'image') cur.image = unquote(m[2]);
      continue;
    }
    if (section === 'ports') {
      m = /^\s+-\s*["']?(?:[\d.]+:)?(\d+):(\d+)/.exec(raw);
      if (m) cur.ports.push({ host: Number(m[1]), container: Number(m[2]) });
    } else if (section === 'environment') {
      m = /^\s+(?:-\s*)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*(.*)$/.exec(raw);
      if (m) cur.env[m[1]] = unquote(m[2]);
    }
  }
  const result: Instance[] = [];
  for (const item of out) {
    const def = CATALOG.find((c) => imageRepo(c.image) === imageRepo(item.image));
    if (!def) continue;
    const base = makeInstance(def.key, result);
    const plan = portPlan(def.key);
    result.push({
      ...base,
      name: item.name,
      image: item.image,
      ports: item.ports.length ? item.ports.map((p, i) => ({ ...p, label: plan[i]?.label })) : base.ports,
      env: Object.keys(item.env).length ? item.env : base.env,
    });
  }
  return result;
}

function composeYaml(instances: Instance[]): string {
  const lines = ['services:'];
  const volumes: string[] = [];
  for (const inst of instances) {
    const { key, name } = inst;
    lines.push(`  ${name}:`, `    image: ${inst.image}`, '    restart: unless-stopped', '    ports:');
    for (const p of inst.ports) lines.push(`      - "127.0.0.1:${p.host}:${p.container}"`);

    const env: Record<string, string> = { ...inst.env };
    // Client services: link to the first matching database instance.
    if (CLIENT_TARGET[key]) {
      const target = instances.find((i) => CLIENT_TARGET[key]!.includes(i.key));
      if (target) {
        lines.push('    depends_on:', `      - ${target.name}`);
        if (key === 'mongo-express') {
          env.ME_CONFIG_MONGODB_URL = `mongodb://${encodeURIComponent(target.env.MONGO_INITDB_ROOT_USERNAME || 'dev')}:${encodeURIComponent(target.env.MONGO_INITDB_ROOT_PASSWORD || '')}@${target.name}:27017/?authSource=admin`;
          env.ME_CONFIG_BASICAUTH = 'false';
        }
        if (key === 'kibana') env.ELASTICSEARCH_HOSTS = `http://${target.name}:9200`;
        if (key === 'adminer') env.ADMINER_DEFAULT_SERVER = target.name;
      }
    }
    let vol = STATEFUL_VOLUME[key];
    // PostgreSQL 18+ keeps its data in a versioned subfolder: the volume must sit one level up
    if (key === 'postgres' && Number(/^postgres:(\d+)/.exec(inst.image)?.[1] ?? 0) >= 18) vol = '/var/lib/postgresql';
    if (vol) lines.push('    volumes:', `      - ${volName(name)}:${vol}`);
    if (key === 'postgres') lines.push('    healthcheck:', '      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]', '      interval: 5s', '      timeout: 3s', '      retries: 20');
    if (key === 'redis') lines.push('    command:', '      - sh', '      - -c', '      - exec redis-server --appendonly yes --requirepass "$$REDIS_PASSWORD"');
    if (vol) volumes.push(volName(name));

    const visibleEnv = Object.entries(env).filter(([n]) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(n));
    if (visibleEnv.length) lines.push('    environment:', ...visibleEnv.map(([n, v]) => `      ${n}: ${JSON.stringify(v)}`));
  }
  if (volumes.length) lines.push('volumes:', ...volumes.map((v) => `  ${v}:`));
  return `${lines.join('\n')}\n`;
}

function devcontainerJson(runtimes: RuntimeMap, runtimeEnv: Record<string, string>, composerPackages: string[] = []): string {
  const features: Record<string, { version: string }> = {};
  if (runtimes.node) features['ghcr.io/devcontainers/features/node:1'] = { version: runtimes.node };
  if (runtimes.python) features['ghcr.io/devcontainers/features/python:1'] = { version: runtimes.python };
  if (runtimes.go) features['ghcr.io/devcontainers/features/go:1'] = { version: runtimes.go };
  if (runtimes.rust) features['ghcr.io/devcontainers/features/rust:1'] = { version: runtimes.rust };
  if (runtimes.java) features['ghcr.io/devcontainers/features/java:1'] = { version: runtimes.java };
  if (runtimes.dotnet) features['ghcr.io/devcontainers/features/dotnet:2'] = { version: runtimes.dotnet };
  if (runtimes.php) features['ghcr.io/devcontainers/features/php:1'] = { version: runtimes.php };
  if (runtimes.ruby) features['ghcr.io/devcontainers/features/ruby:1'] = { version: runtimes.ruby };
  const safeEnv = Object.fromEntries(Object.entries(runtimeEnv).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)));
  const config: Record<string, unknown> = { name: 'Otto development environment', image: 'mcr.microsoft.com/devcontainers/base:ubuntu', features, containerEnv: safeEnv };
  // The devcontainers PHP feature lives under /usr/local/php, not /etc/php: ask PHP where it scans for extra .ini files.
  // A failure here must not break the container start.
  if (runtimes.php) {
    config.postStartCommand = 'd=$(php -r \'echo PHP_CONFIG_FILE_SCAN_DIR;\' 2>/dev/null); [ -n "$d" ] || d=/usr/local/php/current/ini/conf.d; '
      + 'sudo mkdir -p "$d" && sudo install -m 0644 .devcontainer/php.ini "$d/99-otto.ini" || echo "otto: php.ini was not installed"';
  }
  if (runtimes.php && composerPackages.length) {
    // Install curated composer packages after the container is created.
    config.postCreateCommand = `composer require ${composerPackages.join(' ')}`;
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

function phpIniText(values: Record<string, string>, extensions: string[] = []): string {
  const settings = Object.entries(values)
    .filter(([name]) => /^[A-Za-z][A-Za-z0-9_.-]*$/.test(name))
    .map(([name, value]) => `${name} = ${value.replace(/[\r\n]/g, '')}`).join('\n');
  const exts = extensions
    .filter((e) => /^[A-Za-z0-9_]+$/.test(e))
    .map((e) => `extension=${e}`).join('\n');
  return `; Generated by zeithub.otto — PHP runtime settings\n${settings}${exts ? `\n\n; extensions\n${exts}` : ''}\n`;
}

async function putProjectFile(projectId: number, path: string, content: string) {
  try { await createProjectFile(projectId, path); } catch (error) {
    if (!(error instanceof Error) || !/already exists/i.test(error.message)) throw error;
  }
  await saveFileContent(projectId, path, content);
}
const storageKey = (id: number) => `otto-services:${id}`;

export function ServicesView({ project }: { project: Project | null }) {
  const { t: tr } = useT();
  const [instances, setInstances] = useState<Instance[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeMap>({});
  const [runtimeEnv, setRuntimeEnv] = useState<Record<string, string>>(runtimeEnvDefaults);
  const [phpIni, setPhpIni] = useState<Record<string, string>>(phpIniDefaults);
  const [phpExtensions, setPhpExtensions] = useState<Record<string, boolean>>({});
  const [laravelPackages, setLaravelPackages] = useState<Record<string, boolean>>({});
  const [loadedProjectId, setLoadedProjectId] = useState<number | null>(null);
  const [docker, setDocker] = useState<{ available: boolean; running?: boolean; output?: string; detail?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'services' | 'runtimes' | 'tools'>('services');
  const [envTools, setEnvTools] = useState<ToolStatus[]>([]);
  const [envLoading, setEnvLoading] = useState(false);
  const [toolInstalls, setToolInstalls] = useState<Record<string, { log: string[]; running: boolean; action?: 'install' | 'reinstall' | 'uninstall' }>>({});
  const confirm = useConfirm();
  const [toolVariant, setToolVariant] = useState<Record<string, string>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showYaml, setShowYaml] = useState(false);
  const [showDev, setShowDev] = useState(false);
  const [showEnv, setShowEnv] = useState(false);
  const [langPickerOpen, setLangPickerOpen] = useState(false);
  const [expandedLang, setExpandedLang] = useState<Set<string>>(new Set());
  const [svcBusy, setSvcBusy] = useState<Record<string, string>>({});
  const [svcLogs, setSvcLogs] = useState<Record<string, string>>({});
  const [logFor, setLogFor] = useState<string | null>(null);
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string>('');
  const selectedPackages = LARAVEL_PACKAGES.filter((p) => laravelPackages[p.id]);
  const composerList = selectedPackages.map((p) => p.composer);
  const effectiveExtensions = Array.from(new Set([
    ...PHP_EXTENSIONS.filter((e) => phpExtensions[e]),
    ...selectedPackages.flatMap((p) => p.ext),
  ]));
  const yaml = useMemo(() => composeYaml(instances), [instances]);
  const runtimeConfig = useMemo(() => devcontainerJson(runtimes, runtimeEnv, composerList), [runtimes, runtimeEnv, composerList.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasInvalidEnv = instances.some((inst) => Object.keys(inst.env).some((name) => !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)));

  useEffect(() => {
    setLoadedProjectId(null); setInstances([]); setRuntimes({}); setRuntimeEnv(runtimeEnvDefaults); setPhpIni(phpIniDefaults); setPhpExtensions({}); setLaravelPackages({}); setDocker(null); setNotice(''); setError('');
    if (!project) return;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(project.id)) || '{}');
      if (Array.isArray(saved.instances)) {
        setInstances(saved.instances.filter((i: Instance) => i && CATALOG.some((c) => c.key === i.key)).map(migrateInstance));
      } else if (Array.isArray(saved.services)) {
        // Migrate the old single-instance-per-type format.
        let migrated: Instance[] = [];
        for (const key of saved.services as ServiceKey[]) {
          if (!CATALOG.some((c) => c.key === key)) continue;
          const inst = makeInstance(key, migrated);
          if (saved.environments?.[key]) inst.env = saved.environments[key];
          if (saved.versions?.[key]) inst.image = saved.versions[key];
          migrated = [...migrated, inst];
        }
        setInstances(migrated);
      }
      setRuntimes(saved.runtimes && typeof saved.runtimes === 'object' ? saved.runtimes : {});
      setRuntimeEnv(saved.runtimeEnv && typeof saved.runtimeEnv === 'object' ? saved.runtimeEnv : runtimeEnvDefaults);
      setPhpIni(saved.phpIni && typeof saved.phpIni === 'object' ? saved.phpIni : phpIniDefaults);
      setPhpExtensions(saved.phpExtensions && typeof saved.phpExtensions === 'object' ? saved.phpExtensions : {});
      setLaravelPackages(saved.laravelPackages && typeof saved.laravelPackages === 'object' ? saved.laravelPackages : {});
    } catch { /* ignore stale local settings */ }
    setLoadedProjectId(project.id);
  }, [project?.id]);

  // the compose file on disk wins over this browser's copy: an agent or another Otto window may have changed it
  const composeChecked = useRef<number | null>(null);
  useEffect(() => {
    if (!project || loadedProjectId !== project.id || composeChecked.current === project.id) return;
    composeChecked.current = project.id;
    const id = project.id;
    void fetchFileContent(id, 'otto.compose.yaml').then((text) => {
      if (composeChecked.current !== id || !text) return;
      const fromFile = instancesFromCompose(text);
      if (!fromFile.length) return;
      setInstances((current) => {
        const sig = (list: Instance[]) => list.map((i) => `${i.name}|${i.image}|${i.ports.map((p) => `${p.host}:${p.container}`).join(',')}|${JSON.stringify(i.env)}`).sort().join(';');
        return sig(current) === sig(fromFile) ? current : fromFile;
      });
    }).catch(() => undefined);
  }, [project?.id, loadedProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // badges in the sidebar follow every start / stop / status made here
  useEffect(() => { if (docker) announceServicesChanged(); }, [docker]);

  useEffect(() => {
    if (!project || loadedProjectId !== project.id) return;
    localStorage.setItem(storageKey(project.id), JSON.stringify({ instances, runtimes, runtimeEnv, phpIni, phpExtensions, laravelPackages }));
  }, [project?.id, loadedProjectId, instances, runtimes, runtimeEnv, phpIni, phpExtensions, laravelPackages]);

  // --- .env follows the services: a change of a port / password / service updates the project's .env ---
  const [envAuto, setEnvAuto] = useState(true);
  const [envNote, setEnvNote] = useState('');
  const lastEnvSig = useRef<string | null>(null);
  useEffect(() => {
    try { setEnvAuto(localStorage.getItem('otto-env-autosync') !== '0'); } catch { /* default on */ }
  }, []);
  const servicesSig = useMemo(() => JSON.stringify(instances.map((i) => [i.key, i.ports.map((p) => [p.host, p.label ?? '']), i.env])), [instances]);

  const syncEnv = async (create: 'always' | 'example', manual: boolean) => {
    if (!project) return;
    try {
      const result = await syncProjectEnv(project.id, instances, create);
      if (result.changed.length) {
        const keys = result.changed.map((c) => c.key);
        setEnvNote(tr(result.created ? 'svc.envCreated' : 'svc.envSynced', { keys: keys.slice(0, 6).join(', ') + (keys.length > 6 ? ` +${keys.length - 6}` : '') }));
        window.dispatchEvent(new CustomEvent('otto:files-changed', { detail: { projectId: project.id } }));
      } else if (manual) {
        setEnvNote(tr('svc.envUpToDate'));
      }
    } catch (exc) {
      if (manual) setError(exc instanceof Error ? exc.message : String(exc));
    }
  };

  useEffect(() => { lastEnvSig.current = null; setEnvNote(''); }, [project?.id]);
  useEffect(() => {
    if (!project || loadedProjectId !== project.id || !envAuto || instances.length === 0) return;
    if (lastEnvSig.current === null) { lastEnvSig.current = servicesSig; return; } // the state as loaded is not a change
    if (lastEnvSig.current === servicesSig) return;
    lastEnvSig.current = servicesSig;
    const timer = setTimeout(() => void syncEnv('example', false), 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servicesSig, envAuto, loadedProjectId, project?.id]);

  // Load environment/tool status for the "Инструменты" tab and gating.
  useEffect(() => {
    if (!project) return;
    void refreshEnv();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Live logs for the open service: refresh every 3s while its log panel is open.
  useEffect(() => {
    if (!logFor || !project) return;
    if (starting[logFor]) return; // don't fight the live start stream
    const inst = instances.find((i) => i.id === logFor);
    if (!inst) return;
    let stopped = false;
    const pull = async () => {
      try {
        const r = await dockerServiceAction(project.id, inst.name, 'service-logs');
        if (!stopped) setSvcLogs((prev) => ({ ...prev, [inst.id]: r.output || tr('svc.emptyOut') }));
      } catch { /* container may be down — keep last output */ }
    };
    void pull();
    const timer = window.setInterval(pull, 3000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [logFor, project, instances, starting, tr]);

  const dockerAction = async (action: 'status' | 'validate' | 'up' | 'down' | 'runtime-up' | 'runtime-down') => {
    if (!project || busy) return;
    if ((action === 'up' || action === 'validate') && hasInvalidEnv) { setError(tr('svc.envName')); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      if (action === 'up' || action === 'validate') await putProjectFile(project.id, 'otto.compose.yaml', yaml);
      if (action === 'runtime-up') {
        try { await createProjectFolder(project.id, '.devcontainer'); } catch (error) {
          if (!(error instanceof Error) || !/already exists/i.test(error.message)) throw error;
        }
        await putProjectFile(project.id, '.devcontainer/devcontainer.json', runtimeConfig);
        if (runtimes.php) await putProjectFile(project.id, '.devcontainer/php.ini', phpIniText(phpIni, effectiveExtensions));
      }
      const result = await dockerProjectAction(project.id, action);
      setDocker(result);
      if (action === 'up' && envAuto) void syncEnv('example', false); // starting the services: make sure .env points at them
      setNotice(action === 'up' ? tr('svc.up') : action === 'down' ? tr('svc.down') : action === 'validate' ? tr('svc.validated') : action === 'runtime-up' ? tr('svc.runtimeUp') : action === 'runtime-down' ? tr('svc.runtimeDown') : tr('svc.statusUpdated'));
    } catch (exc) { setError(exc instanceof Error ? exc.message : tr('svc.dockerFail')); }
    finally { setBusy(false); }
  };

  const startDockerEngine = async () => {
    if (!project || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await dockerProjectAction(project.id, 'start-engine');
      setDocker(result);
      setNotice(result.detail || tr('svc.dockerStarting'));
    } catch (exc) { setError(exc instanceof Error ? exc.message : tr('svc.dockerFail')); }
    finally { setBusy(false); }
  };

  const saveConfig = async () => {
    if (!project) return;
    if (hasInvalidEnv) { setError(tr('svc.envName')); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      if (instances.length) await putProjectFile(project.id, 'otto.compose.yaml', yaml);
      if (Object.keys(runtimes).length) {
        try { await createProjectFolder(project.id, '.devcontainer'); } catch (error) {
          if (!(error instanceof Error) || !/already exists/i.test(error.message)) throw error;
        }
        await putProjectFile(project.id, '.devcontainer/devcontainer.json', runtimeConfig);
      }
      if (runtimes.php) await putProjectFile(project.id, '.devcontainer/php.ini', phpIniText(phpIni, effectiveExtensions));
      setNotice(tr('svc.saved'));
    } catch (exc) { setError(exc instanceof Error ? exc.message : tr('svc.saveFail')); }
    finally { setBusy(false); }
  };

  const add = (key: ServiceKey) => {
    setInstances((prev) => {
      const inst = makeInstance(key, prev);
      setExpanded((e) => new Set(e).add(inst.id));
      return [...prev, inst];
    });
    setPickerOpen(false);
  };
  const remove = (id: string) => setInstances((prev) => prev.filter((i) => i.id !== id));
  const toggleExpand = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const patch = (id: string, changes: Partial<Instance>) => setInstances((prev) => prev.map((i) => (i.id === id ? { ...i, ...changes } : i)));
  const setEnvValue = (id: string, oldName: string, name: string, value: string) => setInstances((prev) => prev.map((i) => {
    if (i.id !== id) return i;
    const env = { ...i.env };
    if (oldName !== name) delete env[oldName];
    if (name.trim()) env[name.trim()] = value;
    return { ...i, env };
  }));
  const rename = (id: string, raw: string) => {
    const name = raw.trim().replace(/[^A-Za-z0-9_-]/g, '-');
    if (!name) return;
    setInstances((prev) => prev.some((i) => i.id !== id && i.name === name)
      ? prev // keep unique
      : prev.map((i) => (i.id === id ? { ...i, name } : i)));
  };

  const copy = (id: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? '' : c)), 1200);
    }).catch(() => { /* clipboard unavailable */ });
  };
  // Streamed start: bring the service up in the background with live progress.
  const startService = async (inst: Instance) => {
    if (!project || starting[inst.id]) return;
    setError(''); setNotice('');
    setStarting((p) => ({ ...p, [inst.id]: true }));
    setSvcLogs((p) => ({ ...p, [inst.id]: '' }));
    setLogFor(inst.id); // open the log panel to show progress
    try {
      await putProjectFile(project.id, 'otto.compose.yaml', yaml);
      const code = await startServiceStream(project.id, inst.name, (line) => {
        setSvcLogs((prev) => ({ ...prev, [inst.id]: `${prev[inst.id] ? prev[inst.id] + '\n' : ''}${line}`.split('\n').slice(-400).join('\n') }));
      });
      setNotice(code === 0 ? tr('svc.started', { name: inst.name }) : tr('svc.exitCode', { name: inst.name, code }));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : tr('svc.startFail'));
    } finally {
      setStarting((p) => { const n = { ...p }; delete n[inst.id]; return n; });
    }
  };

  const serviceAction = async (inst: Instance, action: 'service-stop' | 'service-restart') => {
    if (!project || svcBusy[inst.id]) return;
    setSvcBusy((prev) => ({ ...prev, [inst.id]: action }));
    setError(''); setNotice('');
    try {
      // Keep the compose file in sync so container names match the current config.
      await putProjectFile(project.id, 'otto.compose.yaml', yaml);
      await dockerServiceAction(project.id, inst.name, action);
      setNotice(action === 'service-stop' ? tr('svc.stopped', { name: inst.name }) : tr('svc.restarted', { name: inst.name }));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : tr('svc.actionFail'));
    } finally {
      setSvcBusy((prev) => { const n = { ...prev }; delete n[inst.id]; return n; });
    }
  };

  const refreshEnv = async () => {
    setEnvLoading(true);
    try { setEnvTools(await fetchEnvStatus()); } catch { /* ignore */ } finally { setEnvLoading(false); }
  };
  const installEnvTool = async (id: string, wingetId?: string, action: 'install' | 'reinstall' | 'uninstall' = 'install') => {
    if (action !== 'install') {
      const name = envTools.find((x) => x.id === id)?.name ?? id;
      const ok = await confirm({
        title: tr(action === 'uninstall' ? 'svc.uninstallTitle' : 'svc.reinstallTitle'),
        message: tr(action === 'uninstall' ? 'svc.uninstallMsg' : 'svc.reinstallMsg', { name }),
        danger: action === 'uninstall',
        confirmText: tr(action === 'uninstall' ? 'svc.uninstall' : 'svc.reinstall'),
      });
      if (!ok) return;
    }
    setToolInstalls((p) => ({ ...p, [id]: { log: [], running: true, action } }));
    try {
      await installTool(id, (line) => setToolInstalls((p) => p[id] ? { ...p, [id]: { ...p[id], log: [...p[id].log.slice(-150), line] } } : p), undefined, wingetId, action);
    } catch (e) {
      setToolInstalls((p) => p[id] ? { ...p, [id]: { ...p[id], log: [...p[id].log, e instanceof Error ? e.message : tr('svc.errWord')] } } : p);
    }
    setToolInstalls((p) => p[id] ? { ...p, [id]: { ...p[id], running: false } } : p);
    await refreshEnv();
  };

  const addLang = (key: string) => {
    const rt = RUNTIMES.find((r) => r.key === key);
    if (!rt) return;
    setRuntimes((prev) => ({ ...prev, [key]: rt.versions[rt.versions.length - 1] }));
    setExpandedLang((e) => new Set(e).add(key));
    setLangPickerOpen(false);
  };
  const removeLang = (key: string) => setRuntimes((prev) => { const n = { ...prev }; delete n[key]; return n; });
  const toggleLang = (key: string) => setExpandedLang((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  if (!project) return <div className="flex-1 grid place-items-center text-[var(--text-muted)]">{tr('svc.pickProject')}</div>;

  return <section className="flex-1 min-h-0 overflow-y-auto">
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold flex items-center gap-2"><Boxes size={18} className="text-[var(--accent)]"/>{tr('services.title')}</h1>
          <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{project.name} · {tr('svc.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void startDockerEngine()} disabled={busy} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--border-color)] text-sm hover:bg-[var(--bg-hover)] disabled:opacity-50"><Play size={13}/>{tr('svc.startDocker')}</button>
          <button onClick={() => void dockerAction('status')} disabled={busy} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--border-color)] text-sm hover:bg-[var(--bg-hover)] disabled:opacity-50"><RefreshCw size={14} className={busy ? 'animate-spin' : ''}/>{docker?.available ? (docker.running ? tr('svc.dockerRunning') : tr('svc.dockerReady')) : docker ? tr('svc.dockerDown') : tr('svc.dockerCheck')}</button>
        </div>
      </header>

      <nav className="flex gap-2 border-b border-[var(--border-color)]">
        <button onClick={() => setTab('services')} className={`px-3 py-2 text-sm border-b-2 ${tab === 'services' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-secondary)]'}`}><Database size={14} className="inline mr-2"/>{tr('services.tabServices')}</button>
        <button onClick={() => setTab('runtimes')} className={`px-3 py-2 text-sm border-b-2 ${tab === 'runtimes' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-secondary)]'}`}><Container size={14} className="inline mr-2"/>{tr('services.tabRuntimes')}</button>
        <button onClick={() => setTab('tools')} className={`px-3 py-2 text-sm border-b-2 ${tab === 'tools' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-secondary)]'}`}><Wrench size={14} className="inline mr-2"/>{tr('services.tabTools')}</button>
      </nav>

      {tab === 'services' ? <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{tr('svc.projectServices')} {instances.length > 0 && <span className="text-[var(--text-muted)]">({instances.length})</span>}</h2>
          <button onClick={() => setPickerOpen(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--accent)] text-[var(--on-accent)] text-sm font-medium hover:bg-[var(--accent-hover)]"><Plus size={15}/>{tr('svc.add')}</button>
        </div>
        {instances.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-xs">
            <label className="flex items-center gap-1.5 text-[var(--text-secondary)]" title={tr('svc.envAutoHint')}>
              <input type="checkbox" checked={envAuto} onChange={(e) => { setEnvAuto(e.target.checked); try { localStorage.setItem('otto-env-autosync', e.target.checked ? '1' : '0'); } catch { /* ignore */ } }} />
              {tr('svc.envAuto')}
            </label>
            <button onClick={() => void syncEnv('always', true)} className="rounded-md border border-[var(--border-color)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]">{tr('svc.envNow')}</button>
            {envNote && <span className="text-[var(--success)]">{envNote}</span>}
          </div>
        )}

        {/* Services table */}
        <div className="rounded-xl border border-[var(--border-color)] overflow-hidden">
          <div className="grid grid-cols-[1.4fr_1fr_1.2fr_auto] gap-2 px-3 py-2 bg-[var(--bg-tertiary)] text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            <span>{tr('svc.colName')}</span><span>{tr('svc.colType')}</span><span>{tr('svc.colPorts')}</span><span>{tr('svc.colActions')}</span>
          </div>
          {!instances.length && <div className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">{tr('svc.none')}</div>}
          {instances.map((inst) => {
            const item = CATALOG.find((entry) => entry.key === inst.key)!;
            const isClient = item.group === 'client';
            const open = expanded.has(inst.id);
            return <div key={inst.id} className="border-t border-[var(--border-color)]">
              <div className="grid grid-cols-[1.4fr_1fr_1.2fr_auto] gap-2 px-3 py-2.5 items-center hover:bg-[var(--bg-hover)]/40">
                <div className="flex items-center gap-2 min-w-0">
                  <button onClick={() => toggleExpand(inst.id)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] shrink-0">{open ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}</button>
                  {isClient ? <ExternalLink size={15} className="text-[var(--accent)] shrink-0"/> : <Database size={15} className="text-[var(--accent)] shrink-0"/>}
                  <span className="truncate text-sm font-medium">{inst.name}</span>
                </div>
                <span className="text-xs text-[var(--text-muted)] truncate">{item.name}</span>
                <span className="text-xs font-mono text-[var(--text-secondary)] truncate">{inst.ports.map((p) => p.host).join(', ')}</span>
                <div className="flex items-center gap-1 justify-end">
                  <button onClick={() => toggleExpand(inst.id)} className="p-1.5 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" title={tr('svc.settings')}><Settings2 size={15}/></button>
                  <button onClick={() => remove(inst.id)} className="p-1.5 rounded-md text-[var(--text-muted)] hover:bg-[var(--error)]/10 hover:text-[var(--error)]" title={tr('common.delete')}><Trash2 size={15}/></button>
                </div>
              </div>
              {open && <div className="px-3 pb-3 pt-1 space-y-3 bg-[var(--bg-secondary)]/40">
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="text-xs text-[var(--text-muted)] space-y-1"><span>{tr('svc.serviceName')}</span>
                    <input value={inst.name} onChange={(e) => rename(inst.id, e.target.value)} className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs font-mono text-[var(--text-primary)]"/></label>
                  {IMAGE_TAGS[inst.key] && <label className="text-xs text-[var(--text-muted)] space-y-1"><span>{tr('svc.imageVersion')}</span>
                    <select value={inst.image} onChange={(e) => patch(inst.id, { image: e.target.value })} className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs">{IMAGE_TAGS[inst.key]!.map((image) => <option key={image} value={image}>{image}</option>)}</select></label>}
                </div>
                <div className="flex flex-wrap gap-3">
                  {inst.ports.map((p, idx) => <label key={idx} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                    <span>{p.label || tr('svc.port')}</span>
                    <input type="number" value={p.host} onChange={(e) => patch(inst.id, { ports: inst.ports.map((pp, i) => i === idx ? { ...pp, host: Number(e.target.value) || pp.host } : pp) })} className="w-24 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 font-mono"/>
                    <span className="opacity-60">→ {p.container}</span>
                  </label>)}
                </div>
                <div className="space-y-2"><div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{tr('svc.envVars')}</div>{Object.entries(inst.env).map(([name, value]) => <div key={`${inst.id}-${name}`} className="grid grid-cols-[minmax(100px,0.8fr)_minmax(100px,1fr)_auto] gap-2"><input value={name} onChange={(event) => setEnvValue(inst.id, name, event.target.value, value)} aria-label={tr('svc.varKey')} className={`min-w-0 rounded-md border ${/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) ? 'border-[var(--border-color)]' : 'border-[var(--error)]'} bg-[var(--bg-primary)] px-2 py-1.5 text-xs font-mono`}/><input value={value} onChange={(event) => setEnvValue(inst.id, name, name, event.target.value)} aria-label={tr('svc.valueOf', { name })} className="min-w-0 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs font-mono"/><div className="flex items-center gap-0.5"><button onClick={() => copy(`${inst.id}-${name}`, value)} className="px-1.5 py-1 text-[var(--text-muted)] hover:text-[var(--accent)]" title={tr('svc.copyValue')}>{copied === `${inst.id}-${name}` ? <Check size={13} className="text-[var(--success)]"/> : <Copy size={13}/>}</button><button onClick={() => setEnvValue(inst.id, name, '', '')} className="px-1.5 text-xs text-[var(--error)]" title={tr('svc.delVar')}>×</button></div></div>)}<button onClick={() => { let n = 1; while (inst.env[`CUSTOM_ENV_${n}`] !== undefined) n++; setEnvValue(inst.id, '', `CUSTOM_ENV_${n}`, ''); }} className="text-xs text-[var(--accent)] hover:underline">{tr('svc.addKey')}</button></div>
                {/* Connection string for this instance */}
                {(() => {
                  const port = inst.ports[0].host;
                  let url = '';
                  if (inst.key === 'postgres') url = `postgresql://${encodeURIComponent(inst.env.POSTGRES_USER || 'dev')}:${encodeURIComponent(inst.env.POSTGRES_PASSWORD || '')}@localhost:${port}/${inst.env.POSTGRES_DB || 'app'}`;
                  else if (inst.key === 'mysql') url = `mysql://${encodeURIComponent(inst.env.MYSQL_USER || 'dev')}:${encodeURIComponent(inst.env.MYSQL_PASSWORD || '')}@localhost:${port}/${inst.env.MYSQL_DATABASE || 'app'}`;
                  else if (inst.key === 'mariadb') url = `mysql://${encodeURIComponent(inst.env.MARIADB_USER || 'dev')}:${encodeURIComponent(inst.env.MARIADB_PASSWORD || '')}@localhost:${port}/${inst.env.MARIADB_DATABASE || 'app'}`;
                  else if (inst.key === 'mongodb') url = `mongodb://${encodeURIComponent(inst.env.MONGO_INITDB_ROOT_USERNAME || 'dev')}:${encodeURIComponent(inst.env.MONGO_INITDB_ROOT_PASSWORD || '')}@localhost:${port}/?authSource=admin`;
                  else if (inst.key === 'redis') url = `redis://:${encodeURIComponent(inst.env.REDIS_PASSWORD || '')}@localhost:${port}`;
                  const web = WEB_CLIENTS.includes(inst.key) ? `http://127.0.0.1:${port}` : '';
                  if (!url && !web) return null;
                  return <div className="flex items-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5">
                    {web
                      ? <a href={web} target="_blank" rel="noreferrer" className="text-xs font-mono text-[var(--accent)] hover:underline truncate">{web}</a>
                      : <span className="text-xs font-mono text-[var(--text-secondary)] truncate flex-1">{url}</span>}
                    <button onClick={() => copy(`url-${inst.id}`, web || url)} className="shrink-0 text-[var(--text-muted)] hover:text-[var(--accent)]" title={tr('svc.copy')}>{copied === `url-${inst.id}` ? <Check size={13} className="text-[var(--success)]"/> : <Copy size={13}/>}</button>
                  </div>;
                })()}

                {/* Per-service Docker actions */}
                <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-color)] pt-3">
                  <button onClick={() => void startService(inst)} disabled={!!starting[inst.id] || !!svcBusy[inst.id]} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-[var(--border-color)] hover:border-[var(--accent)]/40 disabled:opacity-40">{starting[inst.id] ? <Loader2 size={12} className="animate-spin"/> : <Play size={12}/>}{starting[inst.id] ? tr('svc.starting') : tr('svc.start')}</button>
                  <button onClick={() => void serviceAction(inst, 'service-restart')} disabled={!!svcBusy[inst.id] || !!starting[inst.id]} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-[var(--border-color)] hover:border-[var(--accent)]/40 disabled:opacity-40"><RefreshCw size={12} className={svcBusy[inst.id] === 'service-restart' ? 'animate-spin' : ''}/>{tr('svc.restart')}</button>
                  <button onClick={() => void serviceAction(inst, 'service-stop')} disabled={!!svcBusy[inst.id] || !!starting[inst.id]} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-[var(--border-color)] hover:border-[var(--error)]/40 hover:text-[var(--error)] disabled:opacity-40"><Square size={11}/>{tr('svc.stop')}</button>
                  <button onClick={() => setLogFor((f) => (f === inst.id ? null : inst.id))} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border transition-colors ${logFor === inst.id ? 'border-[var(--accent)]/40 bg-[var(--accent-glow)] text-[var(--accent)]' : 'border-[var(--border-color)] hover:border-[var(--accent)]/40'}`}><ScrollText size={12}/>{tr('svc.logs')}</button>
                  {SERVICE_DOCS[inst.key] && <a href={SERVICE_DOCS[inst.key]} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/40 transition-colors" title={tr('svc.docs')}><BookOpen size={12}/>{tr('svc.docsShort')}</a>}
                </div>
                {logFor === inst.id && <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)]">
                  <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-[var(--border-color)] text-[10px] text-[var(--text-muted)]">
                    <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] animate-pulse"/>{starting[inst.id] ? tr('svc.startLive') : tr('svc.logsAuto')}</span>
                    <button onClick={() => setLogFor(null)} className="hover:text-[var(--text-primary)]"><X size={12}/></button>
                  </div>
                  <pre className="max-h-56 overflow-auto p-3 text-[10px] font-mono text-[var(--text-muted)] whitespace-pre-wrap">{svcLogs[inst.id] ?? tr('svc.logsLoading')}</pre>
                </div>}
              </div>}
            </div>;
          })}
        </div>

        {/* Compose preview (collapsed by default) */}
        {instances.length > 0 && <div className="space-y-2">
          <button onClick={() => setShowYaml((v) => !v)} className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)]">{showYaml ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}otto.compose.yaml</button>
          {showYaml && <pre className="max-h-72 overflow-auto rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] p-4 text-xs text-[var(--text-secondary)]">{yaml}</pre>}
        </div>}
        <p className="text-xs text-[var(--text-muted)]">{tr('svc.portsNote')}</p>
      </div> : tab === 'runtimes' ? <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{tr('svc.langs')} {Object.keys(runtimes).length > 0 && <span className="text-[var(--text-muted)]">({Object.keys(runtimes).length})</span>}</h2>
          <button onClick={() => setLangPickerOpen(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--accent)] text-[var(--on-accent)] text-sm font-medium hover:bg-[var(--accent-hover)]"><Plus size={15}/>{tr('svc.addLang')}</button>
        </div>
        <p className="text-xs text-[var(--text-muted)]">{tr('svc.devA')}<code>.devcontainer/devcontainer.json</code>{tr('svc.devB')}</p>

        {/* Languages table */}
        <div className="rounded-xl border border-[var(--border-color)] overflow-hidden">
          <div className="grid grid-cols-[1.4fr_1fr_auto] gap-2 px-3 py-2 bg-[var(--bg-tertiary)] text-[10px] uppercase tracking-wider text-[var(--text-muted)]"><span>{tr('svc.colLang')}</span><span>{tr('svc.colVersion')}</span><span>{tr('svc.colActions')}</span></div>
          {Object.keys(runtimes).length === 0 && <div className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">{tr('svc.noLangs')}</div>}
          {RUNTIMES.filter((rt) => runtimes[rt.key] !== undefined).map((rt) => {
            const open = expandedLang.has(rt.key);
            return <div key={rt.key} className="border-t border-[var(--border-color)]">
              <div className="grid grid-cols-[1.4fr_1fr_auto] gap-2 px-3 py-2.5 items-center hover:bg-[var(--bg-hover)]/40">
                <div className="flex items-center gap-2 min-w-0">
                  <button onClick={() => toggleLang(rt.key)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] shrink-0">{open ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}</button>
                  <Container size={15} className="text-[var(--accent)] shrink-0"/>
                  <span className="truncate text-sm font-medium">{rt.name}</span>
                </div>
                <span className="text-xs font-mono text-[var(--text-secondary)]">{runtimes[rt.key]}</span>
                <div className="flex items-center gap-1 justify-end">
                  <button onClick={() => toggleLang(rt.key)} className="p-1.5 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" title={tr('svc.settings')}><Settings2 size={15}/></button>
                  <button onClick={() => removeLang(rt.key)} className="p-1.5 rounded-md text-[var(--text-muted)] hover:bg-[var(--error)]/10 hover:text-[var(--error)]" title={tr('common.delete')}><Trash2 size={15}/></button>
                </div>
              </div>
              {open && <div className="px-3 pb-3 pt-1 space-y-3 bg-[var(--bg-secondary)]/40">
                <div className="flex items-end gap-2 flex-wrap">
                  <label className="block max-w-xs flex-1 text-xs text-[var(--text-muted)] space-y-1"><span>{tr('svc.colVersion')}</span>
                    <select value={runtimes[rt.key]} onChange={(e) => setRuntimes((prev) => ({ ...prev, [rt.key]: e.target.value }))} className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs">{rt.versions.map((v) => <option key={v} value={v}>{v}</option>)}</select>
                  </label>
                  {rt.docs && <a href={rt.docs} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/40 transition-colors" title={tr('svc.docs')}><BookOpen size={13}/>{tr('svc.docsShort')}</a>}
                </div>
                {rt.key === 'php' && <>
                  <div className="space-y-2"><div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">php.ini</div>{Object.entries(phpIni).map(([name, value]) => <label key={name} className="grid grid-cols-[1fr_1fr] items-center gap-3 text-sm"><code className="text-xs">{name}</code><input value={value} onChange={(event) => setPhpIni((prev) => ({ ...prev, [name]: event.target.value.replace(/[\r\n]/g, '') }))} className="rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs font-mono"/></label>)}</div>

                  {/* Laravel package presets → composer require + auto-enable extensions */}
                  <div className="space-y-2">
                    <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{tr('svc.laravelPkgs')}</div>
                    <div className="grid sm:grid-cols-2 gap-1.5">
                      {LARAVEL_PACKAGES.map((pkg) => {
                        const on = !!laravelPackages[pkg.id];
                        return <label key={pkg.id} className={`flex items-start gap-2 rounded-md border p-2 cursor-pointer transition-colors ${on ? 'border-[var(--accent)]/50 bg-[var(--accent-glow)]' : 'border-[var(--border-color)] hover:border-[var(--accent)]/30'}`}>
                          <input type="checkbox" checked={on} onChange={(e) => setLaravelPackages((prev) => ({ ...prev, [pkg.id]: e.target.checked }))} className="mt-0.5 accent-[var(--accent)]"/>
                          <span className="min-w-0">
                            <span className="text-xs text-[var(--text-primary)] block">{pkg.id === 'image' ? tr('svc.pkg.imageName') : pkg.name}</span>
                            <span className="text-[10px] text-[var(--text-muted)] block truncate">{tr(pkg.note)} · {pkg.composer}</span>
                            {pkg.ext.length > 0 && <span className="text-[9px] text-[var(--accent)]">ext: {pkg.ext.join(', ')}</span>}
                          </span>
                        </label>;
                      })}
                    </div>
                    {composerList.length > 0 && <div className="text-[10px] font-mono text-[var(--text-muted)] rounded bg-[var(--bg-primary)] border border-[var(--border-color)] px-2 py-1.5 break-all">composer require {composerList.join(' ')}</div>}
                  </div>

                  {/* PHP extensions → extension=... in php.ini */}
                  <div className="space-y-2">
                    <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{tr('svc.phpExt')}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {PHP_EXTENSIONS.map((ext) => {
                        const auto = selectedPackages.some((p) => p.ext.includes(ext));
                        const on = auto || !!phpExtensions[ext];
                        return <button key={ext} onClick={() => !auto && setPhpExtensions((prev) => ({ ...prev, [ext]: !prev[ext] }))} disabled={auto} title={auto ? tr('svc.byPackage') : ''} className={`px-2 py-1 rounded-md text-[11px] font-mono border transition-colors ${on ? 'border-[var(--accent)]/50 bg-[var(--accent-glow)] text-[var(--accent)]' : 'border-[var(--border-color)] text-[var(--text-muted)] hover:border-[var(--accent)]/30'} ${auto ? 'opacity-70 cursor-default' : ''}`}>{ext}</button>;
                      })}
                    </div>
                  </div>
                </>}
              </div>}
            </div>;
          })}
        </div>

        {/* Container-wide environment (collapsed by default) */}
        <div className="space-y-2">
          <button onClick={() => setShowEnv((v) => !v)} className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)]">{showEnv ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}{tr('svc.containerEnv')} <span className="text-[var(--text-muted)] font-normal">({Object.keys(runtimeEnv).length})</span></button>
          {showEnv && <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 space-y-3"><p className="text-xs text-[var(--text-muted)]">{tr('svc.envNote')}</p>{Object.entries(runtimeEnv).map(([name, value]) => <div key={name} className="grid grid-cols-[minmax(100px,0.8fr)_minmax(100px,1fr)_auto] gap-2"><input value={name} onChange={(event) => setRuntimeEnv((prev) => { const next = { ...prev }; delete next[name]; if (event.target.value.trim()) next[event.target.value.trim()] = value; return next; })} aria-label={tr('svc.varKey')} className="min-w-0 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs font-mono"/><input value={value} onChange={(event) => setRuntimeEnv((prev) => ({ ...prev, [name]: event.target.value.replace(/[\r\n]/g, '') }))} aria-label={tr('svc.valueOf', { name })} className="min-w-0 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs font-mono"/><button onClick={() => setRuntimeEnv((prev) => { const next = { ...prev }; delete next[name]; return next; })} className="px-2 text-xs text-[var(--error)]">×</button></div>)}<button onClick={() => { let n = 1; while (runtimeEnv[`CUSTOM_ENV_${n}`] !== undefined) n++; setRuntimeEnv((prev) => ({ ...prev, [`CUSTOM_ENV_${n}`]: '' })); }} className="text-xs text-[var(--accent)] hover:underline">{tr('svc.addVar')}</button></div>}
        </div>

        {Object.keys(runtimes).length > 0 && <div className="space-y-2">
          <button onClick={() => setShowDev((v) => !v)} className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)]">{showDev ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}.devcontainer/devcontainer.json</button>
          {showDev && <pre className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] p-4 text-xs overflow-auto max-h-72">{runtimeConfig}</pre>}
        </div>}
      </div> : <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{tr('svc.toolsEnv')}</h2>
          <button onClick={() => void refreshEnv()} disabled={envLoading} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-color)] text-sm hover:bg-[var(--bg-hover)] disabled:opacity-50"><RefreshCw size={14} className={envLoading ? 'animate-spin' : ''}/>{tr('svc.check')}</button>
        </div>

        {/* Gating banners */}
        {(() => {
          const docker = envTools.find((t) => t.id === 'docker');
          const ollama = envTools.find((t) => t.id === 'ollama');
          const banner = (ok: boolean, okText: string, badText: string) => (
            <div className={`rounded-lg border px-3 py-2 text-xs ${ok ? 'border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success)]' : 'border-[var(--warning)]/30 bg-[var(--warning)]/10 text-[var(--warning)]'}`}>{ok ? okText : badText}</div>
          );
          return <div className="grid sm:grid-cols-2 gap-2">
            {docker && banner(docker.installed, tr('svc.dockerOk'), tr('svc.dockerNo'))}
            {ollama && banner(ollama.installed, ollama.running ? tr('svc.ollamaRun') : tr('svc.ollamaOk'), tr('svc.ollamaNo'))}
          </div>;
        })()}

        {envLoading && envTools.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]"><Loader2 size={14} className="animate-spin"/>{tr('svc.checkingEnv')}</div>
        ) : ([
          { kind: 'container', label: 'svc.containers', icon: Container },
          { kind: 'ai', label: 'AI', icon: Cpu },
          { kind: 'runtime', label: 'svc.runtimes', icon: Boxes },
          { kind: 'tool', label: 'svc.tools', icon: Wrench },
        ] as const).map((group) => {
          const items = envTools.filter((t) => t.kind === group.kind);
          if (!items.length) return null;
          const GIcon = group.icon;
          return <section key={group.kind} className="space-y-2">
            <h3 className="text-xs uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5"><GIcon size={13}/>{group.label.startsWith('svc.') ? tr(group.label) : group.label}</h3>
            <div className="grid gap-2">
              {items.map((t) => {
                const inst = toolInstalls[t.id];
                const variant = toolVariant[t.id] ?? t.wingetId;
                return <div key={t.id} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm">
                        {t.installed ? <Check size={14} className="text-[var(--success)] shrink-0"/> : <X size={14} className="text-[var(--text-muted)] shrink-0"/>}
                        <span className="text-[var(--text-primary)] truncate">{t.name}</span>
                        {t.id === 'ollama' && t.installed && <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.running ? 'bg-[var(--success)]/15 text-[var(--success)]' : 'bg-[var(--error)]/15 text-[var(--error)]'}`}>{t.running ? tr('svc.running') : tr('svc.notRunning')}</span>}
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)] font-mono truncate mt-0.5">{t.installed ? (t.version || tr('svc.installedWord')) : (t.note || tr('svc.notInstalledWord'))}</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {TOOL_DOCS[t.id] && <a href={TOOL_DOCS[t.id]} target="_blank" rel="noreferrer" className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--accent)]" title={tr('svc.docs')}><BookOpen size={14}/></a>}
                      {t.options && t.options.length > 0 && (
                        <select value={variant} onChange={(e) => setToolVariant((p) => ({ ...p, [t.id]: e.target.value }))} className="rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-xs max-w-[160px]">
                          {t.options.map((o) => <option key={o.wingetId} value={o.wingetId}>{o.label}</option>)}
                        </select>
                      )}
                      {inst?.running ? (
                        <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]"><Loader2 size={13} className="animate-spin"/>{tr(inst.action === 'uninstall' ? 'svc.uninstalling' : inst.action === 'reinstall' ? 'svc.reinstalling' : 'svc.installing')}</span>
                      ) : t.installed ? (
                        <>
                          {t.options && t.options.length > 0 && t.id !== 'php' && (
                            <button onClick={() => void installEnvTool(t.id, variant)} title={tr('svc.installVersion')} aria-label={tr('svc.installVersion')} className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)]"><Download size={14}/></button>
                          )}
                          <button onClick={() => void installEnvTool(t.id, undefined, 'reinstall')} title={tr('svc.reinstall')} aria-label={tr('svc.reinstall')} className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)]"><RotateCw size={14}/></button>
                          <button onClick={() => void installEnvTool(t.id, undefined, 'uninstall')} title={tr('svc.uninstall')} aria-label={tr('svc.uninstall')} className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error)]/10"><Trash2 size={14}/></button>
                        </>
                      ) : (
                        <button onClick={() => void installEnvTool(t.id, variant)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/40 transition-colors"><Download size={13}/>{t.wingetId ? 'winget' : 'getcomposer.org'}</button>
                      )}
                    </div>
                  </div>
                  {inst && inst.log.length > 0 && <pre className="mt-2 max-h-32 overflow-y-auto rounded bg-[var(--bg-tertiary)] p-2 text-[10px] font-mono text-[var(--text-muted)] whitespace-pre-wrap">{inst.log.join('\n')}</pre>}
                </div>;
              })}
            </div>
          </section>;
        })}
        <PhpManager project={project} />
        <p className="text-[10px] text-[var(--text-muted)]">{tr('svc.wingetNote')}</p>
      </div>}

      {error && <div className="rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">{error}</div>}
      {notice && <div className="rounded-lg border border-[var(--success)]/30 bg-[var(--success)]/10 p-3 text-sm text-[var(--success)]">{notice}</div>}
      <footer className="flex flex-wrap gap-2 border-t border-[var(--border-color)] pt-4">
        <button onClick={() => void saveConfig()} disabled={busy || (!instances.length && !Object.keys(runtimes).length)} className="px-4 py-2 rounded-lg bg-[var(--bg-active)] hover:bg-[var(--bg-hover)] text-sm disabled:opacity-40">{tr('svc.saveConfig')}</button>
        {tab === 'services' && (
          <button onClick={() => void dockerAction('validate')} disabled={busy || !instances.length} className="px-4 py-2 rounded-lg border border-[var(--border-color)] text-sm disabled:opacity-40">{tr('svc.validate')}</button>
        )}
        {tab === 'runtimes' && <>
          <button onClick={() => void dockerAction('runtime-up')} disabled={busy || !Object.keys(runtimes).length} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--accent)] text-[var(--on-accent)] font-medium text-sm disabled:opacity-40"><Play size={14}/>{busy ? tr('svc.building') : tr('svc.buildEnv')}</button>
          <button onClick={() => void dockerAction('runtime-down')} disabled={busy || !Object.keys(runtimes).length} className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--border-color)] text-sm disabled:opacity-40"><Square size={13}/>{tr('svc.stopEnv')}</button>
        </>}
      </footer>
    </div>

    {/* Service picker */}
    {pickerOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setPickerOpen(false)}>
      <div className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)] sticky top-0 bg-[var(--bg-secondary)]">
          <h3 className="text-sm font-semibold flex items-center gap-2"><Plus size={15} className="text-[var(--accent)]"/>{tr('svc.add')}</h3>
          <button onClick={() => setPickerOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={16}/></button>
        </div>
        <div className="p-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] px-1 pt-1 pb-1.5">{tr('svc.dbBrokers')}</div>
          {CATALOG.filter((item) => item.group === 'database').map((item) => <button key={item.key} onClick={() => add(item.key)} className="w-full flex items-center gap-3 rounded-lg border border-[var(--border-color)] p-3 text-left hover:border-[var(--accent)]/50 hover:bg-[var(--bg-hover)] transition-colors">
            <Database size={16} className="text-[var(--accent)] shrink-0"/><div className="flex-1 min-w-0"><div className="text-sm">{item.name}</div><div className="text-xs text-[var(--text-muted)] truncate">{item.note} · {item.image}</div></div><Plus size={15} className="text-[var(--text-muted)] shrink-0"/>
          </button>)}
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] px-1 pt-3 pb-1.5">{tr('svc.realtime')}</div>
          {CATALOG.filter((item) => item.group === 'realtime').map((item) => <button key={item.key} onClick={() => add(item.key)} className="w-full flex items-center gap-3 rounded-lg border border-[var(--border-color)] p-3 text-left hover:border-[var(--accent)]/50 hover:bg-[var(--bg-hover)] transition-colors">
            <Boxes size={16} className="text-[var(--accent)] shrink-0"/><div className="flex-1 min-w-0"><div className="text-sm">{item.name}</div><div className="text-xs text-[var(--text-muted)] truncate">{item.note} · {item.image}</div></div><Plus size={15} className="text-[var(--text-muted)] shrink-0"/>
          </button>)}
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] px-1 pt-3 pb-1.5">{tr('svc.webClients')}</div>
          {CATALOG.filter((item) => item.group === 'client').map((item) => <button key={item.key} onClick={() => add(item.key)} className="w-full flex items-center gap-3 rounded-lg border border-[var(--border-color)] p-3 text-left hover:border-[var(--accent)]/50 hover:bg-[var(--bg-hover)] transition-colors">
            <ExternalLink size={16} className="text-[var(--accent)] shrink-0"/><div className="flex-1 min-w-0"><div className="text-sm">{item.name}</div><div className="text-xs text-[var(--text-muted)] truncate">{item.note}</div></div><Plus size={15} className="text-[var(--text-muted)] shrink-0"/>
          </button>)}
        </div>
      </div>
    </div>}

    {/* Language picker */}
    {langPickerOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setLangPickerOpen(false)}>
      <div className="w-full max-w-md max-h-[80vh] overflow-y-auto rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)] sticky top-0 bg-[var(--bg-secondary)]">
          <h3 className="text-sm font-semibold flex items-center gap-2"><Plus size={15} className="text-[var(--accent)]"/>{tr('svc.addLang')}</h3>
          <button onClick={() => setLangPickerOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={16}/></button>
        </div>
        <div className="p-3 space-y-1">
          {RUNTIMES.filter((rt) => runtimes[rt.key] === undefined).map((rt) => <button key={rt.key} onClick={() => addLang(rt.key)} className="w-full flex items-center gap-3 rounded-lg border border-[var(--border-color)] p-3 text-left hover:border-[var(--accent)]/50 hover:bg-[var(--bg-hover)] transition-colors">
            <Container size={16} className="text-[var(--accent)] shrink-0"/><div className="flex-1 min-w-0"><div className="text-sm">{rt.name}</div><div className="text-xs text-[var(--text-muted)] truncate">{tr('svc.versions', { list: rt.versions.join(', ') })}</div></div><Plus size={15} className="text-[var(--text-muted)] shrink-0"/>
          </button>)}
          {RUNTIMES.every((rt) => runtimes[rt.key] !== undefined) && <div className="text-sm text-[var(--text-muted)] p-3 text-center">{tr('svc.allLangs')}</div>}
        </div>
      </div>
    </div>}
  </section>;
}
