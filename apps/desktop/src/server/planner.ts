/**
 * Planner + coder: a light "architect" model thinks the work through first (files, design, texts,
 * logic) and the model of the chat only carries the plan out. The plan is constrained by a JSON schema,
 * so even a small planner returns a usable plan; the coder then needs no imagination of its own.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface BuildPlan {
  summary: string;
  design: { style: string; palette: Record<string, string>; fonts: string };
  files: Array<{ path: string; role: string; spec: string }>;
  checklist: string[];
}

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    design: {
      type: 'object',
      properties: {
        style: { type: 'string' },
        palette: { type: 'object', properties: { bg: { type: 'string' }, surface: { type: 'string' }, text: { type: 'string' }, primary: { type: 'string' }, accent: { type: 'string' }, dark: { type: 'string' } }, required: ['bg', 'text', 'primary', 'dark'] },
        fonts: { type: 'string' },
      },
      required: ['style', 'palette', 'fonts'],
    },
    files: {
      type: 'array',
      items: { type: 'object', properties: { path: { type: 'string' }, role: { type: 'string' }, spec: { type: 'string' } }, required: ['path', 'role', 'spec'] },
    },
    checklist: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'design', 'files', 'checklist'],
};

const PROMPT = [
  'You are the architect of a small coding agent inside the IDE zeithub.otto. You do NOT write code.',
  'You write a precise build plan that a weak coder model will follow literally, file by file.',
  'For every file to create or change give a spec detailed enough to need no imagination:',
  '- HTML: every block in order with its tag and classes (kit classes: nav, container, logo, hero, btn, section, section alt, section-title, section-subtitle, grid, card, price, quote, author, form, field, error, success, footer), and the REAL texts: headings, menu items with prices, reviews with names, address, phone, button labels.',
  '- CSS: the palette (hex), fonts, and what to add on top of the design kit (it already styles the kit classes).',
  '- JS: each behaviour step by step (which element, which event, what is checked, what text is shown where).',
  'Keep what already exists in the project unless the request changes it. Write the texts in the language of the request.',
  'Answer with the JSON object only.',
].join('\n');

/** The few lines of each existing page / style / script the planner should keep consistent with. */
function projectExcerpt(root: string): string {
  const out: string[] = [];
  for (const f of ['index.html', 'style.css', 'script.js']) {
    try {
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      out.push(`--- ${f} (${text.length} chars)\n${text.slice(0, 1800)}`);
    } catch { /* not there */ }
  }
  return out.join('\n');
}

/** Ask `model` (an Ollama model) for the plan of `request`; null when it fails or times out. */
export async function makePlan(
  baseUrl: string,
  model: string,
  request: string,
  root: string,
  history: Array<{ role: string; content: string }>,
  timeoutMs = 300_000,
): Promise<BuildPlan | null> {
  const earlier = history.filter((m) => m.role === 'user').slice(-4).map((m) => `- ${m.content.slice(0, 400)}`).join('\n');
  const user = [
    `Request: ${request}`,
    earlier ? `Earlier requests in this chat:\n${earlier}` : '',
    `Project files now:\n${projectExcerpt(root) || '(empty project)'}`,
  ].filter(Boolean).join('\n\n');
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, format: SCHEMA,
        options: { temperature: 0.3, num_ctx: 16384, num_predict: 6000 },
        messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json() as { message?: { content?: string } };
    const plan = JSON.parse(data.message?.content ?? '') as BuildPlan;
    return Array.isArray(plan.files) && plan.files.length ? plan : null;
  } catch {
    return null;
  }
}

/** The plan as the coder reads it (and as it is shown in the chat). */
export function planText(plan: BuildPlan): string {
  const pal = Object.entries(plan.design.palette ?? {}).map(([k, v]) => `--${k}: ${v}`).join('; ');
  return [
    `PLAN — ${plan.summary}`,
    `Design: ${plan.design.style}. Palette: ${pal}. Fonts: ${plan.design.fonts}.`,
    ...plan.files.map((f, i) => `${i + 1}. ${f.path} — ${f.role}\n${f.spec}`),
    plan.checklist.length ? `Checklist:\n${plan.checklist.map((c) => `- ${c}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

/** Requests worth planning: building or changing something, not a question or an app command. */
export const wantsPlan = (prompt: string): boolean =>
  /(созда|сдела|добав|напиш|сгенер|постро|переделай|измени|create|build|make|add|generate|write|redesign)/i.test(prompt) &&
  !/^(что|как|почему|what|how|why)(?![а-яёa-z])/i.test(prompt.trim());
