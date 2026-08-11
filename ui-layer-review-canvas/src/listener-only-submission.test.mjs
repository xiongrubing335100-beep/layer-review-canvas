import assert from 'node:assert/strict';
import test from 'node:test';

test('an MCP-hosted workbench queues through the listener without posting directly', async () => {
  const listeners = new Set();
  const sent = [];
  const parent = {
    postMessage(message) {
      sent.push(message);
      if (!message.id) return;
      const structuredContent = message.method === 'tools/call'
        ? {
            submission: {
              job_id: 'job-1',
              status: 'awaiting_codex_message',
              submitted_at: '2026-07-30T00:00:00.000Z',
              skill_name: 'split-skill',
              delivery_channel: 'conversation_bridge',
            },
          }
        : undefined;
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({
            source: parent,
            data: {
              jsonrpc: '2.0',
              id: message.id,
              result: structuredContent ? { structuredContent } : {},
            },
          });
        }
      });
    },
  };
  globalThis.window = {
    parent,
    __IMVIA_MCP_APP_HOST__: true,
    addEventListener(type, listener) {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'message') listeners.delete(listener);
    },
  };

  try {
    const { submitLayerReviewPlan } = await import(
      `./mcp-workbench-host.js?listener-only=${Date.now()}`
    );
    const result = await submitLayerReviewPlan({ layers: [] });

    assert.equal(result.delivery_channel, 'conversation_bridge');
    assert.deepEqual(
      sent.filter(({ method }) => method).map(({ method }) => method),
      [
        'ui/initialize',
        'ui/notifications/initialized',
        'tools/call',
      ],
    );
  } finally {
    delete globalThis.window;
  }
});

test('the legacy Codex bridge exposes no background submission operation', async () => {
  const bridge = await import(`../codex-thread-bridge.mjs?listener-only=${Date.now()}`);
  assert.equal('sendPlanToCurrentThread' in bridge, false);
});
