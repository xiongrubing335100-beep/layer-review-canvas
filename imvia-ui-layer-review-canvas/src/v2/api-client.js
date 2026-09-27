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
    sourceUrl(id) { return `/api/workbench-v2/documents/${encodeURIComponent(id)}/source`; },
  };
}
