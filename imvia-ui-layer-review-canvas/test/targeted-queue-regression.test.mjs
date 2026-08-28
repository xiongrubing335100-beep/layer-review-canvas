import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  claimNextForegroundDispatchFromRoots,
  enqueueForegroundDispatch,
  markForegroundDispatchDelivered,
  readForegroundQueueSummaryFromRoots,
} from '../src/foreground-dispatch.js';
import {
  readWorkbenchSession,
  rotateWorkbenchSession,
} from '../src/workbench-lifecycle-store.js';
import {
  activateConversationBridge,
  markConversationBridgeHeartbeat,
} from '../src/conversation-bridge-presence.js';
import { buildPosterTargetedCandidatePrompt } from '../src/poster-prompt.js';
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

test('a delivered task is reclaimed by a replacement bridge after its confirmation lease expires', async (t) => {
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

  await markForegroundDispatchDelivered(fixture.jobDirectory, {
    bridgeId: firstClaim.bridgeId,
    claimToken: firstClaim.claimToken,
    deliveredAt: '2026-08-23T00:00:02.000Z',
    dispatchId,
    rootKind: 'poster',
  });

  const recoveredClaim = await claimNextForegroundDispatchFromRoots([fixture.jobsDirectory], {
    bridgeId: 'bridge-after-reload',
    workbenchSessionId: 'session-a',
    claimedAt: '2026-08-23T00:01:03.000Z',
    leaseMs: 1_000,
  });

  assert.equal(recoveredClaim.dispatchId, dispatchId);
  assert.equal(recoveredClaim.bridgeId, 'bridge-after-reload');
  assert.notEqual(recoveredClaim.claimToken, firstClaim.claimToken);
});

test('an expired delivery from an old workbench session cannot block the current session queue', async (t) => {
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

test('targeted prompt treats the whole plan file hash as audit metadata, not a live expiry gate', () => {
  const prompt = buildPosterTargetedCandidatePrompt({
    jobId: 'poster-a',
    planPath: '/tmp/poster-a/poster-layer-plan.json',
    snapshotPath: '/tmp/poster-a/poster-layer-plan.json',
    sourcePath: '/tmp/poster-a/source.png',
    selectedCropPath: '/tmp/poster-a/evidence/layer-3.selected-crop.png',
    expectedOutput: { width: 320, height: 180 },
    layerIndex: 3,
    candidateNumber: 1,
    processingCategory: 'brand_ui',
  });

  assert.match(prompt, /snapshot_file_sha256.*派发时.*审计/);
  assert.match(prompt, /不得仅因.*整份计划文件.*哈希.*失效/);
});

test('reopening the workbench rotates the queue session so old messages cannot reach the new bridge', async (t) => {
  const fixture = await createPosterQueueFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const firstSessionId = await rotateWorkbenchSession(fixture.root, {
    sessionId: 'session-before-reopen',
    reopenedAt: '2026-08-23T01:00:00.000Z',
  });
  await activateConversationBridge(
    fixture.root,
    'bridge-before-reopen',
    '2026-08-23T01:00:00.500Z',
    { workbenchSessionId: firstSessionId },
  );
  await enqueueForegroundDispatch(fixture.jobDirectory, {
    dispatchId: 'dispatch-from-old-workbench',
    taskKind: 'poster_candidate',
    layerIndex: 2,
    candidateNumber: 1,
    submittedAt: '2026-08-23T01:00:01.000Z',
    workbenchSessionId: firstSessionId,
    planPath: fixture.planPath,
    prompt: 'old message must not be sent after reopen',
  });

  const reopenedSessionId = await rotateWorkbenchSession(fixture.root, {
    sessionId: 'session-after-reopen',
    reopenedAt: '2026-08-23T01:01:00.000Z',
  });

  assert.equal(await readWorkbenchSession(fixture.root), reopenedSessionId);
  assert.notEqual(reopenedSessionId, firstSessionId);
  assert.equal(await markConversationBridgeHeartbeat(
    fixture.root,
    'bridge-before-reopen',
    '2026-08-23T01:01:01.000Z',
    { workbenchSessionId: firstSessionId },
  ), false);
  assert.deepEqual(
    await readForegroundQueueSummaryFromRoots([fixture.jobsDirectory], {
      bridgeId: 'bridge-after-reopen',
      workbenchSessionId: reopenedSessionId,
    }),
    { count: 0, jobIds: [] },
  );
  assert.equal(await claimNextForegroundDispatchFromRoots([fixture.jobsDirectory], {
    bridgeId: 'bridge-after-reopen',
    workbenchSessionId: reopenedSessionId,
    claimedAt: '2026-08-23T01:01:01.000Z',
  }), null);
});

test('a delayed bridge card from the previous workbench session cannot register after reopen', async (t) => {
  const fixture = await createPosterQueueFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await rotateWorkbenchSession(fixture.root, {
    sessionId: 'current-workbench-session',
    reopenedAt: '2026-08-23T01:02:00.000Z',
  });

  const registration = await activateConversationBridge(
    fixture.root,
    'delayed-bridge-from-previous-session',
    '2026-08-23T01:02:01.000Z',
    { workbenchSessionId: 'previous-workbench-session' },
  );

  assert.equal(registration.active, false);
  assert.equal(registration.workbenchSessionId, 'current-workbench-session');
  assert.equal(await markConversationBridgeHeartbeat(
    fixture.root,
    'delayed-bridge-from-previous-session',
    '2026-08-23T01:02:02.000Z',
    { workbenchSessionId: 'previous-workbench-session' },
  ), false);
});
