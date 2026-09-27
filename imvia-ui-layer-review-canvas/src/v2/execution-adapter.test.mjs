import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareV2Item } from './execution-adapter.js';
import { digestCanonicalJson } from '../poster-plan.js';
import { readPosterPngBytes } from '../poster-png.js';

function png(width, height, rgba) {
  const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); return crc >>> 0;
  });
  const crc32 = data => { let crc = 0xffffffff; for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const name = Buffer.from(type); const body = Buffer.concat([name, data]); const header = Buffer.alloc(4); header.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body)); return Buffer.concat([header, body, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba).copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
import * as zlib from 'node:zlib';

function fixture({ category = 'subject', operation = 'extract', removeBackground = false } = {}) {
  const width = 1500; const height = 3000; const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) { rgba[i * 4] = 24; rgba[i * 4 + 1] = 96; rgba[i * 4 + 2] = 180; rgba[i * 4 + 3] = 255; }
  const sourceBytes = png(width, height, rgba);
  const source = { path: '', width, height, fingerprint: createHash('sha256').update(sourceBytes).digest('hex'), revision: 1 };
  const bounds = { x: 129, y: 1522, width: 1280, height: 1451 };
  const snapshot = { snapshotId: '', source, layerId: 'layer-a', layerRevision: 3, bounds,
    paths: [], requirements: '', processingCategory: category, strategy: { operation, removeBackground, repairPaths: [] } };
  snapshot.snapshotId = digestCanonicalJson({ source, layerId: snapshot.layerId, layerRevision: snapshot.layerRevision, bounds,
    paths: snapshot.paths, requirements: snapshot.requirements, processingCategory: snapshot.processingCategory, strategy: snapshot.strategy });
  const document = { schemaVersion: 2, documentId: 'doc-a', workbenchSessionId: 'session-a', mode: 'poster', source };
  const attempt = { attemptId: 'attempt-a', batchId: 'batch-a', documentId: 'doc-a', layerId: 'layer-a', layerRevision: 3,
    dispatchId: 'dispatch-a', authorizationId: 'auth-a', snapshotId: snapshot.snapshotId, sourceFingerprint: source.fingerprint,
    candidateNumber: 1, planVersion: 1, delivery: 'sent', execution: 'running', legacyEnvelope: { dispatchId: 'dispatch-a' } };
  return { sourceBytes, source, snapshot, document, attempt };
}
function updateSnapshotBinding(f) {
  f.snapshot.snapshotId = digestCanonicalJson({ source: f.snapshot.source, layerId: f.snapshot.layerId,
    layerRevision: f.snapshot.layerRevision, bounds: f.snapshot.bounds, paths: f.snapshot.paths,
    requirements: f.snapshot.requirements, processingCategory: f.snapshot.processingCategory, strategy: f.snapshot.strategy });
  f.attempt.snapshotId = f.snapshot.snapshotId;
}

test('prepares an immutable far-from-origin extraction manifest without moving placement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-execution-'));
  try {
    const f = fixture(); const sourcePath = path.join(root, 'source.png'); const outputRoot = path.join(root, 'work');
    await writeFile(sourcePath, f.sourceBytes); f.source.path = sourcePath; f.snapshot.source.path = sourcePath; f.document.source.path = sourcePath; updateSnapshotBinding(f);
    const manifest = await prepareV2Item({ ...f, outputRoot });
    assert.equal(manifest.route, 'extract_mask'); assert.equal(manifest.maximumImagegenCalls, 0); assert.equal(manifest.maskProvider, 'selection');
    assert.deepEqual(manifest.snapshot.bounds, { x: 129, y: 1522, width: 1280, height: 1451 });
    const crop = readPosterPngBytes(await readFile(manifest.selectedCropPath));
    assert.deepEqual({ width: crop.width, height: crop.height }, { width: 1280, height: 1451 });
    assert.deepEqual(manifest.envelope.legacyEnvelope, f.attempt.legacyEnvelope);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('routes h5 explicitly and grants one matte call only to opted-in text and brand UI extraction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-routes-'));
  try {
    const f = fixture({ category: 'text', removeBackground: true }); const sourcePath = path.join(root, 'source.png');
    await writeFile(sourcePath, f.sourceBytes); f.source.path = sourcePath; f.snapshot.source.path = sourcePath; f.document.source.path = sourcePath; updateSnapshotBinding(f);
    f.document.mode = 'h5';
    const textManifest = await prepareV2Item({ ...f, outputRoot: path.join(root, 'text') });
    assert.equal(textManifest.mode, 'h5'); assert.equal(textManifest.route, 'extract_mask');
    assert.equal(textManifest.maskProvider, 'imagegen_matte'); assert.equal(textManifest.maximumImagegenCalls, 1);
    const mapping = JSON.parse(await readFile(textManifest.mappingPath, 'utf8'));
    const reference = readPosterPngBytes(await readFile(textManifest.referencePath));
    assert.deepEqual({ width: reference.width, height: reference.height }, { width: 1536, height: 1024 });
    assert.deepEqual(mapping.sourcePlacement, { x: 129, y: 1522 });
    assert.deepEqual(mapping.sourceRegion, { width: 1280, height: 1451 });
    assert.ok(mapping.contentRegion.x >= 61 && mapping.contentRegion.y >= 61);
    assert.ok(mapping.contentRegion.x + mapping.contentRegion.width <= 1475);
    assert.ok(mapping.contentRegion.y + mapping.contentRegion.height <= 963);
    f.snapshot.processingCategory = 'subject'; updateSnapshotBinding(f);
    const subjectManifest = await prepareV2Item({ ...f, outputRoot: path.join(root, 'subject') });
    assert.equal(subjectManifest.maskProvider, 'bria'); assert.equal(subjectManifest.maximumImagegenCalls, 0);
    f.snapshot.strategy.operation = 'reconstruct'; updateSnapshotBinding(f);
    const repairManifest = await prepareV2Item({ ...f, outputRoot: path.join(root, 'repair') });
    assert.equal(repairManifest.route, 'reconstruct'); assert.equal(repairManifest.maximumImagegenCalls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects source, dispatch, and authorization mismatches before creating a route', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-binding-'));
  try {
    const f = fixture(); const sourcePath = path.join(root, 'source.png');
    await writeFile(sourcePath, f.sourceBytes); f.source.path = sourcePath; f.snapshot.source.path = sourcePath; f.document.source.path = sourcePath; updateSnapshotBinding(f);
    await assert.rejects(() => prepareV2Item({ ...f, attempt: { ...f.attempt, dispatchId: 'other' }, outputRoot: path.join(root, 'a') }), /ATTEMPT_SNAPSHOT_MISMATCH/);
    await assert.rejects(() => prepareV2Item({ ...f, snapshot: { ...f.snapshot, source: { ...f.source, fingerprint: 'wrong' } }, outputRoot: path.join(root, 'b') }), /SNAPSHOT_DIGEST_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
