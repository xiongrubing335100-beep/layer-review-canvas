import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { createWorkbenchV2Api } from './api.mjs';
import { addLayer, applyLayerEdit, freezeLayer } from './document.js';
import { prepareV2Item } from './execution-adapter.js';
import { currentProcessingPolicy } from './processing-policy.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function png(width, height, pixel) {
  const chunk = (type, bytes) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); let crc = 0xffffffff;
    for (const byte of Buffer.concat([name, bytes])) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, name, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t, realText = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-revalidation-')); t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureName = realText === 'gold-ui' ? 'gold-ui' : realText === 'reflective' ? 'reflective-text' : 'car-text';
  const source = realText ? await readFile(`scripts/fixtures/matte-contours/${fixtureName}-source.png`)
    : png(160, 100, (x, y) => { const c = x >= 30 && x < 130 && y >= 25 && y < 75 ? 220 : 40; return [c,c,c,255]; });
  const api = createWorkbenchV2Api({ root: path.join(root, 'documents') });
  const initial = await api.createDocument({ mode: 'poster', bytes: source, workbenchSessionId: 'session' });
  const document = await api.saveDocument(addLayer(initial, { layerId: 'layer', name: 'Title', displayCategory: '主标题', processingCategory: realText === 'gold-ui' ? 'brand_ui' : 'text',
    bounds: { x: 0, y: 0, width: initial.source.width, height: initial.source.height }, paths: [], requirements: '',
    strategy: { operation: 'extract', removeBackground: true, repairPaths: [] } }), initial.revision);
  const snapshot = freezeLayer(document, 'layer');
  const attempt = { attemptId: 'attempt', batchId: 'batch', documentId: document.documentId, layerId: 'layer', layerRevision: 1,
    dispatchId: 'dispatch', authorizationId: 'auth', snapshotId: snapshot.snapshotId, sourceFingerprint: document.source.fingerprint, execution: 'suggested' };
  const manifest = await prepareV2Item({ document, snapshot, attempt, outputRoot: root });
  const mapping = JSON.parse(await readFile(manifest.mappingPath));
  const r = mapping.contentRegion;
  const raw = realText ? await readFile(`scripts/fixtures/matte-contours/${fixtureName}-matte.png`) : png(1536, 1024, (x, y) => {
    const sx = (x - r.x + 0.5) * 160 / r.width, sy = (y - r.y + 0.5) * 100 / r.height;
    const c = sx >= 30 && sx < 130 && sy >= 25 && sy < 75 ? 255 : 0; return [c,c,c,255];
  });
  const directory = path.join(root, 'candidates', 'attempt'); await mkdir(directory, { recursive: true });
  const rawPath = path.join(root, 'attempts', 'attempt', 'raw.png'); await writeFile(rawPath, raw);
  const reportPath = path.join(root, 'attempts', 'attempt', 'review.json');
  const review = { attemptId: 'attempt', dispatchId: 'dispatch', authorizationId: 'auth', snapshotId: snapshot.snapshotId,
    sourceFingerprint: document.source.fingerprint, checks: { pngReadable: true, binding: true } };
  await writeFile(reportPath, JSON.stringify(review));
  const old = { ...attempt, versionId: 'old', rawPath, reviewReportPath: reportPath,
    pngPath: path.join(directory, 'old.png'), sha256: hash(source), width: document.source.width, height: document.source.height,
    alpha: { min: 0, max: 255 }, placement: { x: 0, y: 0 }, mapping, review,
    pixelAudit: { maskProvider: 'imagegen_matte', sourceGeometryAlignment: { policyVersion: 2, status: 'passed' } }, createdAt: '2026-01-01T00:00:00Z' };
  await writeFile(old.pngPath, source); await writeFile(path.join(directory, 'old.json'), JSON.stringify(old));
  await writeFile(path.join(root, 'attempts', 'attempt.json'), JSON.stringify(attempt));
  // The original attempt's bound policy must not be overwritten to make migration work.
  manifest.processingPolicy = { version: 2, processorSha256: 'old', itemContractSha256: 'old' };
  // Model the actual historical contract, not new semantic requirements merely
  // inherited from the current fixture preparer. Migration must not invent them.
  delete manifest.semanticRequirements;
  const manifestPath = path.join(root, 'attempts', 'attempt', 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, api, document, old, raw, rawPath, manifestPath };
}

test('a processor fix within policy v7 repairs the real failed card once, without changing its frozen attempt', async t => {
  const f = await fixture(t, 'gold-ui');
  f.old.processingPolicy = { ...(await currentProcessingPolicy()), processorSha256: 'older-processor' };
  f.old.pixelAudit.status = 'needs_review';
  f.old.pixelAudit.sourceGeometryAlignment = { policyVersion: 7, method: 'source_guided_matte', evidenceMethod: 'bounded_shape',
    status: 'needs_review', reviewReasons: ['SOURCE_BOUNDARY_UNCERTAIN'], boundaryMatchRatio: .703875, boundaryPixels: 2157,
    longestUnsupportedRun: 290, contourIntegrity: { status: 'passed', changedByAlphaRecoveryPixels: 0, lostCounterPixels: 0 } };
  await writeFile(path.join(f.root, 'candidates', 'attempt', 'old.json'), JSON.stringify(f.old));
  const before = await readFile(f.manifestPath);
  assert.equal((await f.api.listLayerVersions({ documentId: f.document.documentId, layerId: 'layer' })).state.status, 'quality_failed');
  const repaired = await f.api.revalidateCandidates({ documentId: f.document.documentId });
  assert.equal(repaired.results.length, 1);
  assert.equal(repaired.results[0].status, 'completed');
  await f.api.revalidateCandidates({ documentId: f.document.documentId });
  const { versions, state } = await f.api.listLayerVersions({ documentId: f.document.documentId, layerId: 'layer' });
  assert.equal(versions.length, 2);
  assert.equal(state.status, 'ready');
  const current = versions.find(v => v.versionId === state.resultVersionId);
  assert.equal(current.revalidation.modelCalls, 0);
  assert.deepEqual(current.processingPolicy, await currentProcessingPolicy());
  assert.equal(current.pixelAudit.sourceGeometryAlignment.status, 'passed');
  assert.equal(current.pixelAudit.sourceGeometryAlignment.minimumRatio, .9);
  assert.equal(current.pixelAudit.sourceGeometryAlignment.maximumUnsupportedRun, 12);
  assert.deepEqual(await f.api.getDocument(f.document.documentId), f.document);
  assert.deepEqual(await readFile(f.manifestPath), before);
  assert.deepEqual(await readFile(f.rawPath), f.raw);
  assert.equal((await f.api.exportDocumentPsd({ documentId: f.document.documentId, expectedRevision: f.document.revision })).layerCount, 1);
});

test('current-processor quality failures are not automatically retried on every refresh', async t => {
  const f = await fixture(t);
  f.old.processingPolicy = await currentProcessingPolicy();
  f.old.pixelAudit.status = 'needs_review';
  f.old.pixelAudit.sourceGeometryAlignment = { policyVersion: 7, method: 'source_guided_matte', evidenceMethod: 'bounded_shape',
    status: 'needs_review', reviewReasons: ['SOURCE_BOUNDARY_UNCERTAIN'], boundaryMatchRatio: .7, boundaryPixels: 200,
    longestUnsupportedRun: 30, contourIntegrity: { status: 'passed', changedByAlphaRecoveryPixels: 0, lostCounterPixels: 0 } };
  await writeFile(path.join(f.root, 'candidates', 'attempt', 'old.json'), JSON.stringify(f.old));
  for (let i = 0; i < 2; i++) assert.deepEqual((await f.api.revalidateCandidates({ documentId: f.document.documentId })).results, []);
  assert.equal((await f.api.listLayerVersions({ documentId: f.document.documentId, layerId: 'layer' })).versions.length, 1);
});

test('a source-matte processor change does not rerun an unrelated provider', async t => {
  const f = await fixture(t);
  f.old.processingPolicy = { ...(await currentProcessingPolicy()), processorSha256: 'older-processor' };
  f.old.alpha = { min: 255, max: 255 };
  f.old.pixelAudit = { maskProvider: 'bria', status: 'needs_review' };
  await writeFile(path.join(f.root, 'candidates', 'attempt', 'old.json'), JSON.stringify(f.old));
  assert.deepEqual((await f.api.revalidateCandidates({ documentId: f.document.documentId })).results, []);
});

test('policy-v5 reflective text is automatically rechecked and delivered without generation, approval or document changes', async t => {
  const f = await fixture(t, 'reflective');
  f.old.pixelAudit.sourceGeometryAlignment = { policyVersion: 5, method: 'source_guided_matte', evidenceMethod: 'bounded_shape',
    status: 'needs_review', reviewReasons: ['SOURCE_BOUNDARY_UNCERTAIN'], boundaryMatchRatio: .974278, boundaryPixels: 6648,
    longestUnsupportedRun: 22, contourIntegrity: { status: 'passed', changedByAlphaRecoveryPixels: 0, lostCounterPixels: 0 } };
  await writeFile(path.join(f.root, 'candidates', 'attempt', 'old.json'), JSON.stringify(f.old));
  const manifest = JSON.parse(await readFile(f.manifestPath)); manifest.processingPolicy.version = 5;
  await writeFile(f.manifestPath, JSON.stringify(manifest));
  const before = await readFile(f.manifestPath);
  assert.equal((await f.api.listLayerVersions({ documentId: f.document.documentId, layerId: 'layer' })).state.status, 'validation_pending');
  await f.api.revalidateCandidates({ documentId: f.document.documentId });
  await f.api.revalidateCandidates({ documentId: f.document.documentId });
  const { versions, state } = await f.api.listLayerVersions({ documentId: f.document.documentId, layerId: 'layer' });
  assert.equal(versions.length, 2);
  assert.equal(state.status, 'ready');
  const current = versions.find(v => v.versionId === state.resultVersionId);
  assert.equal(current.revalidation.modelCalls, 0);
  assert.equal(current.pixelAudit.sourceGeometryAlignment.policyVersion, 7);
  assert.equal(current.pixelAudit.sourceGeometryAlignment.minimumRatio, .9);
  assert.equal(current.pixelAudit.sourceGeometryAlignment.maximumUnsupportedRun, 12);
  assert.deepEqual(await f.api.getDocument(f.document.documentId), f.document);
  assert.deepEqual(await readFile(f.manifestPath), before);
  assert.deepEqual(await readFile(f.rawPath), f.raw);
  assert.equal((await f.api.getComposition(f.document.documentId)).layers[0].versionId, current.versionId);
  assert.equal((await f.api.exportDocumentPsd({ documentId: f.document.documentId, expectedRevision: f.document.revision })).layerCount, 1);
});

test('local revalidation archives once across concurrent calls and restarts, then delivers a downloadable PSD without adoption', async t => {
  const f = await fixture(t); const manifestBefore = await readFile(f.manifestPath);
  assert.equal(typeof f.api.revalidateCandidates, 'function', 'the workbench must offer local recovery rather than another generation');
  await Promise.all([f.api.revalidateCandidates({ documentId: f.document.documentId }), f.api.revalidateCandidates({ documentId: f.document.documentId })]);
  const api = createWorkbenchV2Api({ root: path.join(f.root, 'documents') });
  await api.revalidateCandidates({ documentId: f.document.documentId });
  const result = await api.listLayerVersions({ documentId: f.document.documentId, layerId: 'layer' });
  assert.equal(result.versions.length, 2, 'refresh/restart must not append duplicates');
  assert.equal(result.state.status, 'ready');
  const current = result.versions.find(v => v.versionId !== 'old');
  assert.equal(current.revalidation.originalVersionId, 'old');
  assert.equal(current.pixelAudit.sourceGeometryAlignment.contourIntegrity.status, 'passed');
  assert.deepEqual(await api.getDocument(f.document.documentId), f.document, 'automatic result resolution must not modify selections or document revision');
  assert.deepEqual(await readFile(f.manifestPath), manifestBefore);
  assert.equal(hash(await readFile(f.old.pngPath)), f.old.sha256);
  const composed = await api.getComposition(f.document.documentId);
  assert.equal(composed.layers[0].versionId, current.versionId);
  const exported = await api.exportDocumentPsd({ documentId: f.document.documentId, expectedRevision: f.document.revision });
  assert.equal(exported.layerCount, 1);
});

test('missing evidence is cached as a local failure and explicit retry recovers without generation', async t => {
  const f = await fixture(t); await rm(f.rawPath);
  assert.equal(typeof f.api.revalidateCandidates, 'function');
  const first = await f.api.revalidateCandidates({ documentId: f.document.documentId });
  assert.equal(first.results[0].status, 'failed');
  await writeFile(f.rawPath, f.raw);
  assert.equal((await f.api.revalidateCandidates({ documentId: f.document.documentId })).results[0].status, 'failed');
  assert.equal((await f.api.listLayerVersions({ documentId: f.document.documentId, layerId: 'layer' })).state.status, 'validation_failed');
  await f.api.revalidateCandidates({ documentId: f.document.documentId, layerId: 'layer', retry: true });
  assert.equal((await f.api.listLayerVersions({ documentId: f.document.documentId, layerId: 'layer' })).state.status, 'ready');
});

test('changed selections never reprocess a stale candidate against a new snapshot', async t => {
  const f = await fixture(t);
  await f.api.saveDocument(applyLayerEdit(f.document, 'layer', { bounds: { x: 1, y: 0, width: 159, height: 100 } }), f.document.revision);
  assert.equal(typeof f.api.revalidateCandidates, 'function');
  assert.deepEqual((await f.api.revalidateCandidates({ documentId: f.document.documentId })).results, []);
  assert.equal((await f.api.listLayerVersions({ documentId: f.document.documentId, layerId: 'layer' })).versions.length, 1);
});

test('the original car-text failure is locally repaired once and delivered without acknowledgement', async t => {
  const f = await fixture(t, true);
  f.old.pixelAudit.sourceGeometryAlignment = { policyVersion: 6, method: 'source_guided_matte', evidenceMethod: 'bounded_shape',
    status: 'needs_review', reviewReasons: ['SOURCE_BOUNDARY_UNCERTAIN'], boundaryMatchRatio: .978319, boundaryPixels: 6688,
    longestUnsupportedRun: 15, contourIntegrity: { status: 'passed', changedByAlphaRecoveryPixels: 0, lostCounterPixels: 0 } };
  await writeFile(path.join(f.root,'candidates','attempt','old.json'), JSON.stringify(f.old));
  const before = await readFile(f.manifestPath);
  assert.equal(typeof f.api.revalidateCandidates, 'function');
  await f.api.revalidateCandidates({ documentId: f.document.documentId });
  await f.api.revalidateCandidates({ documentId: f.document.documentId });
  const result = await f.api.listLayerVersions({ documentId: f.document.documentId, layerId: 'layer' });
  assert.equal(result.versions.length, 2);
  assert.equal(result.state.status, 'ready');
  const current = result.versions.find(v => v.versionId !== 'old');
  assert.deepEqual(result.state.versionIds, [current.versionId]);
  assert.equal(current.pixelAudit.sourceGeometryAlignment.policyVersion, 7);
  assert.equal(current.pixelAudit.sourceGeometryAlignment.contourIntegrity.status, 'passed');
  assert.deepEqual(current.pixelAudit.sourceGeometryAlignment.reviewReasons, []);
  assert.ok(current.pixelAudit.sourceGeometryAlignment.localContourRepair.changedPixels > 0);
  assert.equal(current.pixelAudit.sourceGeometryAlignment.maximumUnsupportedRun, 12);
  assert.equal(current.revalidation.modelCalls, 0);
  assert.equal(current.pixelAudit.sourceGeometryAlignment.status, 'passed');
  assert.equal((await f.api.getComposition(f.document.documentId)).layers[0].versionId,current.versionId);
  assert.equal((await f.api.exportDocumentPsd({ documentId: f.document.documentId, expectedRevision: f.document.revision })).layerCount,1);
  assert.deepEqual(await f.api.getDocument(f.document.documentId),f.document);
  assert.deepEqual(await readFile(f.manifestPath),before);
  assert.deepEqual(await readFile(f.rawPath),f.raw);
});
