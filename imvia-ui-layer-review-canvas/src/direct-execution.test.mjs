import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { isDirectExecution } from '../scripts/direct-execution.mjs';

test('direct execution canonicalizes both the invoked and module filenames', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'real.mjs');
  const alias = path.join(root, 'alias.mjs');
  await writeFile(target, '');
  await symlink(target, alias);
  assert.equal(await isDirectExecution(pathToFileURL(alias), { argvPath: target }), true);
  assert.equal(await isDirectExecution(pathToFileURL(target), { argvPath: alias }), true);
  const other = path.join(root, 'other.mjs');
  await writeFile(other, '');
  assert.equal(await isDirectExecution(pathToFileURL(target), { argvPath: other }), false);
});

test('Windows short-path and case aliases resolve to the same executable', async () => {
  const resolved = ['C:\\Users\\RunnerAdmin\\AppData\\Local\\Temp\\install.mjs',
    'c:\\users\\runneradmin\\appdata\\local\\temp\\install.mjs'];
  const calls = [];
  assert.equal(await isDirectExecution(import.meta.url, {
    argvPath: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\install.mjs', platform: 'win32',
    realpathImpl: async value => { calls.push(value); return resolved[calls.length - 1]; },
  }), true);
  assert.equal(calls.length, 2);
});

test('missing or imported entrypoints never start a CLI', async () => {
  assert.equal(await isDirectExecution(import.meta.url, { argvPath: null }), false);
  assert.equal(await isDirectExecution(import.meta.url, {
    argvPath: 'missing', realpathImpl: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }), false);
  let call = 0;
  assert.equal(await isDirectExecution(import.meta.url, {
    argvPath: '/tmp/A.mjs', platform: 'darwin', realpathImpl: async () => ++call === 1 ? '/tmp/A.mjs' : '/tmp/a.mjs',
  }), false);
});
