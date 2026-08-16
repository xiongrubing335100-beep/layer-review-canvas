// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as realFileSystem from 'node:fs/promises';
import path from 'node:path';
import { withRuntimeInstallLock } from './runtime-install-lock.mjs';

const OWNED_TRANSIENT_PATTERN = /^\.node-runtime\.(?:staging|backup)-\d+-\d+-[a-f0-9]{12}$/;
const NODE_LICENSE_ORIGIN = 'https://api.github.com';
const NODE_LICENSE_MAX_BYTES = 2 * 1024 * 1024;
const NODE_LICENSE_TIMEOUT_MS = 15_000;
const NODE_LICENSE_MAX_REDIRECTS = 3;

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

function parseNodeVersion(output) {
  const version = output.trim();
  return /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

async function probeNodeVersion(nodePath, { cwd, runCommandImpl }) {
  const result = await runCommandImpl(nodePath, ['--version'], { cwd });
  const version = parseNodeVersion(result.stdout);
  if (!version) throw new Error(`Node launcher version probe failed: ${result.stdout.trim() || '<empty>'}`);
  return version;
}

async function verifyNode(nodePath, {
  cwd,
  runCommandImpl,
  expectedSha256,
  expectedNodeVersion,
  fileSystem,
}) {
  const actualSha256 = await hashFile(nodePath, fileSystem);
  if (actualSha256 !== expectedSha256) throw new Error(`Node launcher SHA-256 mismatch: ${nodePath}`);
  const nodeVersion = await probeNodeVersion(nodePath, { cwd, runCommandImpl });
  if (nodeVersion !== expectedNodeVersion) {
    throw new Error(`Node launcher version mismatch: expected ${expectedNodeVersion}, received ${nodeVersion}`);
  }
  return nodeVersion;
}

function officialLicenseUrl(nodeVersion) {
  return `${NODE_LICENSE_ORIGIN}/repos/nodejs/node/contents/LICENSE?ref=${encodeURIComponent(nodeVersion)}`;
}

function validateOfficialLicenseUrl(candidate, nodeVersion) {
  const url = new URL(candidate);
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.port || url.username || url.password) {
    throw new Error(`Node LICENSE redirect must stay on the official api.github.com HTTPS host: ${url.href}`);
  }
  const expectedPath = '/repos/nodejs/node/contents/LICENSE';
  if (url.pathname !== expectedPath
    || url.searchParams.size !== 1
    || url.searchParams.get('ref') !== nodeVersion
    || url.hash) {
    throw new Error(`Node LICENSE redirect version mismatch: expected ref=${nodeVersion}, received ${url.pathname}${url.search}`);
  }
  return url;
}

async function readBoundedResponse(response, maximumBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Node LICENSE exceeds ${maximumBytes} byte safety limit`);
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error(`Node LICENSE exceeds ${maximumBytes} byte safety limit`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }

  const contents = Buffer.from(await response.arrayBuffer());
  if (contents.length > maximumBytes) throw new Error(`Node LICENSE exceeds ${maximumBytes} byte safety limit`);
  return contents;
}

async function fetchOfficialNodeLicense({
  nodeVersion,
  fetchImpl,
  timeoutMs,
  maximumBytes,
  maximumRedirects,
}) {
  const licenseSource = officialLicenseUrl(nodeVersion);
  let currentUrl = validateOfficialLicenseUrl(licenseSource, nodeVersion);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount += 1) {
      let response;
      try {
        response = await fetchImpl(currentUrl, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: 'application/vnd.github.raw+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
      } catch (error) {
        const reason = error.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : error.message;
        throw new Error(`unable to fetch Node ${nodeVersion} LICENSE from ${licenseSource}: ${reason}`, { cause: error });
      }

      if (response.status >= 300 && response.status < 400) {
        if (redirectCount === maximumRedirects) {
          throw new Error(`Node ${nodeVersion} LICENSE exceeded ${maximumRedirects} redirects`);
        }
        const location = response.headers?.get?.('location');
        if (!location) throw new Error(`Node ${nodeVersion} LICENSE redirect omitted Location`);
        currentUrl = validateOfficialLicenseUrl(new URL(location, currentUrl), nodeVersion);
        continue;
      }
      if (response.status !== 200) {
        throw new Error(`unable to fetch Node ${nodeVersion} LICENSE from ${licenseSource}: HTTP ${response.status}`);
      }

      const contents = await readBoundedResponse(response, maximumBytes);
      const licenseText = contents.toString('utf8');
      if (!licenseText.includes('Node.js') || !licenseText.includes('Copyright')) {
        throw new Error(`Node ${nodeVersion} LICENSE response is missing expected license text`);
      }
      return {
        contents,
        licenseSource,
        licenseSha256: createHash('sha256').update(contents).digest('hex'),
      };
    }
    throw new Error(`unable to fetch Node ${nodeVersion} LICENSE from ${licenseSource}`);
  } finally {
    clearTimeout(timeout);
  }
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

async function ensurePersistentNodeLauncherUnlocked({
  pluginRoot,
  nodeExecutable = process.execPath,
  platform = process.platform,
  architecture = process.arch,
  fileSystem = realFileSystem,
  runCommandImpl = runCommand,
  pid = process.pid,
  now = Date.now,
  token = randomBytes(6).toString('hex'),
  fetchImpl = globalThis.fetch,
  licenseTimeoutMs = NODE_LICENSE_TIMEOUT_MS,
  licenseMaxBytes = NODE_LICENSE_MAX_BYTES,
  licenseMaxRedirects = NODE_LICENSE_MAX_REDIRECTS,
} = {}) {
  if (!pluginRoot) throw new Error('Imvia Layer Node launcher requires pluginRoot');
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const runtimeRoot = pathApi.join(pluginRoot, '.node-runtime');
  const launcherPath = runtimeNodePath(runtimeRoot, platform);
  const markerPath = pathApi.join(runtimeRoot, '.imvia-layer-node.json');
  const licensePath = pathApi.join(runtimeRoot, 'LICENSE');
  await fileSystem.mkdir(pluginRoot, { recursive: true });
  await recoverNodeRuntime({ pluginRoot, runtimeRoot, fileSystem, pathApi });

  const sourceSha256 = await hashFile(nodeExecutable, fileSystem);
  const nodeVersion = await probeNodeVersion(nodeExecutable, { cwd: pluginRoot, runCommandImpl });
  const licenseSource = officialLicenseUrl(nodeVersion);
  const marker = await readMarker(markerPath, fileSystem);
  if (marker?.sourceSha256 === sourceSha256
    && marker.nodeVersion === nodeVersion
    && marker.licenseSource === licenseSource
    && typeof marker.licenseSha256 === 'string'
    && marker.platform === platform
    && marker.architecture === architecture) {
    try {
      await verifyNode(launcherPath, {
        cwd: pluginRoot,
        runCommandImpl,
        expectedSha256: sourceSha256,
        expectedNodeVersion: nodeVersion,
        fileSystem,
      });
      if (await hashFile(licensePath, fileSystem) !== marker.licenseSha256) {
        throw new Error(`Node LICENSE SHA-256 mismatch: ${licensePath}`);
      }
      return {
        command: launcherPath,
        nodeVersion,
        version: nodeVersion,
        sourceSha256,
        licenseSource,
        licenseSha256: marker.licenseSha256,
      };
    } catch {
      // Rebuild a missing or damaged launcher below.
    }
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error(`unable to fetch Node ${nodeVersion} LICENSE: Fetch API is unavailable`);
  }
  const officialLicense = await fetchOfficialNodeLicense({
    nodeVersion,
    fetchImpl,
    timeoutMs: licenseTimeoutMs,
    maximumBytes: licenseMaxBytes,
    maximumRedirects: licenseMaxRedirects,
  });

  const suffix = `${pid}-${now()}-${token}`;
  const stagingRoot = `${runtimeRoot}.staging-${suffix}`;
  const backupRoot = `${runtimeRoot}.backup-${suffix}`;
  const stagingLauncher = runtimeNodePath(stagingRoot, platform);
  try {
    await fileSystem.mkdir(pathApi.dirname(stagingLauncher), { recursive: true });
    await fileSystem.copyFile(nodeExecutable, stagingLauncher);
    await fileSystem.writeFile(pathApi.join(stagingRoot, 'LICENSE'), officialLicense.contents);
    if (platform !== 'win32') await fileSystem.chmod(stagingLauncher, 0o755);
    await verifyNode(stagingLauncher, {
      cwd: pluginRoot,
      runCommandImpl,
      expectedSha256: sourceSha256,
      expectedNodeVersion: nodeVersion,
      fileSystem,
    });
    if (await hashFile(pathApi.join(stagingRoot, 'LICENSE'), fileSystem) !== officialLicense.licenseSha256) {
      throw new Error('Node LICENSE SHA-256 mismatch while staging');
    }
    await fileSystem.writeFile(pathApi.join(stagingRoot, '.imvia-layer-node.json'), `${JSON.stringify({
      sourceSha256,
      nodeVersion,
      licenseSource: officialLicense.licenseSource,
      licenseSha256: officialLicense.licenseSha256,
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
    nodeVersion: publishedMarker.nodeVersion,
    version: publishedMarker.nodeVersion,
    sourceSha256,
    licenseSource: publishedMarker.licenseSource,
    licenseSha256: publishedMarker.licenseSha256,
  };
}

export async function ensurePersistentNodeLauncher(options = {}) {
  if (options.lockAlreadyHeld) return ensurePersistentNodeLauncherUnlocked(options);
  return withRuntimeInstallLock({
    pluginRoot: options.pluginRoot,
    lockOptions: options.runtimeLockOptions,
    task: () => ensurePersistentNodeLauncherUnlocked(options),
  });
}
