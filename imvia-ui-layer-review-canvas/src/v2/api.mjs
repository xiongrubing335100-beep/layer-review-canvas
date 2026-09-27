import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createDocumentStore } from './document-store.js';
import { createDocument, validateDocument, idSchema } from './document.js';
import { readPosterPngBytes } from '../poster-png.js';
import { createBatchStore } from './batch-store.js';
import { createBridgeRequestStore } from './bridge-request-store.js';
import { buildBatchPrompt } from './batch-bridge.js';
import { listV2CandidateVersions, readV2CandidatePng } from './candidate-store.js';
import { candidateState, getCompositionLayers } from './candidate-review.js';
import { createExportStore } from './export-store.js';

function error(code, message = code) { return Object.assign(new Error(message), { code }); }

export function createWorkbenchV2Api({ root, batchStore: providedBatchStore = null, bridgeStore: providedBridgeStore = null, exportStore: providedExportStore = null }) {
  const documentsRoot = path.resolve(root);
  const runtimeRoot = path.dirname(documentsRoot);
  const store = createDocumentStore({ root: documentsRoot });
  const bridgeStore = providedBridgeStore || createBridgeRequestStore({ root: path.join(runtimeRoot, 'bridge-requests') });
  const cancelConfirmation = async id => {
    const record = await bridgeStore.read(id);
    if (['pending', 'claimed'].includes(record.status)) {
      try { return await bridgeStore.transition({ requestId: id, expectedStatus: record.status, nextStatus: 'cancelled' }); }
      catch (cause) { const current = await bridgeStore.read(id); if (!['sent', 'cancelled'].includes(current.status)) throw cause; return current; }
    }
    return record;
  };
  const batches = providedBatchStore || createBatchStore({ root: runtimeRoot, getDocument: id => store.read(id),
    readConfirmation: id => bridgeStore.read(id), cancelConfirmation });
  const exports = providedExportStore || createExportStore({ root: runtimeRoot });
  const candidateVersions = async (documentId, layerId = null) => {
    const document = await store.read(idSchema.parse(documentId));
    if (layerId && !document.layerOrder.includes(idSchema.parse(layerId))) throw error('INACTIVE_LAYER');
    const attempts = await batches.listDocumentAttempts(documentId);
    const versions = await listV2CandidateVersions({ root: runtimeRoot, attempts, documentId, layerId });
    return { document, attempts, versions };
  };
  const publicVersion = version => {
    const { pngPath, rawPath, reviewReportPath, pixelAuditPath, ...safe } = version;
    return safe;
  };
  return {
    async createDocument({ mode, bytes, workbenchSessionId }) {
      if (!['poster', 'h5'].includes(mode)) throw error('INVALID_MODE');
      idSchema.parse(workbenchSessionId);
      const png = Buffer.from(bytes);
      const decoded = readPosterPngBytes(png, 'source');
      const documentId = randomUUID().replaceAll('-', '');
      const sourcePath = path.join(documentsRoot, documentId, 'source.png');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, png, { flag: 'wx' });
      const source = { path: sourcePath, width: decoded.width, height: decoded.height,
        fingerprint: createHash('sha256').update(png).digest('hex'), revision: 1 };
      try { return await store.create(createDocument({ documentId, workbenchSessionId, mode, source })); }
      catch (cause) { await rm(sourcePath, { force: true }); throw cause; }
    },
    getDocument(id) { return store.read(idSchema.parse(id)); },
    async submitBatch(input) {
      const batch = await batches.submitBatch(input);
      if (batch.items.length === 0) return { batch, confirmation: null, prompt: null };
      let confirmation = await bridgeStore.create({ batchId: batch.batchId, envelope: batch.confirmation.envelope });
      if (confirmation.status === 'pending') confirmation = await bridgeStore.transition({ requestId: batch.batchId, expectedStatus: 'pending', nextStatus: 'claimed' });
      return { batch, confirmation, prompt: buildBatchPrompt(confirmation) };
    },
    getBatch(id) { return batches.getBatch(id); },
    async getBatchSubmission(id) {
      const batch = await batches.getBatch(id);
      const confirmation = await bridgeStore.read(id);
      return { batch, confirmation, prompt: confirmation.status === 'pending' ? buildBatchPrompt(confirmation) : null };
    },
    async listSessionBatches(workbenchSessionId) {
      const records = await batches.listSessionBatches(workbenchSessionId);
      return Promise.all(records.map(async batch => {
        try { return { ...batch, confirmation: { ...batch.confirmation, ...(await bridgeStore.read(batch.batchId)) } }; }
        catch { return batch; }
      }));
    },
    getConfirmation(id) { return bridgeStore.read(id); },
    getAttempt(id) { return batches.getAttempt(id); },
    claimNextBatchItem(input) { return batches.claimNextBatchItem(input); },
    cancelAttempt(input) { return batches.cancelAttempt(input); },
    cancelBatch(id) { return batches.cancelBatch(id); },
    restartSession(input) { return batches.restartSession(input); },
    applyAttemptEvent(input) { return batches.applyEvent(input); },
    async listLayerVersions({ documentId, layerId }) {
      const { document, attempts, versions } = await candidateVersions(documentId, layerId);
      return { versions: versions.map(publicVersion), state: candidateState(document, layerId, versions, attempts),
        attempts: attempts.filter(attempt => attempt.layerId === layerId).map(({ attemptId, layerRevision, sourceFingerprint, execution, error: failure }) => ({ attemptId, layerRevision, sourceFingerprint, execution, error: failure })) };
    },
    async adoptCandidate({ documentId, expectedRevision, layerId, versionId }) {
      const { document, versions } = await candidateVersions(documentId, layerId);
      if (document.revision !== expectedRevision) throw error('REVISION_CONFLICT');
      const state = candidateState(document, layerId, versions, []);
      if (!state.versionIds.includes(versionId)) throw error('CANDIDATE_NOT_CURRENT');
      if (document.layers[layerId].acceptedVersionId === versionId) return document;
      const next = { ...document, revision: document.revision + 1,
        layers: { ...document.layers, [layerId]: { ...document.layers[layerId], acceptedVersionId: versionId } } };
      return store.update({ documentId, expectedRevision, document: next });
    },
    async getComposition(documentId) {
      const { document, versions } = await candidateVersions(documentId);
      return { documentId, documentRevision: document.revision, width: document.source.width, height: document.source.height,
        layers: getCompositionLayers(document, versions).map(layer => {
          const { pngPath, ...safe } = layer;
          return { ...safe, pngUrl: `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/layers/${encodeURIComponent(layer.layerId)}/versions/${encodeURIComponent(layer.versionId)}/png` };
        }) };
    },
    async readCandidatePng({ documentId, layerId, versionId }) {
      const { document, attempts } = await candidateVersions(documentId, layerId);
      return (await readV2CandidatePng({ root: runtimeRoot, attempts, documentId: document.documentId, layerId, versionId })).bytes;
    },
    async exportDocumentPsd({ documentId, expectedRevision }) {
      const { document, versions } = await candidateVersions(documentId);
      if (document.revision !== expectedRevision) throw error('REVISION_CONFLICT');
      return exports.exportDocumentPsd({ document, versions, expectedRevision });
    },
    async listExports(documentId) {
      const document = await store.read(idSchema.parse(documentId));
      return { exports: await exports.list(documentId, document.revision) };
    },
    async readExportPsd({ documentId, exportId }) { return exports.readPsd(idSchema.parse(documentId), idSchema.parse(exportId)); },
    saveDocument(document, expectedRevision) {
      return store.update({ documentId: document.documentId, expectedRevision, document: validateDocument(document) });
    },
    async readSource(id) {
      const document = await store.read(idSchema.parse(id));
      return readFile(document.source.path);
    },
  };
}

async function readBody(request, maximum = 32 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maximum) throw error('BODY_TOO_LARGE'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export function workbenchV2Middleware({ root }) {
  const api = createWorkbenchV2Api({ root });
  return async (request, response, next) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/workbench-v2/')) { next(); return; }
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Workbench-Mode, X-Workbench-Session');
    if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return; }
    try {
      let result; let status = 200;
      if (url.pathname === '/api/workbench-v2/documents' && request.method === 'POST') {
        if (String(request.headers['content-type'] || '').split(';')[0] !== 'image/png') throw error('INVALID_IMAGE_TYPE');
        result = await api.createDocument({ mode: request.headers['x-workbench-mode'],
          workbenchSessionId: request.headers['x-workbench-session'], bytes: await readBody(request) }); status = 201;
      } else {
        const submitBatch = url.pathname.match(/^\/api\/workbench-v2\/documents\/([A-Za-z0-9_-]+)\/batches$/);
        const batchMatch = url.pathname.match(/^\/api\/workbench-v2\/batches\/([A-Za-z0-9_-]+)$/);
        const confirmationMatch = url.pathname.match(/^\/api\/workbench-v2\/batches\/([A-Za-z0-9_-]+)\/confirmation$/);
        const batchSubmissionMatch = url.pathname.match(/^\/api\/workbench-v2\/batches\/([A-Za-z0-9_-]+)\/submission$/);
        const batchCancelMatch = url.pathname.match(/^\/api\/workbench-v2\/batches\/([A-Za-z0-9_-]+)\/cancel$/);
        const claimMatch = url.pathname.match(/^\/api\/workbench-v2\/batches\/([A-Za-z0-9_-]+)\/claim-next$/);
        const cancelMatch = url.pathname.match(/^\/api\/workbench-v2\/attempts\/([A-Za-z0-9_-]+)\/cancel$/);
        const attemptMatch = url.pathname.match(/^\/api\/workbench-v2\/attempts\/([A-Za-z0-9_-]+)$/);
        const eventMatch = url.pathname.match(/^\/api\/workbench-v2\/batches\/([A-Za-z0-9_-]+)\/events$/);
        const restartMatch = url.pathname.match(/^\/api\/workbench-v2\/sessions\/([A-Za-z0-9_-]+)\/restart$/);
        const sessionBatchesMatch = url.pathname.match(/^\/api\/workbench-v2\/sessions\/([A-Za-z0-9_-]+)\/batches$/);
        const layerVersionsMatch = url.pathname.match(/^\/api\/workbench-v2\/documents\/([A-Za-z0-9_-]+)\/layers\/([A-Za-z0-9_-]+)\/versions$/);
        const adoptCandidateMatch = url.pathname.match(/^\/api\/workbench-v2\/documents\/([A-Za-z0-9_-]+)\/layers\/([A-Za-z0-9_-]+)\/adopt$/);
        const compositionMatch = url.pathname.match(/^\/api\/workbench-v2\/documents\/([A-Za-z0-9_-]+)\/composition$/);
        const candidatePngMatch = url.pathname.match(/^\/api\/workbench-v2\/documents\/([A-Za-z0-9_-]+)\/layers\/([A-Za-z0-9_-]+)\/versions\/([A-Za-z0-9_-]+)\/png$/);
        const createExportMatch = url.pathname.match(/^\/api\/workbench-v2\/documents\/([A-Za-z0-9_-]+)\/exports$/);
        const exportDownloadMatch = url.pathname.match(/^\/api\/workbench-v2\/documents\/([A-Za-z0-9_-]+)\/exports\/([A-Za-z0-9_-]+)\/download$/);
        if (submitBatch && request.method === 'POST') {
          const payload = JSON.parse((await readBody(request)).toString('utf8'));
          result = await api.submitBatch({ ...payload, documentId: submitBatch[1] }); status = 202;
        } else if (batchSubmissionMatch && request.method === 'GET') result = await api.getBatchSubmission(batchSubmissionMatch[1]);
        else if (confirmationMatch && request.method === 'GET') result = await api.getConfirmation(confirmationMatch[1]);
        else if (batchCancelMatch && request.method === 'POST') result = await api.cancelBatch(batchCancelMatch[1]);
        else if (sessionBatchesMatch && request.method === 'GET') result = await api.listSessionBatches(sessionBatchesMatch[1]);
        else if (batchMatch && request.method === 'GET') result = await api.getBatch(batchMatch[1]);
        else if (layerVersionsMatch && request.method === 'GET') result = await api.listLayerVersions({ documentId: layerVersionsMatch[1], layerId: layerVersionsMatch[2] });
        else if (adoptCandidateMatch && request.method === 'POST') {
          const payload = JSON.parse((await readBody(request)).toString('utf8'));
          result = await api.adoptCandidate({ ...payload, documentId: adoptCandidateMatch[1], layerId: adoptCandidateMatch[2] });
        } else if (compositionMatch && request.method === 'GET') result = await api.getComposition(compositionMatch[1]);
        else if (candidatePngMatch && request.method === 'GET') {
          const bytes = await api.readCandidatePng({ documentId: candidatePngMatch[1], layerId: candidatePngMatch[2], versionId: candidatePngMatch[3] });
          response.setHeader('Content-Type', 'image/png'); response.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); response.end(bytes); return;
        } else if (createExportMatch && request.method === 'POST') {
          const payload = JSON.parse((await readBody(request)).toString('utf8'));
          result = await api.exportDocumentPsd({ documentId: createExportMatch[1], expectedRevision: payload.expectedRevision }); status = 201;
        } else if (createExportMatch && request.method === 'GET') result = await api.listExports(createExportMatch[1]);
        else if (exportDownloadMatch && request.method === 'GET') {
          const { record, bytes } = await api.readExportPsd({ documentId: exportDownloadMatch[1], exportId: exportDownloadMatch[2] });
          response.setHeader('Content-Type', 'image/vnd.adobe.photoshop');
          response.setHeader('Content-Disposition', `attachment; filename="${record.exportId}.psd"`);
          response.setHeader('Cache-Control', 'private, no-store'); response.end(bytes); return;
        } else if (claimMatch && request.method === 'POST') {
          const payload = JSON.parse((await readBody(request)).toString('utf8'));
          result = await api.claimNextBatchItem({ ...payload, batchId: claimMatch[1] });
        } else if (cancelMatch && request.method === 'POST') result = await api.cancelAttempt({ attemptId: cancelMatch[1] });
        else if (attemptMatch && request.method === 'GET') result = await api.getAttempt(attemptMatch[1]);
        else if (eventMatch && request.method === 'POST') {
          const payload = JSON.parse((await readBody(request)).toString('utf8'));
          result = await api.applyAttemptEvent({ batchId: eventMatch[1], event: payload.event });
        } else if (restartMatch && request.method === 'POST') result = await api.restartSession({ workbenchSessionId: restartMatch[1] });
        else {
        const source = url.pathname.match(/^\/api\/workbench-v2\/documents\/([A-Za-z0-9_-]+)\/source$/);
        const document = url.pathname.match(/^\/api\/workbench-v2\/documents\/([A-Za-z0-9_-]+)$/);
        if (source && request.method === 'GET') {
          const bytes = await api.readSource(source[1]); response.setHeader('Content-Type', 'image/png'); response.setHeader('Cache-Control', 'private, max-age=3600'); response.end(bytes); return;
        }
        if (!document) throw error('NOT_FOUND');
        if (request.method === 'GET') result = await api.getDocument(document[1]);
        else if (request.method === 'PUT') {
          const payload = JSON.parse((await readBody(request)).toString('utf8'));
          result = await api.saveDocument(payload.document, Number(payload.expectedRevision));
        } else throw error('METHOD_NOT_ALLOWED');
        }
      }
      response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(result));
    } catch (cause) {
      response.statusCode = cause.code === 'REVISION_CONFLICT' ? 409 : ['NOT_FOUND','CANDIDATE_NOT_FOUND','EXPORT_NOT_FOUND'].includes(cause.code) ? 404 : cause.code === 'METHOD_NOT_ALLOWED' ? 405 : 400;
      response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify({ error: cause.code || 'INVALID_REQUEST', message: cause.message }));
    }
  };
}
