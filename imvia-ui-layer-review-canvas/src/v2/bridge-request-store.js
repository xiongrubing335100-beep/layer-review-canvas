import { mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { idSchema } from './document.js';
import { canonicalJson } from '../poster-plan.js';

export function createBridgeRequestStore({ root, now = Date.now }) {
  const target = id => path.join(root, `${idSchema.parse(id)}.json`);
  const read = async id => JSON.parse(await readFile(target(id), 'utf8'));
  const presencePath = id => path.join(root, `relay-${idSchema.parse(id)}.json`);
  const workspacePath = id => path.join(root, `workspace-${idSchema.parse(id)}.json`);
  const getWorkspace = async id => JSON.parse(await readFile(workspacePath(id), 'utf8'));
  const readPresence = id => readFile(presencePath(id), 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const statusOf = (presence, documentId, workspaceId) => {
    const reconnecting = Boolean(presence?.reconnectRequestId && presence.reconnectRequestId !== presence.reconnectAcknowledgedId);
    const mismatch = Boolean((documentId && presence?.documentId !== documentId) || (workspaceId && presence?.workspaceId !== workspaceId));
    const online = Boolean(presence?.bridgeId && now() - presence.lastSeen < 15000 && !reconnecting && !mismatch);
    const reason = online ? 'connected' : reconnecting ? 'reconnecting' : !presence?.bridgeId ? 'not_connected'
      : mismatch ? 'binding_mismatch' : 'heartbeat_expired';
    return { online, reason, reconnecting,
      boundDocumentId: presence?.documentId ?? null,
      boundWorkspaceId: presence?.workspaceId ?? null,
      lastSeen: presence?.lastSeen ?? null, reconnectRequestedAt: presence?.reconnectRequestedAt ?? null };
  };
  async function locked(fn) {
    await mkdir(root, { recursive: true });
    const release = await lockfile.lock(root, { realpath: false, retries: { retries: 20, minTimeout: 5, maxTimeout: 50 } });
    try { return await fn(); } finally { await release(); }
  }
  async function write(record) {
    const temp = path.join(root, `${randomUUID()}.tmp`);
    try { await writeFile(temp, JSON.stringify(record)); await rename(temp, target(record.requestId)); }
    finally { await rm(temp, { force: true }); }
    return record;
  }
  return { read, getWorkspace,
    async findWorkspace(documentId) {
      await mkdir(root, { recursive: true });
      const records = await Promise.all((await readdir(root)).filter(f => f.startsWith('workspace-') && f.endsWith('.json')).map(async f => JSON.parse(await readFile(path.join(root, f), 'utf8'))));
      return records.filter(record => record.documentId === documentId).sort((a,b) => b.updatedAt - a.updatedAt)[0] ?? null;
    },
    async bindWorkspace({ workspaceId, documentId, workbenchSessionId }, { reconnect = false, automatic = false } = {}) {
      [workspaceId, workbenchSessionId].forEach(id => idSchema.parse(id));
      if (documentId !== null) idSchema.parse(documentId);
      return locked(async () => {
        const previous = await getWorkspace(workspaceId).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (previous?.documentId === documentId && previous.workbenchSessionId === workbenchSessionId) return previous;
        if (automatic && previous?.retiredDocumentIds?.includes(documentId)) return previous;
        const firstUpload = previous?.documentId === null && documentId !== null && previous.workbenchSessionId === workbenchSessionId;
        if (previous && !reconnect && !firstUpload) return previous;
        // Registration alone cannot switch a card. Recovery retires its old target so stale tabs cannot seize it back.
        if (previous && (previous.documentId !== documentId || previous.workbenchSessionId !== workbenchSessionId)) {
          const presence = await readPresence(previous.workbenchSessionId);
          if (presence?.workspaceId === workspaceId) await writeFile(presencePath(previous.workbenchSessionId), JSON.stringify({ ...presence, lastSeen: 0 }));
        }
        const retiredDocumentIds = [...new Set([...(previous?.retiredDocumentIds || []), previous?.documentId].filter(id => id && id !== documentId))];
        const binding = { workspaceId, documentId, workbenchSessionId, bindingRevision: (previous?.bindingRevision || 0) + 1, updatedAt: now(), retiredDocumentIds };
        await writeFile(workspacePath(workspaceId), JSON.stringify(binding));
        return binding;
      });
    },
    async getRelayStatus(sessionId, documentId, workspaceId) { return locked(async () => statusOf(await readPresence(sessionId), documentId, workspaceId)); },
    async requestRelayReconnect(sessionId, documentId, workspaceId) {
      return locked(async () => {
        const presence = await readPresence(sessionId);
        if (statusOf(presence).reconnecting && presence.expectedDocumentId === documentId
          && presence.expectedWorkspaceId === workspaceId) return statusOf(presence, documentId, workspaceId);
        const next = { ...presence, reconnectRequestId: randomUUID(), reconnectRequestedAt: now(),
          ...(workspaceId ? { expectedWorkspaceId: workspaceId, expectedDocumentId: documentId,
            ...(presence?.workspaceId !== workspaceId || presence?.documentId !== documentId ? { lastSeen:0 } : {}) } : {}) };
        await writeFile(presencePath(sessionId), JSON.stringify(next));
        return statusOf(next);
      });
    },
    async queueRelay(requestId, { workspaceId } = {}) {
      return locked(async () => {
        const record = await read(requestId);
        if (record.status !== 'claimed') throw new Error('REQUEST_TERMINAL');
        const presence = await readPresence(record.workbenchSessionId);
        if (!statusOf(presence, record.envelope.documentId, workspaceId).online) throw new Error('V2_BRIDGE_NOT_CONNECTED');
        if (record.relayClaimedAt) return { queued: false, requiresManualConfirmation: true };
        await write({ ...record, relayRequestedAt: record.relayRequestedAt || new Date().toISOString() });
        return { queued: true };
      });
    },
    async pollRelay({ workbenchSessionId, documentId, workspaceId, bindingRevision, bridgeId, claim = true }) {
      idSchema.parse(workbenchSessionId); idSchema.parse(bridgeId);
      return locked(async () => {
        const binding = workspaceId ? await getWorkspace(workspaceId) : { workbenchSessionId, documentId };
        const switched = binding.workbenchSessionId !== workbenchSessionId || binding.documentId !== documentId || (bindingRevision != null && binding.bindingRevision !== bindingRevision);
        workbenchSessionId = binding.workbenchSessionId; documentId = binding.documentId;
        const presence = await readPresence(workbenchSessionId);
        if (presence?.expectedWorkspaceId && (presence.expectedWorkspaceId !== workspaceId || presence.expectedDocumentId !== documentId)) return { active:false, binding, request:null };
        if (presence?.bridgeId && presence.bridgeId !== bridgeId && now() - presence.lastSeen < 15000) return { active: false, binding, request: null };
        const reconnected = statusOf(presence).reconnecting;
        await writeFile(presencePath(workbenchSessionId), JSON.stringify({ ...presence, bridgeId, documentId, workspaceId, lastSeen: now(),
          reconnectAcknowledgedId: presence?.reconnectRequestId ?? null }));
        if (documentId === null) return { active: true, binding, waitingForDocument: true, request: null };
        if (!claim || reconnected || switched) return { active: true, binding, reconnected, switched, request: null };
        for (const file of (await readdir(root)).filter(name => name.endsWith('.json') && !name.startsWith('relay-') && !name.startsWith('workspace-'))) {
          const record = JSON.parse(await readFile(path.join(root, file), 'utf8'));
          if (record.workbenchSessionId !== workbenchSessionId || record.status !== 'claimed' || !record.relayRequestedAt) continue;
          if (documentId && record.envelope.documentId !== documentId) continue;
          if (record.relayClaimedAt) return { active: true, binding, request: null, recoverableRequest: record };
          const request = await write({ ...record, relayClaimedAt: new Date().toISOString(), relayBridgeId: bridgeId });
          return { active: true, binding, request };
        }
        return { active: true, binding, request: null };
      });
    },
    async create({ batchId, envelope }) {
      idSchema.parse(batchId); idSchema.parse(envelope.workbenchSessionId);
      const normalized = JSON.parse(canonicalJson(envelope));
      const envelopeSha256 = createHash('sha256').update(canonicalJson(normalized)).digest('hex');
      return locked(async () => {
        try {
          const existing = await read(batchId);
          if (existing.envelopeSha256 !== envelopeSha256) throw new Error('BINDING_MISMATCH');
          return existing;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return write({ requestId: batchId, batchId, workbenchSessionId: envelope.workbenchSessionId,
          envelopeSha256, envelope: normalized, status: 'pending', deliveredAt: null, confirmedAt: null });
      });
    },
    async transition({ requestId, expectedStatus, nextStatus, receipt }) {
      return locked(async () => {
        const record = await read(requestId);
        if (nextStatus === 'sent') {
          if (!receipt || receipt.workbenchSessionId !== record.workbenchSessionId || receipt.envelopeSha256 !== record.envelopeSha256) throw new Error('RECEIPT_MISMATCH');
          if (record.status === 'sent') return record;
        }
        if (record.status !== expectedStatus) throw new Error('REQUEST_STATE_CONFLICT');
        const allowed = { pending: ['claimed', 'cancelled'], claimed: ['sent', 'cancelled'], sent: [], cancelled: [] };
        if (!allowed[record.status]?.includes(nextStatus)) throw new Error('REQUEST_TERMINAL');
        const now = new Date().toISOString();
        return write({ ...record, status: nextStatus,
          ...(nextStatus === 'sent' ? { deliveredAt: now, confirmedAt: now } : {}) });
      });
    },
  };
}
