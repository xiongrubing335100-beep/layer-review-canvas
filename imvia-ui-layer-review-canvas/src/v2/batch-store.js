import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { applyAttemptEvent, createBatch, nextQueuedAttempt, sessionAttemptsToCancel } from './batch.js';
import { idSchema } from './document.js';
import { canonicalJson } from '../poster-plan.js';
import { prepareV2Item } from './execution-adapter.js';

const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

export function createBatchStore({ root, getDocument, readConfirmation, cancelConfirmation, prepareItem = prepareV2Item }) {
  const batchesRoot = path.join(root, 'batches'); const attemptsRoot = path.join(root, 'attempts');
  const batchPath = id => path.join(batchesRoot, `${idSchema.parse(id)}.json`);
  const attemptPath = id => path.join(attemptsRoot, `${idSchema.parse(id)}.json`);
  async function locked(file, fn) {
    const directory = path.dirname(file);
    await mkdir(directory, { recursive: true });
    const release = await lockfile.lock(directory, { realpath: false, retries: { retries: 20, minTimeout: 5, maxTimeout: 50 } });
    try { return await fn(); } finally { await release(); }
  }
  async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
  async function writeJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
    return value;
  }
  async function allAttempts() {
    let names; try { names = await readdir(attemptsRoot); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const name of names.filter(value => value.endsWith('.json'))) records.push(await readJson(path.join(attemptsRoot, name)));
    return records;
  }
  async function allBatches() {
    let names; try { names = await readdir(batchesRoot); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const name of names.filter(value => value.endsWith('.json'))) records.push(await readJson(path.join(batchesRoot, name)));
    return records;
  }
  async function saveAttempt(attempt) { await writeJson(attemptPath(attempt.attemptId), attempt); return attempt; }
  async function saveBatch(batch) { await writeJson(batchPath(batch.batchId), batch); return batch; }

  return {
    async submitBatch({ documentId, expectedRevision, submissionKey, mode = 'pending', layerIds = null }) {
      idSchema.parse(documentId);
      const document = await getDocument(documentId);
      if (document.revision !== expectedRevision) throw Object.assign(new Error('REVISION_CONFLICT'), { code: 'REVISION_CONFLICT' });
      const proposed = createBatch({ document, attempts: await allAttempts(), submissionKey, mode, layerIds });
      return locked(batchPath(proposed.batchId), async () => {
        try { return await readJson(batchPath(proposed.batchId)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const manifestPath = path.join(batchesRoot, `${proposed.batchId}.json`);
        const envelope = { mode: 'layer_batch', workbenchSessionId: document.workbenchSessionId, documentId,
          documentRevision: document.revision, sourceFingerprint: document.source.fingerprint,
          manifestPath,
          itemCount: proposed.items.length, items: proposed.items.map(item => ({ layerId: item.layerId,
            layerRevision: item.layerRevision, snapshotId: item.snapshot.snapshotId, attemptId: item.attempt.attemptId })) };
        const batch = { ...proposed, outputRoot: path.resolve(root), manifestPath,
          confirmation: { envelope, envelopeSha256: digest(envelope), status: 'pending', requestId: proposed.batchId },
          items: proposed.items.map((item, index) => ({ ...item, ordinal: index, status: 'queued', manifestPath: null })) };
        await Promise.all(batch.items.map(item => saveAttempt(item.attempt)));
        return saveBatch(batch);
      });
    },
    getBatch(id) { return readJson(batchPath(id)); },
    async listSessionBatches(workbenchSessionId) {
      idSchema.parse(workbenchSessionId);
      return (await allBatches()).filter(batch => batch.workbenchSessionId === workbenchSessionId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    getAttempt(id) { return readJson(attemptPath(id)); },
    async listDocumentAttempts(documentId) {
      idSchema.parse(documentId);
      return (await allAttempts()).filter(attempt => attempt.documentId === documentId);
    },
    async cancelBatch(id) {
      const batch = await readJson(batchPath(id));
      const attempts = [];
      for (const item of batch.items) attempts.push(await this.cancelAttempt({ attemptId: item.attempt.attemptId }));
      await cancelConfirmation?.(id);
      return { batchId: id, attempts };
    },
    async claimNextBatchItem({ batchId, receipt }) {
      return locked(batchPath(batchId), async () => {
        const batch = await readJson(batchPath(batchId));
        const confirmation = await readConfirmation?.(batchId);
        if (!confirmation || confirmation.status !== 'sent' || confirmation.workbenchSessionId !== batch.workbenchSessionId
          || confirmation.envelopeSha256 !== batch.confirmation.envelopeSha256 || !receipt
          || receipt.workbenchSessionId !== batch.workbenchSessionId || receipt.envelopeSha256 !== batch.confirmation.envelopeSha256) throw new Error('BATCH_CONFIRMATION_REQUIRED');
        batch.confirmation = { ...batch.confirmation, status: 'sent', confirmedAt: confirmation.confirmedAt || new Date().toISOString() };
        const attempts = await Promise.all(batch.items.map(item => readJson(attemptPath(item.attempt.attemptId))));
        if (attempts.some(item => item.execution === 'running')) { await saveBatch(batch); return { running: true, attemptId: attempts.find(item => item.execution === 'running').attemptId }; }
        const attempt = nextQueuedAttempt(attempts);
        if (!attempt) { batch.status = 'complete'; await saveBatch(batch); return { done: true, batch }; }
        const item = batch.items.find(value => value.attempt.attemptId === attempt.attemptId);
        let manifest;
        try {
          const document = await getDocument(batch.documentId);
          if (document.source.fingerprint !== attempt.sourceFingerprint) throw new Error('BATCH_SOURCE_CHANGED');
          manifest = await prepareItem({ document, snapshot: item.snapshot, attempt, outputRoot: batch.outputRoot });
        }
        catch (cause) {
          const failed = applyAttemptEvent(attempt, { eventId: randomUUID().replaceAll('-', ''), attemptId: attempt.attemptId,
            dispatchId: attempt.dispatchId, type: 'failed', payload: { code: cause.code || 'PREPARATION_FAILED', message: cause.message || String(cause) } });
          await saveAttempt(failed); item.attempt = failed; item.status = 'failed';
          const remaining = await Promise.all(batch.items.map(value => readJson(attemptPath(value.attempt.attemptId))));
          if (remaining.every(value => ['suggested', 'failed', 'cancelled'].includes(value.execution))) batch.status = 'complete';
          else batch.status = 'ready';
          await saveBatch(batch);
          return { done: false, preparationFailed: true, batchId: batch.batchId, attempt: failed, error: failed.error };
        }
        const running = applyAttemptEvent(attempt, { eventId: randomUUID().replaceAll('-', ''), attemptId: attempt.attemptId,
          dispatchId: attempt.dispatchId, type: 'running' });
        await saveAttempt(running);
        item.status = 'running'; item.manifestPath = path.join(path.dirname(manifest.selectedCropPath), 'manifest.json');
        batch.status = 'running'; await saveBatch(batch);
        return { done: false, manifest, batchId: batch.batchId, attempt: running };
      });
    },
    async applyEvent({ batchId, event }) {
      return locked(batchPath(batchId), async () => {
        const batch = await readJson(batchPath(batchId));
        const item = batch.items.find(value => value.attempt.attemptId === event.attemptId);
        if (!item) throw new Error('ATTEMPT_NOT_IN_BATCH');
        const previous = await readJson(attemptPath(event.attemptId));
        const next = applyAttemptEvent(previous, event);
        if (next !== previous) { await saveAttempt(next); item.attempt = next; item.status = next.execution; }
        const attempts = await Promise.all(batch.items.map(value => readJson(attemptPath(value.attempt.attemptId))));
        if (attempts.length && attempts.every(value => ['suggested', 'failed', 'cancelled'].includes(value.execution))) batch.status = 'complete';
        else if (!attempts.some(value => value.execution === 'running') && attempts.some(value => value.execution === 'queued')) batch.status = 'ready';
        await saveBatch(batch);
        return next;
      });
    },
    async cancelAttempt({ attemptId }) {
      const attempt = await readJson(attemptPath(attemptId));
      return locked(batchPath(attempt.batchId), async () => {
        const current = await readJson(attemptPath(attemptId));
        if (['suggested', 'failed', 'cancelled'].includes(current.execution)) return current;
        const next = applyAttemptEvent(current, { eventId: randomUUID().replaceAll('-', ''), attemptId,
          dispatchId: current.dispatchId, type: 'cancelled' });
        await saveAttempt(next);
        const batch = await readJson(batchPath(current.batchId));
        const item = batch.items.find(value => value.attempt.attemptId === attemptId); item.attempt = next; item.status = 'cancelled';
        const all = await Promise.all(batch.items.map(value => readJson(attemptPath(value.attempt.attemptId))));
        if (all.every(value => ['suggested', 'failed', 'cancelled'].includes(value.execution))) batch.status = 'complete';
        await saveBatch(batch); return next;
      });
    },
    async restartSession({ workbenchSessionId }) {
      idSchema.parse(workbenchSessionId);
      const attempts = sessionAttemptsToCancel(await allAttempts(), workbenchSessionId);
      const cancelledAttemptIds = [];
      for (const attempt of attempts) { await this.cancelAttempt({ attemptId: attempt.attemptId }); cancelledAttemptIds.push(attempt.attemptId); }
      const batches = await allBatches();
      for (const batch of batches.filter(value => value.workbenchSessionId === workbenchSessionId)) await cancelConfirmation?.(batch.batchId);
      return { cancelledAttemptIds, empty: true };
    },
  };
}
