import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearStoredProjectImages,
  createProjectState,
  upsertImageDocument,
  writeStoredProjectState,
} from './project-state.js';
import { getPosterJobWithDispatch } from './poster-workbench-host.js';

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test('a refreshed poster binding reloads candidate failures and accepted layers from the backend', async () => {
  const storage = createStorage();
  const project = upsertImageDocument(createProjectState({
    projectId: 'project-1', activeImageId: 'poster-image',
  }), {
    imageId: 'poster-image',
    documentMode: 'poster',
    posterJobId: 'poster-job-1',
    posterDispatchId: 'dispatch-1',
    posterPlanVersion: 5,
    sourceDataUrl: 'data:image/png;base64,large-source',
  });
  writeStoredProjectState(project, storage);

  const refreshedProject = clearStoredProjectImages(storage);
  const binding = refreshedProject.images[refreshedProject.activeImageId];
  const requests = [];
  const backendJob = {
    job_id: 'poster-job-1',
    plan: { status: 'PLAN_CONFIRMED', plan_version: 5 },
    manifest: {
      layers: [
        { layer_index: 1, status: 'HARD_REJECTED', failure_codes: ['TEXT_OR_LOGO_MUTATED'] },
        { layer_index: 2, status: 'ACCEPTED', source_output: 'layers/layer_2_source.png' },
      ],
    },
  };
  const restoredJob = await getPosterJobWithDispatch(
    binding.posterJobId,
    binding.posterDispatchId,
    async (url) => {
      requests.push(url);
      const payload = url.includes('/dispatches/')
        ? { dispatch_id: 'dispatch-1', status: 'completed' }
        : backendJob;
      return { ok: true, json: async () => payload };
    },
  );

  assert.equal(binding.documentMode, 'poster');
  assert.equal(binding.posterPlanVersion, 5);
  assert.equal(binding.sourceDataUrl, '');
  assert.equal(requests.length, 2);
  assert.deepEqual(restoredJob.manifest.layers, backendJob.manifest.layers);
  assert.equal(restoredJob.dispatch.status, 'completed');
});
