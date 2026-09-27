import test from 'node:test';
import assert from 'node:assert/strict';
import { addLayer, createDocument, freezeLayer } from './document.js';
import { createExportStore, freezeExport, validateExportPngBytes } from './export-store.js';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runCommand } from '../../scripts/python-runtime.mjs';

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

function tinyPng() {
  const chunk = (type, data) => {
    const typeBytes = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crcInput = Buffer.concat([typeBytes, data]); let crc = 0xffffffff;
    for (const byte of crcInput) { crc ^= byte; for (let bit=0; bit<8; bit+=1) crc=(crc>>>1)^(0xedb88320&-(crc&1)); }
    const checksum=Buffer.alloc(4); checksum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([length,typeBytes,data,checksum]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('IDAT',Buffer.from([120,156,99,248,207,192,240,31,0,5,0,1,255])),chunk('IEND',Buffer.alloc(0))]);
}

test('freezeExport freezes only explicitly adopted, current raster layers in original order', () => {
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
  assert.throws(() => freezeExport({ document, versions: [] }), /EXPORT_LAYER_NOT_ADOPTED/);
  assert.throws(() => freezeExport({ document, versions: [{ ...version, layerRevision: 99 }] }), /EXPORT_LAYER_NOT_ADOPTED/);
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
