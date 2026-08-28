import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advancePosterFastExecution,
  createPosterFastExecution,
  failPosterFastExecution,
  resumePosterFastPostprocess,
} from './poster-fast-execution.js';

const startedAt = '2026-08-22T08:00:00.000Z';

test('targeted fast execution advances monotonically through the visible stages', () => {
  let execution = createPosterFastExecution({
    dispatchId: 'dispatch-1', authorizationId: 'authorization-1', removeBackground: true, startedAt,
  });
  assert.equal(execution.current_stage, 'imagegen');
  assert.equal(execution.stages.imagegen.status, 'running');

  execution = advancePosterFastExecution(execution, 'rmbg', '2026-08-22T08:00:10.000Z');
  assert.equal(execution.stages.imagegen.status, 'completed');
  assert.equal(execution.stages.rmbg.status, 'running');

  execution = advancePosterFastExecution(execution, 'canvas_mapping', '2026-08-22T08:00:20.000Z');
  execution = advancePosterFastExecution(execution, 'finalizing', '2026-08-22T08:00:30.000Z');
  execution = advancePosterFastExecution(execution, 'review_ready', '2026-08-22T08:00:40.000Z');
  assert.equal(execution.status, 'completed');
  assert.equal(execution.current_stage, 'review_ready');
  assert.equal(execution.completed_at, '2026-08-22T08:00:40.000Z');
  assert.equal(execution.stages.finalizing.status, 'completed');
});

test('targeted fast execution marks RMBG skipped when remove background is disabled', () => {
  const execution = createPosterFastExecution({
    dispatchId: 'dispatch-2', authorizationId: 'authorization-2', removeBackground: false, startedAt,
  });
  assert.equal(execution.stages.rmbg.status, 'skipped');
});

test('targeted fast execution rejects a backward transition', () => {
  const execution = advancePosterFastExecution(createPosterFastExecution({
    dispatchId: 'dispatch-3', authorizationId: 'authorization-3', removeBackground: true, startedAt,
  }), 'canvas_mapping', '2026-08-22T08:00:20.000Z');
  assert.throws(() => advancePosterFastExecution(execution, 'rmbg', '2026-08-22T08:00:21.000Z'), /backward/i);
});

test('postprocess failure is recoverable without another ImageGen call', () => {
  const running = advancePosterFastExecution(createPosterFastExecution({
    dispatchId: 'dispatch-4', authorizationId: 'authorization-4', removeBackground: true, startedAt,
  }), 'rmbg', '2026-08-22T08:00:10.000Z');
  const failed = failPosterFastExecution(running, 'rmbg', '2026-08-22T08:00:12.000Z');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure_stage, 'rmbg');
  assert.equal(failed.recoverability, 'postprocess_only');
  assert.equal(failed.raw_candidate_available, true);
});

test('ImageGen failure requires explicit regeneration', () => {
  const failed = failPosterFastExecution(createPosterFastExecution({
    dispatchId: 'dispatch-5', authorizationId: 'authorization-5', removeBackground: true, startedAt,
  }), 'imagegen', '2026-08-22T08:00:12.000Z');
  assert.equal(failed.recoverability, 'regenerate_required');
  assert.equal(failed.raw_candidate_available, false);
});

test('postprocess recovery resumes at RMBG without resetting ImageGen', () => {
  let execution = createPosterFastExecution({
    dispatchId: 'dispatch-1', authorizationId: 'auth-1', removeBackground: true,
    startedAt: '2026-08-22T00:00:00.000Z',
  });
  execution = failPosterFastExecution(advancePosterFastExecution(execution, 'rmbg', '2026-08-22T00:00:10.000Z'), 'rmbg', '2026-08-22T00:00:20.000Z');
  execution = { ...execution, raw_candidate_available: true, raw_candidate_path: '/job/evidence/raw.png' };
  const resumed = resumePosterFastPostprocess(execution, '2026-08-22T00:01:00.000Z');
  assert.equal(resumed.current_stage, 'rmbg');
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.stages.imagegen.status, 'completed');
  assert.equal(resumed.stages.rmbg.status, 'running');
  assert.equal(resumed.stages.canvas_mapping.status, 'pending');
  assert.equal(resumed.raw_candidate_path, '/job/evidence/raw.png');
});
