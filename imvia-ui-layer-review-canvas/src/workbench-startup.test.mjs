import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createInitialWorkbenchState } from './workbench-state.js';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the default dev command starts the embedded workbench App', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(rootDirectory, 'package.json'), 'utf8'),
  );
  const launcherSource = await readFile(
    path.join(rootDirectory, 'scripts', 'start-workbench.mjs'),
    'utf8',
  ).catch(() => '');

  assert.equal(packageJson.scripts.dev, 'node scripts/start-workbench.mjs');
  assert.match(launcherSource, /node_modules.*vite.*bin.*vite\.js/s);
  assert.match(launcherSource, /IMVIA_WORKBENCH_SESSION_ID/);
  assert.match(launcherSource, /randomUUID/);
  assert.match(launcherSource, /workbench/);
  assert.match(launcherSource, /embedded_app/);
  assert.match(launcherSource, /windowsHide: true/);
  assert.doesNotMatch(launcherSource, /layer-review-mcp-server\.mjs/);
  assert.doesNotMatch(launcherSource, /IMVIA_CURRENT_TASK_LISTENER/);
  assert.doesNotMatch(launcherSource, /--stdio/);
});

test('the managed workbench reuses its session ID in the Vite server', async () => {
  const viteSource = await readFile(path.join(rootDirectory, 'vite.config.js'), 'utf8');

  assert.match(viteSource, /process\.env\.IMVIA_WORKBENCH_SESSION_ID \|\| crypto\.randomUUID\(\)/);
});

test('the MCP opener delegates startup to the single lifecycle owner', async () => {
  const mcpServerSource = await readFile(
    path.join(rootDirectory, 'layer-review-mcp-server.mjs'),
    'utf8',
  );

  assert.match(mcpServerSource, /scripts.*start-workbench\.mjs/s);
  assert.match(mcpServerSource, /embedded_app/);
  assert.match(mcpServerSource, /windowsHide: true/);
  assert.doesNotMatch(mcpServerSource, /IMVIA_CURRENT_TASK_LISTENER/);
  assert.doesNotMatch(mcpServerSource, /mcp_app_pending/);
  assert.doesNotMatch(mcpServerSource, /IMVIA_SKIP_MCP_BRIDGE/);
  assert.doesNotMatch(
    mcpServerSource.match(/async function ensureWorkbenchRunning\(\)[\s\S]*?\n}/)?.[0] || '',
    /node_modules.*vite.*bin.*vite\.js/s,
  );
});

test('the workbench opens without a demo image or prefilled split items', () => {
  assert.deepEqual(createInitialWorkbenchState(), {
    sourceImage: '',
    sourceDataUrl: '',
    sourceName: '',
    sourceSize: { width: 0, height: 0 },
    nodes: [],
    selectedId: '',
  });
});
