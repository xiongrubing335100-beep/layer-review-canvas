import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('the MCP app serves the full workbench through current and cached resource URIs', async () => {
  const serverSource = await readFile(
    path.resolve(import.meta.dirname, '..', 'layer-review-mcp-server.mjs'),
    'utf8',
  );

  assert.match(serverSource, /ui:\/\/layer-review\/workbench-v4\.html/);
  assert.match(serverSource, /ui:\/\/layer-review\/conversation-bridge-v3\.html/);
  assert.match(serverSource, /ui:\/\/layer-review\/workbench-v2\.html/);
  assert.doesNotMatch(serverSource, /frameDomains:/);
  assert.match(serverSource, /connect_layer_review_workbench/);
  assert.match(serverSource, /open_layer_review_workbench/);
});
