import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('the MCP tool returns a right-panel browser URL and mounts the conversation bridge', async () => {
  const serverSource = await readFile(
    path.resolve(import.meta.dirname, '..', 'layer-review-mcp-server.mjs'),
    'utf8',
  );

  assert.match(serverSource, /ui:\/\/imvia-layer\/workbench-v1\.html/);
  assert.match(serverSource, /buildBridgeWidgetHtml/);
  assert.match(serverSource, /buildWorkbenchWidgetHtml/);
  assert.match(serverSource, /path\.join\(rootDirectory, 'dist', 'index\.html'\)/);
  assert.match(serverSource, /widgetResourceDomains = \[workbenchDomain, 'data:', 'blob:'\]/);
  assert.match(serverSource, /ui:\/\/imvia-layer\/conversation-bridge-v20\.html/);
  assert.match(serverSource, /path\.join\(rootDirectory, 'public', 'layer-review-bridge-widget\.html'\)/);
  assert.match(serverSource, /path\.join\(rootDirectory, 'public', 'layer-review-bridge-widget\.js'\)/);
  assert.doesNotMatch(serverSource, /frameDomains:/);
  assert.match(serverSource, /connect_layer_review_workbench/);
  assert.match(serverSource, /open_layer_review_workbench/);
  assert.match(serverSource, /submit_layer_review_job/);
  assert.match(serverSource, /get_layer_review_job/);
  assert.match(serverSource, /cancel_layer_review_job/);
  assert.match(serverSource, /confirm_layer_review_foreground_dispatch/);
  assert.match(serverSource, /register_layer_review_conversation_bridge/);
  assert.match(serverSource, /heartbeat_layer_review_conversation_bridge/);
  assert.match(serverSource, /get_layer_review_foreground_dispatch/);
  assert.match(serverSource, /mark_layer_review_foreground_dispatch_delivered/);
  assert.match(serverSource, /release_layer_review_foreground_dispatch_claim/);
  assert.match(serverSource, /resourceUri: bridgeWidgetUri/);
  assert.match(serverSource, /openai\/outputTemplate.*bridgeWidgetUri/s);
  assert.match(serverSource, /workbenchUrl: z\.string/);
  assert.match(serverSource, /workbenchUrl: `\$\{workbenchOrigin\}\/\?open=/);
  assert.match(serverSource, /resetWorkbenchForOpen/);
  assert.doesNotMatch(serverSource, /mode: z\.literal\('native_canvas'\)/);
  assert.doesNotMatch(serverSource, /rendering: z\.literal\('native_widget'\)/);
  assert.match(serverSource, /codex_app__open_in_codex/);
  assert.match(serverSource, /workbenchSessionId/);
  assert.match(serverSource, /\/api\/layer-review\/workbench-session/);
  assert.match(serverSource, /visibility: \['model', 'app'\]/);
  assert.match(serverSource, /visibility: \['app'\]/);
  assert.match(serverSource, /acknowledgeForegroundDispatch/);
  assert.doesNotMatch(serverSource, /x-imvia-delivery-mode/);
  assert.match(serverSource, /delivery_channel: z\.enum\(\['current_conversation', 'conversation_bridge', 'conversation_queue'\]\)/);
  assert.match(serverSource, /mark_layer_review_message_sent/);
  assert.match(serverSource, /mark_layer_review_message_failed/);
  assert.match(serverSource, /windowsHide: true/);
  assert.doesNotMatch(serverSource, /IMVIA_CURRENT_TASK_LISTENER/);
  assert.doesNotMatch(serverSource, /mcp_app_pending/);
  assert.doesNotMatch(serverSource, /IMVIA_SKIP_MCP_BRIDGE/);
  assert.match(serverSource, /StdioServerTransport/);
  assert.match(serverSource, /--stdio/);
  assert.match(serverSource, /ensureWorkbenchRunning/);
  assert.match(serverSource, /await ensureWorkbenchRunning\(\)/);
});
