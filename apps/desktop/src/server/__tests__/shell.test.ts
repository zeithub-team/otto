import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dangerReason, describeResult, listBackground, normalizeMode, requestApproval, resolveApproval, runCommand, startBackground, stopAllBackground } from '../shell';

test('commands that can wreck the machine are recognised; ordinary dev commands are not', () => {
  for (const bad of [
    'format C:', 'diskpart', 'rm -rf /', 'rm -rf ~', 'sudo rm -fr / --no-preserve-root',
    'Remove-Item -Recurse -Force C:\\', 'Remove-Item C:\\ -Recurse', 'rd /s /q C:\\', 'shutdown /s /t 0', 'Stop-Computer',
    'reg delete HKLM\\Software\\X /f', 'Set-ExecutionPolicy Unrestricted', 'vssadmin delete shadows /all',
  ]) assert.ok(dangerReason(bad), `should refuse: ${bad}`);
  for (const ok of [
    'docker compose -f otto.compose.yaml up -d', 'docker exec pg psql -U postgres -c "create database shop"',
    'npm run dev', 'rm -rf node_modules', 'Remove-Item -Recurse -Force .\\dist', 'git status', 'php artisan migrate',
    'docker run -d --name pg2 -e POSTGRES_PASSWORD=secret -p 5433:5432 postgres:16',
  ]) assert.equal(dangerReason(ok), null, `should allow: ${ok}`);
});

test('mode defaults to asking', () => {
  assert.equal(normalizeMode(undefined), 'ask');
  assert.equal(normalizeMode('auto'), 'auto');
  assert.equal(normalizeMode('off'), 'off');
  assert.equal(normalizeMode('yes please'), 'ask');
});

test('a command runs in the project folder and its output and exit code come back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-shell-'));
  fs.writeFileSync(path.join(dir, 'marker.txt'), 'x');
  const listing = await runCommand(dir, process.platform === 'win32' ? 'Get-ChildItem -Name' : 'ls');
  assert.equal(listing.code, 0);
  assert.match(listing.output, /marker\.txt/);
  const failing = await runCommand(dir, 'exit 3');
  assert.equal(failing.code, 3);
  assert.match(describeResult('exit 3', failing), /exit code 3/);
  const slow = await runCommand(dir, process.platform === 'win32' ? 'Start-Sleep -Seconds 5' : 'sleep 5', 1);
  assert.equal(slow.timedOut, true);
});

test('approval: the answer reaches the waiting agent; unknown ids are ignored', async () => {
  const yes = requestApproval();
  assert.equal(resolveApproval(yes.id, true), true);
  assert.equal(await yes.decision, true);
  const no = requestApproval();
  resolveApproval(no.id, false);
  assert.equal(await no.decision, false);
  assert.equal(resolveApproval('nope', true), false);
});

test('a background command keeps running and reports its first output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-bg-'));
  const cmd = process.platform === 'win32' ? 'Write-Output started; Start-Sleep -Seconds 30' : 'echo started; sleep 30';
  const text = await startBackground(dir, cmd, 2500);
  assert.match(text, /started/);
  assert.match(text, /still running/);
  assert.ok(listBackground().some((r) => r.running && r.command === cmd));
  stopAllBackground();
});
