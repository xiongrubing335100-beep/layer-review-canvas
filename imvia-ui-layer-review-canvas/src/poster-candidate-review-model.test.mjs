import assert from 'node:assert/strict';
import test from 'node:test';

import { posterCandidateReviewModel } from './poster-candidate-review-model.js';

test('review-ready rendering exposes accept and retry controls', () => {
  const model = posterCandidateReviewModel({ status: 'NEEDS_USER_REVIEW', canAccept: true, canRetry: true });
  assert.deepEqual(model.actions.map((action) => action.id), ['accept', 'retry']);
});

test('review-ready accept callback is invoked only by the explicit accept control', () => {
  const calls = [];
  const model = posterCandidateReviewModel({
    status: 'NEEDS_USER_REVIEW', canAccept: true, canRetry: true,
    onAccept: () => calls.push('accept'), onRetry: () => calls.push('retry'),
  });
  model.actions.find((action) => action.id === 'accept').onInvoke();
  assert.deepEqual(calls, ['accept']);
});

test('hard-rejected rendering has no accept and exposes only regenerate', () => {
  const model = posterCandidateReviewModel({ status: 'HARD_REJECTED', canAccept: true, canRetry: true });
  assert.deepEqual(model.actions.map((action) => action.id), ['retry']);
  assert.equal(model.actions[0].label, '重新生成此层');
});

test('retry-authorized rendering exposes a single generate control', () => {
  assert.deepEqual(posterCandidateReviewModel({ status: 'RETRY_AUTHORIZED', canGenerate: true }).actions.map((action) => action.id), ['generate']);
});

test('mismatched gate rendering disables acceptance and invokes only the requested callbacks', () => {
  const calls = [];
  const model = posterCandidateReviewModel({
    status: 'NEEDS_USER_REVIEW', canAccept: false, canRetry: true,
    onAccept: () => calls.push('accept'), onRetry: () => calls.push('retry'),
  });
  assert.deepEqual(model.actions.map((action) => [action.id, action.disabled]), [['retry', false]]);
  model.actions[0].onInvoke();
  assert.deepEqual(calls, ['retry']);
  assert.equal(model.preview.downloadable, false);
});
