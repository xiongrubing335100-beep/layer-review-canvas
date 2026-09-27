import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  buildBridgeWidgetHtml,
  buildV2ConfirmationProbeHtml,
  buildWorkbenchDevWidgetHtml,
  buildWorkbenchWidgetHtml,
} from './mcp-bridge-resource.js';

test('V2 resource preserves executable syntax of every inline script including the SDK', () => {
  const scripts = [...buildV2ConfirmationProbeHtml().matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 3);
  for (const [index, script] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(script[1]), `inline script ${index} must parse`);
  }
});

test('the MCP resource inlines the built workbench assets', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-widget-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const assetsDirectory = path.join(directory, 'assets');
  await mkdir(assetsDirectory);
  const htmlPath = path.join(directory, 'index.html');
  await writeFile(
    htmlPath,
    '<html><head><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div></body></html>',
  );
  await writeFile(
    path.join(assetsDirectory, 'app.js'),
    'window.workbenchReady = true; "value".replace(/value/, "$&");',
  );
  await writeFile(path.join(assetsDirectory, 'app.css'), '.workbench { display: grid; }');

  const html = await buildWorkbenchWidgetHtml(htmlPath);

  assert.match(html, /<base href="http:\/\/127\.0\.0\.1:4173\/">/);
  assert.match(html, /window\.workbenchReady = true/);
  assert.match(html, /__IMVIA_MCP_APPS__/);
  assert.match(html, /__IMVIA_MCP_APP_READY__/);
  assert.match(html, /app\.sendMessage/);
  assert.match(html, /app\.requestDisplayMode/);
  assert.match(html, /availableDisplayModes: \['inline', 'fullscreen'\]/);
  assert.match(html, /replace\(\/value\/, "\$&"\)/);
  assert.match(html, /\.workbench \{ display: grid; \}/);
  assert.doesNotMatch(html, /src="\/assets\/app\.js"/);
  assert.doesNotMatch(html, /href="\/assets\/app\.css"/);
});

test('the development MCP resource loads the live Vite workbench source', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dev-widget-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const htmlPath = path.join(directory, 'index.html');
  await writeFile(
    htmlPath,
    '<html><head></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
  );

  const html = await buildWorkbenchDevWidgetHtml(htmlPath);

  assert.match(html, /<base href="http:\/\/127\.0\.0\.1:4173\/">/);
  assert.match(html, /http:\/\/127\.0\.0\.1:4173\/@vite\/client/);
  assert.match(html, /http:\/\/127\.0\.0\.1:4173\/src\/main\.jsx/);
  assert.match(html, /__IMVIA_MCP_APPS__/);
  assert.match(html, /__IMVIA_MCP_APP_READY__/);
  assert.match(html, /ui\/initialize/);
  assert.match(html, /sendFollowUpMessage/);
  assert.doesNotMatch(html, /src="\/src\/main\.jsx"/);
});

test('the real MCP resource contains only the lightweight conversation bridge', async () => {
  const rootDirectory = path.resolve(import.meta.dirname, '..');
  const html = await buildBridgeWidgetHtml(
    path.join(rootDirectory, 'public', 'layer-review-bridge-widget.html'),
    path.join(rootDirectory, 'public', 'layer-review-bridge-widget.js'),
  );

  assert.match(html, /data-bridge-status/);
  assert.match(html, /<button[^>]*data-bridge-send/);
  assert.match(html, /ui\/message/);
  assert.match(html, /tools\/call/);
  assert.match(html, /register_layer_review_conversation_bridge/);
  assert.match(html, /get_layer_review_foreground_dispatch/);
  assert.match(html, /mark_layer_review_foreground_dispatch_delivered/);
  assert.match(html, /release_layer_review_foreground_dispatch_claim/);
  assert.doesNotMatch(html, /acknowledge_layer_review_foreground_dispatch/);
  assert.match(html, /http:\/\/127\.0\.0\.1:4173\/api\/layer-review\/workbench-session/);
  assert.doesNotMatch(html, /__LAYER_REVIEW_BRIDGE_SCRIPT__/);
  assert.doesNotMatch(html, /<iframe/i);
});
