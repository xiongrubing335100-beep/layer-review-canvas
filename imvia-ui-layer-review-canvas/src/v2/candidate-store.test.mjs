import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPosterPngBytes } from '../poster-png.js';
import { finalizeV2Candidate, finalizeV2Failure, listV2CandidateVersions, readV2CandidatePng } from './candidate-store.js';

function crcTable() { return Uint32Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); return crc >>> 0; }); }
const crc32 = (data, table = crcTable()) => { let crc = 0xffffffff; for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
function png(width, height, color, alpha = 255) {
  const chunk = (type, data) => { const name = Buffer.from(type); const body = Buffer.concat([name, data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const p = y * (width * 4 + 1) + 1 + x * 4; rows.set([...color, alpha], p); }
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
    const archived = readPosterPngBytes(await readFile(candidate.pngPath)); assert.equal(archived.colorType, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
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
