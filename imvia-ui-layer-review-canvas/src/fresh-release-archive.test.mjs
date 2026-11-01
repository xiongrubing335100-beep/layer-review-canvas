import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensurePersistentNodeLauncher } from '../scripts/node-runtime.mjs';
import { resolveNpmCacheDirectory, runNpmCommand } from './fixtures/npm-cache-directory.mjs';

const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(applicationRoot, '..');
const applicationDirectoryName = path.basename(applicationRoot);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function copyReleaseCandidateApplication(destinationRoot) {
  // Verify the current candidate before it is committed. This is intentionally
  // not a claim about HEAD: new source files are part of the candidate too.
  const { stdout } = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', applicationDirectoryName], {
    cwd: repositoryRoot,
  });
  const candidatePaths = [...new Set(stdout.split('\0').filter(Boolean))];
  assert.ok(candidatePaths.length > 0, 'source release candidate should contain application files');
  for (const trackedPath of candidatePaths) {
    const relativePath = path.relative(applicationDirectoryName, trackedPath);
    const destination = path.join(destinationRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repositoryRoot, trackedPath), destination);
  }
}

async function writeFakePython(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '-c' && args[1].includes('pythonCacheTag')) {
  process.stdout.write(JSON.stringify({ pythonVersion: '3.12', pythonCacheTag: 'cpython-312', platform: process.platform, architecture: process.arch }) + '\\n');
} else if (args[0] === '-c' && args[1].includes('version_info')) {
  process.stdout.write('3.12\\n');
} else if (args[0] === '-m' && args[1] === 'venv') {
  const runtimePython = path.join(args[2], process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  fs.mkdirSync(path.dirname(runtimePython), { recursive: true });
  fs.copyFileSync(process.argv[1], runtimePython);
  if (process.platform !== 'win32') fs.chmodSync(runtimePython, 0o755);
} else if (args[0] === '-c' && args[1].includes('importlib.metadata.distribution')) {
  process.stdout.write('locked distributions verified\\n');
} else if (args[0] === '-c' && args[1].includes('rembg')) {
  process.stdout.write('2.0.69\\n');
} else if (args[0] === '-m' && args[1] === 'pip') {
  process.exitCode = 0;
} else if (args[0].endsWith('scripts/warm-rmbg.py')) {
  process.exitCode = 0;
} else {
  process.stderr.write('unexpected fake Python args: ' + JSON.stringify(args));
  process.exitCode = 2;
}
`);
  await chmod(filePath, 0o755);
}

async function initializeMcp(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let launchError;
  child.once('error', (error) => { launchError = error; });
  const completion = new Promise((resolve) => child.once('close', resolve));
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fresh-archive-test', version: '1.0.0' } },
  })}\n`);
  try {
    const deadline = Date.now() + 10_000;
    while (!stdout.includes('"id":1')) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode) {
        throw new Error(`MCP exited before initialize (exit ${child.exitCode}, signal ${child.signalCode}): ${stderr || stdout}`);
      }
      if (Date.now() >= deadline) throw new Error(`MCP initialize timed out: ${stderr || stdout}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const initialized = stdout.trim().split('\n').map((line) => JSON.parse(line)).find((message) => message.id === 1);
    assert.ok(initialized?.result?.serverInfo, `MCP initialize must succeed: ${stdout}`);
    assert.doesNotMatch(stderr, /ENOENT/);
  } finally {
    child.stdin.end();
    if (child.exitCode === null && !child.signalCode) child.kill();
    await completion;
  }
}

test('npm cache discovery accepts the absolute path reported by npm.cmd on Windows', async () => {
  const calls = [];
  const env = {};
  const cacheDirectory = await resolveNpmCacheDirectory({
    env,
    platform: 'win32',
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'C:\\Users\\runner\\AppData\\Local\\npm-cache\r\n' };
    },
  });

  assert.equal(cacheDirectory, 'C:\\Users\\runner\\AppData\\Local\\npm-cache');
  assert.deepEqual(calls, [{
    command: 'npm.cmd',
    args: ['config', 'get', 'cache'],
    options: { env, shell: true },
  }]);
});

test('npm lifecycle commands use npm.cmd through the Windows command shell', async () => {
  const calls = [];
  const env = { PATH: 'C:\\node' };
  const result = await runNpmCommand(['run', 'setup'], {
    cwd: 'C:\\release archive',
    env,
    platform: 'win32',
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'setup complete\n', stderr: '' };
    },
  });

  assert.deepEqual(result, { stdout: 'setup complete\n', stderr: '' });
  assert.deepEqual(calls, [{
    command: 'npm.cmd',
    args: ['run', 'setup'],
    options: {
      cwd: 'C:\\release archive',
      env,
      shell: true,
    },
  }]);
});

test('npm cache discovery does not require HOME or npm_config_cache', async () => {
  const cacheDirectory = await resolveNpmCacheDirectory({
    env: {},
    platform: 'linux',
    runCommand: async () => ({ stdout: '/var/tmp/npm-cache\n' }),
  });

  assert.equal(cacheDirectory, '/var/tmp/npm-cache');
});

test('a clean current working tree release candidate runs real npm ci, setup, update and installed MCP', { timeout: 300_000 }, async (t) => {
  const startedAt = Date.now();
  const checkpoint = name => t.diagnostic(`fresh archive (${Date.now() - startedAt}ms): ${name}`);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia clean archive-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const archiveRoot = path.join(temporaryRoot, applicationDirectoryName);
  const homeRoot = path.join(temporaryRoot, 'home');
  const pluginRoot = path.join(homeRoot, 'plugins', 'imvia-layer');
  const fakePython = path.join(temporaryRoot, 'python', 'python3');
  await copyReleaseCandidateApplication(archiveRoot);
  checkpoint('source copied');
  if (process.platform !== 'win32') await writeFakePython(fakePython);
  const npmCache = await resolveNpmCacheDirectory();
  // The source archive is clean; copying an already warm cache does not make
  // npm ci any fresher. Reuse its integrity-checked entries without a slow tree copy.
  await mkdir(npmCache, { recursive: true });
  checkpoint('offline npm cache ready');
  await ensurePersistentNodeLauncher({
    pluginRoot,
    nodeExecutable: process.execPath,
    fetchImpl: async () => new Response(
      'Node.js test distribution license\nCopyright Node.js contributors\n',
      { status: 200 },
    ),
  });

  const pythonCommand = process.platform === 'win32' ? (process.env.PYTHON || 'python') : fakePython;
  const pipCache = process.platform === 'win32'
    ? (await run(pythonCommand, ['-m', 'pip', 'cache', 'dir'])).stdout.trim()
    : null;
  const executablePath = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`;
  const env = {
    ...process.env,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    PYTHON: pythonCommand,
    PATH: executablePath,
    npm_config_cache: npmCache,
    npm_config_offline: 'true',
    ...(pipCache ? { PIP_CACHE_DIR: pipCache } : {}),
    ...(process.env.IMVIA_TEST_WHEELHOUSE ? {
      PIP_NO_INDEX: '1', PIP_FIND_LINKS: process.env.IMVIA_TEST_WHEELHOUSE,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    } : {}),
    ...(process.platform === 'win32' ? { IMVIA_LAYER_SKIP_MODEL_PREWARM: '1' } : {}),
  };
  await runNpmCommand(['run', 'setup'], { cwd: archiveRoot, env,
    onOutput: chunk => process.stdout.write(`[fresh setup] ${chunk}`) });
  checkpoint('setup finished');
  const distIndexPath = path.join(archiveRoot, 'dist', 'index.html');
  assert.match(await readFile(distIndexPath, 'utf8'), /<script[^>]+assets\/index-/);

  await writeFile(distIndexPath, 'STALE-BUNDLE-MUST-NOT-SURVIVE');
  await runNpmCommand(['run', 'update'], { cwd: archiveRoot, env,
    onOutput: chunk => process.stdout.write(`[fresh update] ${chunk}`) });
  checkpoint('update finished');
  assert.doesNotMatch(await readFile(distIndexPath, 'utf8'), /STALE-BUNDLE-MUST-NOT-SURVIVE/);

  const hash = (contents) => createHash('sha256').update(contents).digest('hex');
  for (const relativePath of [
    'LICENSE', 'NOTICE.md', path.join('.codex-plugin', 'plugin.json'),
    'skills/imvia-layer-batch-v2/SKILL.md',
    'skills/imvia-layer-batch-v2/references/item-contract.md',
  ]) {
    assert.equal(
      hash(await readFile(path.join(pluginRoot, relativePath))),
      hash(await readFile(path.join(archiveRoot, 'plugin-template', 'imvia-layer', relativePath))),
      `${relativePath} should retain installation hash parity`,
    );
  }

  const mcpConfig = JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8')).mcpServers['imvia-layer'];
  const runtimeConfig = JSON.parse(await readFile(path.join(pluginRoot, 'imvia-layer-runtime.json'), 'utf8'));
  assert.equal(runtimeConfig.workbenchRoot, path.join(pluginRoot, 'runtime'));
  await rename(archiveRoot, `${archiveRoot}-unavailable`);
  await initializeMcp(mcpConfig.command, mcpConfig.args, temporaryRoot, env);
  checkpoint('installed MCP initialized after source removal');
});
