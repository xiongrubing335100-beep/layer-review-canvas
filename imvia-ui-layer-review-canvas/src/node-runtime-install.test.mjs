import assert from 'node:assert/strict';
import * as realFileSystem from 'node:fs/promises';
import { chmod, copyFile, link, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const moduleUrl = new URL('../scripts/node-runtime.mjs', import.meta.url);

async function loadNodeRuntime() {
  return import(`${moduleUrl.href}?test=${Date.now()}-${Math.random()}`).catch(() => null);
}

test('Windows and macOS plugin-owned Node paths are stable and platform native', async () => {
  const nodeRuntime = await loadNodeRuntime();
  assert.ok(nodeRuntime, 'managed Node runtime module must exist');
  assert.equal(
    nodeRuntime.runtimeNodePath('C:\\Users\\Qing Mu\\plugins\\imvia-layer\\.node-runtime', 'win32'),
    'C:\\Users\\Qing Mu\\plugins\\imvia-layer\\.node-runtime\\node.exe',
  );
  assert.equal(
    nodeRuntime.runtimeNodePath('/Users/Qing Mu/plugins/imvia-layer/.node-runtime', 'darwin'),
    '/Users/Qing Mu/plugins/imvia-layer/.node-runtime/bin/node',
  );
});

test('failed Node launcher replacement preserves the previous executable and removes staging', async (t) => {
  const nodeRuntime = await loadNodeRuntime();
  assert.ok(nodeRuntime, 'managed Node runtime module must exist');
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia node atomic-'));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const cacheNode = path.join(temporaryRoot, 'Codex Cache', 'node');
  const changedSource = path.join(temporaryRoot, 'changed-node');
  await mkdir(path.dirname(cacheNode), { recursive: true });
  await link(process.execPath, cacheNode).catch(() => copyFile(process.execPath, cacheNode));
  await writeFile(changedSource, '#!/bin/sh\necho v99.0.0\n');
  await chmod(changedSource, 0o755);
  t.after(() => realFileSystem.rm(temporaryRoot, { recursive: true, force: true }));

  const first = await nodeRuntime.ensurePersistentNodeLauncher({ pluginRoot, nodeExecutable: cacheNode });
  const before = await readFile(first.command);
  const faultingFileSystem = {
    ...realFileSystem,
    async copyFile(source, destination) {
      if (source === changedSource) throw Object.assign(new Error('simulated launcher copy failure'), { code: 'EIO' });
      return realFileSystem.copyFile(source, destination);
    },
  };
  await assert.rejects(
    nodeRuntime.ensurePersistentNodeLauncher({
      pluginRoot,
      nodeExecutable: changedSource,
      fileSystem: faultingFileSystem,
    }),
    /simulated launcher copy failure/,
  );
  assert.deepEqual(await readFile(first.command), before);
  const result = spawnSync(first.command, ['--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal((await readdir(pluginRoot)).some((name) => name.startsWith('.node-runtime.staging-')), false);
});
