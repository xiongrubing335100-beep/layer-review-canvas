import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withDirectoryLock } from './file-lock.js';

test('directory lock serializes overlapping submission work', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'imvia-layer-lock-'));
  const lockDirectory = path.join(directory, '.submission.lock');
  const order = [];
  try {
    await Promise.all([
      withDirectoryLock(lockDirectory, async () => {
        order.push('first-start');
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push('first-end');
      }),
      withDirectoryLock(lockDirectory, async () => {
        order.push('second-start');
        order.push('second-end');
      }),
    ]);
    assert.deepEqual(order, [
      'first-start',
      'first-end',
      'second-start',
      'second-end',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
