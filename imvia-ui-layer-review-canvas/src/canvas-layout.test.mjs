import assert from 'node:assert/strict';
import test from 'node:test';
import { arrangeImageDocuments } from './canvas-layout.js';

test('arranges each image source with its split nodes in an independent group', () => {
  const documents = [
    {
      imageId: 'image-a',
      sourceNodePosition: { x: 110, y: 240 },
      nodes: [{ id: 'a-1', x: 1010, y: 220 }, { id: 'a-2', x: 650, y: 410 }],
      resultNodePositions: { 'result-a': { x: 1760, y: 145 } },
    },
    {
      imageId: 'image-b',
      sourceNodePosition: { x: 110, y: 240 },
      nodes: [{ id: 'b-1', x: 1010, y: 220 }],
      resultNodePositions: {},
    },
  ];

  const arranged = arrangeImageDocuments(documents);
  assert.deepEqual(arranged.map((document) => document.sourceNodePosition), [
    { x: 90, y: 100 },
    { x: 1330, y: 100 },
  ]);
  assert.equal(arranged[0].canvasLayoutVersion, 1);
  assert.equal(arranged[0].nodes[0].x, 450);
  assert.equal(arranged[0].nodes[1].x, 780);
  assert.equal(arranged[0].resultNodePositions['result-a'].x, 450);
});
