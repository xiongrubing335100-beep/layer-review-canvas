import test from 'node:test';
import assert from 'node:assert/strict';
import { exportReadiness, workflowProgress, transparencyStatus } from './result-status.js';

test('an inconsistent result snapshot is checked again, not sent to human adoption or another split', () => {
  const document = { documentId: 'doc', revision: 4, layerOrder: ['new', 'ready', 'done', 'stale'], layers: {
    new: {}, ready: {}, done: { acceptedVersionId: 'accepted' }, stale: { acceptedVersionId: 'old' },
  } };
  const composition = { documentId: 'doc', documentRevision: 4, layers: [{ layerId: 'done', versionId: 'accepted' }],
    states: { new: { status: 'pending', versionIds: [] }, ready: { status: 'review', versionIds: ['candidate'] },
      done: { status: 'adopted', versionIds: ['accepted'] }, stale: { status: 'stale', versionIds: [] } } };
  const progress = workflowProgress(document, composition);
  assert.deepEqual(progress.splitIds, ['new', 'stale']);
  assert.deepEqual(progress.reviewIds, []);
  assert.equal(progress.checking, true);
  assert.equal(progress.adopted, 1);
  assert.equal(progress.ready, false);
  assert.equal(workflowProgress(document, { ...composition, documentRevision: 3 }).checking, true);
  assert.deepEqual(workflowProgress(document, null).reviewIds, []);
});

test('processing and unread states cannot be mistaken for a fresh split or a reviewable result', () => {
  const document = { documentId: 'doc', revision: 1, layerOrder: ['a'], layers: { a: {} } };
  const composition = { documentId: 'doc', documentRevision: 1, layers: [], states: { a: { status: 'processing', versionIds: [] } } };
  const progress = workflowProgress(document, composition);
  assert.deepEqual(progress.processingIds, ['a']);
  assert.deepEqual(progress.splitIds, []);
  assert.deepEqual(progress.reviewIds, []);
  assert.equal(workflowProgress(document, { ...composition, states: {} }).checking, true);
  composition.states.a = { status: 'failed', versionIds: [] };
  assert.deepEqual(workflowProgress(document, composition).splitIds, ['a']);
  composition.states.a = { status: 'stale', versionIds: ['replacement'] };
  assert.deepEqual(workflowProgress(document, composition).reviewIds, []);
  assert.equal(workflowProgress(document, composition).checking, true);
});

test('PSD requires current delivered artifacts for every active layer, not merely a document with layers', () => {
  const document = { documentId: 'doc', revision: 4, layerOrder: ['a', 'b'], layers: {
    a: { name: '标题', acceptedVersionId: 'va' }, b: { name: 'UI', acceptedVersionId: null },
  } };
  const composition = { documentId: 'doc', documentRevision: 4, layers: [{ layerId: 'a', versionId: 'va' }] };
  assert.equal(exportReadiness(document, composition).ready, false);
  assert.equal(exportReadiness(document, composition).adopted, 1);
  assert.deepEqual(exportReadiness(document, composition).missing, ['b']);
  document.layers.b.acceptedVersionId = 'vb';
  composition.layers.push({ layerId: 'b', versionId: 'vb' });
  assert.equal(exportReadiness(document, composition).ready, true);
  assert.equal(exportReadiness(document, { ...composition, documentRevision: 3 }).ready, false);
  assert.equal(exportReadiness(document, { ...composition, documentId: 'other' }).ready, false);
  assert.equal(exportReadiness({ ...document, layerOrder: [] }, composition).ready, false);
});

test('opaque and empty PNGs are not described as transparent cutouts', () => {
  assert.equal(transparencyStatus({ min: 255, max: 255 }), '无透明像素');
  assert.equal(transparencyStatus({ min: 0, max: 255 }), '含透明像素');
  assert.equal(transparencyStatus({ min: 0, max: 0 }), '完全透明，无可见内容');
  assert.equal(transparencyStatus(null), '未检测');
});

test('validation recovery and diagnostic results are never sent into another generation by the main action', () => {
  const document = { documentId: 'doc', revision: 1, layerOrder: ['old', 'error', 'edge'], layers: { old: {}, error: {}, edge: {} } };
  const progress = workflowProgress(document, { documentId: 'doc', documentRevision: 1, layers: [], states: {
    old: { status: 'validation_pending', versionIds: [] }, error: { status: 'validation_failed', versionIds: [] },
    edge: { status: 'quality_failed', versionIds: [], diagnosticVersionIds: ['diagnostic'] },
  } });
  assert.deepEqual(progress.splitIds, []);
  assert.deepEqual(progress.validationIds, ['old']);
  assert.deepEqual(progress.attentionIds, ['error', 'edge']);
  assert.equal(progress.ready, false);
});
