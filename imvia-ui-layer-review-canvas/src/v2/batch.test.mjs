import assert from 'node:assert/strict';
import test from 'node:test';
import { createBatch, applyAttemptEvent, nextQueuedAttempt } from './batch.js';

function documentFixture() {
  const source = { path: '/source.png', width: 900, height: 600, fingerprint: 'source-a', revision: 1 };
  const layer = (layerId, x) => ({ layerId, layerRevision: 1, name: layerId, displayCategory: '主体', processingCategory: 'subject',
    bounds: { x, y: 10, width: 120, height: 100 }, paths: [], requirements: '', strategy: { operation: 'extract', removeBackground: false, repairPaths: [] }, acceptedVersionId: null });
  return { schemaVersion: 2, documentId: 'doc-a', workbenchSessionId: 'session-a', mode: 'poster', source, revision: 3,
    layers: { one: layer('one', 10), two: layer('two', 200) }, layerOrder: ['one', 'two'], activeLayerId: 'one' };
}
const attempt = (layerId, status, overrides = {}) => ({ attemptId: `attempt-${layerId}`, batchId: 'old-batch', documentId: 'doc-a',
  workbenchSessionId: 'session-a', layerId, layerRevision: 1, dispatchId: `dispatch-${layerId}`, authorizationId: `auth-${layerId}`,
  snapshotId: `snapshot-${layerId}`, sourceFingerprint: 'source-a', delivery: 'sent', execution: status, eventIds: [], ...overrides });

test('submission key is idempotent and pending excludes layers already attempted at this revision', () => {
  const document = documentFixture();
  const input = { document, attempts: [attempt('one', 'failed')], submissionKey: 'submit-a', mode: 'pending' };
  const first = createBatch(input); const duplicate = createBatch({ ...input, batchId: first.batchId });
  assert.equal(first.batchId, duplicate.batchId);
  assert.deepEqual(first.items.map(item => item.layerId), ['two']);
});

test('explicit retry creates a fresh attempt while pending never silently retries a failed item', () => {
  const document = documentFixture();
  const previous = attempt('one', 'failed');
  const pending = createBatch({ document, attempts: [previous], submissionKey: 'pending', mode: 'pending', layerIds: ['one'] });
  const retry = createBatch({ document, attempts: [previous], submissionKey: 'retry', mode: 'retry', layerIds: ['one'] });
  assert.deepEqual(pending.items, []);
  assert.equal(retry.items.length, 1);
  assert.notEqual(retry.items[0].attempt.attemptId, previous.attemptId);
  assert.equal(retry.items[0].attempt.execution, 'queued');
});

test('pending omits same-revision active, review, adopted, failed, and cancelled attempts', () => {
  const document = documentFixture();
  const historical = ['running', 'suggested', 'adopted', 'failed', 'cancelled'].map((status, index) =>
    attempt(index % 2 ? 'two' : 'one', status, { attemptId: `history-${status}` }));
  const batch = createBatch({ document, attempts: historical, submissionKey: 'skip-existing', mode: 'pending' });
  assert.equal(batch.items.length, 0);
});

test('attempt events are idempotent and cancellation remains terminal after late events', () => {
  const queued = attempt('one', 'queued', { delivery: 'pending', eventIds: [] });
  const sent = applyAttemptEvent(queued, { eventId: 'e1', attemptId: queued.attemptId, dispatchId: queued.dispatchId, type: 'sent', timestamp: '2026-09-27T00:00:00Z' });
  assert.equal(applyAttemptEvent(sent, { eventId: 'e1', attemptId: queued.attemptId, dispatchId: queued.dispatchId, type: 'sent' }), sent);
  const cancelled = applyAttemptEvent({ ...sent, execution: 'running' }, { eventId: 'e2', attemptId: queued.attemptId, dispatchId: queued.dispatchId, type: 'cancelled' });
  const late = applyAttemptEvent(cancelled, { eventId: 'late', attemptId: queued.attemptId, dispatchId: queued.dispatchId, type: 'suggested' });
  assert.equal(late.execution, 'cancelled');
  assert.equal(late.lateEvents[0].eventId, 'late');
  assert.equal(applyAttemptEvent(cancelled, { eventId: 'wrong', attemptId: 'other', dispatchId: queued.dispatchId, type: 'failed' }), cancelled);
});

test('failure makes the next queued attempt claimable without restarting the failed attempt', () => {
  const failed = attempt('one', 'failed');
  const queued = attempt('two', 'queued', { delivery: 'pending' });
  assert.equal(nextQueuedAttempt([failed, queued]).attemptId, queued.attemptId);
  assert.equal(failed.execution, 'failed');
});

test('late failed or cancelled events cannot regress a candidate already suggested for review', () => {
  const suggested = attempt('one', 'suggested', { eventIds: [] });
  const late = applyAttemptEvent(suggested, { eventId: 'late-failure', attemptId: suggested.attemptId,
    dispatchId: suggested.dispatchId, type: 'failed' });
  assert.equal(late.execution, 'suggested');
  assert.equal(late.lateEvents[0].eventId, 'late-failure');
});
