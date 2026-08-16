import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withRuntimeInstallLock } from '../../scripts/runtime-install-lock.mjs';
import { uninstallLocalPlugin } from '../../scripts/uninstall-codex-plugin.mjs';

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

if (operation === 'install') {
  await withRuntimeInstallLock({
    pluginRoot,
    task: async () => {
      await writeFile(enteredPath, 'entered');
      await waitForGate();
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(sentinelPath, 'installed');
    },
  });
} else if (operation === 'uninstall') {
  await uninstallLocalPlugin({ pluginRoot, marketplacePath: null });
} else if (operation === 'held-uninstall') {
  await withRuntimeInstallLock({
    pluginRoot,
    task: async () => {
      await uninstallLocalPlugin({ pluginRoot, marketplacePath: null, lockAlreadyHeld: true });
      await writeFile(enteredPath, 'entered');
      await waitForGate();
    },
  });
} else {
  throw new Error(`unknown lifecycle operation: ${operation}`);
}
