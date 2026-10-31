import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./PosterPlanReview.jsx', import.meta.url), 'utf8');

test('poster plan review exposes evidence and ownership fields', () => {
  assert.match(source, /来源证据/);
  assert.match(source, /遮挡关系/);
  assert.match(source, /锁定可见锚点/);
  assert.match(source, /修复范围/);
});

test('review identifies reorder controls by layer and announces blocking validation errors', () => {
  assert.match(source, /aria-label=\{`将 \$\{layer\.layer_name\} 上移`\}/);
  assert.match(source, /aria-label=\{`将 \$\{layer\.layer_name\} 下移`\}/);
  assert.match(source, /role="alert"/);
  assert.match(source, /reviewUi\.errors/);
});

test('review disables confirmation while poster validation has errors', () => {
  assert.match(source, /确认海报计划/);
  assert.match(source, /disabled=\{!reviewUi\.canConfirm\}/);
});
