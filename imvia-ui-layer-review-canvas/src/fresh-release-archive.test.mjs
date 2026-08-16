import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensurePersistentNodeLauncher } from '../scripts/node-runtime.mjs';

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

async function copyTrackedApplication(destinationRoot) {
  const { stdout } = await run('git', ['ls-files', '-z', '--', applicationDirectoryName], {
    cwd: repositoryRoot,
  });
  const trackedPaths = stdout.split('\0').filter(Boolean);
  assert.ok(trackedPaths.length > 0, 'tracked archive should contain application files');
  for (const trackedPath of trackedPaths) {
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
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fresh-archive-test', version: '1.0.0' } },
  })}\n`);
  const deadline = Date.now() + 10_000;
  while (!stdout.includes('"id":1')) {
    if (child.exitCode !== null) throw new Error(`MCP exited before initialize: ${stderr || stdout}`);
    if (Date.now() >= deadline) throw new Error(`MCP initialize timed out: ${stderr || stdout}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.stdin.end();
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  assert.doesNotMatch(stderr, /ENOENT/);
}

test('a clean tracked archive setup and update build a fresh bundle before MCP import', { timeout: 300_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia clean archive-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const archiveRoot = path.join(temporaryRoot, applicationDirectoryName);
  const homeRoot = path.join(temporaryRoot, 'home');
  const pluginRoot = path.join(homeRoot, 'plugins', 'imvia-layer');
  const fakePython = path.join(temporaryRoot, 'python', 'python3');
  const npmCache = path.join(temporaryRoot, 'npm-cache');
  await copyTrackedApplication(archiveRoot);
  if (process.platform !== 'win32') await writeFakePython(fakePython);
  const sourceNpmCache = process.env.npm_config_cache || path.join(os.homedir(), '.npm');
  await mkdir(npmCache, { recursive: true });
  await cp(path.join(sourceNpmCache, '_cacache'), path.join(npmCache, '_cacache'), { recursive: true });
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
    ...(process.platform === 'win32' ? { IMVIA_LAYER_SKIP_MODEL_PREWARM: '1' } : {}),
  };
  await run('npm', ['run', 'setup'], { cwd: archiveRoot, env });
  const distIndexPath = path.join(archiveRoot, 'dist', 'index.html');
  assert.match(await readFile(distIndexPath, 'utf8'), /<script[^>]+assets\/index-/);

  await writeFile(distIndexPath, 'STALE-BUNDLE-MUST-NOT-SURVIVE');
  await run('npm', ['run', 'update'], { cwd: archiveRoot, env });
  assert.doesNotMatch(await readFile(distIndexPath, 'utf8'), /STALE-BUNDLE-MUST-NOT-SURVIVE/);

  const hash = (contents) => createHash('sha256').update(contents).digest('hex');
  for (const relativePath of ['LICENSE', 'NOTICE.md', path.join('.codex-plugin', 'plugin.json')]) {
    assert.equal(
      hash(await readFile(path.join(pluginRoot, relativePath))),
      hash(await readFile(path.join(archiveRoot, 'plugin-template', 'imvia-layer', relativePath))),
      `${relativePath} should retain installation hash parity`,
    );
  }

  const mcpConfig = JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8')).mcpServers['imvia-layer'];
  await initializeMcp(mcpConfig.command, mcpConfig.args, mcpConfig.cwd, env);
});
