import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('../scripts/runtime-install-lock.mjs', import.meta.url);

async function loadRuntimeLock() {
  return import(`${moduleUrl.href}?test=${Date.now()}-${Math.random()}`).catch(() => null);
}

const fastLockOptions = {
  stale: 5_000,
  update: 1_000,
  retries: { retries: 20, factor: 1, minTimeout: 10, maxTimeout: 10 },
};

function spawnLifecycleWorker(operation, paths) {
  const fixture = fileURLToPath(new URL('./fixtures/runtime-lifecycle-worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [fixture, operation, ...paths], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${operation} worker exited ${code}: ${stderr || stdout}`));
    });
  });
  return { child, completion };
}

async function waitForPath(targetPath) {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await access(targetPath);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${targetPath}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

test('shared installer lock recovers an orphaned stale lock without a custom reaper', async (t) => {
  const runtimeLock = await loadRuntimeLock();
  assert.ok(runtimeLock, 'shared runtime lock module must exist');
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia orphaned lock-'));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const target = path.join(temporaryRoot, 'plugins', '.imvia-layer-install.lock-target');
  const orphanedLock = `${target}.lock`;
  await mkdir(path.dirname(target), { recursive: true });
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
  assert.equal((await readdir(path.dirname(target))).some((name) => name.includes('reaper')), false);
});

test('shared installer lock serializes waiters and a failed owner cannot break its successor', async (t) => {
  const runtimeLock = await loadRuntimeLock();
  assert.ok(runtimeLock, 'shared runtime lock module must exist');
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia serialized lock-'));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

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

test('fresh-runner workflow installs locked Node dependencies before every runtime contract', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/python-runtime-contracts.yml', import.meta.url),
    'utf8',
  );
  const npmCi = workflow.indexOf('run: npm ci');
  const productionBuild = workflow.indexOf('run: npm run build');
  const firstNodeContract = workflow.indexOf('run: npm test');
  const realInstaller = workflow.indexOf('run: node scripts/install-codex-plugin.mjs');

  assert.ok(npmCi >= 0, 'fresh runner must install package-lock dependencies');
  assert.ok(npmCi < firstNodeContract, 'npm ci must precede focused Node contracts');
  assert.ok(npmCi < realInstaller, 'npm ci must precede the real installer');
  assert.ok(productionBuild > npmCi, 'fresh checkout must build the ignored dist after npm ci');
  assert.ok(productionBuild < firstNodeContract, 'production build must precede focused Node contracts');
  assert.match(workflow, /run:\s*npm test/);
  assert.doesNotMatch(workflow, /node --test src\/\*\.test\.mjs/);
});

test('CI runs the complete release contract on macOS and Windows at the minimum supported Node', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/python-runtime-contracts.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /os:\s*\[macos-latest, windows-latest\]/);
  assert.match(workflow, /node-version:\s*['"]?20\.19\.0['"]?/);
  assert.match(workflow, /run:\s*npm test/);
  assert.doesNotMatch(workflow, /node --test src\/\*\.test\.mjs/);
  assert.match(workflow, /run:\s*node scripts\/run-managed-python-tests\.mjs/);
  assert.match(workflow, /run:\s*node scripts\/verify-installed-runtime\.mjs/);
  assert.match(workflow, /run:\s*node scripts\/verify-production-build\.mjs/);
  assert.equal((workflow.match(/run:\s*npm run build/g) || []).length, 1, 'CI must perform one declared production build');
});

test('an uninstall queued behind an installer wins and the old installer cannot reappear', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia install then uninstall-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const entered = path.join(temporaryRoot, 'install-entered');
  const gate = path.join(temporaryRoot, 'release-install');
  const sentinel = path.join(pluginRoot, 'installed.txt');
  const workerPaths = [pluginRoot, entered, gate, sentinel];
  const installer = spawnLifecycleWorker('install', workerPaths);
  await waitForPath(entered);
  const uninstaller = spawnLifecycleWorker('uninstall', workerPaths);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const uninstallWaited = uninstaller.child.exitCode === null;
  await writeFile(gate, 'release');
  await Promise.all([installer.completion, uninstaller.completion]);

  assert.equal(uninstallWaited, true, 'uninstall must wait for the active installer lock');
  await assert.rejects(access(sentinel), { code: 'ENOENT' });
  await access(path.join(temporaryRoot, 'plugins', '.imvia-layer-install.lock-target'));
});

test('an installer queued behind an uninstall wins only after plugin deletion releases the lock', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia uninstall then install-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const uninstallEntered = path.join(temporaryRoot, 'uninstall-entered');
  const uninstallGate = path.join(temporaryRoot, 'release-uninstall');
  const installEntered = path.join(temporaryRoot, 'install-entered');
  const installGate = path.join(temporaryRoot, 'release-install');
  const sentinel = path.join(pluginRoot, 'installed.txt');
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(sentinel, 'old');

  const uninstaller = spawnLifecycleWorker('held-uninstall', [
    pluginRoot,
    uninstallEntered,
    uninstallGate,
    sentinel,
  ]);
  await waitForPath(uninstallEntered);
  const installer = spawnLifecycleWorker('install', [pluginRoot, installEntered, installGate, sentinel]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const installerEnteredEarly = await access(installEntered).then(() => true, () => false);

  await writeFile(uninstallGate, 'release');
  await uninstaller.completion;
  await waitForPath(installEntered);
  await writeFile(installGate, 'release');
  await installer.completion;

  assert.equal(installerEnteredEarly, false, 'installer must not enter while uninstall owns the lock');
  assert.equal(await readFile(sentinel, 'utf8'), 'installed');
});
