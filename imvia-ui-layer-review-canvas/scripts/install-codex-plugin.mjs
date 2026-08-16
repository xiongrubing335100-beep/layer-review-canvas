// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePersistentNodeLauncherLocked } from './node-runtime.mjs';
import { ensurePersistentPythonRuntimeLocked } from './python-runtime.mjs';
import { withRuntimeInstallLock } from './runtime-install-lock.mjs';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  pluginRoot = path.join(os.homedir(), 'plugins', 'imvia-layer'),
  marketplacePath = path.join(os.homedir(), '.agents', 'plugins', 'marketplace.json'),
  preparedPython,
  ensurePythonLockedImpl = ensurePersistentPythonRuntimeLocked,
  ensureNodeLockedImpl = ensurePersistentNodeLauncherLocked,
  writeOutput = (chunk) => process.stdout.write(chunk),
} = {}) {
  const pluginTemplateRoot = path.join(repositoryRoot, 'plugin-template', 'imvia-layer');
  const python = preparedPython ?? await ensurePythonLockedImpl({ repositoryRoot, pluginRoot });
  const node = await ensureNodeLockedImpl({ pluginRoot });
  await mkdir(path.dirname(pluginRoot), { recursive: true });
  await cp(pluginTemplateRoot, pluginRoot, { recursive: true, force: true });

  await writeFile(path.join(pluginRoot, 'imvia-layer-runtime.json'), `${JSON.stringify({
    workbenchRoot: repositoryRoot,
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
    source: { source: 'local', path: './plugins/imvia-layer' },
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
    `工作台目录：${repositoryRoot}`,
    '请重启 Codex Desktop 或新建一个任务，然后发送：[@imvia-layer](plugin://imvia-layer@personal) 打开工作台',
  ].join('\n') + '\n');

  return { python, node, pluginRoot, marketplacePath };
}

export async function installCodexPlugin(options = {}) {
  const pluginRoot = options.pluginRoot ?? path.join(os.homedir(), 'plugins', 'imvia-layer');
  return withRuntimeInstallLock({
    pluginRoot,
    lockOptions: options.runtimeLockOptions,
    task: () => installCodexPluginLocked({ ...options, pluginRoot }),
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  installCodexPlugin().catch((error) => {
    process.stderr.write(`安装 Imvia Layer 失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
