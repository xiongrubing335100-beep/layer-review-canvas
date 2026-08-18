import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { buildTargetedExecutionSpec } from './targeted-preflight.js';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(...buffers) {
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0), { corruptCrc = false } = {}) {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE((crc32(typeBytes, data) + (corruptCrc ? 1 : 0)) >>> 0, 8 + data.length);
  return chunk;
}

function pngFixture(width, height, {
  bitDepth = 8,
  colorType = 6,
  interlace = 0,
  ihdrLength = 13,
  ancillaryBeforeIhdr = false,
  duplicateIhdr = false,
  includeIdat = true,
  includeIend = true,
  corruptIdatCrc = false,
  compressedData = null,
  compressedTrailing = null,
  rowFilter = 0,
  trailing = null,
} = {}) {
  const ihdrData = Buffer.alloc(ihdrLength);
  if (ihdrLength >= 8) {
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
  }
  if (ihdrLength >= 13) {
    ihdrData[8] = bitDepth;
    ihdrData[9] = colorType;
    ihdrData[10] = 0;
    ihdrData[11] = 0;
    ihdrData[12] = interlace;
  }
  const ihdr = pngChunk('IHDR', ihdrData);
  const rowBytes = width * 4 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) raw[y * rowBytes] = rowFilter;
  const parts = [pngSignature];
  if (ancillaryBeforeIhdr) parts.push(pngChunk('tEXt', Buffer.from('before')));
  parts.push(ihdr);
  if (duplicateIhdr) parts.push(ihdr);
  if (includeIdat) {
    const encoded = compressedData ?? deflateSync(raw);
    const idatData = compressedTrailing ? Buffer.concat([encoded, compressedTrailing]) : encoded;
    parts.push(pngChunk('IDAT', idatData, { corruptCrc: corruptIdatCrc }));
  }
  if (includeIend) parts.push(pngChunk('IEND'));
  if (trailing) parts.push(trailing);
  return Buffer.concat(parts);
}

const validResultPng = pngFixture(1536, 837);
const roiPolicy = {
  strategy: 'per_repair_path_native_tiles',
  scale_mode: 'native_1_to_1',
  context_padding_ratio: 0.08,
  minimum_padding_ratio: 0.03,
  maximum_padding_ratio: 0.15,
  warn_coverage_ratio: 0.4,
  block_coverage_ratio: 0.7,
  tile_overlap_pixels: 32,
};

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

function polygonPath(id, kind, points, width = 100, height = 100) {
  const alreadyClosed = points.at(-1)?.x === points[0]?.x && points.at(-1)?.y === points[0]?.y;
  const vertices = alreadyClosed ? points.slice(0, -1) : points;
  const polygon = alreadyClosed ? points : [...points, points[0]];
  return {
    id,
    order_index: 0,
    kind,
    semantics: kind === 'boundary' ? 'edge_override' : 'mask',
    shape: 'bezier_path',
    coordinate_space: 'selected_region_normalized',
    anchors: vertices.map((point) => ({
      x: point.x / width,
      y: point.y / height,
      in: { x: point.x / width, y: point.y / height },
      out: { x: point.x / width, y: point.y / height },
      handlesLinked: true,
    })),
    closed: true,
    source_polygon_pixels: polygon,
  };
}

async function resultRefinementContext({
  requirement = '增强按钮高光',
  paths = [],
  operation = null,
  width = 1536,
  height = 837,
} = {}) {
  const context = await fixture();
  await writeFile(context.sourcePath, width === 1536 && height === 837
    ? validResultPng
    : pngFixture(width, height));
  const refinementOperation = operation || (paths.length > 0
    ? { mode: 'path_scoped', subject_path_ids: [], alpha_include_path_ids: [] }
    : { mode: 'full_canvas_explicit', subject_path_ids: [], alpha_include_path_ids: [] });
  context.plan.task = 'refine_split_result';
  context.plan.version = '0.8';
  context.plan.source.canvas = { width, height };
  context.plan.layers[0] = {
    ...context.plan.layers[0],
    requirement,
    normalized_user_requirement: String(requirement).trim().replace(/\s+/g, ' '),
    refinement_operation: refinementOperation,
    roi_policy: { ...roiPolicy },
    execution_route_hint: 'result_refinement',
    transparency_strategy: 'preserve_existing_alpha',
    rmbg_required: false,
    output_resolution_policy: 'existing_result_pixels',
    maximum_imagegen_calls: 2,
    expected_output: { width, height, original_source_x: 0, original_source_y: 0 },
    source_region_pixels: { x: 0, y: 0, width, height },
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

test('preflight rejects layer ids that are unsafe on POSIX or Windows', async () => {
  const context = await fixture();
  try {
    for (const layerId of ['../escape', '..\\escape', 'C:\\escape', '/tmp/escape', '\\\\server\\share', 123, {}]) {
      await assert.rejects(
        buildTargetedExecutionSpec({
          ...context,
          plan: { ...context.plan, layers: [{ ...context.plan.layers[0], id: layerId }] },
        }),
        /layer id/i,
      );
    }
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

test('preflight accepts an erase-only result refinement without ImageGen calls', async () => {
  const erasePath = polygonPath('erase-copy', 'erase', [
    { x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 },
  ]);
  const context = await resultRefinementContext({ requirement: '  ', paths: [erasePath], width: 100, height: 100 });
  context.plan.layers[0].maximum_imagegen_calls = 0;
  try {
    const spec = await buildTargetedExecutionSpec(context);

    assert.equal(spec.layers[0].requirement, '');
    assert.deepEqual(spec.layers[0].erase_path_ids, ['erase-copy']);
    assert.deepEqual(spec.layers[0].repair_path_ids, []);
    assert.equal(spec.layers[0].expected_roi_tile_count, 0);
    assert.equal(spec.layers[0].maximum_imagegen_calls, 0);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight keeps explicit full-canvas erase-only work deterministic', async () => {
  const erasePath = polygonPath('erase-copy', 'erase', [
    { x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 },
  ]);
  const context = await resultRefinementContext({
    requirement: '',
    paths: [erasePath],
    operation: {
      mode: 'full_canvas_explicit', subject_path_ids: [], alpha_include_path_ids: [],
    },
    width: 100,
    height: 100,
  });
  context.plan.layers[0].maximum_imagegen_calls = 0;
  try {
    const spec = await buildTargetedExecutionSpec(context);
    assert.equal(spec.layers[0].expected_roi_tile_count, 0);
    assert.equal(spec.layers[0].maximum_imagegen_calls, 0);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight rejects text-only local mode and accepts explicit full-canvas text editing', async () => {
  const context = await resultRefinementContext({
    operation: { mode: 'path_scoped', subject_path_ids: [], alpha_include_path_ids: [] },
  });
  try {
    await assert.rejects(buildTargetedExecutionSpec(context), /局部.*闭合路径/);

    context.plan.layers[0].refinement_operation.mode = 'full_canvas_explicit';
    const spec = await buildTargetedExecutionSpec(context);
    assert.equal(spec.layers[0].refinement_operation.mode, 'full_canvas_explicit');
    assert.equal(spec.layers[0].expected_roi_tile_count, 1);
    assert.equal(spec.layers[0].maximum_imagegen_calls, 2);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight independently derives path roles, coverage, tile count, and normalized requirement', async () => {
  const paths = [
    polygonPath('subject', 'boundary', [
      { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
    ]),
    polygonPath('repair', 'boundary', [
      { x: 30, y: 30 }, { x: 50, y: 30 }, { x: 50, y: 50 }, { x: 30, y: 50 },
    ]),
    polygonPath('erase', 'background', [
      { x: 60, y: 60 }, { x: 70, y: 60 }, { x: 70, y: 70 }, { x: 60, y: 70 },
    ]),
    polygonPath('protect', 'foreground', [
      { x: 75, y: 75 }, { x: 85, y: 75 }, { x: 85, y: 85 }, { x: 75, y: 85 },
    ]),
  ];
  const operation = {
    mode: 'keep_inside_delete_outside',
    subject_path_ids: ['subject'],
    alpha_include_path_ids: ['repair'],
  };
  const context = await resultRefinementContext({
    requirement: '  补全\n  金币  ', paths, operation, width: 100, height: 100,
  });
  Object.assign(context.plan.layers[0], {
    repair_path_ids: ['tampered'],
    erase_path_ids: [],
    protect_path_ids: [],
    subject_path_ids: [],
    alpha_include_path_ids: [],
    repair_coverage_ratio: 0,
    expected_roi_tile_count: 99,
  });
  try {
    const spec = await buildTargetedExecutionSpec(context);
    const layer = spec.layers[0];
    assert.equal(layer.normalized_user_requirement, '补全 金币');
    assert.deepEqual(layer.repair_path_ids, ['repair']);
    assert.deepEqual(layer.erase_path_ids, ['erase']);
    assert.deepEqual(layer.protect_path_ids, ['protect']);
    assert.deepEqual(layer.subject_path_ids, ['subject']);
    assert.deepEqual(layer.alpha_include_path_ids, ['repair']);
    assert.equal(layer.repair_coverage_ratio, 0.04);
    assert.equal(layer.expected_roi_tile_count, 1);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight counts padded native repair tiles with 32-pixel overlap', async () => {
  const repair = polygonPath('wide-repair', 'boundary', [
    { x: 500, y: 300 }, { x: 3480, y: 300 }, { x: 3480, y: 700 }, { x: 500, y: 700 },
  ], 4000, 1000);
  const context = await resultRefinementContext({ paths: [repair], width: 4000, height: 1000 });
  context.plan.layers[0].maximum_imagegen_calls = 6;
  try {
    const spec = await buildTargetedExecutionSpec(context);
    assert.equal(spec.layers[0].expected_roi_tile_count, 3);
    assert.equal(spec.layers[0].maximum_imagegen_calls, 6);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight rejects invalid operation references and unsafe or duplicate path ids', async () => {
  const subject = polygonPath('subject', 'boundary', [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
  ]);
  const erase = polygonPath('erase', 'erase', [
    { x: 30, y: 30 }, { x: 40, y: 30 }, { x: 40, y: 40 }, { x: 30, y: 40 },
  ]);
  const context = await resultRefinementContext({ requirement: '', paths: [subject, erase], width: 100, height: 100 });
  context.plan.layers[0].maximum_imagegen_calls = 2;
  try {
    context.plan.layers[0].refinement_operation = {
      mode: 'keep_inside_delete_outside', subject_path_ids: ['missing'], alpha_include_path_ids: [],
    };
    await assert.rejects(buildTargetedExecutionSpec(context), /subject_path_ids.*boundary/);

    context.plan.layers[0].refinement_operation.subject_path_ids = ['erase'];
    await assert.rejects(buildTargetedExecutionSpec(context), /subject_path_ids.*boundary/);

    context.plan.layers[0].refinement_operation = {
      mode: 'unknown', subject_path_ids: [], alpha_include_path_ids: [],
    };
    await assert.rejects(buildTargetedExecutionSpec(context), /operation mode/);

    context.plan.layers[0].refinement_operation = {
      mode: 'path_scoped', subject_path_ids: [], alpha_include_path_ids: [],
    };
    context.plan.layers[0].mask_annotations[0].id = '../repair';
    await assert.rejects(buildTargetedExecutionSpec(context), /path id|路径 id/i);

    context.plan.layers[0].mask_annotations[0].id = 'erase';
    await assert.rejects(buildTargetedExecutionSpec(context), /重复|duplicate/i);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight rejects a self-intersecting polygon whose shoelace area is nonzero', async () => {
  const selfIntersecting = polygonPath('crossed', 'boundary', [
    { x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 80, y: 0 },
  ]);
  const context = await resultRefinementContext({ paths: [selfIntersecting], width: 100, height: 100 });
  try {
    await assert.rejects(buildTargetedExecutionSpec(context), /不得自交/);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight rejects a zero-area polygon', async () => {
  const zeroArea = polygonPath('flat', 'boundary', [
    { x: 0, y: 10 }, { x: 50, y: 10 }, { x: 100, y: 10 },
  ]);
  const context = await resultRefinementContext({ paths: [zeroArea], width: 100, height: 100 });
  try {
    await assert.rejects(buildTargetedExecutionSpec(context), /面积/);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight enforces normalized requirements and structured text authority', async () => {
  const repair = polygonPath('repair', 'boundary', [
    { x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 },
  ]);
  const context = await resultRefinementContext({ requirement: '', paths: [repair], width: 100, height: 100 });
  try {
    await assert.rejects(buildTargetedExecutionSpec(context), /修复路径.*修改目标/);

    context.plan.layers[0].requirement = '把路径外删除';
    context.plan.layers[0].normalized_user_requirement = '把路径外删除';
    await assert.rejects(buildTargetedExecutionSpec(context), /仅保留路径内/);

    context.plan.layers[0].requirement = '对整图进行调整';
    context.plan.layers[0].normalized_user_requirement = '对整图进行调整';
    await assert.rejects(buildTargetedExecutionSpec(context), /整图编辑/);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight recomputes the 40% warning and blocks an actual 80% repair polygon', async () => {
  const warning = polygonPath('warning', 'boundary', [
    { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 0, y: 100 },
  ]);
  const context = await resultRefinementContext({ paths: [warning], width: 100, height: 100 });
  try {
    const spec = await buildTargetedExecutionSpec(context);
    assert.equal(spec.layers[0].repair_coverage_ratio, 0.5);
    assert.deepEqual(spec.layers[0].refinement_warnings, ['局部修复路径范围较大，可能产生重新构图']);

    context.plan.layers[0].mask_annotations = [polygonPath('blocking', 'boundary', [
      { x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 100 }, { x: 0, y: 100 },
    ])];
    await assert.rejects(buildTargetedExecutionSpec(context), /覆盖超过 70%/);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight uses repair polygon union coverage for fully overlapping paths', async () => {
  const overlap = [
    { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 100 }, { x: 0, y: 100 },
  ];
  const context = await resultRefinementContext({
    requirement: '修复重叠区域',
    paths: [
      polygonPath('overlap-a', 'boundary', overlap),
      polygonPath('overlap-b', 'boundary', overlap),
    ],
    width: 100,
    height: 100,
  });
  context.plan.layers[0].maximum_imagegen_calls = 4;
  try {
    const spec = await buildTargetedExecutionSpec(context);
    assert.equal(spec.layers[0].repair_coverage_ratio, 0.6);
    assert.deepEqual(spec.layers[0].refinement_warnings, ['局部修复路径范围较大，可能产生重新构图']);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight rejects tampered plan version, ROI scale policy, call budget, and normalized text', async () => {
  const context = await resultRefinementContext();
  try {
    context.plan.version = '0.7';
    await assert.rejects(buildTargetedExecutionSpec(context), /0\.8/);

    context.plan.version = '0.8';
    context.plan.layers[0].roi_policy.scale_mode = 'fit';
    await assert.rejects(buildTargetedExecutionSpec(context), /native_1_to_1|1:1/);

    context.plan.layers[0].roi_policy = { ...roiPolicy };
    context.plan.layers[0].maximum_imagegen_calls = 99;
    await assert.rejects(buildTargetedExecutionSpec(context), /调用上限.*策略|预算/);

    context.plan.layers[0].maximum_imagegen_calls = 2;
    context.plan.layers[0].normalized_user_requirement = '被篡改';
    await assert.rejects(buildTargetedExecutionSpec(context), /normalized_user_requirement/);
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

    await writeFile(context.sourcePath, validResultPng);
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

test('preflight derives and locks every fixed result refinement route field', async () => {
  const context = await resultRefinementContext();
  try {
    delete context.plan.layers[0].transparency_strategy;
    delete context.plan.layers[0].rmbg_required;
    delete context.plan.layers[0].output_resolution_policy;
    const inferred = await buildTargetedExecutionSpec(context);
    assert.equal(inferred.layers[0].transparency_strategy, 'preserve_existing_alpha');
    assert.equal(inferred.layers[0].rmbg_required, false);
    assert.equal(inferred.layers[0].output_resolution_policy, 'existing_result_pixels');

    for (const maliciousRmbg of ['false', 0, 1, null]) {
      context.plan.layers[0].rmbg_required = maliciousRmbg;
      await assert.rejects(buildTargetedExecutionSpec(context), /RMBG/);
    }

    delete context.plan.layers[0].rmbg_required;
    context.plan.layers[0].output_resolution_policy = 'logical_crop';
    await assert.rejects(buildTargetedExecutionSpec(context), /existing_result_pixels/);

    delete context.plan.layers[0].output_resolution_policy;
    context.plan.layers[0].transparency_strategy = '';
    await assert.rejects(buildTargetedExecutionSpec(context), /preserve_existing_alpha/);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight rejects structurally invalid or unreadable result PNG sources', async () => {
  const malformedPngs = [
    ['truncated chunk', validResultPng.subarray(0, validResultPng.length - 2)],
    ['CRC mismatch', pngFixture(1536, 837, { corruptIdatCrc: true })],
    ['invalid zlib stream', pngFixture(1536, 837, { compressedData: Buffer.from('not-zlib') })],
    ['missing IDAT', pngFixture(1536, 837, { includeIdat: false })],
    ['missing IEND', pngFixture(1536, 837, { includeIend: false })],
    ['trailing data', pngFixture(1536, 837, { trailing: Buffer.from([0]) })],
    ['IHDR is not first', pngFixture(1536, 837, { ancillaryBeforeIhdr: true })],
    ['invalid IHDR length', pngFixture(1536, 837, { ihdrLength: 12 })],
    ['duplicate IHDR', pngFixture(1536, 837, { duplicateIhdr: true })],
    ['unsupported pixel format', pngFixture(1536, 837, { colorType: 2 })],
    ['invalid scanline filter', pngFixture(1536, 837, { rowFilter: 5 })],
  ];

  await Promise.all(malformedPngs.map(async ([label, png]) => {
    const context = await resultRefinementContext();
    try {
      await writeFile(context.sourcePath, png);
      await assert.rejects(buildTargetedExecutionSpec(context), /PNG/, label);
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  }));
});

test('preflight rejects CRC-valid trailing garbage inside concatenated IDAT data', async () => {
  const context = await resultRefinementContext();
  try {
    await writeFile(context.sourcePath, pngFixture(1536, 837, {
      compressedTrailing: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    }));
    await assert.rejects(buildTargetedExecutionSpec(context), /PNG.*IDAT|IDAT.*PNG/);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('preflight requires result refinement text or a valid closed Bezier path', async () => {
  const context = await resultRefinementContext({
    requirement: ' \n ',
    paths: [],
    operation: { mode: 'path_scoped', subject_path_ids: [], alpha_include_path_ids: [] },
  });
  try {
    await assert.rejects(buildTargetedExecutionSpec(context), /局部.*闭合路径/);

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
