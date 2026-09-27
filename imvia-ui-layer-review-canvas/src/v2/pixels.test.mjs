import test from 'node:test';
import assert from 'node:assert/strict';
import { composeNormal } from './pixels.js';

export const image = (width, height, rgba) => ({ width, height,
  data: Uint8ClampedArray.from(Array.from({ length: width * height }, () => rgba).flat()) });
test('source-over keeps front layer order, offsets, alpha and transparent uncovered pixels', () => {
  const result = composeNormal({ width: 4, height: 3, layers: [
    { image: image(1, 1, [255, 0, 0, 128]), placement: { x: 2, y: 1 } },
    { image: image(2, 1, [0, 0, 255, 128]), placement: { x: 1, y: 1 } },
  ] });
  const at = (x,y) => Array.from(result.data.slice((y*4+x)*4,(y*4+x+1)*4));
  assert.deepEqual(at(0,0), [0,0,0,0]);
  assert.deepEqual(at(1,1), [0,0,255,128]);
  assert.deepEqual(at(2,1), [170,0,85,192]);
});
test('opaque layers retain source RGB and invalid placement never silently crops', () => {
  const layer = { image: image(1,1,[11,22,33,255]), placement: { x: 0, y: 0 } };
  assert.deepEqual(Array.from(composeNormal({ width: 1, height: 1, layers: [layer] }).data), [11,22,33,255]);
  for (const placement of [{x:-1,y:0},{x:.5,y:0},{x:1,y:0}]) assert.throws(() => composeNormal({width:1,height:1,layers:[{...layer,placement}]}));
  assert.throws(() => composeNormal({width:1,height:1,layers:[{...layer,image:{width:1,height:1,data:new Uint8ClampedArray(3)}}]}));
});
