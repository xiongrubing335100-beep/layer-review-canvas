import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeSubmissionPayload, serializedPlanBytes } from './submission-normalizer.js';

const pngDataUrl = 'data:image/png;base64,aGVsbG8=';

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'submission-normalizer-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('normalizes embedded source and crop data into local paths', async () => {
  await withTempDirectory(async (jobDirectory) => {
    const { normalizedPayload, sourcePath, createdFiles } = await normalizeSubmissionPayload({
      payload: {
        source: { embedded_data_url: pngDataUrl },
        layers: [{
          id: 'ui/one',
          name: '组件',
          review_snapshot: { embedded_crop_data_url: pngDataUrl },
        }],
      },
      jobDirectory,
      projectRoot: jobDirectory,
    });

    assert.equal(normalizedPayload.source.embedded_data_url, undefined);
    assert.equal(normalizedPayload.layers[0].review_snapshot.embedded_crop_data_url, undefined);
    assert.equal(normalizedPayload.source.local_path, sourcePath);
    assert.match(normalizedPayload.layers[0].review_snapshot.local_crop_path, /01-ui-one-selection\.png$/);
    assert.equal(createdFiles.length, 2);
    assert.equal((await readFile(sourcePath)).toString(), 'hello');
    await access(normalizedPayload.layers[0].review_snapshot.local_crop_path);
  });
});

test('keeps a local source URI and does not create a duplicate source file', async () => {
  await withTempDirectory(async (projectRoot) => {
    const payload = { source: { source_uri: 'public/demo.png' }, layers: [] };
    const result = await normalizeSubmissionPayload({
      payload,
      jobDirectory: path.join(projectRoot, 'job'),
      projectRoot,
    });

    assert.equal(result.createdFiles.length, 0);
    assert.equal(result.sourcePath, path.resolve(projectRoot, 'public/demo.png'));
  });
});

test('moves a data source URI to disk instead of persisting Base64 in the plan', async () => {
  await withTempDirectory(async (jobDirectory) => {
    const { normalizedPayload, sourcePath } = await normalizeSubmissionPayload({
      payload: { source: { source_uri: pngDataUrl }, layers: [] },
      jobDirectory,
      projectRoot: jobDirectory,
    });

    assert.equal(normalizedPayload.source.source_uri, undefined);
    assert.equal(normalizedPayload.source.local_path, sourcePath);
    assert.equal((await readFile(sourcePath)).toString(), 'hello');
  });
});

test('rejects a plan larger than the configured limit', async () => {
  await withTempDirectory(async (jobDirectory) => {
    await assert.rejects(
      normalizeSubmissionPayload({
        payload: {
          source: { embedded_data_url: pngDataUrl },
          layers: [],
          metadata: 'x'.repeat(100),
        },
        jobDirectory,
        projectRoot: jobDirectory,
        maxPlanBytes: 32,
      }),
      (error) => error.code === 'PLAN_TOO_LARGE' && error.bytes > 32,
    );
    await assert.rejects(access(path.join(jobDirectory, 'source.png')));
  });
});

test('serializedPlanBytes measures the persisted JSON contract', () => {
  assert.equal(serializedPlanBytes({ answer: 'ok' }), Buffer.byteLength('{"answer":"ok"}'));
});
