// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as realFileSystem from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const VERSION_PROBE = 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")';
const REMBG_PROBE = 'import importlib.metadata; import rembg; print(importlib.metadata.version("rembg"))';
const ENVIRONMENT_PROBE = `
import json
import platform
import sys
print(json.dumps({
    "pythonVersion": f"{sys.version_info.major}.{sys.version_info.minor}",
    "pythonCacheTag": sys.implementation.cache_tag,
    "platform": sys.platform,
    "architecture": platform.machine(),
}))
`;
const LOCK_DISTRIBUTION_PROBE = `
import importlib.metadata
import pathlib
import re
import sys
from packaging.requirements import Requirement

logical_lines = []
buffer = ""
for raw_line in pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    stripped = raw_line.strip()
    if not stripped or stripped.startswith("#"):
        continue
    continued = stripped.endswith("\\\\")
    fragment = stripped[:-1].rstrip() if continued else stripped
    buffer = f"{buffer} {fragment}".strip()
    if not continued:
        logical_lines.append(buffer)
        buffer = ""

errors = []
for locked_line in logical_lines:
    requirement_text = re.split(r"\\s+--hash=", locked_line, maxsplit=1)[0].strip()
    if not requirement_text or requirement_text.startswith("-"):
        continue
    requirement = Requirement(requirement_text)
    if requirement.marker and not requirement.marker.evaluate():
        continue
    try:
        installed = importlib.metadata.distribution(requirement.name).version
    except importlib.metadata.PackageNotFoundError:
        errors.append(f"{requirement.name} is not installed")
        continue
    if installed not in requirement.specifier:
        errors.append(f"{requirement.name}=={installed} does not satisfy {requirement.specifier}")
if errors:
    raise SystemExit("; ".join(errors))
print("locked distributions verified")
`;
const OWNED_TRANSIENT_PATTERN = /^\.python-runtime\.(?:staging|backup)-\d+-\d+(?:-[a-f0-9]{12})?$/;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

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

async function probePython(candidate, options, runCommandImpl = runCommand) {
  try {
    const result = await runCommandImpl(candidate.command, [...candidate.args, '-c', VERSION_PROBE], options);
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

async function resolveBasePython({ cwd, env, platform, nodeExecutable, runCommandImpl }) {
  const configured = env.PYTHON?.trim();
  const candidates = pythonCandidates({ configuredPython: configured, nodeExecutable, platform });
  for (const candidate of candidates) {
    const resolved = await probePython(candidate, { cwd, env }, runCommandImpl);
    if (resolved) return resolved;
  }
  const prefix = configured ? `PYTHON=${configured} 不可用或版本低于 3.10` : '未找到 Python 3.10+';
  throw new Error(`${prefix}。请安装 Python 3.10+，或设置 PYTHON 指向可用的 Python 可执行文件后重试。`);
}

async function verifyRmbg(pythonCommand, { cwd, env, runCommandImpl = runCommand }) {
  try {
    await runCommandImpl(pythonCommand, ['-c', REMBG_PROBE], { cwd, env });
  } catch (error) {
    throw new Error(`RMBG 依赖验证失败（${pythonCommand}无法 import rembg）：${error.message}`);
  }
}

async function probeManagedEnvironment(pythonCommand, { cwd, env, runCommandImpl = runCommand }) {
  const result = await runCommandImpl(pythonCommand, ['-c', ENVIRONMENT_PROBE], { cwd, env });
  let fingerprint;
  try {
    fingerprint = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`Python runtime 环境指纹不可解析：${result.stdout.trim() || '<empty>'}`);
  }
  if (!supportedVersion(fingerprint.pythonVersion)) {
    throw new Error(`Python runtime 版本低于 3.10：${fingerprint.pythonVersion || '<unknown>'}`);
  }
  for (const field of ['pythonCacheTag', 'platform', 'architecture']) {
    if (typeof fingerprint[field] !== 'string' || !fingerprint[field]) {
      throw new Error(`Python runtime 缺少环境指纹字段：${field}`);
    }
  }
  return fingerprint;
}

async function verifyLockedDistributions(pythonCommand, lockPath, { cwd, env, runCommandImpl = runCommand }) {
  try {
    await runCommandImpl(pythonCommand, ['-m', 'pip', 'check'], { cwd, env });
    await runCommandImpl(pythonCommand, ['-c', LOCK_DISTRIBUTION_PROBE, lockPath], { cwd, env });
  } catch (error) {
    throw new Error(`RMBG lock 与已安装 distributions 验证失败：${error.message}`);
  }
}

function markerMatches(marker, lockSha256, fingerprint) {
  return marker?.lockSha256 === lockSha256
    && marker.pythonVersion === fingerprint.pythonVersion
    && marker.pythonCacheTag === fingerprint.pythonCacheTag
    && marker.platform === fingerprint.platform
    && marker.architecture === fingerprint.architecture;
}

async function requirementsHash(requirementsPath, fileSystem) {
  return createHash('sha256').update(await fileSystem.readFile(requirementsPath)).digest('hex');
}

async function readMarker(markerPath, fileSystem) {
  try {
    return JSON.parse(await fileSystem.readFile(markerPath, 'utf8'));
  } catch {
    return null;
  }
}

async function pathExists(targetPath, fileSystem) {
  try {
    await fileSystem.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function ownedTransientNames(names, kind) {
  const prefix = `.python-runtime.${kind}-`;
  return names.filter((name) => name.startsWith(prefix) && OWNED_TRANSIENT_PATTERN.test(name));
}

async function recoverManagedRuntime({ pluginRoot, runtimeRoot, fileSystem, pathApi }) {
  let names = [];
  try {
    names = await fileSystem.readdir(pluginRoot);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const backups = ownedTransientNames(names, 'backup');
  const stages = ownedTransientNames(names, 'staging');
  let runtimeExists = await pathExists(runtimeRoot, fileSystem);

  if (!runtimeExists && backups.length === 1) {
    await fileSystem.rename(pathApi.join(pluginRoot, backups[0]), runtimeRoot);
    runtimeExists = true;
  } else if (!runtimeExists && backups.length > 1) {
    throw new Error(`Imvia Layer 发现多个可恢复 Python runtime backup，为避免误删已停止：${backups.join(', ')}`);
  }

  for (const name of stages) {
    await fileSystem.rm(pathApi.join(pluginRoot, name), { recursive: true, force: true });
  }
  if (runtimeExists) {
    for (const name of backups) {
      await fileSystem.rm(pathApi.join(pluginRoot, name), { recursive: true, force: true });
    }
  }
}

async function acquireManagedRuntimeLock({
  pluginRoot,
  fileSystem,
  pathApi,
  now,
  pid,
  token,
  lockTimeoutMs,
  lockPollMs,
  lockStaleMs,
  isProcessAlive,
  sleep,
}) {
  const lockRoot = pathApi.join(pluginRoot, '.python-runtime.lock');
  const ownerPath = pathApi.join(lockRoot, 'owner.json');
  const deadline = now() + lockTimeoutMs;
  await fileSystem.mkdir(pluginRoot, { recursive: true });

  while (true) {
    try {
      await fileSystem.mkdir(lockRoot);
      await fileSystem.writeFile(ownerPath, `${JSON.stringify({ pid, createdAtMs: now(), token }, null, 2)}\n`);
      return async () => {
        const owner = await readMarker(ownerPath, fileSystem);
        if (owner?.token === token) await fileSystem.rm(lockRoot, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const owner = await readMarker(ownerPath, fileSystem);
    let stale = false;
    if (owner && Number.isFinite(owner.createdAtMs)) {
      stale = now() - owner.createdAtMs > lockStaleMs && !isProcessAlive(owner.pid);
    } else {
      try {
        const metadata = await fileSystem.stat(lockRoot);
        stale = now() - metadata.mtimeMs > lockStaleMs;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
    }
    if (stale) {
      await fileSystem.rm(lockRoot, { recursive: true, force: true });
      continue;
    }
    if (now() >= deadline) {
      throw new Error(`等待 Imvia Layer Python runtime lock 超时（owner pid=${owner?.pid ?? 'unknown'}）`);
    }
    await sleep(lockPollMs);
  }
}

export async function ensurePersistentPythonRuntime({
  repositoryRoot,
  pluginRoot = path.join(os.homedir(), 'plugins', 'imvia-layer'),
  env = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath,
  fileSystem = realFileSystem,
  runCommandImpl = runCommand,
  now = Date.now,
  pid = process.pid,
  token = randomBytes(6).toString('hex'),
  lockTimeoutMs = 30_000,
  lockPollMs = 100,
  lockStaleMs = 5 * 60_000,
  isProcessAlive = processIsAlive,
  sleep = delay,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const lockPath = pathApi.join(repositoryRoot, 'requirements-rmbg.lock');
  const runtimeRoot = pathApi.join(pluginRoot, '.python-runtime');
  const runtimePython = runtimePythonPath(runtimeRoot, platform);
  const markerPath = pathApi.join(runtimeRoot, '.imvia-layer-runtime.json');
  const releaseLock = await acquireManagedRuntimeLock({
    pluginRoot,
    fileSystem,
    pathApi,
    now,
    pid,
    token,
    lockTimeoutMs,
    lockPollMs,
    lockStaleMs,
    isProcessAlive,
    sleep,
  });

  try {
    await recoverManagedRuntime({ pluginRoot, runtimeRoot, fileSystem, pathApi });
    const lockSha256 = await requirementsHash(lockPath, fileSystem);
    const currentMarker = await readMarker(markerPath, fileSystem);

    if (currentMarker?.lockSha256 === lockSha256) {
      try {
        const fingerprint = await probeManagedEnvironment(runtimePython, { cwd: repositoryRoot, env, runCommandImpl });
        if (markerMatches(currentMarker, lockSha256, fingerprint)) {
          await verifyRmbg(runtimePython, { cwd: repositoryRoot, env, runCommandImpl });
          await verifyLockedDistributions(runtimePython, lockPath, { cwd: repositoryRoot, env, runCommandImpl });
          return { command: runtimePython, args: [], version: fingerprint.pythonVersion, lockSha256 };
        }
      } catch {
        // Rebuild a missing or damaged managed runtime below.
      }
    }

    const base = await resolveBasePython({ cwd: repositoryRoot, env, platform, nodeExecutable, runCommandImpl });
    const suffix = `${pid}-${now()}-${token}`;
    const stagingRoot = `${runtimeRoot}.staging-${suffix}`;
    const backupRoot = `${runtimeRoot}.backup-${suffix}`;
    const stagingPython = runtimePythonPath(stagingRoot, platform);
    await fileSystem.mkdir(pluginRoot, { recursive: true });

    try {
      await runCommandImpl(base.command, [...base.args, '-m', 'venv', stagingRoot], { cwd: repositoryRoot, env, stdio: 'inherit' });
      try {
        const installResult = await runCommandImpl(stagingPython, ['-m', 'pip', 'install', '--require-hashes', '-r', lockPath], { cwd: repositoryRoot, env });
        if (installResult.stdout) process.stdout.write(installResult.stdout);
        if (installResult.stderr) process.stderr.write(installResult.stderr);
      } catch (error) {
        throw new Error(`RMBG 依赖安装失败：${error.message}`);
      }
      await verifyRmbg(stagingPython, { cwd: repositoryRoot, env, runCommandImpl });
      const fingerprint = await probeManagedEnvironment(stagingPython, { cwd: repositoryRoot, env, runCommandImpl });
      await verifyLockedDistributions(stagingPython, lockPath, { cwd: repositoryRoot, env, runCommandImpl });
      await fileSystem.writeFile(pathApi.join(stagingRoot, '.imvia-layer-runtime.json'), `${JSON.stringify({
        lockSha256,
        ...fingerprint,
      }, null, 2)}\n`);
    } catch (error) {
      await fileSystem.rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }

    let movedCurrent = false;
    try {
      await fileSystem.rename(runtimeRoot, backupRoot);
      movedCurrent = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await fileSystem.rm(stagingRoot, { recursive: true, force: true });
        throw error;
      }
    }

    try {
      await fileSystem.rename(stagingRoot, runtimeRoot);
    } catch (publishError) {
      let restoreError = null;
      if (movedCurrent) {
        try {
          await fileSystem.rename(backupRoot, runtimeRoot);
        } catch (error) {
          restoreError = error;
        }
      }
      await fileSystem.rm(stagingRoot, { recursive: true, force: true });
      if (restoreError) {
        throw new AggregateError(
          [publishError, restoreError],
          `Imvia Layer Python runtime 发布失败，旧 runtime 保留在 ${backupRoot}，下次安装将自动恢复`,
        );
      }
      throw publishError;
    }
    if (movedCurrent) await fileSystem.rm(backupRoot, { recursive: true, force: true });

    return { command: runtimePython, args: [], version: base.version, lockSha256 };
  } finally {
    try {
      await releaseLock();
    } catch (error) {
      process.stderr.write(`释放 Imvia Layer Python runtime lock 失败：${error.message}\n`);
    }
  }
}
