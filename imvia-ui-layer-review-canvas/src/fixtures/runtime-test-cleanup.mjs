import * as realFileSystem from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

const RETRYABLE_WINDOWS_ERRORS = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

export async function removeRuntimeTestTree(targetPath, {
  fileSystem = realFileSystem,
  maxRetries = 20,
  retryDelayMs = 100,
  waitImpl = wait,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fileSystem.rm(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 1,
        retryDelay: retryDelayMs,
      });
      return;
    } catch (error) {
      if (!RETRYABLE_WINDOWS_ERRORS.has(error.code) || attempt >= maxRetries) throw error;
      await waitImpl(retryDelayMs);
    }
  }
}
