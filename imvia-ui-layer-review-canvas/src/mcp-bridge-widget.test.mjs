import assert from 'node:assert/strict';
import test from 'node:test';
import * as bridgeWidget from '../public/layer-review-bridge-widget.js';
import {
  buildToolCallRequest,
  buildUiMessageRequest,
  connectHost,
  sendForegroundMessage,
} from '../public/layer-review-bridge-widget.js';

test('the bridge builds a native task message payload', () => {
  assert.deepEqual(buildUiMessageRequest({
    prompt: 'split this layer',
    presentation: {
      preview: {
        mimeType: 'image/png',
        data: 'cHJldmlldw==',
      },
    },
  }, 7), {
    jsonrpc: '2.0',
    id: 7,
    method: 'ui/message',
    params: {
      role: 'user',
      content: [
        { type: 'text', text: 'split this layer' },
        { type: 'image', mimeType: 'image/png', data: 'cHJldmlldw==' },
      ],
    },
  });
});

test('the bridge reads the queue through an app-only MCP tool', () => {
  assert.deepEqual(buildToolCallRequest('get_layer_review_foreground_dispatch', {}, 8), {
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: {
      name: 'get_layer_review_foreground_dispatch',
      arguments: {},
    },
  });
});

test('the bridge prefers the host-bound follow-up helper for the current Codex task', async () => {
  const requests = [];
  const notifications = [];
  const followUpMessages = [];
  const previousWindow = globalThis.window;
  globalThis.window = {
    openai: {
      async sendFollowUpMessage(message) {
        followUpMessages.push(message);
        return {};
      },
    },
  };

  try {
    const connection = await connectHost(
      async (message) => {
        requests.push(message);
        if (message.method === 'ui/initialize') {
          return { hostCapabilities: { message: { text: {} } } };
        }
        return {};
      },
      (message) => notifications.push(message),
    );
    await sendForegroundMessage({
      prompt: 'split this layer',
      presentation: {
        preview: {
          mimeType: 'image/png',
          data: 'cHJldmlldw==',
        },
      },
    }, connection);
    assert.equal(connection.mode, 'follow_up_message');
  } finally {
    globalThis.window = previousWindow;
  }

  assert.deepEqual(requests, []);
  assert.deepEqual(notifications, []);
  assert.deepEqual(followUpMessages, [{
    prompt: 'split this layer',
    presentation: {
      preview: {
        mimeType: 'image/png',
        data: 'cHJldmlldw==',
      },
    },
  }]);
});

test('the bridge fails closed when the visible conversation message route is unavailable', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { openai: {} };

  try {
    await assert.rejects(
      () => connectHost(async () => {
        throw new Error('ui/message unavailable');
      }, () => {}),
      /ui\/message unavailable/,
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test('the bridge marks initialization failures as non-retryable', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { openai: {} };

  try {
    await assert.rejects(
      connectHost(async () => {
        throw new Error('host rejected initialization');
      }, () => {}),
      (error) => (
        /host rejected initialization/.test(error.message)
        && error.retryable === false
      ),
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test('the bridge rejects a visible message error instead of marking the host accepted', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    openai: {
      async sendFollowUpMessage() {
        return { isError: true };
      },
    },
  };

  try {
    const connection = await connectHost(
      async (message) => {
        if (message.method === 'ui/message') return { isError: true };
        return {};
      },
      () => {},
    );
    await assert.rejects(
      sendForegroundMessage('split this layer', connection),
      /拒绝接收拆分消息/,
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test('the conversation listener retries an initial connection failure and keeps polling after reconnect', async () => {
  assert.equal(typeof bridgeWidget.startConversationBridge, 'function');
  let connectAttempts = 0;
  let pollCount = 0;
  const retries = [];
  const pollers = [];
  const heartbeats = [];

  const options = {
    bridgeId: 'bridge-current',
    workbenchSessionId: 'workbench-current',
    connect: async () => {
      connectAttempts += 1;
      if (connectAttempts === 1) throw new Error('host unavailable');
      return { mode: 'test', sendMessage: async () => ({}) };
    },
    registerBridge: async () => {},
    pollOnce: async () => {
      pollCount += 1;
    },
    setBridgeStatus: () => {},
    scheduleRetry: (callback) => retries.push(callback),
    schedulePoll: (callback) => pollers.push(callback),
    heartbeatBridge: async () => ({ active: true }),
    scheduleHeartbeat: (callback) => heartbeats.push(callback),
    clearHeartbeat: () => {},
  };

  assert.equal(await bridgeWidget.startConversationBridge(options), false);
  assert.equal(retries.length, 1);
  assert.equal(pollers.length, 0);

  assert.equal(await retries[0](), true);
  assert.equal(connectAttempts, 2);
  assert.equal(pollCount, 1);
  assert.equal(pollers.length, 1);
  assert.equal(heartbeats.length, 1);
});

test('the conversation listener clears its timers and reconnects after a heartbeat failure', async () => {
  const retries = [];
  const heartbeats = [];
  const cleared = [];
  const statuses = [];
  let heartbeatCount = 0;

  assert.equal(await bridgeWidget.startConversationBridge({
    bridgeId: 'bridge-heartbeat',
    connectedAt: '2026-08-02T10:00:00.000Z',
    workbenchSessionId: 'session-heartbeat',
    connect: async () => ({ mode: 'follow_up_confirmation' }),
    registerBridge: async () => ({
      workbenchSessionId: 'session-heartbeat',
      active: true,
    }),
    heartbeatBridge: async () => {
      heartbeatCount += 1;
      if (heartbeatCount > 1) throw new Error('heartbeat lost');
      return { active: true };
    },
    createDispatcher: () => () => {},
    pollOnce: async () => {},
    setBridgeStatus: (...status) => statuses.push(status),
    scheduleRetry: (callback) => retries.push(callback),
    schedulePoll: () => 'poll-timer',
    clearPoll: (timer) => cleared.push(`poll:${timer}`),
    scheduleHeartbeat: (callback) => {
      heartbeats.push(callback);
      return 'heartbeat-timer';
    },
    clearHeartbeat: (timer) => cleared.push(`heartbeat:${timer}`),
  }), true);

  heartbeats[0]();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(cleared.sort(), ['heartbeat:heartbeat-timer', 'poll:poll-timer']);
  assert.equal(retries.length, 1);
  assert.equal(statuses.at(-1)[0], '正在重连当前会话');
});

test('the conversation listener does not retry when the host lacks a current-task message channel', async () => {
  let retries = 0;
  const statuses = [];
  const unsupported = new Error('宿主未开放当前任务消息通道');
  unsupported.retryable = false;

  assert.equal(await bridgeWidget.startConversationBridge({
    connect: async () => {
      throw unsupported;
    },
    registerBridge: async () => {},
    pollOnce: async () => {},
    setBridgeStatus: (...args) => statuses.push(args),
    scheduleRetry: () => {
      retries += 1;
    },
    schedulePoll: () => {},
  }), false);

  assert.equal(retries, 0);
  assert.equal(statuses.at(-1)[0], '当前任务消息通道不可用');
});

test('polling waits for an explicit user action before sending a foreground job', async () => {
  assert.equal(typeof bridgeWidget.createForegroundDispatcher, 'function');
  let sends = 0;
  let delivered = 0;
  const pending = [];
  const dispatcher = bridgeWidget.createForegroundDispatcher({
    bridgeId: 'bridge-current',
    readDispatch: async () => ({
      jobId: 'layer-job-1',
      prompt: 'split this layer',
      claimToken: 'claim-1',
    }),
    sendMessage: async () => {
      sends += 1;
    },
    markDelivered: async () => {
      delivered += 1;
    },
    releaseClaim: async () => {},
    setBridgeStatus: () => {},
    setPendingDispatch: (dispatch) => pending.push(dispatch),
  });

  await dispatcher.poll();
  await dispatcher.poll();

  assert.equal(sends, 0);
  assert.equal(delivered, 0);
  assert.equal(pending.at(-1).jobId, 'layer-job-1');

  await dispatcher.sendPendingFromUserGesture();

  assert.equal(sends, 1);
  assert.equal(delivered, 1);
});

test('the conversation bridge shows queued work instead of an empty ready state', async () => {
  const statuses = [];
  const dispatcher = bridgeWidget.createForegroundDispatcher({
    bridgeId: 'bridge-current',
    readDispatch: async () => ({
      active: true,
      dispatch: null,
      queue: { count: 2, jobIds: ['layer-job-1', 'layer-job-2'] },
    }),
    setBridgeStatus: (label, detail) => statuses.push([label, detail]),
    setPendingDispatch: () => {},
  });

  await dispatcher.poll();

  assert.deepEqual(statuses.at(-1), [
    '队列中有 2 个任务',
    '当前任务完成后，此卡片会显示下一项的发送按钮。',
  ]);
});

test('the listener keeps polling and sends the next queued task after the active task is terminal', async () => {
  const dispatches = [
    { jobId: 'layer-job-1', prompt: 'first', claimToken: 'claim-1' },
    { jobId: 'layer-job-1', prompt: 'first', claimToken: 'claim-1' },
    null,
    { jobId: 'layer-job-2', prompt: 'second', claimToken: 'claim-2' },
    { jobId: 'layer-job-2', prompt: 'second', claimToken: 'claim-2' },
  ];
  const sent = [];
  const dispatcher = bridgeWidget.createForegroundDispatcher({
    bridgeId: 'bridge-current',
    autoSendPending: true,
    readDispatch: async () => dispatches.shift() ?? null,
    sendMessage: async (dispatch) => sent.push(dispatch.jobId),
    markDelivered: async () => {},
    releaseClaim: async () => {},
    setBridgeStatus: () => {},
    setPendingDispatch: () => {},
  });

  await dispatcher.poll();
  await dispatcher.poll();
  await dispatcher.poll();

  assert.deepEqual(sent, ['layer-job-1', 'layer-job-2']);
  assert.equal(dispatcher.getPendingDispatch().jobId, 'layer-job-2');
});

test('the listener refreshes only after the current task actually confirms the delivered message', async () => {
  const confirmed = [];
  let jobStatus = 'host_accepted';
  const dispatches = [
    { jobId: 'layer-job-1', prompt: 'first', claimToken: 'claim-1' },
    { jobId: 'layer-job-1', prompt: 'first', claimToken: 'claim-1' },
    null,
    null,
  ];
  const dispatcher = bridgeWidget.createForegroundDispatcher({
    bridgeId: 'bridge-current',
    autoSendPending: true,
    readDispatch: async () => dispatches.shift() ?? null,
    sendMessage: async () => ({}),
    markDelivered: async () => {},
    readJob: async () => ({ status: jobStatus }),
    onDispatchConfirmed: (dispatch) => confirmed.push(dispatch.jobId),
    releaseClaim: async () => {},
    setBridgeStatus: () => {},
    setPendingDispatch: () => {},
  });

  await dispatcher.poll();
  await dispatcher.poll();
  assert.deepEqual(confirmed, []);
  assert.equal(dispatcher.getPendingDispatch().jobId, 'layer-job-1');

  jobStatus = 'sent_to_codex';
  await dispatcher.poll();
  assert.deepEqual(confirmed, ['layer-job-1']);
  assert.equal(dispatcher.getPendingDispatch(), null);
});

test('the bridge card cannot mark delivery confirmed from a second user click', async () => {
  let confirms = 0;
  const states = [];
  const dispatcher = bridgeWidget.createForegroundDispatcher({
    bridgeId: 'bridge-current',
    readDispatch: async () => ({
      jobId: 'layer-job-1',
      prompt: 'split this layer',
      claimToken: 'claim-1',
    }),
    sendMessage: async () => {},
    markDelivered: async () => {},
    confirmDispatch: async () => {
      confirms += 1;
    },
    releaseClaim: async () => {},
    setBridgeStatus: () => {},
    setPendingDispatch: (_dispatch, state) => states.push(state),
  });

  await dispatcher.poll();
  await dispatcher.sendPendingFromUserGesture();
  assert.equal(states.includes('awaiting_confirmation'), true);
  assert.equal(await dispatcher.handlePendingAction(), false);
  assert.equal(confirms, 0);
  assert.equal(states.at(-1), 'awaiting_confirmation');
});

test('explicit user sending is the default delivery path', async () => {
  let sends = 0;
  let delivered = 0;
  const statuses = [];
  const dispatcher = bridgeWidget.createForegroundDispatcher({
    bridgeId: 'bridge-current',
    readDispatch: async () => ({
      jobId: 'layer-job-1',
      prompt: 'split this layer',
      claimToken: 'claim-1',
    }),
    sendMessage: async () => {
      sends += 1;
    },
    markDelivered: async () => {
      delivered += 1;
    },
    releaseClaim: async () => {},
    setBridgeStatus: (...args) => statuses.push(args),
    setPendingDispatch: () => {},
  });

  await dispatcher.poll();
  assert.equal(sends, 0);

  await dispatcher.sendPendingFromUserGesture();
  await dispatcher.sendPendingFromUserGesture();

  assert.equal(sends, 1);
  assert.equal(delivered, 1);
  assert.equal(statuses.some(([label]) => label === '正在发送可见会话消息'), true);
  assert.equal(
    statuses.some(([label]) => /已提交到当前会话/.test(label)),
    false,
  );
});

test('an obsolete confirmation card is replaced by the next queued task before sending', async () => {
  let reads = 0;
  let sends = 0;
  const pending = [];
  const dispatcher = bridgeWidget.createForegroundDispatcher({
    bridgeId: 'bridge-current',
    autoSendPending: false,
    readDispatch: async () => {
      reads += 1;
      return reads === 1
        ? { jobId: 'layer-job-1', prompt: 'first', claimToken: 'claim-1' }
        : { jobId: 'layer-job-2', prompt: 'second', claimToken: 'claim-2' };
    },
    sendMessage: async () => {
      sends += 1;
    },
    markDelivered: async () => {},
    releaseClaim: async () => {},
    setBridgeStatus: () => {},
    setPendingDispatch: (dispatch) => pending.push(dispatch),
  });

  await dispatcher.poll();
  assert.equal(await dispatcher.sendPendingFromUserGesture(), false);
  assert.equal(sends, 0);
  assert.equal(dispatcher.getPendingDispatch().jobId, 'layer-job-2');
  assert.equal(pending.at(-1).jobId, 'layer-job-2');
});

test('a failed explicit confirmation releases the foreground claim for retry', async () => {
  let releases = 0;
  const dispatcher = bridgeWidget.createForegroundDispatcher({
    bridgeId: 'bridge-current',
    autoSendPending: false,
    readDispatch: async () => ({
      jobId: 'layer-job-1',
      prompt: 'split this layer',
      claimToken: 'claim-1',
    }),
    sendMessage: async () => {
      throw new Error('native confirmation unavailable');
    },
    markDelivered: async () => {
      throw new Error('must not mark a failed request delivered');
    },
    releaseClaim: async () => {
      releases += 1;
    },
    setBridgeStatus: () => {},
    setPendingDispatch: () => {},
  });

  await dispatcher.poll();
  await dispatcher.sendPendingFromUserGesture();

  assert.equal(releases, 1);
  assert.equal(dispatcher.getPendingDispatch(), null);
});

test('the conversation bridge registers its card before polling the queue', async () => {
  const order = [];
  const pollers = [];

  assert.equal(await bridgeWidget.startConversationBridge({
    bridgeId: 'bridge-current',
    connectedAt: '2026-07-29T02:00:00.000Z',
    workbenchSessionId: 'workbench-current',
    connect: async () => {
      order.push('host');
      return { mode: 'test', sendMessage: async () => ({}) };
    },
    registerBridge: async (bridgeId, connectedAt) => (
      order.push(`bridge:${bridgeId}:${connectedAt}`)
    ),
    pollOnce: async () => order.push('poll'),
    setBridgeStatus: () => {},
    scheduleRetry: () => {},
    schedulePoll: (callback) => pollers.push(callback),
    heartbeatBridge: async () => {
      order.push('heartbeat');
      return { active: true };
    },
    scheduleHeartbeat: () => {},
    clearHeartbeat: () => {},
  }), true);

  assert.deepEqual(order, [
    'host',
    'bridge:bridge-current:2026-07-29T02:00:00.000Z',
    'heartbeat',
    'poll',
  ]);
  assert.equal(pollers.length, 1);
});

test('the conversation bridge registers against the workbench session that opened its card', async () => {
  const registrations = [];

  assert.equal(await bridgeWidget.startConversationBridge({
    bridgeId: 'bridge-current',
    connectedAt: '2026-07-30T04:00:00.000Z',
    workbenchSessionId: 'workbench-current',
    connect: async () => ({ mode: 'test', sendMessage: async () => ({}) }),
    registerBridge: async (...args) => {
      registrations.push(args);
      return { active: true };
    },
    pollOnce: async () => {},
    setBridgeStatus: () => {},
    scheduleRetry: () => {},
    schedulePoll: () => {},
    heartbeatBridge: async () => ({ active: true }),
    scheduleHeartbeat: () => {},
    clearHeartbeat: () => {},
  }), true);

  assert.deepEqual(registrations, [[
    'bridge-current',
    '2026-07-30T04:00:00.000Z',
    'workbench-current',
  ]]);
});

test('the conversation bridge resolves the workbench session when the card actually starts', async () => {
  const registrations = [];
  const dispatchers = [];

  assert.equal(await bridgeWidget.startConversationBridge({
    bridgeId: 'bridge-current',
    connectedAt: '2026-07-30T04:00:00.000Z',
    workbenchSessionId: null,
    getWorkbenchSessionId: () => 'workbench-late',
    connect: async () => ({ mode: 'test', sendMessage: async () => ({}) }),
    registerBridge: async (...args) => {
      registrations.push(args);
      return { active: true };
    },
    createDispatcher: (options) => {
      dispatchers.push(options);
      return { poll: async () => {} };
    },
    setBridgeStatus: () => {},
    scheduleRetry: () => {},
    schedulePoll: () => {},
    heartbeatBridge: async () => ({ active: true }),
    scheduleHeartbeat: () => {},
    clearHeartbeat: () => {},
  }), true);

  assert.deepEqual(registrations, [[
    'bridge-current',
    '2026-07-30T04:00:00.000Z',
    'workbench-late',
  ]]);
  assert.equal(dispatchers[0].workbenchSessionId, 'workbench-late');
  assert.equal(typeof dispatchers[0].sendMessage, 'function');
});

test('a confirmed task keeps the listener alive for the next queued task', async () => {
  const dispatchers = [];
  const cleared = [];
  let reloads = 0;

  assert.equal(await bridgeWidget.startConversationBridge({
    bridgeId: 'bridge-refresh',
    workbenchSessionId: 'workbench-current',
    connect: async () => ({ mode: 'test', sendMessage: async () => ({}) }),
    registerBridge: async () => ({ active: true }),
    heartbeatBridge: async () => ({ active: true }),
    createDispatcher: (options) => {
      dispatchers.push(options);
      return { poll: async () => {} };
    },
    setBridgeStatus: () => {},
    schedulePoll: () => 'poll-timer',
    clearPoll: (timer) => cleared.push(`poll:${timer}`),
    scheduleHeartbeat: () => 'heartbeat-timer',
    clearHeartbeat: (timer) => cleared.push(`heartbeat:${timer}`),
    reloadBridge: () => {
      reloads += 1;
    },
  }), true);

  assert.equal(dispatchers[0].onDispatchConfirmed, undefined);
  assert.deepEqual(cleared, []);
  assert.equal(reloads, 0);
});

test('a superseded bridge does not poll or retry against the current conversation', async () => {
  let polls = 0;
  let retries = 0;
  const statuses = [];

  assert.equal(await bridgeWidget.startConversationBridge({
    bridgeId: 'bridge-old',
    connectedAt: '2026-07-29T01:00:00.000Z',
    workbenchSessionId: 'workbench-current',
    connect: async () => ({ mode: 'test', sendMessage: async () => ({}) }),
    registerBridge: async () => ({ active: false }),
    pollOnce: async () => {
      polls += 1;
    },
    setBridgeStatus: (...args) => statuses.push(args),
    scheduleRetry: () => {
      retries += 1;
    },
    schedulePoll: () => {},
  }), false);

  assert.equal(polls, 0);
  assert.equal(retries, 0);
  assert.equal(statuses.at(-1)[0], '当前监听已被替代');
});
