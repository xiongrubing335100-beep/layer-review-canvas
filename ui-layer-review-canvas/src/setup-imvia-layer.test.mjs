import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('setup selects a supported cross-platform Python before it registers the plugin', async () => {
  const source = await readFile(path.join(root, 'scripts', 'setup-imvia-layer.mjs'), 'utf8');
  assert.match(source, /PYTHON/);
  assert.match(source, /python3/);
  assert.match(source, /command: 'py'/);
  assert.match(source, /Python 3\.10\+/);
  assert.ok(source.indexOf('scripts/warm-rmbg.py') < source.indexOf('scripts/install-codex-plugin.mjs'));
});

test('installed plugin receives the selected Python runtime for later task prompts', async () => {
  const [installer, starter] = await Promise.all([
    readFile(path.join(root, 'scripts', 'install-codex-plugin.mjs'), 'utf8'),
    readFile(path.join(root, 'plugin-template', 'imvia-layer', 'scripts', 'start-mcp.mjs'), 'utf8'),
  ]);
  assert.match(installer, /IMVIA_LAYER_PYTHON_COMMAND/);
  assert.match(installer, /python: installedPythonRuntime\(\)/);
  assert.match(starter, /IMVIA_LAYER_PYTHON_COMMAND/);
  assert.match(starter, /IMVIA_LAYER_PYTHON_ARGS/);
});

test('the documented setup command installs JavaScript dependencies before the RMBG runtime', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(manifest.scripts.setup, /^npm install && node scripts\/setup-imvia-layer\.mjs$/);
});
