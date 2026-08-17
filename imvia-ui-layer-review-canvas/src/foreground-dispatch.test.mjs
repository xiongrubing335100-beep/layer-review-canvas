import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acknowledgeForegroundDispatch,
  cancelForegroundDispatch,
  claimNextForegroundDispatch,
  enqueueForegroundDispatch,
  markForegroundDispatchDelivered,
  readForegroundQueueSummary,
  readNextForegroundDispatch,
  releaseForegroundDispatchClaim,
} from './foreground-dispatch.js';

test('the oldest pending split is exposed first for a foreground conversation message', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const firstDirectory = path.join(jobsDirectory, 'job-1');
  const secondDirectory = path.join(jobsDirectory, 'job-2');
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);

  await enqueueForegroundDispatch(firstDirectory, {
    jobId: 'job-1',
    prompt: 'first prompt',
    submittedAt: '2026-07-28T10:00:00.000Z',
  });
  await enqueueForegroundDispatch(secondDirectory, {
    jobId: 'job-2',
    prompt: 'second prompt',
    submittedAt: '2026-07-28T10:00:01.000Z',
  });

  assert.deepEqual(await readNextForegroundDispatch(jobsDirectory), {
    jobId: 'job-1',
    prompt: 'first prompt',
    submittedAt: '2026-07-28T10:00:00.000Z',
  });
});

test('the conversation bridge reports pending queue items even while another task is active', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  for (const [jobId, submittedAt] of [
    ['job-active', '2026-07-28T10:00:00.000Z'],
    ['job-queued', '2026-07-28T10:00:01.000Z'],
  ]) {
    const jobDirectory = path.join(jobsDirectory, jobId);
    await mkdir(jobDirectory);
    await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
      job_id: jobId,
      status: jobId === 'job-active' ? 'sent_to_codex' : 'queued',
    }));
    await enqueueForegroundDispatch(jobDirectory, {
      jobId,
      prompt: `${jobId} prompt`,
      submittedAt,
      targetBridgeId: 'bridge-current',
      workbenchSessionId: 'workbench-current',
    });
  }

  const summary = await readForegroundQueueSummary(jobsDirectory, {
    bridgeId: 'bridge-current',
    workbenchSessionId: 'workbench-current',
  });

  assert.deepEqual(summary, {
    count: 2,
    jobIds: ['job-active', 'job-queued'],
  });
});

test('completed jobs never reappear in a reopened conversation queue', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const jobDirectory = path.join(jobsDirectory, 'job-completed');
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-completed',
    status: 'queued',
  }));
  await writeFile(path.join(jobDirectory, 'execution-report.json'), JSON.stringify({
    status: 'completed',
  }));
  await enqueueForegroundDispatch(jobDirectory, {
    jobId: 'job-completed',
    prompt: 'stale completed prompt',
    submittedAt: '2026-07-28T10:00:00.000Z',
    workbenchSessionId: 'workbench-current',
  });

  assert.deepEqual(await readForegroundQueueSummary(jobsDirectory, {
    bridgeId: 'bridge-new',
    workbenchSessionId: 'workbench-current',
  }), {
    count: 0,
    jobIds: [],
  });
  assert.equal(await readNextForegroundDispatch(jobsDirectory), null);
});

test('newer tasks remain queued behind older tasks on the same conversation bridge', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const firstDirectory = path.join(jobsDirectory, 'job-1');
  const secondDirectory = path.join(jobsDirectory, 'job-2');
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  await Promise.all([
    writeFile(path.join(firstDirectory, 'layer-review-plan.json'), JSON.stringify({
      job_id: 'job-1',
      status: 'awaiting_codex_message',
    })),
    writeFile(path.join(secondDirectory, 'layer-review-plan.json'), JSON.stringify({
      job_id: 'job-2',
      status: 'awaiting_codex_message',
    })),
  ]);

  await enqueueForegroundDispatch(firstDirectory, {
    jobId: 'job-1',
    prompt: 'first prompt',
    submittedAt: '2026-07-28T10:00:00.000Z',
    targetBridgeId: 'bridge-current',
    workbenchSessionId: 'workbench-current',
  });
  await enqueueForegroundDispatch(secondDirectory, {
    jobId: 'job-2',
    prompt: 'second prompt',
    submittedAt: '2026-07-28T10:00:01.000Z',
    targetBridgeId: 'bridge-current',
    workbenchSessionId: 'workbench-current',
  });

  const first = JSON.parse(await readFile(
    path.join(firstDirectory, 'foreground-dispatch.json'),
    'utf8',
  ));
  const second = JSON.parse(await readFile(
    path.join(secondDirectory, 'foreground-dispatch.json'),
    'utf8',
  ));
  assert.equal(first.status, 'pending');
  assert.equal(second.status, 'pending');
  assert.equal((await readNextForegroundDispatch(jobsDirectory)).jobId, 'job-1');
});

test('a queued split waits until the active conversation job reaches a terminal report', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const activeDirectory = path.join(jobsDirectory, 'job-active');
  const queuedDirectory = path.join(jobsDirectory, 'job-queued');
  await mkdir(activeDirectory);
  await mkdir(queuedDirectory);
  await writeFile(path.join(activeDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-active',
    status: 'sent_to_codex',
  }));
  await writeFile(path.join(queuedDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-queued',
    status: 'queued',
  }));
  await enqueueForegroundDispatch(queuedDirectory, {
    jobId: 'job-queued',
    prompt: 'queued prompt',
    submittedAt: '2026-07-28T10:00:01.000Z',
  });

  assert.equal(await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-current',
    claimedAt: '2026-07-28T10:00:02.000Z',
  }), null);

  await writeFile(path.join(activeDirectory, 'execution-report.json'), JSON.stringify({
    status: 'completed',
  }));
  const claim = await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-current',
    claimedAt: '2026-07-28T10:00:03.000Z',
  });
  assert.equal(claim.jobId, 'job-queued');
});

test('a claimed task includes its confirmation-card summary and crop preview', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const jobDirectory = path.join(jobsDirectory, 'job-preview');
  const previewPath = path.join(jobDirectory, 'selection.png');
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-preview',
    status: 'awaiting_codex_message',
  }));
  await writeFile(previewPath, Buffer.from('preview-binary'));
  await enqueueForegroundDispatch(jobDirectory, {
    jobId: 'job-preview',
    prompt: 'split preview',
    submittedAt: '2026-07-28T10:00:00.000Z',
    presentation: {
      layerName: 'UI 组件 1',
      width: 427,
      height: 137,
      removeBackground: true,
      promptSummary: '保留按钮渐变和光效',
      previewPath,
    },
  });

  const claim = await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-current',
  });
  assert.equal(claim.presentation.layerName, 'UI 组件 1');
  assert.equal(claim.presentation.preview.mimeType, 'image/png');
  assert.equal(
    claim.presentation.preview.data,
    Buffer.from('preview-binary').toString('base64'),
  );
  assert.equal(claim.presentation.preview.path, previewPath);
});

test('a fresh listener in the same workbench session can reclaim an old targeted split', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const jobDirectory = path.join(jobsDirectory, 'job-bound');
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-bound',
    status: 'awaiting_codex_message',
  }));
  await enqueueForegroundDispatch(jobDirectory, {
    jobId: 'job-bound',
    prompt: 'bound prompt',
    submittedAt: '2026-07-30T04:00:00.000Z',
    targetBridgeId: 'bridge-current-task',
    workbenchSessionId: 'workbench-current',
  });

  assert.equal(
    await claimNextForegroundDispatch(jobsDirectory, {
      bridgeId: 'bridge-old-task',
      workbenchSessionId: 'workbench-old',
      claimedAt: '2026-07-30T04:00:01.000Z',
    }),
    null,
  );

  const claim = await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-new-task',
    workbenchSessionId: 'workbench-current',
    claimedAt: '2026-07-30T04:00:02.000Z',
  });
  assert.equal(claim.jobId, 'job-bound');
  assert.equal(claim.bridgeId, 'bridge-new-task');
  assert.equal(claim.workbenchSessionId, 'workbench-current');
});

test('transport acceptance cannot remove a split before the current Codex task confirms receipt', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const jobDirectory = path.join(jobsDirectory, 'job-1');
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-1',
    status: 'awaiting_codex_message',
  }));
  await enqueueForegroundDispatch(jobDirectory, {
    jobId: 'job-1',
    prompt: 'prompt',
    submittedAt: '2026-07-28T10:00:00.000Z',
  });

  await assert.rejects(
    acknowledgeForegroundDispatch(jobDirectory, '2026-07-28T10:00:01.000Z'),
    /当前 Codex 任务确认/,
  );
  assert.equal((await readNextForegroundDispatch(jobsDirectory))?.jobId, 'job-1');

  const claim = await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-current',
    claimedAt: '2026-07-28T10:00:01.100Z',
  });
  await assert.rejects(
    acknowledgeForegroundDispatch(jobDirectory, '2026-07-28T10:00:01.200Z', {
      confirmationSource: 'codex_model_tool',
    }),
    /尚未由宿主接收/,
  );
  await markForegroundDispatchDelivered(jobDirectory, {
    bridgeId: 'bridge-current',
    claimToken: claim.claimToken,
    deliveredAt: '2026-07-28T10:00:01.500Z',
  });
  await acknowledgeForegroundDispatch(jobDirectory, '2026-07-28T10:00:02.000Z', {
    confirmationSource: 'codex_model_tool',
  });

  assert.equal(await readNextForegroundDispatch(jobsDirectory), null);
  const plan = JSON.parse(await readFile(path.join(jobDirectory, 'layer-review-plan.json'), 'utf8'));
  assert.equal(plan.status, 'sent_to_codex');
  assert.equal(plan.codex_message_sent_at, '2026-07-28T10:00:02.000Z');
  assert.equal(plan.codex_message_confirmation, 'codex_model_tool');
});

test('cancellation wins when it starts before Codex confirmation', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const jobDirectory = path.join(jobsDirectory, 'job-race');
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-race',
    status: 'awaiting_codex_message',
  }));
  await enqueueForegroundDispatch(jobDirectory, {
    jobId: 'job-race',
    prompt: 'prompt',
    submittedAt: '2026-07-29T10:00:00.000Z',
  });
  const claim = await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-current',
    claimedAt: '2026-07-29T10:00:01.000Z',
  });
  await markForegroundDispatchDelivered(jobDirectory, {
    bridgeId: 'bridge-current',
    claimToken: claim.claimToken,
    deliveredAt: '2026-07-29T10:00:02.000Z',
  });

  const [cancelResult, confirmResult] = await Promise.allSettled([
    cancelForegroundDispatch(jobDirectory, '2026-07-29T10:00:03.000Z'),
    acknowledgeForegroundDispatch(jobDirectory, '2026-07-29T10:00:03.100Z', {
      confirmationSource: 'codex_model_tool',
    }),
  ]);

  assert.equal(cancelResult.status, 'fulfilled');
  assert.equal(confirmResult.status, 'rejected');
  assert.match(confirmResult.reason.message, /已取消/);
  assert.equal(JSON.parse(await readFile(
    path.join(jobDirectory, 'layer-review-plan.json'),
    'utf8',
  )).status, 'cancelled');
});

test('cancelling the first pending job exposes the next queued job', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const firstDirectory = path.join(jobsDirectory, 'job-1');
  const secondDirectory = path.join(jobsDirectory, 'job-2');
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  await Promise.all([
    writeFile(path.join(firstDirectory, 'layer-review-plan.json'), JSON.stringify({
      job_id: 'job-1',
      status: 'awaiting_codex_message',
    })),
    writeFile(path.join(secondDirectory, 'layer-review-plan.json'), JSON.stringify({
      job_id: 'job-2',
      status: 'awaiting_codex_message',
    })),
  ]);
  await enqueueForegroundDispatch(firstDirectory, {
    jobId: 'job-1',
    prompt: 'first prompt',
    submittedAt: '2026-07-28T10:00:00.000Z',
  });
  await enqueueForegroundDispatch(secondDirectory, {
    jobId: 'job-2',
    prompt: 'second prompt',
    submittedAt: '2026-07-28T10:00:01.000Z',
  });

  await cancelForegroundDispatch(firstDirectory, '2026-07-28T10:00:02.000Z');

  assert.equal((await readNextForegroundDispatch(jobsDirectory))?.jobId, 'job-2');
  const dispatch = JSON.parse(await readFile(
    path.join(firstDirectory, 'foreground-dispatch.json'),
    'utf8',
  ));
  const plan = JSON.parse(await readFile(
    path.join(firstDirectory, 'layer-review-plan.json'),
    'utf8',
  ));
  assert.equal(dispatch.status, 'cancelled');
  assert.equal(plan.status, 'cancelled');
  assert.equal(plan.cancelled_at, '2026-07-28T10:00:02.000Z');
});

test('a queued job can be cancelled before the listener claims it', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const jobDirectory = path.join(jobsDirectory, 'job-queued');
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-queued',
    status: 'queued',
  }));
  await enqueueForegroundDispatch(jobDirectory, {
    jobId: 'job-queued',
    prompt: 'queued prompt',
    submittedAt: '2026-07-28T10:00:00.000Z',
  });

  await cancelForegroundDispatch(jobDirectory, '2026-07-28T10:00:01.000Z');

  assert.equal(await readNextForegroundDispatch(jobsDirectory), null);
  assert.equal(JSON.parse(await readFile(
    path.join(jobDirectory, 'layer-review-plan.json'),
    'utf8',
  )).status, 'cancelled');
});

test('only one active conversation bridge can claim a queued split', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const jobDirectory = path.join(jobsDirectory, 'job-1');
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-1',
    status: 'awaiting_codex_message',
  }));
  await enqueueForegroundDispatch(jobDirectory, {
    jobId: 'job-1',
    prompt: 'prompt',
    submittedAt: '2026-07-29T10:00:00.000Z',
  });

  const claimed = await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-current',
    claimedAt: '2026-07-29T10:00:01.000Z',
    leaseMs: 4_000,
  });

  assert.equal(claimed.jobId, 'job-1');
  assert.equal(typeof claimed.claimToken, 'string');
  assert.equal(
    await claimNextForegroundDispatch(jobsDirectory, {
      bridgeId: 'bridge-old',
      claimedAt: '2026-07-29T10:00:02.000Z',
      leaseMs: 4_000,
    }),
    null,
  );
});

test('an expired delivery claim can be recovered without leaving the queue blocked', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const jobDirectory = path.join(jobsDirectory, 'job-1');
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-1',
    status: 'awaiting_codex_message',
  }));
  await enqueueForegroundDispatch(jobDirectory, {
    jobId: 'job-1',
    prompt: 'prompt',
    submittedAt: '2026-07-29T10:00:00.000Z',
  });

  const firstClaim = await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-old',
    claimedAt: '2026-07-29T10:00:01.000Z',
    leaseMs: 4_000,
  });
  const recoveredClaim = await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-current',
    claimedAt: '2026-07-29T10:00:06.000Z',
    leaseMs: 4_000,
  });

  assert.equal(recoveredClaim.jobId, 'job-1');
  assert.notEqual(recoveredClaim.claimToken, firstClaim.claimToken);
  assert.equal(recoveredClaim.bridgeId, 'bridge-current');
});

test('host acceptance is recorded separately from Codex model confirmation', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const jobDirectory = path.join(jobsDirectory, 'job-1');
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-1',
    status: 'awaiting_codex_message',
  }));
  await enqueueForegroundDispatch(jobDirectory, {
    jobId: 'job-1',
    prompt: 'prompt',
    submittedAt: '2026-07-29T10:00:00.000Z',
  });
  const claim = await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-current',
    claimedAt: '2026-07-29T10:00:01.000Z',
  });

  await markForegroundDispatchDelivered(jobDirectory, {
    bridgeId: 'bridge-current',
    claimToken: claim.claimToken,
    deliveredAt: '2026-07-29T10:00:02.000Z',
  });

  const dispatch = JSON.parse(await readFile(
    path.join(jobDirectory, 'foreground-dispatch.json'),
    'utf8',
  ));
  const plan = JSON.parse(await readFile(
    path.join(jobDirectory, 'layer-review-plan.json'),
    'utf8',
  ));
  assert.equal(dispatch.status, 'delivered');
  assert.equal(dispatch.deliveredAt, '2026-07-29T10:00:02.000Z');
  assert.equal(plan.status, 'host_accepted');
  assert.equal(plan.codex_host_accepted_at, '2026-07-29T10:00:02.000Z');
  assert.equal(plan.codex_message_submitted_at, undefined);
  assert.equal(await readNextForegroundDispatch(jobsDirectory), null);

  await acknowledgeForegroundDispatch(jobDirectory, '2026-07-29T10:00:03.000Z', {
    confirmationSource: 'codex_model_tool',
  });
  assert.equal(JSON.parse(await readFile(
    path.join(jobDirectory, 'foreground-dispatch.json'),
    'utf8',
  )).status, 'sent');
});

test('delivery confirmation is idempotent when the first response is lost', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const jobDirectory = path.join(jobsDirectory, 'job-idempotent');
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-idempotent',
    status: 'awaiting_codex_message',
  }));
  await enqueueForegroundDispatch(jobDirectory, {
    jobId: 'job-idempotent',
    prompt: 'prompt',
    submittedAt: '2026-07-29T10:00:00.000Z',
  });
  const claim = await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-current',
    claimedAt: '2026-07-29T10:00:01.000Z',
  });
  const delivery = {
    bridgeId: 'bridge-current',
    claimToken: claim.claimToken,
    deliveredAt: '2026-07-29T10:00:02.000Z',
  };

  await markForegroundDispatchDelivered(jobDirectory, delivery);
  await markForegroundDispatchDelivered(jobDirectory, delivery);

  const dispatch = JSON.parse(await readFile(
    path.join(jobDirectory, 'foreground-dispatch.json'),
    'utf8',
  ));
  assert.equal(dispatch.status, 'delivered');
  assert.equal(dispatch.deliveredAt, delivery.deliveredAt);
});

test('a failed ui message releases its claim so the same task can retry', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const jobDirectory = path.join(jobsDirectory, 'job-1');
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-1',
    status: 'awaiting_codex_message',
  }));
  await enqueueForegroundDispatch(jobDirectory, {
    jobId: 'job-1',
    prompt: 'prompt',
    submittedAt: '2026-07-29T10:00:00.000Z',
  });
  const claim = await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-current',
    claimedAt: '2026-07-29T10:00:01.000Z',
  });

  await releaseForegroundDispatchClaim(jobDirectory, {
    bridgeId: 'bridge-current',
    claimToken: claim.claimToken,
    releasedAt: '2026-07-29T10:00:02.000Z',
    error: 'host unavailable',
  });
  const retry = await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-current',
    claimedAt: '2026-07-29T10:00:03.000Z',
  });

  assert.equal(retry.jobId, 'job-1');
  assert.notEqual(retry.claimToken, claim.claimToken);
  const dispatch = JSON.parse(await readFile(
    path.join(jobDirectory, 'foreground-dispatch.json'),
    'utf8',
  ));
  assert.equal(dispatch.deliveryAttempts, 2);
  assert.equal(dispatch.lastError, 'host unavailable');
});

test('a delivered but unconfirmed message can be cancelled and cannot be confirmed later', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const jobDirectory = path.join(jobsDirectory, 'job-1');
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-1',
    status: 'awaiting_codex_message',
  }));
  await enqueueForegroundDispatch(jobDirectory, {
    jobId: 'job-1',
    prompt: 'prompt',
    submittedAt: '2026-07-29T10:00:00.000Z',
  });
  const claim = await claimNextForegroundDispatch(jobsDirectory, {
    bridgeId: 'bridge-current',
    claimedAt: '2026-07-29T10:00:01.000Z',
  });
  await markForegroundDispatchDelivered(jobDirectory, {
    bridgeId: 'bridge-current',
    claimToken: claim.claimToken,
    deliveredAt: '2026-07-29T10:00:02.000Z',
  });

  await cancelForegroundDispatch(jobDirectory, '2026-07-29T10:00:03.000Z');

  await assert.rejects(
    acknowledgeForegroundDispatch(jobDirectory, '2026-07-29T10:00:04.000Z', {
      confirmationSource: 'codex_model_tool',
    }),
    /已取消/,
  );
});
