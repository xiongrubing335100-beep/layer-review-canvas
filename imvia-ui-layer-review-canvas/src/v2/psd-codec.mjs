import os from 'node:os';
import { initializeCanvas, writePsdUint8Array, readPsd } from 'ag-psd';
import { assertPixelImage, assertPlacedImage } from './pixels.js';

initializeCanvas(() => { throw new Error('CANVAS_DISABLED_USE_RGBA'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));

export function checkPsdBudget({ width, height, layers, availableMemory = os.freemem() }) {
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 30000)) throw new Error('PSD_SIZE_LIMIT');
  if (width * height > 40000000) throw new Error('PSD_PIXEL_LIMIT');
  if (layers.length > 100) throw new Error('PSD_LAYER_LIMIT');
  const regionPixels = layers.reduce((sum, { image }) => {
    if (![image.width, image.height].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('INVALID_RGBA_SIZE');
    return sum + image.width * image.height;
  }, 0);
  const estimatedBytes = 24 * width * height + 12 * regionPixels + 64 * 1024 ** 2;
  const budgetBytes = Math.min(1024 ** 3, availableMemory / 4);
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0 || estimatedBytes > budgetBytes) throw new Error(`PSD_MEMORY_LIMIT: estimated=${estimatedBytes}, budget=${budgetBytes}`);
  return { estimatedBytes, budgetBytes };
}

export function encodePsd({ width, height, layers, composite }) {
  checkPsdBudget({ width, height, layers });
  assertPixelImage(composite);
  if (composite.width !== width || composite.height !== height) throw new Error('COMPOSITE_SIZE_MISMATCH');
  if (!layers.length) throw new Error('PSD_NO_LAYERS');
  for (const layer of layers) {
    assertPlacedImage(layer, width, height);
    if (typeof layer.name !== 'string' || !layer.name.trim()) throw new Error('INVALID_LAYER_NAME');
    if (layer.blendMode && layer.blendMode !== 'normal') throw new Error('UNSUPPORTED_BLEND_MODE');
  }
  return writePsdUint8Array({ width, height, bitsPerChannel: 8, imageData: composite,
    children: layers.map(layer => ({ name: layer.name, left: layer.placement.x, top: layer.placement.y,
      blendMode: 'normal', opacity: 1, imageData: layer.image })) },
  { trimImageData: false, generateThumbnail: false, noBackground: true });
}

/** Only read bounded files produced by this service; not an arbitrary PSD importer. */
export function inspectPsd(bytes) {
  const structural = readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  checkPsdBudget({ width: structural.width, height: structural.height,
    layers: (structural.children ?? []).map(layer => ({ image: { width: layer.right - layer.left, height: layer.bottom - layer.top } })) });
  const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true, totalMemoryLimit: 1024 ** 3 });
  return { width: psd.width, height: psd.height, composite: psd.imageData,
    layers: (psd.children ?? []).map(layer => ({ name: layer.name, image: layer.imageData,
      placement: { x: layer.left, y: layer.top } })) };
}
