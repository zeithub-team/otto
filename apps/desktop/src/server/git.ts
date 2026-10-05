/**
 * Git integration for zeithub.otto.
 *
 * Two parts, no `electron` import (runs inside the embedded server):
 *  - provider REST (GitHub) for auth, orgs and repositories, using a PAT;
 *  - local `git` CLI for branch listing / switching / cloning.
 */
import { spawn, spawnSync } from 'child_process';
import { errorMessage } from './http';

const GITHUB_API = 'https://api.github.com';

export interface GitIdentity {
  username: string;
  displayName: string;
  avatarUrl: string;
}

export interface RepoInfo {
  name: string;
  full_name: string;
  clone_url: string;
  private: boolean;
  owner: string;
  description: string;
}

/** GitHub API GET with a bearer token; throws a readable error on failure. */
async function githubGet(token: string, path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'zeithub.otto',
      },
    });
  } catch (exc) {
    throw new Error(`Не удалось связаться с GitHub: ${errorMessage(exc)}`);
  }
  if (res.status === 401) throw new Error('Неверный или просроченный токен');
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

/** Validate a token and return the account identity. */
export async function validateToken(provider: string, token: string): Promise<GitIdentity> {
  if (provider !== 'github') throw new Error(`Провайдер не поддерживается: ${provider}`);
  const user = (await githubGet(token, '/user')) as Record<string, unknown>;
  const login = String(user.login ?? '').trim();
  if (!login) throw new Error('GitHub не вернул имя пользователя');
  return {
    username: login,
    displayName: String(user.name ?? login),
    avatarUrl: String(user.avatar_url ?? ''),
  };
}

/** Login names the token can act for: the user plus their organisations. */
export async function listOwners(token: string): Promise<string[]> {
  const user = (await githubGet(token, '/user')) as Record<string, unknown>;
  const orgs = (await githubGet(token, '/user/orgs')) as Array<Record<string, unknown>>;
  const owners = [String(user.login ?? '')];
  for (const org of orgs) owners.push(String(org.login ?? ''));
  return owners.filter(Boolean);
}

/** Repositories the token can access (user repos, newest first). */
export async function listRepos(token: string): Promise<RepoInfo[]> {
  const repos = (await githubGet(
    token,
    '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
  )) as Array<Record<string, unknown>>;
  return repos.map((r) => ({
    name: String(r.name ?? ''),
    full_name: String(r.full_name ?? ''),
    clone_url: String(r.clone_url ?? ''),
    private: Boolean(r.private),
    owner: String((r.owner as Record<string, unknown> | undefined)?.login ?? ''),
    description: String(r.description ?? ''),
  }));
}

// ------------------------------------------------------------- local git CLI

function git(cwd: string, args: string[], timeout = 30000) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: process.platform === 'win32',
    maxBuffer: 4 * 1024 * 1024,
  });
}

export interface BranchInfo {
  current: string | null;
  branches: string[];
  isRepo: boolean;
}

/** List local branches and the current one. */
export function listBranches(cwd: string): BranchInfo {
  const head = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.status !== 0) return { current: null, branches: [], isRepo: false };
  const current = (head.stdout ?? '').trim() || null;
  const list = git(cwd, ['branch', '--format=%(refname:short)']);
  const branches = (list.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { current, branches, isRepo: true };
}

/** Checkout a branch, optionally creating it. Throws on git error. */
export function checkoutBranch(cwd: string, branch: string, create: boolean): string {
  const args = create ? ['checkout', '-b', branch] : ['checkout', branch];
  const res = git(cwd, args);
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || 'git checkout failed').trim());
  }
  return (res.stdout || res.stderr || '').trim();
}

/**
 * `POST /api/git/clone` — clone a repo, streaming progress. Yields output
 * lines; the token is injected into the HTTPS URL for private repositories.
 */
export function cloneRepo(
  destDir: string,
  cloneUrl: string,
  token: string | null,
  onLine: (line: string) => void,
): Promise<number> {
  let url = cloneUrl;
  if (token && url.startsWith('https://')) {
    // Embed the token so private repos clone without a credential prompt.
    url = url.replace('https://', `https://${token}@`);
  }
  const child = spawn('git', ['clone', '--progress', url, destDir], {
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  const redact = (s: string): string => (token ? s.split(token).join('***') : s);
  const pump = (buf: Buffer): void => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t) onLine(redact(t));
    }
  };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump); // git clone prints progress to stderr
  return new Promise((resolve) => {
    child.on('error', (exc) => { onLine(redact(errorMessage(exc))); resolve(1); });
    child.on('close', (code) => resolve(code ?? 0));
  });
}
