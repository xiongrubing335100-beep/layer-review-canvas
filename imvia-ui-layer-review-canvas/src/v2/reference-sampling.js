/** Preserve source coverage when reducing a model reference; interpolate when enlarging.
 * Alpha is filtered premultiplied so hidden RGB cannot become a visible contour.
 * This operates on the reference only, never the frozen crop or delivered pixels.
 */
function axisWeights(sourceSize, targetSize) {
  const scale = sourceSize / targetSize;
  return Array.from({ length: targetSize }, (_, index) => {
    if (scale > 1) {
      const start = index * scale, end = (index + 1) * scale;
      const weights = [];
      for (let pixel = Math.floor(start); pixel < Math.min(sourceSize, Math.ceil(end)); pixel++) {
        weights.push([pixel, (Math.min(end, pixel + 1) - Math.max(start, pixel)) / scale]);
      }
      return weights;
    }
    const center = Math.max(0, Math.min(sourceSize - 1, (index + .5) * scale - .5));
    const left = Math.floor(center), fraction = center - left;
    return [[left, 1 - fraction], [Math.min(sourceSize - 1, left + 1), fraction]];
  });
}

export function sampleReferenceRgba(crop, sourceWidth, sourceHeight, width, height) {
  const horizontal = axisWeights(sourceWidth, width), vertical = axisWeights(sourceHeight, height);
  const intermediate = new Float32Array(width * sourceHeight * 4);
  for (let y = 0; y < sourceHeight; y++) for (let x = 0; x < width; x++) {
    const to = (y * width + x) * 4;
    for (const [sx, weight] of horizontal[x]) {
      const from = (y * sourceWidth + sx) * 4, alphaWeight = crop[from + 3] * weight;
      for (let channel = 0; channel < 3; channel++) intermediate[to + channel] += crop[from + channel] * alphaWeight;
      intermediate[to + 3] += alphaWeight;
    }
  }
  const result = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = [0, 0, 0, 0], to = (y * width + x) * 4;
    for (const [sy, weight] of vertical[y]) {
      const from = (sy * width + x) * 4;
      for (let channel = 0; channel < 4; channel++) value[channel] += intermediate[from + channel] * weight;
    }
    for (let channel = 0; channel < 3; channel++) result[to + channel] = value[3] > 0 ? Math.round(value[channel] / value[3]) : 0;
    result[to + 3] = Math.round(value[3]);
  }
  return result;
}
