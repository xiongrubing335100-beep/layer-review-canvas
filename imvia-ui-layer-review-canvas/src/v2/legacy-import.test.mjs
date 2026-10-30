import test from 'node:test';
import assert from 'node:assert/strict';
import { importLegacyDocument } from './legacy-import.js';

const legacyFixture = () => ({
  imageId: 'old-image', sourceName: 'poster.png', sourceSize: { width: 1000, height: 2000 },
  sourceFingerprint: 'poster.png:1234:1700000000000:1700', documentMode: 'poster', sourceRevision: 3,
  nodes: [
    { id: 'title-old', name: 'KV 标题 1', category: 'kvTitle', status: 'accepted', bounds: { x: 10, y: 20, width: 30, height: 10 } },
    { id: 'logo-old', name: '品牌组件', category: 'uiComponent', status: 'needs-repair', bounds: { x: 50, y: 60, width: 20, height: 15 }, removeBackground: true },
  ],
  results: [{ id: 'old-candidate', nodeId: 'title-old', status: 'complete', bounds: { x: 20, y: 20, width: 30, height: 10 } }],
});

const verifiedAssets = ({ legacyFingerprint = 'poster.png:1234:1700000000000:1700', width = 1000, height = 2000 } = {}) => ({
  workbenchSessionId: 'new-session',
  source: { path: '/managed/doc/source.png', width, height, fingerprint: 'a'.repeat(64), revision: 1, legacyFingerprint },
});

test('legacy import copies only verified source and definitions into a fresh, unadopted V2 document', () => {
  const legacyDocument = legacyFixture();
  const inputBefore = structuredClone(legacyDocument);
  const imported = importLegacyDocument({ legacyDocument, verifiedAssets: verifiedAssets(), newDocumentId: 'new-doc' });

  assert.equal(imported.document.documentId, 'new-doc');
  assert.equal(imported.document.mode, 'poster');
  assert.equal(imported.document.revision, 1);
  assert.deepEqual(imported.document.layerOrder, ['legacy-1', 'legacy-2']);
  assert.deepEqual(imported.document.layers['legacy-1'].bounds, { x: 100, y: 400, width: 300, height: 200 });
  assert.equal(imported.document.layers['legacy-1'].processingCategory, 'text');
  assert.equal(imported.document.layers['legacy-1'].acceptedVersionId, null);
  assert.equal(imported.document.layers['legacy-2'].processingCategory, 'brand_ui');
  assert.equal(imported.document.layers['legacy-2'].strategy.removeBackground, true);
  assert.deepEqual(legacyDocument, inputBefore);
  assert.equal(imported.history[0].status, 'untrusted_pending_review');
  assert.equal(imported.history[0].artifactPresent, true);
  assert.match(imported.warnings.join(' '), /旧版候选仅保留为历史记录/);
});

test('legacy UI mode maps explicitly to H5 and recentered artifacts stay out of the new candidate list', () => {
  const legacyDocument = { ...legacyFixture(), documentMode: 'ui', nodes: [
    { id: 'text-old', name: '普通文字', category: 'ordinaryText', status: 'accepted', bounds: { x: 5, y: 10, width: 20, height: 5 } },
  ] };
  const imported = importLegacyDocument({ legacyDocument, verifiedAssets: verifiedAssets(), newDocumentId: 'new-h5' });
  assert.equal(imported.document.mode, 'h5');
  assert.equal(imported.history[0].reviewEligible, false);
  assert.equal(imported.history[0].status, 'legacy_accepted_marker');
  assert.equal(imported.document.layers['legacy-1'].acceptedVersionId, null);
});

test('a legacy candidate with shifted original placement is recorded as untrusted and is not review eligible', () => {
  const legacyDocument = legacyFixture();
  const source = verifiedAssets().source;
  const imported = importLegacyDocument({ legacyDocument, newDocumentId: 'new-doc', verifiedAssets: {
    ...verifiedAssets(), candidates: { 'old-candidate': { verified: true, sourceFingerprint: legacyDocument.sourceFingerprint,
      sourceWidth: source.width, sourceHeight: source.height, sha256: 'b'.repeat(64), width: 300, height: 200,
      placement: { x: 200, y: 400 } } },
  } });
  assert.equal(imported.history.find(item => item.legacyCandidateId === 'old-candidate').reviewEligible, false);
  assert.equal(imported.document.layers['legacy-1'].acceptedVersionId, null);
});

test('legacy import rejects source identity or dimensions that do not match the explicitly selected image', () => {
  assert.throws(() => importLegacyDocument({ legacyDocument: legacyFixture(), verifiedAssets: verifiedAssets({ legacyFingerprint: 'other-source' }), newDocumentId: 'new-doc' }), /LEGACY_SOURCE_IDENTITY_MISMATCH/);
  assert.throws(() => importLegacyDocument({ legacyDocument: legacyFixture(), verifiedAssets: verifiedAssets({ width: 999 }), newDocumentId: 'new-doc' }), /LEGACY_SOURCE_DIMENSIONS_MISMATCH/);
});
