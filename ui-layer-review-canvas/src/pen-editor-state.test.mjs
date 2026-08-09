import assert from 'node:assert/strict';
import test from 'node:test';
import { appendAnchor, closePenPath, createPenPath } from './pen-path.js';
import { createPenEditorState, focusPenOverlayOwner, reducePenEditor } from './pen-editor-state.js';

function addClick(state, x, y, kind = 'foreground') {
  const down = reducePenEditor(state, { type: 'pointer-down', point: { x, y }, kind });
  return reducePenEditor(down, { type: 'pointer-up', point: { x, y } });
}

function closedFixture() {
  let path = createPenPath({ id: 'closed', kind: 'boundary', point: { x: .1, y: .1 } });
  path = appendAnchor(path, { x: .9, y: .1 });
  path = appendAnchor(path, { x: .9, y: .9 });
  return closePenPath(path);
}

test('clicks append anchors and clicking the first anchor closes the draft', () => {
  let state = createPenEditorState();
  state = reducePenEditor(state, { type: 'pointer-down', point: { x: .1, y: .1 }, kind: 'foreground' });
  state = reducePenEditor(state, { type: 'pointer-up', point: { x: .1, y: .1 } });
  state = addClick(state, .9, .1);
  state = addClick(state, .9, .9);
  state = reducePenEditor(state, { type: 'close-draft' });

  assert.equal(state.paths.length, 1);
  assert.equal(state.paths[0].closed, true);
  assert.equal(state.draft, null);
});

test('escape discards only the open draft and undo restores the previous closed path state', () => {
  const drafted = addClick(createPenEditorState([closedFixture()]), .2, .2);
  const cancelled = reducePenEditor(drafted, { type: 'cancel-draft' });
  assert.equal(cancelled.paths.length, 1);
  const deleted = reducePenEditor(cancelled, { type: 'delete-path', pathId: closedFixture().id });
  assert.equal(deleted.paths.length, 0);
  assert.equal(reducePenEditor(deleted, { type: 'undo' }).paths.length, 1);
});

test('cancelling a multi-anchor draft cannot restore its unfinished anchors through undo', () => {
  let state = addClick(createPenEditorState([closedFixture()]), .2, .2);
  state = addClick(state, .3, .2);
  const cancelled = reducePenEditor(state, { type: 'cancel-draft' });

  assert.equal(reducePenEditor(cancelled, { type: 'undo' }).draft, null);
});

test('dragging a newly-created anchor creates linked symmetric handles', () => {
  let state = createPenEditorState();
  state = reducePenEditor(state, { type: 'pointer-down', point: { x: .5, y: .5 }, kind: 'foreground' });
  state = reducePenEditor(state, { type: 'pointer-move', point: { x: .7, y: .4 } });
  state = reducePenEditor(state, { type: 'pointer-up', point: { x: .7, y: .4 } });

  assert.deepEqual(state.draft.anchors[0].out, { x: .7, y: .4 });
  assert.deepEqual(state.draft.anchors[0].in, { x: .3, y: .6 });
});

test('deleting a selected anchor removes its path once fewer than three anchors remain', () => {
  const state = createPenEditorState([closedFixture()]);
  const selected = reducePenEditor(state, { type: 'select-anchor', pathId: 'closed', anchorIndex: 1 });
  const deleted = reducePenEditor(selected, { type: 'delete-selection' });

  assert.equal(deleted.paths.length, 0);
  assert.deepEqual(deleted.selection, null);
});

test('history keeps the most recent fifty complete snapshots', () => {
  let state = createPenEditorState([closedFixture()]);
  for (let index = 0; index < 55; index += 1) {
    state = reducePenEditor(state, {
      type: 'move-anchor', pathId: 'closed', anchorIndex: 0, point: { x: index / 100, y: .1 },
    });
  }

  assert.equal(state.history.length, 50);
  assert.equal(reducePenEditor(state, { type: 'undo' }).paths[0].anchors[0].x, .53);
});

test('allocates the next deterministic pen id after imported pen ids', () => {
  const existing = createPenPath({ id: 'pen-2', kind: 'boundary', point: { x: .1, y: .1 } });
  const state = reducePenEditor(createPenEditorState([existing]), {
    type: 'pointer-down', point: { x: .2, y: .2 }, kind: 'foreground',
  });

  assert.equal(state.draft.id, 'pen-3');
  assert.notEqual(state.draft.id, existing.id);
});

test('focuses the owning SVG before a child path control interaction', () => {
  let focusCalls = 0;
  const overlay = { focus: () => { focusCalls += 1; } };
  const anchor = { ownerSVGElement: overlay };

  assert.equal(focusPenOverlayOwner(anchor), overlay);
  assert.equal(focusCalls, 1);
});
