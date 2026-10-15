import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTool } from '../ollama';
import { syntaxProblems, vetWrite } from '../codecheck';
import { EditSession, isFailure, LoopGuard } from '../runguard';
import { Checkpoint, hasCheckpoint, restoreCheckpoint } from '../checkpoints';
import { ChangeTracker } from '../changes';

const tmpProject = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'otto-guard-'));
const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

// ---------------------------------------------------------------- codecheck --

test('the parser finds broken JS / TS / JSON / CSS and passes good code', () => {
  assert.deepEqual(syntaxProblems('a.ts', 'export const a: number = 1;\n'), []);
  assert.ok(syntaxProblems('a.ts', 'export function f( {\n  return 1;\n')!.length > 0);
  assert.deepEqual(syntaxProblems('App.jsx', 'export default () => <div className="x">hi</div>;\n'), []);
  assert.ok(syntaxProblems('App.tsx', 'export const A = () => <div>hi</span>;\n')!.length > 0);
  assert.deepEqual(syntaxProblems('p.json', '{"a": 1}'), []);
  assert.equal(syntaxProblems('p.json', '{"a": 1,,}')!.length, 1);
  assert.deepEqual(syntaxProblems('s.css', 'a { content: "}"; } /* { */\n'), []);
  assert.ok(syntaxProblems('s.css', 'body {\n  color: red;\n')!.length > 0);
  assert.equal(syntaxProblems('notes.md', '# {{{'), null);
});

test('inline scripts of a page are checked with their line in the page', () => {
  const page = '<!doctype html>\n<html>\n<body>\n<script>\nconst a = ;\n</script>\n</body>\n</html>\n';
  const problems = syntaxProblems('index.html', page)!;
  assert.equal(problems.length > 0, true);
  assert.equal(problems[0].line, 5);
  // a template placeholder and an external script are left alone
  assert.deepEqual(syntaxProblems('t.html', '<script>var x = {{ data }};</script><script src="a.js"></script>'), []);
});

test('a change that breaks a working file is rejected; new files and appends only warn', () => {
  const good = 'export function f() {\n  return 1;\n}\n';
  const bad = 'export function f() {\n  return 1;\n';
  assert.match(vetWrite('f.ts', good, bad, 'overwrite').reject ?? '', /REJECTED.*NOT changed/s);
  assert.match(vetWrite('f.ts', good, bad, 'replace').reject ?? '', /line \d+/);
  assert.equal(vetWrite('f.ts', null, bad, 'create').reject, undefined);
  assert.match(vetWrite('f.ts', null, bad, 'create').warn ?? '', /append_file/);
  // a file that was already broken is not held hostage
  assert.equal(vetWrite('f.ts', bad, bad + '\n// more', 'overwrite').reject, undefined);
  assert.deepEqual(vetWrite('f.ts', good, good.replace('1', '2'), 'overwrite'), {});
});

test('runTool leaves a working file untouched when the write would break it', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'app.js'), 'function a() {\n  return 1;\n}\n');
  const out = runTool(root, 'replace_in_file', { path: 'app.js', find: '  return 1;\n}', replace: '  return 2;\n' });
  assert.match(out, /^REJECTED/);
  assert.equal(read(root, 'app.js'), 'function a() {\n  return 1;\n}\n');
  assert.match(runTool(root, 'replace_in_file', { path: 'app.js', find: 'return 1;', replace: 'return 2;' }), /^Replaced/);
  assert.match(runTool(root, 'write_file', { path: 'app.js', content: read(root, 'app.js') }), /^No change/);
});

// -------------------------------------------------------------- EditSession --

test('a big file is not rewritten before it was read in the run', () => {
  const root = tmpProject();
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'notes.txt'), long);
  const session = new EditSession();
  const blind = runTool(root, 'write_file', { path: 'notes.txt', content: long + 'extra\n' }, undefined, undefined, session);
  assert.match(blind, /not read it/);
  assert.equal(read(root, 'notes.txt'), long);
  runTool(root, 'read_file', { path: 'notes.txt' }, undefined, undefined, session);
  assert.match(runTool(root, 'write_file', { path: 'notes.txt', content: long + 'extra\n' }, undefined, undefined, session), /overwritten/);
});

test('throwing most of a file away must be confirmed by sending the same call again', () => {
  const root = tmpProject();
  const long = Array.from({ length: 20 }, (_, i) => `row ${i}`).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'list.txt'), long);
  const session = new EditSession();
  session.noteRead('list.txt');
  const first = runTool(root, 'write_file', { path: 'list.txt', content: 'row 0\n' }, undefined, undefined, session);
  assert.match(first, /^REJECTED for now/);
  assert.equal(read(root, 'list.txt'), long);
  assert.match(runTool(root, 'write_file', { path: 'list.txt', content: 'row 0\n' }, undefined, undefined, session), /overwritten/);
});

// ---------------------------------------------------------------- LoopGuard --

test('a read repeated with nothing changed in between is refused', () => {
  const guard = new LoopGuard(tmpProject());
  assert.equal(guard.before('read_file', { path: 'a.ts' }), null);
  guard.after('read_file', { path: 'a.ts' }, 'const a = 1;');
  assert.match(guard.before('read_file', { path: 'a.ts' }) ?? '', /^Repeated call/);
  // after a write the file may differ: reading it again is fine
  guard.after('write_file', { path: 'a.ts', content: 'x' }, 'File overwritten: a.ts');
  assert.equal(guard.before('read_file', { path: 'a.ts' }), null);
});

test('the same failing command is run twice at most', () => {
  const guard = new LoopGuard(tmpProject());
  const fail = '$ npm test\n(exit code 1, 2.1 s)\nError: boom';
  guard.after('run_command', { command: 'npm test' }, fail);
  assert.equal(guard.before('run_command', { command: 'npm test' }), null);
  guard.after('run_command', { command: 'npm test' }, fail.replace('2.1', '1.9'));
  assert.match(guard.before('run_command', { command: 'npm test' }) ?? '', /failed 2 times/);
});

test('appending the same text twice is refused (it would duplicate it)', () => {
  const guard = new LoopGuard(tmpProject());
  guard.after('append_file', { path: 'a.css', content: 'p{}' }, 'Appended to a.css');
  assert.match(guard.before('append_file', { path: 'a.css', content: 'p{}' }) ?? '', /duplicate/);
});

test('a rejected write may be sent again (that is how a big removal is confirmed)', () => {
  const guard = new LoopGuard(tmpProject());
  guard.after('write_file', { path: 'a.txt', content: 'x' }, 'REJECTED for now: …');
  assert.equal(guard.before('write_file', { path: 'a.txt', content: 'x' }), null);
});

test('the run stops when steps bring nothing new or keep failing', () => {
  const idle = new LoopGuard(tmpProject());
  for (let i = 0; i < 6; i++) idle.after('write_file', { path: 'a.txt', content: String(i) }, 'No change: a.txt already has exactly this content');
  assert.match(idle.stopReason ?? '', /nothing new/);

  const failing = new LoopGuard(tmpProject());
  for (let i = 0; i < 5; i++) failing.after('read_file', { path: `missing${i}.ts` }, 'File not found');
  assert.match(failing.stopReason ?? '', /failed/);

  const fine = new LoopGuard(tmpProject());
  for (let i = 0; i < 12; i++) fine.after('read_file', { path: `f${i}.ts` }, `content ${i}`);
  assert.equal(fine.stopReason, null);
});

test('a file switching back to its earlier versions stops the run', () => {
  const root = tmpProject();
  const guard = new LoopGuard(root);
  const write = (text: string) => {
    fs.writeFileSync(path.join(root, 'a.css'), text);
    guard.after('write_file', { path: 'a.css', content: text }, 'File overwritten: a.css');
  };
  write('a{}'); write('b{}'); write('a{}'); write('b{}');
  assert.match(guard.stopReason ?? '', /earlier versions/);
});

test('failures are told apart from results', () => {
  assert.equal(isFailure('REJECTED: …'), true);
  assert.equal(isFailure('$ npm test\n(exit code 1, 2 s)\nfail'), true);
  assert.equal(isFailure('$ npm test\n(exit code 0, 2 s)\nok'), false);
  assert.equal(isFailure('File overwritten: a.ts'), false);
});

// -------------------------------------------------------------- checkpoints --

test('a run can be undone: changed files come back, created ones go', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'keep.txt'), 'original');
  fs.writeFileSync(path.join(root, 'gone.txt'), 'will be deleted');
  const cp = new Checkpoint(root, 'msg-1');
  cp.remember('keep.txt');
  fs.writeFileSync(path.join(root, 'keep.txt'), 'changed');
  cp.remember('new/dir/made.txt');
  fs.mkdirSync(path.join(root, 'new/dir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'new/dir/made.txt'), 'new');
  cp.remember('gone.txt');
  fs.rmSync(path.join(root, 'gone.txt'));
  cp.save();
  assert.equal(hasCheckpoint(root, 'msg-1'), true);

  const r = restoreCheckpoint(root, 'msg-1')!;
  assert.deepEqual(r.removed, ['new/dir/made.txt']);
  assert.equal(read(root, 'keep.txt'), 'original');
  assert.equal(read(root, 'gone.txt'), 'will be deleted');
  assert.equal(fs.existsSync(path.join(root, 'new')), false);
  // used up
  assert.equal(restoreCheckpoint(root, 'msg-1'), null);
});

test('a write that did not change the file leaves no checkpoint behind', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, 'a.txt'), 'same');
  const cp = new Checkpoint(root, 'msg-2');
  cp.remember('a.txt');
  cp.remember('never.txt');
  cp.settle('a.txt');
  cp.settle('never.txt');
  assert.equal(cp.empty, true);
  cp.save();
  assert.equal(hasCheckpoint(root, 'msg-2'), false);
});

test('the changes card names the run it can undo', () => {
  const t = new ChangeTracker();
  t.track('write_file', { path: 'a.txt' }, 'File CREATED (новый файл): a.txt [Δ +1 −0]');
  assert.match(t.marker('msg-3'), /"run":"msg-3"/);
  assert.match(t.marker(), /^\n\n:::changes\n\[/);
});

test('a model that only reads is pushed to start working', () => {
  const guard = new LoopGuard(tmpProject());
  for (let i = 0; i < 14; i++) guard.after('read_file', { path: `f${i}.php` }, `c${i}`);
  assert.equal(guard.readNudge(), null);
  guard.after('read_file', { path: 'f14.php' }, 'c14');
  assert.match(guard.readNudge() ?? '', /start the actual change/);
  assert.equal(guard.readNudge(), null);
});
