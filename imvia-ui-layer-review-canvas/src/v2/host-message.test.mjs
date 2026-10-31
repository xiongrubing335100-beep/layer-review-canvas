import assert from 'node:assert/strict';
import test from 'node:test';
import { sendVisibleWorkbenchMessage } from './host-message.js';

test('uses the connected Codex follow-up channel and does not call a message sent before host acceptance', async () => {
  const sent = [];
  const environment = { window: { openai: { async sendFollowUpMessage(input) { sent.push(input); return {}; } } } };
  assert.deepEqual(await sendVisibleWorkbenchMessage('frozen batch', environment), { accepted: true, channel: 'send_follow_up_message' });
  assert.equal(sent[0].prompt, 'frozen batch');
  assert.equal(sent[0].scrollToBottom, true);
});

test('uses the MCP App channel and reports unavailable or rejected hosts without silent success', async () => {
  const environment = { __IMVIA_MCP_APP__: { async sendMessage(input) { assert.equal(input.content[0].text, 'task'); return { isError: true }; } } };
  await assert.rejects(sendVisibleWorkbenchMessage('task', environment), /HOST_MESSAGE_REJECTED/);
  await assert.rejects(sendVisibleWorkbenchMessage('task', {}), error => error.code === 'HOST_MESSAGE_UNAVAILABLE');
});

test('standalone page queues the exact batch through its visible conversation relay', async () => {
  const window = {}; window.parent = window;
  const queued = [];
  const result = await sendVisibleWorkbenchMessage('task', { window }, { batchId: 'batch-one',
    queueRelay: async id => { queued.push(id); return { queued: true }; } });
  assert.deepEqual(queued, ['batch-one']);
  assert.deepEqual(result, { accepted: false, queued: true, channel: 'conversation_bridge' });
});

test('an unresponsive parent times out and removes its listener instead of hanging or sending by another channel', async () => {
  const listeners = new Set(); let posts = 0, queued = 0;
  const window = { parent:{postMessage(){posts++;}},addEventListener:(name,fn)=>listeners.add(fn),removeEventListener:(name,fn)=>listeners.delete(fn) };
  await assert.rejects(sendVisibleWorkbenchMessage('task',{window},{timeoutMs:5,queueRelay:async()=>{queued++;}}), /HOST_MESSAGE_TIMEOUT/);
  assert.equal(listeners.size,0); assert.equal(posts,1); assert.equal(queued,0);
});
