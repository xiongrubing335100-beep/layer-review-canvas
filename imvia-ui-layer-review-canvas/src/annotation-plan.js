import { flattenPenPath } from './pen-path.js';

function pixelBounds(bounds, sourceSize) {
  return {
    x: Math.round((bounds.x / 100) * sourceSize.width),
    y: Math.round((bounds.y / 100) * sourceSize.height),
    width: Math.round((bounds.width / 100) * sourceSize.width),
    height: Math.round((bounds.height / 100) * sourceSize.height),
  };
}

function normalizedKind(kind) {
  return kind === 'brush' ? 'boundary' : kind;
}

function semanticForKind(kind) {
  if (kind === 'foreground') return 'force_keep';
  if (kind === 'background') return 'force_exclude';
  return 'edge_override';
}

export function selectionForPenOverlay(selectionByLayer, layerId, selectedMarkId, paths) {
  if (!paths?.some((path) => path.id === selectedMarkId)) return null;
  const emittedSelection = selectionByLayer?.get?.(layerId);
  return emittedSelection?.pathId === selectedMarkId
    ? emittedSelection
    : { pathId: selectedMarkId };
}

export function annotationForPlan(
  mark,
  bounds,
  sourceSize,
  orderIndex,
  { operationRole = null } = {},
) {
  const region = pixelBounds(bounds, sourceSize);
  const kind = normalizedKind(mark.kind);
  const operationRoleField = operationRole == null ? {} : { operation_role: operationRole };
  if (mark.shape === 'rect') {
    const sourceRectPercent = {
      x: bounds.x + (mark.x / 100) * bounds.width,
      y: bounds.y + (mark.y / 100) * bounds.height,
      width: (mark.width / 100) * bounds.width,
      height: (mark.height / 100) * bounds.height,
    };
    return {
      id: mark.id,
      order_index: orderIndex,
      ...operationRoleField,
      kind,
      semantics: semanticForKind(kind),
      shape: 'rect',
      coordinate_space: 'selected_region_percent',
      region_percent: { x: mark.x, y: mark.y, width: mark.width, height: mark.height },
      source_rect_percent: sourceRectPercent,
      source_rect_pixels: pixelBounds(sourceRectPercent, sourceSize),
    };
  }

  if (mark.shape === 'bezier_path') {
    return {
      id: mark.id,
      order_index: orderIndex,
      ...operationRoleField,
      kind,
      semantics: semanticForKind(kind),
      shape: 'bezier_path',
      coordinate_space: 'selected_region_normalized',
      anchors: mark.anchors,
      closed: true,
      source_polygon_pixels: flattenPenPath(mark, {
        width: region.width,
        height: region.height,
        maxErrorPx: 1,
      }).map(({ x, y }) => ({ x: region.x + x, y: region.y + y })),
    };
  }

  const sourcePointsPixels = mark.points.map((point) => ({
    x: Math.round(region.x + (point.x / 100) * region.width),
    y: Math.round(region.y + (point.y / 100) * region.height),
  }));
  return {
    id: mark.id,
    order_index: orderIndex,
    ...operationRoleField,
    kind,
    semantics: semanticForKind(kind),
    shape: 'stroke',
    coordinate_space: 'selected_region_percent',
    points: mark.points,
    source_points_pixels: sourcePointsPixels,
    brush_size_percent: mark.brush_size_percent,
    brush_size_source_pixels: Math.max(1, Math.round((mark.brush_size_percent / 100) * region.width)),
  };
}
