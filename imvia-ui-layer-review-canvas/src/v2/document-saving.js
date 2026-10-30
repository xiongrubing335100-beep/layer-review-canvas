import { validateDocument } from './document.js';
import { canonicalJson } from '../poster-plan.js';

const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const identity = value => [value.documentId, value.workbenchSessionId, value.mode, value.source];

// Reconcile the durable local outbox with the server. A lost response is not a
// lost edit, but another window's divergent revision must never be overwritten.
export function recoverPendingSaves(serverInput, pending) {
  const server = validateDocument(serverInput);
  if (!Array.isArray(pending)) throw new Error('SAVE_CONFLICT: invalid pending edits');
  const queue = pending.map(value => validateDocument(value));
  if (!queue.length) return { document: server, queue: [] };
  if (queue.some((value, index) => !same(identity(value), identity(server))
    || (index > 0 && value.revision !== queue[index - 1].revision + 1))) {
    throw new Error('SAVE_CONFLICT: pending document identity or revision changed');
  }
  if (server.revision >= queue[0].revision) {
    const committed = queue.find(value => value.revision === server.revision);
    if (!committed || !same(committed, server)) throw new Error('SAVE_CONFLICT: server has different edits');
  } else if (server.revision !== queue[0].revision - 1) {
    throw new Error('SAVE_CONFLICT: missing document revision');
  }
  return { document: queue.at(-1), queue: queue.filter(value => value.revision > server.revision) };
}

export async function saveDocumentRevision(api, next) {
  try {
    const saved = await api.saveDocument(next, next.revision - 1);
    if (!same(saved, next)) throw new Error('SAVE_RESPONSE_MISMATCH');
    return saved;
  } catch (cause) {
    // PUT may have committed before the connection broke. Read before retrying.
    const saved = await api.getDocument(next.documentId).catch(() => null);
    if (saved && same(saved, next)) return saved;
    if (saved && (saved.revision >= next.revision || !same(identity(saved), identity(next)))) {
      throw new Error('SAVE_CONFLICT: server has different edits', { cause });
    }
    throw cause;
  }
}

export const pendingSaveKey = (workspaceId, documentId) => `imvia-v2-save-outbox:v1:${workspaceId}:${documentId}`;

export function readPendingSaves(storage, workspaceId, documentId) {
  const value = storage.getItem(pendingSaveKey(workspaceId, documentId));
  return value ? JSON.parse(value) : [];
}

export function writePendingSaves(storage, workspaceId, documentId, queue) {
  const key = pendingSaveKey(workspaceId, documentId);
  if (queue.length) storage.setItem(key, JSON.stringify(queue));
  else storage.removeItem(key);
}
