import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTool } from '../ollama';
import { syntaxProblems, vetWrite } from '../codecheck';
import { EditSession, isFailure, LoopGuard, madeProgress, STEP_HARD_CAP, stepBudget } from '../runguard';
import { Checkpoint, hasCheckpoint, restoreCheckpoint } from '../checkpoints';
import { ChangeTracker } from '../changes';
import { decodeTextFile, isProtectedFile, stubNote } from '../workspacetools';
import { configureSkills, enabledSkills, pickSkills } from '../skills';
import { modelProfile, shouldUseGuided, recommendedContext, recommendedTemperature } from '../modelcaps';
import { commandExitCode, compactMessages, ChatMessage, sameCheck, taskStateNote } from '../context';
import { onlyCommands, pastedCode } from '../ollama';
import { describeResult, runCommand } from '../shell';

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

// --------------------------------------------------------- protected files --

test('critical project files cannot be deleted by the agent', () => {
  assert.match(isProtectedFile('.env') ?? '', /environment/);
  assert.match(isProtectedFile('composer.json') ?? '', /Composer/);
  assert.match(isProtectedFile('package.json') ?? '', /npm/);
  assert.match(isProtectedFile('Gemfile') ?? '', /Bundler/);
  assert.match(isProtectedFile('go.mod') ?? '', /Go/);
  assert.match(isProtectedFile('Cargo.toml') ?? '', /Rust/);
  assert.match(isProtectedFile('Dockerfile') ?? '', /Docker/);
  assert.match(isProtectedFile('.gitignore') ?? '', /Git/);
  assert.equal(isProtectedFile('src/app.ts'), null);
  assert.equal(isProtectedFile('README.md'), null);
  assert.equal(isProtectedFile('database/migrations/001.php'), null);
});

test('delete_file refuses to delete a protected file', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, '.env'), 'APP_KEY=test');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  assert.match(runTool(root, 'delete_file', { path: '.env' }), /^REJECTED/);
  assert.equal(fs.existsSync(path.join(root, '.env')), true);
  assert.match(runTool(root, 'delete_file', { path: 'package.json' }), /^REJECTED/);
  assert.equal(fs.existsSync(path.join(root, 'package.json')), true);
  // but a regular file can still be deleted
  fs.writeFileSync(path.join(root, 'tmp.txt'), 'hello');
  assert.match(runTool(root, 'delete_file', { path: 'tmp.txt' }), /^Deleted/);
  assert.equal(fs.existsSync(path.join(root, 'tmp.txt')), false);
});

// ------------------------------------------------------------ model caps --

test('model capability registry returns correct profiles for known families', () => {
  const tiel = modelProfile('hf.co/peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF:UD-IQ4_XS');
  assert.equal(tiel.family, 'tiel');
  assert.equal(tiel.nativeTools, true);

  const qwen25 = modelProfile('qwen2.5-coder:14b');
  assert.equal(qwen25.family, 'qwen2.5-coder');
  assert.equal(qwen25.nativeTools, false); // guided mode

  const qwen3 = modelProfile('qwen3.5:9b');
  assert.equal(qwen3.family, 'qwen3-coder');
  assert.equal(qwen3.nativeTools, true); // native tools

  const gemma = modelProfile('gemma4:12b');
  assert.equal(gemma.family, 'gemma4');
  assert.equal(gemma.nativeTools, true);

  const deepseek = modelProfile('deepseek-r1:8b');
  assert.equal(deepseek.family, 'deepseek-r1');
  assert.equal(deepseek.nativeTools, false);

  const unknown = modelProfile('some-random-model:7b');
  assert.equal(unknown.family, 'unknown');
  assert.equal(unknown.nativeTools, false); // conservative default
});

test('shouldUseGuided respects user override and model capability', () => {
  // User forces guided
  assert.equal(shouldUseGuided('qwen3.5:9b', 'guided'), true);
  // User forces native
  assert.equal(shouldUseGuided('qwen2.5-coder:14b', 'native'), false);
  // Auto: qwen2.5-coder → guided (no native tools)
  assert.equal(shouldUseGuided('qwen2.5-coder:14b', 'auto'), true);
  // Auto: qwen3.5 → native (has native tools)
  assert.equal(shouldUseGuided('qwen3.5:9b', 'auto'), false);
  // Auto: Tiel → native
  assert.equal(shouldUseGuided('hf.co/peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF:UD-IQ4_XS', 'auto'), false);
  // Cloud models always native
  assert.equal(shouldUseGuided('kimi-k3:cloud', 'auto'), false);
});

test('compaction preserves first line and errors from tool results', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'tool', content: 'File overwritten: src/app.ts (2400 bytes)\n' + 'x'.repeat(2000), tool_name: 'write_file' },
    { role: 'tool', content: 'REJECTED: .env is a critical project file\nError: cannot delete protected file\n' + 'y'.repeat(2000), tool_name: 'delete_file' },
    { role: 'user', content: 'continue' },
  ];
  const shrunk = compactMessages(msgs, 500, 1, 0.1);
  assert.ok(shrunk >= 2);
  assert.match(msgs[1].content, /File overwritten: src\/app\.ts/);
  assert.match(msgs[2].content, /REJECTED/);
  assert.match(msgs[2].content, /cannot delete protected file/);
});

test('stopping a run kills the running command and says so', async () => {
  const stop = new AbortController();
  const cmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
  const started = Date.now();
  const pending = runCommand(tmpProject(), cmd, 60, stop.signal);
  setTimeout(() => stop.abort(), 1500);
  const r = await pending;
  assert.equal(r.cancelled, true);
  assert.ok(Date.now() - started < 15_000, 'the command must end soon after the stop');
  assert.match(describeResult(cmd, r), /cancelled by the user/);
  assert.equal(commandExitCode(describeResult(cmd, r)), null);
});

test('exit codes and the task state note come from tool results', () => {
  assert.equal(commandExitCode('$ php artisan test\n(exit code 1, 4.2 s)\nFAIL'), 1);
  assert.equal(commandExitCode('$ npm test\n(exit code 0, 1 s)\nok'), 0);
  assert.equal(commandExitCode('$ x\n(stopped: time limit reached, 120 s)\n'), null);
  const note = taskStateNote('Сделай каталог книг', [{ path: 'app/Models/Book.php', action: 'created' }], { command: 'php artisan test', output: 'FAILED BookTest' });
  assert.match(note, /каталог книг/);
  assert.match(note, /app\/Models\/Book\.php \(created\)/);
  assert.match(note, /php artisan test/);
  assert.match(note, /FAILED BookTest/);
  assert.match(taskStateNote('t', [], null), /Файлы ещё не менялись/);
});

test('compaction drops written file bodies instead of leaving a copyable placeholder', () => {
  const body = 'x'.repeat(3000);
  const call = { function: { name: 'write_file', arguments: { path: 'a.php', content: body } } };
  const msgs: ChatMessage[] = [
    { role: 'system', content: 's' },
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', content: 'File CREATED: a.php', tool_name: 'write_file' },
    { role: 'user', content: 'go on' },
  ];
  compactMessages(msgs, 500, 1, 0.1);
  const args = call.function.arguments as Record<string, unknown>;
  assert.equal('content' in args, false);
  assert.equal(args.omitted_content_chars, 3000);
  assert.equal(args.path, 'a.php');
});

test('a run that keeps changing files is not cut off at the step limit, an idle one is', () => {
  assert.equal(madeProgress('write_file', 'File CREATED (новый файл): src/a.ts'), true);
  assert.equal(madeProgress('write_file', 'REJECTED: syntax error'), false);
  assert.equal(madeProgress('read_file', 'export const a = 1;'), false);
  assert.equal(madeProgress('run_command', '$ npm test\n(exit code 0, 2 s)\nok'), true);
  assert.equal(madeProgress('run_command', '$ npm test\n(exit code 1, 2 s)\nFAIL'), false);
  // looking around is not progress, even when it succeeds
  assert.equal(madeProgress('run_command', '$ Get-ChildItem -Recurse -Path dist -Filter "seed.js"\n(exit code 0, 1 s)\n…'), false);
  assert.equal(madeProgress('run_command', '$ $src = Get-Content node_modules\\typeorm\\x.js; …\n(exit code 0, 1 s)\n…'), false);
  assert.equal(madeProgress('run_command', '$ Select-String -Path dist/seed.js -Pattern "entities"\n(exit code 0, 1 s)\n'), false);
  assert.equal(madeProgress('run_command', '$ npm install\n(exit code 0, 30 s)\nadded 500 packages'), true);
  // mid-run: nothing changes
  assert.equal(stepBudget(10, 40, 40, 9), 40);
  // last step of the budget, wrote a file 2 steps ago: 40 more
  assert.equal(stepBudget(39, 40, 40, 37), 80);
  // last step, but only reads for the last 10 steps: stop
  assert.equal(stepBudget(39, 40, 40, 29), 40);
  assert.equal(stepBudget(39, 40, 40, -1), 40);
  // never beyond the hard cap
  assert.equal(stepBudget(279, 280, 40, 278), STEP_HARD_CAP);
  assert.equal(stepBudget(STEP_HARD_CAP - 1, STEP_HARD_CAP, 40, STEP_HARD_CAP - 2), STEP_HARD_CAP);
});

test('read_file reads a UTF-16 log written by PowerShell, still refuses binary', () => {
  const root = tmpProject();
  const text = 'src/app.module.ts(5,31): error TS2307: Не найден модуль';
  fs.writeFileSync(path.join(root, 'errors.log'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  assert.match(runTool(root, 'read_file', { path: 'errors.log' }), /TS2307: Не найден модуль/);
  assert.equal(decodeTextFile(Buffer.from('привет', 'utf8')), 'привет');
  assert.throws(() => decodeTextFile(Buffer.from([0xc3, 0x28, 0x00, 0x9f])));
});

test('a file under a folder named like the project is refused: the model is already in the root', () => {
  const root = path.join(tmpProject(), 'stranica');
  fs.mkdirSync(root);
  const r = runTool(root, 'write_file', { path: 'stranica/src/main.ts', content: 'export const a = 1;\n' });
  assert.match(r, /^REJECTED: you are already inside the project folder "stranica"/);
  assert.match(r, /"src\/main\.ts"/);
  assert.equal(fs.existsSync(path.join(root, 'stranica')), false);
  // a real subfolder with that name, or the right path, are fine
  assert.match(runTool(root, 'write_file', { path: 'src/main.ts', content: 'export const a = 1;\n' }), /^File CREATED/);
  fs.mkdirSync(path.join(root, 'stranica'));
  assert.match(runTool(root, 'write_file', { path: 'stranica/x.ts', content: 'export const b = 2;\n' }), /^File CREATED/);
});

test('an empty controller or service is reported as a stub, a real one and a NestJS module are not', () => {
  assert.match(stubNote('src/cart/cart.controller.ts', "import { Controller } from '@nestjs/common';\n@Controller('cart')\nexport class CartController {}\n"), /only a stub \(an empty class\)/);
  assert.match(stubNote('app/Http/Controllers/BookController.php', '<?php\nclass BookController extends Controller\n{\n    // TODO\n}\n'), /stub/);
  assert.equal(stubNote('src/books/books.module.ts', "@Module({ imports: [TypeOrmModule.forFeature([Book])], providers: [BooksService] })\nexport class BooksModule {}\n"), '');
  const real = "@Injectable()\nexport class BooksService {\n  constructor(@InjectRepository(Book) private readonly books: Repository<Book>) {}\n  findAll() {\n    return this.books.find();\n  }\n  findOne(id: number) {\n    return this.books.findOne({ where: { id } });\n  }\n}\n";
  assert.equal(stubNote('src/books/books.service.ts', real), '');
  assert.equal(stubNote('src/books/dto/create-book.dto.ts', 'export class CreateBookDto {}'), '');
  // the note reaches the model in the write result
  const root = tmpProject();
  assert.match(runTool(root, 'write_file', { path: 'src/cart/cart.controller.ts', content: 'export class CartController {}\n' }), /NOTE: src\/cart\/cart\.controller\.ts is only a stub/);
});

test('a model that only reads is pushed four times, then stopped', () => {
  const guard = new LoopGuard(tmpProject());
  let pushes = 0;
  for (let i = 0; i < 80 && !guard.stopReason; i++) {
    guard.after('read_file', { path: `f${i}.ts` }, `c${i}`);
    if (guard.readNudge()) pushes++;
  }
  assert.equal(pushes, 4);
  assert.match(guard.stopReason ?? '', /reads in a row without a single change/);
});

test('the frameworks a request names get their skills first', () => {
  configureSkills({ getSetting: () => '' });
  const on = enabledSkills(null);
  const names = (p: string) => pickSkills(on, p).map((s) => s.name);
  const nest = names('Собери на NestJS + PostgreSQL, TypeORM, Docker compose, тесты, сайт по концепту');
  assert.deepEqual([...nest].sort(), ['docker-compose', 'nestjs', 'postgres']);
  const lara = names('Создай проект на Laravel про книги, SQLite, миграции и сидеры, страницы на Blade');
  assert.equal(lara[0], 'laravel');
  assert.ok(!lara.includes('postgres'));
  // no framework named: two general skills, no stack ones
  const site = pickSkills(on, 'Сделай лендинг кофейни, адаптив под телефон');
  assert.equal(site.length, 2);
  assert.ok(site.every((s) => !s.stack));
  assert.ok(site.some((s) => s.name === 'responsive-mobile'));
});

test('a plan step gets the skills of its own job within the project stack', () => {
  configureSkills({ getSetting: () => '' });
  const on = enabledSkills(null);
  const goal = 'Книжный магазин на NestJS + TypeORM + PostgreSQL, Docker compose, сайт по концепту';
  const pick = (step: string) => pickSkills(on, goal, step).map((s) => s.name);
  assert.deepEqual(pick('[Бэкенд] Сервис книг: поиск и пагинация'), ['nestjs'], 'nothing named: the main framework');
  assert.deepEqual(pick('[Docker] Dockerfile и docker-compose.yml — проверка: docker compose config'), ['docker-compose']);
  assert.ok(pick('[Данные] Миграции и сид для PostgreSQL').includes('postgres'));
  assert.ok(pick('[Фронтенд] Вёрстка каталога: html, адаптив').every((n) => n !== 'docker-compose' && n !== 'postgres'));
  assert.ok(pick('[Бэкенд] Модуль книг TypeORM').length <= 2);
});

test('a failed check is cleared only by the same kind of check passing', () => {
  assert.equal(sameCheck('php artisan test', 'php artisan test'), true);
  assert.equal(sameCheck('php artisan test', 'php artisan test --filter=BookTest'), true);
  assert.equal(sameCheck('php artisan test', 'php artisan key:generate --force'), false);
  assert.equal(sameCheck('npm run build', 'npm run lint'), false);
  assert.equal(sameCheck('php artisan migrate', 'php artisan migrate:fresh --seed'), true);
});

test('run instructions in an answer are not mistaken for pasted code', () => {
  const howTo = 'cd bookshelf\ncomposer install\ncp .env.example .env\nphp artisan key:generate\nphp artisan migrate --seed\nphp artisan serve\n# открой http://127.0.0.1:8000';
  assert.equal(onlyCommands(howTo), true);
  assert.equal(pastedCode('Запуск:\n```\n' + howTo + '\n```'), false);
  assert.equal(pastedCode('```php\n<?php\nclass Book extends Model\n{\n  protected $fillable = [];\n}\n```'), true);
});

test('recommended context and temperature vary by model', () => {
  assert.equal(recommendedContext('qwen2.5-coder:14b'), 32768);
  assert.equal(recommendedContext('some-tiny:1b'), 4096); // tiny model gets capped context
  assert.ok(recommendedTemperature('qwen2.5-coder:14b', true) <= 0.3);
  assert.ok(recommendedTemperature('qwen3.5:9b', true) >= 0.3);
  // Chat (tools off) is warmer
  assert.ok(recommendedTemperature('qwen2.5-coder:14b', false) > recommendedTemperature('qwen2.5-coder:14b', true));
});
