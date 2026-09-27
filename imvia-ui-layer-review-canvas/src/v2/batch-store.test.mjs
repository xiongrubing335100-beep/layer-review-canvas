import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBatchStore } from './batch-store.js';

function documentFixture(documentId = 'doc-a', session = 'session-a') {
  const source = { path: '/source.png', width: 900, height: 600, fingerprint: `source-${documentId}`, revision: 1 };
  const layer = (layerId, x) => ({ layerId, layerRevision: 1, name: layerId, displayCategory: '主体', processingCategory: 'subject',
    bounds: { x, y: 10, width: 120, height: 100 }, paths: [], requirements: '', strategy: { operation: 'extract', removeBackground: false, repairPaths: [] }, acceptedVersionId: null });
  return { schemaVersion: 2, documentId, workbenchSessionId: session, mode: 'poster', source, revision: 3,
    layers: { one: layer('one', 10), two: layer('two', 200) }, layerOrder: ['one', 'two'], activeLayerId: 'one' };
}

test('submission is idempotent across refresh and no attempt can be claimed before matching visible confirmation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-batch-store-'));
  try {
    const document = documentFixture(); const confirmations = new Map(); const calls = [];
    const store = createBatchStore({ root, getDocument: async () => document,
      readConfirmation: async id => confirmations.get(id),
      prepareItem: async input => { calls.push(input.attempt.attemptId); return { selectedCropPath: path.join(root, 'attempts', input.attempt.attemptId, 'selected-crop.png') }; } });
    const first = await store.submitBatch({ documentId: document.documentId, expectedRevision: document.revision, submissionKey: 'submit-one' });
    const refreshed = await store.submitBatch({ documentId: document.documentId, expectedRevision: document.revision, submissionKey: 'submit-one' });
    assert.equal(first.batchId, refreshed.batchId);
    await assert.rejects(() => store.claimNextBatchItem({ batchId: first.batchId, receipt: null }), /BATCH_CONFIRMATION_REQUIRED/);
    assert.deepEqual(calls, []);
    const confirmation = { status: 'sent', workbenchSessionId: document.workbenchSessionId, envelopeSha256: first.confirmation.envelopeSha256 };
    confirmations.set(first.batchId, confirmation);
    const receipt = { workbenchSessionId: confirmation.workbenchSessionId, envelopeSha256: confirmation.envelopeSha256 };
    const claimed = await store.claimNextBatchItem({ batchId: first.batchId, receipt });
    assert.equal(claimed.attempt.layerId, 'one');
    const blocked = await store.claimNextBatchItem({ batchId: first.batchId, receipt });
    assert.equal(blocked.running, true);
    await store.applyEvent({ batchId: first.batchId, event: { eventId: 'failed-one', attemptId: claimed.attempt.attemptId,
      dispatchId: claimed.attempt.dispatchId, type: 'failed', payload: { code: 'TEST_FAILURE' } } });
    const next = await store.claimNextBatchItem({ batchId: first.batchId, receipt });
    assert.equal(next.attempt.layerId, 'two');
    await store.cancelAttempt({ attemptId: next.attempt.attemptId });
    const late = await store.applyEvent({ batchId: first.batchId, event: { eventId: 'late-two', attemptId: next.attempt.attemptId,
      dispatchId: next.attempt.dispatchId, type: 'suggested', payload: { versionId: 'late-version' } } });
    assert.equal(late.execution, 'cancelled');
    assert.equal(late.lateEvents.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('restart cancels only active attempts bound to the named workbench session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-session-restart-'));
  try {
    const documents = new Map([['doc-a', documentFixture('doc-a', 'session-a')], ['doc-b', documentFixture('doc-b', 'session-b')]]);
    const cancelledConfirmations = [];
    const store = createBatchStore({ root, getDocument: async id => documents.get(id), readConfirmation: async () => null,
      cancelConfirmation: async id => { cancelledConfirmations.push(id); },
      prepareItem: async () => { throw new Error('must not dispatch during restart'); } });
    const batchA = await store.submitBatch({ documentId: 'doc-a', expectedRevision: 3, submissionKey: 'a' });
    const batchB = await store.submitBatch({ documentId: 'doc-b', expectedRevision: 3, submissionKey: 'b' });
    const restarted = await store.restartSession({ workbenchSessionId: 'session-a' });
    assert.equal(restarted.empty, true);
    assert.equal((await store.getAttempt(batchA.items[0].attempt.attemptId)).execution, 'cancelled');
    assert.equal((await store.getAttempt(batchB.items[0].attempt.attemptId)).execution, 'queued');
    assert.ok(cancelledConfirmations.includes(batchA.batchId));
    assert.ok(!cancelledConfirmations.includes(batchB.batchId));
    const history = await store.getBatch(batchA.batchId);
    assert.equal(history.items.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('preparation failure ends only that attempt and lets the caller claim the next item', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v2-prepare-failure-'));
  try {
    const document = documentFixture(); const confirmations = new Map(); let call = 0;
    const store = createBatchStore({ root, getDocument: async () => document, readConfirmation: async id => confirmations.get(id),
      prepareItem: async input => { call++; if (call === 1) throw Object.assign(new Error('source could not be prepared'), { code: 'SOURCE_READ_FAILED' });
        return { selectedCropPath: path.join(root, 'attempts', input.attempt.attemptId, 'selected-crop.png') }; } });
    const batch = await store.submitBatch({ documentId: document.documentId, expectedRevision: document.revision, submissionKey: 'preparation-fails' });
    confirmations.set(batch.batchId, { status: 'sent', workbenchSessionId: document.workbenchSessionId, envelopeSha256: batch.confirmation.envelopeSha256 });
    const receipt = { workbenchSessionId: document.workbenchSessionId, envelopeSha256: batch.confirmation.envelopeSha256 };
    const failed = await store.claimNextBatchItem({ batchId: batch.batchId, receipt });
    assert.equal(failed.preparationFailed, true); assert.equal(failed.attempt.execution, 'failed');
    const next = await store.claimNextBatchItem({ batchId: batch.batchId, receipt });
    assert.equal(next.attempt.layerId, 'two');
  } finally { await rm(root, { recursive: true, force: true }); }
});
