import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildWorkbenchWidgetHtml } from './mcp-bridge-resource.js';

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
  await writeFile(path.join(assetsDirectory, 'app.js'), 'window.workbenchReady = true;');
  await writeFile(path.join(assetsDirectory, 'app.css'), '.workbench { display: grid; }');

  const html = await buildWorkbenchWidgetHtml(htmlPath);

  assert.match(html, /<base href="http:\/\/127\.0\.0\.1:4173\/">/);
  assert.match(html, /window\.workbenchReady = true/);
  assert.match(html, /\.workbench \{ display: grid; \}/);
  assert.doesNotMatch(html, /src="\/assets\/app\.js"/);
  assert.doesNotMatch(html, /href="\/assets\/app\.css"/);
});

test('the real MCP resource contains the full Layer Review workbench', async () => {
  const rootDirectory = path.resolve(import.meta.dirname, '..');
  const html = await buildWorkbenchWidgetHtml(path.join(rootDirectory, 'dist', 'index.html'));

  assert.match(html, /Layer Review Canvas/);
  assert.match(html, /id="root"/);
  assert.doesNotMatch(html, /data-bridge-status/);
  assert.doesNotMatch(html, /data-workbench-frame/);
  assert.doesNotMatch(html, /<iframe/i);
});
