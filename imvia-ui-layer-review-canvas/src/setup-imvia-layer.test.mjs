import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('setup and update fail closed through preflight, clean dependencies, build, then locked registration', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const expected = 'node scripts/node-version-preflight.mjs && npm ci && npm run build && node scripts/setup-imvia-layer.mjs';
  assert.equal(manifest.scripts.setup, expected);
  assert.equal(manifest.scripts.update, expected);
});

function spawnWorker(operation, paths) {
  const fixture = fileURLToPath(new URL('./fixtures/setup-lifecycle-worker.mjs', import.meta.url));
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
      if (code === 0) resolve({ stdout, stderr });
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

test('uninstall queued during setup prewarm wins after the complete setup lifecycle releases the lock', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia setup then uninstall-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const prewarmEntered = path.join(temporaryRoot, 'prewarm-entered');
  const prewarmGate = path.join(temporaryRoot, 'release-prewarm');
  const setupSentinel = path.join(pluginRoot, 'setup-complete.txt');
  const setup = spawnWorker('setup', [pluginRoot, prewarmEntered, prewarmGate, setupSentinel]);
  await waitForPath(prewarmEntered);
  const uninstall = spawnWorker('uninstall', [pluginRoot, prewarmEntered, prewarmGate, setupSentinel]);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(uninstall.child.exitCode, null, 'uninstall must wait while setup is prewarming under the shared lock');
  await writeFile(prewarmGate, 'release');
  await Promise.all([setup.completion, uninstall.completion]);

  await assert.rejects(access(pluginRoot), { code: 'ENOENT' });
});

test('setup queued behind uninstall wins only after deletion releases the shared lifecycle lock', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia uninstall then setup-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const uninstallEntered = path.join(temporaryRoot, 'uninstall-entered');
  const uninstallGate = path.join(temporaryRoot, 'release-uninstall');
  const setupEntered = path.join(temporaryRoot, 'setup-entered');
  const setupSentinel = path.join(pluginRoot, 'setup-complete.txt');
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(path.join(pluginRoot, 'old.txt'), 'old');

  const uninstall = spawnWorker('held-uninstall', [pluginRoot, uninstallEntered, uninstallGate, setupSentinel]);
  await waitForPath(uninstallEntered);
  const setup = spawnWorker('setup', [pluginRoot, setupEntered, uninstallGate, setupSentinel]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(access(setupEntered), { code: 'ENOENT' });
  await writeFile(uninstallGate, 'release');
  await uninstall.completion;
  await setup.completion;

  assert.equal(await readFile(setupSentinel, 'utf8'), 'installed');
  await assert.rejects(access(path.join(pluginRoot, 'old.txt')), { code: 'ENOENT' });
});

test('uninstall reports removal of both managed Python and Node runtimes', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia uninstall message-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['scripts/uninstall-codex-plugin.mjs'], {
    cwd: root,
    env: { ...process.env, HOME: temporaryRoot, USERPROFILE: temporaryRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Python 和 Node runtime 已卸载/);
});

test('test setup may skip only model prewarm while retaining locked registration', async () => {
  let warmCount = 0;
  let installCount = 0;
  await import('../scripts/setup-imvia-layer.mjs').then(({ setupImviaLayer }) => setupImviaLayer({
    pluginRoot: path.join(os.tmpdir(), `imvia skip prewarm-${process.pid}-${Date.now()}`),
    ensurePythonLockedImpl: async () => ({ command: 'python', args: [], version: '3.12' }),
    warmModelImpl: async () => { warmCount += 1; },
    installLockedImpl: async () => { installCount += 1; },
    withLockImpl: async ({ task }) => task(),
    writeOutput: () => {},
    skipModelPrewarm: true,
  }));
  assert.equal(warmCount, 0);
  assert.equal(installCount, 1);
});
