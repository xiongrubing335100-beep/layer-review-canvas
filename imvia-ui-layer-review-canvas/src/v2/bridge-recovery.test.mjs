import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeRecovery, bridgeReceiptDeadline } from './bridge-recovery.js';

test('an old unacknowledged reconnect request does not restart the connection spinner', () => {
  assert.equal(bridgeReceiptDeadline({online:false,reconnectRequestedAt:1000},2000),11000);
  assert.equal(bridgeReceiptDeadline({online:false,reconnectRequestedAt:1000},12000),0);
  assert.equal(bridgeReceiptDeadline({online:true,reconnectRequestedAt:1000},2000),0);
  assert.equal(bridgeReceiptDeadline({online:false,autoReconnectBlocked:true,reconnectRequestedAt:1000},2000),0);
});

test('offline current document reconnects automatically and returns only the real server status', async () => {
  const calls = [];
  const acknowledgement = {online:false,reason:'reconnecting',reconnecting:true};
  const recovery = createBridgeRecovery({documentId:'doc',workspaceId:'workspace',api:{
    async reconnectBridge(...args) {calls.push(args);return acknowledgement;},
  }});
  assert.deepEqual(await recovery.recover({online:false,reason:'binding_mismatch'}), acknowledgement);
  assert.deepEqual(calls,[['doc','workspace',{automatic:true}]]);
});

test('recovery backs off across missing card receipts and resets after a real connection', async () => {
  let time=100000, calls=0;
  const recovery=createBridgeRecovery({documentId:'doc',workspaceId:'workspace',now:()=>time,api:{
    async reconnectBridge(){calls++;return {online:false,reconnecting:true};},
  }});
  const offline={online:false,reason:'heartbeat_expired'};
  await recovery.recover(offline);
  await recovery.recover(offline);
  time+=9999; await recovery.recover(offline);
  assert.equal(calls,1,'polling must not repeatedly reset the pending connection receipt');
  time++; await recovery.recover(offline); assert.equal(calls,2);
  time+=10000; await recovery.recover(offline); assert.equal(calls,2);
  time+=10000; await recovery.recover(offline); assert.equal(calls,3);
  await recovery.recover({online:true});
  await recovery.recover(offline); assert.equal(calls,4);
});

test('background, empty, or superseded documents never seize the bridge', async () => {
  const api={async reconnectBridge(){assert.fail('must not reconnect');}};
  await createBridgeRecovery({api,documentId:null,workspaceId:'workspace'}).recover({online:false});
  const recovery=createBridgeRecovery({api,documentId:'doc',workspaceId:'workspace'});
  await recovery.recover({online:false},{visible:false});
  await recovery.recover({online:false,autoReconnectBlocked:true});
});

test('failed requests back off and a late response cannot revive an unmounted document', async () => {
  let time=100000, calls=0, resolve;
  const recovery=createBridgeRecovery({documentId:'doc',workspaceId:'workspace',now:()=>time,api:{
    async reconnectBridge(){calls++;if(calls===1)throw new Error('offline');return new Promise(done=>{resolve=done;});},
  }});
  await assert.rejects(recovery.recover({online:false}),/offline/);
  assert.equal(await recovery.recover({online:false}),null);
  assert.equal(calls,1);
  time+=10000;
  const pending=recovery.recover({online:false});
  assert.equal(await recovery.recover({online:false}),null);
  recovery.stop(); resolve({online:true});
  assert.equal(await pending,null);
  time+=60000; assert.equal(await recovery.recover({online:false}),null);
  assert.equal(calls,2);
});
