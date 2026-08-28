import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { storePosterSource } from './poster-source-store.js';

test('stores valid PNG bytes under a server-owned safe path', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-source-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const png = await readFile(path.resolve('public/demo-source.png'));

  const stored = await storePosterSource({ outputRoot: root, bytes: png });

  assert.match(stored.sourcePath, /^output\/poster-sources\/source-[a-z0-9-]+\.png$/);
  assert.equal(stored.width > 0, true);
  assert.equal(stored.height > 0, true);
});

test('rejects invalid payloads and caller-controlled paths', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-source-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(storePosterSource({ outputRoot: root, bytes: Buffer.from('not a png') }), /PNG/);
  await assert.rejects(storePosterSource({ outputRoot: root, bytes: Buffer.from('x'), sourcePath: '../../escape.png' }), /path/);
});
