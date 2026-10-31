import { fitViewport, toSource } from './coordinates.js';

export function previewBounds(source, layers, composition = false) {
  if (composition || !layers.length) return { x: 0, y: 0, width: source.width, height: source.height };
  const layer = layers[0];
  return { x: layer.placement.x, y: layer.placement.y, width: layer.width, height: layer.height };
}

export function fitPreview(bounds, size) {
  return fitViewport(bounds, size, Math.min(24, size.width / 4, size.height / 4));
}

// Keep the source pixel under the pointer fixed; only presentation changes.
export function zoomPreview(view, anchor, requestedScale) {
  const scale = Math.max(.01, Math.min(32, requestedScale));
  const pixel = toSource(anchor, view);
  return { scale, offsetX: anchor.x - pixel.x * scale, offsetY: anchor.y - pixel.y * scale };
}
