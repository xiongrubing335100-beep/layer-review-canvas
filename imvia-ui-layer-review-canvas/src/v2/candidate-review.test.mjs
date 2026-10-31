import test from 'node:test';
import assert from 'node:assert/strict';
import { addLayer, applyLayerEdit, createDocument, freezeLayer } from './document.js';
import { candidateState, getCompositionLayers } from './candidate-review.js';
import { freezeExport } from './export-store.js';

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

test('a matching result is delivered without changing the explicit selection', () => {
  const document = fixture(); const candidate = version(document);
  assert.deepEqual(candidateState(document, 'layer-review', [candidate], []), {
    status: 'ready', reason: null, versionIds: ['version-a'], resultVersionId: 'version-a',
  });
  assert.equal(getCompositionLayers(document, [candidate])[0].versionId, 'version-a');
  assert.equal(document.layers['layer-review'].acceptedVersionId, null);
});

test('native repair cannot bypass source alignment or full silhouette review', () => {
  const document = fixture();
  const candidate = version(document, { pixelAudit: { status: 'candidate', maskProvider: 'native_rgba' },
    review: { checks: { png: true }, visualReview: { status: 'passed' }, rawSha256: 'a'.repeat(64),
      finalPreview: { rgbaSha256: 'b'.repeat(64) }, nativeRgbaChecks: {
        contentFidelity: true, fullSilhouette: true, thinStructures: true,
        holesAndSolidMaterial: true, placement: true, protectedRegions: true } } });
  assert.deepEqual(getCompositionLayers(document, [candidate]), []);
  candidate.pixelAudit.nativeAlignment = { status: 'passed' };
  assert.equal(getCompositionLayers(document, [candidate]).length, 1);
  candidate.review.nativeRgbaChecks.fullSilhouette = false;
  assert.deepEqual(getCompositionLayers(document, [candidate]), []);
  assert.equal(candidateState(document, 'layer-review', [candidate], []).status, 'quality_failed');
});

for (const status of ['rejected', 'needs_review', 'unknown']) {
  test(`semantic ${status} cannot be overridden by passing file checks or an accepted version`, () => {
    const document = fixture();
    const candidate = version(document, { review: { checks: { png: true, dimensions: true },
      visualReview: { status, code: 'SEMANTIC_MATTE_MISMATCH' } } });
    document.layers['layer-review'].acceptedVersionId = candidate.versionId;
    assert.equal(candidateState(document, 'layer-review', [candidate], []).status, 'quality_failed');
    assert.deepEqual(getCompositionLayers(document, [candidate]), []);
    assert.throws(() => freezeExport({ document, versions: [candidate] }), /EXPORT_CANDIDATE_GEOMETRY_UNVERIFIED/);
  });
}

test('generated text mattes require the calibrated audit, not a legacy contrast-only score', () => {
  const document = fixture();
  const unverified = version(document, { pixelAudit: { status: 'candidate', maskProvider: 'imagegen_matte' } });
  assert.equal(candidateState(document, 'layer-review', [unverified], []).status, 'validation_pending');
  const verified = version(document, { pixelAudit: { status: 'candidate', maskProvider: 'imagegen_matte',
    sourceGeometryAlignment: { policyVersion: 6, method: 'source_guided_matte', evidenceMethod: 'bounded_shape',
      contourIntegrity: { status: 'passed', changedByAlphaRecoveryPixels: 0, lostCounterPixels: 0 },
      status: 'passed', reviewReasons: [], boundaryMatchRatio: 0.96, boundaryPixels: 100, longestUnsupportedRun: 2 } } });
  assert.equal(candidateState(document, 'layer-review', [verified], []).status, 'ready');
});

test('new results need completed semantic topology as well as source geometry', () => {
  const document = fixture();
  const candidate = version(document, { semanticRequirements: { version: 1 }, review: { checks: { png: true }, visualReview: { status: 'passed' } } });
  assert.deepEqual(getCompositionLayers(document, [candidate]), []);
  assert.equal(candidateState(document, 'layer-review', [candidate], []).status, 'quality_failed');
  candidate.pixelAudit.semanticTopology = { version: 1, status: 'passed' };
  assert.equal(getCompositionLayers(document, [candidate]).length, 1);
});

test('legacy source-alignment proposal can use a verified final contour but is not a new semantic approval', () => {
  const document = fixture();
  const candidate = version(document, { artifactValid: true, review: { checks: { png: true }, visualReview: { status: 'proposal_requires_source_alignment' } },
    pixelAudit: { maskProvider: 'imagegen_matte', sourceGeometryAlignment: { policyVersion: 7, method: 'source_guided_matte',
      evidenceMethod: 'bounded_shape', status: 'passed', reviewReasons: [], boundaryMatchRatio: .99, boundaryPixels: 100,
      longestUnsupportedRun: 2, contourIntegrity: { status: 'passed', changedByAlphaRecoveryPixels: 0, lostCounterPixels: 0 } } } });
  assert.equal(candidateState(document, 'layer-review', [candidate], []).status, 'ready');
  assert.equal(freezeExport({ document, versions: [candidate] }).layers.length, 1);
  candidate.semanticRequirements = { version: 1 };
  assert.equal(getCompositionLayers(document, [candidate]).length, 0);
  delete candidate.semanticRequirements;
  delete candidate.pixelAudit;
  assert.equal(getCompositionLayers(document, [candidate]).length, 0, 'pending alignment is never sufficient by itself');
});

test('a legacy v3 contrast score cannot certify contour integrity for adoption or PSD', () => {
  const document = fixture();
  const candidate = version(document, { pixelAudit: { maskProvider: 'imagegen_matte',
    sourceGeometryAlignment: { policyVersion: 3, method: 'source_guided_matte', evidenceMethod: 'bounded_trimap',
      status: 'passed', reviewReasons: [], boundaryMatchRatio: 1, boundaryPixels: 100, longestUnsupportedRun: 0 } } });
  assert.equal(candidateState(document, 'layer-review', [candidate], []).status, 'validation_pending');
  const adopted = { ...document, layers: { ...document.layers,
    'layer-review': { ...document.layers['layer-review'], acceptedVersionId: candidate.versionId } } };
  assert.deepEqual(getCompositionLayers(adopted, [candidate]), []);
});

test('UI matte geometry must be verified before adoption and export, including old adopted versions', () => {
  let document = fixture();
  document = { ...document, layers: { ...document.layers, 'layer-review': { ...document.layers['layer-review'], processingCategory: 'brand_ui' } } };
  const unverified = version(document, { pixelAudit: { maskProvider: 'imagegen_matte' } });
  assert.equal(candidateState(document, 'layer-review', [unverified], []).versionIds.length, 0);
  const adopted = { ...document, layers: { ...document.layers, 'layer-review': { ...document.layers['layer-review'], acceptedVersionId: unverified.versionId } } };
  assert.deepEqual(getCompositionLayers(adopted, [unverified]), []);
  const audit = { policyVersion: 6, method: 'source_guided_matte', evidenceMethod: 'source_color_projection',
    contourIntegrity: { status: 'passed', changedByAlphaRecoveryPixels: 0, lostCounterPixels: 0 },
    status: 'passed', reviewReasons: [], boundaryMatchRatio: 0.98, boundaryPixels: 300, longestUnsupportedRun: 0 };
  const verified = version(document, { pixelAudit: { maskProvider: 'imagegen_matte', sourceGeometryAlignment: audit } });
  assert.equal(candidateState(document, 'layer-review', [verified], []).status, 'ready');
  for (const change of [{ policyVersion: 2 }, { policyVersion: 3 }, { policyVersion: 4 }, { policyVersion: 5 }, { contourIntegrity: undefined },
    { contourIntegrity: { ...audit.contourIntegrity, changedByAlphaRecoveryPixels: 1 } },
    { contourIntegrity: { ...audit.contourIntegrity, lostCounterPixels: 1 } },
    { boundaryMatchRatio: 0.8, minimumRatio: 0.1 },
    { longestUnsupportedRun: 20 }, { boundaryPixels: 0 }, { status: 'failed' },
    { reviewReasons: ['POSSIBLE_MISSING_COMPONENTS'] }, { evidenceMethod: 'unknown' }]) {
    const bad = { ...verified, pixelAudit: { ...verified.pixelAudit, sourceGeometryAlignment: { ...audit, ...change } } };
    assert.deepEqual(getCompositionLayers(adopted, [bad]), []);
  }
});

for (const reason of ['POSSIBLE_MISSING_COMPONENTS', 'SOURCE_BOUNDARY_UNCERTAIN', 'ALPHA_CONTOUR_CHANGED']) {
test(`${reason} is inspectable but cannot be adopted or exported`, () => {
  const document = fixture();
  const candidate = version(document, { pixelAudit: { maskProvider: 'imagegen_matte', status: 'needs_review',
    sourceGeometryAlignment: { policyVersion: 7, method: 'source_guided_matte', evidenceMethod: 'source_color_projection',
      contourIntegrity: { status: 'passed', changedByAlphaRecoveryPixels: 0, lostCounterPixels: 0 },
      status: 'needs_review', reviewReasons: [reason],
      boundaryMatchRatio: 1, boundaryPixels: 100, longestUnsupportedRun: 0 } } });
  const state = candidateState(document, 'layer-review', [candidate], []);
  assert.equal(state.status, 'quality_failed');
  assert.deepEqual(state.versionIds, []);
  assert.deepEqual(state.diagnosticVersionIds, [candidate.versionId]);
  assert.deepEqual(getCompositionLayers({ ...document, layers: { ...document.layers,
    'layer-review': { ...document.layers['layer-review'], acceptedVersionId: candidate.versionId } } }, [candidate]), []);
});
}

test('a file is not reviewable until its bound attempt is suggested', () => {
  const document = fixture();
  assert.equal(candidateState(document, 'layer-review', [version(document, { execution: 'running' })], []).status, 'pending');
});

test('an invalid or missing PNG cannot be counted as adopted or exported', () => {
  const initial = fixture(); const candidate = version(initial, { artifactValid: false });
  const adopted = { ...initial, layers: { ...initial.layers, 'layer-review': { ...initial.layers['layer-review'], acceptedVersionId: candidate.versionId } } };
  assert.equal(candidateState(adopted, 'layer-review', [candidate], []).status, 'stale');
  assert.deepEqual(getCompositionLayers(adopted, [candidate]), []);
});

test('adoption is current only when source, snapshot revision, dimensions and alpha match', () => {
  let document = fixture(); const candidate = version(document);
  document = { ...document, layers: { ...document.layers, 'layer-review': { ...document.layers['layer-review'], acceptedVersionId: candidate.versionId } } };
  assert.equal(candidateState(document, 'layer-review', [candidate], []).status, 'ready');
  assert.equal(candidateState(document, 'layer-review', [version(document, { sourceFingerprint: 'old-source' })], []).status, 'stale');
  assert.equal(candidateState(document, 'layer-review', [version(document, { layerRevision: 9 })], []).status, 'stale');
  assert.equal(candidateState(document, 'layer-review', [version(document, { width: 79 })], []).status, 'stale');
  assert.equal(candidateState(document, 'layer-review', [version(document, { alpha: { max: 0 } })], []).status, 'stale');
});

test('renaming keeps an adopted raster current while editing pixels makes it stale', () => {
  const initial = fixture(); const candidate = version(initial);
  const adopted = { ...initial, layers: { ...initial.layers, 'layer-review': { ...initial.layers['layer-review'], acceptedVersionId: candidate.versionId } } };
  const renamed = applyLayerEdit(adopted, 'layer-review', { name: '新主标题' });
  assert.equal(candidateState(renamed, 'layer-review', [candidate], []).status, 'ready');
  const moved = applyLayerEdit(renamed, 'layer-review', { bounds: { ...renamed.layers['layer-review'].bounds, x: 25 } });
  assert.equal(candidateState(moved, 'layer-review', [candidate], []).status, 'stale');
});

test('an explicit valid version choice takes precedence over newer automatic results', () => {
  const original = fixture(); const adoptedVersion = version(original);
  const adopted = { ...original, layers: { ...original.layers, 'layer-review': { ...original.layers['layer-review'], acceptedVersionId: adoptedVersion.versionId } } };
  const newVersion = version(adopted, { versionId: 'version-b', createdAt: '2026-09-28T00:00:00Z' });
  assert.equal(candidateState(adopted, 'layer-review', [newVersion, adoptedVersion], []).status, 'ready');
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
