import { annotationForPlan } from './annotation-plan.js';

const fullCanvasPercent = { x: 0, y: 0, width: 100, height: 100 };

function positivePixelSize(size) {
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('无法读取拆分结果 PNG 尺寸');
  }
  return { width: Math.round(width), height: Math.round(height) };
}

function isClosedPath(path) {
  return path?.shape === 'bezier_path'
    && path.closed === true
    && Array.isArray(path.anchors)
    && path.anchors.length >= 3;
}

export async function readPngPixelSize(blob, createBitmap = globalThis.createImageBitmap) {
  if (typeof createBitmap !== 'function') throw new Error('当前浏览器无法解码拆分结果 PNG 尺寸');
  const bitmap = await createBitmap(blob);
  try {
    return positivePixelSize(bitmap);
  } finally {
    bitmap?.close?.();
  }
}

export function canSubmitResultRefinement({ prompt, paths, draft }) {
  if (draft) return { ok: false, reason: '请先闭合或取消当前钢笔路径' };
  const hasPrompt = String(prompt || '').trim().length > 0;
  const hasClosedPath = Array.isArray(paths) && paths.some(isClosedPath);
  if (!hasPrompt && !hasClosedPath) {
    return { ok: false, reason: '请填写二次编辑要求或添加至少一条有效闭合路径' };
  }
  return { ok: true, reason: null };
}

export function buildResultRefinementPlan({
  pngSize,
  placement,
  prompt,
  paths = [],
  baseResult,
  layer,
  project,
}) {
  const canvas = positivePixelSize(pngSize);
  const pixelRegion = { x: 0, y: 0, ...canvas };
  const requirement = String(prompt || '').trim();
  return {
    version: '0.7',
    task: 'refine_split_result',
    project_id: project.projectId,
    image_id: project.imageId,
    source_fingerprint: project.sourceFingerprint || null,
    source_revision: project.sourceRevision,
    parent_job_id: baseResult.jobId,
    parent_version_id: baseResult.versionId || null,
    source: {
      file_name: baseResult.fileName,
      canvas,
      coordinate_space: 'result_pixels',
      source_uri: null,
      embedded_data_url: baseResult.dataUrl,
    },
    layers: [{
      layer_index: 1,
      id: layer.id,
      category: layer.category,
      category_label: layer.categoryLabel,
      name: layer.name,
      requirement,
      refinement_requirement: requirement || null,
      execution_route_hint: 'result_refinement',
      repair_engine: 'imagegen',
      maximum_imagegen_calls: 2,
      transparency_strategy: 'preserve_existing_alpha',
      rmbg_required: false,
      structure_validation_required: true,
      imagegen_input_kind: 'existing_result_png',
      imagegen_canvas_policy: 'prepared_result_locked_canvas',
      output_resolution_policy: 'existing_result_pixels',
      source_region_percent: fullCanvasPercent,
      source_region_pixels: pixelRegion,
      placement: { ...placement },
      review_snapshot: {
        placement: { ...placement },
      },
      mask_annotations: paths
        .filter(isClosedPath)
        .map((path, index) => annotationForPlan(path, fullCanvasPercent, canvas, index)),
      mask_policy: {
        selected_region: 'existing_result_full_canvas',
        keep_region: 'force_include_existing_result_pixels',
        exclude_region: 'force_remove_to_transparent',
        overlapping_keep_exclude: 'later_annotation_wins',
        manual_boundary: 'highest_priority_edge_override',
        preserve_unmarked_pixels: true,
      },
      execution_mode: layer.executionMode || 'fast',
      processing_route: 'result_refinement',
      remove_background: false,
      expected_output: {
        crop_to_source_region: true,
        ...pixelRegion,
      },
      output: {
        crop_to_source_region: true,
        ...pixelRegion,
      },
    }],
    constraints: {
      output_scope: 'selected_layers_only',
      auto_add_layers: false,
      edit_base: 'existing_split_result_png',
      preserve_unmarked_pixels: true,
      preserve_existing_alpha: true,
      final_png_canvas: 'exact_existing_result_canvas',
      visible_pixels: 'existing_result_pixel_locked_outside_annotations',
    },
  };
}
