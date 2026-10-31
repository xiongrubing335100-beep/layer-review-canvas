import assert from 'node:assert/strict';
import test from 'node:test';
import { posterPlanReviewUiState, selectPosterMode } from './poster-ui-controller.js';
import { createPosterPlan, validatePosterPlan } from './poster-plan.js';

test('picker controller reports the selected mode and does not fire while disabled', () => {
  const changes = [];
  assert.equal(selectPosterMode({ choice: 'poster', disabled: false, onChange: (value) => changes.push(value) }), true);
  assert.deepEqual(changes, ['poster']);
  assert.equal(selectPosterMode({ choice: 'ui', disabled: true, onChange: (value) => changes.push(value) }), false);
  assert.deepEqual(changes, ['poster']);
});

test('review controller disables confirmation and exposes validation errors', () => {
  assert.deepEqual(posterPlanReviewUiState({ status: 'PLAN_REVIEW' }, { valid: false, errors: [{ message: '来源证据不能为空' }] }), {
    canConfirm: false,
    errors: ['来源证据不能为空'],
  });
  assert.equal(posterPlanReviewUiState({ status: 'PLAN_REVIEW' }, { valid: true, errors: [] }).canConfirm, true);
});

test('review controller blocks an empty poster plan with its schema error', () => {
  const plan = createPosterPlan({ status: 'PLAN_REVIEW', layers: [] });
  const ui = posterPlanReviewUiState(plan, validatePosterPlan(plan));
  assert.equal(ui.canConfirm, false);
  assert.ok(ui.errors.some((message) => message.includes('layers must contain at least one item')));
});
