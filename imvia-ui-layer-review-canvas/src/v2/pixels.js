export function assertPixelImage(image) {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width <= 0 || image.height <= 0
    || !(image.data instanceof Uint8ClampedArray) || image.data.length !== image.width * image.height * 4) throw new Error('INVALID_RGBA_IMAGE');
}
export function assertPlacedImage(layer, width, height) {
  assertPixelImage(layer.image);
  const { x, y } = layer.placement;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0
    || x + layer.image.width > width || y + layer.image.height > height) throw new Error('PLACEMENT_OUTSIDE_CANVAS');
}

/** Layers are front-to-back; output stores straight (not premultiplied) RGBA. */
export function composeNormal({ width, height, layers }) {
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0) || width * height > 40000000) throw new Error('INVALID_CANVAS_SIZE');
  layers.forEach(layer => assertPlacedImage(layer, width, height));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = layers.length - 1; i >= 0; i--) {
    const { image, placement } = layers[i];
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const s = (y * image.width + x) * 4;
      const d = ((y + placement.y) * width + x + placement.x) * 4;
      const sa = image.data[s + 3] / 255;
      if (!sa) continue;
      const da = data[d + 3] / 255;
      const outAlpha = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) data[d + c] = Math.round((image.data[s + c] * sa + data[d + c] * da * (1 - sa)) / outAlpha);
      data[d + 3] = Math.round(outAlpha * 255);
    }
  }
  return { width, height, data };
}
