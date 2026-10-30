import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridgeRequestStore } from './bridge-request-store.js';
import { buildV2RelayHtml } from '../mcp-bridge-resource.js';
import vm from 'node:vm';

test('a connected inline bridge requests a supported side panel once without blocking heartbeats', async () => {
  const nodes = { state: {}, connection: {}, send: {} };
  const binding = { documentId: 'doc', workbenchSessionId: 'session' };
  let bind, tick, polls = 0;
  const requests = [];
  const app = {
    getHostContext: () => ({ displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] }),
    requestDisplayMode(args) { requests.push(args); return new Promise(() => {}); },
    async callServerTool() { polls++; return { structuredContent: { active: true, binding } }; },
    sendMessage() { assert.fail('connecting must not send a task'); },
  };
  const script = [...(await buildV2RelayHtml()).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1]
    .replace('void bind(event.detail)', 'return bind(event.detail)');
  vm.runInNewContext(script, {
    document: { getElementById: id => nodes[id] }, crypto: { randomUUID: () => 'card' },
    __IMVIA_MCP_APP__: app, __IMVIA_MCP_APP_READY__: Promise.resolve(),
    window: { addEventListener: (name, fn) => { if (name === 'imvia:tool-result') bind = fn; } },
    setInterval: fn => { tick = fn; }, setTimeout, clearTimeout,
  });
  await bind({ detail: { structuredContent: binding } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].mode, 'fullscreen');
  await tick(); await tick();
  assert.equal(polls, 3);
  assert.equal(requests.length, 1, 'an unanswered display request must not repeatedly open panels');
  assert.match(nodes.connection.textContent, /已连接/);
});

test('an initial host handshake failure keeps recovery running without another tool result', async () => {
  const nodes = { state: {}, connection: {}, send: { hidden: true, disabled: false } };
  const binding = { documentId: 'doc', workbenchSessionId: 'session' };
  let bind, tick, connected = false, sends = 0;
  const app = {
    async callServerTool() {
      if (!connected) throw new Error('transport is not initialized');
      return { structuredContent: { active: true, binding, request: null } };
    },
    async close() {},
    async connect() { connected = true; },
    sendMessage() { sends++; },
  };
  const script = [...(await buildV2RelayHtml()).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  // A thenable avoids an unrelated process-level unhandled rejection in this
  // harness; the observable failure is the missing recovery loop.
  const initialReady = { then(resolve, reject) { reject(new Error('initial handshake timed out')); } };
  const errors = [];
  // Capture the bind promise in the evaluated test context, not by modifying
  // production behavior or installing a global unhandled-rejection handler.
  const observableScript = script.replace('void bind(event.detail)', 'return bind(event.detail)');
  vm.runInNewContext(observableScript, {
    document: { getElementById: id => nodes[id] }, crypto: { randomUUID: () => 'card' },
    __IMVIA_MCP_APP__: app, __IMVIA_MCP_APP_READY__: initialReady,
    window: { addEventListener: (name, fn) => { if (name === 'imvia:tool-result') bind = fn; } },
    setInterval: fn => { tick = fn; }, setTimeout, clearTimeout,
  });
  await Promise.resolve(bind({ detail: { structuredContent: binding } })).catch(error => errors.push(error));
  assert.equal(typeof tick, 'function', 'initialization failure must not permanently disable recovery');
  for (let attempt = 0; attempt < 4; attempt++) await tick();
  assert.equal(errors.length, 0);
  assert.match(nodes.connection.textContent, /已连接/);
  assert.equal(sends, 0);
});

for (const scenario of [
  { name: 'unsupported host', context: { displayMode: 'inline', availableDisplayModes: ['inline'] }, active: true, requests: 0 },
  { name: 'already expanded host', context: { displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] }, active: true, requests: 0 },
  { name: 'inactive bridge', context: { displayMode: 'inline', availableDisplayModes: ['fullscreen'] }, active: false, requests: 0 },
  { name: 'host rejects expansion', context: { displayMode: 'inline', availableDisplayModes: ['fullscreen'] }, active: true, requests: 1 },
]) test(`display recovery leaves polling running for ${scenario.name}`, async () => {
  const nodes = { state: {}, connection: {}, send: {} };
  const binding = { documentId: 'doc', workbenchSessionId: 'session' };
  let bind, tick, requests = 0, polls = 0;
  const app = {
    getHostContext: () => scenario.context,
    requestDisplayMode() { requests++; return Promise.reject(new Error('host denied display')); },
    async callServerTool() { polls++; return { structuredContent: { active: scenario.active, binding } }; },
    sendMessage() { assert.fail('display changes must not send tasks'); },
  };
  const script = [...(await buildV2RelayHtml()).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1]
    .replace('void bind(event.detail)', 'return bind(event.detail)');
  vm.runInNewContext(script, {
    document: { getElementById: id => nodes[id] }, crypto: { randomUUID: () => 'card' },
    __IMVIA_MCP_APP__: app, __IMVIA_MCP_APP_READY__: Promise.resolve(),
    window: { addEventListener: (name, fn) => { if (name === 'imvia:tool-result') bind = fn; } },
    setInterval: fn => { tick = fn; }, setTimeout, clearTimeout,
  });
  await bind({ detail: { structuredContent: binding } });
  await tick(); await tick();
  assert.equal(requests, scenario.requests);
  assert.equal(polls, 3);
  if (scenario.active) assert.match(nodes.connection.textContent, /已连接/);
});

test('bridge status distinguishes an absent card, expired heartbeat, binding mismatch and fresh reconnect receipt', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-connection-reason-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 100000;
  const store = createBridgeRequestStore({ root, now: () => now });
  const binding = { workbenchSessionId: 'session', documentId: 'doc' };
  assert.equal((await store.getRelayStatus('session', 'doc')).reason, 'not_connected');
  await store.pollRelay({ ...binding, bridgeId: 'card', claim: false });
  assert.equal((await store.getRelayStatus('session', 'doc')).reason, 'connected');
  assert.equal((await store.getRelayStatus('session', 'different-doc')).reason, 'binding_mismatch');
  now += 16000;
  assert.equal((await store.getRelayStatus('session', 'doc')).reason, 'heartbeat_expired');
  await store.requestRelayReconnect('session', 'doc');
  assert.equal((await store.getRelayStatus('session', 'doc')).reason, 'reconnecting');
  await store.pollRelay({ ...binding, bridgeId: 'card', claim: false });
  assert.equal((await store.getRelayStatus('session', 'doc')).reason, 'connected');
});

test('returning to the relay card immediately checks heartbeat without claiming a queued task', async () => {
  const nodes = { state: {}, connection: {}, send: { hidden: true, disabled: false } };
  const events = {}, calls = [];
  const binding = { documentId: 'doc', workbenchSessionId: 'session' };
  let tick, sends = 0;
  const app = {
    async callServerTool({ arguments: args }) {
      calls.push(args);
      return { structuredContent: { active: true, binding, request: null } };
    },
    sendMessage() { sends++; },
  };
  const script = [...(await buildV2RelayHtml()).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInNewContext(script, { document: { getElementById: id => nodes[id], visibilityState: 'visible', addEventListener: (name, fn) => { events[name] = fn; } },
    crypto: { randomUUID: () => 'card' }, __IMVIA_MCP_APP__: app, __IMVIA_MCP_APP_READY__: Promise.resolve(),
    window: { addEventListener: (name, fn) => { events[name] = fn; } }, setInterval: fn => { tick = fn; }, setTimeout, clearTimeout });
  events['imvia:tool-result']({ detail: { structuredContent: binding } });
  while (!tick) await new Promise(resolve => setImmediate(resolve));
  const before = calls.length;
  assert.equal(typeof events.pageshow, 'function');
  events.pageshow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).claim, false);
  assert.equal(sends, 0);
  assert.match(nodes.connection.textContent, /已连接/);
});

test('explicit workspace reconnect rebinds the existing card without consuming either document batch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createBridgeRequestStore({ root });
  const old = { workspaceId: 'workspace-one', documentId: 'doc-old', workbenchSessionId: 'session-old' };
  const next = { ...old, documentId: 'doc-new', workbenchSessionId: 'session-new' };
  await store.bindWorkspace(old);
  await store.pollRelay({ ...old, bridgeId: 'card-one' });
  await store.bindWorkspace(next);
  assert.equal((await store.getWorkspace(old.workspaceId)).documentId, 'doc-old', 'opening another document must not silently retarget a live card');
  for (const binding of [old, next]) {
    await store.create({ batchId: binding.documentId, envelope: binding });
    await store.transition({ requestId: binding.documentId, expectedStatus: 'pending', nextStatus: 'claimed' });
  }
  await store.queueRelay('doc-old');
  await store.bindWorkspace(next, { reconnect: true });
  const switched = await store.pollRelay({ ...old, bridgeId: 'card-one' });
  assert.equal(switched.binding.documentId, 'doc-new');
  assert.equal(switched.request, null);
  assert.equal((await store.getRelayStatus('session-old', 'doc-old')).online, false);
  assert.equal((await store.getRelayStatus('session-new', 'doc-new')).online, true);
  await store.queueRelay('doc-new');
  const delivery = await store.pollRelay({ ...next, bridgeId: 'card-one' });
  assert.equal(delivery.request.batchId, 'doc-new');
  assert.equal((await store.read('doc-old')).relayClaimedAt, undefined);
  assert.equal((await store.read('doc-new')).deliveredAt, null);
  assert.equal((await store.pollRelay({ ...next, bridgeId: 'card-one' })).request, null);
});

test('a session heartbeat for another document cannot authorize a batch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-doc-bound-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createBridgeRequestStore({ root });
  await store.pollRelay({ workbenchSessionId: 'shared-session', documentId: 'other-doc', bridgeId: 'card' });
  await store.create({ batchId: 'new-batch', envelope: { workbenchSessionId: 'shared-session', documentId: 'current-doc' } });
  await store.transition({ requestId: 'new-batch', expectedStatus: 'pending', nextStatus: 'claimed' });
  assert.equal((await store.getRelayStatus('shared-session', 'current-doc')).online, false);
  await assert.rejects(() => store.queueRelay('new-batch'), /V2_BRIDGE_NOT_CONNECTED/);
});

test('automatic recovery follows the current document once, without letting a stale page steal it back', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-auto-binding-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const store = createBridgeRequestStore({ root });
  const old = { workspaceId:'workspace', documentId:'old-doc', workbenchSessionId:'old-session' };
  const next = { workspaceId:'workspace', documentId:'new-doc', workbenchSessionId:'new-session' };
  await store.bindWorkspace(old);
  await store.pollRelay({ ...old, bridgeId:'card' });
  await store.bindWorkspace(next, { reconnect:true, automatic:true });
  const recovered = await store.pollRelay({ ...old, bridgeId:'card', claim:false });
  assert.equal(recovered.binding.documentId, 'new-doc');
  assert.equal(recovered.request, null);
  await store.bindWorkspace(old, { reconnect:true, automatic:true });
  assert.equal((await store.getWorkspace('workspace')).documentId, 'new-doc');
  assert.equal((await store.getRelayStatus('new-session', 'new-doc', 'workspace')).online, true);
  // A deliberate manual resume remains available.
  await store.bindWorkspace(old, { reconnect:true });
  assert.equal((await store.getWorkspace('workspace')).documentId, 'old-doc');
});

test('repeated automatic recovery preserves the pending receipt and stable workspace revision', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-auto-receipt-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  let now = 100000;
  const store = createBridgeRequestStore({ root, now:() => now });
  const binding = { workspaceId:'workspace', documentId:'doc', workbenchSessionId:'session' };
  const before = await store.bindWorkspace(binding);
  await store.requestRelayReconnect('session','doc','workspace');
  const first = await store.getRelayStatus('session','doc','workspace');
  now += 5000;
  const again = await store.bindWorkspace(binding, { reconnect:true, automatic:true });
  await store.requestRelayReconnect('session','doc','workspace');
  assert.equal(again.bindingRevision, before.bindingRevision);
  assert.equal((await store.getRelayStatus('session','doc','workspace')).reconnectRequestedAt, first.reconnectRequestedAt);
  const acknowledgement = await store.pollRelay({...binding,bridgeId:'card',claim:false});
  assert.equal(acknowledgement.reconnected,true);
  assert.equal(acknowledgement.request,null);
});

test('a replacement card exposes a claimed request for manual recovery without replaying it', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-recovery-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  let now = 100000;
  const store = createBridgeRequestStore({ root, now: () => now });
  const binding = { workbenchSessionId:'session', documentId:'doc' };
  await store.create({ batchId:'batch', envelope:binding });
  await store.transition({requestId:'batch',expectedStatus:'pending',nextStatus:'claimed'});
  await store.pollRelay({...binding, bridgeId:'old'});
  await store.queueRelay('batch');
  await store.pollRelay({...binding, bridgeId:'old'});
  const before = await store.read('batch');
  now += 16000;
  const next = await store.pollRelay({...binding, bridgeId:'new'});
  assert.equal(next.request, null);
  assert.equal(next.recoverableRequest.batchId, 'batch');
  assert.deepEqual(await store.read('batch'), before);
  assert.equal((await store.queueRelay('batch')).requiresManualConfirmation, true);
});

test('explicit reconnect takes the target workspace lease; the previous workspace cannot acknowledge it', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'imvia-lease-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createBridgeRequestStore({root});
  const a={documentId:'doc-a',workbenchSessionId:'shared',workspaceId:'workspace-a'};
  const b={documentId:'doc-b',workbenchSessionId:'shared',workspaceId:'workspace-b'};
  await store.bindWorkspace(a); await store.bindWorkspace(b);
  await store.pollRelay({...a,bridgeId:'a'});
  await store.requestRelayReconnect('shared','doc-b','workspace-b');
  assert.equal((await store.pollRelay({...a,bridgeId:'a'})).active,false);
  assert.equal((await store.getRelayStatus('shared','doc-b','workspace-b')).online,false);
  assert.equal((await store.pollRelay({...b,bridgeId:'b'})).active,true);
  assert.equal((await store.getRelayStatus('shared','doc-b','workspace-b')).online,true);
  assert.equal((await store.getRelayStatus('shared','doc-a','workspace-a')).online,false);
});

test('reconnect requires a new heartbeat acknowledgement and never replays a claimed batch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-reconnect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 100000;
  const store = createBridgeRequestStore({ root, now: () => now });
  assert.equal((await store.getRelayStatus('session-one')).online, false);
  await store.pollRelay({ workbenchSessionId: 'session-one', bridgeId: 'card-one' });
  assert.equal((await store.getRelayStatus('session-one')).online, true);
  await store.create({ batchId: 'batch-one', envelope: { workbenchSessionId: 'session-one' } });
  await store.transition({ requestId: 'batch-one', expectedStatus: 'pending', nextStatus: 'claimed' });
  await store.queueRelay('batch-one');
  await store.pollRelay({ workbenchSessionId: 'session-one', bridgeId: 'card-one' });
  const before = await store.read('batch-one');
  now += 16000;
  assert.equal((await store.getRelayStatus('session-one')).online, false);
  const reconnect = await store.requestRelayReconnect('session-one');
  assert.equal(reconnect.online, false);
  assert.equal(reconnect.reconnecting, true);
  await store.pollRelay({ workbenchSessionId: 'other-session', bridgeId: 'other-card' });
  assert.equal((await store.getRelayStatus('session-one')).reconnecting, true);
  const recovered = await store.pollRelay({ workbenchSessionId: 'session-one', bridgeId: 'card-one' });
  assert.equal(recovered.reconnected, true);
  assert.equal(recovered.request, null);
  assert.equal((await store.getRelayStatus('session-one')).online, true);
  assert.deepEqual(await store.read('batch-one'), before);
  await store.requestRelayReconnect('session-one');
  assert.equal((await store.getRelayStatus('session-one')).online, false, 'old heartbeat cannot satisfy a new reconnect');
});

test('standalone relay requires a live session card, claims once, and never marks delivery', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-relay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createBridgeRequestStore({ root });
  await store.create({ batchId: 'batch-one', envelope: { workbenchSessionId: 'session-one' } });
  await store.transition({ requestId: 'batch-one', expectedStatus: 'pending', nextStatus: 'claimed' });
  await assert.rejects(() => store.queueRelay('batch-one'), /V2_BRIDGE_NOT_CONNECTED/);
  await store.pollRelay({ workbenchSessionId: 'session-two', bridgeId: 'card-two' });
  await assert.rejects(() => store.queueRelay('batch-one'), /V2_BRIDGE_NOT_CONNECTED/);
  await store.pollRelay({ workbenchSessionId: 'session-one', bridgeId: 'card-one' });
  await store.queueRelay('batch-one');
  const [a, b] = await Promise.all([1, 2].map(() => store.pollRelay({ workbenchSessionId: 'session-one', bridgeId: 'card-one' })));
  assert.equal([a, b].filter(x => x.request).length, 1);
  assert.equal((a.request || b.request).batchId, 'batch-one');
  const record = await store.read('batch-one');
  assert.equal(record.status, 'claimed');
  assert.equal(record.deliveredAt, null);
  await store.transition({ requestId: 'batch-one', expectedStatus: 'claimed', nextStatus: 'cancelled' });
  await assert.rejects(() => store.queueRelay('batch-one'), /REQUEST_TERMINAL/);
  assert.equal((await store.pollRelay({ workbenchSessionId: 'session-one', bridgeId: 'card-one' })).request, null);
});

test('relay card binds only the tool session, surfaces synchronous host rejection, and waits for receipt', async () => {
  const nodes = { state: { textContent: '' }, send: { hidden: true, disabled: false } };
  let timer, bind, status = 'claimed', sends = 0, claimed = false;
  const app = {
    async callServerTool({ name, arguments: args }) {
      if (name === 'get_workbench_v2_confirmation') return { structuredContent: { status } };
      assert.equal(args.workbenchSessionId, 'session-one');
      const request = !claimed && args.claim ? { requestId: 'batch-one', prompt: 'frozen task' } : null;
      if (request) claimed = true;
      return { structuredContent: { active: true, binding:{documentId:'doc-one',workbenchSessionId:'session-one'}, request } };
    },
    sendMessage(message) { assert.equal(message.content[0].text, 'frozen task'); sends++; if (sends === 1) throw new Error('click required'); return {}; },
  };
  const html = await buildV2RelayHtml();
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInNewContext(script, { document: { getElementById: id => nodes[id] }, crypto: { randomUUID: () => 'card-one' },
    __IMVIA_MCP_APP__: app, __IMVIA_MCP_APP_READY__: Promise.resolve(), window: { addEventListener: (name, fn) => { bind = fn; } }, setInterval: fn => { timer = fn; }, setTimeout, clearTimeout });
  bind({ detail: { structuredContent: { workbenchSessionId: 'session-one', documentId:'doc-one' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1);
  assert.equal(nodes.send.hidden, false);
  assert.equal(nodes.send.disabled, false);
  nodes.send.onclick();
  await new Promise(resolve => setImmediate(resolve));
  await timer();
  assert.equal(sends, 2);
  assert.match(nodes.state.textContent, /尚未确认/);
  status = 'sent'; await timer();
  assert.match(nodes.state.textContent, /已确认收到/);
});

test('slow receipt queries do not block heartbeats or turn a live connection offline', async () => {
  const nodes={state:{textContent:''},connection:{textContent:''},send:{hidden:true,disabled:false}};
  let bind, tick, rejectReceipt, heartbeats=0, receipts=0, sends=0;
  const app={
    callServerTool({name}) {
      if(name==='get_workbench_v2_confirmation') {
        receipts++;
        return new Promise((resolve,reject)=>{rejectReceipt=reject;});
      }
      heartbeats++;
      return Promise.resolve({structuredContent:{active:true,binding:{documentId:'doc',workbenchSessionId:'session'},request:heartbeats===1?{requestId:'batch',prompt:'frozen task'}:null}});
    },
    sendMessage(){sends++;return {};},
  };
  const script=[...(await buildV2RelayHtml()).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInNewContext(script,{document:{getElementById:id=>nodes[id]},crypto:{randomUUID:()=> 'card'},__IMVIA_MCP_APP__:app,__IMVIA_MCP_APP_READY__:Promise.resolve(),window:{addEventListener:(name,fn)=>{if(name==='imvia:tool-result')bind=fn;}},setInterval:fn=>{tick=fn;},setTimeout,clearTimeout});
  bind({detail:{structuredContent:{documentId:'doc',workbenchSessionId:'session'}}});
  await new Promise(r=>setImmediate(r));
  const pending=tick();
  await new Promise(r=>setImmediate(r));
  try {
    await tick();
    assert.equal(heartbeats,3);
    assert.equal(receipts,1);
    assert.equal(sends,1);
  } finally {
    rejectReceipt(new Error('receipt unavailable'));
    await pending;
    await new Promise(r=>setImmediate(r));
  }
  assert.match(nodes.connection.textContent,/已连接/);
});

test('relay rehandshakes a broken host transport without replaying its submitted batch', async () => {
  const nodes={state:{textContent:''},connection:{textContent:''},send:{hidden:true,disabled:false}};
  let bind,tick,broken=false,sends=0,closes=0,connects=0,claimed=false;
  const app={
    async callServerTool({name,arguments:args}) {
      if(broken) throw new Error('Transport closed');
      if(name==='get_workbench_v2_confirmation') return {structuredContent:{status:'claimed'}};
      const request=!claimed&&args.claim?{requestId:'batch',prompt:'frozen task'}:null;
      if(request) claimed=true;
      return {structuredContent:{active:true,binding:{documentId:'doc',workbenchSessionId:'session'},request}};
    },
    sendMessage(){sends++;return {};},
    async close(){closes++;},
    async connect(){connects++;broken=false;},
  };
  const script=[...(await buildV2RelayHtml()).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInNewContext(script,{document:{getElementById:id=>nodes[id]},crypto:{randomUUID:()=> 'card'},__IMVIA_MCP_APP__:app,__IMVIA_MCP_APP_READY__:Promise.resolve(),window:{addEventListener:(name,fn)=>{if(name==='imvia:tool-result')bind=fn;}},setInterval:fn=>{tick=fn;},setTimeout,clearTimeout});
  bind({detail:{structuredContent:{documentId:'doc',workbenchSessionId:'session'}}});
  await new Promise(r=>setImmediate(r));
  broken=true;
  await tick();await tick();await tick();await tick();
  assert.equal(connects,1);assert.equal(closes,1);
  assert.equal(sends,1);
  assert.match(nodes.connection.textContent,/已连接/);
});

test('card rejects a legacy heartbeat without document identity instead of showing connected or sending', async () => {
  const nodes={state:{textContent:''},connection:{textContent:''},send:{hidden:true,disabled:false}};
  let bind, sends=0;
  const app={async callServerTool(){return {structuredContent:{active:true,request:{requestId:'batch',prompt:'must not send'}}};},sendMessage(){sends++;}};
  const script=[...(await buildV2RelayHtml()).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInNewContext(script,{document:{getElementById:id=>nodes[id]},crypto:{randomUUID:()=> 'card'},__IMVIA_MCP_APP__:app,__IMVIA_MCP_APP_READY__:Promise.resolve(),window:{addEventListener:(name,fn)=>{if(name==='imvia:tool-result')bind=fn;}},setInterval(){},setTimeout,clearTimeout});
  bind({detail:{structuredContent:{documentId:'doc',workbenchSessionId:'session',workspaceId:'workspace'}}});
  await new Promise(r=>setImmediate(r));
  assert.equal(sends,0);
  assert.match(nodes.state.textContent,/后台版本/);
  assert.doesNotMatch(nodes.connection.textContent,/已连接/);
});

test('a fresh relay card waits empty, follows the first upload, and sends only that workspace batch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-empty-relay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createBridgeRequestStore({ root });
  const binding = await store.bindWorkspace({workspaceId:'fresh-space',workbenchSessionId:'fresh-session',documentId:null});
  const nodes = {state:{textContent:''},binding:{textContent:''},connection:{textContent:''},send:{hidden:true,disabled:false}};
  let onBind, tick;
  const sent = [];
  const app = {
    async callServerTool({name,arguments:args}) {
      if (name === 'get_workbench_v2_confirmation') return {structuredContent:await store.read(args.requestId)};
      const result = await store.pollRelay(args);
      return {structuredContent:{...result,request:result.request ? {...result.request,prompt:'new upload task'} : null}};
    },
    sendMessage(message) { sent.push(message.content[0].text); return {}; },
  };
  const script = [...(await buildV2RelayHtml()).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInNewContext(script, {document:{getElementById:id=>nodes[id]},crypto:{randomUUID:()=> 'card'},
    __IMVIA_MCP_APP__:app,__IMVIA_MCP_APP_READY__:Promise.resolve(),
    window:{addEventListener:(name,fn)=>{onBind=fn;}},setInterval:fn=>{tick=fn;},setTimeout,clearTimeout});
  onBind({detail:{structuredContent:binding}});
  while (!tick) await new Promise(resolve=>setImmediate(resolve));
  assert.match(nodes.state.textContent, /尚无拆分任务/);
  assert.match(nodes.connection.textContent, /已连接/);
  assert.deepEqual(sent, []);
  assert.equal(nodes.send.hidden, true);
  await store.bindWorkspace({...binding,documentId:'uploaded'});
  await tick();
  assert.match(nodes.binding.textContent, /uploaded/);
  await store.create({batchId:'uploaded-batch',envelope:{documentId:'uploaded',workbenchSessionId:'fresh-session'}});
  await store.transition({requestId:'uploaded-batch',expectedStatus:'pending',nextStatus:'claimed'});
  await store.queueRelay('uploaded-batch',{workspaceId:'fresh-space'});
  await tick();
  assert.deepEqual(sent, ['new upload task']);
});

test('card follows a workspace rebind, shows its document, and offers unknown delivery only as manual confirmation', async () => {
  const nodes = { state:{textContent:''}, binding:{textContent:''}, connection:{textContent:''}, send:{hidden:true,disabled:false} };
  let timer, bind, sends=0, phase=0;
  const app = {
    async callServerTool({ name, arguments:args }) {
      if(name==='get_workbench_v2_confirmation') return {structuredContent:{status:'claimed'}};
      if(phase++ === 0) return {structuredContent:{active:true,switched:true,binding:{workspaceId:'workspace',documentId:'doc-new',workbenchSessionId:'session-new',bindingRevision:2},request:null}};
      assert.equal(args.documentId,'doc-new'); assert.equal(args.workbenchSessionId,'session-new');
      return {structuredContent:{active:true,binding:{workspaceId:'workspace',documentId:'doc-new',workbenchSessionId:'session-new',bindingRevision:2},request:null,recoverableRequest:{requestId:'batch',prompt:'same frozen task'}}};
    },
    sendMessage() { sends++; return {}; },
  };
  const script=[...(await buildV2RelayHtml()).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInNewContext(script,{document:{getElementById:id=>nodes[id]},crypto:{randomUUID:()=> 'card'},__IMVIA_MCP_APP__:app,__IMVIA_MCP_APP_READY__:Promise.resolve(),window:{addEventListener:(name,fn)=>{if(name==='imvia:tool-result')bind=fn;}},setInterval:fn=>{timer=fn;},setTimeout,clearTimeout});
  bind({detail:{structuredContent:{documentId:'doc-old',workbenchSessionId:'session-old',workspaceId:'workspace',bindingRevision:1}}});
  await new Promise(r=>setImmediate(r));
  await timer();
  assert.match(nodes.binding.textContent,/doc-new/);
  assert.equal(sends,0);
  assert.equal(nodes.send.hidden,false);
  assert.match(nodes.state.textContent,/回执/);
  nodes.send.onclick();
  await new Promise(r=>setImmediate(r));
  assert.equal(sends,1);
});

test('late host rejection cannot reenable a card that lost its listening lease', async () => {
  const nodes={state:{textContent:''},send:{hidden:true,disabled:false}};
  let bind,timer,rejectSend,sends=0,active=true,claimed=false;
  const binding={documentId:'doc',workbenchSessionId:'session'};
  const app={async callServerTool(){const request=claimed?null:{requestId:'batch',prompt:'task'};claimed=true;return {structuredContent:{active,binding,request}};},sendMessage(){sends++;return new Promise((_,reject)=>{rejectSend=reject;});}};
  const script=[...(await buildV2RelayHtml()).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInNewContext(script,{document:{getElementById:id=>nodes[id]},crypto:{randomUUID:()=> 'card'},__IMVIA_MCP_APP__:app,__IMVIA_MCP_APP_READY__:Promise.resolve(),window:{addEventListener:(name,fn)=>{if(name==='imvia:tool-result')bind=fn;}},setInterval:fn=>{timer=fn;},setTimeout,clearTimeout});
  bind({detail:{structuredContent:binding}});
  await new Promise(r=>setImmediate(r));
  active=false; await timer();
  rejectSend(new Error('late rejection')); await new Promise(r=>setImmediate(r));
  assert.equal(nodes.send.disabled,true);
  nodes.send.onclick(); assert.equal(sends,1);
});
