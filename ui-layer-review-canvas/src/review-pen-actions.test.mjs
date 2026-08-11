import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canInvokePenOverlayCommand,
  canDeleteReviewMark,
  invokePenOverlayCommand,
  reduceReviewPenParentState,
} from './review-pen-actions.js';

function parentFixture() {
  const pen = { id: 'pen-1', layer_id: 'layer-a', shape: 'bezier_path' };
  const legacy = { id: 'legacy-1', layer_id: 'layer-a', shape: 'stroke' };
  const other = { id: 'other-1', layer_id: 'layer-b', shape: 'bezier_path' };
  return {
    layerId: 'layer-a',
    marks: [pen, legacy, other],
    paths: [pen],
    draft: { id: 'draft-1', anchors: [{ x: .1, y: .1 }] },
    selection: { pathId: 'pen-1' },
    feedbackToken: { origin: 'overlay', sequence: 4 },
    selectedMarkId: 'pen-1',
  };
}

test('hidden annotation clear removes every selected-layer mark and all parent pen state', () => {
  const next = reduceReviewPenParentState(parentFixture(), { type: 'clear' });

  assert.deepEqual(next.marks.map((mark) => mark.id), ['other-1']);
  assert.deepEqual(next.paths, []);
  assert.equal(next.draft, null);
  assert.equal(next.selection, null);
  assert.equal(next.feedbackToken, null);
  assert.equal(next.selectedMarkId, null);
});

test('hidden annotation tool switch cancels only the parent draft', () => {
  const state = parentFixture();
  const next = reduceReviewPenParentState(state, { type: 'cancel-draft' });

  assert.equal(next.marks, state.marks);
  assert.equal(next.paths, state.paths);
  assert.equal(next.draft, null);
  assert.equal(next.selection, state.selection);
  assert.equal(next.feedbackToken, null);
});

test('legacy selection fallback deletes only the selected old mark', () => {
  const state = { ...parentFixture(), selection: null, selectedMarkId: 'legacy-1' };
  const next = reduceReviewPenParentState(state, { type: 'delete-selection' });

  assert.deepEqual(next.marks.map((mark) => mark.id), ['pen-1', 'other-1']);
  assert.equal(next.paths, state.paths);
  assert.equal(next.selectedMarkId, null);
  assert.equal(canDeleteReviewMark(state), true);
});

test('hidden annotation fallback deletes a selected bezier path from parent state', () => {
  const state = parentFixture();
  const next = reduceReviewPenParentState(state, { type: 'delete-selection' });

  assert.deepEqual(next.marks.map((mark) => mark.id), ['legacy-1', 'other-1']);
  assert.deepEqual(next.paths, []);
  assert.equal(next.selection, null);
  assert.equal(next.feedbackToken, null);
  assert.equal(next.selectedMarkId, null);
});

test('an enabled visible undo dispatches to the live overlay command', () => {
  let undoCalls = 0;
  const overlay = { undo: () => { undoCalls += 1; } };

  assert.equal(invokePenOverlayCommand(overlay, 'undo'), true);
  assert.equal(undoCalls, 1);
  assert.equal(invokePenOverlayCommand(null, 'undo'), false);
});

test('history buttons disable immediately when the overlay is intentionally unmounted', () => {
  const staleOverlayRef = { canUndo: true, canRedo: true };

  assert.equal(canInvokePenOverlayCommand(staleOverlayRef, 'undo', { mounted: true }), true);
  assert.equal(canInvokePenOverlayCommand(staleOverlayRef, 'undo', { mounted: false }), false);
  assert.equal(canInvokePenOverlayCommand(staleOverlayRef, 'redo', { mounted: false }), false);
});
