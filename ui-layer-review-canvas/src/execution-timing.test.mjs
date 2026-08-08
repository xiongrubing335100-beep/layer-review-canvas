import assert from 'node:assert/strict';
import test from 'node:test';
import * as executionTiming from './execution-timing.js';

const { deriveDurations, markTiming, mergeTiming } = executionTiming;

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

test('deriveDurations computes stage durations and excludes confirmation dwell from machine time', () => {
  assert.deepEqual(deriveDurations({
    submitted_at: '2026-07-27T00:00:00.000Z',
    confirmation_presented_at: '2026-07-27T00:00:02.000Z',
    confirmation_accepted_at: '2026-07-27T00:00:12.000Z',
    codex_turn_started_at: '2026-07-27T00:00:15.000Z',
    preflight_started_at: '2026-07-27T00:00:16.000Z',
    preflight_completed_at: '2026-07-27T00:00:18.000Z',
    imagegen_requested_at: '2026-07-27T00:00:20.000Z',
    imagegen_completed_at: '2026-07-27T00:00:50.000Z',
    postprocess_started_at: '2026-07-27T00:00:51.000Z',
    rmbg_started_at: '2026-07-27T00:00:54.000Z',
    rmbg_completed_at: '2026-07-27T00:00:57.000Z',
    validation_started_at: '2026-07-27T00:00:58.000Z',
    completed_at: '2026-07-27T00:01:00.000Z',
  }), {
    user_confirmation_dwell_ms: 10000,
    dispatch_ms: 3000,
    preflight_ms: 2000,
    imagegen_ms: 30000,
    postprocess_ms: 3000,
    rmbg_ms: 3000,
    validation_ms: 2000,
    total_machine_ms: 48000,
    total_user_visible_ms: 60000,
    invalid_intervals: [],
  });
});

test('deriveDurations leaves missing intervals null', () => {
  const durations = deriveDurations({
    submitted_at: '2026-07-27T00:00:00.000Z',
    confirmation_accepted_at: '2026-07-27T00:00:10.000Z',
    completed_at: '2026-07-27T00:00:20.000Z',
  });

  assert.equal(durations.user_confirmation_dwell_ms, null);
  assert.equal(durations.dispatch_ms, null);
  assert.equal(durations.total_machine_ms, 10000);
  assert.equal(durations.total_user_visible_ms, 20000);
  assert.deepEqual(durations.invalid_intervals, []);
});

test('deriveDurations rejects invalid and reverse-ordered intervals without negative values', () => {
  const durations = deriveDurations({
    confirmation_accepted_at: '2026-07-27T00:00:20.000Z',
    codex_turn_started_at: '2026-07-27T00:00:10.000Z',
    completed_at: 'not-a-timestamp',
  });

  assert.equal(durations.dispatch_ms, null);
  assert.equal(durations.total_machine_ms, null);
  assert.equal(durations.total_user_visible_ms, null);
  assert.deepEqual(durations.invalid_intervals, ['confirmation_accepted_at->codex_turn_started_at']);
  assert.equal(Object.values(durations).some((value) => typeof value === 'number' && value < 0), false);
});
