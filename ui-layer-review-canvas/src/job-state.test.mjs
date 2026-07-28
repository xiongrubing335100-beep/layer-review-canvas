import assert from 'node:assert/strict';
import test from 'node:test';
import * as jobState from './job-state.js';

const { jobMatchesSource, reconcileTurnStatus } = jobState;

test('jobs from another uploaded image do not bind to the current layer ids', () => {
  const currentSource = { name: '情报探索-4个副本.png', width: 750, height: 1624 };
  const oldJob = {
    sourceName: 'source.png',
    sourceSize: { width: 1500, height: 3664 },
  };

  assert.equal(jobMatchesSource(oldJob, currentSource), false);
});

test('jobs from the current image remain visible', () => {
  const currentSource = { name: 'screen.png', width: 750, height: 1624 };
  const currentJob = {
    sourceName: 'screen.png',
    sourceSize: { width: 750, height: 1624 },
  };

  assert.equal(jobMatchesSource(currentJob, currentSource), true);
});

test('a completed Codex turn without a PNG does not stay processing', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'sent_to_codex',
    turnStatus: 'completed',
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'failed',
    detail: 'Codex 任务已结束，但没有回传拆分 PNG',
  });
});

test('an active Codex turn remains processing', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'sent_to_codex',
    turnStatus: 'inProgress',
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'processing',
    detail: null,
  });
});

test('a foreground split stays waiting until the bridge posts it to the conversation', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'awaiting_codex_message',
    turnStatus: null,
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'awaiting_codex_message',
    detail: '等待 Codex 会话桥接发送',
  });
});

test('a completed execution report finishes a foreground split without a background turn', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'sent_to_codex',
    reportStatus: 'completed',
    turnStatus: null,
    resultReady: true,
    imageCount: 1,
  }), {
    status: 'completed',
    detail: null,
  });
});

test('a confirmation request is not shown as processing', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'needs_confirmation',
    turnStatus: 'completed',
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'needs_confirmation',
    detail: 'Codex 需要确认拆分目标后才能继续',
  });
});

test('a failed executor report overrides an active turn and existing PNGs', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'sent_to_codex',
    reportStatus: 'failed',
    turnStatus: 'inProgress',
    resultReady: true,
    imageCount: 1,
  }), {
    status: 'failed',
    detail: null,
  });
});

test('a failed executor report overrides a completed turn and existing PNGs', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'completed',
    reportStatus: 'failed',
    turnStatus: 'completed',
    resultReady: true,
    imageCount: 1,
  }), {
    status: 'failed',
    detail: null,
  });
});

test('needs confirmation is terminal for polling until resubmission', () => {
  assert.equal(jobState.shouldPollJob?.({
    status: 'needs_confirmation',
    completedAt: null,
    snapshotVerified: false,
  }), false);
});

test('elapsed time stops at report completion timing when available', () => {
  const reportCompletedAt = '2026-07-27T00:00:05.000Z';
  assert.equal(jobState.elapsedEnd?.({
    status: 'needs_confirmation',
    submittedAt: Date.parse('2026-07-27T00:00:00.000Z'),
    confirmationRequestedAt: Date.parse('2026-07-27T00:00:09.000Z'),
    timing: { completed_at: reportCompletedAt },
  }, Date.parse('2026-07-27T00:00:12.000Z')), Date.parse(reportCompletedAt));
});
