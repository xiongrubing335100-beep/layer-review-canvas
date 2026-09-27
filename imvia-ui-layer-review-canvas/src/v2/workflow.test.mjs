import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkbenchV2Api } from './api.mjs';
import { createBridgeRequestStore } from './bridge-request-store.js';
import { createExportStore } from './export-store.js';
import { importLegacyDocument } from './legacy-import.js';
import { runCommand } from '../../scripts/python-runtime.mjs';

const pngChunk = (type, data) => {
  const typeBytes = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBytes, data]); let crc = 0xffffffff;
  for (const byte of crcInput) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
};
const tinyPng = () => {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]); const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([signature, pngChunk('IHDR', header), pngChunk('IDAT', Buffer.from([120,156,99,248,207,192,240,31,0,5,0,1,255])), pngChunk('IEND', Buffer.alloc(0))]);
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function storeSuggestedCandidate(root, attempt, versionId, png) {
  const directory = path.join(root, 'candidates', attempt.attemptId);
  await mkdir(directory, { recursive: true });
  const pngPath = path.join(directory, `${versionId}.png`);
  const record = { versionId, attemptId: attempt.attemptId, batchId: attempt.batchId, documentId: attempt.documentId,
    layerId: attempt.layerId, dispatchId: attempt.dispatchId, authorizationId: attempt.authorizationId,
    snapshotId: attempt.snapshotId, sourceFingerprint: attempt.sourceFingerprint, layerRevision: attempt.layerRevision,
    pngPath, sha256: sha256(png), width: 1, height: 1, alpha: { min: 255, max: 255 }, placement: { x: 0, y: 0 },
    review: { checks: { png: true, alpha: true, authorization: true, dispatch: true } },
    pixelAudit: { status: 'NEEDS_USER_REVIEW' }, createdAt: new Date().toISOString() };
  await writeFile(pngPath, png); await writeFile(path.join(directory, `${versionId}.json`), JSON.stringify(record));
}

test('legacy definitions flow through visible batch confirmation, two reviewed attempts, explicit adoption, and raster PSD export', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-v2-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documentsRoot = path.join(root, 'documents'); const bytes = tinyPng();
  const bridgeStore = createBridgeRequestStore({ root: path.join(root, 'bridge-requests') });
  const exportStore = createExportStore({ root, availableMemory: 8 * 1024 ** 3,
    runExport: (snapshotPath, outputPath) => runCommand(process.execPath,
      [path.resolve('scripts/export-v2-psd.mjs'), '--snapshot', snapshotPath, '--output', outputPath, '--available-memory', String(8 * 1024 ** 3)], { cwd: process.cwd() }) });
  const api = createWorkbenchV2Api({ root: documentsRoot, bridgeStore, exportStore });
  const created = await api.createDocument({ mode: 'poster', bytes, workbenchSessionId: 'workflow-session' });
  const legacyDocument = { sourceFingerprint: 'legacy-file-identity', sourceSize: { width: 1, height: 1 }, documentMode: 'poster',
    nodes: [
      { id: 'old-title', name: '标题', category: 'kvTitle', status: 'candidate', bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { id: 'old-logo', name: '品牌', category: 'uiComponent', status: 'accepted', bounds: { x: 0, y: 0, width: 100, height: 100 } },
    ] };
  const imported = importLegacyDocument({ legacyDocument, newDocumentId: created.documentId,
    verifiedAssets: { workbenchSessionId: created.workbenchSessionId,
      source: { ...created.source, legacyFingerprint: legacyDocument.sourceFingerprint } } });
  const document = await api.saveDocument({ ...imported.document, revision: 2 }, 1);
  assert.equal(document.layerOrder.length, 2);
  assert.ok(document.layerOrder.every(id => document.layers[id].acceptedVersionId === null));

  const submission = await api.submitBatch({ documentId: document.documentId, expectedRevision: document.revision,
    submissionKey: 'workflow-confirmed-batch', mode: 'pending' });
  assert.equal(submission.confirmation.status, 'claimed');
  const receipt = { workbenchSessionId: submission.confirmation.workbenchSessionId,
    envelopeSha256: submission.confirmation.envelopeSha256 };
  await bridgeStore.transition({ requestId: submission.batch.batchId, expectedStatus: 'claimed', nextStatus: 'sent', receipt });
  const suggestions = [];
  for (const [index, layerId] of document.layerOrder.entries()) {
    const attempt = await api.claimNextBatchItem({ batchId: submission.batch.batchId, receipt });
    assert.equal(attempt.attempt.layerId, layerId);
    const versionId = `version-${index + 1}`;
    await storeSuggestedCandidate(root, attempt.attempt, versionId, bytes);
    await api.applyAttemptEvent({ batchId: submission.batch.batchId, event: { eventId: `suggested-${index + 1}`,
      attemptId: attempt.attempt.attemptId, dispatchId: attempt.attempt.dispatchId,
      type: 'suggested', payload: { versionId } } });
    suggestions.push({ layerId, versionId });
  }

  await assert.rejects(api.exportDocumentPsd({ documentId: document.documentId, expectedRevision: document.revision }), /EXPORT_LAYER_NOT_ADOPTED/);
  let current = document;
  for (const suggestion of suggestions) {
    const versions = await api.listLayerVersions({ documentId: document.documentId, layerId: suggestion.layerId });
    assert.equal(versions.state.status, 'review');
    current = await api.adoptCandidate({ documentId: document.documentId, expectedRevision: current.revision,
      layerId: suggestion.layerId, versionId: suggestion.versionId });
  }
  const exported = await api.exportDocumentPsd({ documentId: current.documentId, expectedRevision: current.revision });
  const downloaded = await api.readExportPsd({ documentId: current.documentId, exportId: exported.exportId });
  assert.equal(exported.layerCount, 2); assert.equal(downloaded.bytes.subarray(0, 4).toString(), '8BPS');
});
