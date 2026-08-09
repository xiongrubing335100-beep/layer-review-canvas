import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { buildRouteMetadata } from './split-execution.js';

const allowedRoutes = new Set(['direct_crop', 'alpha_extract', 'codex_rgba', 'targeted_repair', 'result_refinement']);
const jobIdPattern = /^layer-job-[a-zA-Z0-9._-]+$/;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maximumDecodedPngBytes = 512 * 1024 * 1024;
const unsafeLayerIdCharacters = /[<>:"/\\|?*\u0000-\u001f]/;
const windowsDrivePrefix = /^[A-Za-z]:/;
const windowsReservedName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const refinementModes = new Set(['path_scoped', 'keep_inside_delete_outside', 'full_canvas_explicit']);
const refinementKinds = new Set(['boundary', 'background', 'exclude', 'erase', 'foreground', 'keep']);
const eraseKinds = new Set(['background', 'exclude', 'erase']);
const protectKinds = new Set(['foreground', 'keep']);
const refinementRoiPolicy = Object.freeze({
  strategy: 'per_repair_path_native_tiles',
  scale_mode: 'native_1_to_1',
  context_padding_ratio: 0.08,
  minimum_padding_ratio: 0.03,
  maximum_padding_ratio: 0.15,
  warn_coverage_ratio: 0.4,
  block_coverage_ratio: 0.7,
  tile_overlap_pixels: 32,
});
const landscapeCanvas = { width: 1536, height: 1024 };
const portraitCanvas = { width: 1024, height: 1536 };
const squareCanvas = { width: 1024, height: 1024 };
const outsideDeleteIntent = /(?:框外|路径外|选区外).{0,8}(?:删除|去掉|透明|清空)/;
const fullCanvasIntent = /(?:整图|全图|整个画面).{0,8}(?:修改|重绘|调整)/;
const pngCrcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return crc >>> 0;
});

function fail(message, code = 'PREFLIGHT_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeId(value, fallback, label) {
  const identifier = value ?? fallback ?? '';
  if (typeof identifier !== 'string'
    || !identifier
    || identifier !== identifier.trim()
    || identifier.includes('..')
    || unsafeLayerIdCharacters.test(identifier)
    || windowsDrivePrefix.test(identifier)
    || windowsReservedName.test(identifier)
    || /[. ]$/.test(identifier)) {
    throw fail(`${label} 不安全：${identifier || '(empty)'}`);
  }
  return identifier;
}

function safeLayerId(value, fallback) {
  return safeId(value, fallback, 'layer id');
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

function crc32(...buffers) {
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) crc = pngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngFail(detail) {
  return fail(`result_refinement PNG ${detail}`);
}

async function readPngSize(filePath) {
  const png = await readFile(filePath);
  if (png.length < pngSignature.length || !png.subarray(0, 8).equals(pngSignature)) {
    throw pngFail('签名无效');
  }

  let offset = pngSignature.length;
  let chunkIndex = 0;
  let header = null;
  let sawIdat = false;
  let idatEnded = false;
  let sawIend = false;
  const compressedParts = [];
  while (offset < png.length) {
    if (sawIend) throw pngFail('IEND 后存在非法尾随数据');
    if (png.length - offset < 12) throw pngFail('chunk 已截断');
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) throw pngFail('chunk 数据已截断');
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const typeBytes = png.subarray(typeStart, dataStart);
    const data = png.subarray(dataStart, dataEnd);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) throw pngFail('chunk 类型无效');
    if (png.readUInt32BE(dataEnd) !== crc32(typeBytes, data)) {
      throw pngFail(`${type} CRC 校验失败`);
    }
    if (chunkIndex === 0 && type !== 'IHDR') throw pngFail('首个 chunk 必须是 IHDR');

    if (type === 'IHDR') {
      if (header || chunkIndex !== 0 || length !== 13) throw pngFail('IHDR 必须唯一、位于首块且长度为 13');
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
      if (header.width <= 0 || header.height <= 0) throw pngFail('尺寸无效');
      if (header.bitDepth !== 8
        || header.colorType !== 6
        || header.compression !== 0
        || header.filter !== 0
        || header.interlace !== 0) {
        throw pngFail('必须是 8-bit RGBA non-interlaced 格式');
      }
    } else if (type === 'IDAT') {
      if (!header || idatEnded) throw pngFail('IDAT 顺序无效');
      sawIdat = true;
      compressedParts.push(data);
    } else if (type === 'IEND') {
      if (!header || !sawIdat || length !== 0) throw pngFail('IEND 无效或缺少 IDAT');
      sawIend = true;
    } else if (sawIdat) {
      idatEnded = true;
    }

    offset = dataEnd + 4;
    chunkIndex += 1;
  }
  if (!header || !sawIdat || !sawIend) throw pngFail('缺少完整 IHDR、IDAT 或 IEND');

  const rowBytes = header.width * 4 + 1;
  const decodedBytes = rowBytes * header.height;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes > maximumDecodedPngBytes) {
    throw pngFail('解压后像素数据过大');
  }
  const compressed = Buffer.concat(compressedParts);
  let inflation;
  try {
    inflation = inflateSync(compressed, { info: true, maxOutputLength: decodedBytes });
  } catch {
    throw pngFail('IDAT zlib 数据无法解压');
  }
  if (inflation.engine.bytesWritten !== compressed.length) {
    throw pngFail('IDAT zlib 数据包含未消费的尾随字节');
  }
  const decoded = inflation.buffer;
  if (decoded.length !== decodedBytes) throw pngFail('解压后的扫描行长度无效');
  for (let y = 0; y < header.height; y += 1) {
    if (decoded[y * rowBytes] > 4) throw pngFail('扫描行 filter byte 无效');
  }
  return { width: header.width, height: header.height };
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

function finitePoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

function normalizedPoint(point) {
  return finitePoint(point)
    && point.x >= 0 && point.x <= 1
    && point.y >= 0 && point.y <= 1;
}

function polygonVertices(points) {
  if (points.length > 1
    && points[0].x === points.at(-1).x
    && points[0].y === points.at(-1).y) {
    return points.slice(0, -1);
  }
  return points;
}

function cross(first, second, third) {
  return (second.x - first.x) * (third.y - first.y)
    - (second.y - first.y) * (third.x - first.x);
}

function onSegment(first, second, point) {
  return Math.abs(cross(first, second, point)) <= Number.EPSILON
    && point.x >= Math.min(first.x, second.x)
    && point.x <= Math.max(first.x, second.x)
    && point.y >= Math.min(first.y, second.y)
    && point.y <= Math.max(first.y, second.y);
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const firstSide = cross(firstStart, firstEnd, secondStart);
  const secondSide = cross(firstStart, firstEnd, secondEnd);
  const thirdSide = cross(secondStart, secondEnd, firstStart);
  const fourthSide = cross(secondStart, secondEnd, firstEnd);
  if (((firstSide > 0 && secondSide < 0) || (firstSide < 0 && secondSide > 0))
    && ((thirdSide > 0 && fourthSide < 0) || (thirdSide < 0 && fourthSide > 0))) {
    return true;
  }
  return (firstSide === 0 && onSegment(firstStart, firstEnd, secondStart))
    || (secondSide === 0 && onSegment(firstStart, firstEnd, secondEnd))
    || (thirdSide === 0 && onSegment(secondStart, secondEnd, firstStart))
    || (fourthSide === 0 && onSegment(secondStart, secondEnd, firstEnd));
}

function selfIntersects(points) {
  const vertices = polygonVertices(points);
  for (let first = 0; first < vertices.length; first += 1) {
    const firstNext = (first + 1) % vertices.length;
    for (let second = first + 1; second < vertices.length; second += 1) {
      const secondNext = (second + 1) % vertices.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(
        vertices[first], vertices[firstNext], vertices[second], vertices[secondNext],
      )) return true;
    }
  }
  return false;
}

function polygonRatio(points, pngSize) {
  const twiceArea = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  return Math.abs(twiceArea) / 2 / (pngSize.width * pngSize.height);
}

function repairCoverageRatio(annotations, repairPathIds, pngSize) {
  const allowed = new Set(repairPathIds);
  return Math.min(1, annotations
    .filter((annotation) => allowed.has(annotation.id))
    .reduce((sum, annotation) => sum + polygonRatio(annotation.source_polygon_pixels, pngSize), 0));
}

function polygonBounds(points, pngSize) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.max(0, Math.floor(Math.min(...xs)));
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const right = Math.min(pngSize.width, Math.ceil(Math.max(...xs)));
  const bottom = Math.min(pngSize.height, Math.ceil(Math.max(...ys)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function paddedRegion(bounds, pngSize, policy) {
  const ratio = Math.min(
    Math.max(policy.context_padding_ratio, policy.minimum_padding_ratio),
    policy.maximum_padding_ratio,
  );
  const padding = Math.max(1, Math.round(Math.max(bounds.width, bounds.height) * ratio));
  const left = Math.max(0, bounds.x - padding);
  const top = Math.max(0, bounds.y - padding);
  const right = Math.min(pngSize.width, bounds.x + bounds.width + padding);
  const bottom = Math.min(pngSize.height, bounds.y + bounds.height + padding);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function nativeCanvasFor(region) {
  const ratio = region.width / region.height;
  if (ratio > 1.2) return landscapeCanvas;
  if (ratio < 1 / 1.2) return portraitCanvas;
  return squareCanvas;
}

function tileCount(region, nativeCanvas, overlapPixels) {
  const stepX = Math.max(1, nativeCanvas.width - overlapPixels);
  const stepY = Math.max(1, nativeCanvas.height - overlapPixels);
  const columns = region.width <= nativeCanvas.width
    ? 1
    : Math.ceil((region.width - nativeCanvas.width) / stepX) + 1;
  const rows = region.height <= nativeCanvas.height
    ? 1
    : Math.ceil((region.height - nativeCanvas.height) / stepY) + 1;
  return columns * rows;
}

function expectedRefinementTileCount(annotations, repairPathIds, operation, pngSize, policy) {
  if (operation.mode === 'full_canvas_explicit') {
    return tileCount(
      { x: 0, y: 0, width: pngSize.width, height: pngSize.height },
      nativeCanvasFor(pngSize),
      policy.tile_overlap_pixels,
    );
  }
  const allowed = new Set(repairPathIds);
  return annotations
    .filter((annotation) => allowed.has(annotation.id))
    .reduce((count, annotation) => {
      const region = paddedRegion(polygonBounds(annotation.source_polygon_pixels, pngSize), pngSize, policy);
      return count + tileCount(region, nativeCanvasFor(region), policy.tile_overlap_pixels);
    }, 0);
}

function expectedRefinementImagegenCalls(policy) {
  return policy.expected_roi_tile_count * 2;
}

function validateRoiPolicy(layer) {
  const policy = layer.roi_policy;
  if (!policy || policy.scale_mode !== 'native_1_to_1') {
    throw fail('result_refinement roi_policy 必须使用 native_1_to_1（原生 1:1）');
  }
  for (const [key, expected] of Object.entries(refinementRoiPolicy)) {
    if (policy[key] !== expected) throw fail(`result_refinement roi_policy.${key} 无效`);
  }
  return { ...refinementRoiPolicy };
}

function validateRefinementPaths(layer, pngSize) {
  const layerName = layer.name || layer.id || '图层';
  const annotations = layer.mask_annotations ?? [];
  if (!Array.isArray(annotations)) throw fail(`${layerName} 的 mask_annotations 必须是数组`);
  const pathIds = new Set();
  for (const annotation of annotations) {
    const pathId = safeId(annotation?.id, null, 'path id');
    if (pathIds.has(pathId)) throw fail(`${layerName} 的 path id 重复：${pathId}`);
    pathIds.add(pathId);
    if (!refinementKinds.has(annotation.kind)) {
      throw fail(`${layerName} 的 result_refinement 路径 kind 无效`);
    }
    if (annotation?.shape !== 'bezier_path') {
      throw fail(`${layerName} 的 result_refinement 仅支持 bezier_path 标注`);
    }
    if (annotation.closed !== true) throw fail(`${layerName} 的 bezier_path 必须 closed=true`);
    if (!Array.isArray(annotation.anchors) || annotation.anchors.length < 3) {
      throw fail(`${layerName} 的 bezier_path 至少需要三个 anchors 锚点`);
    }
    const distinctAnchors = new Set(annotation.anchors.map((anchor) => `${anchor?.x},${anchor?.y}`));
    if (distinctAnchors.size < 3 || !annotation.anchors.every((anchor) => (
      normalizedPoint(anchor)
      && finitePoint(anchor.in)
      && finitePoint(anchor.out)
      && typeof anchor.handlesLinked === 'boolean'
    ))) {
      throw fail(`${layerName} 的 bezier_path anchors 锚点或控制柄无效`);
    }
    const flattened = annotation.source_polygon_pixels;
    if (!Array.isArray(flattened) || flattened.length < 3) {
      throw fail(`${layerName} 的 bezier_path source_polygon_pixels 扁平像素至少需要三个点`);
    }
    if (!flattened.every((point) => (
      finitePoint(point)
      && point.x >= 0 && point.x <= pngSize.width
      && point.y >= 0 && point.y <= pngSize.height
    ))) {
      throw fail(`${layerName} 的 bezier_path source_polygon_pixels 扁平像素超出 PNG 边界`);
    }
    const vertices = polygonVertices(flattened);
    if (vertices.length < 3 || polygonRatio(vertices, pngSize) <= 0) {
      throw fail(`${layerName} 的 bezier_path 多边形面积必须大于零`);
    }
    if (selfIntersects(vertices)) throw fail(`${layerName} 的 bezier_path 多边形不得自交`);
  }
  return annotations;
}

function validateRefinementOperation(layer, annotations, pngSize) {
  const operation = layer.refinement_operation;
  if (!operation || !refinementModes.has(operation.mode)) {
    throw fail('result_refinement operation mode 无效');
  }
  const byId = new Map(annotations.map((annotation) => [annotation.id, annotation]));
  const subjectPathIds = operation.subject_path_ids ?? [];
  const alphaIncludePathIds = operation.alpha_include_path_ids ?? [];
  if (!Array.isArray(subjectPathIds) || !Array.isArray(alphaIncludePathIds)) {
    throw fail('result_refinement operation 路径引用必须是数组');
  }
  for (const [label, ids] of [['subject_path_ids', subjectPathIds], ['alpha_include_path_ids', alphaIncludePathIds]]) {
    if (new Set(ids).size !== ids.length || !ids.every((id) => {
      try {
        safeId(id, null, `${label} path id`);
        return true;
      } catch {
        return false;
      }
    })) throw fail(`${label} 包含重复或不安全的路径 id`);
  }
  if (!subjectPathIds.every((id) => byId.get(id)?.kind === 'boundary')) {
    throw fail('subject_path_ids 必须引用闭合 boundary 路径');
  }
  if (operation.mode === 'keep_inside_delete_outside' && subjectPathIds.length === 0) {
    throw fail('仅保留路径内，路径外透明必须指定主体范围');
  }
  const subjectSet = new Set(subjectPathIds);
  const repairPathIds = annotations
    .filter((annotation) => annotation.kind === 'boundary' && !subjectSet.has(annotation.id))
    .map((annotation) => annotation.id);
  if (!alphaIncludePathIds.every((id) => repairPathIds.includes(id))) {
    throw fail('alpha_include_path_ids 必须引用修复 boundary 路径');
  }
  const erasePathIds = annotations.filter((annotation) => eraseKinds.has(annotation.kind)).map((annotation) => annotation.id);
  const protectPathIds = annotations.filter((annotation) => protectKinds.has(annotation.kind)).map((annotation) => annotation.id);
  const coverage = repairCoverageRatio(annotations, repairPathIds, pngSize);
  if (coverage > refinementRoiPolicy.block_coverage_ratio && operation.mode !== 'full_canvas_explicit') {
    throw fail('局部修复路径覆盖超过 70%，必须缩小路径或明确启用整图编辑');
  }
  const normalizedUserRequirement = normalizeRequirement(layer.requirement);
  if (layer.normalized_user_requirement !== normalizedUserRequirement) {
    throw fail('normalized_user_requirement 与 Node 规范化结果不一致');
  }
  if (outsideDeleteIntent.test(normalizedUserRequirement)
    && operation.mode !== 'keep_inside_delete_outside') {
    throw fail('请开启“仅保留路径内，路径外透明”，不要只在提示词中描述范围');
  }
  if (fullCanvasIntent.test(normalizedUserRequirement) && operation.mode !== 'full_canvas_explicit') {
    throw fail('请明确开启“整图编辑（高风险）”');
  }
  if (operation.mode !== 'full_canvas_explicit' && annotations.length === 0) {
    throw fail('局部二次编辑必须添加至少一条有效闭合路径');
  }
  if (repairPathIds.length > 0 && !normalizedUserRequirement) {
    throw fail('修复路径必须填写修改目标');
  }
  const changesPixels = repairPathIds.length > 0
    || erasePathIds.length > 0
    || operation.mode === 'keep_inside_delete_outside'
    || (operation.mode === 'full_canvas_explicit' && normalizedUserRequirement.length > 0);
  if (!changesPixels && protectPathIds.length > 0) throw fail('仅保护路径不会产生任何修改');
  if (!changesPixels) throw fail('请填写二次编辑要求或添加会产生修改的路径');
  const roiPolicy = validateRoiPolicy(layer);
  const expectedRoiTileCount = expectedRefinementTileCount(
    annotations, repairPathIds, operation, pngSize, roiPolicy,
  );
  const trustedPolicy = {
    operation: {
      mode: operation.mode,
      subject_path_ids: [...subjectPathIds],
      alpha_include_path_ids: [...alphaIncludePathIds],
    },
    normalized_user_requirement: normalizedUserRequirement,
    roi_policy: roiPolicy,
    repair_path_ids: repairPathIds,
    erase_path_ids: erasePathIds,
    protect_path_ids: protectPathIds,
    subject_path_ids: [...subjectPathIds],
    alpha_include_path_ids: [...alphaIncludePathIds],
    repair_coverage_ratio: coverage,
    expected_roi_tile_count: expectedRoiTileCount,
    refinement_warnings: coverage > roiPolicy.warn_coverage_ratio
      ? ['局部修复路径范围较大，可能产生重新构图']
      : [],
  };
  trustedPolicy.maximum_imagegen_calls = expectedRefinementImagegenCalls(trustedPolicy);
  if (layer.maximum_imagegen_calls !== trustedPolicy.maximum_imagegen_calls) {
    throw fail('result_refinement ImageGen 调用上限与可信策略预算不一致');
  }
  return trustedPolicy;
}

function validateRefinementDimensions(plan, layer, output, pngSize) {
  const declaredCanvas = plan.source?.canvas;
  if (!Number.isInteger(declaredCanvas?.width)
    || !Number.isInteger(declaredCanvas?.height)
    || declaredCanvas.width !== pngSize.width
    || declaredCanvas.height !== pngSize.height) {
    throw fail('result_refinement 声明的画布尺寸必须与 PNG 像素尺寸完全一致');
  }
  if (output.width !== pngSize.width
    || output.height !== pngSize.height
    || output.original_source_x !== 0
    || output.original_source_y !== 0) {
    throw fail(`${layer.name || layer.id || '图层'}的期望输出必须等于完整 PNG 像素尺寸`);
  }
  const sourceRegion = layer.source_region_pixels;
  if (!sourceRegion
    || sourceRegion.x !== 0
    || sourceRegion.y !== 0
    || sourceRegion.width !== pngSize.width
    || sourceRegion.height !== pngSize.height) {
    throw fail(`${layer.name || layer.id || '图层'}的 source_region_pixels 必须等于完整 PNG 像素尺寸`);
  }
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
  const hasResultRefinement = plan.layers.some((layer) => layer.execution_route_hint === 'result_refinement');
  if (hasResultRefinement && plan.version !== '0.8') {
    throw fail('result_refinement 权威计划版本必须是 0.8');
  }
  const refinementPngSize = hasResultRefinement ? await readPngSize(sourcePath) : null;
  const layers = [];
  for (const [index, layer] of plan.layers.entries()) {
    const layerId = safeLayerId(layer.id, `layer-${index + 1}`);
    const layerName = layer.name || layerId || `拆分项 ${index + 1}`;
    if (layer.layer_index !== undefined && layer.layer_index !== index + 1) {
      throw fail(`${layerName} 的 layer_index 顺序不一致`);
    }
    const route = layer.execution_route_hint;
    if (!allowedRoutes.has(route)) throw fail(`${layerName} 的执行路线不受支持`);
    const isResultRefinement = route === 'result_refinement';
    if (isResultRefinement && plan.task !== 'refine_split_result') {
      throw fail(`${layerName} 的 result_refinement 路线要求 task === refine_split_result`);
    }
    const cropPath = isResultRefinement ? sourcePath : layer.review_snapshot?.local_crop_path;
    if (typeof cropPath !== 'string' || !path.isAbsolute(cropPath)) throw fail(`${layerName} 缺少框选预览本地路径`);
    if (!isResultRefinement) await requireFile(cropPath, `${layerName}框选预览`);
    const output = expectedOutput(layer);
    const refinementAnnotations = isResultRefinement
      ? validateRefinementPaths(layer, refinementPngSize)
      : null;
    let trustedRefinementPolicy = null;
    if (isResultRefinement) {
      validateRefinementDimensions(plan, layer, output, refinementPngSize);
      if (layer.transparency_strategy !== undefined
        && layer.transparency_strategy !== 'preserve_existing_alpha') {
        throw fail(`${layerName} 的 transparency_strategy 必须是 preserve_existing_alpha`);
      }
      if (layer.rmbg_required !== undefined && layer.rmbg_required !== false) {
        throw fail(`${layerName} 的 result_refinement 要求 rmbg_required 严格为 false，禁止运行 RMBG`);
      }
      if (layer.remove_background !== undefined && layer.remove_background !== false) {
        throw fail(`${layerName} 的 result_refinement 禁止请求 RMBG 去背景`);
      }
      if (layer.output_resolution_policy !== undefined
        && layer.output_resolution_policy !== 'existing_result_pixels') {
        throw fail(`${layerName} 的 output_resolution_policy 必须是 existing_result_pixels`);
      }
      trustedRefinementPolicy = validateRefinementOperation(layer, refinementAnnotations, refinementPngSize);
    }
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
    const maximumImagegenCalls = trustedRefinementPolicy?.maximum_imagegen_calls
      ?? Number(layer.maximum_imagegen_calls ?? inferredMetadata.maximum_imagegen_calls);
    if (!Number.isInteger(maximumImagegenCalls) || maximumImagegenCalls < 0) {
      throw fail(`${layerName} 的 ImageGen 调用上限无效`);
    }
    layers.push({
      layer_index: index + 1,
      id: layerId,
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
      ...(isResultRefinement ? {
        source_region_pixels: { ...layer.source_region_pixels },
        mask_annotations: refinementAnnotations.map((annotation) => {
          let operationRole = null;
          if (trustedRefinementPolicy.repair_path_ids.includes(annotation.id)) operationRole = 'repair';
          else if (trustedRefinementPolicy.erase_path_ids.includes(annotation.id)) operationRole = 'erase';
          else if (trustedRefinementPolicy.protect_path_ids.includes(annotation.id)) operationRole = 'protect';
          else if (trustedRefinementPolicy.subject_path_ids.includes(annotation.id)) operationRole = 'subject';
          const { operation_role: ignoredRole, ...trustedAnnotation } = annotation;
          return operationRole ? { ...trustedAnnotation, operation_role: operationRole } : trustedAnnotation;
        }),
        refinement_operation: trustedRefinementPolicy.operation,
        normalized_user_requirement: trustedRefinementPolicy.normalized_user_requirement,
        roi_policy: trustedRefinementPolicy.roi_policy,
        repair_path_ids: trustedRefinementPolicy.repair_path_ids,
        erase_path_ids: trustedRefinementPolicy.erase_path_ids,
        protect_path_ids: trustedRefinementPolicy.protect_path_ids,
        subject_path_ids: trustedRefinementPolicy.subject_path_ids,
        alpha_include_path_ids: trustedRefinementPolicy.alpha_include_path_ids,
        repair_coverage_ratio: trustedRefinementPolicy.repair_coverage_ratio,
        expected_roi_tile_count: trustedRefinementPolicy.expected_roi_tile_count,
        refinement_warnings: trustedRefinementPolicy.refinement_warnings,
      } : {}),
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
