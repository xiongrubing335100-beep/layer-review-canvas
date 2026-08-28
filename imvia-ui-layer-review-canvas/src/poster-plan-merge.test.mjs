import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePosterMerge } from './poster-plan-merge.js';

const title = { asset_role: 'headline', ui_independence: 'not_applicable' };
const date = { asset_role: 'date', ui_independence: 'independent' };

test('rejects headline and independent UI merges in either order', () => {
  assert.equal(validatePosterMerge(title, date).valid, false);
  assert.equal(validatePosterMerge(date, title).code, 'UI_BUNDLING_ERROR');
});

test('allows a headline to merge with a non-independent decoration', () => {
  assert.deepEqual(validatePosterMerge(title, { asset_role: 'decoration', ui_independence: 'attached' }), { valid: true });
});
