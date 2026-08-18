import assert from 'node:assert/strict';
import test from 'node:test';
import * as workbenchHost from './mcp-workbench-host.js';
import {
  cancelQueuedSplit,
} from './mcp-workbench-host.js';

test('the standalone workbench does not own a second conversation delivery channel', () => {
  assert.equal('sendSplitPromptToCurrentTask' in workbenchHost, false);
  assert.equal('connectWorkbenchApp' in workbenchHost, false);
});

test('the standalone workbench can verify that the current conversation listener is online', async () => {
  assert.equal(typeof workbenchHost.getConversationBridgePresence, 'function');
  const requests = [];
  const presence = await workbenchHost.getConversationBridgePresence(async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        online: true,
        last_seen: '2026-07-29T02:00:00.000Z',
      }),
    };
  });

  assert.equal(presence.online, true);
  assert.equal(requests[0].url, 'http://127.0.0.1:4173/api/layer-review/bridge-status');
  assert.equal(requests[0].options.cache, 'no-store');
});

test('the embedded workbench also reads the real listener status instead of assuming it is online', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { parent: {} };
  const requests = [];

  try {
    const presence = await workbenchHost.getConversationBridgePresence(async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          online: false,
          last_seen: null,
        }),
      };
    });

    assert.equal(presence.online, false);
    assert.equal(requests[0].url, 'http://127.0.0.1:4173/api/layer-review/bridge-status');
    assert.equal(requests[0].options.cache, 'no-store');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('manual reconnect normalizes the latest bridge presence for the topbar', async () => {
  assert.equal(typeof workbenchHost.reconnectConversationBridge, 'function');
  const state = await workbenchHost.reconnectConversationBridge(async () => ({
    ok: true,
    json: async () => ({
      online: true,
      last_seen: '2026-07-29T02:00:00.000Z',
    }),
  }));

  assert.deepEqual(state, {
    online: true,
    lastSeen: '2026-07-29T02:00:00.000Z',
    checked: true,
  });
});

test('manual reconnect returns a stable disconnected state when the bridge cannot be reached', async () => {
  assert.equal(typeof workbenchHost.reconnectConversationBridge, 'function');
  const state = await workbenchHost.reconnectConversationBridge(async () => {
    throw new Error('offline');
  });

  assert.deepEqual(state, {
    online: false,
    lastSeen: null,
    checked: true,
  });
});

test('a queued split can be cancelled through the workbench API', async () => {
  const requests = [];
  const result = await cancelQueuedSplit('layer-job-1', async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({ ok: true, status: 'cancelled' }),
    };
  });

  assert.deepEqual(result, { ok: true, status: 'cancelled' });
  assert.equal(
    requests[0].url,
    'http://127.0.0.1:4173/api/layer-review/foreground-dispatch/layer-job-1/cancel',
  );
  assert.equal(requests[0].options.method, 'POST');
});
