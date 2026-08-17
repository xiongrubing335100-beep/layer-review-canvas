import assert from 'node:assert/strict';
import test from 'node:test';
import { removeRuntimeTestTree } from './fixtures/runtime-test-cleanup.mjs';

test('runtime fixture cleanup retries transient Windows executable locks', async () => {
  let attempts = 0;
  const waits = [];
  const fileSystem = {
    async rm() {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('executable is still in use'), { code: 'EPERM' });
    },
  };

  await removeRuntimeTestTree('C:\\Temp\\imvia runtime', {
    fileSystem,
    maxRetries: 3,
    retryDelayMs: 25,
    waitImpl: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(waits, [25, 25]);
});

test('runtime fixture cleanup does not hide non-lock failures', async () => {
  const fileSystem = {
    async rm() {
      throw Object.assign(new Error('simulated I/O failure'), { code: 'EIO' });
    },
  };

  await assert.rejects(
    removeRuntimeTestTree('/tmp/imvia-runtime', { fileSystem }),
    /simulated I\/O failure/,
  );
});
