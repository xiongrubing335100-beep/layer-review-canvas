import assert from 'node:assert/strict';
import test from 'node:test';
import * as executionTiming from './execution-timing.js';

const { markTiming, mergeTiming } = executionTiming;

test('markTiming preserves existing stages', () => {
  const timing = markTiming({ submitted_at: '2026-07-27T00:00:00.000Z' }, 'codex_turn_started_at', '2026-07-27T00:00:01.000Z');
  assert.equal(timing.submitted_at, '2026-07-27T00:00:00.000Z');
  assert.equal(timing.codex_turn_started_at, '2026-07-27T00:00:01.000Z');
});

test('executor timing wins only for fields it reports', () => {
  assert.deepEqual(mergeTiming(
    { submitted_at: 'a', codex_turn_started_at: 'b' },
    { intent_normalized_at: 'c' },
  ), {
    submitted_at: 'a',
    codex_turn_started_at: 'b',
    intent_normalized_at: 'c',
  });
});

test('executor timing wins when both sources contain the same stage', () => {
  assert.deepEqual(mergeTiming(
    { submitted_at: 'job-submitted', completed_at: 'job-completed' },
    { completed_at: 'report-completed' },
  ), {
    submitted_at: 'job-submitted',
    completed_at: 'report-completed',
  });
});

test('terminal completion uses the executor report timestamp first', () => {
  assert.equal(executionTiming.completionTimestamp?.({
    status: 'failed',
    timing: { completed_at: 'report-completed' },
    planCompletedAt: 'plan-completed',
    turnCompletedAt: 'turn-completed',
    imageCompletedAt: 'image-completed',
    fallbackCompletedAt: 'fallback-completed',
  }), 'report-completed');
});
