import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUiMessageRequest,
  deliverSplitPrompt,
} from './mcp-workbench-host.js';

test('the workbench sends the confirmed split prompt through the current MCP App conversation', async () => {
  const requests = [];
  const acknowledgements = [];
  const delivered = await deliverSplitPrompt({
    jobId: 'layer-job-1',
    prompt: 'split this confirmed layer',
    request: async (method, params) => {
      requests.push({ method, params });
      return {};
    },
    acknowledge: async (jobId) => acknowledgements.push(jobId),
  });

  assert.equal(delivered, true);
  assert.deepEqual(requests, [{
    method: 'ui/message',
    params: {
      role: 'user',
      content: [{ type: 'text', text: 'split this confirmed layer' }],
    },
  }]);
  assert.deepEqual(acknowledgements, ['layer-job-1']);
});

test('the workbench does not acknowledge a job when no current conversation is connected', async () => {
  let acknowledged = false;
  const delivered = await deliverSplitPrompt({
    jobId: 'layer-job-2',
    prompt: 'split this confirmed layer',
    request: null,
    acknowledge: async () => {
      acknowledged = true;
    },
  });

  assert.equal(delivered, false);
  assert.equal(acknowledged, false);
});

test('the MCP Apps request uses the foreground ui/message method', () => {
  assert.deepEqual(buildUiMessageRequest('split this layer', 9), {
    jsonrpc: '2.0',
    id: 9,
    method: 'ui/message',
    params: {
      role: 'user',
      content: [{ type: 'text', text: 'split this layer' }],
    },
  });
});
