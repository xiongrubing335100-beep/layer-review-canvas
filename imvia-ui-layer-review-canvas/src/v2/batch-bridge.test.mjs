import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridgeRequestStore } from './bridge-request-store.js';
import { createBatchBridge } from './batch-bridge.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerV2BridgeTools } from './bridge-tools.mjs';
import vm from 'node:vm';
import { buildV2ConfirmationProbeHtml } from '../mcp-bridge-resource.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(),'imvia-v2-bridge-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,store:createBridgeRequestStore({root})};
}
const envelope = {workbenchSessionId:'session-test',mode:'confirmation_probe',items:[{layerId:'one',action:'no-generation'},{layerId:'two',action:'no-generation'}]};
const receiptFor = record => ({workbenchSessionId:record.workbenchSessionId,envelopeSha256:record.envelopeSha256});

test('host resolve is not delivery; repeated click opens one request until actual acknowledgement',async t=>{
  const {store}=await fixture(t); let calls=0;
  const bridge=createBatchBridge({store,host:{async sendMessage({prompt}){calls++;assert.match(prompt,/confirm_workbench_v2_batch/);return {};}}});
  const [a,b]=await Promise.all([bridge.requestBatchConfirmation({batchId:'batch-test',envelope}),bridge.requestBatchConfirmation({batchId:'batch-test',envelope})]);
  assert.equal(a.requestId,b.requestId); assert.equal(calls,1);
  const record=await store.read(a.requestId);
  assert.equal(record.status,'claimed'); assert.equal(record.deliveredAt,null);
  await bridge.acknowledgeBatchMessage({batchId:'batch-test',requestId:a.requestId,receipt:receiptFor(record)});
  assert.equal((await store.read(a.requestId)).status,'sent');
  await bridge.acknowledgeBatchMessage({batchId:'batch-test',requestId:a.requestId,receipt:receiptFor(record)});
  await bridge.requestBatchConfirmation({batchId:'batch-test',envelope}); assert.equal(calls,1);
});
test('cancel or host rejection is terminal; mismatched and late receipts cannot revive',async t=>{
  const {store}=await fixture(t);
  const bridge=createBatchBridge({store,host:{async sendMessage(){return {};}}});
  const {requestId}=await bridge.requestBatchConfirmation({batchId:'cancel-test',envelope});
  const record=await store.read(requestId);
  await assert.rejects(bridge.acknowledgeBatchMessage({batchId:'wrong',requestId,receipt:receiptFor(record)}));
  await assert.rejects(bridge.acknowledgeBatchMessage({batchId:'cancel-test',requestId,receipt:{...receiptFor(record),workbenchSessionId:'old'}}));
  await store.transition({requestId,expectedStatus:'claimed',nextStatus:'cancelled'});
  await assert.rejects(bridge.acknowledgeBatchMessage({batchId:'cancel-test',requestId,receipt:receiptFor(record)}));
  assert.equal((await store.read(requestId)).status,'cancelled');
  const rejected=createBatchBridge({store,host:{async sendMessage(){throw new Error('User declined');}}});
  await assert.rejects(rejected.requestBatchConfirmation({batchId:'declined',envelope}),/User declined/);
  assert.equal((await store.read('declined')).status,'cancelled');
});
test('different envelope cannot reuse submission identity and abort prevents late success',async t=>{
  const {store}=await fixture(t); const controller=new AbortController();
  const bridge=createBatchBridge({store,host:{async sendMessage(){controller.abort();return {};}}});
  await assert.rejects(bridge.requestBatchConfirmation({batchId:'abort',envelope,signal:controller.signal}));
  assert.equal((await store.read('abort')).status,'cancelled');
  await assert.rejects(store.create({batchId:'abort',envelope:{...envelope,items:[]}}),/BINDING_MISMATCH/);
});
test('an in-flight submission key cannot be rebound to a different envelope',async t=>{
  const {store}=await fixture(t);
  let release;
  const bridge=createBatchBridge({store,host:{sendMessage(){return new Promise(resolve=>{release=resolve;});}}});
  const first=bridge.requestBatchConfirmation({batchId:'same',envelope});
  const changed=bridge.requestBatchConfirmation({batchId:'same',envelope:{...envelope,items:[]}});
  const rejected=assert.rejects(changed,/BINDING_MISMATCH/);
  // Release the slow host after preparation, without a wall-clock delay.
  while(!release) await new Promise(resolve=>setImmediate(resolve));
  release({});
  await first;
  await rejected;
});
test('MCP exposes model-only acknowledgement and performs the actual persisted transition',async t=>{
  const {root,store}=await fixture(t);
  const server=new McpServer({name:'v2-test',version:'1'});
  registerV2BridgeTools(server,{root});
  const client=new Client({name:'test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async()=>{await client.close();await server.close();});
  const tools=await client.listTools();
  assert.deepEqual(tools.tools.find(t=>t.name==='confirm_workbench_v2_batch')._meta.ui.visibility,['model']);
  const prepared=await client.callTool({name:'prepare_workbench_v2_confirmation_probe',arguments:{batchId:'probe',workbenchSessionId:'session-test'}});
  const record=prepared.structuredContent;
  assert.equal(record.status,'claimed');
  const response=await client.callTool({name:'confirm_workbench_v2_batch',arguments:{batchId:'probe',requestId:record.requestId,receipt:receiptFor(record)}});
  assert.equal(response.isError,undefined);
  assert.equal((await store.read(record.requestId)).status,'sent');
});
test('probe preserves a direct click send and cancels when SDK throws synchronously',async()=>{
  const nodes=Object.fromEntries(['state','send','cancel'].map(id=>[id,{disabled:true,textContent:''}]));
  const calls=[];
  const html=buildV2ConfirmationProbeHtml();
  const script=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  let sent=0;
  const context={document:{getElementById:id=>nodes[id]},crypto:{randomUUID:()=> 'fixed'},
    __IMVIA_MCP_APP_READY__:Promise.resolve(),
    __IMVIA_MCP_APP__:{sendMessage(){sent++;throw new Error('Host unavailable');}},
    window:{addEventListener(){},openai:{async callTool(name){calls.push(name);return {structuredContent:{requestId:'r',status:'claimed',prompt:'test'}};}}},
    setInterval:()=>1,clearInterval(){}};
  await vm.runInNewContext(script,context);
  assert.equal(sent,0);assert.equal(nodes.send.disabled,false);
  assert.doesNotThrow(()=>nodes.send.onclick());
  assert.equal(sent,1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(calls.includes('cancel_workbench_v2_confirmation'));
  assert.match(nodes.state.textContent,/Host unavailable/);
});
