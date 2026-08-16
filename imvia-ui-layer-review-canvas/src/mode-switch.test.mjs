import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { ModeSwitch } from './mode-switch.js';

test('canvas overview remains enabled before a source image is uploaded', () => {
  const markup = renderToStaticMarkup(createElement(ModeSwitch, {
    value: 'guided',
    onChange: () => {},
    canvasDisabled: true,
  }));
  const canvasButton = markup
    .split('</button>')
    .find((button) => button.includes('画布总览'));

  assert.ok(canvasButton, 'canvas overview button should be rendered');
  assert.doesNotMatch(canvasButton, /\sdisabled(?:=|>)/);
});

test('mode switch keeps accessible names when responsive labels are hidden', () => {
  const markup = renderToStaticMarkup(createElement(ModeSwitch, {
    value: 'canvas',
    onChange: () => {},
  }));

  assert.match(markup, /aria-label="框选拆分"/);
  assert.match(markup, /aria-label="画布总览"/);
  assert.match(markup, /class="mode-switch__label">框选拆分<\/span>/);
  assert.match(markup, /class="mode-switch__label">画布总览<\/span>/);
});
