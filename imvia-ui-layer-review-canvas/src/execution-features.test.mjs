import assert from 'node:assert/strict';
import test from 'node:test';
import { executionFeatureEnvironmentKey, isExecutionFeatureEnabled } from './execution-features.js';

test('execution features default to enabled and can be disabled per environment', () => {
  assert.equal(isExecutionFeatureEnabled('compact_plan_v1', {}), true);
  assert.equal(isExecutionFeatureEnabled('compact_plan_v1', { IMVIA_COMPACT_PLAN_V1: '0' }), false);
  assert.equal(executionFeatureEnvironmentKey('targeted_finalizer_v1'), 'IMVIA_TARGETED_FINALIZER_V1');
});

test('unknown execution features fail closed', () => {
  assert.throws(() => isExecutionFeatureEnabled('unknown', {}), /unknown execution feature/);
});
