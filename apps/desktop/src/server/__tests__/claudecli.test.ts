import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cliArgs, cliEnv, cliToolTarget, isCliModel, ottoToolName, withHistory } from '../claudecli';

test('the CLI runs headless with streaming output and the chosen model alias', () => {
  const a = cliArgs({ model: 'claude-cli/opus', edits: true, shell: false });
  assert.deepEqual(a.slice(0, 7), ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'opus']);
  assert.ok(isCliModel('claude-cli/sonnet'));
  assert.ok(!isCliModel('claude/claude-sonnet-4'));
});

test('Otto rules carry over: Tools off = read-only, commands only in auto mode', () => {
  const readOnly = cliArgs({ model: 'claude-cli/sonnet', edits: false, shell: true });
  const blocked = readOnly.slice(readOnly.indexOf('--disallowedTools') + 1);
  for (const t of ['Edit', 'Write', 'MultiEdit', 'Bash']) assert.ok(blocked.includes(t), `${t} must be blocked without Tools`);
  assert.ok(!readOnly.includes('--allowedTools'));

  const noShell = cliArgs({ model: 'claude-cli/sonnet', edits: true, shell: false });
  assert.ok(noShell.slice(noShell.indexOf('--disallowedTools') + 1).includes('Bash'));
  assert.equal(noShell[noShell.indexOf('--permission-mode') + 1], 'acceptEdits');

  const full = cliArgs({ model: 'claude-cli/sonnet', edits: true, shell: true });
  assert.equal(full[full.indexOf('--allowedTools') + 1], 'Bash');
  assert.ok(!full.slice(full.indexOf('--disallowedTools') + 1).includes('Bash'));
});

test('the subscription login is used: API keys and parent-session markers are removed from the environment', () => {
  const env = cliEnv({ PATH: 'x', ANTHROPIC_API_KEY: 'sk-1', ANTHROPIC_BASE_URL: 'http://proxy', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_OAUTH_SCOPES: 'x', CLAUDE_CONFIG_DIR: '/cfg', HOME: '/h' });
  // the user's own config folder (if they set one) is kept
  assert.deepEqual(env, { PATH: 'x', CLAUDE_CONFIG_DIR: '/cfg', HOME: '/h', MCP_TOOL_TIMEOUT: '900000' });
});

test('CLI tool calls are shown with Otto names and project-relative targets', () => {
  const root = path.resolve('/proj');
  assert.equal(ottoToolName('Edit'), 'write_file');
  assert.equal(ottoToolName('Bash'), 'run_command');
  assert.equal(ottoToolName('Grep'), 'search_files');
  assert.equal(cliToolTarget({ file_path: path.join(root, 'src', 'a.ts') }, root), 'src/a.ts');
  assert.equal(cliToolTarget({ command: 'docker compose up -d' }, root), 'docker compose up -d');
  assert.equal(cliToolTarget({ pattern: 'TODO' }, root), 'TODO');
});

test('earlier turns go along with the prompt; the changes card is stripped', () => {
  const p = withHistory('and now add a test', [
    { role: 'user', content: 'create a.ts' },
    { role: 'assistant', content: 'Done.\n\n:::changes\n[{"path":"a.ts"}]\n:::' },
    { role: 'system', content: 'ignored' },
  ]);
  assert.match(p, /User: create a\.ts/);
  assert.match(p, /Assistant: Done\./);
  assert.ok(!p.includes(':::changes'));
  assert.ok(!p.includes('ignored'));
  assert.match(p, /Now: and now add a test$/);
  assert.equal(withHistory('hi', []), 'hi');
});

import { codexArgs, codexEnv, codexItemActivity, isCodexModel } from '../codexcli';

test('Codex runs headless in the project folder, sandboxed: read-only without Tools', () => {
  const ro = codexArgs({ model: 'codex-cli/gpt-6-luna', cwd: 'C:/p', edits: false });
  assert.deepEqual(ro.slice(0, 8), ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', 'C:/p', '--sandbox', 'read-only']);
  assert.ok(ro.includes('-m') && ro[ro.indexOf('-m') + 1] === 'gpt-6-luna');
  assert.equal(ro[ro.length - 1], '-');
  const rw = codexArgs({ model: 'codex-cli/default', cwd: 'C:/p', edits: true });
  assert.equal(rw[rw.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(!rw.includes('-m'), 'default model: no -m');
  assert.ok(isCodexModel('codex-cli/x') && !isCodexModel('openrouter/x'));
});

test('Codex uses the ChatGPT login, never an API key from the environment', () => {
  assert.deepEqual(codexEnv({ PATH: 'x', OPENAI_API_KEY: 'sk', CODEX_API_KEY: 'k', HOME: '/h' }), { PATH: 'x', HOME: '/h' });
});

test('Codex items become Otto activity lines', () => {
  const root = path.resolve('/proj');
  assert.deepEqual(codexItemActivity({ type: 'command_execution', command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "docker compose up -d"' }, root), [{ tool: 'run_command', target: 'docker compose up -d' }]);
  assert.deepEqual(codexItemActivity({ type: 'file_change', changes: [{ path: path.join(root, 'a.ts'), kind: 'update' }, { path: 'b.ts', kind: 'delete' }] }, root), [{ tool: 'write_file', target: 'a.ts' }, { tool: 'delete_file', target: 'b.ts' }]);
  assert.deepEqual(codexItemActivity({ type: 'agent_message', text: 'hi' }, root), []);
});

import { cliUsage, rememberClaudeLimits, claudeLimits } from '../claudecli';
import { codexUsage } from '../codexcli';

test('the context meter gets real figures from the subscription CLIs', () => {
  const u = cliUsage({ type: 'result', duration_api_ms: 2000, usage: { input_tokens: 1200, cache_read_input_tokens: 8000, cache_creation_input_tokens: 800, output_tokens: 400 }, modelUsage: { 'claude-sonnet-5-5': { contextWindow: 1_000_000 } } }, 'claude-sonnet-5-5')!;
  assert.deepEqual(u, { model: 'claude-sonnet-5-5', used: 10_000, ctx: 1_000_000, generated: 400, tps: 200, estimated: false, compacted: 0 });
  assert.equal(cliUsage({ type: 'result' }, 'x'), null);
  const c = codexUsage({ type: 'turn.completed', usage: { input_tokens: 5000, output_tokens: 90, reasoning_output_tokens: 10 } }, 'codex-cli/none', 1000)!;
  assert.equal(c.used, 5000);
  assert.equal(c.generated, 100);
  assert.ok(c.ctx > 0);
});

test('Claude subscription limits reported during a run are kept for the UI', () => {
  rememberClaudeLimits({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1_800_000_000, utilization: 0.82 });
  const l = claudeLimits()!;
  assert.equal(l.status, 'allowed_warning');
  assert.equal(l.type, 'five_hour');
  assert.equal(l.resetsAt, 1_800_000_000_000);
  assert.equal(l.utilization, 0.82);
});
