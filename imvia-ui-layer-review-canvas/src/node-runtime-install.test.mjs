import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as realFileSystem from 'node:fs/promises';
import { access, chmod, copyFile, link, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const moduleUrl = new URL('../scripts/node-runtime.mjs', import.meta.url);

async function loadNodeRuntime() {
  return import(`${moduleUrl.href}?test=${Date.now()}-${Math.random()}`).catch(() => null);
}

const testLicense = 'Node.js test distribution license\nCopyright Node.js contributors\n';

function licenseResponse(body = testLicense, { status = 200, location } = {}) {
  const headers = new Headers();
  if (location) headers.set('location', location);
  return new Response(body, { status, headers });
}

function officialLicenseFetch(requests = []) {
  return async (url, options) => {
    requests.push({ url: String(url), options });
    return licenseResponse();
  };
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

  const first = await nodeRuntime.ensurePersistentNodeLauncher({
    pluginRoot,
    nodeExecutable: cacheNode,
    fetchImpl: officialLicenseFetch(),
  });
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
      fetchImpl: officialLicenseFetch(),
    }),
    /simulated launcher copy failure/,
  );
  assert.deepEqual(await readFile(first.command), before);
  const result = spawnSync(first.command, ['--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal((await readdir(pluginRoot)).some((name) => name.startsWith('.node-runtime.staging-')), false);
});

test('two first-time and two upgrade ensures publish the Node launcher exactly once', async (t) => {
  const nodeRuntime = await loadNodeRuntime();
  assert.ok(nodeRuntime, 'managed Node runtime module must exist');
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia node concurrent-'));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const sourceNode = path.join(temporaryRoot, 'fake-node');
  await writeFile(sourceNode, 'node-v1');
  t.after(() => realFileSystem.rm(temporaryRoot, { recursive: true, force: true }));

  let copyCount = 0;
  const delayedFileSystem = {
    ...realFileSystem,
    async copyFile(source, destination) {
      copyCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return realFileSystem.copyFile(source, destination);
    },
  };
  const runCommandImpl = async () => ({ stdout: 'v24.4.1\n', stderr: '' });
  const options = {
    pluginRoot,
    nodeExecutable: sourceNode,
    fileSystem: delayedFileSystem,
    runCommandImpl,
    fetchImpl: officialLicenseFetch(),
  };

  const firstResults = await Promise.all([
    nodeRuntime.ensurePersistentNodeLauncher(options),
    nodeRuntime.ensurePersistentNodeLauncher(options),
  ]);
  assert.deepEqual(firstResults[1], firstResults[0]);
  assert.equal(copyCount, 1);

  await writeFile(sourceNode, 'node-v2');
  copyCount = 0;
  const upgradeResults = await Promise.all([
    nodeRuntime.ensurePersistentNodeLauncher(options),
    nodeRuntime.ensurePersistentNodeLauncher(options),
  ]);
  assert.deepEqual(upgradeResults[1], upgradeResults[0]);
  assert.equal(copyCount, 1);
});

test('Node launcher publishes the exact versioned official LICENSE and records its hash', async (t) => {
  const nodeRuntime = await loadNodeRuntime();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia node license-'));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const sourceNode = path.join(temporaryRoot, 'node');
  await writeFile(sourceNode, 'node-v24');
  t.after(() => realFileSystem.rm(temporaryRoot, { recursive: true, force: true }));
  const requests = [];

  const result = await nodeRuntime.ensurePersistentNodeLauncher({
    pluginRoot,
    nodeExecutable: sourceNode,
    runCommandImpl: async () => ({ stdout: 'v24.4.1\n', stderr: '' }),
    fetchImpl: officialLicenseFetch(requests),
  });

  const expectedSource = 'https://api.github.com/repos/nodejs/node/contents/LICENSE?ref=v24.4.1';
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, expectedSource);
  assert.equal(requests[0].options.redirect, 'manual');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(requests[0].options.headers.Accept, 'application/vnd.github.raw+json');
  assert.equal(requests[0].options.headers['X-GitHub-Api-Version'], '2022-11-28');
  const licensePath = path.join(pluginRoot, '.node-runtime', 'LICENSE');
  assert.equal(await readFile(licensePath, 'utf8'), testLicense);
  const marker = JSON.parse(await readFile(path.join(pluginRoot, '.node-runtime', '.imvia-layer-node.json'), 'utf8'));
  assert.equal(marker.nodeVersion, 'v24.4.1');
  assert.equal(marker.licenseSource, expectedSource);
  assert.equal(marker.licenseSha256, createHash('sha256').update(testLicense).digest('hex'));
  assert.equal(result.nodeVersion, 'v24.4.1');
});

test('valid cached Node LICENSE is reused and a damaged copy is fetched and repaired', async (t) => {
  const nodeRuntime = await loadNodeRuntime();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia node license cache-'));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const sourceNode = path.join(temporaryRoot, 'node');
  await writeFile(sourceNode, 'node-v24');
  t.after(() => realFileSystem.rm(temporaryRoot, { recursive: true, force: true }));
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return licenseResponse();
  };
  const options = {
    pluginRoot,
    nodeExecutable: sourceNode,
    runCommandImpl: async () => ({ stdout: 'v24.4.1\n', stderr: '' }),
    fetchImpl,
  };

  await nodeRuntime.ensurePersistentNodeLauncher(options);
  await nodeRuntime.ensurePersistentNodeLauncher({
    ...options,
    fetchImpl: async () => { throw new Error('cache should avoid network'); },
  });
  assert.equal(fetchCount, 1);

  const licensePath = path.join(pluginRoot, '.node-runtime', 'LICENSE');
  await writeFile(licensePath, 'damaged');
  await nodeRuntime.ensurePersistentNodeLauncher(options);
  assert.equal(fetchCount, 2);
  assert.equal(await readFile(licensePath, 'utf8'), testLicense);
});

test('LICENSE fetch rejects wrong-version and non-official redirects', async (t) => {
  const nodeRuntime = await loadNodeRuntime();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia node redirect-'));
  t.after(() => realFileSystem.rm(temporaryRoot, { recursive: true, force: true }));
  const sourceNode = path.join(temporaryRoot, 'node');
  await writeFile(sourceNode, 'node-v24');
  const baseOptions = {
    pluginRoot: path.join(temporaryRoot, 'plugins', 'imvia-layer'),
    nodeExecutable: sourceNode,
    runCommandImpl: async () => ({ stdout: 'v24.4.1\n', stderr: '' }),
  };

  await assert.rejects(nodeRuntime.ensurePersistentNodeLauncher({
    ...baseOptions,
    fetchImpl: async () => licenseResponse('', {
      status: 302,
      location: 'https://api.github.com/repos/nodejs/node/contents/LICENSE?ref=v23.0.0',
    }),
  }), /LICENSE.*version|version.*LICENSE/i);
  await assert.rejects(nodeRuntime.ensurePersistentNodeLauncher({
    ...baseOptions,
    fetchImpl: async () => licenseResponse('', {
      status: 302,
      location: 'https://example.com/LICENSE',
    }),
  }), /official|api\.github\.com|host/i);
});

test('staged Node version mismatch and oversized LICENSE fail before publication', async (t) => {
  const nodeRuntime = await loadNodeRuntime();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia node validation-'));
  t.after(() => realFileSystem.rm(temporaryRoot, { recursive: true, force: true }));
  const sourceNode = path.join(temporaryRoot, 'node');
  await writeFile(sourceNode, 'node-v24');
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const common = { pluginRoot, nodeExecutable: sourceNode };

  await assert.rejects(nodeRuntime.ensurePersistentNodeLauncher({
    ...common,
    runCommandImpl: async (command) => ({
      stdout: command.includes('.node-runtime.staging-') ? 'v23.0.0\n' : 'v24.4.1\n',
      stderr: '',
    }),
    fetchImpl: officialLicenseFetch(),
  }), /version mismatch.*v24\.4\.1.*v23\.0\.0/i);
  await assert.rejects(access(path.join(pluginRoot, '.node-runtime')), { code: 'ENOENT' });

  await assert.rejects(nodeRuntime.ensurePersistentNodeLauncher({
    ...common,
    runCommandImpl: async () => ({ stdout: 'v24.4.1\n', stderr: '' }),
    fetchImpl: async () => licenseResponse(`${testLicense}${'x'.repeat(100)}`),
    licenseMaxBytes: testLicense.length,
  }), /exceeds.*byte safety limit/i);
  await assert.rejects(access(path.join(pluginRoot, '.node-runtime')), { code: 'ENOENT' });
});

test('missing LICENSE fails clearly and preserves the previous valid launcher', async (t) => {
  const nodeRuntime = await loadNodeRuntime();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia node license rollback-'));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const sourceNode = path.join(temporaryRoot, 'node');
  await writeFile(sourceNode, 'node-v24');
  t.after(() => realFileSystem.rm(temporaryRoot, { recursive: true, force: true }));
  let version = 'v24.4.1';
  const options = {
    pluginRoot,
    nodeExecutable: sourceNode,
    runCommandImpl: async () => ({ stdout: `${version}\n`, stderr: '' }),
    fetchImpl: officialLicenseFetch(),
  };
  const first = await nodeRuntime.ensurePersistentNodeLauncher(options);
  const previousLauncher = await readFile(first.command);
  const previousMarker = await readFile(path.join(pluginRoot, '.node-runtime', '.imvia-layer-node.json'));

  await writeFile(sourceNode, 'node-v25');
  version = 'v25.0.0';
  await assert.rejects(nodeRuntime.ensurePersistentNodeLauncher({
    ...options,
    fetchImpl: async () => licenseResponse('not found', { status: 404 }),
  }), /LICENSE.*404|404.*LICENSE/i);

  assert.deepEqual(await readFile(first.command), previousLauncher);
  assert.deepEqual(await readFile(path.join(pluginRoot, '.node-runtime', '.imvia-layer-node.json')), previousMarker);
  assert.equal((await readdir(pluginRoot)).some((name) => name.startsWith('.node-runtime.staging-')), false);
});

test('a failed concurrent Node upgrade releases the lock for a succeeding publisher', async (t) => {
  const nodeRuntime = await loadNodeRuntime();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia node failed waiter-'));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const sourceNode = path.join(temporaryRoot, 'node');
  await writeFile(sourceNode, 'node-v24');
  t.after(() => realFileSystem.rm(temporaryRoot, { recursive: true, force: true }));
  let version = 'v24.4.1';
  const common = {
    pluginRoot,
    nodeExecutable: sourceNode,
    runCommandImpl: async () => ({ stdout: `${version}\n`, stderr: '' }),
  };
  await nodeRuntime.ensurePersistentNodeLauncher({ ...common, fetchImpl: officialLicenseFetch() });
  await writeFile(sourceNode, 'node-v25');
  version = 'v25.0.0';

  let failureEntered;
  const didEnterFailure = new Promise((resolve) => { failureEntered = resolve; });
  let letFailureReturn;
  const failureMayReturn = new Promise((resolve) => { letFailureReturn = resolve; });
  const failed = nodeRuntime.ensurePersistentNodeLauncher({
    ...common,
    fetchImpl: async () => {
      failureEntered();
      await failureMayReturn;
      return licenseResponse('not found', { status: 404 });
    },
  });
  await didEnterFailure;
  const succeeded = nodeRuntime.ensurePersistentNodeLauncher({ ...common, fetchImpl: officialLicenseFetch() });
  letFailureReturn();

  const results = await Promise.allSettled([failed, succeeded]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /LICENSE.*404|404.*LICENSE/i);
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[1].value.nodeVersion, 'v25.0.0');
  const marker = JSON.parse(await readFile(path.join(pluginRoot, '.node-runtime', '.imvia-layer-node.json'), 'utf8'));
  assert.equal(marker.nodeVersion, 'v25.0.0');
  assert.equal((await readdir(pluginRoot)).some((name) => name.startsWith('.node-runtime.staging-')), false);
});
