import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as pythonRuntime from '../scripts/python-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
}

async function writeFakePython(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.FAKE_PYTHON_LOG) fs.appendFileSync(process.env.FAKE_PYTHON_LOG, JSON.stringify({ command: process.argv[1], args }) + '\\n');
if (args[0] === '-c' && args[1].includes('version_info')) {
  process.stdout.write((process.env.FAKE_PYTHON_VERSION || '3.12') + '\\n');
} else if (args[0] === '-m' && args[1] === 'venv') {
  const target = args[2];
  const python = path.join(target, 'bin', 'python');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.copyFileSync(process.argv[1], python);
  fs.chmodSync(python, 0o755);
} else if (args[0] === '-m' && args[1] === 'pip') {
  if (process.env.FAKE_PIP_FAIL === '1') {
    process.stderr.write('simulated pip failure');
    process.exitCode = 7;
  }
} else if (args[0] === '-c' && args[1].includes('rembg')) {
  if (process.env.FAKE_REMBG_FAIL === '1') {
    process.stderr.write('simulated rembg import failure');
    process.exitCode = 8;
  } else {
    process.stdout.write('2.0.69\\n');
  }
} else if (args[0].endsWith('scripts/warm-rmbg.py')) {
  process.exitCode = 0;
} else {
  process.stderr.write('unexpected fake Python arguments: ' + JSON.stringify(args));
  process.exitCode = 2;
}
`);
  await chmod(filePath, 0o755);
}

test('standalone plugin install records a durable verified runtime even when paths contain spaces', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia runtime path with spaces-'));
  const fakePython = path.join(temporaryRoot, 'Python Base', 'python3');
  await writeFakePython(fakePython);
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(temporaryRoot, { recursive: true, force: true })));

  const result = run(process.execPath, ['scripts/install-codex-plugin.mjs'], {
    env: {
      ...process.env,
      HOME: temporaryRoot,
      USERPROFILE: temporaryRoot,
      PYTHON: fakePython,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const runtime = JSON.parse(await readFile(path.join(pluginRoot, 'imvia-layer-runtime.json'), 'utf8'));
  const expectedPython = path.join(pluginRoot, '.python-runtime', 'bin', 'python');
  assert.deepEqual(runtime.python, { command: expectedPython, args: [] });

  const importResult = run(runtime.python.command, [...runtime.python.args, '-c', 'import rembg']);
  assert.equal(importResult.status, 0, importResult.stderr || importResult.stdout);

  const marker = JSON.parse(await readFile(path.join(pluginRoot, '.python-runtime', '.imvia-layer-runtime.json'), 'utf8'));
  assert.match(marker.requirementsSha256, /^[a-f0-9]{64}$/);
  assert.equal(marker.pythonVersion, '3.12');
});

test('Windows keeps spaced runtime paths and py launcher arguments separate', () => {
  const runtimeRoot = 'C:\\Users\\Qing Mu\\plugins\\imvia-layer\\.python-runtime';
  assert.equal(
    pythonRuntime.runtimePythonPath(runtimeRoot, 'win32'),
    'C:\\Users\\Qing Mu\\plugins\\imvia-layer\\.python-runtime\\Scripts\\python.exe',
  );

  assert.equal(typeof pythonRuntime.pythonCandidates, 'function');
  assert.deepEqual(
    pythonRuntime.pythonCandidates({
      platform: 'win32',
      nodeExecutable: 'C:\\Codex App\\dependencies\\node\\node.exe',
    }),
    [
      { command: 'C:\\Codex App\\dependencies\\python\\python.exe', args: [] },
      { command: 'C:\\Codex App\\dependencies\\python\\Scripts\\python.exe', args: [] },
      { command: 'C:\\Codex App\\dependencies\\python\\bin\\python.exe', args: [] },
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
    ],
  );
});

test('macOS tries configured or bundled Python before system fallbacks', () => {
  assert.equal(typeof pythonRuntime.pythonCandidates, 'function');
  assert.deepEqual(
    pythonRuntime.pythonCandidates({
      platform: 'darwin',
      nodeExecutable: '/Codex App/dependencies/node/bin/node',
    }),
    [
      { command: '/Codex App/dependencies/python/bin/python3', args: [] },
      { command: 'python3', args: [] },
      { command: 'python', args: [] },
    ],
  );
  assert.deepEqual(
    pythonRuntime.pythonCandidates({
      configuredPython: '/Users/Qing Mu/Python/bin/python3',
      platform: 'darwin',
      nodeExecutable: '/Codex App/dependencies/node/bin/node',
    }),
    [{ command: '/Users/Qing Mu/Python/bin/python3', args: [] }],
  );
});

test('requirements hash updates are idempotent and failed rebuilds preserve the prior runtime', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia atomic runtime-'));
  const repositoryRoot = path.join(temporaryRoot, 'repository');
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const requirementsPath = path.join(repositoryRoot, 'requirements-rmbg.txt');
  const fakePython = path.join(temporaryRoot, 'Python Base', 'python3');
  const logPath = path.join(temporaryRoot, 'python-calls.log');
  await mkdir(repositoryRoot, { recursive: true });
  await writeFile(requirementsPath, 'rembg[cpu]==2.0.69\n');
  await writeFakePython(fakePython);
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(temporaryRoot, { recursive: true, force: true })));

  const baseEnv = { ...process.env, PYTHON: fakePython, FAKE_PYTHON_LOG: logPath };
  const first = await pythonRuntime.ensurePersistentPythonRuntime({
    repositoryRoot,
    pluginRoot,
    env: baseEnv,
    platform: 'darwin',
    nodeExecutable: process.execPath,
  });
  const sentinelPath = path.join(pluginRoot, '.python-runtime', 'keep-me.txt');
  await writeFile(sentinelPath, 'valid previous runtime');
  await writeFile(logPath, '');

  const reused = await pythonRuntime.ensurePersistentPythonRuntime({
    repositoryRoot,
    pluginRoot,
    env: baseEnv,
    platform: 'darwin',
    nodeExecutable: process.execPath,
  });
  assert.deepEqual(reused, first);
  assert.equal(await readFile(sentinelPath, 'utf8'), 'valid previous runtime');
  const reuseCalls = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(reuseCalls.some(({ args }) => args[0] === '-m' && ['venv', 'pip'].includes(args[1])), false);

  await writeFile(requirementsPath, 'rembg[cpu]==2.0.70\n');
  await assert.rejects(
    pythonRuntime.ensurePersistentPythonRuntime({
      repositoryRoot,
      pluginRoot,
      env: { ...baseEnv, FAKE_PIP_FAIL: '1' },
      platform: 'darwin',
      nodeExecutable: process.execPath,
    }),
    /RMBG 依赖安装失败.*simulated pip failure/,
  );
  assert.equal(await readFile(sentinelPath, 'utf8'), 'valid previous runtime');

  const updated = await pythonRuntime.ensurePersistentPythonRuntime({
    repositoryRoot,
    pluginRoot,
    env: baseEnv,
    platform: 'darwin',
    nodeExecutable: process.execPath,
  });
  assert.equal(updated.command, first.command);
  assert.notEqual(updated.requirementsSha256, first.requirementsSha256);
  await assert.rejects(readFile(sentinelPath), { code: 'ENOENT' });
});

test('rembg verification and unsupported configured Python fail with actionable errors', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia runtime errors-'));
  const repositoryRoot = path.join(temporaryRoot, 'repository');
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const fakePython = path.join(temporaryRoot, 'Python Base', 'python3');
  await mkdir(repositoryRoot, { recursive: true });
  await writeFile(path.join(repositoryRoot, 'requirements-rmbg.txt'), 'rembg[cpu]==2.0.69\n');
  await writeFakePython(fakePython);
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(temporaryRoot, { recursive: true, force: true })));

  await assert.rejects(
    pythonRuntime.ensurePersistentPythonRuntime({
      repositoryRoot,
      pluginRoot,
      env: { ...process.env, PYTHON: fakePython, FAKE_REMBG_FAIL: '1' },
      platform: 'darwin',
      nodeExecutable: process.execPath,
    }),
    /RMBG 依赖验证失败.*import rembg.*simulated rembg import failure/,
  );

  await assert.rejects(
    pythonRuntime.ensurePersistentPythonRuntime({
      repositoryRoot,
      pluginRoot,
      env: { ...process.env, PYTHON: fakePython, FAKE_PYTHON_VERSION: '3.9' },
      platform: 'darwin',
      nodeExecutable: process.execPath,
    }),
    new RegExp(`PYTHON=${fakePython.replaceAll('\\', '\\\\').replaceAll('.', '\\.') } 不可用或版本低于 3\\.10`),
  );
});

test('setup installs dependencies and warms the model with the same durable runtime it registers', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia setup path with spaces-'));
  const fakePython = path.join(temporaryRoot, 'Python Base', 'python3');
  const logPath = path.join(temporaryRoot, 'python-calls.log');
  await writeFakePython(fakePython);
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(temporaryRoot, { recursive: true, force: true })));

  const result = run(process.execPath, ['scripts/setup-imvia-layer.mjs'], {
    env: {
      ...process.env,
      HOME: temporaryRoot,
      USERPROFILE: temporaryRoot,
      PYTHON: fakePython,
      FAKE_PYTHON_LOG: logPath,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const runtime = JSON.parse(await readFile(path.join(temporaryRoot, 'plugins', 'imvia-layer', 'imvia-layer-runtime.json'), 'utf8'));
  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const pipCalls = calls.filter(({ args }) => args[0] === '-m' && args[1] === 'pip');
  assert.ok(pipCalls.length >= 1);
  assert.equal(pipCalls.every(({ command }) => command !== fakePython), true);
  assert.equal(pipCalls.every(({ command }) => command.includes(`${path.sep}.python-runtime.staging-`)), true);
  const warmCalls = calls.filter(({ args }) => args[0].endsWith('scripts/warm-rmbg.py'));
  assert.equal(warmCalls.length, 1);
  assert.equal(warmCalls[0].command, runtime.python.command);
});
