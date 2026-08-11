import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const localLockQueues = new Map();

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function withDirectoryLock(
  lockDirectory,
  action,
  {
    timeoutMs = 5_000,
    staleMs = 30_000,
    retryMs = 20,
  } = {},
) {
  const lockKey = path.resolve(lockDirectory);
  const previous = localLockQueues.get(lockKey) || Promise.resolve();
  let releaseLocalLock;
  const current = new Promise((resolve) => {
    releaseLocalLock = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  localLockQueues.set(lockKey, tail);
  await previous.catch(() => {});

  let acquired = false;
  try {
    await mkdir(path.dirname(lockKey), { recursive: true });
    const startedAt = Date.now();
    while (true) {
      try {
        await mkdir(lockKey);
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const lockStat = await stat(lockKey).catch(() => null);
        if (lockStat && Date.now() - lockStat.mtimeMs > staleMs) {
          await rm(lockKey, { recursive: true, force: true });
          continue;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error('任务状态正在更新，请稍后重试');
        }
        await wait(retryMs);
      }
    }

    return await action();
  } finally {
    if (acquired) await rm(lockKey, { recursive: true, force: true });
    releaseLocalLock();
    if (localLockQueues.get(lockKey) === tail) localLockQueues.delete(lockKey);
  }
}
