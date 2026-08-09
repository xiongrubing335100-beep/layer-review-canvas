import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildRouteMetadata } from './split-execution.js';

const allowedRoutes = new Set(['direct_crop', 'alpha_extract', 'codex_rgba', 'targeted_repair']);
const jobIdPattern = /^layer-job-[a-zA-Z0-9._-]+$/;

function fail(message, code = 'PREFLIGHT_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function requireFile(filePath, label) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 0) throw fail(`${label}不是有效文件`);
  } catch (error) {
    if (error.code === 'ENOENT') throw fail(`${label}不存在`);
    throw error;
  }
  await access(filePath);
  return filePath;
}

function normalizeRequirement(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function expectedOutput(layer) {
  const output = layer.expected_output || layer.output || {};
  const width = Number(output.width);
  const height = Number(output.height);
  const x = Number(output.original_source_x ?? layer.source_region_pixels?.x);
  const y = Number(output.original_source_y ?? layer.source_region_pixels?.y);
  if (![width, height, x, y].every(Number.isFinite) || width <= 0 || height <= 0 || x < 0 || y < 0) {
    throw fail(`${layer.name || layer.id || '图层'}缺少有效的期望输出尺寸或原始坐标`);
  }
  return { width, height, original_source_x: x, original_source_y: y };
}

function repairRegions(layer) {
  if (layer.repair_regions === undefined || layer.repair_regions === null) return null;
  if (!Array.isArray(layer.repair_regions)) throw fail(`${layer.name || layer.id || '图层'}的 repair_regions 必须是数组`);
  const source = layer.repair_region_source;
  if (!['submitted_annotation', 'codex_declared'].includes(source)) {
    throw fail(`${layer.name || layer.id || '图层'}的 repair_region_source 不受支持`);
  }
  return layer.repair_regions;
}

export async function buildTargetedExecutionSpec({
  jobId,
  jobDirectory,
  plan,
  clock = () => new Date().toISOString(),
}) {
  const preflightStartedAt = clock();
  if (!jobIdPattern.test(String(jobId || ''))) throw fail('jobId 格式无效');
  if (path.basename(path.resolve(jobDirectory)) !== jobId) throw fail('jobId 与任务目录不一致');
  if (!plan || typeof plan !== 'object') throw fail('权威计划无效');

  const finalDirectory = path.resolve(jobDirectory, 'final');
  const outputDirectory = path.resolve(plan.output_directory || finalDirectory);
  if (outputDirectory !== finalDirectory) throw fail('输出目录必须位于当前任务的 final 目录');
  const sourcePath = plan.source?.local_path;
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw fail('权威计划缺少原图本地路径');
  await requireFile(sourcePath, '原图');

  if (!Array.isArray(plan.layers) || plan.layers.length === 0) throw fail('权威计划缺少 layers[]');
  const layers = [];
  for (const [index, layer] of plan.layers.entries()) {
    const layerName = layer.name || layer.id || `拆分项 ${index + 1}`;
    if (layer.layer_index !== undefined && layer.layer_index !== index + 1) {
      throw fail(`${layerName} 的 layer_index 顺序不一致`);
    }
    const route = layer.execution_route_hint;
    if (!allowedRoutes.has(route)) throw fail(`${layerName} 的执行路线不受支持`);
    const cropPath = layer.review_snapshot?.local_crop_path;
    if (typeof cropPath !== 'string' || !path.isAbsolute(cropPath)) throw fail(`${layerName} 缺少框选预览本地路径`);
    await requireFile(cropPath, `${layerName}框选预览`);
    const output = expectedOutput(layer);
    const repairRegionsValue = repairRegions(layer);
    const inferredMetadata = buildRouteMetadata({
      category: layer.category,
      requirement: layer.requirement,
      executionMode: layer.execution_mode || 'fast',
      executionRoute: route,
      removeBackground: Boolean(layer.remove_background),
      sourceRegionPixels: output,
    });
    const transparency = layer.transparency_strategy || inferredMetadata.transparency_strategy;
    if (route === 'targeted_repair' && transparency === 'codex_rgba') {
      throw fail(`${layerName} 不支持 targeted_repair 与 codex_rgba 组合；文字透明层必须使用 codex_rgba 路线`);
    }
    const repairEngine = layer.repair_engine ?? inferredMetadata.repair_engine;
    const maximumImagegenCalls = Number(layer.maximum_imagegen_calls ?? inferredMetadata.maximum_imagegen_calls);
    if (!Number.isInteger(maximumImagegenCalls) || maximumImagegenCalls < 0) {
      throw fail(`${layerName} 的 ImageGen 调用上限无效`);
    }
    layers.push({
      layer_index: index + 1,
      id: layer.id || `layer-${index + 1}`,
      name: layerName,
      category: layer.category || null,
      requirement: normalizeRequirement(layer.requirement),
      execution_mode: layer.execution_mode || 'fast',
      execution_route_hint: route,
      repair_engine: repairEngine,
      requires_global_context: layer.requires_global_context === undefined
        ? inferredMetadata.requires_global_context
        : Boolean(layer.requires_global_context),
      maximum_imagegen_calls: maximumImagegenCalls,
      transparency_strategy: transparency,
      rmbg_required: Boolean(layer.rmbg_required ?? inferredMetadata.rmbg_required),
      structure_validation_required: Boolean(
        layer.structure_validation_required ?? inferredMetadata.structure_validation_required
      ),
      imagegen_input_kind: layer.imagegen_input_kind ?? inferredMetadata.imagegen_input_kind,
      imagegen_canvas_policy: layer.imagegen_canvas_policy ?? inferredMetadata.imagegen_canvas_policy,
      output_resolution_policy: layer.output_resolution_policy
        ?? inferredMetadata.output_resolution_policy
        ?? 'logical_crop',
      expected_output: output,
      repair_regions: repairRegionsValue,
      repair_region_source: layer.repair_region_source || null,
      crop_path: cropPath,
    });
  }

  return {
    version: 1,
    job_id: jobId,
    source_path: sourcePath,
    output_directory: finalDirectory,
    generated_directory: path.resolve(jobDirectory, 'generated'),
    layers,
    timing: {
      preflight_started_at: preflightStartedAt,
      preflight_completed_at: clock(),
    },
  };
}
