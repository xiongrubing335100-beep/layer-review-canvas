function finite(...values) {
  if (values.some(v => !Number.isFinite(v))) throw new Error('NON_FINITE_COORDINATE');
}
function size({ width, height }) {
  finite(width, height);
  if (width <= 0 || height <= 0) throw new Error('EMPTY_SIZE');
}
function transform(t) {
  finite(t.scale, t.offsetX, t.offsetY);
  if (t.scale <= 0) throw new Error('INVALID_SCALE');
}
export function fitViewport(bounds, viewport, padding = 16) {
  size(bounds); size(viewport); finite(bounds.x, bounds.y, padding);
  if (padding < 0 || viewport.width <= 2 * padding || viewport.height <= 2 * padding) throw new Error('EMPTY_VIEWPORT');
  const scale = Math.min((viewport.width - 2 * padding) / bounds.width, (viewport.height - 2 * padding) / bounds.height);
  return { scale, offsetX: (viewport.width - bounds.width * scale) / 2 - bounds.x * scale,
    offsetY: (viewport.height - bounds.height * scale) / 2 - bounds.y * scale };
}
export function toScreen(point, t) {
  transform(t); finite(point.x, point.y);
  return { x: point.x * t.scale + t.offsetX, y: point.y * t.scale + t.offsetY };
}
export function toSource(point, t) {
  transform(t); finite(point.x, point.y);
  return { x: (point.x - t.offsetX) / t.scale, y: (point.y - t.offsetY) / t.scale };
}
export function quantizeBounds(bounds, sourceSize) {
  size(sourceSize);
  const { x, y, width, height } = bounds;
  finite(x, y, width, height, x + width, y + height);
  if (!width || !height) throw new Error('EMPTY_BOUNDS');
  const clamp = (value, maximum) => Math.min(maximum, Math.max(0, value));
  const left = clamp(Math.floor(Math.min(x, x + width)), sourceSize.width);
  const top = clamp(Math.floor(Math.min(y, y + height)), sourceSize.height);
  const right = clamp(Math.ceil(Math.max(x, x + width)), sourceSize.width);
  const bottom = clamp(Math.ceil(Math.max(y, y + height)), sourceSize.height);
  if (right <= left || bottom <= top) throw new Error('EMPTY_BOUNDS');
  return { x: left, y: top, width: right - left, height: bottom - top };
}
