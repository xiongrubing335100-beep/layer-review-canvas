import { flattenPenPath } from './pen-path.js';

export const RESULT_REFINEMENT_MODES = new Set([
  'path_scoped',
  'keep_inside_delete_outside',
  'full_canvas_explicit',
]);

export const RESULT_REFINEMENT_ROI_POLICY = Object.freeze({
  strategy: 'per_repair_path_native_tiles',
  scale_mode: 'native_1_to_1',
  context_padding_ratio: 0.08,
  minimum_padding_ratio: 0.03,
  maximum_padding_ratio: 0.15,
  warn_coverage_ratio: 0.4,
  block_coverage_ratio: 0.7,
  tile_overlap_pixels: 32,
});

const OUTSIDE_DELETE_INTENT = /(?:框外|路径外|选区外).{0,8}(?:删除|去掉|透明|清空)/;
const FULL_CANVAS_INTENT = /(?:整图|全图|整个画面).{0,8}(?:修改|重绘|调整)/;
const LANDSCAPE_CANVAS = { width: 1536, height: 1024 };
const PORTRAIT_CANVAS = { width: 1024, height: 1536 };
const SQUARE_CANVAS = { width: 1024, height: 1024 };

function isClosedPenPath(path) {
  return path?.shape === 'bezier_path'
    && path.closed === true
    && (Array.isArray(path.source_polygon_pixels)
      ? path.source_polygon_pixels.length >= 3
      : Array.isArray(path.anchors) && path.anchors.length >= 3);
}

function annotationFromPath(path, canvas) {
  if (Array.isArray(path.source_polygon_pixels)) return path;
  return {
    ...path,
    source_polygon_pixels: flattenPenPath(path, {
      width: canvas.width,
      height: canvas.height,
      maxErrorPx: 1,
    }),
  };
}

function polygonBounds(points, canvas) {
  if (!Array.isArray(points) || points.length < 3) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.max(0, Math.floor(Math.min(...xs)));
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const right = Math.min(canvas.width, Math.ceil(Math.max(...xs)));
  const bottom = Math.min(canvas.height, Math.ceil(Math.max(...ys)));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function paddedRegion(bounds, canvas, roiPolicy) {
  const ratio = Math.min(
    Math.max(roiPolicy.context_padding_ratio, roiPolicy.minimum_padding_ratio),
    roiPolicy.maximum_padding_ratio,
  );
  const padding = Math.max(1, Math.round(Math.max(bounds.width, bounds.height) * ratio));
  const left = Math.max(0, bounds.x - padding);
  const top = Math.max(0, bounds.y - padding);
  const right = Math.min(canvas.width, bounds.x + bounds.width + padding);
  const bottom = Math.min(canvas.height, bounds.y + bounds.height + padding);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function chooseNativeCanvas(width, height) {
  const ratio = width / height;
  if (ratio > 1.2) return LANDSCAPE_CANVAS;
  if (ratio < 1 / 1.2) return PORTRAIT_CANVAS;
  return SQUARE_CANVAS;
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

function expectedNativeTileCount(repairAnnotations, canvas, roiPolicy) {
  return repairAnnotations.reduce((count, annotation) => {
    const bounds = polygonBounds(annotation.source_polygon_pixels, canvas);
    if (!bounds) return count;
    const region = paddedRegion(bounds, canvas, roiPolicy);
    return count + tileCount(
      region,
      chooseNativeCanvas(region.width, region.height),
      roiPolicy.tile_overlap_pixels,
    );
  }, 0);
}

function expectedFullCanvasTileCount(canvas, roiPolicy) {
  return tileCount(
    { x: 0, y: 0, width: canvas.width, height: canvas.height },
    chooseNativeCanvas(canvas.width, canvas.height),
    roiPolicy.tile_overlap_pixels,
  );
}

export function polygonAreaRatio(points, canvas) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  const twiceArea = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  return Math.abs(twiceArea) / 2 / (canvas.width * canvas.height);
}

function segmentIntersectionY(first, second) {
  const firstX = first.end.x - first.start.x;
  const firstY = first.end.y - first.start.y;
  const secondX = second.end.x - second.start.x;
  const secondY = second.end.y - second.start.y;
  const denominator = firstX * secondY - firstY * secondX;
  if (Math.abs(denominator) < Number.EPSILON) return null;
  const offsetX = second.start.x - first.start.x;
  const offsetY = second.start.y - first.start.y;
  const firstRatio = (offsetX * secondY - offsetY * secondX) / denominator;
  const secondRatio = (offsetX * firstY - offsetY * firstX) / denominator;
  if (firstRatio < 0 || firstRatio > 1 || secondRatio < 0 || secondRatio > 1) return null;
  return first.start.y + firstRatio * firstY;
}

function polygonIntervalsAtY(points, y, canvasWidth) {
  const intersections = [];
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    if ((point.y > y) === (next.y > y)) return;
    intersections.push(point.x + ((y - point.y) / (next.y - point.y)) * (next.x - point.x));
  });
  intersections.sort((left, right) => left - right);
  const intervals = [];
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    const left = Math.max(0, intersections[index]);
    const right = Math.min(canvasWidth, intersections[index + 1]);
    if (right > left) intervals.push([left, right]);
  }
  return intervals;
}

function unionIntervalWidth(intervals) {
  if (intervals.length === 0) return 0;
  const ordered = [...intervals].sort((left, right) => left[0] - right[0]);
  let [currentLeft, currentRight] = ordered[0];
  let width = 0;
  ordered.slice(1).forEach(([left, right]) => {
    if (left <= currentRight) {
      currentRight = Math.max(currentRight, right);
      return;
    }
    width += currentRight - currentLeft;
    currentLeft = left;
    currentRight = right;
  });
  return width + currentRight - currentLeft;
}

function polygonUnionAreaRatio(polygons, canvas) {
  const validPolygons = polygons.filter((points) => Array.isArray(points) && points.length >= 3);
  if (validPolygons.length === 0) return 0;
  const edges = validPolygons.flatMap((points, polygonIndex) => points.map((start, index) => ({
    start,
    end: points[(index + 1) % points.length],
    polygonIndex,
    edgeIndex: index,
    edgeCount: points.length,
  })));
  const criticalYs = [0, canvas.height];
  validPolygons.forEach((points) => points.forEach((point) => {
    if (point.y > 0 && point.y < canvas.height) criticalYs.push(point.y);
  }));
  edges.forEach((edge) => {
    const deltaX = edge.end.x - edge.start.x;
    if (deltaX === 0) return;
    [0, canvas.width].forEach((boundaryX) => {
      const ratio = (boundaryX - edge.start.x) / deltaX;
      if (ratio <= 0 || ratio >= 1) return;
      const y = edge.start.y + ratio * (edge.end.y - edge.start.y);
      if (y > 0 && y < canvas.height) criticalYs.push(y);
    });
  });
  edges.forEach((first, firstIndex) => {
    for (let secondIndex = firstIndex + 1; secondIndex < edges.length; secondIndex += 1) {
      const second = edges[secondIndex];
      if (first.polygonIndex === second.polygonIndex) {
        const edgeDistance = Math.abs(first.edgeIndex - second.edgeIndex);
        if (edgeDistance === 1 || edgeDistance === first.edgeCount - 1) continue;
      }
      const y = segmentIntersectionY(first, second);
      if (y != null && y > 0 && y < canvas.height) criticalYs.push(y);
    }
  });

  const orderedYs = criticalYs
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
    .filter((value, index, values) => index === 0 || Math.abs(value - values[index - 1]) > 1e-9);
  const unionArea = orderedYs.slice(0, -1).reduce((area, top, index) => {
    const bottom = orderedYs[index + 1];
    if (bottom <= top) return area;
    const middle = (top + bottom) / 2;
    const intervals = validPolygons.flatMap(
      (points) => polygonIntervalsAtY(points, middle, canvas.width),
    );
    return area + unionIntervalWidth(intervals) * (bottom - top);
  }, 0);
  return Math.min(1, unionArea / (canvas.width * canvas.height));
}

export function deriveRefinementPolicy({ prompt, annotations, operation, canvas }) {
  const normalized = String(prompt || '').trim().replace(/\s+/g, ' ');
  const subjectIds = new Set(operation.subject_path_ids || []);
  const repair = annotations.filter((item) => item.kind === 'boundary' && !subjectIds.has(item.id));
  const erase = annotations.filter((item) => ['background', 'exclude', 'erase'].includes(item.kind));
  const protect = annotations.filter((item) => ['foreground', 'keep'].includes(item.kind));
  const repairCoverage = polygonUnionAreaRatio(
    repair.map((item) => item.source_polygon_pixels),
    canvas,
  );
  const expectedTiles = expectedNativeTileCount(repair, canvas, RESULT_REFINEMENT_ROI_POLICY);
  const fullCanvasTiles = operation.mode === 'full_canvas_explicit'
    ? expectedFullCanvasTileCount(canvas, RESULT_REFINEMENT_ROI_POLICY)
    : 0;
  return {
    operation,
    repair_path_ids: repair.map((item) => item.id),
    erase_path_ids: erase.map((item) => item.id),
    protect_path_ids: protect.map((item) => item.id),
    subject_path_ids: [...subjectIds],
    alpha_include_path_ids: [...(operation.alpha_include_path_ids || [])],
    repair_coverage_ratio: repairCoverage,
    expected_roi_tile_count: operation.mode === 'full_canvas_explicit'
      ? fullCanvasTiles
      : expectedTiles,
    maximum_imagegen_calls: operation.mode === 'full_canvas_explicit'
      ? fullCanvasTiles * 2
      : expectedTiles * 2,
    normalized_user_requirement: normalized,
    warnings: repairCoverage > RESULT_REFINEMENT_ROI_POLICY.warn_coverage_ratio
      ? ['局部修复路径范围较大，可能产生重新构图']
      : [],
  };
}

export function refinementSubmissionState({ prompt, paths = [], draft, operation, canvas }) {
  if (draft) {
    return { ok: false, reason: '请先闭合或取消当前钢笔路径', warnings: [] };
  }
  if (!operation || !RESULT_REFINEMENT_MODES.has(operation.mode)) {
    return { ok: false, reason: '无效的二次编辑操作模式', warnings: [] };
  }

  const normalized = String(prompt || '').trim().replace(/\s+/g, ' ');
  if (OUTSIDE_DELETE_INTENT.test(normalized)
      && operation.mode !== 'keep_inside_delete_outside') {
    return {
      ok: false,
      reason: '请开启“仅保留路径内，路径外透明”，不要只在提示词中描述范围',
      warnings: [],
    };
  }
  if (FULL_CANVAS_INTENT.test(normalized) && operation.mode !== 'full_canvas_explicit') {
    return { ok: false, reason: '请明确开启“整图编辑（高风险）”', warnings: [] };
  }

  const annotations = paths.filter(isClosedPenPath).map((path) => annotationFromPath(path, canvas));
  const boundaryIds = new Set(
    annotations.filter((annotation) => annotation.kind === 'boundary').map((annotation) => annotation.id),
  );
  const subjectPathIds = operation.subject_path_ids || [];
  if (subjectPathIds.some((id) => !boundaryIds.has(id))) {
    return {
      ok: false,
      reason: 'subject_path_ids 必须引用闭合 boundary 路径',
      warnings: [],
    };
  }
  if (operation.mode === 'keep_inside_delete_outside' && subjectPathIds.length === 0) {
    return { ok: false, reason: '仅保留路径内，路径外透明必须指定主体范围', warnings: [] };
  }

  const policy = deriveRefinementPolicy({ prompt: normalized, annotations, operation, canvas });
  if (operation.mode !== 'full_canvas_explicit' && annotations.length === 0) {
    return {
      ok: false,
      reason: '局部二次编辑必须添加至少一条有效闭合路径',
      warnings: policy.warnings,
    };
  }
  if (policy.repair_path_ids.length > 0 && !normalized) {
    return { ok: false, reason: '修复路径必须填写修改目标', warnings: policy.warnings };
  }
  if (policy.repair_coverage_ratio > RESULT_REFINEMENT_ROI_POLICY.block_coverage_ratio
      && operation.mode !== 'full_canvas_explicit') {
    return {
      ok: false,
      reason: '局部修复路径覆盖超过 70%，必须缩小路径或明确启用整图编辑',
      warnings: policy.warnings,
    };
  }
  const changesPixels = policy.repair_path_ids.length > 0
    || policy.erase_path_ids.length > 0
    || operation.mode === 'keep_inside_delete_outside'
    || (operation.mode === 'full_canvas_explicit' && normalized.length > 0);
  if (!changesPixels && policy.protect_path_ids.length > 0) {
    return { ok: false, reason: '仅保护路径不会产生任何修改', warnings: policy.warnings };
  }
  if (!changesPixels) {
    return {
      ok: false,
      reason: '请填写二次编辑要求或添加会产生修改的路径',
      warnings: policy.warnings,
    };
  }
  return { ok: true, reason: null, warnings: policy.warnings };
}

export function refinementSummary(policy) {
  const outsideDelete = policy.operation.mode === 'keep_inside_delete_outside' ? '开启' : '关闭';
  const fullCanvas = policy.operation.mode === 'full_canvas_explicit' ? '开启' : '关闭';
  return [
    `修复 ${policy.repair_path_ids.length} 处`,
    `擦除 ${policy.erase_path_ids.length} 处`,
    `保护 ${policy.protect_path_ids.length} 处`,
    `主体 ${policy.subject_path_ids.length} 处`,
    `路径外透明：${outsideDelete}`,
    `整图编辑：${fullCanvas}`,
  ].join(' · ');
}
