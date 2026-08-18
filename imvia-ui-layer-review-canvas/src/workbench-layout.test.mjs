import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolvePanelVisibility } from './workbench-layout.js';

const mainSource = readFileSync(new URL('./main.jsx', import.meta.url), 'utf8');
const styleSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('guided mode hides both panels before a source image is uploaded', () => {
  assert.deepEqual(resolvePanelVisibility({
    reviewMode: 'guided',
    hasSource: false,
    hasSelectedLayer: false,
    isLeftOpen: true,
    isRightOpen: true,
  }), {
    left: false,
    right: false,
  });
});

test('guided mode reveals the left panel for manual layers but waits for a selection before showing the inspector', () => {
  assert.deepEqual(resolvePanelVisibility({
    reviewMode: 'guided',
    hasSource: true,
    hasSelectedLayer: false,
    isLeftOpen: true,
    isRightOpen: true,
  }), {
    left: true,
    right: false,
  });
});

test('guided mode reveals the inspector only after a layer is selected', () => {
  assert.deepEqual(resolvePanelVisibility({
    reviewMode: 'guided',
    hasSource: true,
    hasSelectedLayer: true,
    isLeftOpen: true,
    isRightOpen: true,
  }), {
    left: true,
    right: true,
  });
});

test('guided mode keeps both panels hidden while uploaded-image analysis owns the main view', () => {
  assert.deepEqual(resolvePanelVisibility({
    reviewMode: 'guided',
    hasSource: true,
    hasSelectedLayer: false,
    isLeftOpen: false,
    isRightOpen: false,
  }), {
    left: false,
    right: false,
  });
});

test('canvas mode keeps the asset sidebar closed and hides the inspector without a single selected node', () => {
  assert.deepEqual(resolvePanelVisibility({
    reviewMode: 'canvas',
    hasSource: false,
    hasSelectedLayer: false,
    hasCanvasInspectorSelection: false,
    isLeftOpen: false,
    isRightOpen: true,
  }), {
    left: false,
    right: false,
  });
});

test('canvas mode reveals the asset sidebar when its toolbar toggle is open', () => {
  assert.deepEqual(resolvePanelVisibility({
    reviewMode: 'canvas',
    hasSource: false,
    hasSelectedLayer: false,
    hasCanvasInspectorSelection: false,
    isLeftOpen: true,
    isRightOpen: false,
  }), {
    left: true,
    right: false,
  });
});

test('canvas mode reveals the inspector only for a single selected canvas node', () => {
  assert.deepEqual(resolvePanelVisibility({
    reviewMode: 'canvas',
    hasSource: false,
    hasSelectedLayer: false,
    hasCanvasInspectorSelection: true,
    isLeftOpen: false,
    isRightOpen: false,
  }), {
    left: false,
    right: true,
  });
});

test('guided source preview uses the uploaded image ratio instead of a fixed tall frame', () => {
  assert.match(
    mainSource,
    /maxWidth:\s*`min\(100%, \$\{Math\.max\(96, Math\.round\(\(sourceSize\.width \/ sourceSize\.height\) \* 330\)\)\}px\)`/,
  );
  assert.match(
    styleSource,
    /\.guided-source-image\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto;[^}]*max-height:\s*none;/s,
  );
});
