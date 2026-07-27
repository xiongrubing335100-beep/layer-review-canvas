import assert from 'node:assert/strict';
import test from 'node:test';
import { median, reductionPercent, summarizeDurations } from './performance-metrics.js';

test('median handles odd and even samples', () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
});

test('reductionPercent compares current against baseline', () => {
  assert.equal(reductionPercent(100, 55), 45);
});

test('summarizeDurations groups successful samples by route', () => {
  assert.deepEqual(summarizeDurations([
    { route: 'direct_crop', seconds: 12, status: 'completed' },
    { route: 'direct_crop', seconds: 8, status: 'completed' },
    { route: 'alpha_extract', seconds: 40, status: 'failed' },
  ]), {
    direct_crop: { completed: 2, failed: 0, medianSeconds: 10 },
    alpha_extract: { completed: 0, failed: 1, medianSeconds: null },
  });
});
