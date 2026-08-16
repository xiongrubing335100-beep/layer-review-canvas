import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setupImviaLayer } from '../../scripts/setup-imvia-layer.mjs';
import { uninstallLocalPlugin, uninstallLocalPluginLocked } from '../../scripts/uninstall-codex-plugin.mjs';
import { withRuntimeInstallLock } from '../../scripts/runtime-install-lock.mjs';

const [operation, pluginRoot, enteredPath, gatePath, sentinelPath] = process.argv.slice(2);

async function waitForGate() {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await access(gatePath);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${gatePath}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

if (operation === 'setup') {
  await setupImviaLayer({
    repositoryRoot: path.resolve('.'),
    pluginRoot,
    ensurePythonLockedImpl: async () => ({ command: 'fake-python', args: [], version: '3.12' }),
    warmModelImpl: async () => {
      await writeFile(enteredPath, 'entered');
      await waitForGate();
    },
    installLockedImpl: async () => {
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(sentinelPath, 'installed');
    },
    writeOutput: () => {},
  });
} else if (operation === 'uninstall') {
  await uninstallLocalPlugin({ pluginRoot, marketplacePath: null });
} else if (operation === 'held-uninstall') {
  await withRuntimeInstallLock({
    pluginRoot,
    task: async (lockToken) => {
      await uninstallLocalPluginLocked({ pluginRoot, marketplacePath: null, lockToken });
      await writeFile(enteredPath, 'entered');
      await waitForGate();
    },
  });
} else {
  throw new Error(`unknown operation: ${operation}`);
}
