import path from 'node:path';

function assertOwnedPath(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') throw new TypeError('候选下载路径无效');
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('候选下载路径超出任务目录');
  return { root: resolvedRoot, path: resolvedTarget };
}

function downloadFilename(layer, suffix = '') {
  const name = String(layer?.layer_name || layer?.name || `layer-${layer?.layer_index || 'candidate'}`)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .trim() || 'candidate';
  return `layer-${layer.layer_index}-${name}${suffix}.png`;
}

export function selectPosterFastDownloadAsset(record, layerIndex) {
  const index = Number(layerIndex);
  const planLayer = record?.plan?.layers?.find((layer) => Number(layer.layer_index) === index);
  const manifestLayer = record?.manifest?.layers?.find((layer) => Number(layer.layer_index) === index);
  if (!planLayer || !manifestLayer) return null;

  const candidateId = manifestLayer.visual_inspection?.candidate_id;
  const candidate = record.manifest?.candidates?.find((item) => (
    item.candidate_id === candidateId
    && Number(item.layer_index) === index
    && Number(item.plan_version) === Number(record.plan?.plan_version)
    && item.stale !== true
  ));
  if (candidate?.transparent_preview?.path) {
    return { ...assertOwnedPath(record.paths?.evidence, candidate.transparent_preview.path), filename: downloadFilename(planLayer), kind: 'transparent' };
  }
  if (candidate?.path) {
    return { ...assertOwnedPath(record.paths?.candidates, candidate.path), filename: downloadFilename(planLayer), kind: 'candidate' };
  }

  const execution = manifestLayer.fast_execution;
  if (execution?.recoverability === 'postprocess_only'
    && execution.raw_candidate_available === true
    && execution.raw_candidate_path) {
    return { ...assertOwnedPath(record.paths?.evidence, execution.raw_candidate_path), filename: downloadFilename(planLayer, '-raw'), kind: 'raw' };
  }
  return null;
}
