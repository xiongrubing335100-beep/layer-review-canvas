import test from 'node:test';
import assert from 'node:assert/strict';
import { addLayer, applyLayerEdit, createDocument, freezeLayer } from './document.js';
import { candidateState, getCompositionLayers } from './candidate-review.js';

function fixture() {
  const document = addLayer(createDocument({ documentId: 'doc-review', workbenchSessionId: 'session-review', mode: 'poster',
    source: { path: '/source.png', width: 200, height: 160, fingerprint: 'source-v1', revision: 1 } }), {
    layerId: 'layer-review', name: '主标题', displayCategory: '主标题', processingCategory: 'text',
    bounds: { x: 24, y: 36, width: 80, height: 40 }, paths: [], requirements: '',
    strategy: { operation: 'extract', removeBackground: true, repairPaths: [] },
  });
  return document;
}

function version(document, overrides = {}) {
  const layer = document.layers['layer-review'];
  return { versionId: 'version-a', attemptId: 'attempt-a', execution: 'suggested', documentId: document.documentId, layerId: layer.layerId,
    layerRevision: layer.layerRevision, sourceFingerprint: document.source.fingerprint, snapshotId: freezeLayer(document, layer.layerId).snapshotId,
    width: layer.bounds.width, height: layer.bounds.height, placement: { x: layer.bounds.x, y: layer.bounds.y },
    pngPath: '/private/version-a.png', sha256: 'a'.repeat(64), alpha: { max: 255 },
    review: { checks: { png: true, authorization: true } }, pixelAudit: { status: 'NEEDS_USER_REVIEW' }, createdAt: '2026-09-27T00:00:00Z',
    ...overrides };
}

test('a matching candidate is reviewable but never implicitly adopted', () => {
  const document = fixture(); const candidate = version(document);
  assert.deepEqual(candidateState(document, 'layer-review', [candidate], []), {
    status: 'review', reason: 'CANDIDATE_REQUIRES_USER_ADOPTION', versionIds: ['version-a'],
  });
  assert.deepEqual(getCompositionLayers(document, [candidate]), []);
});

test('a file is not reviewable until its bound attempt is suggested', () => {
  const document = fixture();
  assert.equal(candidateState(document, 'layer-review', [version(document, { execution: 'running' })], []).status, 'pending');
});

test('adoption is current only when source, snapshot revision, dimensions and alpha match', () => {
  let document = fixture(); const candidate = version(document);
  document = { ...document, layers: { ...document.layers, 'layer-review': { ...document.layers['layer-review'], acceptedVersionId: candidate.versionId } } };
  assert.equal(candidateState(document, 'layer-review', [candidate], []).status, 'adopted');
  assert.equal(candidateState(document, 'layer-review', [version(document, { sourceFingerprint: 'old-source' })], []).status, 'stale');
  assert.equal(candidateState(document, 'layer-review', [version(document, { layerRevision: 9 })], []).status, 'stale');
  assert.equal(candidateState(document, 'layer-review', [version(document, { width: 79 })], []).status, 'stale');
  assert.equal(candidateState(document, 'layer-review', [version(document, { alpha: { max: 0 } })], []).status, 'stale');
});

test('renaming keeps an adopted raster current while editing pixels makes it stale', () => {
  const initial = fixture(); const candidate = version(initial);
  const adopted = { ...initial, layers: { ...initial.layers, 'layer-review': { ...initial.layers['layer-review'], acceptedVersionId: candidate.versionId } } };
  const renamed = applyLayerEdit(adopted, 'layer-review', { name: '新主标题' });
  assert.equal(candidateState(renamed, 'layer-review', [candidate], []).status, 'adopted');
  const moved = applyLayerEdit(renamed, 'layer-review', { bounds: { ...renamed.layers['layer-review'].bounds, x: 25 } });
  assert.equal(candidateState(moved, 'layer-review', [candidate], []).status, 'stale');
});

test('new versions do not replace the adopted id and composition includes only explicit current adoptions', () => {
  const original = fixture(); const adoptedVersion = version(original);
  const adopted = { ...original, layers: { ...original.layers, 'layer-review': { ...original.layers['layer-review'], acceptedVersionId: adoptedVersion.versionId } } };
  const newVersion = version(adopted, { versionId: 'version-b', createdAt: '2026-09-28T00:00:00Z' });
  assert.equal(candidateState(adopted, 'layer-review', [newVersion, adoptedVersion], []).status, 'adopted');
  assert.deepEqual(getCompositionLayers(adopted, [newVersion, adoptedVersion]).map(layer => [layer.layerId, layer.versionId, layer.placement]),
    [['layer-review', 'version-a', { x: 24, y: 36 }]]);
});

test('transparent or failed versions cannot become current; original source is not a composition layer', () => {
  const document = fixture();
  assert.equal(candidateState(document, 'layer-review', [version(document, { alpha: { max: 0 } })], []).status, 'pending');
  assert.equal(candidateState(document, 'layer-review', [], [{ layerId: 'layer-review', layerRevision: 1,
    sourceFingerprint: document.source.fingerprint, execution: 'failed' }]).status, 'failed');
  assert.deepEqual(getCompositionLayers(document, []), []);
});
