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
