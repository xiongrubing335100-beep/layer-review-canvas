import { addLayer, createDocument, validateDocument } from './document.js';

const categoryMap = Object.freeze({
  kvTitle: 'text', ordinaryText: 'text', kvElement: 'subject', uiComponent: 'brand_ui', kvBackground: 'background',
  title: 'text', text: 'text', subject: 'subject', logo: 'brand_ui', decoration: 'decoration_prop',
  effect: 'effect', background: 'background',
});
const legacyCategories = Object.freeze({
  kvTitle: '主标题', ordinaryText: '文案', kvElement: '角色', uiComponent: '品牌与界面', kvBackground: '背景',
});
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value);
const isPositive = value => Number.isSafeInteger(value) && value > 0;

function resolveLegacyImage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_LEGACY_DOCUMENT');
  if (value.images && typeof value.images === 'object') {
    const image = value.images[value.activeImageId] || Object.values(value.images)[0];
    if (!image) throw new Error('LEGACY_PROJECT_EMPTY');
    return image;
  }
  return value;
}

function pixelBounds(bounds, width, height) {
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) return null;
  if (bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0
    || bounds.x + bounds.width > 100 || bounds.y + bounds.height > 100) return null;
  const result = {
    x: Math.round((bounds.x / 100) * width), y: Math.round((bounds.y / 100) * height),
    width: Math.round((bounds.width / 100) * width), height: Math.round((bounds.height / 100) * height),
  };
  if (!result.width || !result.height || result.x + result.width > width || result.y + result.height > height) return null;
  return result;
}

function candidateIsBoundToSource(candidate, legacy, source, bounds) {
  if (!candidate || candidate.verified !== true || candidate.sourceFingerprint !== legacy.sourceFingerprint
    || candidate.sourceWidth !== source.width || candidate.sourceHeight !== source.height
    || !validHash(candidate.sha256) || candidate.placement?.x !== bounds.x || candidate.placement?.y !== bounds.y
    || candidate.width !== bounds.width || candidate.height !== bounds.height) return false;
  return true;
}

/**
 * Convert one user-selected V1 image/project record into a fresh V2 document.
 * The selected source must be independently re-selected and bound to the old
 * source identity; old results are history only and never become accepted V2 layers.
 */
export function importLegacyDocument({ legacyDocument, verifiedAssets, newDocumentId }) {
  const legacy = resolveLegacyImage(legacyDocument);
  const source = verifiedAssets?.source;
  const workbenchSessionId = verifiedAssets?.workbenchSessionId;
  if (!source || source.legacyFingerprint !== legacy.sourceFingerprint || !legacy.sourceFingerprint) {
    throw new Error('LEGACY_SOURCE_IDENTITY_MISMATCH');
  }
  if (!isPositive(source.width) || !isPositive(source.height) || source.width !== legacy.sourceSize?.width
    || source.height !== legacy.sourceSize?.height) throw new Error('LEGACY_SOURCE_DIMENSIONS_MISMATCH');
  if (!source.path || !validHash(source.fingerprint) || !isPositive(source.revision) || !workbenchSessionId) {
    throw new Error('VERIFIED_SOURCE_REQUIRED');
  }
  if (!Array.isArray(legacy.nodes)) throw new Error('INVALID_LEGACY_NODES');

  const warnings = [];
  const history = [];
  const oldMode = legacy.documentMode || legacy.mode;
  if (!['poster', 'h5', 'ui'].includes(oldMode)) throw new Error('LEGACY_MODE_UNSUPPORTED');
  const mode = oldMode === 'ui' || oldMode === 'h5' ? 'h5' : 'poster';
  if (oldMode === 'ui') warnings.push('旧版 UI 项目已明确映射为 H5 模式。');
  const results = Array.isArray(legacy.results) ? legacy.results : [];
  const { legacyFingerprint, ...v2Source } = source;
  void legacyFingerprint;
  let document = createDocument({ documentId: newDocumentId, workbenchSessionId, mode, source: v2Source });
  let index = 0;

  for (const [nodeIndex, node] of legacy.nodes.entries()) {
    if (!node || typeof node !== 'object') { warnings.push(`旧版第 ${nodeIndex + 1} 个拆分定义无效，已跳过。`); continue; }
    const processingCategory = Object.hasOwn(categoryMap, node.category) ? categoryMap[node.category] : null;
    const bounds = pixelBounds(node.bounds, source.width, source.height);
    if (!processingCategory || !bounds) {
      warnings.push(`「${String(node.name || `拆分项 ${nodeIndex + 1}`)}」的类别或框选不受支持，未导入。`);
      continue;
    }
    index += 1;
    const layerId = `legacy-${index}`;
    document = addLayer(document, {
      layerId, name: String(node.name || legacyCategories[node.category] || `旧版拆分项 ${index}`).trim() || `旧版拆分项 ${index}`,
      displayCategory: String(legacyCategories[node.category] || node.category).trim(), processingCategory, bounds,
      paths: [], requirements: String(node.requirement || node.refinementPrompt || ''),
      strategy: { operation: processingCategory === 'background' ? 'reconstruct' : 'extract',
        removeBackground: Boolean(node.removeBackground), repairPaths: [] },
    });
    const nodeResults = results.filter(result => result?.nodeId === node.id || result?.layerId === node.id);
    if (node.status === 'accepted' || nodeResults.length) {
      for (const result of nodeResults.length ? nodeResults : [{ id: null }]) {
        const verified = candidateIsBoundToSource(verifiedAssets?.candidates?.[result?.id], legacy, source, bounds);
        history.push({ legacyNodeId: String(node.id || ''), legacyCandidateId: result?.id || null,
          layerId, name: String(node.name || layerId), artifactPresent: Boolean(result?.id),
          status: result?.id ? 'untrusted_pending_review' : 'legacy_accepted_marker', reviewEligible: verified,
          reason: result?.id ? (verified ? 'IDENTITY_AND_ORIGINAL_PLACEMENT_MATCHED_BUT_REQUIRES_MANUAL_REVIEW' : 'LEGACY_RESULT_BINDING_UNVERIFIED')
            : 'LEGACY_ACCEPTED_STATUS_HAS_NO_IMPORTABLE_ARTIFACT' });
      }
    }
    if ((node.paths?.length || node.marks?.length) && !warnings.includes('旧版钢笔与边界标注未自动迁入；请在 V2 中重新检查标注。')) {
      warnings.push('旧版钢笔与边界标注未自动迁入；请在 V2 中重新检查标注。');
    }
  }
  if (results.length && !history.length) warnings.push('旧版有候选结果，但当前选择的项目记录未包含可核验结果元数据；候选文件保留在旧项目中。');
  if (history.length) warnings.push('旧版候选仅保留为历史记录；重新拆分后的合格结果将自动用于 PSD。');
  // A migration creates one new document revision, regardless of its layer count.
  document = validateDocument({ ...document, revision: 1 });
  return { document, history, warnings };
}
