import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const presenceModule = await import('./conversation-bridge-presence.js').catch(() => ({}));

test('a fresh conversation bridge heartbeat is online and expires when polling stops', async (context) => {
  assert.equal(typeof presenceModule.activateConversationBridge, 'function');
  assert.equal(typeof presenceModule.markConversationBridgeHeartbeat, 'function');
  assert.equal(typeof presenceModule.readConversationBridgePresence, 'function');

  const directory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-bridge-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const stateDirectory = path.join(directory, 'new-output-directory');
  const lastSeen = '2026-07-29T02:00:00.000Z';

  await presenceModule.activateConversationBridge(stateDirectory, 'bridge-a', lastSeen);
  await presenceModule.markConversationBridgeHeartbeat(stateDirectory, 'bridge-a', lastSeen);

  assert.deepEqual(
    await presenceModule.readConversationBridgePresence(stateDirectory, {
      now: new Date('2026-07-29T02:00:03.000Z'),
      timeoutMs: 4_000,
    }),
    { online: true, lastSeen, bridgeId: 'bridge-a' },
  );
  assert.deepEqual(
    await presenceModule.readConversationBridgePresence(stateDirectory, {
      now: new Date('2026-07-29T02:00:05.000Z'),
      timeoutMs: 4_000,
    }),
    { online: false, lastSeen, bridgeId: 'bridge-a' },
  );
});

test('the newest conversation bridge stays active when an older card keeps polling', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-bridge-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  await presenceModule.activateConversationBridge(
    directory,
    'bridge-old',
    '2026-07-29T02:00:00.000Z',
  );
  await presenceModule.activateConversationBridge(
    directory,
    'bridge-current',
    '2026-07-29T02:00:01.000Z',
  );

  assert.equal(
    await presenceModule.markConversationBridgeHeartbeat(
      directory,
      'bridge-old',
      '2026-07-29T02:00:02.000Z',
    ),
    false,
  );
  assert.equal(
    await presenceModule.markConversationBridgeHeartbeat(
      directory,
      'bridge-current',
      '2026-07-29T02:00:03.000Z',
    ),
    true,
  );
  assert.deepEqual(
    await presenceModule.readConversationBridgePresence(directory, {
      now: new Date('2026-07-29T02:00:03.500Z'),
    }),
    {
      online: true,
      lastSeen: '2026-07-29T02:00:03.000Z',
      bridgeId: 'bridge-current',
    },
  );
});

test('an older bridge that reconnects late cannot replace the newer conversation', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-bridge-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  await presenceModule.activateConversationBridge(
    directory,
    'bridge-current',
    '2026-07-29T02:00:10.000Z',
  );
  const registration = await presenceModule.activateConversationBridge(
    directory,
    'bridge-old',
    '2026-07-29T02:00:00.000Z',
  );
  const presence = await presenceModule.readConversationBridgePresence(directory, {
    now: new Date('2026-07-29T02:00:11.000Z'),
  });

  assert.equal(registration.active, false);
  assert.equal(presence.bridgeId, 'bridge-current');
});

test('a legacy bridge heartbeat cannot interfere with the current listener', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-bridge-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const lastSeen = '2026-07-29T02:00:00.000Z';

  await writeFile(
    path.join(directory, 'conversation-bridge-heartbeat.json'),
    JSON.stringify({ lastSeen }),
  );

  assert.deepEqual(
    await presenceModule.readConversationBridgePresence(directory, {
      now: new Date('2026-07-29T02:00:01.000Z'),
    }),
    { online: false, lastSeen: null, bridgeId: null },
  );
});

test('a listener from another workbench session is not online for the current workbench', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-bridge-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const lastSeen = '2026-07-30T04:00:00.000Z';

  await presenceModule.activateConversationBridge(
    directory,
    'bridge-old-task',
    lastSeen,
    { workbenchSessionId: 'workbench-old' },
  );

  assert.deepEqual(
    await presenceModule.readConversationBridgePresence(directory, {
      now: new Date('2026-07-30T04:00:01.000Z'),
      workbenchSessionId: 'workbench-current',
    }),
    {
      online: false,
      lastSeen,
      bridgeId: null,
      workbenchSessionId: null,
    },
  );
  assert.equal(
    await presenceModule.markConversationBridgeHeartbeat(
      directory,
      'bridge-old-task',
      '2026-07-30T04:00:02.000Z',
      { workbenchSessionId: 'workbench-current' },
    ),
    false,
  );
});
