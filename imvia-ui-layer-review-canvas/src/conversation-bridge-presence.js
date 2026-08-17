import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const heartbeatFileName = 'conversation-bridge-v8-heartbeat.json';
let presenceMutation = Promise.resolve();

function serializePresenceMutation(action) {
  const next = presenceMutation.then(action, action);
  presenceMutation = next.catch(() => {});
  return next;
}

async function writePresence(directory, value) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, heartbeatFileName),
    JSON.stringify(value, null, 2),
  );
}

export async function activateConversationBridge(
  directory,
  bridgeId,
  connectedAt = new Date().toISOString(),
  { workbenchSessionId = null } = {},
) {
  if (!bridgeId) throw new Error('会话桥接缺少实例标识');
  return serializePresenceMutation(async () => {
    try {
      const current = JSON.parse(await readFile(
        path.join(directory, heartbeatFileName),
        'utf8',
      ));
      if (
        current.bridgeId !== bridgeId
        && Number.isFinite(Date.parse(current.connectedAt))
        && Date.parse(current.connectedAt) > Date.parse(connectedAt)
      ) {
        return { ...current, active: false };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await writePresence(directory, {
      bridgeId,
      connectedAt,
      lastSeen: connectedAt,
      workbenchSessionId,
    });
    return {
      active: true,
      bridgeId,
      connectedAt,
      lastSeen: connectedAt,
      ...(workbenchSessionId ? { workbenchSessionId } : {}),
    };
  });
}

export async function markConversationBridgeHeartbeat(
  directory,
  bridgeId,
  lastSeen = new Date().toISOString(),
  { workbenchSessionId = null } = {},
) {
  return serializePresenceMutation(async () => {
    try {
      const current = JSON.parse(await readFile(
        path.join(directory, heartbeatFileName),
        'utf8',
      ));
      if (
        !bridgeId
        || current.bridgeId !== bridgeId
        || (
          workbenchSessionId
          && current.workbenchSessionId !== workbenchSessionId
        )
      ) return false;
      await writePresence(directory, { ...current, lastSeen });
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
}

export async function readConversationBridgePresence(directory, {
  now = new Date(),
  timeoutMs = 4_000,
  workbenchSessionId = null,
} = {}) {
  try {
    const {
      bridgeId = null,
      lastSeen,
      workbenchSessionId: activeWorkbenchSessionId = null,
    } = JSON.parse(await readFile(
      path.join(directory, heartbeatFileName),
      'utf8',
    ));
    if (
      workbenchSessionId
      && activeWorkbenchSessionId !== workbenchSessionId
    ) {
      return {
        online: false,
        lastSeen,
        bridgeId: null,
        workbenchSessionId: null,
      };
    }
    return {
      online: Boolean(bridgeId)
        && Number.isFinite(Date.parse(lastSeen))
        && now.getTime() - Date.parse(lastSeen) <= timeoutMs,
      lastSeen,
      bridgeId,
      ...(activeWorkbenchSessionId
        ? { workbenchSessionId: activeWorkbenchSessionId }
        : {}),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { online: false, lastSeen: null, bridgeId: null };
    }
    throw error;
  }
}
