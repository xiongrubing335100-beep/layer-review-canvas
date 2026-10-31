async function request(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const failure = new Error(body.message || body.error || `HTTP ${response.status}`);
    failure.status = response.status; failure.code = body.error;
    throw failure;
  }
  return response;
}

export function createWorkbenchV2Client(fetchImpl = fetch) {
  return {
    async getBridgeStatus(documentId, workspaceId) { return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/bridge${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`, { signal: AbortSignal.timeout(8000), cache: 'no-store' })).json(); },
    async registerBridgeWorkspace(documentId, workspaceId) { return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/bridge/workspace`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({workspaceId}), signal:AbortSignal.timeout(8000) })).json(); },
    async reconnectBridge(documentId, workspaceId, { automatic = false } = {}) { return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/bridge`, { method: 'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({workspaceId,automatic}), signal: AbortSignal.timeout(8000) })).json(); },
    async createDocument({ mode, file, workbenchSessionId }) {
      const bytes = file instanceof Blob ? file : new Blob([file], { type: 'image/png' });
      const response = await request(fetchImpl, '/api/workbench-v2/documents', { method: 'POST',
        headers: { 'Content-Type': 'image/png', 'X-Workbench-Mode': mode, 'X-Workbench-Session': workbenchSessionId }, body: bytes });
      return response.json();
    },
    async getDocument(id) { return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10000), cache: 'no-store' })).json(); },
    async replaceSource(documentId, file, expectedRevision) {
      return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/source?expectedRevision=${encodeURIComponent(expectedRevision)}`, {
        method: 'PUT', headers: { 'Content-Type': 'image/png' },
        body: file instanceof Blob ? file : new Blob([file], { type: 'image/png' }),
      })).json();
    },
    async saveDocument(document, expectedRevision) {
      return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(document.documentId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document, expectedRevision }), signal: AbortSignal.timeout(10000),
      })).json();
    },
    async submitBatch({ documentId, expectedRevision, submissionKey, mode = 'pending', layerIds = null }) {
      return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/batches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision, submissionKey, mode, layerIds }),
      })).json();
    },
    async getBatch(batchId) { return (await request(fetchImpl, `/api/workbench-v2/batches/${encodeURIComponent(batchId)}`)).json(); },
    async queueRelay(batchId, workspaceId) { return (await request(fetchImpl, `/api/workbench-v2/batches/${encodeURIComponent(batchId)}/relay`, { method: 'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspaceId}),signal:AbortSignal.timeout(10000) })).json(); },
    async getBatchSubmission(batchId) { return (await request(fetchImpl, `/api/workbench-v2/batches/${encodeURIComponent(batchId)}/submission`)).json(); },
    async getSessionBatches(workbenchSessionId) { return (await request(fetchImpl, `/api/workbench-v2/sessions/${encodeURIComponent(workbenchSessionId)}/batches`)).json(); },
    async getBatchConfirmation(batchId) { return (await request(fetchImpl, `/api/workbench-v2/batches/${encodeURIComponent(batchId)}/confirmation`)).json(); },
    async cancelBatch(batchId) { return (await request(fetchImpl, `/api/workbench-v2/batches/${encodeURIComponent(batchId)}/cancel`, { method: 'POST' })).json(); },
    async getAttempt(attemptId) { return (await request(fetchImpl, `/api/workbench-v2/attempts/${encodeURIComponent(attemptId)}`)).json(); },
    async claimNextBatchItem(batchId, receipt) {
      return (await request(fetchImpl, `/api/workbench-v2/batches/${encodeURIComponent(batchId)}/claim-next`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receipt }),
      })).json();
    },
    async cancelAttempt(attemptId) {
      return (await request(fetchImpl, `/api/workbench-v2/attempts/${encodeURIComponent(attemptId)}/cancel`, { method: 'POST' })).json();
    },
    async restartSession(workbenchSessionId) {
      return (await request(fetchImpl, `/api/workbench-v2/sessions/${encodeURIComponent(workbenchSessionId)}/restart`, { method: 'POST' })).json();
    },
    async recordAttemptEvent(batchId, event) {
      return (await request(fetchImpl, `/api/workbench-v2/batches/${encodeURIComponent(batchId)}/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event }),
      })).json();
    },
    async getLayerVersions(documentId, layerId) {
      return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/layers/${encodeURIComponent(layerId)}/versions`)).json();
    },
    async revalidateCandidates(documentId, { layerId = null, retry = false } = {}) {
      return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/revalidate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layerId, retry }),
      })).json();
    },
    async adoptCandidate(documentId, layerId, versionId, expectedRevision) {
      return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/layers/${encodeURIComponent(layerId)}/adopt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId, expectedRevision }),
      })).json();
    },
    async getComposition(documentId) {
      return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/composition`, { signal: AbortSignal.timeout(8000), cache: 'no-store' })).json();
    },
    async exportDocumentPsd(documentId, expectedRevision) {
      return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/exports`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision }),
      })).json();
    },
    async getExports(documentId) {
      return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/exports`)).json();
    },
    exportUrl(documentId, exportId) {
      return `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/exports/${encodeURIComponent(exportId)}/download`;
    },
    candidateUrl(documentId, layerId, versionId) {
      return `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/layers/${encodeURIComponent(layerId)}/versions/${encodeURIComponent(versionId)}/png`;
    },
    sourceUrl(id, revision = 1) { return `/api/workbench-v2/documents/${encodeURIComponent(id)}/source?revision=${encodeURIComponent(revision)}`; },
  };
}
