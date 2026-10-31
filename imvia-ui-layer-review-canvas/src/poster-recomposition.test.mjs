import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPosterCompositeOrder,
  canExportPosterPackage,
  canRunPosterAudit,
  posterAuditUiState,
  recordRecompositionAudit,
} from './poster-recomposition.js';

const digest = (character) => character.repeat(64);
const acceptedEntries = () => [
  {
    layer_index: 2, candidate_id: 'candidate-2', candidate_sha256: digest('b'),
    candidate_output: '/job/candidates/layer_2.png',
    source_output: '/job/layers/layer_2_source.png', source_sha256: digest('2'),
  },
  {
    layer_index: 1, candidate_id: 'candidate-1', candidate_sha256: digest('a'),
    candidate_output: '/job/candidates/layer_1.png',
    source_output: '/job/layers/layer_1_source.png', source_sha256: digest('1'),
  },
];
const passingEvidence = () => ({
  checks: {
    dimensions: true, order: true, key_fields: true, coverage: true,
    source_similarity: true, ownership: true, foreign_content: true, accepted_binding: true,
  },
  measurements: {
    source_sha256: digest('c'), total_pixels: 200, coverage_ratio: 1, source_similarity: 1,
    mean_absolute_error: 0, missing_owned_pixels: 0,
    undeclared_overlap_pixels: 0, mismatch_pixels: 0,
  },
});

function jobFixture({
  layerStatuses = ['ACCEPTED', 'ACCEPTED'],
  acceptedPlanVersions = [7, 7],
  revision = 12,
} = {}) {
  const layers = layerStatuses.map((status, offset) => ({
    layer_index: offset + 1,
    status,
    accepted_plan_version: acceptedPlanVersions[offset],
    accepted_candidate_id: `candidate-${offset + 1}`,
    candidate_output: `/job/candidates/layer_${offset + 1}.png`,
    generation_count: 1,
    source_output: `/job/layers/layer_${offset + 1}_source.png`,
    source_sha256: digest(String(offset + 1)),
    visual_inspection: {
      performed: true,
      verdict: 'NEEDS_USER_REVIEW',
      failure_codes: [],
      candidate_id: `candidate-${offset + 1}`,
      plan_version: 7,
      candidate_sha256: digest(String.fromCharCode(97 + offset)),
    },
  }));
  return {
    plan: {
      status: 'PLAN_CONFIRMED',
      plan_version: 7,
      layers: layers.map(({ layer_index }) => ({ layer_index, z_order: layer_index * 10 })),
    },
    manifest: {
      revision,
      layers,
      candidates: layers.map((layer, offset) => ({
        candidate_id: `candidate-${offset + 1}`,
        candidate_number: 1,
        layer_index: offset + 1,
        plan_version: 7,
        path: layer.candidate_output,
        status: 'NEEDS_USER_REVIEW',
        failure_codes: [],
        candidate_sha256: digest(String.fromCharCode(97 + offset)),
        accepted: true,
        accepted_source_output: layer.source_output,
        accepted_source_sha256: layer.source_sha256,
        release_gate: {
          verdict: 'NEEDS_USER_REVIEW', failureCodes: [],
          checks: {
            source_comparison: true, locked_anchors: true, repair_envelope: true,
            canvas_dimensions: true, key_field: true,
          },
          candidateId: `candidate-${offset + 1}`,
          planVersion: 7,
          candidateSha256: digest(String.fromCharCode(97 + offset)),
        },
      })),
    },
    report: { status: 'INITIALIZED' },
  };
}

test('audit requires every planned layer to be accepted', () => {
  assert.equal(canRunPosterAudit(jobFixture({
    layerStatuses: ['ACCEPTED', 'NEEDS_USER_REVIEW'],
  })), false);
});

test('audit rejects accepted metadata that is not bound to the current plan and canonical digest', () => {
  assert.equal(canRunPosterAudit(jobFixture({ acceptedPlanVersions: [7, 6] })), false);
  const missingDigest = jobFixture();
  delete missingDigest.manifest.layers[1].source_sha256;
  assert.equal(canRunPosterAudit(missingDigest), false);
});

test('audit rejects a synthetic accepted layer without its exact accepted candidate lineage', () => {
  const synthetic = jobFixture();
  synthetic.manifest.candidates = [];

  assert.equal(canRunPosterAudit(synthetic), false);
});

test('audit rejects mismatched accepted candidate, inspection, and release-gate digests', () => {
  for (const mutate of [
    (job) => { job.manifest.layers[0].accepted_candidate_id = 'other'; },
    (job) => { job.manifest.layers[0].visual_inspection.candidate_sha256 = digest('f'); },
    (job) => { job.manifest.candidates[0].release_gate.candidateSha256 = digest('f'); },
    (job) => { job.manifest.candidates[0].accepted_source_sha256 = digest('f'); },
  ]) {
    const job = jobFixture();
    mutate(job);
    assert.equal(canRunPosterAudit(job), false);
  }
});

test('recomposition follows strictly monotonic authoritative z-order without requiring contiguous values', () => {
  const plan = { layers: [1, 3, 2].map((layer_index) => ({ layer_index, z_order: layer_index * 10 })) };
  assert.deepEqual(buildPosterCompositeOrder(plan), [3, 2, 1]);
});

test('recomposition rejects duplicate or non-monotonic z-order bindings', () => {
  assert.throws(() => buildPosterCompositeOrder({ layers: [
    { layer_index: 1, z_order: 20 }, { layer_index: 2, z_order: 10 },
  ] }), /z.order/i);
  assert.throws(() => buildPosterCompositeOrder({ layers: [
    { layer_index: 1, z_order: 10 }, { layer_index: 2, z_order: 10 },
  ] }), /z.order/i);
});

test('a passed audit binds the exact accepted revision, plan, order, and digests', () => {
  const job = jobFixture();
  const recorded = recordRecompositionAudit(job, {
    status: 'passed',
    composite_order: [2, 1],
    failure_codes: [],
    accepted_layers: acceptedEntries(),
    ...passingEvidence(),
    preview_path: '/job/audit/recomposition-preview.png',
  });

  assert.deepEqual(recorded.report.recomposition_audit.binding, {
    plan_version: 7,
    manifest_revision: 12,
    composite_order: [2, 1],
    accepted_layers: acceptedEntries(),
  });
  assert.equal(canExportPosterPackage(recorded), true);
});

test('export fails closed when accepted bytes, plan version, order, or revision changed after audit', () => {
  const audited = recordRecompositionAudit(jobFixture(), {
    status: 'passed', composite_order: [2, 1], failure_codes: [],
    accepted_layers: acceptedEntries(),
    ...passingEvidence(),
    preview_path: '/job/audit/recomposition-preview.png',
  });
  const mutations = [
    (job) => { job.manifest.revision += 1; },
    (job) => { job.plan.plan_version += 1; },
    (job) => { job.plan.layers[0].layer_index = 3; },
    (job) => { job.manifest.layers[0].source_sha256 = digest('f'); },
    (job) => {
      job.manifest.layers[0].source_output = '/job/layers/replaced.png';
      job.manifest.candidates[0].accepted_source_output = '/job/layers/replaced.png';
    },
    (job) => {
      job.manifest.layers[0].candidate_output = '/job/candidates/replaced.png';
      job.manifest.candidates[0].path = '/job/candidates/replaced.png';
    },
  ];

  for (const mutate of mutations) {
    const changed = structuredClone(audited);
    mutate(changed);
    assert.equal(canExportPosterPackage(changed), false);
  }
});

test('a pass label without successful deterministic measurements fails closed', () => {
  const recorded = recordRecompositionAudit(jobFixture(), {
    status: 'passed', composite_order: [2, 1], failure_codes: [],
    accepted_layers: acceptedEntries(),
    ...passingEvidence(),
    checks: { dimensions: true, source_similarity: false },
  });

  assert.equal(recorded.report.recomposition_audit.status, 'failed');
  assert.deepEqual(recorded.report.recomposition_audit.failure_codes, ['AUDIT_BINDING_MISMATCH']);
});

test('audit evidence accepts the advertised similarity and MAE boundary but rejects values beyond it', () => {
  const boundary = recordRecompositionAudit(jobFixture(), {
    status: 'passed', composite_order: [2, 1], failure_codes: [],
    accepted_layers: acceptedEntries(), ...passingEvidence(),
    measurements: {
      ...passingEvidence().measurements,
      source_similarity: 0.995, mean_absolute_error: 1, mismatch_pixels: 1,
    },
  });
  assert.equal(canExportPosterPackage(boundary), true);

  const beyond = structuredClone(boundary);
  beyond.report.recomposition_audit.measurements.source_similarity = 0.994;
  assert.equal(canExportPosterPackage(beyond), false);
});

test('a script pass with a digest mismatch is recorded as a blocking audit failure', () => {
  const job = jobFixture();
  const recorded = recordRecompositionAudit(job, {
    status: 'passed', composite_order: [2, 1], failure_codes: [],
    accepted_layers: acceptedEntries().map((entry) => entry.layer_index === 2
      ? { ...entry, source_sha256: digest('x') } : entry),
    ...passingEvidence(),
    preview_path: '/job/audit/recomposition-preview.png',
  });

  assert.equal(recorded.report.recomposition_audit.status, 'failed');
  assert.deepEqual(recorded.report.recomposition_audit.failure_codes, ['AUDIT_BINDING_MISMATCH']);
  assert.equal(canExportPosterPackage(recorded), false);
});

test('completion UI enables audit only when ready and exposes export only for the current passed binding', () => {
  const ready = posterAuditUiState(jobFixture());
  assert.deepEqual(ready, {
    status: 'ready', canAudit: true, canExport: false, conflictLayers: [], failureCodes: [],
  });

  const passedJob = recordRecompositionAudit(jobFixture(), {
    status: 'passed', composite_order: [2, 1], failure_codes: [],
    accepted_layers: acceptedEntries(),
    ...passingEvidence(),
    preview_path: '/job/audit/recomposition-preview.png',
  });
  assert.equal(posterAuditUiState(passedJob).status, 'passed');
  assert.equal(posterAuditUiState(passedJob).canExport, true);

  passedJob.manifest.revision += 1;
  assert.equal(posterAuditUiState(passedJob).status, 'stale');
  assert.equal(posterAuditUiState(passedJob).canExport, false);
});

test('completion UI retains failed audit conflict layers for returning to review', () => {
  const failed = recordRecompositionAudit(jobFixture(), {
    status: 'failed', failure_codes: ['DUPLICATE_OWNED_CONTENT'], conflict_layers: [2, 1],
    composite_order: [2, 1], accepted_layers: acceptedEntries(),
  });

  assert.deepEqual(posterAuditUiState(failed), {
    status: 'failed', canAudit: true, canExport: false,
    conflictLayers: [2, 1], failureCodes: ['DUPLICATE_OWNED_CONTENT'],
  });

  for (const mutate of [
    (job) => { job.manifest.revision += 1; },
    (job) => {
      job.plan.plan_version = 8;
      for (const layer of job.manifest.layers) {
        layer.accepted_plan_version = 8;
        layer.visual_inspection.plan_version = 8;
      }
      for (const candidate of job.manifest.candidates) {
        candidate.plan_version = 8;
        candidate.release_gate.planVersion = 8;
      }
    },
    (job) => {
      job.manifest.layers[0].source_sha256 = digest('f');
      job.manifest.candidates[0].accepted_source_sha256 = digest('f');
    },
  ]) {
    const stale = structuredClone(failed);
    mutate(stale);
    assert.deepEqual(posterAuditUiState(stale), {
      status: 'stale', canAudit: true, canExport: false,
      conflictLayers: [], failureCodes: [],
    });
  }
});
