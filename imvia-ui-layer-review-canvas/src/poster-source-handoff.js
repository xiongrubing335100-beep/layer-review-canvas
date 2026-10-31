import { resolveWorkbenchUrl } from './mcp-workbench-host.js';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_DIMENSION = 32768;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function sourceMime(sourceUrl, blob) {
  if (ALLOWED_TYPES.has(blob?.type)) return blob.type;
  const match = String(sourceUrl || '').match(/^data:([^;,]+)/i);
  return match?.[1]?.toLowerCase() || '';
}

function defaultImageLoader(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    image.src = url;
  });
}

function defaultCanvasFactory() { return document.createElement('canvas'); }

function pngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('无法转换为 PNG')), 'image/png');
  });
}

function imageSize(image) {
  return {
    width: Number(image?.naturalWidth || image?.width),
    height: Number(image?.naturalHeight || image?.height),
  };
}

export async function materializePosterSource(sourceUrl, {
  fetchImpl = fetch,
  loadImage = defaultImageLoader,
  canvasFactory = defaultCanvasFactory,
} = {}) {
  if (typeof sourceUrl !== 'string' || !sourceUrl) throw new Error('缺少海报来源图片');
  const response = await fetchImpl(sourceUrl);
  if (!response.ok) throw new Error(`无法读取海报来源图片：HTTP ${response.status}`);
  const source = await response.blob();
  if (!ALLOWED_TYPES.has(sourceMime(sourceUrl, source))) throw new Error('仅支持 PNG、JPG 或 WebP 图片');
  if (!source.size || source.size > MAX_SOURCE_BYTES) throw new Error('海报来源图片不能为空或超过 32 MB');
  const image = await loadImage(source);
  const size = imageSize(image);
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1
    || size.width > MAX_DIMENSION || size.height > MAX_DIMENSION || size.width * size.height > 268_435_456) {
    throw new Error('海报来源图片尺寸无效');
  }
  const canvas = canvasFactory();
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法转换海报来源图片');
  context.drawImage(image, 0, 0, size.width, size.height);
  const blob = await pngBlob(canvas);
  if (blob.type !== 'image/png' || !blob.size || blob.size > MAX_SOURCE_BYTES) throw new Error('海报 PNG 转换失败');
  return { blob, size };
}

export async function uploadPosterSource(blob, size, fetchImpl = fetch) {
  if (!(blob instanceof Blob) || blob.type !== 'image/png' || !blob.size || blob.size > MAX_SOURCE_BYTES) {
    throw new Error('只能上传有效的 PNG 海报来源');
  }
  if (!Number.isInteger(size?.width) || !Number.isInteger(size?.height) || size.width < 1 || size.height < 1) {
    throw new Error('海报来源尺寸无效');
  }
  const response = await fetchImpl(resolveWorkbenchUrl('/api/poster-layer/sources'), {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'X-Poster-Source-Width': String(size.width),
      'X-Poster-Source-Height': String(size.height),
    },
    body: blob,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `海报来源上传失败：HTTP ${response.status}`);
  if (!/^output\/poster-sources\/source-[a-z0-9-]+\.png$/.test(result.source_path || '')
    || result.width !== size.width || result.height !== size.height) {
    throw new Error('服务端返回的海报来源路径或尺寸无效');
  }
  return { sourcePath: result.source_path, size: { width: result.width, height: result.height } };
}
