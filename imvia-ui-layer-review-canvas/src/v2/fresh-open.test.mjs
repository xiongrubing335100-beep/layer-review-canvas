import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBridgeRequestStore } from './bridge-request-store.js';
import { createDocumentStore } from './document-store.js';
import { createDocument } from './document.js';
import { readPageIdentity } from './page-identity.js';

const previousTestMode = process.env.IMVIA_LAYER_MCP_TEST_MODE;
process.env.IMVIA_LAYER_MCP_TEST_MODE = '1';
const { createLayerReviewBridgeServer } = await import('../../layer-review-mcp-server.mjs');
if (previousTestMode === undefined) delete process.env.IMVIA_LAYER_MCP_TEST_MODE;
else process.env.IMVIA_LAYER_MCP_TEST_MODE = previousTestMode;

test('every open entry creates an empty isolated V2 workbench and matching relay despite old IDs', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'imvia-fresh-open-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'bridge-requests');
  const store = createBridgeRequestStore({ root });
  const documents = createDocumentStore({ root: path.join(base, 'documents') });
  const previous = createDocument({ documentId: 'old-doc', workbenchSessionId: 'old-session', mode: 'poster',
    source: { path: '/original.png', width: 100, height: 100, fingerprint: 'original', revision: 1 } });
  await documents.create(previous);
  const oldBinding = await store.bindWorkspace({ workspaceId: 'old-workspace', documentId: 'old-doc', workbenchSessionId: 'old-session' });
  await store.pollRelay({ ...oldBinding, bridgeId: 'old-card' });
  await store.create({ batchId:'old-batch', envelope:{documentId:'old-doc',workbenchSessionId:'old-session'} });
  await store.transition({ requestId:'old-batch', expectedStatus:'pending', nextStatus:'claimed' });
  await store.queueRelay('old-batch');
  const previousRequest = await store.read('old-batch');

  const server = createLayerReviewBridgeServer({ v2BridgeRoot:root, ensureWorkbenchRunningImpl:async()=>{} });
  const client = new Client({ name:'fresh-test',version:'1' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async()=>{await client.close();await server.close();});
  const identities = [];
  for (const name of ['open_workbench_v2','open_workbench_v2_bridge','open_layer_review_workbench','connect_layer_review_workbench','open_workbench_v2']) {
    const args = name.includes('_v2') ? {documentId:'old-doc',workspaceId:'old-workspace'} : {};
    const result = await client.callTool({name, arguments:args});
    assert.equal(result.isError, undefined, name);
    const identity = result.structuredContent;
    assert.equal(identity.documentId, null, name);
    assert.notEqual(identity.workspaceId, 'old-workspace');
    assert.notEqual(identity.workbenchSessionId, 'old-session');
    const url = new URL(identity.workbenchUrl);
    assert.equal(url.searchParams.get('workbench'), 'v2');
    assert.equal(url.searchParams.has('documentId'), false);
    assert.equal(url.searchParams.get('workspaceId'), identity.workspaceId);
    assert.equal(url.searchParams.get('workbenchSessionId'), identity.workbenchSessionId);
    assert.deepEqual(readPageIdentity(url.href, {getItem:()=> 'old-doc'}), {
      documentId:null, workspaceId:identity.workspaceId, workbenchSessionId:identity.workbenchSessionId,
    });
    const poll = await client.callTool({name:'poll_workbench_v2_relay', arguments:{
      documentId:null,workspaceId:identity.workspaceId,workbenchSessionId:identity.workbenchSessionId,bridgeId:`card-${identities.length}`,
    }});
    assert.equal(poll.isError, undefined);
    assert.equal(poll.structuredContent.waitingForDocument, true);
    assert.equal(poll.structuredContent.request, null);
    assert.equal(poll.structuredContent.recoverableRequest, null);
    identities.push(identity);
  }
  assert.equal(new Set(identities.map(value=>value.workspaceId)).size, identities.length);
  assert.equal(new Set(identities.map(value=>value.workbenchSessionId)).size, identities.length);
  assert.deepEqual(await documents.read('old-doc'), previous);
  assert.deepEqual(await store.read('old-batch'), previousRequest);
  assert.deepEqual(await store.getWorkspace('old-workspace'), oldBinding);
  assert.deepEqual(await readdir(path.join(base,'documents')), ['old-doc']);

  const fresh = identities[0];
  // Upload fills only the matching empty workspace and the mounted card follows it.
  await store.bindWorkspace({workspaceId:fresh.workspaceId,documentId:'wrong-doc',workbenchSessionId:'old-session'});
  assert.equal((await store.getWorkspace(fresh.workspaceId)).documentId, null);
  await store.bindWorkspace({workspaceId:fresh.workspaceId,documentId:'uploaded-doc',workbenchSessionId:fresh.workbenchSessionId});
  const followed = await store.pollRelay({workspaceId:fresh.workspaceId,documentId:null,workbenchSessionId:fresh.workbenchSessionId,bridgeId:'card-0'});
  assert.equal(followed.binding.documentId, 'uploaded-doc');
  assert.equal(followed.switched, true);
  assert.equal(followed.request, null);
  await store.bindWorkspace({workspaceId:fresh.workspaceId,documentId:'wrong-doc',workbenchSessionId:'old-session'});
  assert.equal((await store.getWorkspace(fresh.workspaceId)).documentId, 'uploaded-doc');
});
