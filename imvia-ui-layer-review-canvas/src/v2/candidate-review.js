import { freezeLayer } from './document.js';

function candidateMatches(document, layer, candidate, snapshotId) {
  return candidate.execution === 'suggested'
    && candidate.documentId === document.documentId
    && candidate.layerId === layer.layerId
    && candidate.layerRevision === layer.layerRevision
    && candidate.snapshotId === snapshotId
    && candidate.sourceFingerprint === document.source.fingerprint
    && candidate.width === layer.bounds.width
    && candidate.height === layer.bounds.height
    && candidate.placement?.x === layer.bounds.x
    && candidate.placement?.y === layer.bounds.y
    && Number(candidate.alpha?.max) > 0
    && candidate.review?.checks
    && Object.keys(candidate.review.checks).length > 0
    && Object.values(candidate.review.checks).every(value => value === true);
}

/** Derive the user-visible state without mutating document, attempts, or candidate history. */
export function candidateState(document, layerId, versions = [], attempts = []) {
  const layer = document.layers[layerId];
  if (!layer || !document.layerOrder.includes(layerId)) return { status: 'inactive', reason: 'LAYER_NOT_ACTIVE', versionIds: [] };
  const snapshotId = freezeLayer(document, layerId).snapshotId;
  const relatedVersions = versions.filter(version => version.layerId === layerId);
  const current = relatedVersions.filter(version => candidateMatches(document, layer, version, snapshotId));
  const versionIds = [...current].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(version => version.versionId);
  if (layer.acceptedVersionId) {
    const adopted = current.find(version => version.versionId === layer.acceptedVersionId);
    return adopted
      ? { status: 'adopted', reason: null, versionIds, adoptedVersionId: adopted.versionId }
      : { status: 'stale', reason: 'ADOPTED_VERSION_DOES_NOT_MATCH_CURRENT_LAYER', versionIds };
  }
  if (current.length) return { status: 'review', reason: 'CANDIDATE_REQUIRES_USER_ADOPTION', versionIds };
  const relatedAttempts = attempts.filter(attempt => attempt.layerId === layerId && attempt.layerRevision === layer.layerRevision
    && attempt.sourceFingerprint === document.source.fingerprint);
  if (relatedAttempts.some(attempt => attempt.execution === 'running' || attempt.execution === 'finalizing')) {
    return { status: 'processing', reason: 'CURRENT_LAYER_ATTEMPT_RUNNING', versionIds };
  }
  if (relatedAttempts.some(attempt => attempt.execution === 'failed')) return { status: 'failed', reason: 'CURRENT_LAYER_ATTEMPT_FAILED', versionIds };
  if (relatedAttempts.some(attempt => attempt.execution === 'suggested')) return { status: 'failed', reason: 'SUGGESTED_CANDIDATE_MISSING', versionIds };
  if (relatedAttempts.some(attempt => attempt.execution === 'cancelled')) return { status: 'cancelled', reason: 'CURRENT_LAYER_ATTEMPT_CANCELLED', versionIds };
  return { status: 'pending', reason: 'NO_CURRENT_CANDIDATE', versionIds };
}

/** Return only explicitly adopted, current raster layers in the document's front-to-back order. */
export function getCompositionLayers(document, versions = []) {
  return document.layerOrder.flatMap((layerId, order) => {
    const layer = document.layers[layerId];
    if (!layer.acceptedVersionId) return [];
    const candidate = versions.find(version => version.versionId === layer.acceptedVersionId);
    if (!candidate || !candidateMatches(document, layer, candidate, freezeLayer(document, layerId).snapshotId)) return [];
    return [{ layerId, name: layer.name, versionId: candidate.versionId, pngPath: candidate.pngPath,
      sha256: candidate.sha256, width: candidate.width, height: candidate.height,
      placement: { ...candidate.placement }, order }];
  });
}
