import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const sourceDataPattern = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s;
const cropDataPattern = /^data:image\/png;base64,(.+)$/s;
const defaultMaxPlanBytes = 100 * 1024;

function clonePayload(payload) {
  return JSON.parse(JSON.stringify(payload));
}

function sourcePathFromUri(sourceUri, projectRoot) {
  return sourceUri.startsWith('/')
    ? path.resolve(projectRoot, 'public', sourceUri.slice(1))
    : path.resolve(projectRoot, sourceUri);
}

function safeLayerId(layer, index) {
  return String(layer.id || `layer-${index + 1}`).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function serializedPlanBytes(plan) {
  return Buffer.byteLength(JSON.stringify(plan));
}

export function assertPlanSize(plan, maxBytes = defaultMaxPlanBytes) {
  const bytes = serializedPlanBytes(plan);
  if (bytes > maxBytes) {
    const error = new Error(`拆分计划超过 ${maxBytes} 字节限制（当前 ${bytes} 字节）`);
    error.code = 'PLAN_TOO_LARGE';
    error.bytes = bytes;
    error.maxBytes = maxBytes;
    throw error;
  }
  return bytes;
}

/**
 * Persist image data referenced by a submission and return a Base64-free plan.
 * This module only moves bytes and validates the plan; it never edits pixels.
 */
export async function normalizeSubmissionPayload({
  payload,
  jobDirectory,
  projectRoot,
  maxPlanBytes = defaultMaxPlanBytes,
  write = writeFile,
  remove = unlink,
}) {
  const normalizedPayload = clonePayload(payload);
  const createdFiles = [];
  try {
    const sourceUri = normalizedPayload.source?.source_uri;
    const embeddedSource = normalizedPayload.source?.embedded_data_url
      || (typeof sourceUri === 'string' && sourceUri.startsWith('data:') ? sourceUri : null);
    let sourcePath = null;
    if (typeof embeddedSource === 'string') {
      const match = embeddedSource.match(sourceDataPattern);
      if (!match) throw new Error('原图数据格式不受支持');
      const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
      sourcePath = path.join(jobDirectory, `source.${extension}`);
      await write(sourcePath, Buffer.from(match[2], 'base64'));
      createdFiles.push(sourcePath);
    } else if (typeof normalizedPayload.source?.source_uri === 'string') {
      sourcePath = sourcePathFromUri(normalizedPayload.source.source_uri, projectRoot);
    }
    if (!sourcePath) throw new Error('没有可提交的原始 UI 图片');

    delete normalizedPayload.source.embedded_data_url;
    if (typeof sourceUri === 'string' && sourceUri.startsWith('data:')) {
      delete normalizedPayload.source.source_uri;
    }
    normalizedPayload.source.local_path = sourcePath;
    for (const [index, layer] of (normalizedPayload.layers || []).entries()) {
      const embeddedCrop = layer.review_snapshot?.embedded_crop_data_url;
      if (typeof embeddedCrop !== 'string') continue;
      const match = embeddedCrop.match(cropDataPattern);
      if (!match) throw new Error(`${layer.name || `拆分项 ${index + 1}`}的框选预览图格式不受支持`);
      const cropPath = path.join(
        jobDirectory,
        `${String(index + 1).padStart(2, '0')}-${safeLayerId(layer, index)}-selection.png`,
      );
      await write(cropPath, Buffer.from(match[1], 'base64'));
      createdFiles.push(cropPath);
      delete layer.review_snapshot.embedded_crop_data_url;
      layer.review_snapshot.local_crop_path = cropPath;
    }

    assertPlanSize(normalizedPayload, maxPlanBytes);
    return { normalizedPayload, sourcePath, createdFiles };
  } catch (error) {
    await Promise.all(createdFiles.map((filePath) => remove(filePath).catch(() => {})));
    throw error;
  }
}
