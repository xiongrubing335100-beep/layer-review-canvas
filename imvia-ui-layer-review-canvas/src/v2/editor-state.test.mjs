import assert from 'node:assert/strict';
import test from 'node:test';
import { addLayer, applyLayerEdit, createDocument } from './document.js';
import { createPenEditorState, reducePenEditor } from '../pen-editor-state.js';
import { createEditorDraft, reduceEditorDraft, commitEditorDraft, resumeEditorDraft, hasDraftChanges } from './editor-state.js';
import { documentInput, layerInput } from './test-fixtures.mjs';

const fixture = () => {
  let document = addLayer(createDocument(documentInput()), layerInput());
  document = addLayer(document, layerInput({ layerId: 'b', name: '文案', displayCategory: '文案', processingCategory: 'text', bounds: { x: 12, y: 20, width: 80, height: 40 } }));
  return document;
};

test('interior reconstruction shortcuts are not restricted to automatic boundary-only repair', () => {
  const definition = layerInput();
  delete definition.strategy;
  const document = addLayer(createDocument(documentInput()), definition);
  for (const id of ['remove-text', 'repair-occlusion']) {
    const draft = reduceEditorDraft(createEditorDraft(document, 'a'), { type: 'apply-quick-prompt', id });
    assert.equal(draft.values.strategy.operation, 'reconstruct');
    assert.equal(draft.values.strategy.fidelityPolicy, undefined);
    assert.equal(document.layers.a.strategy.fidelityPolicy, 'source_faithful_repair');
  }
});

test('choosing repair enables source-faithful native rendering without migrating the original layer', () => {
  const original = fixture();
  let draft = createEditorDraft(original, 'a');
  draft = reduceEditorDraft(draft, { type: 'set-strategy', field: 'operation', value: 'reconstruct' });
  const saved = commitEditorDraft(original, draft);
  assert.equal(saved.layers.a.strategy.fidelityPolicy, 'source_faithful_repair');
  assert.equal(original.layers.a.strategy.fidelityPolicy, undefined);
  draft = reduceEditorDraft(createEditorDraft(saved, 'a'), { type: 'set-strategy', field: 'operation', value: 'extract' });
  assert.equal(draft.values.strategy.fidelityPolicy, 'strict_source');
});

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

test('explicit cancel discards the draft without changing the document', () => {
  const original = fixture();
  const draft = reduceEditorDraft(createEditorDraft(original, 'a'), { type: 'set-field', field: 'name', value: '未保存' });
  const cancelled = reduceEditorDraft(draft, { type: 'cancel' });
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(original, fixture());
});

test('reopening a layer retains unsaved fields and region requirements, but never reuses another document draft', () => {
  const document = fixture();
  const draft = reduceEditorDraft(createEditorDraft(document, 'a'), { type: 'set-field', field: 'requirements', value: '保留选区的文字和光效' });
  assert.equal(hasDraftChanges(document, createEditorDraft(document, 'a')), false);
  assert.equal(hasDraftChanges(document, draft), true);
  assert.equal(resumeEditorDraft(document, 'a', draft), draft);
  const other = { ...document, documentId: 'other-document' };
  assert.equal(resumeEditorDraft(other, 'a', draft).documentId, 'other-document');
  assert.notEqual(resumeEditorDraft(other, 'a', draft).values.requirements, draft.values.requirements);
  const changed = applyLayerEdit(document, 'a', { name: '外部修改', requirements: '外部要求' });
  assert.throws(() => resumeEditorDraft(changed, 'a', draft), /LAYER_EDIT_CONFLICT/);
  assert.equal(resumeEditorDraft(changed, 'a', createEditorDraft(document, 'a')).values.name, '外部修改');
});

test('an unfinished pen path is retained when leaving, and cannot be silently saved as a finished region', () => {
  const document = fixture();
  const session = { paths: [], draft: { kind: 'foreground', anchors: [{ x: .2, y: .2 }] }, history: [], future: [] };
  const draft = reduceEditorDraft(createEditorDraft(document, 'a'), { type: 'set-pen-state', target: 'paths', session, paths: [] });
  assert.deepEqual(draft.penSessions?.paths?.draft, session.draft);
  assert.equal(hasDraftChanges(document, draft), true);
  assert.throws(() => commitEditorDraft(document, draft), /请先闭合/);
});

test('custom categories commit a trimmed name and reopen with their processing route', () => {
  const original = fixture();
  let draft = reduceEditorDraft(createEditorDraft(original, 'a'), { type: 'set-category', value: '__custom__' });
  assert.equal(draft.customCategory, true);
  assert.equal(draft.values.displayCategory, '');
  assert.throws(() => commitEditorDraft(original, draft), /CUSTOM_CATEGORY_NAME_REQUIRED/);
  draft = reduceEditorDraft(draft, { type: 'set-field', field: 'displayCategory', value: '  活动徽章  ' });
  assert.deepEqual(reduceEditorDraft(draft, { type: 'set-category', value: '__custom__' }), draft, 'reselecting custom must not erase the typed name');
  draft = reduceEditorDraft(draft, { type: 'set-processing-category', value: 'brand_ui' });
  const saved = commitEditorDraft(original, draft);
  assert.equal(saved.layers.a.displayCategory, '活动徽章');
  assert.equal(saved.layers.a.processingCategory, 'brand_ui');
  assert.equal(saved.layers.a.strategy.removeBackground, true);
  assert.deepEqual(saved.layers.b, original.layers.b);
  assert.equal(createEditorDraft(saved, 'a').customCategory, true);
  assert.equal(createEditorDraft(saved, 'a').values.displayCategory, '活动徽章');
});

test('custom processing changes preserve authored requirements and restore transparency defaults', () => {
  let draft = reduceEditorDraft(createEditorDraft(fixture(), 'a'), { type: 'set-category', value: '__custom__' });
  draft = reduceEditorDraft(draft, { type: 'set-field', field: 'requirements', value: '保留原有金属纹理' });
  draft = reduceEditorDraft(draft, { type: 'set-processing-category', value: 'background' });
  assert.equal(draft.values.strategy.removeBackground, false);
  draft = reduceEditorDraft(draft, { type: 'set-processing-category', value: 'effect' });
  assert.equal(draft.values.strategy.removeBackground, true);
  assert.equal(draft.values.requirements, '保留原有金属纹理');
  assert.deepEqual(reduceEditorDraft(draft, { type: 'set-processing-category', value: 'unknown' }), draft);
  draft = reduceEditorDraft(draft, { type: 'set-category', value: 'UI 组件' });
  assert.equal(draft.customCategory, false);
  assert.equal(draft.values.displayCategory, 'UI 组件');
  assert.equal(draft.values.processingCategory, 'brand_ui');
});

test('resizing an editor draft commits source bounds without transforming paths or other layers', () => {
  const original = fixture();
  const bounds = { x: 140, y: 1540, width: 1100, height: 1300 };
  const draft = reduceEditorDraft(createEditorDraft(original, 'a'), { type: 'set-field', field: 'bounds', value: bounds });
  const saved = commitEditorDraft(original, draft);
  assert.deepEqual(saved.layers.a.bounds, bounds);
  assert.deepEqual(saved.layers.a.paths, original.layers.a.paths);
  assert.deepEqual(saved.layers.a.strategy.repairPaths, original.layers.a.strategy.repairPaths);
  assert.deepEqual(saved.layers.b, original.layers.b);
  assert.equal(saved.layers.a.layerRevision, original.layers.a.layerRevision + 1);
  assert.notDeepEqual(original.layers.a.bounds, bounds);
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
