// Requests recovery through the real store, then only observes host receipts.
// Never calls pollRelay, changes document binding, or queues a batch.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createBridgeRequestStore } from '../src/v2/bridge-request-store.js';

const [root, documentId, workspaceId, sessionId] = process.argv.slice(2);
if (!sessionId) throw new Error('Usage: node probe-live-relay-recovery.mjs ROOT DOCUMENT WORKSPACE SESSION');
const bridgeRoot = path.join(root, 'bridge-requests');
const store = createBridgeRequestStore({ root: bridgeRoot });
const presence = () => readFile(path.join(bridgeRoot, `relay-${sessionId}.json`), 'utf8').then(JSON.parse);
async function fingerprint(directory) {
  const hash = createHash('sha256');
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) { hash.update(path.relative(directory, file)); hash.update(await readFile(file)); }
    }
  }
  await walk(directory);
  return hash.digest('hex');
}
const protectedDirectories = ['documents', 'batches', 'attempts', 'candidates'];
const fingerprints = async () => Object.fromEntries(await Promise.all(protectedDirectories.map(async name =>
  [name, await fingerprint(path.join(root, name))])));
const binding = await store.getWorkspace(workspaceId);
if (binding.documentId !== documentId || binding.workbenchSessionId !== sessionId) throw new Error('BINDING_MISMATCH');
const before = await fingerprints();
const previous = await presence();
await store.requestRelayReconnect(sessionId, documentId, workspaceId);
const requested = await presence();
const started = Date.now();
let observed;
do {
  observed = await presence();
  if (observed.reconnectAcknowledgedId === requested.reconnectRequestId) break;
  await new Promise(resolve => setTimeout(resolve, 250));
} while (Date.now() - started < 12000);
const after = await fingerprints();
const passed = observed.reconnectAcknowledgedId === requested.reconnectRequestId
  && observed.documentId === documentId && observed.workspaceId === workspaceId
  && observed.bridgeId === previous.bridgeId && Date.now() - observed.lastSeen < 15000
  && JSON.stringify(before) === JSON.stringify(after);
console.log(JSON.stringify({ passed, documentId, workspaceId, sessionId,
  bridgeId: observed.bridgeId, sameCard: observed.bridgeId === previous.bridgeId,
  requestId: requested.reconnectRequestId, receiptId: observed.reconnectAcknowledgedId,
  observationMs: Date.now() - started, before, after }, null, 2));
process.exitCode = passed ? 0 : 1;
