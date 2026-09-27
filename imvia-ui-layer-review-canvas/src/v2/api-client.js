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
    async createDocument({ mode, file, workbenchSessionId }) {
      const bytes = file instanceof Blob ? file : new Blob([file], { type: 'image/png' });
      const response = await request(fetchImpl, '/api/workbench-v2/documents', { method: 'POST',
        headers: { 'Content-Type': 'image/png', 'X-Workbench-Mode': mode, 'X-Workbench-Session': workbenchSessionId }, body: bytes });
      return response.json();
    },
    async getDocument(id) { return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(id)}`)).json(); },
    async saveDocument(document, expectedRevision) {
      return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(document.documentId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document, expectedRevision }),
      })).json();
    },
    async submitBatch({ documentId, expectedRevision, submissionKey, mode = 'pending', layerIds = null }) {
      return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/batches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision, submissionKey, mode, layerIds }),
      })).json();
    },
    async getBatch(batchId) { return (await request(fetchImpl, `/api/workbench-v2/batches/${encodeURIComponent(batchId)}`)).json(); },
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
    async adoptCandidate(documentId, layerId, versionId, expectedRevision) {
      return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/layers/${encodeURIComponent(layerId)}/adopt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId, expectedRevision }),
      })).json();
    },
    async getComposition(documentId) {
      return (await request(fetchImpl, `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/composition`)).json();
    },
    candidateUrl(documentId, layerId, versionId) {
      return `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/layers/${encodeURIComponent(layerId)}/versions/${encodeURIComponent(versionId)}/png`;
    },
    sourceUrl(id) { return `/api/workbench-v2/documents/${encodeURIComponent(id)}/source`; },
  };
}
