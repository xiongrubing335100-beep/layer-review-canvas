import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareV2Item } from './execution-adapter.js';
import { defaultLayerStrategy } from './document.js';
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

test('source-faithful repair uses native transparency and one fixed-coordinate model call', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-native-rgba-'));
  try {
    const f = fixture({ category: 'text', removeBackground: true });
    f.source.path = path.join(root, 'source.png');
    await writeFile(f.source.path, f.sourceBytes);
    f.snapshot.strategy.fidelityPolicy = 'source_faithful_repair';
    updateSnapshotBinding(f);
    const manifest = await prepareV2Item({ ...f, outputRoot: root });
    assert.equal(manifest.maskProvider, 'native_rgba');
    assert.equal(manifest.route, 'reconstruct');
    assert.equal(manifest.maximumImagegenCalls, 1);
    assert.equal(manifest.rawCoordinateSpace, 'reference_canvas');
    assert.equal(manifest.nativeRgbaRequirements.version, 3);
    assert.equal(manifest.semanticRequirements, undefined);
    assert.equal(JSON.parse(await readFile(manifest.mappingPath)).sampling, 'area_reduce_linear_enlarge_premultiplied');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ordinary default split uses local repair but disabling background removal stays source-only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'v2-default-repair-'));
  try {
    const f = fixture({category:'subject',removeBackground:true});
    f.source.path = path.join(root,'source.png');
    await writeFile(f.source.path,f.sourceBytes);
    f.snapshot.strategy = defaultLayerStrategy('subject');
    updateSnapshotBinding(f);
    const normal = await prepareV2Item({...f,outputRoot:path.join(root,'normal')});
    assert.equal(normal.maskProvider,'native_rgba');
    assert.equal(normal.nativeRgbaRequirements.version,3);
    assert.equal(normal.maximumImagegenCalls,2);
    assert.equal(normal.snapshot.strategy.localRepairPolicy,'scoped_once_v1');
    f.snapshot.strategy.removeBackground = false;
    updateSnapshotBinding(f);
    const unchanged = await prepareV2Item({...f,outputRoot:path.join(root,'unchanged')});
    assert.equal(unchanged.maskProvider,'selection');
    assert.equal(unchanged.maximumImagegenCalls,0);
    f.snapshot.strategy = {...defaultLayerStrategy('subject'),fidelityPolicy:'strict_source'};
    updateSnapshotBinding(f);
    const strict = await prepareV2Item({...f,outputRoot:path.join(root,'strict')});
    assert.equal(strict.maskProvider,'bria');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('matte reference downsampling preserves thin foreground and background coverage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-reference-coverage-'));
  try {
    // Each reference pixel covers one white column and one black column.
    // Point sampling erases all the black gaps and sends a solid white image.
    const f = fixture({ category: 'text', removeBackground: true });
    const width = 2824, height = 1800;
    const rgba = Buffer.alloc(width * height * 4, 255);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x += 2) {
      const offset = (y * width + x) * 4;
      rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 0;
    }
    const bytes = png(width, height, rgba);
    Object.assign(f.source, { path: path.join(root, 'source.png'), width, height,
      fingerprint: createHash('sha256').update(bytes).digest('hex') });
    f.attempt.sourceFingerprint = f.source.fingerprint;
    f.snapshot.bounds = { x: 0, y: 0, width, height };
    updateSnapshotBinding(f);
    await writeFile(f.source.path, bytes);
    const manifest = await prepareV2Item({ ...f, outputRoot: path.join(root, 'work') });
    const mapping = JSON.parse(await readFile(manifest.mappingPath, 'utf8'));
    const reference = readPosterPngBytes(await readFile(manifest.referencePath));
    assert.deepEqual(mapping.contentRegion, { x: 62, y: 62, width: 1412, height: 900 });
    for (const [x, y] of [[62,62], [700,500], [1473,961]]) {
      const offset = (y * reference.width + x) * 4;
      assert.deepEqual([...reference.pixels.slice(offset, offset + 4)], [128,128,128,255],
        'a half-covered pixel must not become solid foreground or background');
    }
    const crop = readPosterPngBytes(await readFile(manifest.selectedCropPath));
    assert.deepEqual(Buffer.from(crop.pixels), rgba, 'sampling the reference must not edit the source crop');
    assert.equal(manifest.maskProvider, 'imagegen_matte');
    assert.equal(manifest.maximumImagegenCalls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
    assert.match(manifest.processingPolicy.processorSha256, /^[a-f0-9]{64}$/);
    const contract = await readFile(manifest.processingPolicy.itemContractPath);
    assert.equal(manifest.processingPolicy.itemContractSha256, createHash('sha256').update(contract).digest('hex'));
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
    assert.equal(textManifest.semanticRequirements?.version, 1);
    assert.equal(textManifest.semanticRequirements?.coordinateSpace, 'selected_region_pixels');
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
    assert.equal(repairManifest.rawCoordinateSpace, 'selected_region');
    f.snapshot.strategy.removeBackground = false; updateSnapshotBinding(f);
    const backgroundManifest = await prepareV2Item({ ...f, outputRoot: path.join(root, 'background-repair') });
    assert.equal(backgroundManifest.rawCoordinateSpace, 'reference_canvas');
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

test('local repair instructions are combined in the persisted manifest and choose a route that can execute them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-local-requirements-'));
  try {
    const f = fixture(); const sourcePath = path.join(root, 'source.png');
    await writeFile(sourcePath, f.sourceBytes); f.source.path = sourcePath;
    f.snapshot.requirements = '保留 UI 边框与材质';
    f.snapshot.strategy.repairPaths = [{ id: 'nickname', kind: 'include', shape: 'bezier_path', closed: true, order: 0,
      requirements: '移除昵称，补全蓝色底板', anchors: [[150,1540],[250,1540],[250,1600]].map(([x,y]) => ({x,y,in:{x,y},out:{x,y},handlesLinked:true})) }];
    updateSnapshotBinding(f);
    const manifest = await prepareV2Item({ ...f, outputRoot: path.join(root, 'work') });
    assert.equal(manifest.route, 'reconstruct');
    assert.equal(manifest.maximumImagegenCalls, 1);
    const persisted = JSON.parse(await readFile(path.join(path.dirname(manifest.selectedCropPath), 'manifest.json'), 'utf8'));
    assert.match(persisted.processingRequirements, /保留 UI 边框与材质/);
    assert.match(persisted.processingRequirements, /移除昵称，补全蓝色底板/);
    assert.equal(persisted.regionInstructions[0].pathId, 'nickname');
    assert.equal(persisted.regionInstructions[0].referenceAnchors.length, 3);
    assert.equal(persisted.snapshot.strategy.repairPaths[0].requirements, '移除昵称，补全蓝色底板');
  } finally { await rm(root, { recursive: true, force: true }); }
});
