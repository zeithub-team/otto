/**
 * Project detection for the Preview tab: what stack a folder is, whether it
 * has containers and a front end, and which commands could run it.
 * Pure file inspection — nothing is executed here.
 */
import * as fs from 'fs';
import * as path from 'path';

export type RunKind = 'node' | 'laravel' | 'django' | 'python' | 'rails' | 'php' | 'go' | 'docker' | 'static' | 'none';

export interface RunOption {
  id: string;
  label: string;
  command: string;
  /** Port the server is expected to listen on (used to notice it when nothing is printed). */
  port: number | null;
  kind: RunKind;
  /** This option serves a user interface (not just an API). */
  frontend: boolean;
}

export interface ComposeService {
  name: string;
  /** Host ports the service publishes. */
  ports: number[];
}

export interface ContainerInfo {
  compose: string | null;
  services: ComposeService[];
  dockerfile: boolean;
  devcontainer: boolean;
}

export interface ProjectDetection {
  /** Human names of what was recognised, e.g. ["Next.js", "Docker Compose"]. */
  stacks: string[];
  /** The project has a UI that can be previewed in a frame. */
  frontend: boolean;
  containers: ContainerInfo;
  hasIndex: boolean;
  options: RunOption[];
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};
const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

interface Pkg {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

/** Front-end frameworks by dependency: [dependency, label, default dev port]. */
const NODE_FRAMEWORKS: Array<[string, string, number | null]> = [
  ['next', 'Next.js', 3000],
  ['nuxt', 'Nuxt', 3000],
  ['@sveltejs/kit', 'SvelteKit', 5173],
  ['astro', 'Astro', 4321],
  ['@remix-run/dev', 'Remix', 3000],
  ['@angular/cli', 'Angular', 4200],
  ['react-scripts', 'Create React App', 3000],
  ['gatsby', 'Gatsby', 8000],
  ['@vue/cli-service', 'Vue CLI', 8080],
  ['vite', 'Vite', 5173],
  ['parcel', 'Parcel', 1234],
  ['webpack-dev-server', 'webpack', 8080],
  ['solid-start', 'SolidStart', 3000],
  ['@11ty/eleventy', 'Eleventy', 8080],
];
const UI_LIBS = ['react', 'react-dom', 'vue', 'svelte', 'solid-js', 'preact', 'lit', 'alpinejs', '@angular/core'];

interface NodeInfo {
  label: string;
  frontend: boolean;
  port: number | null;
  script: string | null;
}

function inspectPackage(pkg: Pkg): NodeInfo {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const fw = NODE_FRAMEWORKS.find(([dep]) => deps[dep]);
  const ui = UI_LIBS.some((dep) => deps[dep]);
  const script = ['dev', 'start', 'serve', 'preview'].find((s) => pkg.scripts?.[s]) ?? null;
  const backend = ['express', 'fastify', 'koa', '@nestjs/core', 'hono'].find((dep) => deps[dep]);
  return {
    label: fw?.[1] ?? (ui ? 'JavaScript UI' : backend ? 'Node API' : 'Node.js'),
    frontend: Boolean(fw) || ui,
    port: fw?.[2] ?? null,
    script,
  };
}

const npmCommand = (script: string, extra = ''): string => (script === 'start' && !extra ? 'npm start' : `npm run ${script}${extra}`);

/** `workspaces` globs → package folders (one `*` level, which covers apps/*, packages/*). */
function workspaceDirs(root: string, pkg: Pkg): string[] {
  const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
  const dirs: string[] = [];
  for (const glob of globs) {
    if (glob.endsWith('/*')) {
      const parent = path.join(root, glob.slice(0, -2));
      if (!isDir(parent)) continue;
      for (const name of fs.readdirSync(parent)) {
        const dir = path.join(parent, name);
        if (isFile(path.join(dir, 'package.json'))) dirs.push(dir);
      }
    } else if (!glob.includes('*') && isFile(path.join(root, glob, 'package.json'))) {
      dirs.push(path.join(root, glob));
    }
  }
  return dirs;
}

const FRONT_DIRS = ['frontend', 'client', 'web', 'ui', 'app', 'www', 'site', 'dashboard', 'admin'];

/** Parse the services and published host ports out of a compose file (no YAML library needed). */
export function parseCompose(text: string): ComposeService[] {
  const services: ComposeService[] = [];
  const lines = text.split(/\r?\n/);
  let inServices = false;
  let servicesIndent = -1;
  let current: ComposeService | null = null;
  let inPorts = false;
  let portsIndent = -1;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      inServices = /^services:\s*$/.test(line);
      current = null;
      inPorts = false;
      continue;
    }
    if (!inServices) continue;
    if (servicesIndent < 0) servicesIndent = indent;
    if (indent === servicesIndent && /^[\w.-]+:\s*$/.test(line)) {
      current = { name: line.slice(0, -1), ports: [] };
      services.push(current);
      inPorts = false;
      continue;
    }
    if (!current) continue;
    if (/^ports:\s*$/.test(line)) {
      inPorts = true;
      portsIndent = indent;
      continue;
    }
    if (inPorts) {
      if (indent <= portsIndent && !line.startsWith('-')) {
        inPorts = false;
        continue;
      }
      const item = /^-\s*["']?([^"'\s#]+)["']?/.exec(line);
      if (item) {
        const parts = item[1].split(':');
        // "3000:3000", "127.0.0.1:8080:80" → host port is the second-to-last part
        if (parts.length >= 2) {
          const host = Number(parts[parts.length - 2].replace(/[^\d]/g, ''));
          if (host > 0) current.ports.push(host);
        }
      }
    } else if (indent <= portsIndent) {
      inPorts = false;
    }
  }
  return services;
}

const FRONT_SERVICE_NAMES = /^(web|front|frontend|client|ui|app|site|nginx|proxy|gateway|www)/i;

function containersOf(root: string): ContainerInfo {
  const composeName = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find((n) => isFile(path.join(root, n))) ?? null;
  return {
    compose: composeName,
    services: composeName ? parseCompose(readText(path.join(root, composeName))) : [],
    dockerfile: isFile(path.join(root, 'Dockerfile')),
    devcontainer: isFile(path.join(root, '.devcontainer', 'devcontainer.json')) || isFile(path.join(root, '.devcontainer.json')),
  };
}

export function detectProject(root: string): ProjectDetection {
  const has = (name: string): boolean => fs.existsSync(path.join(root, name));
  const stacks: string[] = [];
  const options: RunOption[] = [];
  const add = (opt: RunOption): void => {
    if (!options.some((o) => o.command === opt.command)) options.push(opt);
  };
  const hasIndex = has('index.html');

  // ---- Node ------------------------------------------------------------
  const rootPkg = isFile(path.join(root, 'package.json')) ? readJson<Pkg>(path.join(root, 'package.json')) : null;
  const nodeOptions: RunOption[] = [];
  if (rootPkg) {
    const workspaces = workspaceDirs(root, rootPkg);
    for (const dir of workspaces) {
      const pkg = readJson<Pkg>(path.join(dir, 'package.json'));
      if (!pkg) continue;
      const info = inspectPackage(pkg);
      if (!info.script) continue;
      const rel = path.relative(root, dir).split(path.sep).join('/');
      const workspace = pkg.name ? ` -w ${pkg.name}` : ` --prefix ${rel}`;
      nodeOptions.push({
        id: `ws:${rel}`,
        label: `${rel} — ${info.label} (${info.script})`,
        command: npmCommand(info.script, workspace),
        port: info.port,
        kind: 'node',
        frontend: info.frontend,
      });
      if (!stacks.includes(info.label)) stacks.push(info.label);
    }
    const info = inspectPackage(rootPkg);
    if (info.script) {
      nodeOptions.push({
        id: 'root',
        label: workspaces.length ? `${rootPkg.name ?? 'root'} — ${info.script} (all)` : `${info.label} (${info.script})`,
        command: npmCommand(info.script),
        port: info.port,
        kind: 'node',
        frontend: info.frontend || workspaces.length > 0,
      });
    }
    if (!stacks.length || !workspaces.length) stacks.unshift(info.label);
  }
  // front ends kept in a sub-folder next to a back end (frontend/, client/, web/…)
  for (const name of FRONT_DIRS) {
    const dir = path.join(root, name);
    const pkg = isFile(path.join(dir, 'package.json')) ? readJson<Pkg>(path.join(dir, 'package.json')) : null;
    if (!pkg || rootPkg) continue;
    const info = inspectPackage(pkg);
    if (!info.script) continue;
    nodeOptions.push({
      id: `dir:${name}`,
      label: `${name}/ — ${info.label} (${info.script})`,
      command: npmCommand(info.script, ` --prefix ${name}`),
      port: info.port,
      kind: 'node',
      frontend: info.frontend,
    });
    if (!stacks.includes(info.label)) stacks.push(info.label);
  }
  // front-end options first; in a workspace monorepo the root script (starts everything) leads
  nodeOptions.sort((a, b) => Number(b.frontend) - Number(a.frontend));
  const rootAll = nodeOptions.findIndex((o) => o.id === 'root');
  if (rootAll > 0 && nodeOptions.length > 1 && rootPkg && workspaceDirs(root, rootPkg).length) nodeOptions.unshift(...nodeOptions.splice(rootAll, 1));
  nodeOptions.forEach(add);

  // ---- PHP -------------------------------------------------------------
  if (has('artisan')) {
    stacks.push('Laravel');
    add({ id: 'laravel', label: 'Laravel (artisan serve)', command: 'php artisan serve', port: 8000, kind: 'laravel', frontend: true });
  } else if (has('composer.json') && (has('index.php') || has('public/index.php'))) {
    stacks.push('PHP');
    const docroot = has('public/index.php') ? ' -t public' : '';
    add({ id: 'php', label: 'PHP (built-in server)', command: `php -S localhost:8000${docroot}`, port: 8000, kind: 'php', frontend: true });
  } else if (has('index.php')) {
    stacks.push('PHP');
    add({ id: 'php', label: 'PHP (built-in server)', command: 'php -S localhost:8000', port: 8000, kind: 'php', frontend: true });
  }

  // ---- Python ----------------------------------------------------------
  const pyDeps = (readText(path.join(root, 'requirements.txt')) + readText(path.join(root, 'pyproject.toml'))).toLowerCase();
  if (has('manage.py')) {
    stacks.push('Django');
    add({ id: 'django', label: 'Django (runserver)', command: 'python manage.py runserver', port: 8000, kind: 'django', frontend: true });
  } else if (pyDeps.includes('fastapi') || pyDeps.includes('uvicorn')) {
    stacks.push('FastAPI');
    const entry = ['main', 'app'].find((m) => has(`${m}.py`)) ?? 'main';
    add({ id: 'fastapi', label: 'FastAPI (uvicorn)', command: `uvicorn ${entry}:app --reload`, port: 8000, kind: 'python', frontend: false });
  } else if (pyDeps.includes('flask')) {
    stacks.push('Flask');
    add({ id: 'flask', label: 'Flask', command: 'flask run', port: 5000, kind: 'python', frontend: true });
  }

  // ---- Others ----------------------------------------------------------
  if (has('bin/rails') || (has('Gemfile') && readText(path.join(root, 'Gemfile')).includes('rails'))) {
    stacks.push('Rails');
    add({ id: 'rails', label: 'Rails (server)', command: 'bin/rails server', port: 3000, kind: 'rails', frontend: true });
  }
  if (has('go.mod')) {
    stacks.push('Go');
    add({ id: 'go', label: 'Go (run)', command: 'go run .', port: null, kind: 'go', frontend: false });
  }

  // ---- Containers ------------------------------------------------------
  const containers = containersOf(root);
  if (containers.compose) {
    stacks.push('Docker Compose');
    const published = containers.services.filter((s) => s.ports.length);
    const front = published.find((s) => FRONT_SERVICE_NAMES.test(s.name)) ?? published[0];
    add({
      id: 'compose',
      label: `Docker Compose${front ? ` (${front.name}:${front.ports[0]})` : ''}`,
      command: 'docker compose up',
      port: front?.ports[0] ?? null,
      kind: 'docker',
      frontend: Boolean(front && FRONT_SERVICE_NAMES.test(front.name)) || published.length > 0,
    });
  } else if (containers.dockerfile) {
    stacks.push('Docker');
  }
  if (containers.devcontainer) stacks.push('Dev Container');

  // ---- Static ----------------------------------------------------------
  if (hasIndex) {
    if (!stacks.length) stacks.push('Static site');
  }

  const frontend = hasIndex || has('resources/views') || options.some((o) => o.frontend) || Boolean(rootPkg && inspectPackage(rootPkg).frontend);
  return { stacks: [...new Set(stacks)], frontend, containers, hasIndex, options };
}
