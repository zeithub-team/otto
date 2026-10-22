// One headless Otto agent run on a folder: node scripts/agent-run.js <folder> <model> <prompt-file>
const fs = require('fs');
const { configureAppSettings } = require('../dist/server/appconfig');
const { generateResponse } = require('../dist/server/ollama');
const [root, model, promptFile] = process.argv.slice(2);
const settings = { 'app.agent.shell': 'auto', 'app.agent.web': 'false' };
configureAppSettings((k) => settings[k] ?? '');
(async () => {
  const t0 = Date.now();
  let req = 0, tools = 0, answer = '';
  for await (const raw of generateResponse({
    prompt: fs.readFileSync(promptFile, 'utf8'), messageId: 'audit', projectId: null, projectPath: root, model, useTools: true, useWeb: false, interactive: false,
    onUsage: () => { req++; },
    onToolEvent: (name, args, result) => { tools++; console.log(`TOOL ${name} ${JSON.stringify(args).slice(0, 120)} → ${String(result).replace(/\s+/g, ' ').slice(0, 120)}`); },
  })) {
    try { const c = JSON.parse(raw); if (c.role === 'assistant' && typeof c.content === 'string') answer = c.content; } catch { /* skip */ }
  }
  console.log(`DONE requests=${req} tools=${tools} seconds=${Math.round((Date.now() - t0) / 1000)}`);
  console.log(`ANSWER ${answer.replace(/\s+/g, ' ').slice(0, 600)}`);
  process.exit(0);
})();
