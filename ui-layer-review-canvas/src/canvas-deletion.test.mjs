import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canvasDeletionPlan,
  shouldHandleCanvasDelete,
} from './canvas-deletion.js';

test('builds a deletion plan for every selected canvas node kind', () => {
  assert.deepEqual(
    canvasDeletionPlan([
      'source',
      'split:title',
      'result:job-title',
      'manual-result:draft',
      'unknown',
    ]),
    {
      deleteSource: true,
      sourceImageIds: [],
      splitNodeIds: ['title'],
      resultKeys: ['result:job-title'],
      manualResultIds: ['draft'],
    },
  );
});

test('keeps a namespaced source deletion scoped to its image document', () => {
  assert.deepEqual(canvasDeletionPlan(['image:image-b:source']), {
    deleteSource: false,
    sourceImageIds: ['image-b'],
    splitNodeIds: [],
    resultKeys: [],
    manualResultIds: [],
  });
});

test('accepts Delete and Backspace outside editable controls', () => {
  const plainTarget = { closest: () => null };

  assert.equal(shouldHandleCanvasDelete({ key: 'Delete', target: plainTarget }), true);
  assert.equal(shouldHandleCanvasDelete({ key: 'Backspace', target: plainTarget }), true);
  assert.equal(shouldHandleCanvasDelete({ key: 'Escape', target: plainTarget }), false);
});

test('does not delete canvas nodes while editing form content', () => {
  const editableTarget = { closest: () => ({ tagName: 'TEXTAREA' }) };

  assert.equal(shouldHandleCanvasDelete({ key: 'Delete', target: editableTarget }), false);
  assert.equal(shouldHandleCanvasDelete({ key: 'Backspace', target: editableTarget }), false);
});
