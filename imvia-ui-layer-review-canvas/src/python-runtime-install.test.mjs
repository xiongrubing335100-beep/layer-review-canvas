import assert from 'node:assert/strict';
import * as realFileSystem from 'node:fs/promises';
import { access, chmod, copyFile, link, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as nodeRuntime from '../scripts/node-runtime.mjs';
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
if (args[0] === '-c' && args[1].includes('pythonCacheTag')) {
  process.stdout.write(JSON.stringify({
    pythonVersion: process.env.FAKE_PYTHON_VERSION || '3.12',
    pythonCacheTag: process.env.FAKE_PYTHON_CACHE_TAG || 'cpython-312',
    platform: process.env.FAKE_PYTHON_PLATFORM || 'darwin',
    architecture: process.env.FAKE_PYTHON_ARCH || 'arm64',
  }) + '\\n');
} else if (args[0] === '-c' && args[1].includes('version_info')) {
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
  const delay = Number(process.env.FAKE_PIP_DELAY_MS || 0);
  if (delay > 0) setTimeout(() => {}, delay);
} else if (args[0] === '-c' && args[1].includes('importlib.metadata.distribution')) {
  process.stdout.write('locked distributions verified\\n');
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

async function linkOrCopyExecutable(sourcePath, destinationPath) {
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await link(sourcePath, destinationPath).catch(() => copyFile(sourcePath, destinationPath));
  await chmod(destinationPath, 0o755);
}

async function writeTestRequirements(repositoryRoot, version = '2.0.69') {
  await mkdir(repositoryRoot, { recursive: true });
  await writeFile(path.join(repositoryRoot, 'requirements-rmbg.txt'), `rembg[cpu]==${version}\n`);
  await writeFile(path.join(repositoryRoot, 'requirements-rmbg.lock'), [
    '# universal hashed test lock',
    `rembg==${version} \\`,
    `    --hash=sha256:${'a'.repeat(64)}`,
    '',
  ].join('\n'));
}

function fsError(code, targetPath) {
  return Object.assign(new Error(`${code}: ${targetPath}`), { code });
}

class FakeWindowsFileSystem {
  constructor() {
    this.directories = new Map();
    this.files = new Map();
    this.failPublishTo = null;
  }

  key(targetPath) {
    return path.win32.normalize(targetPath).toLowerCase();
  }

  rememberDirectory(targetPath) {
    this.directories.set(this.key(targetPath), path.win32.normalize(targetPath));
  }

  async mkdir(targetPath, { recursive = false } = {}) {
    const normalized = path.win32.normalize(targetPath);
    if (this.directories.has(this.key(normalized))) {
      if (!recursive) throw fsError('EEXIST', normalized);
      return;
    }
    const parent = path.win32.dirname(normalized);
    if (parent !== normalized && !this.directories.has(this.key(parent))) {
      if (!recursive) throw fsError('ENOENT', parent);
      await this.mkdir(parent, { recursive: true });
    }
    this.rememberDirectory(normalized);
  }

  async writeFile(targetPath, content) {
    const normalized = path.win32.normalize(targetPath);
    if (!this.directories.has(this.key(path.win32.dirname(normalized)))) throw fsError('ENOENT', normalized);
    this.files.set(this.key(normalized), { path: normalized, data: Buffer.from(content) });
  }

  async readFile(targetPath, encoding) {
    const entry = this.files.get(this.key(targetPath));
    if (!entry) throw fsError('ENOENT', targetPath);
    return encoding ? entry.data.toString(encoding) : Buffer.from(entry.data);
  }

  async access(targetPath) {
    if (!this.directories.has(this.key(targetPath)) && !this.files.has(this.key(targetPath))) {
      throw fsError('ENOENT', targetPath);
    }
  }

  async readdir(targetPath) {
    const normalized = path.win32.normalize(targetPath);
    if (!this.directories.has(this.key(normalized))) throw fsError('ENOENT', normalized);
    const prefix = `${this.key(normalized)}\\`;
    const names = new Set();
    for (const entryPath of [...this.directories.values(), ...[...this.files.values()].map(({ path: filePath }) => filePath)]) {
      const entryKey = this.key(entryPath);
      if (entryKey.startsWith(prefix)) {
        const relative = entryPath.slice(normalized.length + 1);
        if (relative && !relative.includes('\\')) names.add(relative);
      }
    }
    return [...names];
  }

  async stat(targetPath) {
    await this.access(targetPath);
    return { mtimeMs: 0 };
  }

  async rename(from, to) {
    const source = path.win32.normalize(from);
    const destination = path.win32.normalize(to);
    if (this.failPublishTo && this.key(destination) === this.key(this.failPublishTo)
      && source.toLowerCase().includes('.python-runtime.staging-')) {
      throw fsError('EACCES', 'simulated Windows publish rename failure');
    }
    const sourceKey = this.key(source);
    if (!this.directories.has(sourceKey) && !this.files.has(sourceKey)) throw fsError('ENOENT', source);
    const replacePrefix = (entryPath) => `${destination}${entryPath.slice(source.length)}`;
    const directories = [...this.directories.values()].filter((entryPath) => {
      const entryKey = this.key(entryPath);
      return entryKey === sourceKey || entryKey.startsWith(`${sourceKey}\\`);
    });
    const files = [...this.files.values()].filter(({ path: entryPath }) => this.key(entryPath).startsWith(`${sourceKey}\\`));
    for (const entryPath of directories) this.directories.delete(this.key(entryPath));
    for (const { path: entryPath } of files) this.files.delete(this.key(entryPath));
    for (const entryPath of directories) this.rememberDirectory(replacePrefix(entryPath));
    for (const entry of files) this.files.set(this.key(replacePrefix(entry.path)), { path: replacePrefix(entry.path), data: entry.data });
  }

  async rm(targetPath, { recursive = false, force = false } = {}) {
    const normalized = path.win32.normalize(targetPath);
    const targetKey = this.key(normalized);
    const exists = this.directories.has(targetKey) || this.files.has(targetKey);
    if (!exists) {
      if (force) return;
      throw fsError('ENOENT', normalized);
    }
    if (this.files.has(targetKey)) {
      this.files.delete(targetKey);
      return;
    }
    const descendants = [...this.directories.keys(), ...this.files.keys()].filter((key) => key.startsWith(`${targetKey}\\`));
    if (descendants.length && !recursive) throw fsError('ENOTEMPTY', normalized);
    for (const key of descendants) {
      this.directories.delete(key);
      this.files.delete(key);
    }
    this.directories.delete(targetKey);
  }
}

test('standalone plugin install records durable Python and Node runtimes when paths contain spaces', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia runtime path with spaces-'));
  const cachePython = path.join(temporaryRoot, 'Codex Cache', 'python', 'bin', 'python3');
  const replacementPython = path.join(temporaryRoot, 'Replacement Python', 'python3');
  const cacheNode = path.join(temporaryRoot, 'Codex Cache', 'node', 'bin', 'node');
  const logPath = path.join(temporaryRoot, 'python-calls.log');
  await writeFakePython(cachePython);
  await linkOrCopyExecutable(process.execPath, cacheNode);
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(temporaryRoot, { recursive: true, force: true })));

  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  await nodeRuntime.ensurePersistentNodeLauncher({
    pluginRoot,
    nodeExecutable: cacheNode,
    fetchImpl: async () => new Response(
      'Node.js test distribution license\nCopyright Node.js contributors\n',
      { status: 200 },
    ),
  });

  const result = run(cacheNode, ['scripts/install-codex-plugin.mjs'], {
    env: {
      ...process.env,
      HOME: temporaryRoot,
      USERPROFILE: temporaryRoot,
      PYTHON: cachePython,
      FAKE_PYTHON_LOG: logPath,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const runtime = JSON.parse(await readFile(path.join(pluginRoot, 'imvia-layer-runtime.json'), 'utf8'));
  const mcpConfig = JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  const expectedPython = path.join(pluginRoot, '.python-runtime', 'bin', 'python');
  const expectedNode = path.join(pluginRoot, '.node-runtime', 'bin', 'node');
  assert.deepEqual(runtime.python, { command: expectedPython, args: [] });
  assert.equal(mcpConfig.mcpServers['imvia-layer'].command, expectedNode);
  await rm(cacheNode);
  await rm(cachePython);
  const nodeResult = run(expectedNode, ['--version']);
  assert.equal(nodeResult.status, 0, nodeResult.stderr || nodeResult.stdout);

  const importResult = run(runtime.python.command, [...runtime.python.args, '-c', 'import rembg']);
  assert.equal(importResult.status, 0, importResult.stderr || importResult.stdout);
  const verificationResult = run(process.execPath, ['scripts/verify-installed-runtime.mjs'], {
    env: { ...process.env, HOME: temporaryRoot, USERPROFILE: temporaryRoot },
  });
  assert.equal(verificationResult.status, 0, verificationResult.stderr || verificationResult.stdout);
  assert.match(verificationResult.stdout, /managed runtime verified/);

  const marker = JSON.parse(await readFile(path.join(pluginRoot, '.python-runtime', '.imvia-layer-runtime.json'), 'utf8'));
  assert.match(marker.lockSha256, /^[a-f0-9]{64}$/);
  assert.equal(marker.pythonVersion, '3.12');
  assert.equal(marker.pythonCacheTag, 'cpython-312');
  assert.equal(marker.platform, 'darwin');
  assert.equal(marker.architecture, 'arm64');
  assert.equal(marker.installPolicy, 'wheel-only-require-hashes-v1');
  assert.equal('requirementsSha256' in marker, false);
  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const pipInstall = calls.find(({ args }) => args[0] === '-m' && args[1] === 'pip' && args[2] === 'install');
  assert.ok(pipInstall);
  assert.equal(pipInstall.args.includes('--require-hashes'), true);
  assert.equal(pipInstall.args.includes('--only-binary=:all:'), true);
  assert.equal(pipInstall.args.at(-1), path.join(root, 'requirements-rmbg.lock'));
  assert.equal(calls.some(({ args }) => args[0] === '-c' && args[1].includes('importlib.metadata.distribution')), true);

  await rm(expectedPython);
  await writeFakePython(replacementPython);
  const bootstrapResult = run(expectedNode, [path.join(pluginRoot, 'scripts', 'start-mcp.mjs')], {
    env: {
      ...process.env,
      HOME: temporaryRoot,
      USERPROFILE: temporaryRoot,
      PYTHON: replacementPython,
      FAKE_PYTHON_LOG: logPath,
    },
    timeout: 20_000,
  });
  assert.equal(bootstrapResult.status, 0, bootstrapResult.stderr || bootstrapResult.stdout);
  assert.equal(bootstrapResult.stdout, '');
  assert.match(bootstrapResult.stderr, /Imvia Layer 插件已安装/);
  await access(expectedPython);
});

test('the managed runtime installs from a committed universal hashed lock', async () => {
  const lockPath = path.join(root, 'requirements-rmbg.lock');
  const exists = await access(lockPath).then(() => true, () => false);
  assert.equal(exists, true, 'requirements-rmbg.lock must be committed');
  const lock = await readFile(lockPath, 'utf8');
  assert.match(lock, /rembg==2\.0\.69/);
  assert.match(lock, /--hash=sha256:[a-f0-9]{64}/);
  assert.match(lock, /universal/iu);
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

test('Win32 injected filesystem and spawn publish, rollback, lock, and uninstall paths safely', async () => {
  const uninstallModuleUrl = new URL('../scripts/uninstall-codex-plugin.mjs', import.meta.url);
  const uninstallModule = await import(`${uninstallModuleUrl.href}?test=${Date.now()}`).catch(() => null);
  assert.equal(typeof uninstallModule?.uninstallLocalPlugin, 'function', 'an injectable uninstall flow must remove the managed runtime');

  const fileSystem = new FakeWindowsFileSystem();
  const repositoryRoot = 'C:\\Users\\Qing Mu\\Downloads\\Imvia Layer';
  const pluginRoot = 'C:\\Users\\Qing Mu\\plugins\\imvia-layer';
  const runtimeRoot = path.win32.join(pluginRoot, '.python-runtime');
  const runtimePython = path.win32.join(runtimeRoot, 'Scripts', 'python.exe');
  const outsideUnknown = 'C:\\Users\\Qing Mu\\plugins\\unknown-owner';
  await fileSystem.mkdir(repositoryRoot, { recursive: true });
  await fileSystem.mkdir(outsideUnknown, { recursive: true });
  await fileSystem.writeFile(path.win32.join(repositoryRoot, 'requirements-rmbg.lock'), [
    `rembg==2.0.69 ${'\\'}`,
    `    --hash=sha256:${'a'.repeat(64)}`,
    '',
  ].join('\n'));

  const calls = [];
  const runCommandImpl = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'py' && args[0] === '-3' && args[1] === '-c') return { stdout: '3.12\n', stderr: '' };
    if (command === 'py' && args[0] === '-3' && args[1] === '-m' && args[2] === 'venv') {
      await fileSystem.mkdir(path.win32.join(args[3], 'Scripts'), { recursive: true });
      await fileSystem.writeFile(path.win32.join(args[3], 'Scripts', 'python.exe'), 'fake');
      return { stdout: '', stderr: '' };
    }
    if (command.toLowerCase().endsWith('\\scripts\\python.exe')) {
      if (args[0] === '-c' && args[1].includes('pythonCacheTag')) {
        return { stdout: JSON.stringify({
          pythonVersion: '3.12',
          pythonCacheTag: 'cpython-312',
          platform: 'win32',
          architecture: 'AMD64',
        }), stderr: '' };
      }
      return { stdout: args[0] === '-c' && args[1].includes('rembg') ? '2.0.69\n' : '', stderr: '' };
    }
    throw fsError('ENOENT', command);
  };
  const options = {
    repositoryRoot,
    pluginRoot,
    fileSystem,
    runCommandImpl,
    platform: 'win32',
    nodeExecutable: 'C:\\Codex App\\dependencies\\node\\node.exe',
    env: {},
    pid: 123,
    now: () => 456,
    token: 'aabbccddeeff',
    lockAlreadyHeld: true,
  };
  const installed = await pythonRuntime.ensurePersistentPythonRuntime(options);
  assert.equal(installed.command, runtimePython);
  assert.deepEqual(calls.find(({ command, args }) => command === 'py' && args[1] === '-m'), {
    command: 'py',
    args: ['-3', '-m', 'venv', `${runtimeRoot}.staging-123-456-aabbccddeeff`],
  });
  await assert.rejects(fileSystem.access(path.win32.join(pluginRoot, '.python-runtime.lock')), { code: 'ENOENT' });

  await fileSystem.writeFile(path.win32.join(runtimeRoot, 'old-runtime.txt'), 'keep');
  await fileSystem.writeFile(path.win32.join(repositoryRoot, 'requirements-rmbg.lock'), [
    `rembg==2.0.70 ${'\\'}`,
    `    --hash=sha256:${'b'.repeat(64)}`,
    '',
  ].join('\n'));
  fileSystem.failPublishTo = runtimeRoot;
  await assert.rejects(pythonRuntime.ensurePersistentPythonRuntime({ ...options, token: '112233445566' }), /simulated Windows publish rename failure/);
  assert.equal(await fileSystem.readFile(path.win32.join(runtimeRoot, 'old-runtime.txt'), 'utf8'), 'keep');
  assert.equal((await fileSystem.readdir(pluginRoot)).some((name) => name.startsWith('.python-runtime.staging-')), false);

  await uninstallModule.uninstallLocalPlugin({ pluginRoot, fileSystem });
  await assert.rejects(fileSystem.access(runtimeRoot), { code: 'ENOENT' });
  await fileSystem.access(outsideUnknown);
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
  const fakePython = path.join(temporaryRoot, 'Python Base', 'python3');
  const logPath = path.join(temporaryRoot, 'python-calls.log');
  await writeTestRequirements(repositoryRoot);
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
  assert.equal(reuseCalls.some(({ args }) => args[0] === '-m' && (args[1] === 'venv' || (args[1] === 'pip' && args[2] === 'install'))), false);

  await writeTestRequirements(repositoryRoot, '2.0.70');
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
  assert.notEqual(updated.lockSha256, first.lockSha256);
  await assert.rejects(readFile(sentinelPath), { code: 'ENOENT' });
});

test('rembg verification and unsupported configured Python fail with actionable errors', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia runtime errors-'));
  const repositoryRoot = path.join(temporaryRoot, 'repository');
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const fakePython = path.join(temporaryRoot, 'Python Base', 'python3');
  await writeTestRequirements(repositoryRoot);
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
  await nodeRuntime.ensurePersistentNodeLauncher({
    pluginRoot: path.join(temporaryRoot, 'plugins', 'imvia-layer'),
    nodeExecutable: process.execPath,
    fetchImpl: async () => new Response(
      'Node.js test distribution license\nCopyright Node.js contributors\n',
      { status: 200 },
    ),
  });

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
  const pipCalls = calls.filter(({ args }) => args[0] === '-m' && args[1] === 'pip' && args[2] === 'install');
  assert.ok(pipCalls.length >= 1);
  assert.equal(pipCalls.every(({ command }) => command !== fakePython), true);
  assert.equal(pipCalls.every(({ command }) => command.includes(`${path.sep}.python-runtime.staging-`)), true);
  const warmCalls = calls.filter(({ args }) => args[0].endsWith('scripts/warm-rmbg.py'));
  assert.equal(warmCalls.length, 1);
  assert.equal(warmCalls[0].command, runtime.python.command);
});

test('concurrent runtime ensures publish exactly one managed environment', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia concurrent runtime-'));
  const repositoryRoot = path.join(temporaryRoot, 'repository');
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const fakePython = path.join(temporaryRoot, 'Python Base', 'python3');
  const logPath = path.join(temporaryRoot, 'python-calls.log');
  await writeTestRequirements(repositoryRoot);
  await writeFakePython(fakePython);
  t.after(() => realFileSystem.rm(temporaryRoot, { recursive: true, force: true }));

  const options = {
    repositoryRoot,
    pluginRoot,
    env: { ...process.env, PYTHON: fakePython, FAKE_PYTHON_LOG: logPath, FAKE_PIP_DELAY_MS: '200' },
    platform: 'darwin',
    nodeExecutable: process.execPath,
    lockTimeoutMs: 3_000,
    lockPollMs: 10,
  };
  const firstPromise = pythonRuntime.ensurePersistentPythonRuntime(options);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const [first, second] = await Promise.all([
    firstPromise,
    pythonRuntime.ensurePersistentPythonRuntime(options),
  ]);
  assert.deepEqual(second, first);

  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.filter(({ args }) => args[0] === '-m' && args[1] === 'venv').length, 1);
  assert.equal(calls.filter(({ args }) => args[0] === '-m' && args[1] === 'pip' && args[2] === 'install').length, 1);
});

test('startup restores the only Imvia backup after a crash and removes only owned stale paths', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia crash recovery-'));
  const repositoryRoot = path.join(temporaryRoot, 'repository');
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const fakePython = path.join(temporaryRoot, 'Python Base', 'python3');
  await writeTestRequirements(repositoryRoot);
  await writeFakePython(fakePython);
  t.after(() => realFileSystem.rm(temporaryRoot, { recursive: true, force: true }));
  const options = {
    repositoryRoot,
    pluginRoot,
    env: { ...process.env, PYTHON: fakePython },
    platform: 'darwin',
    nodeExecutable: process.execPath,
  };
  await pythonRuntime.ensurePersistentPythonRuntime(options);

  const runtimeRoot = path.join(pluginRoot, '.python-runtime');
  const backupRoot = `${runtimeRoot}.backup-777-1000-aabbccddeeff`;
  const staleStage = `${runtimeRoot}.staging-888-1000-aabbccddeeff`;
  const unknownDirectory = path.join(pluginRoot, '.python-runtime.backup-not-imvia-owned');
  await writeFile(path.join(runtimeRoot, 'survives-crash.txt'), 'old valid runtime');
  await rename(runtimeRoot, backupRoot);
  await mkdir(staleStage, { recursive: true });
  await mkdir(unknownDirectory, { recursive: true });
  const lockTarget = path.join(pluginRoot, '.imvia-runtime-install');
  const orphanedLock = `${lockTarget}.lock`;
  await writeFile(lockTarget, '');
  await mkdir(orphanedLock);
  const staleDate = new Date(Date.now() - 30_000);
  await realFileSystem.utimes(orphanedLock, staleDate, staleDate);

  await pythonRuntime.ensurePersistentPythonRuntime({
    ...options,
    runtimeLockOptions: { stale: 5_000, update: 1_000 },
  });
  assert.equal(await readFile(path.join(runtimeRoot, 'survives-crash.txt'), 'utf8'), 'old valid runtime');
  const entries = await readdir(pluginRoot);
  assert.equal(entries.includes(path.basename(backupRoot)), false);
  assert.equal(entries.includes(path.basename(staleStage)), false);
  assert.equal(entries.includes(path.basename(unknownDirectory)), true);
  await assert.rejects(access(orphanedLock), { code: 'ENOENT' });
});

test('publish rename failure restores the previous runtime and removes staging', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia rename rollback-'));
  const repositoryRoot = path.join(temporaryRoot, 'repository');
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const fakePython = path.join(temporaryRoot, 'Python Base', 'python3');
  await writeTestRequirements(repositoryRoot);
  await writeFakePython(fakePython);
  t.after(() => realFileSystem.rm(temporaryRoot, { recursive: true, force: true }));
  const options = {
    repositoryRoot,
    pluginRoot,
    env: { ...process.env, PYTHON: fakePython },
    platform: 'darwin',
    nodeExecutable: process.execPath,
  };
  await pythonRuntime.ensurePersistentPythonRuntime(options);
  const runtimeRoot = path.join(pluginRoot, '.python-runtime');
  await writeFile(path.join(runtimeRoot, 'previous-runtime.txt'), 'keep');
  await writeTestRequirements(repositoryRoot, '2.0.70');

  let injected = false;
  const faultingFileSystem = {
    ...realFileSystem,
    async rename(from, to) {
      if (!injected && from.includes('.python-runtime.staging-') && to === runtimeRoot) {
        injected = true;
        const error = new Error('simulated publish rename failure');
        error.code = 'EACCES';
        throw error;
      }
      return realFileSystem.rename(from, to);
    },
  };
  await assert.rejects(
    pythonRuntime.ensurePersistentPythonRuntime({ ...options, fileSystem: faultingFileSystem }),
    /simulated publish rename failure/,
  );
  assert.equal(await readFile(path.join(runtimeRoot, 'previous-runtime.txt'), 'utf8'), 'keep');
  assert.equal((await readdir(pluginRoot)).some((name) => name.startsWith('.python-runtime.staging-')), false);
});
