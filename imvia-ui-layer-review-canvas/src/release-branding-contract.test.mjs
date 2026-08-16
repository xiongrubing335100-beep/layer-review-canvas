import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const bridge = await readFile(new URL('../codex-thread-bridge.mjs', import.meta.url), 'utf8');

test('the application uses its final Imvia package identity', () => {
  assert.equal(packageJson.name, 'imvia-ui-layer-review-canvas');
  assert.equal(packageLock.name, 'imvia-ui-layer-review-canvas');
  assert.equal(packageLock.packages[''].name, 'imvia-ui-layer-review-canvas');
  assert.match(bridge, /clientInfo:\s*\{ name: 'imvia-ui-layer-review-canvas'/);
  assert.doesNotMatch(bridge, /name: 'ui-layer-review-canvas'/);
});
