import assert from 'node:assert/strict';
import test from 'node:test';

test('the live workbench initializes once and calls an app tool', async () => {
  const listeners = new Set();
  const sent = [];
  const parent = {
    postMessage(message) {
      sent.push(message);
      if (!message.id) return;
      const structuredContent = message.method === 'tools/call'
        ? { accepted: true }
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
    addEventListener(type, listener) {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'message') listeners.delete(listener);
    },
  };

  try {
    const client = await import(`./mcp-app-client.js?test=${Date.now()}`);
    const result = await client.callMcpAppTool('submit_layer_review_job', { plan: {} });

    assert.deepEqual(result, { accepted: true });
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

test('the native MCP Apps bridge calls server tools and sends follow-up messages', async () => {
  const calls = [];
  globalThis.window = {
    parent: {},
    __IMVIA_MCP_APP__: {
      callServerTool: async (request) => {
        calls.push(['tool', request]);
        return { structuredContent: { accepted: true } };
      },
      sendMessage: async (message) => {
        calls.push(['message', message]);
        return { content: [] };
      },
    },
    __IMVIA_MCP_APP_READY__: Promise.resolve(),
  };

  try {
    const client = await import(`./mcp-app-client.js?native-test=${Date.now()}`);
    assert.equal(client.isMcpAppHost(), true);
    assert.deepEqual(
      await client.callMcpAppTool('submit_layer_review_job', { plan: {} }),
      { accepted: true },
    );
    await client.sendMcpAppFollowUpMessage('请拆分当前图层');
    assert.deepEqual(calls, [
      ['tool', { name: 'submit_layer_review_job', arguments: { plan: {} } }],
      ['message', {
        role: 'user',
        content: [{ type: 'text', text: '请拆分当前图层' }],
      }],
    ]);
  } finally {
    delete globalThis.window;
  }
});

test('empty conversation follow-up messages are rejected before reaching the host', async () => {
  let sends = 0;
  globalThis.window = {
    parent: {},
    __IMVIA_MCP_APP__: {
      sendMessage: async () => {
        sends += 1;
        return { content: [] };
      },
    },
    __IMVIA_MCP_APP_READY__: Promise.resolve(),
  };

  try {
    const client = await import(`./mcp-app-client.js?empty-message-test=${Date.now()}`);
    await assert.rejects(
      client.sendMcpAppFollowUpMessage('   '),
      /不能发送空的拆分消息/,
    );
    assert.equal(sends, 0);
  } finally {
    delete globalThis.window;
  }
});
