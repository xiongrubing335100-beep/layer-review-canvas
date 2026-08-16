import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('all MCP workbench submissions post directly to the current conversation', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const [viteSource, hostSource, clientSource, mainSource, bridgeSource, widgetSource] = await Promise.all([
    readFile(path.join(root, 'vite.config.js'), 'utf8'),
    readFile(path.join(root, 'src', 'mcp-workbench-host.js'), 'utf8'),
    readFile(path.join(root, 'src', 'mcp-app-client.js'), 'utf8'),
    readFile(path.join(root, 'src', 'main.jsx'), 'utf8'),
    readFile(path.join(root, 'codex-thread-bridge.mjs'), 'utf8'),
    readFile(path.join(root, 'public', 'layer-review-bridge-widget.js'), 'utf8'),
  ]);

  assert.match(hostSource, /submit_layer_review_job/);
  assert.match(hostSource, /delivery: 'current_conversation'/);
  assert.match(hostSource, /mark_layer_review_message_sent/);
  assert.match(hostSource, /mark_layer_review_message_failed/);
  assert.doesNotMatch(clientSource, /method: 'ui\/message'/);
  assert.match(clientSource, /method: 'tools\/call'/);
  assert.match(clientSource, /sendFollowUpMessage/);
  assert.doesNotMatch(bridgeSource, /turn\/start/);
  assert.doesNotMatch(bridgeSource, /sendPlanToCurrentThread/);
  assert.match(widgetSource, /method: 'ui\/message'/);
  assert.match(widgetSource, /mode: 'ui_message'/);
  assert.doesNotMatch(widgetSource, /sendFollowUpMessage/);

  assert.match(viteSource, /enqueueForegroundDispatch/);
  assert.match(viteSource, /directConversation/);
  assert.match(viteSource, /markDirectConversationMessageSent/);
  assert.doesNotMatch(viteSource, /send-to-current-task/);
  assert.doesNotMatch(hostSource, /send-to-current-task/);
  assert.match(mainSource, /sendMcpAppFollowUpMessage/);
  assert.match(mainSource, /markLayerReviewMessageSent/);
  assert.match(mainSource, /markLayerReviewMessageFailed/);
  assert.match(viteSource, /workbench-session/);
  assert.match(viteSource, /delivery_channel: deliveryMode/);
  assert.doesNotMatch(viteSource, /if \(blockingJob && directConversation\)/);
  assert.match(viteSource, /if \(!directConversation \|\| queued\)/);
  assert.match(viteSource, /image_id: plan\.image_id/);
  assert.match(viteSource, /prompt,/);
  assert.match(mainSource, /host_accepted/);
  assert.match(mainSource, /cancelableDeliveryStatuses/);
  assert.match(mainSource, /已就绪/);
});
