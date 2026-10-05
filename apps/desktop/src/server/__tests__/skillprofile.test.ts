import test from 'node:test';
import assert from 'node:assert/strict';
import { configureSkills, disabledSkills, profileDisabled, profileKey } from '../skills';

test('a project + model profile overrides the global skill choice; without one the global choice applies', () => {
  const store = new Map<string, string>([
    ['skills_disabled', 'testing,git-commits'],
    ['skills_profile:7:claude-cli/sonnet', JSON.stringify({ disabled: ['web-design'] })],
  ]);
  configureSkills({ getSetting: (k) => store.get(k) ?? '' });

  assert.equal(profileKey(7, 'claude-cli/sonnet'), 'skills_profile:7:claude-cli/sonnet');
  assert.equal(profileKey(null, 'x'), null);
  assert.equal(profileKey(7, null), null);

  assert.deepEqual([...disabledSkills(profileKey(7, 'claude-cli/sonnet'))], ['web-design']);
  assert.deepEqual([...disabledSkills(profileKey(7, 'qwen2.5-coder:14b'))].sort(), ['git-commits', 'testing'], 'no profile: global');
  assert.deepEqual([...disabledSkills()].sort(), ['git-commits', 'testing']);
  assert.equal(profileDisabled(profileKey(8, 'claude-cli/sonnet')), null, 'profiles are per project');

  store.set('skills_profile:7:claude-cli/sonnet', ''); // reset to the global choice
  assert.deepEqual([...disabledSkills(profileKey(7, 'claude-cli/sonnet'))].sort(), ['git-commits', 'testing']);
  configureSkills({ getSetting: () => '' });
});

import { allSkills, parseSkill } from '../skills';

test('YAML block descriptions (as in the Anthropic skills) and categories are read', () => {
  const s = parseSkill('---\nname: demo\ndescription: >\n  First line\n  second line.\ncategory: media\n---\nBody', 'demo', 'user')!;
  assert.equal(s.description, 'First line second line.');
  assert.equal(s.category, 'media');
  const lit = parseSkill('---\nname: demo2\ndescription: |-\n  a\n  b\n---\nBody', 'demo2', 'user')!;
  assert.equal(lit.description, 'a\nb');
  const quoted = parseSkill('---\nname: q\ndescription: "Use this when x"\n---\nBody', 'q', 'user')!;
  assert.equal(quoted.description, 'Use this when x');
});

test('the shipped skills: Otto\'s own and the official Anthropic ones, each with a category', () => {
  const all = allSkills();
  const names = all.map((s) => s.name);
  for (const n of ['web-design', 'frontend-design', 'mcp-builder', 'webapp-testing', 'skill-creator']) assert.ok(names.includes(n), n);
  for (const n of ['docx', 'pdf', 'pptx', 'xlsx']) assert.ok(!names.includes(n), `${n} must not be shipped (not open source)`);
  assert.ok(all.filter((s) => s.official).length >= 14);
  assert.ok(all.filter((s) => s.source !== 'library').every((s) => s.category !== 'other'));
  assert.ok(all.filter((s) => s.source === 'library').length >= 300, 'the Anthropic / OpenAI library is shipped');
  assert.ok(all.every((s) => s.description && !/^[>|]/.test(s.description)), 'no raw YAML markers in descriptions');
});
