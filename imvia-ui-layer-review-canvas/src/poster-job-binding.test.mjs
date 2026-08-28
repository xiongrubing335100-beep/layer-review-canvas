import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPosterJobResult } from './poster-job-binding.js';

test('an A result updates A after switching to B without replacing B visible state', () => {
  const result = applyPosterJobResult({
    activeImageId: 'B',
    visibleJob: { job_id: 'job-b' },
    documents: [
      { imageId: 'A', posterJobId: '', posterDispatchId: '', posterPlanVersion: 0 },
      { imageId: 'B', posterJobId: 'job-b', posterDispatchId: 'dispatch-b', posterPlanVersion: 3 },
    ],
  }, 'A', {
    job_id: 'job-a', dispatch_id: 'dispatch-a', plan: { plan_version: 2 },
  });

  assert.deepEqual(result.documents, [
    { imageId: 'A', posterJobId: 'job-a', posterDispatchId: 'dispatch-a', posterPlanVersion: 2 },
    { imageId: 'B', posterJobId: 'job-b', posterDispatchId: 'dispatch-b', posterPlanVersion: 3 },
  ]);
  assert.equal(result.visibleUpdated, false);
  assert.deepEqual(result.visibleJob, { job_id: 'job-b' });
});
