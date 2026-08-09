import { annotationForPlan } from './annotation-plan.js';
import {
  RESULT_REFINEMENT_ROI_POLICY,
  deriveRefinementPolicy,
  refinementSubmissionState,
} from './result-refinement-policy.js';

const fullCanvasPercent = { x: 0, y: 0, width: 100, height: 100 };
const preDeliveryStatuses = new Set([
  'queued',
  'awaiting_codex_message',
  'sending_to_codex',
  'host_accepted',
  'submitted_to_conversation',
]);

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

export function canSubmitResultRefinement({ prompt, paths, draft, operation, canvas }) {
  if (operation || canvas) {
    return refinementSubmissionState({ prompt, paths, draft, operation, canvas });
  }
  if (draft) return { ok: false, reason: '请先闭合或取消当前钢笔路径' };
  const hasPrompt = String(prompt || '').trim().length > 0;
  const hasClosedPath = Array.isArray(paths) && paths.some(isClosedPath);
  if (!hasPrompt && !hasClosedPath) {
    return { ok: false, reason: '请填写二次编辑要求或添加至少一条有效闭合路径' };
  }
  return { ok: true, reason: null };
}

function appendRevisionJob(currentJobs, revisionJob) {
  const jobs = Array.isArray(currentJobs) ? currentJobs : [];
  if (jobs.some((job) => job.id === revisionJob.id)) return jobs;
  return [...jobs, revisionJob];
}

export async function recordResultRefinementDelivery({
  delivery,
  revisionJob,
  setJobs,
  sendFollowUpMessage,
  markMessageSent,
}) {
  const followsCurrentConversation = delivery.delivery_channel === 'current_conversation';
  if (followsCurrentConversation) await sendFollowUpMessage(delivery.prompt);
  const deliveredRevisionJob = followsCurrentConversation
    ? { ...revisionJob, status: 'sent_to_codex', deliveredToConversation: true }
    : revisionJob;
  setJobs((current) => appendRevisionJob(current, deliveredRevisionJob));

  let acknowledgementError = null;
  if (followsCurrentConversation) {
    try {
      await markMessageSent(delivery.job_id);
    } catch (error) {
      acknowledgementError = error;
    }
  }
  return { followUpPosted: followsCurrentConversation, acknowledgementError };
}

export function mergeResultRefinementPollUpdate(currentJob, polledJob) {
  const protectsDeliveredRevision = currentJob?.editKind === 'result_refinement'
    && currentJob.deliveredToConversation === true
    && preDeliveryStatuses.has(polledJob?.status);
  if (!protectsDeliveredRevision) return polledJob;
  return {
    ...polledJob,
    status: currentJob.status,
    statusDetail: currentJob.statusDetail,
    deliveredToConversation: true,
  };
}

export function buildResultRefinementPlan({
  pngSize,
  placement,
  prompt,
  paths = [],
  operation = {
    mode: 'path_scoped',
    subject_path_ids: [],
    alpha_include_path_ids: [],
  },
  baseResult,
  layer,
  project,
}) {
  const canvas = positivePixelSize(pngSize);
  const pixelRegion = { x: 0, y: 0, ...canvas };
  const requirement = String(prompt || '').trim();
  const validPaths = paths.filter(isClosedPath);
  const baseAnnotations = validPaths
    .map((path, index) => annotationForPlan(path, fullCanvasPercent, canvas, index));
  const refinementPolicy = deriveRefinementPolicy({
    prompt,
    annotations: baseAnnotations,
    operation,
    canvas,
  });
  const roleByPathId = new Map([
    ...refinementPolicy.repair_path_ids.map((id) => [id, 'repair']),
    ...refinementPolicy.erase_path_ids.map((id) => [id, 'erase']),
    ...refinementPolicy.protect_path_ids.map((id) => [id, 'protect']),
    ...refinementPolicy.subject_path_ids.map((id) => [id, 'subject']),
  ]);
  const annotations = baseAnnotations.map((annotation) => ({
    ...annotation,
    ...(roleByPathId.has(annotation.id)
      ? { operation_role: roleByPathId.get(annotation.id) }
      : {}),
  }));
  const pathScoped = operation.mode !== 'full_canvas_explicit' && validPaths.length > 0;
  return {
    version: '0.8',
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
      refinement_operation: operation,
      normalized_user_requirement: refinementPolicy.normalized_user_requirement,
      roi_policy: { ...RESULT_REFINEMENT_ROI_POLICY },
      execution_route_hint: 'result_refinement',
      repair_engine: 'imagegen',
      maximum_imagegen_calls: refinementPolicy.maximum_imagegen_calls,
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
      mask_annotations: annotations,
      mask_policy: {
        selected_region: 'existing_result_full_canvas',
        edit_scope: pathScoped ? 'closed_paths_only' : 'full_result_canvas',
        keep_region: 'force_include_existing_result_pixels',
        exclude_region: 'force_remove_to_transparent',
        overlapping_keep_exclude: 'later_annotation_wins',
        manual_boundary: 'highest_priority_edge_override',
        preserve_unmarked_pixels: pathScoped,
        preserve_existing_alpha_outside_annotations: pathScoped,
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
      preserve_unmarked_pixels: pathScoped,
      preserve_existing_alpha: true,
      final_png_canvas: 'exact_existing_result_canvas',
      visible_pixels: pathScoped
        ? 'existing_result_pixel_locked_outside_annotations'
        : 'full_canvas_editable',
      alpha_edit_scope: pathScoped
        ? 'locked_outside_closed_paths'
        : 'full_canvas_editable_preserve_alpha_structure',
    },
  };
}
