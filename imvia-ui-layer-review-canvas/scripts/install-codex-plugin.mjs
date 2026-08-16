// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePersistentNodeLauncher } from './node-runtime.mjs';
import { ensurePersistentPythonRuntime } from './python-runtime.mjs';
import { withRuntimeInstallLock } from './runtime-install-lock.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginTemplateRoot = path.join(repositoryRoot, 'plugin-template', 'imvia-layer');
const pluginRoot = path.join(os.homedir(), 'plugins', 'imvia-layer');
const marketplacePath = path.join(os.homedir(), '.agents', 'plugins', 'marketplace.json');
const cachebuster = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

async function readMarketplace() {
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

async function installWhileLocked() {
  const python = await ensurePersistentPythonRuntime({ repositoryRoot, pluginRoot, lockAlreadyHeld: true });
  const node = await ensurePersistentNodeLauncher({ pluginRoot, lockAlreadyHeld: true });
  await mkdir(path.dirname(pluginRoot), { recursive: true });
  await cp(pluginTemplateRoot, pluginRoot, { recursive: true, force: true });

  const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = `0.1.0+local.${cachebuster}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

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

  const marketplace = await readMarketplace();
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

  process.stdout.write([
    'Imvia Layer 插件已安装。',
    `插件目录：${pluginRoot}`,
    `工作台目录：${repositoryRoot}`,
    '请重启 Codex Desktop 或新建一个任务，然后发送：[@imvia-layer](plugin://imvia-layer@personal) 打开工作台',
  ].join('\n') + '\n');
}

async function install() {
  return withRuntimeInstallLock({ pluginRoot, task: installWhileLocked });
}

install().catch((error) => {
  process.stderr.write(`安装 Imvia Layer 失败：${error.message}\n`);
  process.exitCode = 1;
});
