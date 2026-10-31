import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridgeRequestStore } from './bridge-request-store.js';
import { buildBatchPrompt, createBatchBridge } from './batch-bridge.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerV2BridgeTools } from './bridge-tools.mjs';
import { createDocumentStore } from './document-store.js';
import { createDocument } from './document.js';
import vm from 'node:vm';
import { buildV2ConfirmationProbeHtml } from '../mcp-bridge-resource.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(),'imvia-v2-bridge-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,store:createBridgeRequestStore({root})};
}
const envelope = {workbenchSessionId:'session-test',mode:'confirmation_probe',items:[{layerId:'one',action:'no-generation'},{layerId:'two',action:'no-generation'}]};
const receiptFor = record => ({workbenchSessionId:record.workbenchSessionId,envelopeSha256:record.envelopeSha256});

test('a workbench-click batch tells the visible Codex turn to execute without another user confirmation',()=>{
  const prompt=buildBatchPrompt({batchId:'batch-direct',requestId:'batch-direct',workbenchSessionId:'session-test',envelopeSha256:'a'.repeat(64),
    envelope:{mode:'layer_batch',manifestPath:'/tmp/batch-direct.json',executionPolicy:{trigger:'workbench_user_click',startAfterVisibleReceipt:true,additionalUserConfirmation:false}}});
  assert.match(prompt,/工作台点击已授权执行/);
  assert.match(prompt,/不要再次询问用户/);
  assert.match(prompt,/立即调用 claim_workbench_v2_batch_item/);
});

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
  assert.ok(tools.tools.some(t=>t.name==='claim_workbench_v2_batch_item'));
  assert.ok(tools.tools.some(t=>t.name==='restart_workbench_v2_session'));
  const prepared=await client.callTool({name:'prepare_workbench_v2_confirmation_probe',arguments:{batchId:'probe',workbenchSessionId:'session-test'}});
  const record=prepared.structuredContent;
  assert.equal(record.status,'claimed');
  const response=await client.callTool({name:'confirm_workbench_v2_batch',arguments:{batchId:'probe',requestId:record.requestId,receipt:receiptFor(record)}});
  assert.equal(response.isError,undefined);
  assert.deepEqual(response.structuredContent.receipt,receiptFor(record));
  assert.equal((await store.read(record.requestId)).status,'sent');
});
test('MCP opens one existing V2 document without resetting it or falling back to the legacy workbench',async t=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'imvia-v2-open-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const root=path.join(base,'bridge-requests');
  const documents=createDocumentStore({root:path.join(base,'documents')});
  const store=createBridgeRequestStore({root});
  const document=createDocument({documentId:'doc-one',workbenchSessionId:'session-one',mode:'poster',
    source:{path:path.join(base,'source.png'),width:1200,height:800,fingerprint:'source-one',revision:1}});
  await documents.create(document);
  await store.bindWorkspace({workspaceId:'workspace-one',documentId:'doc-one',workbenchSessionId:'session-one'});
  const server=new McpServer({name:'v2-open-test',version:'1'});
  registerV2BridgeTools(server,{root,workbenchOrigin:'http://127.0.0.1:4173',ensureWorkbenchRunning:async()=>{}});
  const client=new Client({name:'test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async()=>{await client.close();await server.close();});

  const tools=await client.listTools();
  assert.ok(tools.tools.some(tool=>tool.name==='open_workbench_v2'));
  const response=await client.callTool({name:'open_workbench_v2',arguments:{mode:'resume',documentId:'doc-one',workspaceId:'workspace-one'}});
  assert.equal(response.isError,undefined);
  assert.equal(response.structuredContent.documentId,'doc-one');
  assert.equal(response.structuredContent.workspaceId,'workspace-one');
  assert.equal(response.structuredContent.workbenchSessionId,'session-one');
  assert.equal(response.structuredContent.bridgeProtocolVersion,2);
  const url=new URL(response.structuredContent.workbenchUrl);
  assert.equal(url.origin,'http://127.0.0.1:4173');
  assert.equal(url.searchParams.get('workbench'),'v2');
  assert.equal(url.searchParams.get('documentId'),'doc-one');
  assert.equal(url.searchParams.get('workspaceId'),'workspace-one');
  assert.equal(url.searchParams.get('bridgeProtocolVersion'),'2');
  assert.ok(url.searchParams.get('open'));
  assert.deepEqual(await documents.read('doc-one'),document);
});
test('probe preserves a direct click send and cancels when SDK throws synchronously',async()=>{
  const nodes=Object.fromEntries(['state','send','cancel','badge','title','actions','description'].map(id=>[id,{disabled:true,textContent:'',hidden:false}]));
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

test('probe hides actions only after actual delivery acknowledgement',async()=>{
  const nodes=Object.fromEntries(['state','send','cancel','badge','title','actions','description'].map(id=>[id,{disabled:true,textContent:'',hidden:false}]));
  const script=[...buildV2ConfirmationProbeHtml().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  let poll;
  const context={document:{getElementById:id=>nodes[id],body:{dataset:{}}},crypto:{randomUUID:()=> 'fixed'},
    __IMVIA_MCP_APP_READY__:Promise.resolve(),__IMVIA_MCP_APP__:{async sendMessage(){return {};}},
    window:{addEventListener(){},openai:{async callTool(name){return {structuredContent:{requestId:'r',status:name==='get_workbench_v2_confirmation'?'sent':'claimed',prompt:'test'}};}}},
    setInterval:callback=>{poll=callback;return 1;},clearInterval(){}};
  await vm.runInNewContext(script,context);
  nodes.send.onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(nodes.actions.hidden,false);
  await poll();
  assert.equal(nodes.actions.hidden,true);
  assert.equal(nodes.description.hidden,true);
  assert.equal(context.document.body.dataset.result,'sent');
});
