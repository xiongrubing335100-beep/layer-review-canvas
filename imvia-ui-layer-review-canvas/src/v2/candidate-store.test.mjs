import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPosterPngBytes } from '../poster-png.js';
import { finalizeV2Candidate, finalizeV2Failure, listV2CandidateVersions, readV2CandidatePng } from './candidate-store.js';
import { addLayer, createDocument, freezeLayer } from './document.js';
import { candidateState } from './candidate-review.js';
import { createExportStore } from './export-store.js';
import { inspectPsd } from './psd-codec.mjs';

function crcTable() { return Uint32Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); return crc >>> 0; }); }
const crc32 = (data, table = crcTable()) => { let crc = 0xffffffff; for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
function png(width, height, color, alpha = 255) {
  const chunk = (type, data) => { const name = Buffer.from(type); const body = Buffer.concat([name, data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const p = y * (width * 4 + 1) + 1 + x * 4; rows.set([...(typeof color === 'function' ? color(x,y) : color), alpha], p); }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
import { deflateSync } from 'node:zlib';

async function prepared(root) {
  const attemptRoot = path.join(root, 'attempts', 'attempt-a'); await mkdir(attemptRoot, { recursive: true });
  const rawPath = path.join(attemptRoot, 'raw.png'); const reportPath = path.join(attemptRoot, 'review.json'); const outputPath = path.join(attemptRoot, 'region.png');
  await writeFile(path.join(attemptRoot, 'crop.png'), png(3, 2, [10, 20, 30]));
  await writeFile(rawPath, png(3, 2, [220, 40, 30]));
  const report = { attemptId: 'attempt-a', dispatchId: 'dispatch-a', authorizationId: 'auth-a', snapshotId: 'snap-a', sourceFingerprint: 'source-a', checks: { png: true, dimensions: true } };
  await writeFile(reportPath, JSON.stringify(report));
  const manifest = { schemaVersion: 2, mode: 'poster', route: 'reconstruct', maskProvider: 'generated_region', maximumImagegenCalls: 1,
    outputRoot: root,
    selectedCropPath: path.join(attemptRoot, 'crop.png'), outputPath, snapshot: { snapshotId: 'snap-a', source: { fingerprint: 'source-a' }, layerId: 'layer-a', layerRevision: 2, bounds: { x: 129, y: 1522, width: 3, height: 2 }, processingCategory: 'subject', strategy: { operation: 'reconstruct', removeBackground: false, repairPaths: [] } },
    envelope: { attemptId: 'attempt-a', batchId: 'batch-a', documentId: 'doc-a', layerId: 'layer-a', layerRevision: 2, dispatchId: 'dispatch-a', authorizationId: 'auth-a', snapshotId: 'snap-a', sourceFingerprint: 'source-a', candidateNumber: 1, legacyEnvelope: { dispatchId: 'dispatch-a' } } };
  const manifestPath = path.join(attemptRoot, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest));
  return { manifestPath, rawPath, reportPath, outputPath, attemptRoot };
}

test('candidate finalization preserves exact attempt binding, placement, alpha and source report', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-candidate-'));
  try {
    const f = await prepared(root);
    const candidate = await finalizeV2Candidate({ manifestPath: f.manifestPath, rawPath: f.rawPath, reportPath: f.reportPath });
    assert.equal(candidate.attemptId, 'attempt-a'); assert.equal(candidate.dispatchId, 'dispatch-a');
    assert.deepEqual(candidate.placement, { x: 129, y: 1522 }); assert.equal(candidate.width, 3); assert.equal(candidate.height, 2);
    assert.equal(candidate.review.checks.png, true); assert.match(candidate.sha256, /^[a-f0-9]{64}$/);
    // Even a historical manifest must record the processor actually used now.
    assert.equal(candidate.processingPolicy?.version, 7);
    assert.match(candidate.processingPolicy.processorSha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(await readFile(f.manifestPath, 'utf8')).processingPolicy, undefined);
    const archived = readPosterPngBytes(await readFile(candidate.pngPath)); assert.equal(archived.colorType, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native finalization rejects missing review, wrong raw and a second matte before rendering', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-native-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await prepared(root);
  const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
  manifest.maskProvider = 'native_rgba';
  await writeFile(f.manifestPath, JSON.stringify(manifest));
  await assert.rejects(finalizeV2Candidate(f), { code: 'NATIVE_RGBA_REVIEW_REQUIRED' });
  const report = JSON.parse(await readFile(f.reportPath, 'utf8'));
  Object.assign(report, { rawSha256: 'a'.repeat(64), finalPreview: { rgbaSha256: 'b'.repeat(64) },
    visualReview: { status: 'passed' }, nativeRgbaChecks: { contentFidelity: true, fullSilhouette: true,
      thinStructures: true, holesAndSolidMaterial: true, placement: true, protectedRegions: true } });
  await writeFile(f.reportPath, JSON.stringify(report));
  await assert.rejects(finalizeV2Candidate(f), { code: 'NATIVE_RGBA_RAW_BINDING_MISMATCH' });
  await assert.rejects(finalizeV2Candidate({ ...f, mattePath: f.rawPath }), { code: 'NATIVE_RGBA_SECOND_MATTE_FORBIDDEN' });
});

for (const [dx,dy] of [[0,0],[12,-12]]) test(`source-semantic correction at offset ${dx},${dy} survives PNG and lossless PSD readback`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-semantic-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await prepared(root);
  const solid = (x,y) => x >= 30 && x < 130 && y >= 20 && y < 80;
  const groove = (x,y) => x >= 60 && x < 95 && y >= 43 && y < 51;
  const counter = (x,y) => x >= 100 && x < 110 && y >= 60 && y < 70;
  const color = (x,y) => !solid(x,y) || counter(x,y) ? [20,20,20] : groove(x,y) ? [100,75,80] : [240,195,210];
  const sourcePath = path.join(root, 'source.png');
  const source = png(300,250,(x,y) => color(x-37,y-91));
  await writeFile(sourcePath, source);
  let document = createDocument({ documentId: 'doc-a', workbenchSessionId: 'session-a', mode: 'poster',
    source: { path: sourcePath, width: 300, height: 250, fingerprint: createHash('sha256').update(source).digest('hex'), revision: 1 } });
  document = addLayer(document, { layerId: 'layer-a', name: '实体组件', displayCategory: '主标题', processingCategory: 'text',
    bounds: { x: 37, y: 91, width: 160, height: 100 }, paths: [], requirements: '保留实体暗纹与真实镂空',
    strategy: { operation: 'extract', removeBackground: true, repairPaths: [] } });
  const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
  manifest.snapshot = freezeLayer(document, 'layer-a');
  Object.assign(manifest, { route: 'extract_mask', maskProvider: 'imagegen_matte', removeBackground: true,
    semanticRequirements: { version: 1 }, rawCoordinateSpace: 'selected_region' });
  Object.assign(manifest.envelope, { sourceFingerprint: document.source.fingerprint, snapshotId: manifest.snapshot.snapshotId,
    layerRevision: document.layers['layer-a'].layerRevision });
  await writeFile(manifest.selectedCropPath, png(160,100,color));
  const raw = png(160,100,(x,y) => Array(3).fill(solid(x-dx,y-dy) && !groove(x-dx,y-dy) && !counter(x-dx,y-dy) ? 255 : 0));
  await writeFile(f.rawPath, raw);
  await writeFile(f.manifestPath, JSON.stringify(manifest));
  const report = { ...manifest.envelope, rawSha256: createHash('sha256').update(raw).digest('hex'),
    checks: { png: true, dimensions: true, binding: true }, visualReview: { status: 'passed', summary: 'fixture ground truth' },
    semanticTopology: { version: 1, coordinateSpace: 'selected_region_pixels', profile: 'material_composite',
      objects: [{ name: 'card', point: [45,60] }], holes: [
        { id: 1, treatment: 'fill_material', reason: 'Known opaque groove in the independent source fixture.' },
        { id: 2, treatment: 'preserve', reason: 'Known true background counter.' }] } };
  await writeFile(f.reportPath, JSON.stringify(report));
  const candidate = await finalizeV2Candidate(f);
  assert.equal(candidate.pixelAudit.semanticTopology.status, 'passed');
  if (dx || dy) assert.equal(candidate.pixelAudit.sourceGeometryAlignment.globalRegistration.applied, true);
  assert.deepEqual(candidate.pixelAudit.semanticTopology.restoredHoleIds, [1]);
  const delivered = { ...candidate, execution: 'suggested', artifactValid: true };
  assert.equal(candidateState(document, 'layer-a', [delivered], []).status, 'ready');
  const decoded = readPosterPngBytes(await readFile(candidate.pngPath));
  assert.deepEqual([...decoded.pixels.slice((47*160+75)*4, (47*160+75)*4+4)], [100,75,80,255]);
  assert.equal(decoded.pixels[(65*160+105)*4+3], 0);
  assert.deepEqual(await readFile(f.rawPath), raw);
  const store = createExportStore({ root, availableMemory: 8*1024**3 });
  const exported = await store.exportDocumentPsd({ document, versions: [delivered], expectedRevision: document.revision });
  const restored = inspectPsd((await store.readPsd(document.documentId, exported.exportId)).bytes, { availableMemory: 8*1024**3 });
  assert.deepEqual(restored.layers[0].placement, { x: 37, y: 91 });
  assert.deepEqual([...restored.layers[0].image.data], [...decoded.pixels]);
  assert.equal(document.layers['layer-a'].acceptedVersionId, null, 'no user adoption step');
});

test('failure finalization ends only the original attempt and retains report/error evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-failure-'));
  try {
    const f = await prepared(root);
    const result = await finalizeV2Failure({ manifestPath: f.manifestPath, error: { code: 'NO_PNG', message: 'missing output' }, reportPath: f.reportPath, rawPath: f.rawPath });
    assert.equal(result.attemptId, 'attempt-a'); assert.equal(result.dispatchId, 'dispatch-a'); assert.equal(result.execution, 'failed');
    assert.ok(result.failurePath); assert.ok(result.reviewReportPath);
    assert.ok(result.rawPath); assert.equal((await readFile(result.rawPath)).length, (await readFile(f.rawPath)).length);
    const savedFailure = JSON.parse(await readFile(result.failurePath, 'utf8'));
    assert.equal(savedFailure.attemptId, 'attempt-a');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('candidate rejects missing or mismatched review evidence and all-transparent output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-reject-'));
  try {
    const f = await prepared(root); await writeFile(f.rawPath, png(3, 2, [20, 40, 60], 0));
    await assert.rejects(() => finalizeV2Candidate({ manifestPath: f.manifestPath, rawPath: f.rawPath }), /REVIEW_REPORT_REQUIRED/);
    await writeFile(f.reportPath, JSON.stringify({ attemptId: 'other', dispatchId: 'dispatch-a', authorizationId: 'auth-a', snapshotId: 'snap-a', sourceFingerprint: 'source-a', checks: { png: true } }));
    await assert.rejects(() => finalizeV2Candidate({ manifestPath: f.manifestPath, rawPath: f.rawPath, reportPath: f.reportPath }), /REVIEW_REPORT_BINDING_MISMATCH/);
    await writeFile(f.reportPath, JSON.stringify({ attemptId: 'attempt-a', dispatchId: 'dispatch-a', authorizationId: 'auth-a', snapshotId: 'snap-a', sourceFingerprint: 'source-a', checks: { png: true } }));
    await assert.rejects(() => finalizeV2Candidate({ manifestPath: f.manifestPath, rawPath: f.rawPath, reportPath: f.reportPath }), /ALL_TRANSPARENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an explicitly rejected semantic review never produces a candidate artifact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-semantic-reject-'));
  try {
    const f = await prepared(root);
    const report = JSON.parse(await readFile(f.reportPath, 'utf8'));
    report.visualReview = { status: 'rejected', code: 'SEMANTIC_MATTE_MISMATCH' };
    await writeFile(f.reportPath, JSON.stringify(report));
    await assert.rejects(finalizeV2Candidate(f), /SEMANTIC_REVIEW_REJECTED/);
    assert.deepEqual(await readdir(path.join(root, 'candidates')).catch(error => {
      if (error.code === 'ENOENT') return []; throw error;
    }), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('new semantic contracts require independent review bound to the exact raw pixels', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-semantic-binding-'));
  try {
    const f = await prepared(root);
    const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
    manifest.semanticRequirements = { version: 1 };
    await writeFile(f.manifestPath, JSON.stringify(manifest));
    await assert.rejects(finalizeV2Candidate(f), /SEMANTIC_REVIEW_REQUIRED/);
    const report = JSON.parse(await readFile(f.reportPath, 'utf8'));
    report.visualReview = { status: 'passed' };
    report.semanticTopology = { version: 1 };
    report.rawSha256 = '0'.repeat(64);
    await writeFile(f.reportPath, JSON.stringify(report));
    await assert.rejects(finalizeV2Candidate(f), /SEMANTIC_RAW_BINDING_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('delivery rejects pixel drift from the RGBA preview inspected by the executor', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-preview-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await prepared(root);
  const report = JSON.parse(await readFile(f.reportPath, 'utf8'));
  report.finalPreview = { rgbaSha256: '0'.repeat(64) };
  await writeFile(f.reportPath, JSON.stringify(report));
  await assert.rejects(finalizeV2Candidate(f), /FINAL_PREVIEW_MISMATCH/);
  assert.deepEqual(await readdir(path.join(root, 'candidates')).catch(e => { if (e.code === 'ENOENT') return []; throw e; }), []);
});

test('candidate registry scopes versions to their original attempt and verifies archived PNG bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-candidate-registry-'));
  try {
    const f = await prepared(root);
    const candidate = await finalizeV2Candidate({ manifestPath: f.manifestPath, rawPath: f.rawPath, reportPath: f.reportPath });
    const attempt = { attemptId: candidate.attemptId, documentId: candidate.documentId, layerId: candidate.layerId,
      layerRevision: candidate.layerRevision, dispatchId: candidate.dispatchId, authorizationId: candidate.authorizationId,
      snapshotId: candidate.snapshotId, sourceFingerprint: candidate.sourceFingerprint, execution: 'suggested' };
    const versions = await listV2CandidateVersions({ root, attempts: [attempt], documentId: candidate.documentId, layerId: candidate.layerId });
    assert.equal(versions.length, 1); assert.equal(versions[0].artifactValid, true);
    const resolved = await readV2CandidatePng({ root, attempts: [attempt], documentId: candidate.documentId, layerId: candidate.layerId, versionId: candidate.versionId });
    assert.equal(resolved.version.versionId, candidate.versionId); assert.equal(resolved.bytes.length, (await readFile(candidate.pngPath)).length);
    await writeFile(candidate.pngPath, Buffer.from('corrupt'));
    const stale = await listV2CandidateVersions({ root, attempts: [attempt], documentId: candidate.documentId, layerId: candidate.layerId });
    assert.equal(stale[0].artifactValid, false);
    await assert.rejects(() => readV2CandidatePng({ root, attempts: [attempt], documentId: candidate.documentId,
      layerId: candidate.layerId, versionId: candidate.versionId }), /CANDIDATE_ARTIFACT_INVALID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pixel processing errors retain their machine code and stage through failure archival', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-typed-failure-'));
  try {
    const f = await prepared(root);
    await writeFile(f.rawPath, png(3, 2, [20, 40, 60], 0));
    let failure;
    try { await finalizeV2Candidate(f); } catch (error) { failure = error; }
    assert.equal(failure?.code, 'ALL_TRANSPARENT');
    assert.equal(failure?.stage, 'pixel_finalization');
    const archived = await finalizeV2Failure({ ...f, error: failure });
    assert.equal(archived.error.code, 'ALL_TRANSPARENT');
    assert.equal(archived.error.stage, 'pixel_finalization');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a prepared processing policy cannot silently change during generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-policy-change-'));
  try {
    const f = await prepared(root);
    const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
    manifest.processingPolicy = { version: 3, processorSha256: '0'.repeat(64), itemContractSha256: '1'.repeat(64) };
    await writeFile(f.manifestPath, JSON.stringify(manifest));
    await assert.rejects(finalizeV2Candidate(f), error => error.code === 'PROCESSING_POLICY_CHANGED');
  } finally { await rm(root, { recursive: true, force: true }); }
});
