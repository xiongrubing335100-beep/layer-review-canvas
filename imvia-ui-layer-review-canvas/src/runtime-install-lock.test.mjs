import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const moduleUrl = new URL('../scripts/runtime-install-lock.mjs', import.meta.url);

async function loadRuntimeLock() {
  return import(`${moduleUrl.href}?test=${Date.now()}-${Math.random()}`).catch(() => null);
}

const fastLockOptions = {
  stale: 5_000,
  update: 1_000,
  retries: { retries: 20, factor: 1, minTimeout: 10, maxTimeout: 10 },
};

test('shared installer lock recovers an orphaned stale lock without a custom reaper', async (t) => {
  const runtimeLock = await loadRuntimeLock();
  assert.ok(runtimeLock, 'shared runtime lock module must exist');
  const pluginRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia orphaned lock-'));
  t.after(() => rm(pluginRoot, { recursive: true, force: true }));

  const target = path.join(pluginRoot, '.imvia-runtime-install');
  const orphanedLock = `${target}.lock`;
  await mkdir(orphanedLock);
  const staleDate = new Date(Date.now() - 30_000);
  await utimes(orphanedLock, staleDate, staleDate);

  let entered = false;
  await runtimeLock.withRuntimeInstallLock({
    pluginRoot,
    lockOptions: fastLockOptions,
    task: async () => { entered = true; },
  });

  assert.equal(entered, true);
  await assert.rejects(access(orphanedLock), { code: 'ENOENT' });
  assert.equal((await readdir(pluginRoot)).some((name) => name.includes('reaper')), false);
});

test('shared installer lock serializes waiters and a failed owner cannot break its successor', async (t) => {
  const runtimeLock = await loadRuntimeLock();
  assert.ok(runtimeLock, 'shared runtime lock module must exist');
  const pluginRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia serialized lock-'));
  t.after(() => rm(pluginRoot, { recursive: true, force: true }));

  let releaseFirst;
  const firstMayFail = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered;
  const firstDidEnter = new Promise((resolve) => { firstEntered = resolve; });
  let active = 0;
  let maxActive = 0;
  const first = runtimeLock.withRuntimeInstallLock({
    pluginRoot,
    lockOptions: fastLockOptions,
    task: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      firstEntered();
      await firstMayFail;
      active -= 1;
      throw new Error('simulated installer crash');
    },
  });
  await firstDidEnter;
  const second = runtimeLock.withRuntimeInstallLock({
    pluginRoot,
    lockOptions: fastLockOptions,
    task: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      return 'published';
    },
  });
  releaseFirst();

  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /simulated installer crash/);
  assert.deepEqual(results[1], { status: 'fulfilled', value: 'published' });
  assert.equal(maxActive, 1);
});

test('managed runtimes use the shared lock and contain no homemade reaper', async () => {
  for (const relativePath of ['../scripts/python-runtime.mjs', '../scripts/node-runtime.mjs']) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /withRuntimeInstallLock/);
    assert.doesNotMatch(source, /reaper|acquireManagedRuntimeLock|tryReapStaleLock/i);
  }
});
