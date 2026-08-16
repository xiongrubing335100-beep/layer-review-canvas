// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as realFileSystem from 'node:fs/promises';
import path from 'node:path';

const OWNED_TRANSIENT_PATTERN = /^\.node-runtime\.(?:staging|backup)-\d+-\d+-[a-f0-9]{12}$/;

export function runtimeNodePath(runtimeRoot, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return platform === 'win32'
    ? pathApi.join(runtimeRoot, 'node.exe')
    : pathApi.join(runtimeRoot, 'bin', 'node');
}

function runCommand(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} --version failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function pathExists(targetPath, fileSystem) {
  try {
    await fileSystem.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(targetPath, fileSystem) {
  return createHash('sha256').update(await fileSystem.readFile(targetPath)).digest('hex');
}

async function readMarker(markerPath, fileSystem) {
  try {
    return JSON.parse(await fileSystem.readFile(markerPath, 'utf8'));
  } catch {
    return null;
  }
}

async function verifyNode(nodePath, { cwd, runCommandImpl, expectedSha256, fileSystem }) {
  const actualSha256 = await hashFile(nodePath, fileSystem);
  if (actualSha256 !== expectedSha256) throw new Error(`Node launcher SHA-256 mismatch: ${nodePath}`);
  const result = await runCommandImpl(nodePath, ['--version'], { cwd });
  const version = result.stdout.trim();
  if (!/^v\d+\.\d+\.\d+/.test(version)) throw new Error(`Node launcher version probe failed: ${version || '<empty>'}`);
  return version;
}

async function recoverNodeRuntime({ pluginRoot, runtimeRoot, fileSystem, pathApi }) {
  let names = [];
  try {
    names = await fileSystem.readdir(pluginRoot);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const owned = names.filter((name) => OWNED_TRANSIENT_PATTERN.test(name));
  const backups = owned.filter((name) => name.startsWith('.node-runtime.backup-'));
  const stages = owned.filter((name) => name.startsWith('.node-runtime.staging-'));
  let runtimeExists = await pathExists(runtimeRoot, fileSystem);
  if (!runtimeExists && backups.length === 1) {
    await fileSystem.rename(pathApi.join(pluginRoot, backups[0]), runtimeRoot);
    runtimeExists = true;
  } else if (!runtimeExists && backups.length > 1) {
    throw new Error(`Imvia Layer found multiple Node launcher backups and stopped safely: ${backups.join(', ')}`);
  }
  for (const name of stages) await fileSystem.rm(pathApi.join(pluginRoot, name), { recursive: true, force: true });
  if (runtimeExists) {
    for (const name of backups) await fileSystem.rm(pathApi.join(pluginRoot, name), { recursive: true, force: true });
  }
}

export async function ensurePersistentNodeLauncher({
  pluginRoot,
  nodeExecutable = process.execPath,
  platform = process.platform,
  architecture = process.arch,
  fileSystem = realFileSystem,
  runCommandImpl = runCommand,
  pid = process.pid,
  now = Date.now,
  token = randomBytes(6).toString('hex'),
} = {}) {
  if (!pluginRoot) throw new Error('Imvia Layer Node launcher requires pluginRoot');
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const runtimeRoot = pathApi.join(pluginRoot, '.node-runtime');
  const launcherPath = runtimeNodePath(runtimeRoot, platform);
  const markerPath = pathApi.join(runtimeRoot, '.imvia-layer-node.json');
  await fileSystem.mkdir(pluginRoot, { recursive: true });
  await recoverNodeRuntime({ pluginRoot, runtimeRoot, fileSystem, pathApi });

  const sourceSha256 = await hashFile(nodeExecutable, fileSystem);
  const marker = await readMarker(markerPath, fileSystem);
  if (marker?.sourceSha256 === sourceSha256
    && marker.platform === platform
    && marker.architecture === architecture) {
    try {
      const version = await verifyNode(launcherPath, {
        cwd: pluginRoot,
        runCommandImpl,
        expectedSha256: sourceSha256,
        fileSystem,
      });
      return { command: launcherPath, version, sourceSha256 };
    } catch {
      // Rebuild a missing or damaged launcher below.
    }
  }

  const suffix = `${pid}-${now()}-${token}`;
  const stagingRoot = `${runtimeRoot}.staging-${suffix}`;
  const backupRoot = `${runtimeRoot}.backup-${suffix}`;
  const stagingLauncher = runtimeNodePath(stagingRoot, platform);
  try {
    await fileSystem.mkdir(pathApi.dirname(stagingLauncher), { recursive: true });
    await fileSystem.copyFile(nodeExecutable, stagingLauncher);
    if (platform !== 'win32') await fileSystem.chmod(stagingLauncher, 0o755);
    const version = await verifyNode(stagingLauncher, {
      cwd: pluginRoot,
      runCommandImpl,
      expectedSha256: sourceSha256,
      fileSystem,
    });
    await fileSystem.writeFile(pathApi.join(stagingRoot, '.imvia-layer-node.json'), `${JSON.stringify({
      sourceSha256,
      version,
      platform,
      architecture,
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
    if (movedCurrent) await fileSystem.rename(backupRoot, runtimeRoot);
    await fileSystem.rm(stagingRoot, { recursive: true, force: true });
    throw publishError;
  }
  if (movedCurrent) await fileSystem.rm(backupRoot, { recursive: true, force: true });

  const publishedMarker = await readMarker(markerPath, fileSystem);
  return {
    command: launcherPath,
    version: publishedMarker.version,
    sourceSha256,
  };
}
