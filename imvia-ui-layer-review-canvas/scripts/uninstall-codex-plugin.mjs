// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import * as realFileSystem from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRuntimeInstallLock } from './runtime-install-lock.mjs';

export async function uninstallLocalPluginLocked({
  pluginRoot = path.join(os.homedir(), 'plugins', 'imvia-layer'),
  marketplacePath = path.join(os.homedir(), '.agents', 'plugins', 'marketplace.json'),
  fileSystem = realFileSystem,
} = {}) {
  await fileSystem.rm(pluginRoot, { recursive: true, force: true });
  if (!marketplacePath) return;

  try {
    const marketplace = JSON.parse(await fileSystem.readFile(marketplacePath, 'utf8'));
    const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    marketplace.plugins = plugins.filter((plugin) => plugin?.name !== 'imvia-layer');
    await fileSystem.writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function uninstallLocalPlugin(options = {}) {
  const pluginRoot = options.pluginRoot ?? path.join(os.homedir(), 'plugins', 'imvia-layer');
  return withRuntimeInstallLock({
    pluginRoot,
    lockOptions: options.runtimeLockOptions,
    task: () => uninstallLocalPluginLocked({ ...options, pluginRoot }),
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  uninstallLocalPlugin().then(() => {
    process.stdout.write('Imvia Layer 插件及其托管 Python 和 Node runtime 已卸载。\n');
  }).catch((error) => {
    process.stderr.write(`卸载 Imvia Layer 失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
