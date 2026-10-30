import test from 'node:test';
import assert from 'node:assert/strict';
import { addLayer, applyLayerEdit, createDocument, categoryPresets, freezeLayer } from './document.js';
import { createEditorDraft, reduceEditorDraft, commitEditorDraft } from './editor-state.js';
import { documentInput, layerInput } from './test-fixtures.mjs';

const categoryContent = {
  text: /字体.*字形/, subject: /完整轮廓.*材质/, brand_ui: /Logo.*按钮/,
  decoration_prop: /装饰.*道具/, effect: /透明度.*发光边缘/, background: /背景纹理.*渐变/,
};
const freshDocument = (mode, displayCategory, processingCategory) => addLayer(createDocument(documentInput({ mode })),
  layerInput({ displayCategory, processingCategory, requirements: undefined }));

test('new regions have category defaults in saved definitions and frozen execution snapshots', () => {
  for (const mode of ['poster', 'h5']) for (const [displayCategory, processingCategory] of categoryPresets) {
    const document = freshDocument(mode, displayCategory, processingCategory);
    assert.match(document.layers.a.requirements, categoryContent[processingCategory], displayCategory);
    assert.equal(freezeLayer(document, 'a').requirements, document.layers.a.requirements);
  }
  assert.match(freshDocument('poster', '产品特写', 'subject').layers.a.requirements, categoryContent.subject);
});

test('new foreground regions default to transparent extraction while backgrounds stay opaque', () => {
  const definitionWithoutStrategy = (displayCategory, processingCategory, layerId) => {
    const { strategy: ignored, ...definition } = layerInput({ layerId, displayCategory, processingCategory });
    return definition;
  };
  let document = createDocument(documentInput());
  for (const [index, [displayCategory, processingCategory]] of categoryPresets.entries()) {
    const layerId = `category-${index}`;
    document = addLayer(document, definitionWithoutStrategy(displayCategory, processingCategory, layerId));
    assert.deepEqual(document.layers[layerId].strategy,
      { operation: processingCategory === 'background' ? 'reconstruct' : 'extract', removeBackground: processingCategory !== 'background', repairPaths: [],
        ...(processingCategory !== 'background' ? {fidelityPolicy:'source_faithful_repair',localRepairPolicy:'scoped_once_v1'} : {}) }, displayCategory);
  }
  document = addLayer(document, definitionWithoutStrategy('产品特写', 'subject', 'custom-foreground'));
  assert.equal(document.layers['custom-foreground'].strategy.removeBackground, true);
});

test('changing a module category reapplies the transparent-foreground default', () => {
  const { strategy: ignored, ...backgroundDefinition } = layerInput({ displayCategory: '背景', processingCategory: 'background', requirements: undefined });
  const document = addLayer(createDocument(documentInput()), backgroundDefinition);
  let draft = createEditorDraft(document, 'a');
  assert.equal(draft.values.strategy.removeBackground, false);
  assert.equal(draft.values.strategy.operation, 'reconstruct');
  draft = reduceEditorDraft(draft, { type: 'set-category', value: '主标题' });
  assert.equal(draft.values.strategy.removeBackground, true);
  assert.equal(draft.values.strategy.operation, 'extract');
  assert.equal(draft.values.strategy.fidelityPolicy, 'source_faithful_repair');
  draft = reduceEditorDraft(draft, { type: 'set-category', value: '背景' });
  assert.equal(draft.values.strategy.removeBackground, false);
  assert.equal(draft.values.strategy.operation, 'reconstruct');
  assert.equal(draft.values.strategy.fidelityPolicy, undefined);
});

test('an explicit background crop is preserved rather than silently replaced by generation', () => {
  const document = freshDocument('poster', '背景', 'background');
  assert.equal(document.layers.a.strategy.operation, 'extract');
  assert.equal(createEditorDraft(document, 'a').values.strategy.operation, 'extract');
});

test('repair shortcuts persist executable intent, not just text, and repeated clicks do not duplicate instructions', () => {
  for (const id of ['remove-text', 'repair-occlusion']) {
    const document = freshDocument('h5', 'UI 组件', 'brand_ui');
    const draft = reduceEditorDraft(createEditorDraft(document, 'a'), { type: 'apply-quick-prompt', id });
    assert.equal(draft.values.strategy.operation, 'reconstruct');
    assert.equal(draft.values.strategy.removeBackground, document.layers.a.strategy.removeBackground);
    assert.notEqual(draft.values.requirements, document.layers.a.requirements);
    assert.deepEqual(reduceEditorDraft(draft, { type: 'apply-quick-prompt', id }), draft);
    const frozen = freezeLayer(commitEditorDraft(document, draft), 'a');
    assert.equal(frozen.strategy.operation, 'reconstruct');
    assert.equal(document.layers.a.strategy.operation, 'extract', 'draft cannot mutate the saved layer');
  }
});

test('opening an existing blank region restores defaults in the draft, saving persists them and cancel leaves the source intact', () => {
  for (const [displayCategory, processingCategory] of categoryPresets) for (const requirements of ['', '  \n']) {
    const original = applyLayerEdit(freshDocument('poster', displayCategory, processingCategory), 'a', { requirements });
    const before = structuredClone(original);
    const draft = createEditorDraft(original, 'a');
    assert.match(draft.values.requirements, categoryContent[processingCategory]);
    assert.equal(reduceEditorDraft(draft, { type: 'cancel' }).status, 'cancelled');
    assert.deepEqual(original, before);
    const saved = commitEditorDraft(original, draft);
    assert.equal(saved.layers.a.requirements, draft.values.requirements);
    assert.equal(saved.layers.a.layerRevision, original.layers.a.layerRevision + 1);
  }
});

test('switching category replaces only an empty or unchanged default prompt and updates its processing route', () => {
  const original = freshDocument('poster', '角色', 'subject');
  let draft = createEditorDraft(original, 'a');
  draft = reduceEditorDraft(draft, { type: 'set-category', value: '背景' });
  assert.equal(draft.values.displayCategory, '背景');
  assert.equal(draft.values.processingCategory, 'background');
  assert.match(draft.values.requirements, categoryContent.background);
  draft = reduceEditorDraft(draft, { type: 'set-field', field: 'requirements', value: '' });
  draft = reduceEditorDraft(draft, { type: 'set-category', value: '文案' });
  assert.match(draft.values.requirements, categoryContent.text);
  const custom = '保留指定区域内的原有细节，不补画。';
  draft = reduceEditorDraft(draft, { type: 'set-field', field: 'requirements', value: custom });
  draft = reduceEditorDraft(draft, { type: 'set-category', value: '装饰' });
  assert.equal(draft.values.processingCategory, 'decoration_prop');
  assert.equal(draft.values.requirements, custom);
  const saved = commitEditorDraft(original, draft);
  assert.equal(createEditorDraft(saved, 'a').values.requirements, custom);
});
