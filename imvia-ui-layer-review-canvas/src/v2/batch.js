import { createHash } from 'node:crypto';
import { freezeLayer } from './document.js';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const compactId = value => hash(value).slice(0, 32);
const terminal = new Set(['suggested', 'failed', 'cancelled']);

/** Freeze a submission into ordered, source-coordinate snapshots. */
export function createBatch({ document, attempts = [], submissionKey, mode = 'pending', layerIds = null, batchId = null }) {
  if (!document?.documentId || !document?.workbenchSessionId || !submissionKey || !['pending', 'retry'].includes(mode)) throw new Error('INVALID_BATCH_REQUEST');
  const selected = layerIds == null ? document.layerOrder : layerIds;
  if (mode === 'retry' && (!Array.isArray(layerIds) || layerIds.length === 0)) throw new Error('RETRY_REQUIRES_EXPLICIT_LAYERS');
  if (!Array.isArray(selected) || selected.some(id => !document.layerOrder.includes(id)) || new Set(selected).size !== selected.length) throw new Error('INVALID_BATCH_LAYERS');
  const stableBatchId = batchId || compactId(`${document.documentId}:${submissionKey}`);
  const items = [];
  for (const layerId of document.layerOrder.filter(id => selected.includes(id))) {
    const layer = document.layers[layerId];
    const prior = attempts.some(item => item.documentId === document.documentId && item.layerId === layerId
      && item.layerRevision === layer.layerRevision && item.sourceFingerprint === document.source.fingerprint);
    if (mode === 'pending' && prior) continue;
    const attemptId = compactId(`${stableBatchId}:${layerId}:${layer.layerRevision}`);
    const snapshot = freezeLayer(document, layerId);
    const attempt = { attemptId, batchId: stableBatchId, documentId: document.documentId, workbenchSessionId: document.workbenchSessionId,
      layerId, layerRevision: layer.layerRevision, dispatchId: compactId(`${attemptId}:dispatch`),
      authorizationId: compactId(`${attemptId}:authorization`), snapshotId: snapshot.snapshotId,
      sourceFingerprint: document.source.fingerprint, delivery: 'pending', execution: 'queued', eventIds: [], lateEvents: [] };
    items.push({ layerId, layerRevision: layer.layerRevision, snapshot, attempt });
  }
  return { batchId: stableBatchId, submissionKey, mode, documentId: document.documentId, workbenchSessionId: document.workbenchSessionId,
    documentRevision: document.revision, sourceFingerprint: document.source.fingerprint, status: 'queued', items, createdAt: new Date().toISOString() };
}

/** Apply a single attempt-bound event. Cancellation and failure cannot be undone. */
export function applyAttemptEvent(attempt, event) {
  if (!attempt || !event || event.attemptId !== attempt.attemptId || event.dispatchId !== attempt.dispatchId
    || typeof event.eventId !== 'string' || !event.eventId) return attempt;
  if (attempt.eventIds?.includes(event.eventId)) return attempt;
  const eventIds = [...(attempt.eventIds || []), event.eventId];
  if (terminal.has(attempt.execution)) {
    return { ...attempt, eventIds, lateEvents: [...(attempt.lateEvents || []), { ...event, receivedAt: new Date().toISOString() }] };
  }
  const next = { ...attempt, eventIds };
  switch (event.type) {
    case 'sent': next.delivery = 'sent'; break;
    case 'running': if (attempt.execution === 'queued') next.execution = 'running'; break;
    case 'suggested': next.execution = 'suggested'; next.candidateVersionId = event.payload?.versionId || null; break;
    case 'failed': next.execution = 'failed'; next.error = event.payload || { code: 'GENERATION_FAILED' }; break;
    case 'cancelled': next.execution = 'cancelled'; break;
    default: return attempt;
  }
  return next;
}

export function nextQueuedAttempt(attempts) {
  return attempts.find(attempt => attempt.execution === 'queued') || null;
}

export function sessionAttemptsToCancel(attempts, workbenchSessionId) {
  return attempts.filter(attempt => attempt.workbenchSessionId === workbenchSessionId
    && !terminal.has(attempt.execution) && attempt.execution !== 'adopted');
}
