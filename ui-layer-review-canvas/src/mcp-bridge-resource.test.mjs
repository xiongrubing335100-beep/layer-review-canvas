import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildBridgeWidgetHtml } from './mcp-bridge-resource.js';

test('the MCP resource inlines the conversation bridge script', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-widget-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const htmlPath = path.join(directory, 'widget.html');
  const scriptPath = path.join(directory, 'widget.js');
  await writeFile(htmlPath, '<script>/*__LAYER_REVIEW_BRIDGE_SCRIPT__*/</script>');
  await writeFile(scriptPath, 'window.bridgeReady = true;');

  const html = await buildBridgeWidgetHtml(htmlPath, scriptPath);

  assert.equal(html.includes('/*__LAYER_REVIEW_BRIDGE_SCRIPT__*/'), false);
  assert.equal(html.includes('window.bridgeReady = true;'), true);
});
