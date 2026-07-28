import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('the MCP app resource allows the local workbench iframe', async () => {
  const serverSource = await readFile(
    path.resolve(import.meta.dirname, '..', 'layer-review-mcp-server.mjs'),
    'utf8',
  );

  assert.match(serverSource, /ui:\/\/layer-review\/workbench-v2\.html/);
  assert.match(serverSource, /frameDomains:\s*\['http:\/\/127\.0\.0\.1:4173'\]/);
  assert.match(serverSource, /open_layer_review_workbench/);
});
