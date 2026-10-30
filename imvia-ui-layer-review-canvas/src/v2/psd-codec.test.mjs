import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { encodePsd, inspectPsd, checkPsdBudget, assertPsdCompositeReadback } from './psd-codec.mjs';
import { composeNormal } from './pixels.js';
const image = (width,height,rgba) => ({width,height,data:Uint8ClampedArray.from(Array.from({length:width*height},()=>rgba).flat())});

test('PSD preserves Chinese duplicate names, front-to-back layers, ROI pixels and offsets', () => {
  const layers = [
    { name:'主体 · 一', image:image(3,2,[240,12,23,255]), placement:{x:3,y:3} },
    { name:'主体 · 一', image:image(5,4,[0,0,255,128]), placement:{x:1,y:2} },
  ];
  const composite = composeNormal({width:16,height:12,layers});
  const bytes = encodePsd({width:16,height:12,layers,composite,availableMemory:8*1024**3});
  assert.equal(Buffer.from(bytes).subarray(0,4).toString(),'8BPS');
  assert.equal(Buffer.from(bytes).readUInt16BE(4),1);
  const restored = inspectPsd(bytes,{availableMemory:8*1024**3});
  assert.equal(restored.width,16); assert.equal(restored.height,12);
  assert.equal(restored.layers.length,2);
  for (let i=0;i<2;i++) {
    assert.equal(restored.layers[i].name,layers[i].name);
    assert.deepEqual(restored.layers[i].placement,layers[i].placement);
    assert.deepEqual(Array.from(restored.layers[i].image.data),Array.from(layers[i].image.data));
  }
  assert.deepEqual(Array.from(restored.composite.data),Array.from(composite.data));
});
test('PSD rejects oversized documents and memory budgets before encoding', () => {
  const base = {width:100,height:100,layers:[],availableMemory:8*1024**3};
  assert.throws(()=>checkPsdBudget({...base,width:30001}), /PSD_SIZE_LIMIT/);
  assert.throws(()=>checkPsdBudget({...base,width:10000,height:4001}), /PSD_PIXEL_LIMIT/);
  assert.throws(()=>checkPsdBudget({...base,layers:Array.from({length:101},()=>({image:{width:1,height:1}}))}), /PSD_LAYER_LIMIT/);
  assert.throws(()=>checkPsdBudget({...base,availableMemory:1}), /PSD_MEMORY_LIMIT/);
  assert.ok(checkPsdBudget(base).estimatedBytes>100*100*4);
});

test('PSD admission uses memory available to the process, not only transient OS free pages', t => {
  t.mock.method(process, 'availableMemory', () => 2 * 1024 ** 3);
  t.mock.method(os, 'freemem', () => 320 * 1024 ** 2);
  assert.doesNotThrow(() => checkPsdBudget({ width: 880, height: 1808, layers: [{ image: { width: 872, height: 202 } }] }));
  t.mock.method(process, 'availableMemory', () => 1);
  assert.throws(() => checkPsdBudget({ width: 880, height: 1808, layers: [] }), /PSD_MEMORY_LIMIT/);
});

test('merged preview validation accepts only the codec quantization, never altered alpha or pixels', () => {
  const composite = { width: 5, height: 1, data: Uint8ClampedArray.from([
    161, 122, 138, 254, 100, 150, 200, 128, 50, 100, 200, 1, 240, 12, 23, 255, 0, 0, 0, 0,
  ]) };
  const layers = [{ name: '半透明 UI', placement: { x: 0, y: 0 }, image: composite }];
  const restored = inspectPsd(encodePsd({ width: 5, height: 1, layers, composite, availableMemory: 8 * 1024 ** 3 }), { availableMemory: 8 * 1024 ** 3 });
  assert.deepEqual(Array.from(restored.composite.data), [
    161, 121, 138, 254, 100, 149, 199, 128, 0, 0, 0, 1, 240, 12, 23, 255, 0, 0, 0, 0,
  ]);
  assert.deepEqual(restored.layers[0].image.data, composite.data);
  assert.doesNotThrow(() => assertPsdCompositeReadback(composite, restored.composite));
  for (let index = 0; index < composite.data.length; index += 1) {
    const corrupted = { ...restored.composite, data: restored.composite.data.slice() };
    corrupted.data[index] ^= 1;
    assert.throws(() => assertPsdCompositeReadback(composite, corrupted), /PSD_COMPOSITE_READBACK_MISMATCH/, `byte ${index}`);
  }
  assert.throws(() => assertPsdCompositeReadback(composite, { ...restored.composite, width: 1, height: 5 }), /PSD_COMPOSITE_READBACK_MISMATCH/);
});
