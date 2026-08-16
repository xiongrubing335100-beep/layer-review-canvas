import test from 'node:test';
import assert from 'node:assert/strict';

import { resultPreviewMaxWidth } from './result-preview-sizing.js';


test('small result previews stay at their native pixel width', () => {
  assert.equal(resultPreviewMaxWidth({ width: 177, height: 87 }, 300), 177);
});

test('large result previews still fit within the existing height limit', () => {
  assert.equal(resultPreviewMaxWidth({ width: 900, height: 450 }, 300), 600);
});

test('result previews without a height limit still refuse to upscale past native width', () => {
  assert.equal(resultPreviewMaxWidth({ width: 177, height: 87 }), 177);
});
