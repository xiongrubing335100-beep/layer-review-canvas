import assert from 'node:assert/strict';
import test from 'node:test';
import { canChangeDocumentMode, normalizeDocumentMode } from './poster-mode.js';
import { createImageDocument } from './project-state.js';

test('legacy documents default to UI mode', () => {
  assert.equal(createImageDocument({ imageId: 'legacy' }).documentMode, 'ui');
});

test('poster mode persists independently per image', () => {
  const poster = createImageDocument({ imageId: 'p', documentMode: 'poster' });
  const ui = createImageDocument({ imageId: 'u', documentMode: 'ui' });
  assert.equal(poster.documentMode, 'poster');
  assert.equal(ui.documentMode, 'ui');
});

test('mode changes require an empty mode-specific state', () => {
  assert.equal(canChangeDocumentMode({
    currentMode: 'poster', nextMode: 'ui', hasModeState: true,
  }), false);
});

test('unknown document modes normalize to UI mode', () => {
  assert.equal(normalizeDocumentMode('unknown'), 'ui');
});

test('mode changes are allowed when mode-specific state is empty', () => {
  assert.equal(canChangeDocumentMode({
    currentMode: 'poster', nextMode: 'ui', hasModeState: false,
  }), true);
});

test('a disabled poster feature blocks only a new UI-to-poster mode choice', () => {
  assert.equal(canChangeDocumentMode({
    currentMode: 'ui', nextMode: 'poster', hasModeState: false, posterLayeringEnabled: false,
  }), false);
  assert.equal(canChangeDocumentMode({
    currentMode: 'poster', nextMode: 'poster', hasModeState: true, posterLayeringEnabled: false,
  }), true);
});
