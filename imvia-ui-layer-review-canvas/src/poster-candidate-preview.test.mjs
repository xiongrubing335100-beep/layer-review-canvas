import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readSafePosterCandidatePreview } from './poster-candidate-preview.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-preview-'));
  const candidates = path.join(root, 'candidates');
  await mkdir(candidates);
  const png = path.join(candidates, 'candidate.png');
  await writeFile(png, PNG);
  return { root, candidates, png };
}

test('reads only a regular PNG inside the exact candidates directory', async () => {
  const { candidates, png } = await fixture();
  assert.deepEqual(await readSafePosterCandidatePreview({ candidatesRoot: candidates, candidatePath: png }), PNG);
});

for (const [name, prepare] of [
  ['symlink candidate', async ({ candidates, png }) => {
    const link = path.join(candidates, 'linked.png'); await symlink(png, link); return link;
  }],
  ['wrong extension', async ({ candidates }) => {
    const target = path.join(candidates, 'candidate.txt'); await writeFile(target, PNG); return target;
  }],
  ['wrong file type', async ({ candidates }) => {
    const target = path.join(candidates, 'directory.png'); await mkdir(target); return target;
  }],
  ['intermediate symlink escape', async ({ root, candidates }) => {
    const outside = path.join(root, 'outside'); await mkdir(outside); const outsidePng = path.join(outside, 'candidate.png'); await writeFile(outsidePng, PNG);
    const link = path.join(candidates, 'escaped'); await symlink(outside, link); return path.join(link, 'candidate.png');
  }],
]) {
  test(`rejects ${name}`, async () => {
    const context = await fixture();
    const candidatePath = await prepare(context);
    await assert.rejects(readSafePosterCandidatePreview({ candidatesRoot: context.candidates, candidatePath }), /候选|PNG|安全|允许/i);
  });
}
