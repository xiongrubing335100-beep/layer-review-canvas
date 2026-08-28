const CATEGORY_META = Object.freeze({
  subject: { label: '主体', order: 1 },
  text: { label: '标题文字', order: 2 },
  brand_ui: { label: '品牌与 UI', order: 3 },
  decoration_prop: { label: '装饰与道具', order: 4 },
  effect: { label: '光效', order: 5 },
  background: { label: '背景', order: 6 },
});

export const POSTER_FAST_DEFAULT_PROMPTS = Object.freeze({
  subject: '拆分主体元素（如人物、花束或产品主体），保留完整轮廓、原有细节和材质，不新增内容。',
  text: '拆分标题与正文文字，保留原字体、字形、颜色、描边和材质，不改写文字。',
  brand_ui: '拆分品牌标识与 UI 组件，保留原始 Logo、图标、按钮和界面文字细节。',
  decoration_prop: '拆分装饰与道具元素，保留完整轮廓、材质、光影和原有遮挡关系。',
  effect: '拆分光效与透明叠加效果，保留原有颜色、透明度、发光边缘和混合关系。',
  background: '拆分背景区域，保留背景纹理、渐变和空间关系，不包含前景主体、文字或装饰。',
});

const PROMPT_CONFLICTS = Object.freeze({
  subject: { pattern: /标题|主标题|文字|正文|字体|字形|logo/i, label: '标题或文字' },
  text: { pattern: /人物|花束|产品主体|主体|背景|道具/i, label: '主体、背景或道具' },
  brand_ui: { pattern: /花束|人物|主体|背景/i, label: '主体或背景' },
  background: { pattern: /人物|花束|产品|主体|标题|文字|logo|按钮/i, label: '前景主体、文字或 UI' },
});

export function defaultPosterFastPrompt(category) {
  return POSTER_FAST_DEFAULT_PROMPTS[category] || '';
}

export function posterFastPromptIssue(category, prompt) {
  const value = String(prompt || '').trim();
  const conflict = PROMPT_CONFLICTS[category];
  if (!value || !conflict || !conflict.pattern.test(value)) return null;
  const categoryLabel = CATEGORY_META[category]?.label || '当前类别';
  return {
    code: 'CATEGORY_PROMPT_MISMATCH',
    message: `当前类别为“${categoryLabel}”，但提示词包含${conflict.label}描述。请修改提示词或切换到匹配类别后再拆分。`,
  };
}

const STATUS_LABELS = Object.freeze({
  PENDING: '尚未生成候选',
  GENERATION_AUTHORIZED: '候选生成中',
  RETRY_AUTHORIZED: '等待重新生成',
  GENERATING: '候选生成中',
  CANDIDATE_CREATED: '正在自动质检',
  NEEDS_USER_REVIEW: '候选，未写入正式图层',
  ACCEPTED: '已写入正式图层',
  HARD_REJECTED: '候选未通过自动质检',
  INVALID: '候选已失效',
});

function numericIndex(layer, fallback) {
  return Number.isInteger(layer?.layer_index) ? layer.layer_index : fallback;
}

function candidateValue(candidate, ...keys) {
  for (const key of keys) if (candidate?.[key] !== undefined) return candidate[key];
  return undefined;
}

function candidateFailureCodes(candidate) {
  const review = candidate?.review || {};
  const value = candidateValue(candidate, 'failureCodes', 'failure_codes')
    ?? candidateValue(review, 'failureCodes', 'failure_codes')
    ?? [];
  return Array.isArray(value) ? value : [];
}

function candidateUrl(candidate) {
  return candidateValue(candidate, 'candidateUrl', 'candidate_url', 'previewUrl', 'preview_url') || null;
}

function candidateIdentity(candidate) {
  return candidateValue(candidate, 'candidateId', 'candidate_id', 'id')
    || candidateValue(candidate, 'candidatePath', 'candidate_path', 'path')
    || null;
}

function normalizedBounds(layer) {
  const value = layer?.bounds?.percentage || layer?.bounds || {};
  return {
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    width: Number(value.width) || 0,
    height: Number(value.height) || 0,
  };
}

export function createPosterFastInspectorDraft(layer = {}) {
  const name = String(layer?.layer_name || '');
  const category = String(layer?.processing_category || '');
  const prompt = String(layer?.prompt || layer?.requirement || '').trim() || defaultPosterFastPrompt(category);
  return {
    layerIndex: Number.isInteger(layer?.layer_index) ? layer.layer_index : null,
    category,
    name,
    prompt,
    originalName: name,
    originalPrompt: prompt,
  };
}

export function reducePosterFastInspectorDraft(draft, action = {}) {
  const current = draft || createPosterFastInspectorDraft();
  if (action.type === 'name-input') return { ...current, name: String(action.value ?? '') };
  if (action.type === 'prompt-input') return { ...current, prompt: String(action.value ?? '') };
  if (action.type === 'replace-layer') {
    const incoming = createPosterFastInspectorDraft(action.layer);
    if (incoming.layerIndex !== current.layerIndex) return incoming;
    const nameDirty = current.name !== current.originalName;
    const promptDirty = current.prompt !== current.originalPrompt;
    return {
      ...incoming,
      name: nameDirty ? current.name : incoming.name,
      prompt: promptDirty ? current.prompt : incoming.prompt,
    };
  }
  return current;
}

export function posterFastInspectorCommitPatch(draft, field) {
  if (!draft) return null;
  if (field === 'name') return draft.name === draft.originalName ? null : { layer_name: draft.name };
  if (field === 'prompt') {
    const prompt = draft.prompt.trim() || defaultPosterFastPrompt(draft.category);
    return prompt === draft.originalPrompt ? null : { prompt };
  }
  throw new RangeError(`Unknown poster inspector field: ${field}`);
}

export function posterFastContainedImageRect(container = {}, sourceSize = {}) {
  const containerWidth = Number(container.width);
  const containerHeight = Number(container.height);
  const sourceWidth = Number(sourceSize.width);
  const sourceHeight = Number(sourceSize.height);
  if (!(containerWidth > 0 && containerHeight > 0 && sourceWidth > 0 && sourceHeight > 0)) return null;
  const scale = Math.min(containerWidth / sourceWidth, containerHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
  };
}

export function posterFastPointerPercent(point = {}, imageRect = {}) {
  const x = Number(point.x);
  const y = Number(point.y);
  const { left, top, width, height } = imageRect;
  if (!(Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0)
    || x < left || x > left + width || y < top || y > top + height) return null;
  return {
    x: ((x - left) / width) * 100,
    y: ((y - top) / height) * 100,
  };
}

export function posterFastCropPreviewGeometry(bounds = {}, sourceSize = {}, options = {}) {
  const width = Math.max(1, Number(bounds.width) || 0);
  const height = Math.max(1, Number(bounds.height) || 0);
  const sourceWidth = Math.max(1, Number(sourceSize.width) || 0);
  const sourceHeight = Math.max(1, Number(sourceSize.height) || 0);
  const cropWidth = sourceWidth * (width / 100);
  const cropHeight = sourceHeight * (height / 100);
  const aspectRatio = Math.max(0.12, cropWidth / cropHeight);
  const previewHeight = Math.max(120, Number(options.previewHeight) || 390);
  const expandedPreviewHeight = Math.max(160, Number(options.expandedPreviewHeight) || 720);
  return {
    aspectRatio,
    aspectRatioCss: `${cropWidth} / ${cropHeight}`,
    maxWidth: `${Math.max(48, Math.round(aspectRatio * previewHeight))}px`,
    expandedMaxWidth: `${Math.max(48, Math.round(aspectRatio * expandedPreviewHeight))}px`,
    imageStyle: {
      width: `${10000 / width}%`,
      height: `${10000 / height}%`,
      left: `${-((Number(bounds.x) || 0) / width) * 100}%`,
      top: `${-((Number(bounds.y) || 0) / height) * 100}%`,
    },
  };
}

export function posterFastCandidatePreviewPath({ jobId, layerIndex, candidate } = {}) {
  const directUrl = candidateUrl(candidate);
  if (directUrl) return directUrl;
  const index = Number(layerIndex);
  if (!jobId || !Number.isInteger(index) || index < 1 || !candidateIdentity(candidate)) return null;
  return `/api/poster-layer/jobs/${encodeURIComponent(jobId)}/layers/${encodeURIComponent(index)}/candidate-preview`;
}

export function posterFastCandidateDownloadPath({ jobId, layerIndex, candidate } = {}) {
  const index = Number(layerIndex);
  const execution = candidate?.execution || candidate?.fast_execution;
  if (!jobId || !Number.isInteger(index) || index < 1
    || (!candidateIdentity(candidate) && execution?.raw_candidate_available !== true)) return null;
  return `/api/poster-layer/jobs/${encodeURIComponent(jobId)}/layers/${encodeURIComponent(index)}/candidate-download`;
}

const EXECUTION_STEPS = Object.freeze([
  { key: 'imagegen', label: '生成候选' },
  { key: 'rmbg', label: '去除背景' },
  { key: 'canvas_mapping', label: '全画布归位' },
  { key: 'finalizing', label: '回传工作台' },
]);

function elapsedLabel(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const base = `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return hours ? `${String(hours).padStart(2, '0')}:${base}` : base;
}

export function posterFastExecutionView(execution = {}, now = Date.now()) {
  const startedAt = Date.parse(execution.started_at || '');
  const completedAt = Date.parse(execution.completed_at || '');
  const end = Number.isFinite(completedAt) ? completedAt : Number(now);
  const currentStage = execution.current_stage === 'review_ready' ? 'finalizing' : execution.current_stage;
  const steps = EXECUTION_STEPS.map((step) => ({
    ...step,
    status: execution.stages?.[step.key]?.status || 'pending',
  }));
  return {
    status: execution.status || 'pending',
    currentStage,
    stageLabel: steps.find((step) => step.key === currentStage)?.label || '等待开始',
    elapsedLabel: elapsedLabel(Number.isFinite(startedAt) && Number.isFinite(end) ? end - startedAt : 0),
    steps,
  };
}

export function posterFastRecoveryAction(candidate = {}) {
  const execution = candidate.execution || candidate.fast_execution || {};
  if (execution.recoverability === 'postprocess_only') {
    return { kind: 'postprocess_only', label: '重新处理原 PNG' };
  }
  return { kind: 'regenerate', label: '重新生成此项目' };
}

export function posterFastWorkbenchContract({ layers, selectedLayerIndex } = {}) {
  const concreteLayers = Array.isArray(layers) && layers.length ? layers : [{
    layer_index: 1, layer_name: '花束', processing_category: 'subject',
  }];
  const groups = groupPosterFastLayers(concreteLayers);
  const selected = concreteLayers.find((layer) => layer.layer_index === selectedLayerIndex)
    || concreteLayers[0];
  const selectedGroup = groups.find((group) => group.items.includes(selected));
  return {
    centerPanels: ['原图展示', '框选操作区', 'PNG 回传展示区'],
    inspectorControls: ['名称', '提示词', '去背景', '钢笔', '拆分当前项目'],
    prohibitedMarkup: ['poster-completion', 'bottom-step', 'PosterCandidateReview'],
    projectSelection: {
      ariaCurrent: 'true',
      categoryLabel: selectedGroup?.label || '其他项目',
      projectName: selected?.layer_name || '未命名项目',
    },
  };
}

export function groupPosterFastLayers(layers = []) {
  const buckets = new Map();
  (Array.isArray(layers) ? layers : []).forEach((layer, index) => {
    const category = layer?.processing_category || 'other';
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push({ layer, index });
  });
  return [...buckets.entries()]
    .sort(([left], [right]) => (CATEGORY_META[left]?.order ?? 99) - (CATEGORY_META[right]?.order ?? 99))
    .map(([category, entries]) => ({
      category,
      label: CATEGORY_META[category]?.label || '其他项目',
      items: entries
        .sort((left, right) => numericIndex(left.layer, left.index + 1) - numericIndex(right.layer, right.index + 1))
        .map(({ layer }) => layer),
    }));
}

export function posterFastPngReturnState(candidate = {}) {
  const status = candidate?.status || 'PENDING';
  const failureCodes = candidateFailureCodes(candidate);
  const rejected = status === 'HARD_REJECTED' || failureCodes.length > 0;
  const accepted = status === 'ACCEPTED' || candidate?.accepted === true;
  const reviewReady = status === 'NEEDS_USER_REVIEW' && !rejected;
  return {
    status,
    candidateUrl: candidateUrl(candidate),
    failureCodes,
    execution: candidate.execution || candidate.fast_execution || null,
    formalLayer: accepted,
    kind: accepted ? 'accepted' : rejected ? 'rejected' : reviewReady ? 'review-ready'
      : ['GENERATION_AUTHORIZED', 'RETRY_AUTHORIZED', 'GENERATING', 'CANDIDATE_CREATED'].includes(status) ? 'pending' : 'empty',
    label: accepted ? STATUS_LABELS.ACCEPTED : rejected ? STATUS_LABELS.HARD_REJECTED
      : reviewReady ? STATUS_LABELS.NEEDS_USER_REVIEW : STATUS_LABELS[status] || STATUS_LABELS.PENDING,
  };
}

export function posterFastWorkbenchState({
  plan = {}, selectedLayerIndex, busy = false, sourceUrl = null, candidate = null,
} = {}) {
  const layers = Array.isArray(plan?.layers) ? plan.layers : [];
  const selected = layers.find((layer) => layer?.layer_index === selectedLayerIndex)
    || layers.find((layer) => layer?.layer_index === Number(selectedLayerIndex))
    || layers[0]
    || null;
  const sourceSize = plan?.source && Number.isFinite(plan.source.width) && Number.isFinite(plan.source.height)
    ? { width: plan.source.width, height: plan.source.height }
    : { width: 0, height: 0 };
  const currentCandidate = candidate || { status: selected?.status || selected?.state || 'PENDING' };
  return {
    groups: groupPosterFastLayers(layers),
    source: { label: '原图展示', url: sourceUrl, size: sourceSize, readOnly: true },
    selection: {
      label: '框选操作区', layer: selected, bounds: normalizedBounds(selected), busy: busy === true,
    },
    pngReturn: posterFastPngReturnState(currentCandidate),
    inspector: selected ? {
      layerIndex: selected.layer_index,
      name: selected.layer_name || '',
      prompt: selected.prompt || selected.requirement || '',
      removeBackground: selected.remove_background !== false,
      category: selected.processing_category || 'other',
      busy: busy === true,
    } : null,
  };
}
