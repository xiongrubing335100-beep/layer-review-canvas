// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const VERSION_PROBE = 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")';
const REMBG_PROBE = 'import importlib.metadata; import rembg; print(importlib.metadata.version("rembg"))';

export function runCommand(command, args, { cwd, env = process.env, stdio = 'pipe', spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      shell: false,
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const detail = stderr.trim() || stdout.trim() || `退出码 ${code}`;
      reject(new Error(`${command} ${args.join(' ')} 执行失败：${detail}`));
    });
  });
}

export function runtimePythonPath(runtimeRoot, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return platform === 'win32'
    ? pathApi.join(runtimeRoot, 'Scripts', 'python.exe')
    : pathApi.join(runtimeRoot, 'bin', 'python');
}

function supportedVersion(output) {
  const match = output.trim().match(/^(\d+)\.(\d+)$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 10) ? `${major}.${minor}` : null;
}

async function probePython(candidate, options) {
  try {
    const result = await runCommand(candidate.command, [...candidate.args, '-c', VERSION_PROBE], options);
    const version = supportedVersion(result.stdout);
    return version ? { ...candidate, version } : null;
  } catch {
    return null;
  }
}

export function pythonCandidates({ configuredPython, nodeExecutable, platform = process.platform }) {
  if (configuredPython?.trim()) return [{ command: configuredPython.trim(), args: [] }];
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const executableDirectory = pathApi.dirname(nodeExecutable);
  const dependenciesRoot = pathApi.basename(executableDirectory).toLowerCase() === 'bin'
    ? pathApi.resolve(executableDirectory, '..', '..')
    : pathApi.resolve(executableDirectory, '..');
  const bundled = platform === 'win32'
    ? [
        pathApi.join(dependenciesRoot, 'python', 'python.exe'),
        pathApi.join(dependenciesRoot, 'python', 'Scripts', 'python.exe'),
        pathApi.join(dependenciesRoot, 'python', 'bin', 'python.exe'),
      ]
    : [pathApi.join(dependenciesRoot, 'python', 'bin', 'python3')];
  return [
    ...bundled.map((command) => ({ command, args: [] })),
    ...(platform === 'win32'
      ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }]
      : [{ command: 'python3', args: [] }, { command: 'python', args: [] }]),
  ];
}

async function resolveBasePython({ cwd, env, platform, nodeExecutable }) {
  const configured = env.PYTHON?.trim();
  const candidates = pythonCandidates({ configuredPython: configured, nodeExecutable, platform });
  for (const candidate of candidates) {
    const resolved = await probePython(candidate, { cwd, env });
    if (resolved) return resolved;
  }
  const prefix = configured ? `PYTHON=${configured} 不可用或版本低于 3.10` : '未找到 Python 3.10+';
  throw new Error(`${prefix}。请安装 Python 3.10+，或设置 PYTHON 指向可用的 Python 可执行文件后重试。`);
}

async function verifyRmbg(pythonCommand, { cwd, env }) {
  try {
    await runCommand(pythonCommand, ['-c', REMBG_PROBE], { cwd, env });
  } catch (error) {
    throw new Error(`RMBG 依赖验证失败（${pythonCommand}无法 import rembg）：${error.message}`);
  }
}

async function requirementsHash(requirementsPath) {
  return createHash('sha256').update(await readFile(requirementsPath)).digest('hex');
}

async function readMarker(markerPath) {
  try {
    return JSON.parse(await readFile(markerPath, 'utf8'));
  } catch {
    return null;
  }
}

export async function ensurePersistentPythonRuntime({
  repositoryRoot,
  pluginRoot = path.join(os.homedir(), 'plugins', 'imvia-layer'),
  env = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath,
} = {}) {
  const requirementsPath = path.join(repositoryRoot, 'requirements-rmbg.txt');
  const expectedHash = await requirementsHash(requirementsPath);
  const runtimeRoot = path.join(pluginRoot, '.python-runtime');
  const runtimePython = runtimePythonPath(runtimeRoot, platform);
  const markerPath = path.join(runtimeRoot, '.imvia-layer-runtime.json');
  const currentMarker = await readMarker(markerPath);

  if (currentMarker?.requirementsSha256 === expectedHash) {
    try {
      const versionResult = await runCommand(runtimePython, ['-c', VERSION_PROBE], { cwd: repositoryRoot, env });
      const version = supportedVersion(versionResult.stdout);
      if (version) {
        await verifyRmbg(runtimePython, { cwd: repositoryRoot, env });
        return { command: runtimePython, args: [], version, requirementsSha256: expectedHash };
      }
    } catch {
      // Rebuild a missing or damaged managed runtime below.
    }
  }

  const base = await resolveBasePython({ cwd: repositoryRoot, env, platform, nodeExecutable });
  const suffix = `${process.pid}-${Date.now()}`;
  const stagingRoot = `${runtimeRoot}.staging-${suffix}`;
  const backupRoot = `${runtimeRoot}.backup-${suffix}`;
  const stagingPython = runtimePythonPath(stagingRoot, platform);
  await mkdir(pluginRoot, { recursive: true });

  try {
    await runCommand(base.command, [...base.args, '-m', 'venv', stagingRoot], { cwd: repositoryRoot, env, stdio: 'inherit' });
    try {
      const installResult = await runCommand(stagingPython, ['-m', 'pip', 'install', '-r', requirementsPath], { cwd: repositoryRoot, env });
      if (installResult.stdout) process.stdout.write(installResult.stdout);
      if (installResult.stderr) process.stderr.write(installResult.stderr);
    } catch (error) {
      throw new Error(`RMBG 依赖安装失败：${error.message}`);
    }
    await verifyRmbg(stagingPython, { cwd: repositoryRoot, env });
    await writeFile(path.join(stagingRoot, '.imvia-layer-runtime.json'), `${JSON.stringify({
      requirementsSha256: expectedHash,
      pythonVersion: base.version,
    }, null, 2)}\n`);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  let movedCurrent = false;
  try {
    await rename(runtimeRoot, backupRoot);
    movedCurrent = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }

  try {
    await rename(stagingRoot, runtimeRoot);
  } catch (error) {
    if (movedCurrent) await rename(backupRoot, runtimeRoot);
    throw error;
  }
  if (movedCurrent) await rm(backupRoot, { recursive: true, force: true });

  return { command: runtimePython, args: [], version: base.version, requirementsSha256: expectedHash };
}
