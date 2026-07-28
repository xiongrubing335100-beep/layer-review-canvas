import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUiMessageRequest } from '../public/layer-review-bridge-widget.js';

test('the bridge posts a user message through the MCP Apps foreground channel', () => {
  assert.deepEqual(buildUiMessageRequest('split this layer', 7), {
    jsonrpc: '2.0',
    id: 7,
    method: 'ui/message',
    params: {
      role: 'user',
      content: [{ type: 'text', text: 'split this layer' }],
    },
  });
});
