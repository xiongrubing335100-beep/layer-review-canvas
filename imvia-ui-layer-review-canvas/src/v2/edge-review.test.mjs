import test from 'node:test';
import assert from 'node:assert/strict';
import { addLayer, applyLayerEdit, createDocument, freezeLayer, validateDocument } from './document.js';
import * as review from './candidate-review.js';
import { freezeExport } from './export-store.js';

function fixture() {
  const document = addLayer(createDocument({ documentId: 'edge-doc', workbenchSessionId: 'edge-session', mode: 'poster',
    source: { path: '/source.png', width: 100, height: 80, fingerprint: 'source', revision: 1 } }), {
    layerId: 'text', name: '标题', displayCategory: '主标题', processingCategory: 'text',
    bounds: { x: 10, y: 20, width: 80, height: 40 },
  });
  const candidate = { versionId: 'edge-version', execution: 'suggested', documentId: document.documentId,
    layerId: 'text', layerRevision: 1, snapshotId: freezeLayer(document, 'text').snapshotId,
    sourceFingerprint: 'source', width: 80, height: 40, placement: { x: 10, y: 20 },
    artifactValid: true, pngPath: '/candidate.png', sha256: 'a'.repeat(64), alpha: { min: 0, max: 255 },
    review: { checks: { png: true } }, createdAt: '2026-01-01T00:00:00Z',
    pixelAudit: { maskProvider: 'imagegen_matte', sourceGeometryAlignment: { policyVersion: 7,
      method: 'source_guided_matte', evidenceMethod: 'bounded_shape', status: 'needs_review',
      contourIntegrity: { status: 'passed', changedByAlphaRecoveryPixels: 0, lostCounterPixels: 0 },
      boundaryMatchRatio: .96, boundaryPixels: 1000, longestUnsupportedRun: 22,
      reviewReasons: ['SOURCE_BOUNDARY_UNCERTAIN'],
      uncertainRegions: [{ x: 3, y: 4, width: 4, height: 20, boundaryPixels: 22 }] } } };
  return { document, candidate };
}

test('localized uncertainty is an internal failure, not a user approval request', () => {
  const { document, candidate } = fixture();
  const check = review.geometryReview(document.layers.text, candidate);
  assert.equal(check.status, 'quality_failed');
  assert.equal(review.sourceGeometryMatches(document.layers.text, candidate), false);
  assert.doesNotMatch(check.detail, /请人工复核|确认后/);
  assert.doesNotMatch(check.detail, /偏移 22|修正后采用/);
  assert.equal(review.candidateState(document, 'text', [candidate]).status, 'quality_failed');
  assert.deepEqual(review.getCompositionLayers(document, [candidate]), []);
});

test('legacy human acknowledgements are readable but cannot release uncertain results', () => {
  const { document, candidate } = fixture();
  const adopted = structuredClone(document);
  adopted.layers.text.acceptedVersionId = candidate.versionId;
  assert.deepEqual(review.getCompositionLayers(adopted, [candidate]), [], 'accepted id is not an acknowledgement');
  adopted.layers.text.acceptedQualityReview = { versionId: candidate.versionId, sha256: candidate.sha256,
    snapshotId: candidate.snapshotId, policyVersion: 5, kind: 'uncertain_edges', reviewedAt: new Date().toISOString() };
  assert.doesNotThrow(() => validateDocument(adopted));
  assert.equal(review.getCompositionLayers(adopted, [candidate]).length, 0);
  assert.throws(() => freezeExport({ document: adopted, versions: [candidate] }), /GEOMETRY_UNVERIFIED/);
  assert.equal(review.sourceGeometryMatches(adopted.layers.text, candidate), false, 'human review must not rewrite the machine audit');
  for (const patch of [{ sha256: 'b'.repeat(64) }, { versionId: 'new' }, { snapshotId: 'new' },
    { artifactValid: false }, { placement: { x: 11, y: 20 } }]) {
    assert.deepEqual(review.getCompositionLayers(adopted, [{ ...candidate, ...patch }]), []);
  }
  const moved = applyLayerEdit(adopted, 'text', { bounds: { ...adopted.layers.text.bounds, x: 11 } });
  assert.deepEqual(review.getCompositionLayers(moved, [candidate]), []);
});

test('automatic delivery cannot waive missing parts, damaged counters, old processing, weak global evidence or unlocated doubts', () => {
  const { document, candidate } = fixture();
  const alignment = candidate.pixelAudit.sourceGeometryAlignment;
  for (const patch of [{ policyVersion: 4 }, { boundaryMatchRatio: .89 }, { status: 'failed' },
    { reviewReasons: ['POSSIBLE_MISSING_COMPONENTS'] }, { reviewReasons: ['ALPHA_CONTOUR_CHANGED'] },
    { reviewReasons: ['SOURCE_BOUNDARY_UNCERTAIN', 'UNKNOWN'] }, { uncertainRegions: [] },
    { contourIntegrity: { ...alignment.contourIntegrity, lostCounterPixels: 1 } }]) {
    const bad = { ...candidate, pixelAudit: { ...candidate.pixelAudit, sourceGeometryAlignment: { ...alignment, ...patch } } };
    assert.notEqual(review.geometryReview(document.layers.text, bad).status, 'manual_review');
    assert.deepEqual(review.candidateState(document, 'text', [bad]).versionIds, []);
  }
});
