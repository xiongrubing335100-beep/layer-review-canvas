const DEFAULT_MAX_ERROR_PX = 1;
const MAX_SUBDIVISION_DEPTH = 24;

function clampUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function normalizedPoint(point) {
  return { x: clampUnit(point?.x), y: clampUnit(point?.y) };
}

function finitePoint(point) {
  return validPoint(point) ? { x: point.x, y: point.y } : null;
}

function stableNumber(value) {
  return Number(value.toFixed(12));
}

function hasSameCoordinates(first, second) {
  return first?.x === second?.x && first?.y === second?.y;
}

function straightAnchor(point) {
  const normalized = normalizedPoint(point);
  return {
    ...normalized,
    in: { ...normalized },
    out: { ...normalized },
    handlesLinked: true,
  };
}

function validPoint(point, { unit = false } = {}) {
  return Number.isFinite(point?.x)
    && Number.isFinite(point?.y)
    && (!unit || (point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1));
}

function validAnchor(anchor) {
  return validPoint(anchor, { unit: true })
    && validPoint(anchor.in)
    && validPoint(anchor.out)
    && typeof anchor.handlesLinked === 'boolean';
}

function isDistinctAnchorSet(anchors) {
  if (!Array.isArray(anchors) || anchors.length < 3) return false;
  return new Set(anchors.map(({ x, y }) => `${x},${y}`)).size >= 3;
}

function replaceAnchor(path, index, nextAnchor) {
  if (!Array.isArray(path?.anchors) || index < 0 || index >= path.anchors.length) return path;
  return {
    ...path,
    anchors: path.anchors.map((anchor, anchorIndex) => (
      anchorIndex === index ? nextAnchor : anchor
    )),
  };
}

function pointToString({ x, y }) {
  return `${x} ${y}`;
}

function pixelPoint(point, width, height) {
  return { x: point.x * width, y: point.y * height };
}

function clampPixelPoint(point, width, height) {
  return {
    x: Math.min(width, Math.max(0, point.x)),
    y: Math.min(height, Math.max(0, point.y)),
  };
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.min(1, Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}

function splitCubic([p0, p1, p2, p3]) {
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const p01 = midpoint(p0, p1);
  const p12 = midpoint(p1, p2);
  const p23 = midpoint(p2, p3);
  const p012 = midpoint(p01, p12);
  const p123 = midpoint(p12, p23);
  const p0123 = midpoint(p012, p123);
  return [[p0, p01, p012, p0123], [p0123, p123, p23, p3]];
}

function appendFlattenedSegment(points, segment, maxErrorPx, depth = 0) {
  const [start, control1, control2, end] = segment;
  const error = Math.max(
    distanceToSegment(control1, start, end),
    distanceToSegment(control2, start, end),
  );
  if (error <= maxErrorPx || depth >= MAX_SUBDIVISION_DEPTH) {
    const previous = points.at(-1);
    if (!previous || previous.x !== end.x || previous.y !== end.y) points.push(end);
    return;
  }
  const [left, right] = splitCubic(segment);
  appendFlattenedSegment(points, left, maxErrorPx, depth + 1);
  appendFlattenedSegment(points, right, maxErrorPx, depth + 1);
}

export function createPenPath({ id, kind, point }) {
  return {
    id,
    kind,
    shape: 'bezier_path',
    closed: false,
    anchors: [straightAnchor(point)],
    order: 0,
  };
}

export function appendAnchor(path, point, handles) {
  const anchor = straightAnchor(point);
  if (handles?.in && validPoint(handles.in)) anchor.in = { ...handles.in };
  if (handles?.out && validPoint(handles.out)) anchor.out = { ...handles.out };
  if (typeof handles?.handlesLinked === 'boolean') anchor.handlesLinked = handles.handlesLinked;
  return { ...path, anchors: [...(path?.anchors ?? []), anchor] };
}

export function closePenPath(path) {
  return isDistinctAnchorSet(path?.anchors) ? { ...path, closed: true } : path;
}

export function moveAnchor(path, index, point) {
  const anchor = path?.anchors?.[index];
  if (!anchor) return path;
  const nextPoint = normalizedPoint(point);
  const dx = nextPoint.x - anchor.x;
  const dy = nextPoint.y - anchor.y;
  return replaceAnchor(path, index, {
    ...anchor,
    ...nextPoint,
    in: { x: anchor.in.x + dx, y: anchor.in.y + dy },
    out: { x: anchor.out.x + dx, y: anchor.out.y + dy },
  });
}

export function moveHandle(path, index, side, point, { breakLink = false } = {}) {
  if (!['in', 'out'].includes(side)) return path;
  const anchor = path?.anchors?.[index];
  if (!anchor) return path;
  const nextPoint = finitePoint(point);
  if (!nextPoint) return path;
  const opposite = side === 'in' ? 'out' : 'in';
  const nextAnchor = { ...anchor, [side]: nextPoint };
  if (breakLink) {
    nextAnchor.handlesLinked = false;
  } else if (anchor.handlesLinked) {
    nextAnchor[opposite] = {
      x: stableNumber(anchor.x * 2 - nextPoint.x),
      y: stableNumber(anchor.y * 2 - nextPoint.y),
    };
  }
  return replaceAnchor(path, index, nextAnchor);
}

export function toggleAnchorMode(path, index) {
  const anchor = path?.anchors?.[index];
  if (!anchor) return path;
  const collapsed = hasSameCoordinates(anchor.in, anchor) && hasSameCoordinates(anchor.out, anchor);
  if (!collapsed) {
    return replaceAnchor(path, index, {
      ...anchor,
      in: { x: anchor.x, y: anchor.y },
      out: { x: anchor.x, y: anchor.y },
      handlesLinked: false,
    });
  }
  const previous = path.anchors[index - 1] ?? (path.closed ? path.anchors.at(-1) : null);
  const next = path.anchors[index + 1] ?? (path.closed ? path.anchors[0] : null);
  let dx = (next?.x ?? anchor.x + 1) - (previous?.x ?? anchor.x - 1);
  let dy = (next?.y ?? anchor.y) - (previous?.y ?? anchor.y);
  let magnitude = Math.hypot(dx, dy);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    dx = 1;
    dy = 0;
    magnitude = 1;
  }
  const adjacentDistances = [previous, next]
    .filter(Boolean)
    .map((point) => Math.hypot(point.x - anchor.x, point.y - anchor.y))
    .filter((distance) => Number.isFinite(distance) && distance > 0);
  const handleLength = Math.min(.12, Math.max(.04, Math.min(...adjacentDistances, .32) / 3));
  const offsetX = (dx / magnitude) * handleLength;
  const offsetY = (dy / magnitude) * handleLength;
  return replaceAnchor(path, index, {
    ...anchor,
    in: { x: stableNumber(anchor.x - offsetX), y: stableNumber(anchor.y - offsetY) },
    out: { x: stableNumber(anchor.x + offsetX), y: stableNumber(anchor.y + offsetY) },
    handlesLinked: true,
  });
}

export function deleteAnchor(path, index) {
  if (!Array.isArray(path?.anchors) || index < 0 || index >= path.anchors.length) return path;
  const anchors = path.anchors.filter((_, anchorIndex) => anchorIndex !== index);
  if (!anchors.length) return null;
  return { ...path, anchors, closed: path.closed && isDistinctAnchorSet(anchors) };
}

export function isValidClosedPath(path) {
  return path?.shape === 'bezier_path'
    && path.closed === true
    && isDistinctAnchorSet(path.anchors)
    && path.anchors.every(validAnchor);
}

export function pathToSvgD(path, { close } = {}) {
  const anchors = path?.anchors ?? [];
  if (!anchors.length) return '';
  const shouldClose = close ?? path.closed;
  const segments = anchors.slice(1).map((anchor, index) => [anchors[index], anchor]);
  if (shouldClose && anchors.length > 1) segments.push([anchors.at(-1), anchors[0]]);
  const commands = [`M ${pointToString(anchors[0])}`];
  segments.forEach(([start, end]) => {
    commands.push(`C ${pointToString(start.out)} ${pointToString(end.in)} ${pointToString(end)}`);
  });
  if (shouldClose && anchors.length > 1) commands.push('Z');
  return commands.join(' ');
}

export function draftPreviewSegment(anchor, previewPoint) {
  if (!validPoint(anchor) || !validPoint(anchor?.out) || !validPoint(previewPoint)) return null;
  return {
    start: { x: anchor.x, y: anchor.y },
    control1: { x: anchor.out.x, y: anchor.out.y },
    control2: { x: previewPoint.x, y: previewPoint.y },
    end: { x: previewPoint.x, y: previewPoint.y },
  };
}

export function flattenPenPath(path, { width, height, maxErrorPx = DEFAULT_MAX_ERROR_PX } = {}) {
  if (!Array.isArray(path?.anchors) || !path.anchors.length) return [];
  const pixelWidth = Math.max(0, Number(width) || 0);
  const pixelHeight = Math.max(0, Number(height) || 0);
  const error = Number.isFinite(maxErrorPx) && maxErrorPx > 0 ? maxErrorPx : DEFAULT_MAX_ERROR_PX;
  const anchors = path.anchors;
  const points = [pixelPoint(anchors[0], pixelWidth, pixelHeight)];
  const segments = anchors.slice(1).map((anchor, index) => [anchors[index], anchor]);
  if (path.closed && anchors.length > 1) segments.push([anchors.at(-1), anchors[0]]);
  segments.forEach(([start, end]) => {
    appendFlattenedSegment(points, [
      pixelPoint(start, pixelWidth, pixelHeight),
      pixelPoint(start.out, pixelWidth, pixelHeight),
      pixelPoint(end.in, pixelWidth, pixelHeight),
      pixelPoint(end, pixelWidth, pixelHeight),
    ], error);
  });
  return points.reduce((samples, point) => {
    const sample = clampPixelPoint(point, pixelWidth, pixelHeight);
    const previous = samples.at(-1);
    if (!previous || previous.x !== sample.x || previous.y !== sample.y) samples.push(sample);
    return samples;
  }, []);
}
