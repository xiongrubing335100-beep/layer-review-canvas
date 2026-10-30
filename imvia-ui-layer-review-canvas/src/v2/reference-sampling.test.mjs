import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleReferenceRgba } from './reference-sampling.js';

test('non-integer reduction integrates complete source-pixel footprints on both axes', () => {
  const row = Buffer.from([0,0,0,255, 120,120,120,255, 240,240,240,255]);
  const expected = Buffer.from([40,40,40,255, 200,200,200,255]);
  assert.deepEqual(sampleReferenceRgba(row, 3, 1, 2, 1), expected);
  assert.deepEqual(sampleReferenceRgba(row, 1, 3, 1, 2), expected);
});

test('enlargement interpolates source centers without a half-pixel shift or hard steps', () => {
  const pixels = Buffer.from([0,0,0,255, 255,255,255,255]);
  const expected = Buffer.from([0,0,0,255, 64,64,64,255, 191,191,191,255, 255,255,255,255]);
  assert.deepEqual(sampleReferenceRgba(pixels, 2, 1, 4, 1), expected);
  assert.deepEqual(sampleReferenceRgba(pixels, 1, 2, 1, 4), expected);
});

test('hidden source RGB cannot bleed into a partially covered reference pixel', () => {
  const pixels = Buffer.from([255,0,0,0, 0,0,255,255]);
  assert.deepEqual(sampleReferenceRgba(pixels, 2, 1, 1, 1), Buffer.from([0,0,255,128]));
  assert.deepEqual(pixels, Buffer.from([255,0,0,0, 0,0,255,255]), 'input must remain immutable');
});

test('one-to-one reference pixels retain source RGBA exactly', () => {
  const pixels = Buffer.from([18,27,35,128, 41,55,79,255]);
  assert.deepEqual(sampleReferenceRgba(pixels, 2, 1, 2, 1), pixels);
});
