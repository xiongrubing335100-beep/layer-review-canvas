// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

export const RUNTIME_INSTALL_LOCK_TARGET = '.imvia-runtime-install';

const DEFAULT_LOCK_OPTIONS = Object.freeze({
  stale: 30_000,
  update: 10_000,
  retries: Object.freeze({
    retries: 60,
    factor: 1.2,
    minTimeout: 100,
    maxTimeout: 1_000,
  }),
});

export async function withRuntimeInstallLock({
  pluginRoot,
  task,
  lockOptions = {},
  lockImpl = lockfile.lock,
} = {}) {
  if (!pluginRoot) throw new Error('Imvia Layer runtime installer lock requires pluginRoot');
  if (typeof task !== 'function') throw new Error('Imvia Layer runtime installer lock requires a task');

  await mkdir(pluginRoot, { recursive: true });
  const target = path.join(pluginRoot, RUNTIME_INSTALL_LOCK_TARGET);
  const targetHandle = await open(target, 'a');
  await targetHandle.close();

  let release;
  try {
    release = await lockImpl(target, {
      ...DEFAULT_LOCK_OPTIONS,
      ...lockOptions,
      realpath: false,
    });
  } catch (error) {
    throw new Error(`等待 Imvia Layer runtime installer lock 失败：${error.message}`, { cause: error });
  }

  try {
    return await task();
  } finally {
    await release();
  }
}
