import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the documented setup command installs JavaScript dependencies before the RMBG runtime', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(manifest.scripts.setup, /^npm install && node scripts\/setup-imvia-layer\.mjs$/);
});
