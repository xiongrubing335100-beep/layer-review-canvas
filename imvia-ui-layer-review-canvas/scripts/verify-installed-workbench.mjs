// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const pluginRoot = process.env.IMVIA_LAYER_PLUGIN_DIRECTORY || path.join(os.homedir(), 'plugins', 'imvia-layer');
const runtime = JSON.parse(await readFile(path.join(pluginRoot, 'imvia-layer-runtime.json'), 'utf8'));
const configuration = JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8')).mcpServers['imvia-layer'];
const ownerPath = path.join(runtime.workbenchRoot, 'output', 'workbench-runtime', 'manager-owner.json');
const readOwner = () => readFile(ownerPath, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const previousOwner = await readOwner();
const startedAt = Date.now();
const client = new Client({ name: 'installed-workbench-verification', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ ...configuration, stderr: 'inherit' }));
  const result = await client.callTool({ name: 'open_workbench_v2', arguments: { mode: 'new' } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const opened = result.structuredContent;
  assert.equal(opened?.state, 'ready');
  assert.equal(opened.bridgeProtocolVersion, 2);
  const url = new URL(opened.workbenchUrl);
  assert.equal(url.origin, 'http://127.0.0.1:4173');
  assert.equal(url.searchParams.get('workbench'), 'v2');
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id=["']root["']/);
  process.stdout.write('installed V2 MCP launch and workbench HTTP opening verified\n');
} finally {
  await client.close();
  const owner = await readOwner();
  // Shut down only the manager started by this isolated smoke check.
  if (owner?.pid !== previousOwner?.pid && Date.parse(owner?.startedAt) >= startedAt) {
    try { process.kill(owner.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
