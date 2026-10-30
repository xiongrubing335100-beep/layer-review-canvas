import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, addLayer } from './document.js';
import { createEditorDraft, reduceEditorDraft } from './editor-state.js';
import { prepareSplitDocument } from './prepare-split.js';
const doc = () => addLayer(createDocument({ documentId: 'split-draft', workbenchSessionId: 'test', mode: 'poster',
  source: { path: '/source.png', width: 800, height: 1600, fingerprint: 'test', revision: 1 } }), {
  layerId: 'title', name: '主标题', displayCategory: '主标题', processingCategory: 'text',
  bounds: { x: 20, y: 30, width: 500, height: 300 }, paths: [], requirements: '保留标题',
});
test('board split persists the pending editor requirements before using the new revision', async () => {
  const document = doc();
  const draft = reduceEditorDraft(createEditorDraft(document, 'title'), { type: 'set-field', field: 'requirements', value: '保留标题与高光，去掉背景' });
  let saved = false;
  const next = await prepareSplitDocument(document, draft, async (candidate, revision) => {
    assert.equal(revision, document.revision);
    assert.equal(candidate.layers.title.requirements, draft.values.requirements);
    saved = true; return candidate;
  });
  assert.equal(saved, true);
  assert.equal(next.revision, document.revision + 1);
  assert.equal(document.layers.title.requirements, '保留标题');
});
test('unchanged or absent drafts need no writes, and save failure prevents submission', async () => {
  const document = doc();
  const unexpected = async () => assert.fail('unexpected write');
  assert.equal(await prepareSplitDocument(document, null, unexpected), document);
  assert.equal(await prepareSplitDocument(document, createEditorDraft(document, 'title'), unexpected), document);
  const draft = reduceEditorDraft(createEditorDraft(document, 'title'), { type: 'set-field', field: 'requirements', value: '新要求' });
  await assert.rejects(prepareSplitDocument(document, draft, async () => { throw new Error('保存失败'); }), /保存失败/);
  await assert.rejects(prepareSplitDocument(document, draft, async () => document), /修订号不匹配/);
  const invalid = reduceEditorDraft(draft, { type: 'set-category', value: '__custom__' });
  await assert.rejects(prepareSplitDocument(document, invalid, unexpected), /CUSTOM_CATEGORY_NAME_REQUIRED/);
});
