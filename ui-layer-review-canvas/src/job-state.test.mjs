import assert from 'node:assert/strict';
import test from 'node:test';
import { jobMatchesSource, reconcileTurnStatus } from './job-state.js';

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
