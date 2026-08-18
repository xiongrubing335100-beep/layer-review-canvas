import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeFastCategories } from './fast-category-analysis.js';

function createImage(width, height, background = [238, 238, 238, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data.set(background, index * 4);
  }
  return { data, width, height };
}

function fillRect(image, x, y, width, height, color) {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      image.data.set(color, (row * image.width + column) * 4);
    }
  }
}

test('fast category analysis returns the five editable UI categories with bounded rough regions', () => {
  const image = createImage(48, 96);
  fillRect(image, 6, 5, 36, 10, [35, 35, 35, 255]);
  fillRect(image, 8, 22, 32, 24, [235, 70, 155, 255]);
  fillRect(image, 6, 54, 36, 8, [80, 80, 80, 255]);
  fillRect(image, 4, 70, 40, 18, [65, 135, 235, 255]);

  const suggestions = analyzeFastCategories(image);

  assert.deepEqual(
    suggestions.map((item) => item.category),
    ['kvTitle', 'kvElement', 'kvBackground', 'ordinaryText', 'uiComponent'],
  );
  assert.deepEqual(suggestions[2].bounds, { x: 0, y: 0, width: 100, height: 100 });
  suggestions.forEach(({ bounds }) => {
    assert.ok(bounds.x >= 0 && bounds.y >= 0);
    assert.ok(bounds.width > 0 && bounds.height > 0);
    assert.ok(bounds.x + bounds.width <= 100);
    assert.ok(bounds.y + bounds.height <= 100);
  });
});

test('fast category analysis follows the image content instead of returning a fixed title template', () => {
  const upper = createImage(48, 96);
  fillRect(upper, 6, 5, 36, 10, [25, 25, 25, 255]);
  fillRect(upper, 8, 50, 32, 26, [220, 75, 170, 255]);

  const lower = createImage(48, 96);
  fillRect(lower, 6, 24, 36, 10, [25, 25, 25, 255]);
  fillRect(lower, 8, 50, 32, 26, [220, 75, 170, 255]);

  const upperTitle = analyzeFastCategories(upper).find((item) => item.category === 'kvTitle');
  const lowerTitle = analyzeFastCategories(lower).find((item) => item.category === 'kvTitle');

  assert.ok(lowerTitle.bounds.y > upperTitle.bounds.y + 10);
});
