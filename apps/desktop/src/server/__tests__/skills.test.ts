import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { allSkills, configureSkills, enabledSkills, matchSkills, parseSkill, skillsPrompt } from '../skills';

test('parseSkill reads frontmatter and body', () => {
  const s = parseSkill('---\nname: demo\ndescription: d\ntriggers: Лендинг, css\n---\nBODY', 'x', 'user');
  assert.equal(s?.name, 'demo');
  assert.deepEqual(s?.triggers, ['лендинг', 'css']);
  assert.equal(s?.body, 'BODY');
  assert.equal(parseSkill('---\nname: e\n---\n', 'x', 'user'), null);
  assert.equal(parseSkill('body only', '../bad', 'user'), null);
});

test('built-in web-design and verify-ui skills ship with the app', () => {
  configureSkills({ getSetting: () => '', userDir: '' });
  const names = allSkills().map((s) => s.name);
  for (const name of ['web-design', 'verify-ui', 'ux-design', 'accessibility', 'ux-copy', 'responsive-mobile', 'code-review', 'testing', 'security-review', 'git-commits']) {
    assert.ok(names.includes(name), `built-in skill ${name} is missing`);
  }
});

test('matching skills are injected, others are listed; project skills override; disabled are hidden', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-skill-'));
  const dir = path.join(root, '.otto', 'skills', 'web-design');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\ndescription: custom\ntriggers: лендинг\n---\nPROJECT RULES');

  const other = path.join(root, '.otto', 'skills', 'other');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'SKILL.md'), '---\ndescription: manual only\n---\nOTHER');

  configureSkills({ getSetting: () => '', userDir: '' });
  const skills = enabledSkills(root);
  assert.equal(skills.find((s) => s.name === 'web-design')?.source, 'project');
  const prompt = skillsPrompt(skills, 'сделай лендинг про котят');
  assert.match(prompt, /PROJECT RULES/);
  assert.match(prompt, /use_skill\(name\)[\s\S]*other: manual only/);
  assert.ok(!prompt.includes('OTHER'));
  assert.equal(matchSkills(skills, 'привет').length, 0);

  configureSkills({ getSetting: (k) => (k === 'skills_disabled' ? 'web-design' : '') });
  assert.ok(!enabledSkills(root).some((s) => s.name === 'web-design'));
  configureSkills({ getSetting: () => '' });
});

test('only the two best matching skills are injected; the others are listed for use_skill', () => {
  configureSkills({ getSetting: () => '', userDir: '' });
  const skills = enabledSkills();
  // a request that touches many skills at once
  const prompt = 'сделай адаптивный мобильный лендинг с ux, доступностью a11y и проверь безопасность, ревью кода и тесты';
  const prompt2 = skillsPrompt(skills, prompt);
  const injected = (prompt2.match(/=== НАВЫК «/g) ?? []).length;
  assert.equal(injected, 2);
  assert.match(prompt2, /ДОСТУПНЫЕ НАВЫКИ/);
  assert.ok(matchSkills(skills, prompt).length > 2);
});

test('each built-in skill has a description and trigger words', () => {
  configureSkills({ getSetting: () => '', userDir: '' });
  // Otto's own skills (the official Anthropic ones come with their own descriptions and fewer trigger words)
  for (const skill of allSkills().filter((s) => s.source === 'builtin' && !s.official)) {
    assert.ok(skill.description.length > 20, `${skill.name}: description`);
    assert.ok(skill.triggers.length >= 3, `${skill.name}: triggers`);
    assert.ok(skill.body.length > 500, `${skill.name}: body`);
  }
});
