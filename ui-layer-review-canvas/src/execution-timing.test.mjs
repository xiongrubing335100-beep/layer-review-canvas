import assert from 'node:assert/strict';
import test from 'node:test';
import { markTiming, mergeTiming } from './execution-timing.js';

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
