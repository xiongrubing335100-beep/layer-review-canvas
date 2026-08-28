import assert from 'node:assert/strict';
import test from 'node:test';
import { layerReviewQueue } from './vite.config.js';

async function requestPosterRouteWithFeatureOff(url) {
  const handlers = [];
  const plugin = layerReviewQueue();
  plugin.configureServer({
    middlewares: {
      use(handler) {
        handlers.push(handler);
      },
    },
  });

  const original = process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE;
  process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE = '0';
  try {
    return await new Promise((resolve, reject) => {
      const response = {
        headers: {},
        statusCode: 200,
        setHeader(name, value) {
          this.headers[name] = value;
        },
        end(body = '') {
          resolve({ statusCode: this.statusCode, body: String(body) });
        },
      };
      const request = { method: 'POST', url, headers: {} };
      const dispatch = (index) => {
        const handler = handlers[index];
        if (!handler) return reject(new Error('poster API did not produce a response'));
        return handler(request, response, () => dispatch(index + 1));
      };
      Promise.resolve(dispatch(0)).catch(reject);
    });
  } finally {
    if (original === undefined) delete process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE;
    else process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE = original;
  }
}

test('feature-off poster analysis API rejects before accepting a job', async () => {
  const response = await requestPosterRouteWithFeatureOff('/api/poster-layer/jobs/analyze');
  assert.equal(response.statusCode, 403);
  assert.match(response.body, /海报分层功能当前已关闭/);
});

test('feature-off poster candidate API rejects before reading or reserving a legacy job', async () => {
  const response = await requestPosterRouteWithFeatureOff('/api/poster-layer/jobs/legacy-job/candidates/1');
  assert.equal(response.statusCode, 403);
  assert.match(response.body, /海报分层功能当前已关闭/);
});
