import test from 'node:test';
import assert from 'node:assert/strict';
import { findSecrets, sensitivePath } from '../scripts/check-secrets.mjs';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('detects key material without including the secret in findings', () => {
  const token = 'sk-' + 'a'.repeat(48);
  const findings = findSecrets(`const key = "${token}";`, 'public/app.js');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1);
  assert.equal(JSON.stringify(findings).includes(token), false);
});

test('permits blank environment templates and detects nonblank key assignments', () => {
  assert.equal(findSecrets('OPENAI_API_KEY=\nDEEPSEEK_API_KEY=', '.env.example').length, 0);
  assert.equal(findSecrets('OPENAI_API_KEY=""\nDEEPSEEK_API_KEY= # leave blank', '.env.example').length, 0);
  assert.ok(findSecrets('OPENAI_API_KEY=abc', '.env.example').length > 0);
});

test('blocks tracked secret files including nested files and allows the blank template name', () => {
  for (const name of ['.env', '.env_backup', 'local/.env.production', 'auth.json', '.codex/auth.json', 'private.key', 'credentials-local.json', '.npmrc']) assert.equal(sensitivePath(name), true, name);
  assert.equal(sensitivePath('.env.example'), false);
  assert.equal(sensitivePath('server.mjs'), false);
});

test('staged checks inspect the index and block force-added ignored files in a nested project', t => {
  const tempBase = path.resolve(os.tmpdir());
  const directory = mkdtempSync(path.join(tempBase, 'paper-translator-security-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(tempBase + path.sep) || !path.basename(resolved).startsWith('paper-translator-security-')) throw new Error('Unsafe test cleanup path');
    rmSync(resolved, { recursive: true, force: true });
  });
  const project = path.join(directory, 'project');
  mkdirSync(path.join(project, 'scripts'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../scripts/check-secrets.mjs', import.meta.url)), path.join(project, 'scripts', 'check-secrets.mjs'));
  function git(...args) {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  function check() { return spawnSync(process.execPath, ['scripts/check-secrets.mjs', '--staged'], { cwd: project, encoding: 'utf8', windowsHide: true }); }
  git('init', '--quiet');
  writeFileSync(path.join(project, '.gitignore'), '.env\n');
  writeFileSync(path.join(project, '.env'), 'OPENAI_API_KEY=local-only\n');
  git('add', '-f', 'project/.env');
  const ignored = check();
  assert.equal(ignored.status, 1);
  assert.match(ignored.stderr, /敏感文件/);
  git('rm', '--cached', '--', 'project/.env');
  const token = 'sk-' + 'b'.repeat(48);
  writeFileSync(path.join(project, 'app.js'), `const key = "${token}";`);
  git('add', 'project/app.js');
  writeFileSync(path.join(project, 'app.js'), '// working tree is clean; index still contains the key');
  const staged = check();
  assert.equal(staged.status, 1);
  assert.match(staged.stderr, /app\.js:1/);
  assert.equal((staged.stderr + staged.stdout).includes(token), false);
  git('add', 'project/app.js');
  assert.equal(check().status, 0);
});
