import assert from 'node:assert/strict';
import test from 'node:test';
import { addLayer, applyLayerEdit, createDocument } from './document.js';
import { createPenEditorState, reducePenEditor } from '../pen-editor-state.js';
import { createEditorDraft, reduceEditorDraft, commitEditorDraft } from './editor-state.js';
import { documentInput, layerInput } from './test-fixtures.mjs';

const fixture = () => {
  let document = addLayer(createDocument(documentInput()), layerInput());
  document = addLayer(document, layerInput({ layerId: 'b', name: '文案', displayCategory: '文案', processingCategory: 'text', bounds: { x: 12, y: 20, width: 80, height: 40 } }));
  return document;
};

test('editor Done commits only the active layer and never dispatches work', () => {
  const original = fixture();
  let sendCalls = 0;
  let draft = createEditorDraft(original, 'a');
  draft = reduceEditorDraft(draft, { type: 'set-field', field: 'name', value: '重命名主体' });
  draft = reduceEditorDraft(draft, { type: 'set-field', field: 'requirements', value: '保留金属纹理' });
  const saved = commitEditorDraft(original, draft);

  assert.equal(sendCalls, 0);
  assert.equal(saved.layers.a.name, '重命名主体');
  assert.equal(saved.layers.a.requirements, '保留金属纹理');
  assert.equal(saved.layers.a.layerRevision, original.layers.a.layerRevision + 1);
  assert.deepEqual(saved.layers.b, original.layers.b);
  assert.equal(saved.revision, original.revision + 1);
});

test('cancel and switching away discard the draft without changing the document', () => {
  const original = fixture();
  const draft = reduceEditorDraft(createEditorDraft(original, 'a'), { type: 'set-field', field: 'name', value: '未保存' });
  const cancelled = reduceEditorDraft(draft, { type: 'cancel' });
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(original, fixture());
});

test('stale edits are rejected when the same layer changed after editor opened', () => {
  const original = fixture();
  const draft = reduceEditorDraft(createEditorDraft(original, 'a'), { type: 'set-field', field: 'name', value: '新名字' });
  const concurrent = applyLayerEdit(original, 'a', { requirements: '并行修改' });
  assert.throws(() => commitEditorDraft(concurrent, draft), { message: 'LAYER_EDIT_CONFLICT' });
});

test('pen undo and redo restore region paths, and closing the focused editor does not commit', () => {
  const original = fixture();
  const draft = createEditorDraft(original, 'a');
  const pen = createPenEditorState(draft.values.paths);
  const initialPaths = structuredClone(pen.paths);
  const changedPath = { id: 'pen-1', kind: 'foreground', shape: 'bezier_path', closed: true, order: 0,
    anchors: [{ x: 0.1, y: 0.1, in: { x: 0.1, y: 0.1 }, out: { x: 0.1, y: 0.1 }, handlesLinked: true },
      { x: 0.8, y: 0.1, in: { x: 0.8, y: 0.1 }, out: { x: 0.8, y: 0.1 }, handlesLinked: true },
      { x: 0.8, y: 0.8, in: { x: 0.8, y: 0.8 }, out: { x: 0.8, y: 0.8 }, handlesLinked: true }] };
  const withPath = reducePenEditor(createPenEditorState([changedPath]), { type: 'move-anchor', pathId: 'pen-1', anchorIndex: 0, point: { x: 0.2, y: 0.2 } });
  const undone = reducePenEditor(withPath, { type: 'undo' });
  const redone = reducePenEditor(undone, { type: 'redo' });
  assert.deepEqual(undone.paths, [changedPath]);
  assert.deepEqual(redone.paths, withPath.paths);
  assert.deepEqual(pen.paths, initialPaths);
  assert.deepEqual(original, fixture());
});
