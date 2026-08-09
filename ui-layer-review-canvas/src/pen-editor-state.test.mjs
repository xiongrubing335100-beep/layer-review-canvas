import assert from 'node:assert/strict';
import test from 'node:test';
import { appendAnchor, closePenPath, createPenPath } from './pen-path.js';
import * as penEditorState from './pen-editor-state.js';

const {
  createPenEditorState,
  focusPenOverlayOwner,
  penEditorActionForKeyboard,
  reducePenEditor,
} = penEditorState;

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

function fourAnchorFixture() {
  let path = createPenPath({ id: 'four', kind: 'boundary', point: { x: .1, y: .1 } });
  path = appendAnchor(path, { x: .9, y: .1 });
  path = appendAnchor(path, { x: .9, y: .9 });
  path = appendAnchor(path, { x: .1, y: .9 });
  return closePenPath(path);
}

function emittedOutput(state, feedbackToken) {
  return {
    paths: state.paths,
    draft: state.draft,
    selection: state.selection,
    history: state.history,
    feedbackToken,
  };
}

function feedbackToken(sequence) {
  return { origin: 'test-overlay', sequence };
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

test('undo and redo traverse complete snapshots and a new edit clears future history', () => {
  const original = fourAnchorFixture();
  const initial = createPenEditorState([original]);
  const moved = reducePenEditor(initial, {
    type: 'move-anchor', pathId: original.id, anchorIndex: 0, point: { x: .25, y: .2 },
  });
  const undone = reducePenEditor(moved, { type: 'undo' });
  const redone = reducePenEditor(undone, { type: 'redo' });

  assert.deepEqual(undone.paths, initial.paths);
  assert.deepEqual(redone.paths, moved.paths);
  assert.equal(redone.future.length, 0);

  const branched = reducePenEditor(undone, {
    type: 'move-anchor', pathId: original.id, anchorIndex: 0, point: { x: .4, y: .35 },
  });
  assert.equal(branched.future.length, 0);
  assert.equal(reducePenEditor(branched, { type: 'redo' }), branched);
});

test('keyboard shortcuts map platform undo and redo commands without capturing plain keys', () => {
  assert.deepEqual(penEditorActionForKeyboard({ key: 'z', metaKey: true }), { type: 'undo' });
  assert.deepEqual(penEditorActionForKeyboard({ key: 'Z', ctrlKey: true, shiftKey: true }), { type: 'redo' });
  assert.deepEqual(penEditorActionForKeyboard({ key: 'y', ctrlKey: true }), { type: 'redo' });
  assert.equal(penEditorActionForKeyboard({ key: 'z' }), null);
});

test('anchor mode geometry changes are undoable and redoable', () => {
  const original = fourAnchorFixture();
  const toggled = reducePenEditor(createPenEditorState([original]), {
    type: 'toggle-anchor-mode', pathId: original.id, anchorIndex: 0,
  });
  const undone = reducePenEditor(toggled, { type: 'undo' });
  const redone = reducePenEditor(undone, { type: 'redo' });

  assert.deepEqual(undone.paths[0].anchors[0], original.anchors[0]);
  assert.deepEqual(redone.paths[0].anchors[0], toggled.paths[0].anchors[0]);
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

test('stale self-emitted props during a drag do not reset undo history', () => {
  assert.equal(typeof penEditorState.syncPenEditorStateFromProps, 'function');
  const original = fourAnchorFixture();
  const initial = reducePenEditor(createPenEditorState([original]), {
    type: 'select-anchor', pathId: original.id, anchorIndex: 0,
  });
  const firstMove = reducePenEditor(initial, {
    type: 'move-anchor', pathId: original.id, anchorIndex: 0, point: { x: .2, y: .2 },
  });
  const latestMove = reducePenEditor(firstMove, {
    type: 'move-anchor', pathId: original.id, anchorIndex: 0, point: { x: .3, y: .3 }, transient: true,
  });
  const firstOutput = emittedOutput(firstMove, feedbackToken(1));
  const latestOutput = emittedOutput(latestMove, feedbackToken(2));

  const staleSync = penEditorState.syncPenEditorStateFromProps({
    current: latestMove,
    pendingEmissions: [firstOutput, latestOutput],
    ...firstOutput,
  });
  assert.equal(staleSync.state, latestMove);
  assert.deepEqual(staleSync.pendingEmissions, [latestOutput]);

  const latestSync = penEditorState.syncPenEditorStateFromProps({
    current: staleSync.state,
    pendingEmissions: staleSync.pendingEmissions,
    ...latestOutput,
  });
  const undone = reducePenEditor(latestSync.state, { type: 'undo' });

  assert.equal(latestSync.state, latestMove);
  assert.deepEqual(latestSync.pendingEmissions, []);
  assert.deepEqual(undone.paths[0].anchors[0], original.anchors[0]);
});

test('out-of-order self-emitted props are both ignored without losing undo history', () => {
  const original = fourAnchorFixture();
  const initial = reducePenEditor(createPenEditorState([original]), {
    type: 'select-anchor', pathId: original.id, anchorIndex: 0,
  });
  const firstMove = reducePenEditor(initial, {
    type: 'move-anchor', pathId: original.id, anchorIndex: 0, point: { x: .2, y: .2 },
  });
  const latestMove = reducePenEditor(firstMove, {
    type: 'move-anchor', pathId: original.id, anchorIndex: 0, point: { x: .3, y: .3 }, transient: true,
  });
  const firstOutput = emittedOutput(firstMove, feedbackToken(1));
  const latestOutput = emittedOutput(latestMove, feedbackToken(2));

  const latestSync = penEditorState.syncPenEditorStateFromProps({
    current: latestMove,
    pendingEmissions: [firstOutput, latestOutput],
    ...latestOutput,
  });
  assert.equal(latestSync.state, latestMove);
  assert.deepEqual(latestSync.pendingEmissions, [firstOutput]);

  const staleSync = penEditorState.syncPenEditorStateFromProps({
    current: latestSync.state,
    pendingEmissions: latestSync.pendingEmissions,
    ...firstOutput,
  });
  const undone = reducePenEditor(staleSync.state, { type: 'undo' });

  assert.equal(staleSync.state, latestMove);
  assert.deepEqual(staleSync.pendingEmissions, []);
  assert.deepEqual(undone.paths[0].anchors[0], original.anchors[0]);
});

test('a controlled rollback with cleared feedback token applies even with emitted prop references', () => {
  const original = fourAnchorFixture();
  const initial = createPenEditorState([original]);
  const firstMove = reducePenEditor(initial, {
    type: 'move-anchor', pathId: original.id, anchorIndex: 0, point: { x: .2, y: .2 },
  });
  const latestMove = reducePenEditor(firstMove, {
    type: 'move-anchor', pathId: original.id, anchorIndex: 0, point: { x: .3, y: .3 }, transient: true,
  });
  const firstOutput = emittedOutput(firstMove, feedbackToken(1));
  const latestOutput = emittedOutput(latestMove, feedbackToken(2));

  const rollbackSync = penEditorState.syncPenEditorStateFromProps({
    current: latestMove,
    pendingEmissions: [firstOutput, latestOutput],
    paths: firstOutput.paths,
    draft: firstOutput.draft,
    selection: firstOutput.selection,
    feedbackToken: null,
  });

  assert.notEqual(rollbackSync.state, latestMove);
  assert.equal(rollbackSync.state.paths, firstOutput.paths);
  assert.deepEqual(rollbackSync.state.history, []);
  assert.deepEqual(rollbackSync.pendingEmissions, []);
});

test('pending self-emissions are disabled without onChange and bounded without parent feedback', () => {
  assert.equal(typeof penEditorState.queuePenEditorEmission, 'function');
  const outputs = Array.from({ length: 75 }, (_, index) => ({
    paths: [{ id: `path-${index}` }],
    draft: null,
    selection: null,
    history: [],
  }));

  const disabledQueue = penEditorState.queuePenEditorEmission([], outputs[0], { enabled: false });
  const boundedQueue = outputs.reduce(
    (pending, output) => penEditorState.queuePenEditorEmission(pending, output, { enabled: true }),
    [],
  );

  assert.deepEqual(disabledQueue, []);
  assert.equal(boundedQueue.length, 50);
  assert.equal(boundedQueue[0], outputs[25]);
  assert.equal(boundedQueue.at(-1), outputs[74]);
});
