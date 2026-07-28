import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('the MCP app resource is a compact bridge without a nested frame', async () => {
  const serverSource = await readFile(
    path.resolve(import.meta.dirname, '..', 'layer-review-mcp-server.mjs'),
    'utf8',
  );

  assert.match(serverSource, /ui:\/\/layer-review\/conversation-bridge-v3\.html/);
  assert.doesNotMatch(serverSource, /frameDomains:/);
  assert.match(serverSource, /connect_layer_review_workbench/);
  assert.doesNotMatch(serverSource, /open_layer_review_workbench/);
});
