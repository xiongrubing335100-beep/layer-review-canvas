import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildTargetedExecutionSpec } from './targeted-preflight.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'targeted-preflight-'));
  const jobId = 'layer-job-fixture';
  const jobDirectory = path.join(root, jobId);
  const finalDirectory = path.join(jobDirectory, 'final');
  await mkdir(finalDirectory, { recursive: true });
  const sourcePath = path.join(jobDirectory, 'source.png');
  const cropPath = path.join(jobDirectory, '01-selection.png');
  await writeFile(sourcePath, 'source');
  await writeFile(cropPath, 'crop');
  const plan = {
    output_directory: finalDirectory,
    source: { local_path: sourcePath },
    layers: [{
      layer_index: 1,
      id: 'layer-one',
      name: '组件',
      requirement: '移除\n文字',
      execution_mode: 'fast',
      execution_route_hint: 'targeted_repair',
      repair_engine: 'imagegen',
      requires_global_context: false,
      maximum_imagegen_calls: 1,
      rmbg_required: true,
      expected_output: { width: 120, height: 64, original_source_x: 8, original_source_y: 12 },
      review_snapshot: { local_crop_path: cropPath },
    }],
  };
  return { root, jobId, jobDirectory, finalDirectory, sourcePath, cropPath, plan };
}

function pngHeader(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function closedPath(width = 1536, height = 837) {
  return {
    id: 'path-1',
    order_index: 0,
    kind: 'boundary',
    semantics: 'edge_override',
    shape: 'bezier_path',
    coordinate_space: 'selected_region_normalized',
    anchors: [
      { x: 0, y: 0, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, handlesLinked: true },
      { x: 1, y: 0, in: { x: 1, y: 0 }, out: { x: 1, y: 0 }, handlesLinked: true },
      { x: 0, y: 1, in: { x: 0, y: 1 }, out: { x: 0, y: 1 }, handlesLinked: true },
    ],
    closed: true,
    source_polygon_pixels: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: 0, y: height },
      { x: 0, y: 0 },
    ],
  };
}

async function resultRefinementContext({ requirement = '增强按钮高光', paths = [] } = {}) {
  const context = await fixture();
  await writeFile(context.sourcePath, pngHeader(1536, 837));
  context.plan.task = 'refine_split_result';
  context.plan.source.canvas = { width: 1536, height: 837 };
  context.plan.layers[0] = {
    ...context.plan.layers[0],
    requirement,
    execution_route_hint: 'result_refinement',
    transparency_strategy: 'preserve_existing_alpha',
    rmbg_required: false,
    output_resolution_policy: 'existing_result_pixels',
    expected_output: { width: 1536, height: 837, original_source_x: 0, original_source_y: 0 },
    source_region_pixels: { x: 0, y: 0, width: 1536, height: 837 },
    mask_annotations: paths,
  };
  delete context.plan.layers[0].review_snapshot.local_crop_path;
  return context;
}

test('buildTargetedExecutionSpec returns a compact machine-readable spec', async () => {
  const context = await fixture();
  try {
    const spec = await buildTargetedExecutionSpec({
      ...context,
      clock: (() => {
        const values = ['2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.010Z'];
        return () => values.shift();
      })(),
    });
    assert.equal(spec.job_id, context.jobId);
    assert.equal(spec.layers[0].requirement, '移除 文字');
    assert.equal(spec.layers[0].maximum_imagegen_calls, 1);
    assert.deepEqual(spec.layers[0].expected_output, {
      width: 120,
      height: 64,
      original_source_x: 8,
      original_source_y: 12,
    });
    assert.equal(spec.output_directory, context.finalDirectory);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight preserves native ImageGen content resolution policy for repaired RMBG layers', async () => {
  const context = await fixture();
  try {
    context.plan.layers[0].remove_background = true;
    context.plan.layers[0].transparency_strategy = 'rembg';
    context.plan.layers[0].output_resolution_policy = 'native_imagegen_content';

    const spec = await buildTargetedExecutionSpec(context);

    assert.equal(spec.layers[0].output_resolution_policy, 'native_imagegen_content');
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight rejects output path escape, missing files, invalid size, and layer order', async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      buildTargetedExecutionSpec({ ...context, plan: { ...context.plan, output_directory: path.join(context.root, 'other') } }),
      /输出目录/,
    );
    await assert.rejects(
      buildTargetedExecutionSpec({
        ...context,
        plan: { ...context.plan, source: { local_path: path.join(context.root, 'missing.png') } },
      }),
      /原图不存在/,
    );
    await assert.rejects(
      buildTargetedExecutionSpec({
        ...context,
        plan: { ...context.plan, layers: [{ ...context.plan.layers[0], expected_output: { width: 0, height: 2, original_source_x: 0, original_source_y: 0 } }] },
      }),
      /期望输出尺寸/,
    );
    await assert.rejects(
      buildTargetedExecutionSpec({
        ...context,
        plan: { ...context.plan, layers: [{ ...context.plan.layers[0], layer_index: 2 }] },
      }),
      /顺序不一致/,
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight rejects repair regions without an allowed source', async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      buildTargetedExecutionSpec({
        ...context,
        plan: { ...context.plan, layers: [{ ...context.plan.layers[0], repair_regions: [{ x: 0, y: 0, width: 1, height: 1 }] }] },
      }),
      /repair_region_source/,
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight preserves the Codex RGBA contract for title layers', async () => {
  const context = await fixture();
  try {
    const layer = {
      ...context.plan.layers[0],
      category: 'kvTitle',
      execution_route_hint: 'codex_rgba',
      repair_engine: 'none',
      maximum_imagegen_calls: 1,
      remove_background: true,
      transparency_strategy: 'codex_rgba',
      rmbg_required: false,
      structure_validation_required: true,
    };
    const spec = await buildTargetedExecutionSpec({
      ...context,
      plan: { ...context.plan, layers: [layer] },
    });

    assert.equal(spec.layers[0].transparency_strategy, 'codex_rgba');
    assert.equal(spec.layers[0].rmbg_required, false);
    assert.equal(spec.layers[0].structure_validation_required, true);
    assert.equal(spec.layers[0].imagegen_input_kind, 'codex_alpha_matte');
    assert.equal(spec.layers[0].imagegen_canvas_policy, 'prepared_source_locked_canvas');
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight rejects the unsupported targeted repair plus Codex RGBA combination', async () => {
  const context = await fixture();
  try {
    const layer = {
      ...context.plan.layers[0],
      category: 'kvTitle',
      execution_route_hint: 'targeted_repair',
      remove_background: true,
      transparency_strategy: 'codex_rgba',
      rmbg_required: false,
    };
    await assert.rejects(
      buildTargetedExecutionSpec({
        ...context,
        plan: { ...context.plan, layers: [layer] },
      }),
      /targeted_repair.*codex_rgba/,
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight accepts result refinement without a separate crop preview', async () => {
  const context = await resultRefinementContext();
  try {
    const spec = await buildTargetedExecutionSpec(context);

    assert.equal(spec.layers[0].crop_path, context.sourcePath);
    assert.equal(spec.layers[0].transparency_strategy, 'preserve_existing_alpha');
    assert.equal(spec.layers[0].output_resolution_policy, 'existing_result_pixels');
    assert.deepEqual(spec.layers[0].expected_output, {
      width: 1536,
      height: 837,
      original_source_x: 0,
      original_source_y: 0,
    });
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight accepts a path-only result refinement with valid closed Bezier pixels', async () => {
  const context = await resultRefinementContext({ requirement: '  ', paths: [closedPath()] });
  try {
    const spec = await buildTargetedExecutionSpec(context);

    assert.equal(spec.layers[0].requirement, '');
    assert.deepEqual(spec.layers[0].mask_annotations, [closedPath()]);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight requires the refinement task, readable PNG, exact dimensions, and alpha contract', async () => {
  const context = await resultRefinementContext();
  try {
    context.plan.task = 'split_ui_layers';
    await assert.rejects(buildTargetedExecutionSpec(context), /refine_split_result/);

    context.plan.task = 'refine_split_result';
    await writeFile(context.sourcePath, 'not a png');
    await assert.rejects(buildTargetedExecutionSpec(context), /PNG/);

    await writeFile(context.sourcePath, pngHeader(1536, 837));
    context.plan.source.canvas.width = 1535;
    await assert.rejects(buildTargetedExecutionSpec(context), /PNG.*尺寸|尺寸.*PNG/);

    context.plan.source.canvas.width = 1536;
    context.plan.layers[0].expected_output.width = 1535;
    await assert.rejects(buildTargetedExecutionSpec(context), /期望输出.*PNG|PNG.*期望输出/);

    context.plan.layers[0].expected_output.width = 1536;
    context.plan.layers[0].transparency_strategy = 'rembg';
    await assert.rejects(buildTargetedExecutionSpec(context), /preserve_existing_alpha/);

    context.plan.layers[0].transparency_strategy = 'preserve_existing_alpha';
    context.plan.layers[0].rmbg_required = true;
    await assert.rejects(buildTargetedExecutionSpec(context), /RMBG/);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight requires result refinement text or a valid closed Bezier path', async () => {
  const context = await resultRefinementContext({ requirement: ' \n ', paths: [] });
  try {
    await assert.rejects(buildTargetedExecutionSpec(context), /要求.*闭合路径/);

    context.plan.layers[0].mask_annotations = [{ ...closedPath(), closed: false }];
    await assert.rejects(buildTargetedExecutionSpec(context), /closed|闭合/);

    context.plan.layers[0].mask_annotations = [{ ...closedPath(), anchors: closedPath().anchors.slice(0, 2) }];
    await assert.rejects(buildTargetedExecutionSpec(context), /anchor|锚点/);

    context.plan.layers[0].mask_annotations = [{
      ...closedPath(),
      source_polygon_pixels: closedPath().source_polygon_pixels.slice(0, 2),
    }];
    await assert.rejects(buildTargetedExecutionSpec(context), /source_polygon_pixels|扁平/);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight rejects non-finite or out-of-bounds refinement path coordinates', async () => {
  const context = await resultRefinementContext({ requirement: '', paths: [closedPath()] });
  try {
    context.plan.layers[0].mask_annotations[0].anchors[1].x = 1.01;
    await assert.rejects(buildTargetedExecutionSpec(context), /anchor|锚点/);

    context.plan.layers[0].mask_annotations[0] = closedPath();
    context.plan.layers[0].mask_annotations[0].anchors[1].out.x = Number.POSITIVE_INFINITY;
    await assert.rejects(buildTargetedExecutionSpec(context), /anchor|锚点|控制柄/);

    context.plan.layers[0].mask_annotations[0] = closedPath();
    context.plan.layers[0].mask_annotations[0].source_polygon_pixels[1].x = 1537;
    await assert.rejects(buildTargetedExecutionSpec(context), /source_polygon_pixels|扁平|边界/);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});
