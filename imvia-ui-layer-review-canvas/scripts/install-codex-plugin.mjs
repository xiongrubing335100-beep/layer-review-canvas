// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { isDirectExecution } from './direct-execution.mjs';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePersistentNodeLauncherLocked } from './node-runtime.mjs';
import { ensurePersistentPythonRuntimeLocked, runCommand } from './python-runtime.mjs';
import { withRuntimeInstallLock } from './runtime-install-lock.mjs';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeEntries = [
  'src', 'scripts', 'public', 'plugin-template', 'node_modules', 'dist',
  'package.json', 'package-lock.json', 'requirements-rmbg.txt', 'requirements-rmbg.lock',
  'LICENSE', 'vite.config.js', 'index.html', 'codex-thread-bridge.mjs', 'layer-review-mcp-server.mjs',
];
const requiredAdapterFiles = [
  'scripts/prepare-poster-job.mjs', 'scripts/finalize-poster-analysis.mjs',
  'scripts/finalize-poster-candidate.mjs', 'scripts/finalize-poster-fast-rmbg-candidate.mjs',
  'scripts/finalize-poster-generation-failure.mjs', 'scripts/finalize-rmbg.py',
  'scripts/prepare-poster-rmbg-candidate.py', 'scripts/normalize-poster-layer.py',
  'scripts/audit-poster-recomposition.py', 'src/assets/poster-layer-manifest-v3.1.json',
  'scripts/v2-region-pixels.py', 'scripts/source-guided-matte.py',
  'scripts/semantic-matte.py', 'scripts/matte-registration.py', 'scripts/matte-correspondence.py', 'scripts/inspect-v2-matte.py',
  'scripts/finalize-v2-candidate.mjs', 'scripts/export-v2-psd.mjs',
  'src/v2/psd-codec.mjs', 'node_modules/ag-psd/package.json', 'node_modules/fflate/package.json',
];

async function validateRuntimeSource(repositoryRoot) {
  for (const relativePath of requiredAdapterFiles) {
    try {
      if (!(await stat(path.join(repositoryRoot, relativePath))).isFile()) throw new Error('not a file');
    } catch (error) {
      throw new Error(`海报分层适配技能契约不完整：缺少 ${relativePath}`, { cause: error });
    }
  }
  for (const relativePath of runtimeEntries.filter((entry) => entry !== 'dist')) {
    await stat(path.join(repositoryRoot, relativePath));
  }
}

async function pathExists(targetPath) {
  try { await stat(targetPath); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function stageWorkbenchRuntime(repositoryRoot, pluginRoot) {
  const stagingRoot = await mkdtemp(path.join(pluginRoot, '.workbench-runtime.staging-'));
  try {
    // Resolve package links while the source checkout is available. Installed helpers
    // must never follow an absolute node_modules link back to that checkout.
    for (const entry of runtimeEntries) {
      await cp(path.join(repositoryRoot, entry), path.join(stagingRoot, entry), {
        recursive: true, dereference: true,
      });
    }
    await validateRuntimeSource(stagingRoot);
    await stat(path.join(stagingRoot, 'dist', 'index.html'));
    // Only migrate data from an explicitly registered legacy checkout. A new
    // installation must not package the developer's output/ and QA artifacts.
    if (!await pathExists(path.join(pluginRoot, 'runtime'))) {
      let previousConfig;
      try { previousConfig = JSON.parse(await readFile(path.join(pluginRoot, 'imvia-layer-runtime.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previousConfig?.workbenchRoot && path.resolve(previousConfig.workbenchRoot) === repositoryRoot
        && await pathExists(path.join(repositoryRoot, 'output'))) {
        await cp(path.join(repositoryRoot, 'output'), path.join(stagingRoot, 'output'), { recursive: true });
      }
    }
    return stagingRoot;
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function publishWorkbenchRuntime(stagingRoot, pluginRoot) {
  const runtimeRoot = path.join(pluginRoot, 'runtime');
  const backupRoot = `${stagingRoot}.backup`;
  let backedUp = false;
  let movedOutput = false;
  try {
    if (await pathExists(runtimeRoot)) {
      await rename(runtimeRoot, backupRoot);
      backedUp = true;
      if (await pathExists(path.join(backupRoot, 'output'))) {
        await rename(path.join(backupRoot, 'output'), path.join(stagingRoot, 'output'));
        movedOutput = true;
      }
    }
    await rename(stagingRoot, runtimeRoot);
  } catch (error) {
    // Keep user projects with the previous runtime if publishing the new code fails.
    if (movedOutput) await rename(path.join(stagingRoot, 'output'), path.join(backupRoot, 'output'));
    if (backedUp) await rename(backupRoot, runtimeRoot);
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  if (backedUp) await rm(backupRoot, { recursive: true, force: true });
  return runtimeRoot;
}

async function readMarketplace(marketplacePath) {
  try {
    return JSON.parse(await readFile(marketplacePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      name: 'personal',
      interface: { displayName: 'Personal' },
      plugins: [],
    };
  }
}

export async function installCodexPluginLocked({
  repositoryRoot = defaultRepositoryRoot,
  pluginRoot = process.env.IMVIA_LAYER_PLUGIN_DIRECTORY || path.join(os.homedir(), 'plugins', 'imvia-layer'),
  marketplacePath = process.env.IMVIA_LAYER_MARKETPLACE_PATH || path.join(os.homedir(), '.agents', 'plugins', 'marketplace.json'),
  preparedPython,
  ensurePythonLockedImpl = ensurePersistentPythonRuntimeLocked,
  ensureNodeLockedImpl = ensurePersistentNodeLauncherLocked,
  writeOutput = (chunk) => process.stdout.write(chunk),
} = {}) {
  repositoryRoot = path.resolve(repositoryRoot);
  pluginRoot = path.resolve(pluginRoot);
  marketplacePath = path.resolve(marketplacePath);
  await validateRuntimeSource(repositoryRoot);
  await runCommand(process.execPath, [path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: repositoryRoot,
  });
  const python = preparedPython ?? await ensurePythonLockedImpl({ repositoryRoot, pluginRoot });
  const node = await ensureNodeLockedImpl({ pluginRoot });
  await mkdir(pluginRoot, { recursive: true });
  const stagedRuntime = await stageWorkbenchRuntime(repositoryRoot, pluginRoot);
  const runtimeRoot = await publishWorkbenchRuntime(stagedRuntime, pluginRoot);
  await cp(path.join(runtimeRoot, 'plugin-template', 'imvia-layer'), pluginRoot, { recursive: true, force: true });

  await writeFile(path.join(pluginRoot, 'imvia-layer-runtime.json'), `${JSON.stringify({
    workbenchRoot: runtimeRoot,
    marketplacePath,
    python: { command: python.command, args: python.args },
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  await writeFile(path.join(pluginRoot, '.mcp.json'), `${JSON.stringify({
    mcpServers: {
      'imvia-layer': {
        command: node.command,
        args: [path.join(pluginRoot, 'scripts', 'start-mcp.mjs')],
        cwd: pluginRoot,
      },
    },
  }, null, 2)}\n`);

  const marketplace = await readMarketplace(marketplacePath);
  const pluginEntry = {
    name: 'imvia-layer',
    source: { source: 'local', path: pluginRoot },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  };
  marketplace.plugins = (marketplace.plugins || []).filter((plugin) => plugin.name !== pluginEntry.name);
  marketplace.plugins.push(pluginEntry);
  await mkdir(path.dirname(marketplacePath), { recursive: true });
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);

  writeOutput([
    'Imvia Layer 插件已安装。',
    `插件目录：${pluginRoot}`,
    `工作台目录：${runtimeRoot}`,
    '请重启 Codex Desktop 或新建一个任务，然后发送：[@imvia-layer](plugin://imvia-layer@personal) 打开工作台',
  ].join('\n') + '\n');

  return { python, node, pluginRoot, marketplacePath };
}

export async function installCodexPlugin(options = {}) {
  const pluginRoot = path.resolve(options.pluginRoot ?? process.env.IMVIA_LAYER_PLUGIN_DIRECTORY ?? path.join(os.homedir(), 'plugins', 'imvia-layer'));
  return withRuntimeInstallLock({
    pluginRoot,
    lockOptions: options.runtimeLockOptions,
    task: () => installCodexPluginLocked({ ...options, pluginRoot }),
  });
}

if (await isDirectExecution(import.meta.url)) {
  installCodexPlugin().catch((error) => {
    process.stderr.write(`安装 Imvia Layer 失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
