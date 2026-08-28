import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POSTER_PLAN_VERSION,
  PosterPlanValidationError,
  confirmPosterPlan,
  createPosterPlan,
  updatePosterLayer,
  validatePosterPlan,
} from './poster-plan.js';

const requiredLayer = {
  layer_index: 1,
  layer_name: '主标题',
  asset_role: 'headline',
  layer_type: 'graphic',
  z_order: 1,
  position: 'full canvas coordinates',
  visible_content: ['老师您辛苦了'],
  included_content: ['source-visible title pixels'],
  excluded_content: ['9/10 date'],
  occludes: [],
  occluded_by: [],
  source_evidence: [{ description: 'central dark calligraphy', region: [0.1, 0.1, 0.6, 0.3] }],
  support_components: [],
  ui_independence: 'not_applicable',
  repair_envelope: { description: '', covered_segment: [], seam_band: '', forbidden_regions: [] },
  locked_visible_anchors: ['all visible glyph pixels'],
  completion_required: false,
  completion_regions: [],
  risk_level: 'high',
  processing_mode: 'graphic_completion',
  fill_color: '#00FF00',
  compositing_mode: 'Normal',
  separation_reason: 'independent headline',
};

function fixture(overrides = {}) {
  return {
    version: POSTER_PLAN_VERSION,
    task: 'poster_layering',
    job_id: 'poster-job-1',
    project_id: 'project-1',
    image_id: 'image-1',
    source: {
      path: 'source.png', width: 1920, height: 1080, aspect_ratio: 16 / 9, target_2x: true,
    },
    document_mode: 'poster',
    status: 'PLAN_REVIEW',
    plan_version: 1,
    skill_contract: {
      base: 'lovart-poster-layering-v3-1',
      adapter: 'imvia-poster-layering-workbench-v1',
      auto_retry: false,
      full_canvas: true,
    },
    layers: [{ ...requiredLayer }],
    output_directory: 'output/poster-jobs/poster-job-1',
    ...overrides,
  };
}

test('poster plans require every v3.1 ownership field', () => {
  const input = fixture();
  delete input.layers[0].source_evidence;
  const plan = createPosterPlan(input);
  assert.deepEqual(validatePosterPlan(plan).errors.map((error) => error.path), [
    'layers[0].source_evidence',
  ]);
});
test('independent UI cannot be merged into a headline', () => {
  const plan = createPosterPlan(fixture({ layers: [{
    ...requiredLayer,
    asset_role: 'headline',
    included_content: ['headline', 'date badge'],
    ui_independence: 'independent',
  }] }));
  assert.equal(validatePosterPlan(plan).errors[0].code, 'UI_BUNDLING_ERROR');
});

test('title semantics reject independent date badges in every ownership component', () => {
  for (const field of ['visible_content', 'included_content', 'support_components']) {
    const plan = createPosterPlan(fixture({ layers: [{
      ...requiredLayer,
      asset_role: 'title',
      visible_content: ['title glyphs'],
      included_content: ['title glyphs'],
      support_components: [],
      [field]: ['independent date badge'],
    }] }));
    assert.deepEqual(validatePosterPlan(plan).errors.map((error) => ({ path: error.path, code: error.code })), [
      { path: 'layers[0]', code: 'UI_BUNDLING_ERROR' },
    ]);
  }
});

test('poster plans reject an empty layer list before confirmation', () => {
  const plan = createPosterPlan(fixture({ layers: [] }));
  assert.deepEqual(validatePosterPlan(plan).errors.map((error) => ({ path: error.path, code: error.code })), [
    { path: 'layers', code: 'EMPTY_ARRAY' },
  ]);
  assert.throws(() => confirmPosterPlan(plan), PosterPlanValidationError);
});

test('poster plans reject unsafe dimensions, enum values, and incompatible keys', () => {
  const plan = createPosterPlan(fixture({
    source: { ...fixture().source, width: 0 },
    layers: [{ ...requiredLayer, processing_mode: 'unknown', fill_color: '#00FF00', compositing_mode: 'Screen' }],
  }));
  const result = validatePosterPlan(plan);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.code), [
    'SOURCE_DIMENSIONS_INVALID', 'INVALID_ENUM', 'KEY_COMPOSITING_MISMATCH',
  ]);
});

test('poster plans require unique positive layer indexes and front-to-back z order', () => {
  const plan = createPosterPlan(fixture({ layers: [
    { ...requiredLayer, layer_index: 1, z_order: 2 },
    { ...requiredLayer, layer_index: 1, z_order: 1, layer_name: '背景' },
  ] }));
  const errors = validatePosterPlan(plan).errors;
  assert.ok(errors.some((error) => error.code === 'LAYER_INDEX_DUPLICATE'));
  assert.ok(errors.some((error) => error.code === 'Z_ORDER_INVALID'));
});

test('confirming a valid plan locks it and increments its plan version', () => {
  const confirmed = confirmPosterPlan(fixture(), '2026-08-20T12:00:00.000Z');
  assert.equal(confirmed.status, 'PLAN_CONFIRMED');
  assert.equal(confirmed.plan_version, 2);
  assert.equal(confirmed.confirmed_at, '2026-08-20T12:00:00.000Z');
});

test('confirming an invalid plan throws structured validation errors', () => {
  const input = fixture();
  delete input.layers[0].source_evidence;
  assert.throws(
    () => confirmPosterPlan(input),
    (error) => error instanceof PosterPlanValidationError
      && error.errors[0].path === 'layers[0].source_evidence',
  );
});

test('confirming a plan invalidates non-accepted candidates from its old version', () => {
  const input = fixture({ layers: [{ ...requiredLayer, candidates: [
    { candidate_id: 'candidate-review', plan_version: 1, status: 'NEEDS_USER_REVIEW' },
    { candidate_id: 'candidate-accepted', plan_version: 1, status: 'ACCEPTED' },
  ] }] });
  const confirmed = confirmPosterPlan(input, '2026-08-20T12:00:00.000Z');
  assert.equal(confirmed.plan_version, 2);
  assert.equal(confirmed.layers[0].candidates[0].status, 'INVALID');
  assert.equal(confirmed.layers[0].candidates[0].valid, false);
  assert.equal(confirmed.layers[0].candidates[1].status, 'ACCEPTED');
});

test('createPosterPlan preserves explicit unsupported metadata for validation', () => {
  const plan = createPosterPlan({ ...fixture(), version: '9.9', task: 'not-poster', document_mode: 'ui' });
  assert.equal(plan.version, '9.9');
  assert.equal(plan.task, 'not-poster');
  assert.equal(plan.document_mode, 'ui');
  assert.deepEqual(validatePosterPlan(plan).errors.map((error) => error.code), [
    'VERSION_UNSUPPORTED', 'TASK_INVALID', 'DOCUMENT_MODE_INVALID',
  ]);
});

test('createPosterPlan rejects values that JSON serialization would lose or change', () => {
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    -0, () => {}, Symbol('unsafe'), new Date('2026-01-01T00:00:00.000Z')]) {
    assert.throws(
      () => createPosterPlan(fixture({ layers: [{ ...requiredLayer, included_content: [value] }] })),
      TypeError,
    );
  }
});

test('createPosterPlan rejects lossy non-canonical array properties', () => {
  for (const property of ['00', '01', '1e0']) {
    const included = ['source-visible title pixels'];
    included[property] = 'this property would be dropped by JSON arrays';
    assert.throws(
      () => createPosterPlan(fixture({ layers: [{ ...requiredLayer, included_content: included }] })),
      TypeError,
    );
  }
});

test('confirmPosterPlan requires a canonical ISO timestamp string', () => {
  for (const confirmedAt of [new Date('2026-01-01T00:00:00.000Z'), Number.NaN, Symbol('unsafe'),
    '2026-08-20', 'not-a-timestamp']) {
    assert.throws(() => confirmPosterPlan(fixture(), confirmedAt), TypeError);
  }
  const defaulted = confirmPosterPlan(fixture(), undefined);
  assert.match(defaulted.confirmed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(defaulted.confirmed_at).toISOString(), defaulted.confirmed_at);
  const confirmed = confirmPosterPlan(fixture(), '2026-08-20T12:00:00.000Z');
  assert.equal(confirmed.confirmed_at, '2026-08-20T12:00:00.000Z');
});

test('processing mode accepts only the v3.1 completion modes', () => {
  for (const processingMode of ['full_asset_completion', 'graphic_completion', 'effect_completion', 'background_completion']) {
    const plan = createPosterPlan(fixture({ layers: [{ ...requiredLayer, processing_mode: processingMode }] }));
    assert.equal(validatePosterPlan(plan).valid, true);
  }
  const legacy = createPosterPlan(fixture({ layers: [{ ...requiredLayer, processing_mode: 'graphic_isolation' }] }));
  assert.equal(validatePosterPlan(legacy).errors[0].code, 'INVALID_ENUM');
});

test('editing a confirmed plan invalidates unaccepted candidate versions', () => {
  const confirmed = confirmPosterPlan(fixture({
    layers: [{ ...requiredLayer, candidates: [
      { candidate_id: 'candidate-1', plan_version: 2, status: 'NEEDS_USER_REVIEW' },
      { candidate_id: 'candidate-accepted', plan_version: 2, status: 'ACCEPTED' },
    ] }],
  }));
  const edited = updatePosterLayer(confirmed, 1, { layer_name: '新主标题' });
  assert.equal(edited.status, 'PLAN_REVIEW');
  assert.equal(edited.plan_version, 3);
  assert.equal(edited.layers[0].candidates[0].status, 'INVALID');
  assert.equal(edited.layers[0].candidates[0].valid, false);
  assert.equal(edited.layers[0].candidates[1].status, 'ACCEPTED');
});
