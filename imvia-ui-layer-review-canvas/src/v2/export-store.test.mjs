import test from 'node:test';
import assert from 'node:assert/strict';
import { addLayer, createDocument, freezeLayer } from './document.js';
import { createExportStore, freezeExport, validateExportPngBytes } from './export-store.js';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runCommand } from '../../scripts/python-runtime.mjs';
import { deflateSync } from 'node:zlib';
import { inspectPsd } from './psd-codec.mjs';

function fixture() {
  let document = createDocument({ documentId: 'export-doc', workbenchSessionId: 'export-session', mode: 'poster',
    source: { path: '/source.png', width: 8, height: 6, fingerprint: 'source-hash', revision: 1 } });
  document = addLayer(document, { layerId: 'layer-a', name: '标题', displayCategory: '主标题', processingCategory: 'text',
    bounds: { x: 2, y: 1, width: 1, height: 1 }, paths: [], requirements: '',
    strategy: { operation: 'extract', removeBackground: true, repairPaths: [] } });
  const layer = document.layers['layer-a'];
  const version = { versionId: 'version-a', documentId: document.documentId, layerId: layer.layerId,
    layerRevision: layer.layerRevision, snapshotId: freezeLayer(document, layer.layerId).snapshotId,
    sourceFingerprint: document.source.fingerprint, execution: 'suggested', width: 1, height: 1,
    placement: { x: 2, y: 1 }, alpha: { min: 0, max: 255 }, sha256: createHash('sha256').update(tinyPng()).digest('hex'),
    pngPath: '/private/version-a.png', review: { checks: { png: true, authorization: true } }, artifactValid: true };
  document = { ...document, revision: document.revision + 1,
    layers: { ...document.layers, 'layer-a': { ...layer, acceptedVersionId: version.versionId } } };
  return { document, version };
}

function tinyPng(rgba = [255, 0, 0, 255]) {
  const chunk = (type, data) => {
    const typeBytes = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crcInput = Buffer.concat([typeBytes, data]); let crc = 0xffffffff;
    for (const byte of crcInput) { crc ^= byte; for (let bit=0; bit<8; bit+=1) crc=(crc>>>1)^(0xedb88320&-(crc&1)); }
    const checksum=Buffer.alloc(4); checksum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([length,typeBytes,data,checksum]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('IDAT',deflateSync(Buffer.from([0, ...rgba]))),chunk('IEND',Buffer.alloc(0))]);
}

test('freezeExport freezes only verified current raster layers in original order', () => {
  const { document, version } = fixture();
  const snapshot = freezeExport({ document, versions: [version], availableMemory: 8 * 1024 ** 3 });
  assert.equal(snapshot.documentRevision, document.revision);
  assert.equal(snapshot.layers.length, 1);
  assert.deepEqual(snapshot.layers[0].placement, { x: 2, y: 1 });
  assert.equal(snapshot.layers[0].name, '标题');
  assert.equal(snapshot.background, 'transparent');
  assert.equal(Object.isFrozen(snapshot.layers[0]), true);
});

test('freezeExport rejects missing, stale, hash/dimension-mismatched, and non-Normal layer data', () => {
  const { document, version } = fixture();
  assert.throws(() => freezeExport({ document, versions: [] }), /EXPORT_LAYER_NOT_READY/);
  assert.throws(() => freezeExport({ document, versions: [{ ...version, layerRevision: 99 }] }), /EXPORT_LAYER_NOT_READY/);
  assert.throws(() => freezeExport({ document, versions: [{ ...version, sha256: 'bad' }] }), /EXPORT_CANDIDATE_HASH_INVALID/);
  assert.throws(() => freezeExport({ document, versions: [{ ...version, width: 4 }] }), /EXPORT_CANDIDATE_DIMENSIONS_MISMATCH/);
  assert.throws(() => freezeExport({ document, versions: [{ ...version, blendMode: 'multiply' }] }), /UNSUPPORTED_BLEND_MODE/);
  assert.throws(() => freezeExport({ document, versions: [version], availableMemory: 1 }), /PSD_MEMORY_LIMIT/);
});

test('export PNG verification binds exact bytes and RGBA dimensions to the frozen layer', () => {
  const bytes = tinyPng(); const version = { sha256: createHash('sha256').update(bytes).digest('hex'), width: 1, height: 1 };
  assert.equal(validateExportPngBytes(bytes, version).colorType, 6);
  assert.throws(() => validateExportPngBytes(bytes, { ...version, sha256: '0'.repeat(64) }), /EXPORT_CANDIDATE_HASH_MISMATCH/);
  assert.throws(() => validateExportPngBytes(bytes, { ...version, width: 2 }), /EXPORT_CANDIDATE_DIMENSIONS_MISMATCH/);
});

test('cached PSD cannot bypass a subsequently unverified matte geometry check', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-v2-geometry-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { document, version: base } = fixture();
  const pngPath = path.join(root, 'candidates', 'version-a.png');
  await mkdir(path.dirname(pngPath), { recursive: true }); await writeFile(pngPath, tinyPng());
  const store = createExportStore({ root, availableMemory: 8 * 1024 ** 3 });
  const version = { ...base, pngPath };
  const exported = await store.exportDocumentPsd({ document, versions: [version], expectedRevision: document.revision });
  const unverified = { ...version, pixelAudit: { maskProvider: 'imagegen_matte' } };
  await assert.rejects(store.exportDocumentPsd({ document, versions: [unverified], expectedRevision: document.revision }), /EXPORT_CANDIDATE_GEOMETRY_UNVERIFIED/);
  assert.equal((await store.readPsd(document.documentId, exported.exportId)).record.exportId, exported.exportId, 'archive remains recoverable');
});

test('a real export uses its frozen revision and a failed later export cannot replace the previous PSD', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-v2-exports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { document, version: baseVersion } = fixture(); let failNext = false;
  const candidatePath = path.join(root, 'candidates', `${baseVersion.versionId}.png`);
  await mkdir(path.dirname(candidatePath), { recursive: true }); await writeFile(candidatePath, tinyPng());
  const version = { ...baseVersion, pngPath: candidatePath, sha256: createHash('sha256').update(tinyPng()).digest('hex') };
  const testMemory = 8 * 1024 ** 3;
  const store = createExportStore({ root, availableMemory: testMemory, runExport: async (snapshotPath, outputPath) => {
    const script = path.resolve('scripts/export-v2-psd.mjs');
    const result = await runCommand(process.execPath, [script, '--snapshot', snapshotPath, '--output', outputPath,
      '--available-memory', String(testMemory)], { cwd: process.cwd() });
    if (failNext) { failNext = false; throw new Error('injected post-write failure'); }
    return result;
  } });
  const first = await store.exportDocumentPsd({ document, versions: [version], expectedRevision: document.revision });
  const old = await store.readPsd(document.documentId, first.exportId);
  assert.equal(old.record.documentRevision, document.revision);
  const newerDocument = { ...document, revision: document.revision + 1 };
  const frozen = freezeExport({ document: newerDocument, versions: [version], availableMemory: testMemory });
  assert.equal(frozen.documentRevision, document.revision + 1);
  failNext = true;
  await assert.rejects(store.exportDocumentPsd({ document: newerDocument, versions: [version], expectedRevision: newerDocument.revision }), /injected post-write failure/);
  assert.equal(createHash('sha256').update((await store.readPsd(document.documentId, first.exportId)).bytes).digest('hex'), first.sha256);
  assert.equal((await readdir(path.join(root, 'exports', document.documentId))).some(name => name.startsWith('.staging-')), false);
  assert.deepEqual((await store.list(document.documentId, newerDocument.revision)).map(value => [value.exportId, value.stale]), [[first.exportId, true]]);
});

test('a real PSD export accepts semi-transparent UI pixels without changing the layer RGBA', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-v2-alpha-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { document, version: baseVersion } = fixture();
  const bytes = tinyPng([161, 122, 138, 254]);
  const pngPath = path.join(root, 'candidates', `${baseVersion.versionId}.png`);
  await mkdir(path.dirname(pngPath), { recursive: true });
  await writeFile(pngPath, bytes);
  const version = { ...baseVersion, pngPath, sha256: createHash('sha256').update(bytes).digest('hex') };
  const testMemory = 8 * 1024 ** 3;
  const store = createExportStore({ root, availableMemory: testMemory, runExport: (snapshotPath, outputPath) =>
    runCommand(process.execPath, [path.resolve('scripts/export-v2-psd.mjs'), '--snapshot', snapshotPath, '--output', outputPath,
      '--available-memory', String(testMemory)], { cwd: process.cwd() }) });
  const record = await store.exportDocumentPsd({ document, versions: [version], expectedRevision: document.revision });
  const downloaded = await store.readPsd(document.documentId, record.exportId);
  const restored = inspectPsd(downloaded.bytes, { availableMemory: 8 * 1024 ** 3 });
  assert.equal(record.status, 'complete');
  assert.deepEqual(Array.from(restored.layers[0].image.data), [161, 122, 138, 254]);
  assert.deepEqual(restored.layers[0].placement, { x: 2, y: 1 });
  const offset = (1 * 8 + 2) * 4;
  assert.deepEqual(Array.from(restored.composite.data.slice(offset, offset + 4)), [161, 121, 138, 254]);
});

test('a current completed PSD downloads again under low memory without regenerating or accepting stale/corrupt files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-v2-cached-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { document, version: baseVersion } = fixture();
  const pngPath = path.join(root, 'candidates', 'version-a.png');
  await mkdir(path.dirname(pngPath), { recursive: true }); await writeFile(pngPath, tinyPng());
  const version = { ...baseVersion, pngPath };
  const store = createExportStore({ root, availableMemory: 8 * 1024 ** 3 });
  const first = await store.exportDocumentPsd({ document, versions: [version], expectedRevision: document.revision });
  const lowMemoryStore = createExportStore({ root, availableMemory: 1 });
  const second = await lowMemoryStore.exportDocumentPsd({ document, versions: [version], expectedRevision: document.revision });
  assert.equal(second.exportId, first.exportId);
  assert.equal(second.reused, true);
  assert.equal((await lowMemoryStore.readPsd(document.documentId, second.exportId)).record.sha256, first.sha256);
  assert.equal((await lowMemoryStore.list(document.documentId)).length, 1);
  const newer = { ...document, revision: document.revision + 1 };
  await assert.rejects(lowMemoryStore.exportDocumentPsd({ document: newer, versions: [version], expectedRevision: newer.revision }), /PSD_MEMORY_LIMIT/);
  await assert.rejects(lowMemoryStore.exportDocumentPsd({ document, versions: [version], expectedRevision: document.revision - 1 }), /REVISION_CONFLICT/);
  await writeFile(path.join(root, 'exports', document.documentId, `${first.exportId}.psd`), Buffer.from('8BPS-corrupted'));
  await assert.rejects(lowMemoryStore.exportDocumentPsd({ document, versions: [version], expectedRevision: document.revision }), /PSD_MEMORY_LIMIT/);
  const regenerated = await store.exportDocumentPsd({ document, versions: [version], expectedRevision: document.revision });
  assert.notEqual(regenerated.exportId, first.exportId);
  assert.equal((await store.readPsd(document.documentId, regenerated.exportId)).record.status, 'complete');
});

test('automatic result changes invalidate cached PSD even when the editable document revision is unchanged', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-v2-auto-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { document, version: base } = fixture();
  document.layers['layer-a'].acceptedVersionId = null;
  const store = createExportStore({ root, availableMemory: 8 * 1024 ** 3 });
  const make = async (id, rgba, createdAt) => {
    const bytes = tinyPng(rgba), pngPath = path.join(root, id + '.png');
    await writeFile(pngPath, bytes);
    return { ...base, versionId: id, pngPath, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt };
  };
  const old = await make('first', [255, 0, 0, 255], '2026-01-01');
  const next = await make('second', [0, 255, 0, 255], '2026-01-02');
  const first = await store.exportDocumentPsd({ document, versions: [old], expectedRevision: document.revision });
  const second = await store.exportDocumentPsd({ document, versions: [old, next], expectedRevision: document.revision });
  assert.notEqual(second.exportId, first.exportId);
  const parsed = inspectPsd((await store.readPsd(document.documentId, second.exportId)).bytes, { availableMemory: 8 * 1024 ** 3 });
  assert.deepEqual(Array.from(parsed.layers[0].image.data), [0, 255, 0, 255]);
  assert.deepEqual(parsed.layers[0].placement, { x: 2, y: 1 });
  assert.equal((await store.exportDocumentPsd({ document, versions: [old, next], expectedRevision: document.revision })).reused, true);
});

test('first-time PSD export keeps its admission budget through worker encoding and readback', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-v2-memory-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { document, version: baseVersion } = fixture();
  const pngPath = path.join(root, 'candidates', 'version-a.png');
  await mkdir(path.dirname(pngPath), { recursive: true }); await writeFile(pngPath, tinyPng());
  let samples = 0;
  t.mock.method(process, 'availableMemory', () => ++samples === 1 ? 2 * 1024 ** 3 : 1);
  const store = createExportStore({ root });
  const record = await store.exportDocumentPsd({ document, versions: [{ ...baseVersion, pngPath }], expectedRevision: document.revision });
  assert.equal((await store.readPsd(document.documentId, record.exportId)).record.status, 'complete');
  assert.equal(samples, 1);
});
