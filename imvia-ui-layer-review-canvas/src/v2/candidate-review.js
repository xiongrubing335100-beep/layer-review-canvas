import { freezeLayer } from './document.js';
import { semanticReviewAllowsDelivery } from './semantic-review.js';
import { nativeRgbaReviewPassed } from './native-rgba-review.js';

function hasCurrentGeometryEvidence(alignment) {
  // v7 adds local repair and corner evidence without weakening v6's delivery
  // contract. Keep already verified v6 results downloadable during migration.
  return [6, 7].includes(alignment?.policyVersion) && alignment.method === 'source_guided_matte'
    && ['source_color_projection', 'bounded_shape'].includes(alignment.evidenceMethod)
    && alignment.contourIntegrity?.status === 'passed'
    && alignment.contourIntegrity.changedByAlphaRecoveryPixels === 0
    && alignment.contourIntegrity.lostCounterPixels === 0
    && Number.isFinite(alignment.boundaryMatchRatio) && alignment.boundaryMatchRatio >= 0.90
    && alignment.boundaryMatchRatio <= 1 && Number.isSafeInteger(alignment.boundaryPixels) && alignment.boundaryPixels > 0
    && Number.isSafeInteger(alignment.longestUnsupportedRun) && alignment.longestUnsupportedRun >= 0;
}

/** Historical acknowledgements remain readable, but cannot waive machine quality checks. */
export function candidateAdoptionAllowed(layer, candidate) {
  return sourceGeometryMatches(layer, candidate);
}

export function sourceGeometryMatches(layer, candidate) {
  if ((layer.strategy?.fidelityPolicy === 'source_faithful_repair' || candidate.pixelAudit?.maskProvider === 'native_rgba')
    && (!nativeRgbaReviewPassed(candidate.review) || candidate.pixelAudit?.nativeAlignment?.status !== 'passed')) return false;
  if (!semanticReviewAllowsDelivery(candidate.review)) return false;
  if (candidate.semanticRequirements?.version === 1
    && (candidate.review?.visualReview?.status !== 'passed'
      || candidate.pixelAudit?.semanticTopology?.version !== 1 || candidate.pixelAudit.semanticTopology.status !== 'passed')) return false;
  if (candidate.pixelAudit?.status === 'needs_review' || candidate.alpha?.status === 'needs_review'
    || (layer.strategy?.removeBackground && candidate.alpha?.min === 255)) return false;
  const deferredGeometry = candidate.review?.visualReview?.status === 'proposal_requires_source_alignment';
  if (!deferredGeometry && (!['text', 'brand_ui'].includes(layer.processingCategory)
    || (candidate.pixelAudit?.maskProvider ?? candidate.review?.provider) !== 'imagegen_matte')) return true;
  const alignment = candidate.pixelAudit?.sourceGeometryAlignment;
  return hasCurrentGeometryEvidence(alignment) && alignment.status === 'passed'
    && Array.isArray(alignment.reviewReasons) && alignment.reviewReasons.length === 0
    && alignment.longestUnsupportedRun <= 12;
}

export function geometryReview(layer, candidate) {
  if (!semanticReviewAllowsDelivery(candidate.review)) return { status: 'quality_failed', label: '未达到交付标准',
    detail: '主体完整性检查未通过，此版本未交付。', code: candidate.review?.visualReview?.code || 'SEMANTIC_REVIEW_REJECTED' };
  if (candidate.semanticRequirements?.version === 1
    && (candidate.review?.visualReview?.status !== 'passed'
      || candidate.pixelAudit?.semanticTopology?.version !== 1 || candidate.pixelAudit.semanticTopology.status !== 'passed')) {
    return { status: 'quality_failed', label: '未达到交付标准',
      detail: '缺少主体完整性检查记录，此版本未交付。', code: 'SEMANTIC_REVIEW_REQUIRED' };
  }
  if (sourceGeometryMatches(layer, candidate)) return { status: 'passed', label: '检查通过' };
  if (layer.strategy?.fidelityPolicy === 'source_faithful_repair' || candidate.pixelAudit?.maskProvider === 'native_rgba') {
    return { status: 'quality_failed', label: '修复未完成',
      detail: '修复结果未通过完整内容或原图位置检查，此版本未交付。', code: 'NATIVE_RGBA_REVIEW_FAILED' };
  }
  const alignment = candidate.pixelAudit?.sourceGeometryAlignment;
  if (candidate.validationRecovery?.status === 'failed') return { status: 'validation_failed', label: '补验失败',
    detail: candidate.validationRecovery.message, code: candidate.validationRecovery.code };
  if (layer.strategy?.removeBackground && candidate.alpha?.min === 255) return { status: 'quality_failed', label: '未达到交付标准',
    detail: '自动去背景未完成，此版本未交付。' };
  if (!alignment && (candidate.pixelAudit?.status === 'needs_review' || candidate.alpha?.status === 'needs_review')) {
    return { status: 'quality_failed', label: '未达到交付标准', detail: '自动检查未通过，此版本未交付。' };
  }
  if (alignment?.policyVersion !== 7 || !alignment.contourIntegrity) return { status: 'validation_pending', label: '待补验',
    detail: '旧版结果缺少当前检查，正在复用已有蒙版本地补验，不重新生成。' };
  const reasons = alignment.reviewReasons || [];
  const detail = reasons.includes('ALPHA_CONTOUR_CHANGED') ? '自动处理未能保持轮廓或镂空，此版本未交付。'
    : reasons.includes('POSSIBLE_MISSING_COMPONENTS') ? '自动检查发现可能有内容缺失，此版本未交付。'
    : '自动修正后仍有边缘未达到交付标准，此版本未交付。无需人工确认。';
  return { status: 'quality_failed', label: '未达到交付标准', detail };
}

const newestFirst = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.versionId.localeCompare(a.versionId);

/** One resolver for previews, download readiness and PSD. Never writes the editable document. */
export function resolveLayerResult(document, layerId, versions = []) {
  const layer = document.layers[layerId];
  if (!layer || !document.layerOrder.includes(layerId)) return null;
  const snapshotId = freezeLayer(document, layerId).snapshotId;
  const eligible = versions.filter(candidate => candidateMatches(document, layer, candidate, snapshotId));
  return eligible.find(candidate => candidate.versionId === layer.acceptedVersionId)
    || eligible.sort(newestFirst)[0] || null;
}

export function candidateMatches(document, layer, candidate, snapshotId, requireGeometry = true) {
  return candidate.execution === 'suggested'
    && candidate.artifactValid !== false
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
    && (!requireGeometry || sourceGeometryMatches(layer, candidate))
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
  const versionIds = [...current].sort(newestFirst).map(version => version.versionId);
  const result = resolveLayerResult(document, layerId, current);
  if (result) return { status: 'ready', reason: null, versionIds, resultVersionId: result.versionId };
  const relatedAttempts = attempts.filter(attempt => attempt.layerId === layerId && attempt.layerRevision === layer.layerRevision
    && attempt.sourceFingerprint === document.source.fingerprint);
  if (relatedAttempts.some(attempt => attempt.execution === 'running' || attempt.execution === 'finalizing')) {
    return { status: 'processing', reason: 'CURRENT_LAYER_ATTEMPT_RUNNING', versionIds };
  }
  const diagnostics = relatedVersions.filter(version => candidateMatches(document, layer, version, snapshotId, false)
    && !sourceGeometryMatches(layer, version));
  if (diagnostics.length) {
    const latest = [...diagnostics].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    return { status: geometryReview(layer, latest).status, reason: 'MATTE_REQUIRES_REFINEMENT', versionIds,
      diagnosticVersionIds: diagnostics.map(version => version.versionId) };
  }
  if (layer.acceptedVersionId) return { status: 'stale', reason: 'ADOPTED_VERSION_DOES_NOT_MATCH_CURRENT_LAYER', versionIds };
  if (relatedAttempts.some(attempt => attempt.execution === 'failed')) return { status: 'failed', reason: 'CURRENT_LAYER_ATTEMPT_FAILED', versionIds };
  if (relatedAttempts.some(attempt => attempt.execution === 'suggested')) return { status: 'failed', reason: 'SUGGESTED_CANDIDATE_MISSING', versionIds };
  if (relatedAttempts.some(attempt => attempt.execution === 'cancelled')) return { status: 'cancelled', reason: 'CURRENT_LAYER_ATTEMPT_CANCELLED', versionIds };
  return { status: 'pending', reason: 'NO_CURRENT_CANDIDATE', versionIds };
}

/** Deliver verified current rasters automatically, in the document's front-to-back order. */
export function getCompositionLayers(document, versions = []) {
  return document.layerOrder.flatMap((layerId, order) => {
    const layer = document.layers[layerId];
    const candidate = resolveLayerResult(document, layerId, versions);
    if (!candidate) return [];
    return [{ layerId, name: layer.name, versionId: candidate.versionId, pngPath: candidate.pngPath,
      sha256: candidate.sha256, width: candidate.width, height: candidate.height,
      placement: { ...candidate.placement }, order }];
  });
}
