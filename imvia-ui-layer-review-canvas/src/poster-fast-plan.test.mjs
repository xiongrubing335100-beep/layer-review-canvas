import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFastLayerSnapshot,
  createFastPosterPlan,
  fastLayerState,
  removeFastPosterLayer,
  suggestPosterFastLayers,
} from './poster-fast-plan.js';
import { validatePosterPlan } from './poster-plan.js';

const fixturePixels = new Uint8ClampedArray(120 * 240 * 4).fill(255);
const fixturePlanInput = () => ({
  job_id: 'fast-job', project_id: 'project', image_id: 'image',
  source: { path: 'poster.png', width: 120, height: 240, aspect_ratio: 0.5, target_2x: true },
  output_directory: 'output/fast', layers: suggestPosterFastLayers({ data: fixturePixels, width: 120, height: 240 }),
});

test('fast suggestions group concrete projects under six Chinese categories', () => {
  const layers = suggestPosterFastLayers({ data: fixturePixels, width: 120, height: 240 });
  assert.deepEqual([...new Set(layers.map((layer) => layer.processing_category))], [
    'subject', 'text', 'brand_ui', 'decoration_prop', 'effect', 'background',
  ]);
  assert.ok(layers.every((layer) => layer.user_confirmed === false));
  assert.ok(layers.every((layer) => layer.bounds.source_pixels));
});

test('snapshot confirms only the selected layer and preserves the full-canvas source', () => {
  const plan = createFastPosterPlan(fixturePlanInput());
  const { snapshot } = buildFastLayerSnapshot(plan, 2, { prompt: '只保留日期' }, '2026-08-21T00:00:00.000Z');
  assert.equal(snapshot.layer.layer_index, 2);
  assert.equal(snapshot.source.width, plan.source.width);
  assert.equal(snapshot.user_confirmed, true);
  assert.equal(snapshot.skill_contract.base, 'lovart-poster-layering-v3-1');
  assert.equal(typeof snapshot.snapshot_id, 'string');
  assert.equal(snapshot.user_confirmed, true);
  assert.equal(validatePosterPlan(plan).valid, true);
});

test('snapshot persists the UI default remove-background choice explicitly', () => {
  const plan = createFastPosterPlan(fixturePlanInput());
  assert.equal(plan.layers[1].remove_background, undefined);
  const { snapshot } = buildFastLayerSnapshot(plan, 2, {}, '2026-08-21T00:00:00.000Z');
  assert.equal(snapshot.layer.remove_background, true);
});

test('targeted generation rejects confirmation without an immutable snapshot', () => {
  const plan = createFastPosterPlan(fixturePlanInput());
  plan.layers[0].state = 'GENERATING';
  plan.layers[0].user_confirmed = true;
  const result = validatePosterPlan(plan);
  assert.ok(result.errors.some((error) => error.code === 'SNAPSHOT_REQUIRED'));
});

test('snapshot IDs are deterministic, snapshots do not mutate plans, and selected layer only changes', () => {
  const plan = createFastPosterPlan(fixturePlanInput());
  const before = JSON.stringify(plan);
  const first = buildFastLayerSnapshot(plan, 2, { prompt: '只保留日期' }, '2026-08-21T00:00:00.000Z');
  const second = buildFastLayerSnapshot(plan, 2, { prompt: '只保留日期' }, '2026-08-21T00:00:00.000Z');
  assert.equal(first.snapshot.snapshot_id, second.snapshot.snapshot_id);
  assert.equal(JSON.stringify(plan), before);
  assert.equal(first.plan.layers[0].snapshot_id, undefined);
  assert.equal(first.plan.layers[1].snapshot_id, first.snapshot.snapshot_id);
  assert.ok(first.plan.layers[1].confirmed_snapshot);
});

test('snapshot verification rejects current-layer mutation and forged metadata', () => {
  const plan = createFastPosterPlan(fixturePlanInput());
  const { plan: confirmed } = buildFastLayerSnapshot(plan, 2, { prompt: '只保留日期' }, '2026-08-21T00:00:00.000Z');
  confirmed.layers[1].state = 'GENERATING';
  assert.equal(validatePosterPlan(confirmed).valid, true);
  confirmed.layers[1].prompt = '篡改提示词';
  assert.ok(validatePosterPlan(confirmed).errors.some((error) => error.code === 'SNAPSHOT_REQUIRED'));
  const forged = buildFastLayerSnapshot(plan, 2, { prompt: '只保留日期' }, '2026-08-21T00:00:00.000Z').plan;
  forged.layers[1].state = 'GENERATING';
  forged.layers[1].snapshot_user_confirmed = true;
  forged.layers[1].snapshot_plan_version = forged.plan_version;
  forged.layers[1].snapshot_id = 'forged';
  forged.layers[1].confirmed_snapshot = undefined;
  assert.ok(validatePosterPlan(forged).errors.some((error) => error.code === 'SNAPSHOT_REQUIRED'));
});

test('source pixel bounds remain inside one-pixel and fractional canvases', () => {
  const one = suggestPosterFastLayers({ width: 1, height: 1, data: new Uint8ClampedArray(4) });
  const fractional = suggestPosterFastLayers({ width: 3, height: 7, data: new Uint8ClampedArray(3 * 7 * 4) });
  for (const layer of [...one, ...fractional]) {
    const bounds = layer.bounds.source_pixels;
    assert.ok(bounds.x >= 0 && bounds.y >= 0);
    assert.ok(bounds.x + bounds.width <= (layer === one[0] ? 1 : 3));
    assert.ok(bounds.y + bounds.height <= (layer === one[0] ? 1 : 7));
  }
});

test('fast layer states use stable Chinese labels', () => {
  assert.equal(fastLayerState({ state: 'USER_CONFIRMED' }), '已确认');
  assert.equal(fastLayerState({ status: 'NEEDS_USER_REVIEW' }), '待人工复核');
});

test('deleting a fast project preserves stable layer indexes and selects the nearest survivor', () => {
  const plan = createFastPosterPlan(fixturePlanInput());
  const result = removeFastPosterLayer(plan, 2);

  assert.equal(result.plan.layers.length, 5);
  assert.deepEqual(result.plan.layers.map((layer) => layer.layer_index), [1, 3, 4, 5, 6]);
  assert.equal(result.plan.layers[1].processing_category, 'brand_ui');
  assert.equal(result.selectedLayerIndex, 3);
  assert.equal(plan.layers.length, 6);
});

test('fast project deletion refuses to remove the final surviving project', () => {
  const plan = createFastPosterPlan({ ...fixturePlanInput(), layers: suggestPosterFastLayers({ data: fixturePixels, width: 120, height: 240 }).slice(0, 1) });
  assert.throws(() => removeFastPosterLayer(plan, 1), /至少保留一个拆分项目/);
});
