// Repeated status polls return the same request timestamp. Only a genuinely new
// request gets a waiting indicator; an absent card must not spin indefinitely.
export function bridgeReceiptDeadline(status, now = Date.now()) {
  if (status?.online || status?.autoReconnectBlocked || !Number.isFinite(status?.reconnectRequestedAt)) return 0;
  const deadline = status.reconnectRequestedAt + 10000;
  return deadline > now ? deadline : 0;
}

export function createBridgeRecovery({ api, documentId, workspaceId, now = Date.now }) {
  let stopped = false, pending = false, attempts = 0, retryAt = 0;
  return {
    async recover(status, { visible = true } = {}) {
      if (stopped) return null;
      if (status?.online) { attempts = 0; retryAt = 0; return null; }
      if (!visible || !documentId || !workspaceId || status?.autoReconnectBlocked
        || !api.reconnectBridge || pending || now() < retryAt) return null;
      pending = true;
      retryAt = now() + Math.min(10000 * 2 ** Math.min(attempts++, 2), 30000);
      try {
        const result = await api.reconnectBridge(documentId, workspaceId, { automatic:true });
        return stopped ? null : result;
      } finally { pending = false; }
    },
    stop() { stopped = true; },
  };
}
