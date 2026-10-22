/**
 * Runs Otto's own agent loop (generateResponse) on the reliability scenarios and measures what
 * actually happened (Phase 13, 17.8). The verdict comes from the files on disk and the test run.
 *
 *   node dist/server/bench/run.js --models openrouter/poolside/laguna-s-2.1:free --scenarios all --reps 1
 *   node dist/server/bench/run.js --selfcheck        reference solutions must pass, empty ones fail
 *
 * Keys: OPENROUTER_API_KEY (and the usual <PROVIDER>_API_KEY variables). Commands run without asking
 * (agent.shell = auto) inside throw-away folders under the OS temp directory.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configureAppSettings } from '../appconfig';
import { configureProviders } from '../providers';
import { generateResponse } from '../ollama';
import type { HarnessProfile } from '../harness';
import { SCENARIOS, materialize, tampered, type Scenario } from './scenarios';

export interface RunMetrics {
  scenario: string;
  steps: number;
  model: string;
  rep: number;
  ok: boolean;
  detail: string;
  /** The final answer says the work is done/fixed/passing, but the verifier disagrees. */
  falseClaim: boolean;
  tamperedTests: string[];
  modelRequests: number;
  toolCalls: number;
  /** Same tool with the same arguments again (after the first). */
  duplicateCalls: number;
  failedTools: number;
  peakContext: number;
  /** Otto switched to another model during the run (the result is not this model's alone). */
  switchedTo: string[];
  /** The model never answered (rate limit, provider down): not a verdict on the model. */
  infra: boolean;
  /** What happened, for the harness editor: tool calls (trimmed) and the final answer. */
  trace: string[];
  error: string;
  ms: number;
}

const CLAIM = /(готов|сделан|исправ|проход|выполн|успешн|работает|passed|passing|done|fixed|complete|all tests)/i;
const TOOL_FAIL = /^(error|ошибка|tool failed|failed|не удалось|exit code: [1-9])|exit code: [1-9]|\bENOENT\b|SyntaxError/i;

export async function runOnce(s: Scenario, model: string, rep: number, keepDir = false, harness?: HarnessProfile | null): Promise<RunMetrics> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `otto-bench-${s.id}-`));
  materialize(s, root);
  const m: RunMetrics = {
    scenario: s.id, steps: s.steps, model, rep, ok: false, detail: '', falseClaim: false, tamperedTests: [],
    modelRequests: 0, toolCalls: 0, duplicateCalls: 0, failedTools: 0, peakContext: 0, switchedTo: [], infra: false, trace: [], error: '', ms: 0,
  };
  const seen = new Set<string>();
  let answer = '';
  const t0 = Date.now();
  try {
    for await (const raw of generateResponse({
      prompt: s.prompt,
      messageId: `bench-${s.id}-${rep}`,
      projectId: null,
      projectPath: root,
      model,
      useTools: true,
      useWeb: false,
      interactive: false,
      ...(harness !== undefined ? { harness } : {}),
      onUsage: (u) => { m.modelRequests++; m.peakContext = Math.max(m.peakContext, u.used); },
      onModelSwitch: (to) => { m.switchedTo.push(to); },
      onToolEvent: (name, args, result) => {
        m.toolCalls++;
        const sig = `${name}:${JSON.stringify(args)}`;
        if (seen.has(sig)) m.duplicateCalls++;
        seen.add(sig);
        if (TOOL_FAIL.test(String(result).trim().slice(0, 400))) m.failedTools++;
        m.trace.push(`${name}(${JSON.stringify(args).slice(0, 160)}) → ${String(result).replace(/s+/g, ' ').slice(0, 220)}`);
      },
    })) {
      let c: Record<string, unknown>;
      try { c = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
      if (c.role === 'assistant' && typeof c.content === 'string') answer = c.content;
      if (c.role === 'system' && c.isError) m.error = String(c.content ?? '').slice(0, 300);
    }
  } catch (exc) {
    m.error = exc instanceof Error ? exc.message : String(exc);
  }
  m.ms = Date.now() - t0;
  m.trace.push(`FINAL ANSWER: ${answer.replace(/s+/g, ' ').slice(0, 300)}`);
  const v = s.verify(root, answer);
  m.tamperedTests = tampered(s, root);
  m.ok = v.ok && m.tamperedTests.length === 0;
  m.detail = v.detail + (m.tamperedTests.length ? `; tests changed: ${m.tamperedTests.join(', ')}` : '');
  m.falseClaim = !m.ok && s.steps > 1 && CLAIM.test(answer);
  if (!keepDir) fs.rmSync(root, { recursive: true, force: true });
  else m.detail += ` (dir ${root})`;
  return m;
}

/** A run where the model never answered is retried after a pause (free models are often rate-limited upstream). */
export async function runOne(s: Scenario, model: string, rep: number, keepDir = false, harness?: HarnessProfile | null): Promise<RunMetrics> {
  let r = await runOnce(s, model, rep, keepDir, harness);
  for (let i = 0; i < 3 && r.modelRequests === 0; i++) {
    await new Promise((res) => setTimeout(res, 45_000));
    r = await runOnce(s, model, rep, keepDir, harness);
  }
  r.infra = r.modelRequests === 0;
  return r;
}

/** Aggregate per model: success rate and the reliability counters. */
export function summarize(rows: RunMetrics[]): string {
  const by = new Map<string, RunMetrics[]>();
  for (const r of rows) by.set(r.model, [...(by.get(r.model) ?? []), r]);
  const lines = ['| model | success | false «done» | tests changed | requests | tool calls | duplicates | failed tools | switched | avg s |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const [model, all] of by) {
    const rs = all.filter((r) => !r.infra);
    if (!rs.length) { lines.push(`| ${model} | no answers (rate-limited) | | | | | | | | |`); continue; }
    const sum = (f: (r: RunMetrics) => number) => rs.reduce((a, r) => a + f(r), 0);
    lines.push(`| ${model} | ${sum((r) => +r.ok)}/${rs.length} | ${sum((r) => +r.falseClaim)} | ${sum((r) => +(r.tamperedTests.length > 0))} | ${sum((r) => r.modelRequests)} | ${sum((r) => r.toolCalls)} | ${sum((r) => r.duplicateCalls)} | ${sum((r) => r.failedTools)} | ${sum((r) => +(r.switchedTo.length > 0))} | ${Math.round(sum((r) => r.ms) / rs.length / 1000)} |`);
  }
  lines.push('', '| scenario | model | rep | ok | detail | req | tools | dup | error |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) lines.push(`| ${r.scenario} | ${r.model} | ${r.rep} | ${r.infra ? '—' : r.ok ? '✔' : '✖'} | ${r.detail.replace(/\|/g, '/')} | ${r.modelRequests} | ${r.toolCalls} | ${r.duplicateCalls} | ${r.error.replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 80)} |`);
  return lines.join('\n');
}

// ------------------------------------------------------------- selfcheck --

/** Reference solutions: every scenario must be solvable, and the untouched workspace must fail. */
const REFERENCE: Record<string, Record<string, string>> = {
  's03-module': { 'src/math.js': 'module.exports = { add: (a, b) => a + b, multiply: (a, b) => a * b };\n' },
  's05-bugfix': { 'src/cart.js': 'function total(items){let s=0;for(const i of items)s+=i.price*(i.qty??1);return Math.round(s*100)/100}\nfunction applyDiscount(a,p){return Math.round(a*(1-p/100)*100)/100}\nmodule.exports={total,applyDiscount};\n' },
  's10-rename': {
    'src/format.js': "function formatMoney(value, currency = 'USD') { return value.toFixed(2) + ' ' + currency; }\nmodule.exports = { formatMoney };\n",
    'src/invoice.js': "const { formatMoney } = require('./format');\nmodule.exports = { invoiceLine: (n, v) => `${n}: ${formatMoney(v)}` };\n",
    'src/report.js': "const { formatMoney } = require('./format');\nmodule.exports = { summary: (lines, c) => 'Total ' + formatMoney(lines.reduce((s, l) => s + l.value, 0), c) };\n",
  },
  's20-todo': {
    'src/store.js': "const fs=require('fs');module.exports={load:(f)=>fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[],save:(f,i)=>fs.writeFileSync(f,JSON.stringify(i,null,2))};\n",
    'src/todo.js': "const add=(it,t)=>[...it,{id:Math.max(0,...it.map(i=>i.id))+1,title:t,done:false}];const complete=(it,id)=>it.map(i=>i.id===id?{...i,done:true}:i);const remove=(it,id)=>it.filter(i=>i.id!==id);const list=(it)=>it.map(i=>`[${i.done?'x':' '}] ${i.id} ${i.title}`);module.exports={add,complete,remove,list};\n",
    'src/cli.js': "const path=require('path');const s=require('./store');const t=require('./todo');const f=path.join(process.cwd(),'todos.json');const [c,...a]=process.argv.slice(2);let it=s.load(f);if(c==='add')it=t.add(it,a.join(' '));else if(c==='done')it=t.complete(it,Number(a[0]));else if(c==='rm')it=t.remove(it,Number(a[0]));else console.log(t.list(it).join('\\n'));s.save(f,it);\n",
    'README.md': '# Todo\n\n## Использование\n\n    node src/cli.js add Купить хлеб\n    node src/cli.js list\n',
  },
};

export function selfcheck(): string[] {
  const problems: string[] = [];
  for (const s of SCENARIOS) {
    if (s.id === 's01-answer') {
      if (!s.verify('', 'Порт 4817.').ok || s.verify('', '3000').ok) problems.push(`${s.id}: verifier wrong`);
      continue;
    }
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-bench-check-'));
    materialize(s, empty);
    if (s.verify(empty, 'Готово').ok) problems.push(`${s.id}: passes without any work`);
    const solved = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-bench-check-'));
    materialize(s, solved);
    for (const [rel, text] of Object.entries(REFERENCE[s.id] ?? {})) { fs.mkdirSync(path.dirname(path.join(solved, rel)), { recursive: true }); fs.writeFileSync(path.join(solved, rel), text); }
    const v = s.verify(solved, '');
    if (!v.ok) problems.push(`${s.id}: reference solution fails (${v.detail})`);
    for (const d of [empty, solved]) fs.rmSync(d, { recursive: true, force: true });
  }
  return problems;
}

// ------------------------------------------------------------------- cli --

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? '' : fallback;
}

async function main(): Promise<void> {
  if (process.argv.includes('--selfcheck')) {
    const p = selfcheck();
    console.log(p.length ? `✖ ${p.join('\n✖ ')}` : '✔ every scenario: reference passes, untouched workspace fails');
    process.exit(p.length ? 1 : 0);
  }
  const settings: Record<string, string> = { 'app.agent.shell': 'auto', 'app.agent.web': 'false', ...JSON.parse(process.env.OTTO_BENCH_SETTINGS ?? '{}') };
  configureAppSettings((k) => settings[k] ?? '');
  configureProviders({ getSetting: () => '' }); // keys come from <PROVIDER>_API_KEY
  process.env.OLLAMA_URL ??= 'http://127.0.0.1:9'; // no local fallback during a measurement

  const models = arg('models').split(',').filter(Boolean);
  const wanted = arg('scenarios', 'all');
  const list = SCENARIOS.filter((s) => wanted === 'all' || wanted.split(',').includes(s.id) || wanted.split(',').includes(String(s.steps)));
  const reps = Number(arg('reps', '1')) || 1;
  const out = arg('out', path.join(process.cwd(), 'bench-results'));
  if (!models.length || !list.length) { console.error('Usage: --models a,b --scenarios all|1,3,5|s05-bugfix --reps N --out dir'); process.exit(1); }
  fs.mkdirSync(out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rows: RunMetrics[] = [];
  for (const model of models) {
    for (const s of list) {
      for (let rep = 1; rep <= reps; rep++) {
        process.stdout.write(`${model}  ${s.id}  #${rep} … `);
        const r = await runOne(s, model, rep, process.argv.includes('--keep'));
        rows.push(r);
        console.log(`${r.infra ? 'NO ANSWER (rate-limited)' : r.ok ? 'ok' : 'FAIL'}  ${r.detail}  req=${r.modelRequests} tools=${r.toolCalls} dup=${r.duplicateCalls}${r.switchedTo.length ? ` switched→${r.switchedTo.join(',')}` : ''}${r.error ? `  error: ${r.error.slice(0, 120)}` : ''}`);
        fs.writeFileSync(path.join(out, `${stamp}.json`), JSON.stringify(rows, null, 2));
      }
    }
  }
  const md = summarize(rows);
  fs.writeFileSync(path.join(out, `${stamp}.md`), md + '\n');
  console.log(`\n${md}\n\nSaved: ${path.join(out, `${stamp}.md`)}`);
}

if (require.main === module) void main();
