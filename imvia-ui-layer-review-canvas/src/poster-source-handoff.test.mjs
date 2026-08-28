import assert from 'node:assert/strict';
import test from 'node:test';
import { materializePosterSource, uploadPosterSource } from './poster-source-handoff.js';

function canvasHarness() {
  const calls = [];
  return {
    calls,
    canvasFactory() {
      return {
        getContext() { return { drawImage(...args) { calls.push(args); } }; },
        toBlob(callback, type) { callback(new Blob(['png-bytes'], { type })); },
      };
    },
  };
}

test('materializes a browser data URL as a full-size PNG without using a filename path', async () => {
  const canvas = canvasHarness();
  const result = await materializePosterSource('data:image/jpeg;base64,ZmFrZQ==', {
    fetchImpl: async () => new Response(new Blob(['jpeg'], { type: 'image/jpeg' })),
    loadImage: async () => ({ width: 640, height: 480 }),
    canvasFactory: canvas.canvasFactory,
  });

  assert.equal(result.blob.type, 'image/png');
  assert.deepEqual(result.size, { width: 640, height: 480 });
  assert.equal(canvas.calls.length, 1);
});

test('materializes a served MCP preview URL and converts WebP to PNG', async () => {
  const canvas = canvasHarness();
  const requested = [];
  const result = await materializePosterSource('http://127.0.0.1:4173/api/layer-review/source-preview/a', {
    fetchImpl: async (url) => {
      requested.push(url);
      return new Response(new Blob(['webp'], { type: 'image/webp' }));
    },
    loadImage: async () => ({ naturalWidth: 1920, naturalHeight: 1080 }),
    canvasFactory: canvas.canvasFactory,
  });

  assert.deepEqual(requested, ['http://127.0.0.1:4173/api/layer-review/source-preview/a']);
  assert.equal(result.blob.type, 'image/png');
  assert.deepEqual(result.size, { width: 1920, height: 1080 });
});

test('rejects unsupported source payloads before a poster source upload', async () => {
  await assert.rejects(
    materializePosterSource('data:text/plain;base64,eA==', {
      fetchImpl: async () => new Response(new Blob(['x'], { type: 'text/plain' })),
    }),
    /PNG、JPG 或 WebP/,
  );
});

test('uploads only PNG bytes and returns the server-owned source path', async () => {
  const previousLocation = globalThis.location;
  globalThis.location = new URL('http://127.0.0.1:4175/workbench');
  const requests = [];
  try {
    const result = await uploadPosterSource(new Blob(['png'], { type: 'image/png' }), { width: 10, height: 20 }, async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ source_path: 'output/poster-sources/source-1.png', width: 10, height: 20 }), { status: 201 });
    });

    assert.equal(result.sourcePath, 'output/poster-sources/source-1.png');
    assert.equal(requests[0].url, 'http://127.0.0.1:4175/api/poster-layer/sources');
    assert.equal(requests[0].options.headers['Content-Type'], 'image/png');
    assert.equal(requests[0].options.headers['X-Poster-Source-Width'], '10');
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});
