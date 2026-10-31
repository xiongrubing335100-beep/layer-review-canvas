const DOCUMENT_KEY = 'imvia-layer-v2-document';
const SESSION_KEY = 'imvia-layer-v2-session';
const WORKSPACE_KEY = 'imvia-layer-v2-workspace';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

export function readPageIdentity(href, storage) {
  const url = new URL(href);
  const fromUrl = url.searchParams.get('documentId');
  if (fromUrl !== null && !validId(fromUrl)) throw new Error('无效的文档链接');
  const workspace = url.searchParams.get('workspaceId');
  const workspaceId = validId(workspace) ? workspace : crypto.randomUUID().replaceAll('-', '');
  const session = url.searchParams.get('workbenchSessionId');
  const workbenchSessionId = validId(session) ? session : crypto.randomUUID().replaceAll('-', '');
  return { documentId: fromUrl, workspaceId, workbenchSessionId };
}

export function persistPageIdentity(href, storage, document, workspaceId, sessionId) {
  const url = new URL(href);
  url.searchParams.set('workbench', 'v2');
  url.searchParams.set('workspaceId', workspaceId);
  const session = document?.workbenchSessionId || sessionId || url.searchParams.get('workbenchSessionId');
  if (validId(session)) url.searchParams.set('workbenchSessionId', session);
  if (document) url.searchParams.set('documentId', document.documentId);
  else url.searchParams.delete('documentId');
  try {
    storage?.setItem(WORKSPACE_KEY, workspaceId);
    if (document) {
      storage?.setItem(DOCUMENT_KEY, document.documentId);
    } else storage?.removeItem(DOCUMENT_KEY);
    if (validId(session)) storage?.setItem(SESSION_KEY, session);
  } catch { /* URL remains usable if storage is disabled */ }
  return url.href;
}
