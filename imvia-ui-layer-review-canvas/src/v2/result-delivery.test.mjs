import test from 'node:test';
import assert from 'node:assert/strict';
import { addLayer, applyLayerEdit, createDocument, freezeLayer } from './document.js';
import { candidateState, getCompositionLayers } from './candidate-review.js';
import { exportReadiness } from './result-status.js';
import { freezeExport } from './export-store.js';

function fixture() {
  const document = addLayer(createDocument({ documentId: 'delivery-doc', workbenchSessionId: 'session', mode: 'poster',
    source: { path: '/source.png', width: 100, height: 80, fingerprint: 'source', revision: 1 } }), {
    layerId: 'text', name: '标题', displayCategory: '主标题', processingCategory: 'text', bounds: { x: 10, y: 20, width: 80, height: 40 },
    strategy: { operation: 'extract', removeBackground: true, repairPaths: [], fidelityPolicy: 'strict_source' },
  });
  const candidate = { versionId: 'good', documentId: document.documentId, layerId: 'text', layerRevision: 1,
    snapshotId: freezeLayer(document, 'text').snapshotId, sourceFingerprint: 'source', execution: 'suggested',
    artifactValid: true, width: 80, height: 40, placement: { x: 10, y: 20 }, alpha: { min: 0, max: 255 },
    pngPath: '/good.png', sha256: 'a'.repeat(64), review: { checks: { png: true } }, createdAt: '2026-01-01T00:00:00Z',
    pixelAudit: { maskProvider: 'imagegen_matte', sourceGeometryAlignment: { policyVersion: 7,
      method: 'source_guided_matte', evidenceMethod: 'bounded_shape', status: 'passed', reviewReasons: [],
      contourIntegrity: { status: 'passed', changedByAlphaRecoveryPixels: 0, lostCounterPixels: 0 },
      boundaryMatchRatio: .98, boundaryPixels: 1000, longestUnsupportedRun: 6 } } };
  return { document, candidate };
}

test('a verified result is composed and PSD-ready without adoption or a document write', () => {
  const { document, candidate } = fixture(); const before = structuredClone(document);
  const state = candidateState(document, 'text', [candidate]);
  assert.equal(state.status, 'ready');
  assert.equal(state.resultVersionId, 'good');
  const layers = getCompositionLayers(document, [candidate]);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].versionId, 'good');
  assert.equal(exportReadiness(document, { documentId: document.documentId, documentRevision: document.revision, layers }).ready, true);
  assert.equal(freezeExport({ document, versions: [candidate] }).layers[0].versionId, 'good');
  assert.deepEqual(document, before, 'reading results must not race with unsaved edits or change selections');
});

test('automatic delivery chooses the newest verified result, not the newest failed attempt', () => {
  const { document, candidate } = fixture();
  const newer = { ...candidate, versionId: 'new-good', sha256: 'b'.repeat(64), createdAt: '2026-01-02T00:00:00Z' };
  const failed = { ...candidate, versionId: 'bad', createdAt: '2026-01-03T00:00:00Z', pixelAudit: {
    ...candidate.pixelAudit, sourceGeometryAlignment: { ...candidate.pixelAudit.sourceGeometryAlignment, status: 'needs_review',
      reviewReasons: ['SOURCE_BOUNDARY_UNCERTAIN'], longestUnsupportedRun: 22,
      uncertainRegions: [{ x: 3, y: 4, width: 4, height: 20, boundaryPixels: 22 }] } } };
  assert.equal(getCompositionLayers(document, [failed, candidate, newer])[0].versionId, 'new-good');
  const explicitlySelected = structuredClone(document);
  explicitlySelected.layers.text.acceptedVersionId = 'good';
  assert.equal(getCompositionLayers(explicitlySelected, [newer, failed, candidate])[0].versionId, 'good');
  explicitlySelected.layers.text.acceptedVersionId = failed.versionId;
  explicitlySelected.layers.text.acceptedQualityReview = { kind: 'uncertain_edges', versionId: 'bad', sha256: failed.sha256,
    snapshotId: failed.snapshotId, policyVersion: 5, reviewedAt: '2026-01-03T00:00:00Z' };
  assert.deepEqual(getCompositionLayers(explicitlySelected, [failed]), [], 'old manual acknowledgements must not bypass quality');
  assert.equal(candidateState(document, 'text', [failed]).status, 'quality_failed');
  assert.throws(() => freezeExport({ document: explicitlySelected, versions: [failed] }));
});

test('source, selection, file and task checks still invalidate automatic results', () => {
  const { document, candidate } = fixture();
  for (const patch of [{ sourceFingerprint: 'other' }, { snapshotId: 'other' }, { layerRevision: 2 },
    { artifactValid: false }, { alpha: { min: 0, max: 0 } }, { execution: 'running' },
    { placement: { x: 11, y: 20 } }, { review: { checks: { png: false } } }]) {
    assert.deepEqual(getCompositionLayers(document, [{ ...candidate, ...patch }]), []);
  }
  const moved = applyLayerEdit(document, 'text', { bounds: { x: 11, y: 20, width: 80, height: 40 } });
  assert.deepEqual(getCompositionLayers(moved, [candidate]), []);
});

test('automatic delivery never promotes an opaque background-removal diagnostic from another provider', () => {
  const { document, candidate } = fixture();
  const opaque = { ...candidate, alpha: { min: 255, max: 255, status: 'needs_review' },
    pixelAudit: { maskProvider: 'bria', status: 'needs_review' } };
  assert.deepEqual(getCompositionLayers(document, [opaque]), []);
  assert.equal(candidateState(document, 'text', [opaque]).status, 'quality_failed');
});

test('an active retry is processing rather than an old failure, without hiding an already delivered result', () => {
  const { document, candidate } = fixture();
  const failed = { ...candidate, pixelAudit: { maskProvider: 'bria', status: 'needs_review' } };
  const attempts = [{ layerId: 'text', layerRevision: 1, sourceFingerprint: 'source', execution: 'running' }];
  assert.equal(candidateState(document, 'text', [failed], attempts).status, 'processing');
  assert.equal(candidateState(document, 'text', [candidate], attempts).status, 'ready');
});
