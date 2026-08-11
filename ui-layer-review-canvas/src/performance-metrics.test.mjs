import assert from 'node:assert/strict';
import test from 'node:test';
import { median, percentile, reductionPercent, summarizeDurations } from './performance-metrics.js';

test('median handles odd and even samples', () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
});

test('percentile uses deterministic linear interpolation', () => {
  assert.equal(percentile([30, 10, 20], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 90), 37);
  assert.equal(percentile([], 90), null);
  assert.throws(() => percentile([10], 101), /between 0 and 100/);
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
    direct_crop: {
      completed: 2,
      failed: 0,
      medianSeconds: 10,
      p50Seconds: 10,
      p90Seconds: 11.6,
      medianPostprocessSeconds: null,
      maxPostprocessSeconds: null,
    },
    alpha_extract: {
      completed: 0,
      failed: 1,
      medianSeconds: null,
      p50Seconds: null,
      p90Seconds: null,
      medianPostprocessSeconds: null,
      maxPostprocessSeconds: null,
    },
  });
});

test('summarizeDurations reports postprocess statistics', () => {
  assert.deepEqual(summarizeDurations([
    { route: 'targeted_repair', seconds: 100, postprocessSeconds: 12, status: 'completed' },
    { route: 'targeted_repair', seconds: 140, postprocessSeconds: 18, status: 'completed' },
    { route: 'targeted_repair', seconds: 200, postprocessSeconds: 40, status: 'failed' },
  ]).targeted_repair, {
    completed: 2,
    failed: 1,
    medianSeconds: 120,
    p50Seconds: 120,
    p90Seconds: 136,
    medianPostprocessSeconds: 15,
    maxPostprocessSeconds: 18,
  });
});
