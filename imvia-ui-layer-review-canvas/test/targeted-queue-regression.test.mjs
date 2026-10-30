import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cancelForegroundDispatch,
  claimNextForegroundDispatchFromRoots,
  enqueueForegroundDispatch,
  markForegroundDispatchDelivered,
  readForegroundDispatch,
  readForegroundQueueSummaryFromRoots,
} from '../src/foreground-dispatch.js';
import { resetPosterDispatchesForOpen } from '../src/poster-dispatch-control.js';
import {
  activateConversationBridge,
  markConversationBridgeHeartbeat,
} from '../src/conversation-bridge-presence.js';
import { buildFastLayerSnapshot } from '../src/poster-fast-plan.js';
import { canonicalJson, digestCanonicalJson } from '../src/poster-plan.js';
import { assertPosterFastAuthorizationBinding } from '../src/poster-job-store.js';
import {
  readWorkbenchSessionId,
  resolveWorkbenchSessionId,
  startConversationBridge,
} from '../public/layer-review-bridge-widget.js';

async function createPosterQueueFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-delivered-recovery-'));
  const jobsDirectory = path.join(root, 'poster-jobs');
  const jobId = 'poster-delivered-recovery';
  const jobDirectory = path.join(jobsDirectory, jobId);
  const planPath = path.join(jobDirectory, 'poster-layer-plan.json');
  await mkdir(jobDirectory, { recursive: true });
  await writeFile(planPath, JSON.stringify({ job_id: jobId, status: 'PLAN_CONFIRMED' }));
  await writeFile(
    path.join(jobDirectory, 'poster-execution-report.json'),
    JSON.stringify({ status: 'INITIALIZED' }),
  );
  return { root, jobsDirectory, jobId, jobDirectory, planPath };
}

test('an undelivered claim is recovered by a replacement bridge after its lease expires', async (t) => {
  const fixture = await createPosterQueueFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const dispatchId = 'dispatch-delivered-recovery';
  await enqueueForegroundDispatch(fixture.jobDirectory, {
    dispatchId,
    taskKind: 'poster_candidate',
    layerIndex: 2,
    candidateNumber: 1,
    submittedAt: '2026-08-23T00:00:00.000Z',
    workbenchSessionId: 'session-a',
    planPath: fixture.planPath,
    prompt: 'visible targeted candidate task',
  });

  const firstClaim = await claimNextForegroundDispatchFromRoots([fixture.jobsDirectory], {
    bridgeId: 'bridge-before-reload',
    workbenchSessionId: 'session-a',
    claimedAt: '2026-08-23T00:00:01.000Z',
    leaseMs: 1_000,
  });
  assert.equal(firstClaim.dispatchId, dispatchId);

  const recoveredClaim = await claimNextForegroundDispatchFromRoots([fixture.jobsDirectory], {
    bridgeId: 'bridge-after-reload',
    workbenchSessionId: 'session-a',
    claimedAt: '2026-08-23T00:01:03.000Z',
    leaseMs: 1_000,
  });

  assert.equal(recoveredClaim.dispatchId, dispatchId);
  assert.equal(recoveredClaim.bridgeId, 'bridge-after-reload');
  assert.notEqual(recoveredClaim.claimToken, firstClaim.claimToken);
  await assert.rejects(markForegroundDispatchDelivered(fixture.jobDirectory, {
    bridgeId: firstClaim.bridgeId,
    claimToken: firstClaim.claimToken,
    deliveredAt: '2026-08-23T00:01:04.000Z',
    dispatchId,
    rootKind: 'poster',
  }), /领取凭证已失效/);
});

test('a delivered message is not replayed on reload and cancellation releases the queue', async (t) => {
  const fixture = await createPosterQueueFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await enqueueForegroundDispatch(fixture.jobDirectory, {
    dispatchId: 'dispatch-from-old-session',
    taskKind: 'poster_candidate',
    layerIndex: 1,
    candidateNumber: 1,
    submittedAt: '2026-08-23T00:00:00.000Z',
    workbenchSessionId: 'old-workbench-session',
    planPath: fixture.planPath,
    prompt: 'old workbench message',
  });
  const oldClaim = await claimNextForegroundDispatchFromRoots([fixture.jobsDirectory], {
    bridgeId: 'old-bridge',
    workbenchSessionId: 'old-workbench-session',
    claimedAt: '2026-08-23T00:00:01.000Z',
    leaseMs: 1_000,
  });
  await markForegroundDispatchDelivered(fixture.jobDirectory, {
    bridgeId: oldClaim.bridgeId,
    claimToken: oldClaim.claimToken,
    deliveredAt: '2026-08-23T00:00:02.000Z',
    dispatchId: oldClaim.dispatchId,
    rootKind: 'poster',
  });
  const dispatchPath = path.join(fixture.jobDirectory, 'foreground-dispatches', `${oldClaim.dispatchId}.json`);
  const delivered = JSON.parse(await readFile(dispatchPath, 'utf8'));
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.leaseExpiresAt, null);
  assert.equal(await claimNextForegroundDispatchFromRoots([fixture.jobsDirectory], {
    bridgeId: 'replacement-bridge',
    workbenchSessionId: 'old-workbench-session',
    claimedAt: '2026-08-23T00:01:00.000Z',
  }), null);
  assert.deepEqual(JSON.parse(await readFile(dispatchPath, 'utf8')), delivered);
  await cancelForegroundDispatch(fixture.jobDirectory, '2026-08-23T00:01:00.000Z', {
    dispatchId: oldClaim.dispatchId,
    rootKind: 'poster',
  });

  const currentJobId = 'poster-current-session';
  const currentJobDirectory = path.join(fixture.jobsDirectory, currentJobId);
  const currentPlanPath = path.join(currentJobDirectory, 'poster-layer-plan.json');
  await mkdir(currentJobDirectory, { recursive: true });
  await writeFile(currentPlanPath, JSON.stringify({
    job_id: currentJobId,
    status: 'PLAN_CONFIRMED',
  }));
  await writeFile(
    path.join(currentJobDirectory, 'poster-execution-report.json'),
    JSON.stringify({ status: 'INITIALIZED' }),
  );
  await enqueueForegroundDispatch(currentJobDirectory, {
    dispatchId: 'dispatch-from-current-session',
    taskKind: 'poster_candidate',
    layerIndex: 2,
    candidateNumber: 1,
    submittedAt: '2026-08-23T00:01:00.000Z',
    workbenchSessionId: 'current-workbench-session',
    planPath: currentPlanPath,
    prompt: 'current workbench message must be delivered',
  });

  const currentClaim = await claimNextForegroundDispatchFromRoots([fixture.jobsDirectory], {
    bridgeId: 'current-bridge',
    workbenchSessionId: 'current-workbench-session',
    claimedAt: '2026-08-23T00:01:01.000Z',
    leaseMs: 1_000,
  });

  assert.equal(currentClaim?.dispatchId, 'dispatch-from-current-session');
  assert.equal(currentClaim?.workbenchSessionId, 'current-workbench-session');
  assert.equal((await readForegroundDispatch(fixture.jobDirectory, {
    dispatchId: oldClaim.dispatchId,
    rootKind: 'poster',
  })).status, 'cancelled');
});

test('the bridge remembers its workbench session across a widget reload', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const originalWindow = globalThis.window;
  try {
    globalThis.window = {
      openai: { toolOutput: { workbenchSessionId: 'session-persisted' } },
      sessionStorage: storage,
    };
    assert.equal(readWorkbenchSessionId(), 'session-persisted');

    globalThis.window.openai.toolOutput = {};
    assert.equal(readWorkbenchSessionId(), 'session-persisted');
  } finally {
    globalThis.window = originalWindow;
  }
});

test('bridge startup waits for an asynchronously recovered workbench session', async () => {
  let registeredSessionId = null;
  const started = await startConversationBridge({
    bridgeId: 'bridge-async-session',
    connectedAt: '2026-08-23T00:00:00.000Z',
    getWorkbenchSessionId: async () => 'session-from-workbench',
    connect: async () => ({ mode: 'ui_message' }),
    registerBridge: async (_bridgeId, _connectedAt, sessionId) => {
      registeredSessionId = sessionId;
      return { active: true };
    },
    heartbeatBridge: async () => ({ active: true }),
    pollOnce: async () => {},
    setBridgeStatus: () => {},
    bindPendingSend: () => {},
    schedulePoll: () => 1,
    clearPoll: () => {},
    scheduleHeartbeat: () => 2,
    clearHeartbeat: () => {},
    scheduleRetry: () => {},
  });

  assert.equal(started, true);
  assert.equal(registeredSessionId, 'session-from-workbench');
});

test('the bridge can recover its session directly from the running workbench', async () => {
  const values = new Map();
  const originalWindow = globalThis.window;
  try {
    globalThis.window = {
      openai: { toolOutput: {} },
      sessionStorage: {
        getItem: (key) => values.get(key) || null,
        setItem: (key, value) => values.set(key, String(value)),
      },
    };
    const recovered = await resolveWorkbenchSessionId({
      fetchSession: async () => ({
        ok: true,
        json: async () => ({ workbench_session_id: 'session-from-http' }),
      }),
    });
    assert.equal(recovered, 'session-from-http');
    assert.equal(readWorkbenchSessionId(), 'session-from-http');
  } finally {
    globalThis.window = originalWindow;
  }
});

test('targeted authorization survives unrelated plan edits but rejects changed snapshot content', () => {
  const { plan, snapshot } = buildFastLayerSnapshot({
    job_id: 'poster-a',
    project_id: 'project-a',
    image_id: 'image-a',
    plan_version: 1,
    planning_mode: 'targeted_fast',
    source: { path: 'source.png', width: 320, height: 180 },
    skill_contract: {},
    layers: [{ layer_index: 3, processing_category: 'brand_ui', prompt: '只保留品牌标识' }],
  }, 3, {}, '2026-08-23T00:00:00.000Z');
  const planFileHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const authorization = {
    planning_mode: 'targeted_fast',
    layer_index: 3,
    snapshot_id: snapshot.snapshot_id,
    source_fingerprint: digestCanonicalJson(plan.source),
    processing_category: 'brand_ui',
    snapshot_sha256: createHash('sha256').update(canonicalJson(snapshot)).digest('hex'),
    snapshot_file_sha256: planFileHash(plan),
  };
  assert.equal(assertPosterFastAuthorizationBinding({ plan }, authorization), true);
  plan.audit_note = 'another layer is under review';
  assert.notEqual(planFileHash(plan), authorization.snapshot_file_sha256);
  assert.equal(assertPosterFastAuthorizationBinding({ plan }, authorization), true);

  plan.layers[0].confirmed_snapshot.layer.prompt = 'changed after authorization';
  assert.throws(() => assertPosterFastAuthorizationBinding({ plan }, authorization), /snapshot or source binding is stale/);
});

test('reopening cancels old pending messages without rotating the workbench session', async (t) => {
  const fixture = await createPosterQueueFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const sessionId = 'persisted-workbench-session';
  await activateConversationBridge(
    fixture.root,
    'bridge-before-reopen',
    '2026-08-23T01:00:00.500Z',
    { workbenchSessionId: sessionId },
  );
  await enqueueForegroundDispatch(fixture.jobDirectory, {
    dispatchId: 'dispatch-from-old-workbench',
    taskKind: 'poster_analysis',
    submittedAt: '2026-08-23T01:00:01.000Z',
    workbenchSessionId: sessionId,
    planPath: fixture.planPath,
    prompt: 'old message must not be sent after reopen',
  });

  assert.deepEqual(await resetPosterDispatchesForOpen(
    fixture.jobsDirectory,
    '2026-08-23T01:01:00.000Z',
  ), { cancelledDispatchIds: ['dispatch-from-old-workbench'], abandonedDispatchIds: [] });
  await activateConversationBridge(
    fixture.root,
    'bridge-after-reopen',
    '2026-08-23T01:01:00.500Z',
    { workbenchSessionId: sessionId },
  );

  assert.equal(await markConversationBridgeHeartbeat(
    fixture.root,
    'bridge-before-reopen',
    '2026-08-23T01:01:01.000Z',
    { workbenchSessionId: sessionId },
  ), false);
  assert.deepEqual(
    await readForegroundQueueSummaryFromRoots([fixture.jobsDirectory], {
      bridgeId: 'bridge-after-reopen',
      workbenchSessionId: sessionId,
    }),
    { count: 0, jobIds: [] },
  );
  assert.equal(await claimNextForegroundDispatchFromRoots([fixture.jobsDirectory], {
    bridgeId: 'bridge-after-reopen',
    workbenchSessionId: sessionId,
    claimedAt: '2026-08-23T01:01:01.000Z',
  }), null);
  assert.equal((await readForegroundDispatch(fixture.jobDirectory, {
    dispatchId: 'dispatch-from-old-workbench',
    rootKind: 'poster',
  })).status, 'cancelled');
  assert.deepEqual(await resetPosterDispatchesForOpen(
    fixture.jobsDirectory,
    '2026-08-23T01:02:00.000Z',
  ), { cancelledDispatchIds: [], abandonedDispatchIds: [] });
});

test('an older bridge card cannot replace the current listener in the persisted session', async (t) => {
  const fixture = await createPosterQueueFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await activateConversationBridge(
    fixture.root,
    'current-bridge',
    '2026-08-23T01:02:00.000Z',
    { workbenchSessionId: 'persisted-workbench-session' },
  );

  const registration = await activateConversationBridge(
    fixture.root,
    'delayed-bridge-from-previous-session',
    '2026-08-23T01:01:00.000Z',
    { workbenchSessionId: 'persisted-workbench-session' },
  );

  assert.equal(registration.active, false);
  assert.equal(registration.workbenchSessionId, 'persisted-workbench-session');
  assert.equal(registration.bridgeId, 'current-bridge');
  assert.equal(await markConversationBridgeHeartbeat(
    fixture.root,
    'delayed-bridge-from-previous-session',
    '2026-08-23T01:02:02.000Z',
    { workbenchSessionId: 'persisted-workbench-session' },
  ), false);
});

test('terminal dispatch records survive reopening without becoming claimable again', async (t) => {
  const fixture = await createPosterQueueFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const records = [];
  for (const status of ['completed', 'failed', 'cancelled']) {
    // Persisted terminal records model a prior process, not a successful new run.
    const record = {
      dispatchId: `dispatch-${status}`,
      jobId: fixture.jobId,
      rootKind: 'poster',
      taskKind: 'poster_candidate',
      layerIndex: 2,
      candidateNumber: 1,
      workbenchSessionId: 'persisted-workbench-session',
      planPath: fixture.planPath,
      prompt: 'must never be sent again',
      status,
    };
    const file = path.join(fixture.jobDirectory, 'foreground-dispatches', `${record.dispatchId}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(record));
    records.push({ file, record });
  }
  assert.deepEqual(await resetPosterDispatchesForOpen(fixture.jobsDirectory), {
    cancelledDispatchIds: [],
    abandonedDispatchIds: [],
  });
  const listener = {
    bridgeId: 'bridge-after-reopen',
    workbenchSessionId: 'persisted-workbench-session',
  };
  assert.deepEqual(await readForegroundQueueSummaryFromRoots([fixture.jobsDirectory], listener), {
    count: 0, jobIds: [],
  });
  assert.equal(await claimNextForegroundDispatchFromRoots([fixture.jobsDirectory], listener), null);
  for (const { file, record } of records) {
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), record);
  }
});
