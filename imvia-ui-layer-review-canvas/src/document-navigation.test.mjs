import assert from 'node:assert/strict';
import test from 'node:test';
import { documentNavigationItems } from './document-navigation.js';

test('shared document navigation keeps a poster selectable while a UI image is active', () => {
  const items = documentNavigationItems([
    { imageId: 'poster', sourceName: 'poster.png', documentMode: 'poster' },
    { imageId: 'ui', sourceName: 'ui.png', documentMode: 'ui' },
  ], 'ui');

  assert.deepEqual(items, [
    { imageId: 'poster', label: 'poster.png', mode: 'poster', active: false },
    { imageId: 'ui', label: 'ui.png', mode: 'ui', active: true },
  ]);
});
