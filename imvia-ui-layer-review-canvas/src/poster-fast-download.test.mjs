import assert from 'node:assert/strict';
import test from 'node:test';

import { selectPosterFastDownloadAsset } from './poster-fast-download.js';

function record() {
  return {
    plan: { plan_version: 2, layers: [{ layer_index: 1, layer_name: '主体' }] },
    paths: { candidates: '/job/candidates', evidence: '/job/evidence', layers: '/job/layers' },
    manifest: {
      layers: [{
        layer_index: 1, status: 'NEEDS_USER_REVIEW',
        visual_inspection: { candidate_id: 'candidate-1' },
      }],
      candidates: [{
        candidate_id: 'candidate-1', layer_index: 1, plan_version: 2,
        path: '/job/candidates/candidate.png',
        transparent_preview: { path: '/job/evidence/transparent.png' },
      }],
    },
  };
}

test('download prefers the transparent full-canvas preview for a review candidate', () => {
  assert.deepEqual(selectPosterFastDownloadAsset(record(), 1), {
    root: '/job/evidence', path: '/job/evidence/transparent.png', filename: 'layer-1-主体.png', kind: 'transparent',
  });
});

test('postprocess-only failure exposes the retained raw PNG without inventing a path', () => {
  const failed = record();
  failed.manifest.layers[0] = {
    layer_index: 1, status: 'HARD_REJECTED', visual_inspection: { performed: false },
    fast_execution: {
      recoverability: 'postprocess_only', raw_candidate_available: true,
      raw_candidate_path: '/job/evidence/imagegen-raw.png',
    },
  };
  failed.manifest.candidates = [];
  assert.deepEqual(selectPosterFastDownloadAsset(failed, 1), {
    root: '/job/evidence', path: '/job/evidence/imagegen-raw.png', filename: 'layer-1-主体-raw.png', kind: 'raw',
  });
});

test('download rejects a retained path outside the job-owned directories', () => {
  const failed = record();
  failed.manifest.layers[0] = {
    layer_index: 1,
    fast_execution: { recoverability: 'postprocess_only', raw_candidate_available: true, raw_candidate_path: '/tmp/foreign.png' },
  };
  failed.manifest.candidates = [];
  assert.throws(() => selectPosterFastDownloadAsset(failed, 1), /outside|目录/i);
});
