const STATUS_LABELS = Object.freeze({
  PENDING: '尚未生成候选',
  GENERATION_AUTHORIZED: '已授权生成候选',
  RETRY_AUTHORIZED: '已授权重新生成',
  GENERATING: '候选生成中',
  CANDIDATE_CREATED: '候选正在自动质检',
  NEEDS_USER_REVIEW: '候选等待人工审核',
  ACCEPTED: '候选已接受',
  HARD_REJECTED: '候选未通过自动质检',
});

const FAILURE_MESSAGES = Object.freeze({
  GENERATION_FAILED: '候选生成失败，尚未产生可审核的 PNG。',
  IMAGEGEN_NO_PNG: '图像生成未返回可用 PNG，无法继续审核。',
  UNSUPPORTED_GRAPHIC_EFFECT: '发现来源中没有证据支撑的图形效果。',
  UI_BUNDLING_ERROR: '独立 UI 被合并，无法单独移动。',
  VISIBLE_ANCHOR_MUTATION: '锁定的可见锚点发生变化。',
  WHOLE_ASSET_REGENERATION: '整体资产疑似被重新绘制。',
  REPAIR_ENVELOPE_EXCEEDED: '修复范围超出了已声明的范围。',
  COMPLETION_MISSING: '声明需要补全的区域仍然缺失。',
  ANATOMY_OR_STRUCTURE_BROKEN: '人物或结构连续性被破坏。',
  TEXT_OR_LOGO_MUTATED: '文字、字形或 Logo 与来源不一致。',
  BACKGROUND_LAYOUT_DRIFT: '背景结构或几何位置发生漂移。',
  OCCLUDER_OWNERSHIP_ERROR: '遮挡者的所有权不明确或不正确。',
  EFFECT_CONTINUITY_BROKEN: '效果层连续性被破坏。',
  FOREIGN_CONTENT_LEAK: '候选中泄漏了不属于本层的内容。',
  REGISTRATION_UNCERTAIN: '候选与原图的配准无法确认。',
  KEY_UNUSABLE: '绿幕/黑底 key 不可用于正式图层。',
  CANVAS_OR_GREEN_FIELD_INVALID: '候选画布或 key 字段不符合要求。',
});

function valueAt(value, ...keys) {
  for (const key of keys) if (value?.[key] !== undefined) return value[key];
  return undefined;
}

function dimensions(value) {
  const width = Number(value?.width);
  const height = Number(value?.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? `${width} × ${height} px` : null;
}

function factList(code, facts) {
  if (!facts || typeof facts !== 'object') return [];
  if (code === 'CANVAS_OR_GREEN_FIELD_INVALID') {
    const actual = dimensions(valueAt(facts, 'dimensions', 'canvasDimensions', 'canvas_dimensions'));
    const expected = dimensions(valueAt(facts, 'expectedDimensions', 'expected_dimensions', 'sourceSize', 'source_size'));
    return [actual ? `实际画布：${actual}` : null, expected ? `要求画布：${expected}` : null].filter(Boolean);
  }
  if (code === 'KEY_UNUSABLE') {
    const observedKey = valueAt(facts, 'observedKey', 'observed_key');
    const expectedKey = valueAt(facts, 'expectedKey', 'expected_key');
    return [
      typeof observedKey === 'string' && observedKey ? `实际键色：${observedKey}` : null,
      typeof expectedKey === 'string' && expectedKey ? `要求键色：${expectedKey}` : null,
    ].filter(Boolean);
  }
  if (code === 'REGISTRATION_UNCERTAIN') {
    const registration = valueAt(facts, 'registration', 'registrationDetail', 'registration_detail');
    return typeof registration === 'string' && registration ? [`配准：${registration}`] : [];
  }
  return [];
}

export function posterCandidateStatusLabel(status) {
  return STATUS_LABELS[status] || '候选状态未知';
}

// Machine codes remain the stable API contract; this only supplies the
// user-facing Chinese explanation and any concrete inspection facts.
export function failureExplanation(code, facts) {
  const technicalCode = typeof code === 'string' && code ? code : undefined;
  return {
    message: FAILURE_MESSAGES[technicalCode] || '候选未通过发布检查。',
    ...(technicalCode ? { technicalCode } : {}),
    facts: factList(technicalCode, facts),
  };
}

export function posterCandidateReviewModel({
  status = 'PENDING', canGenerate = false, canAccept = false, canRetry = false,
  failureCodes = [], facts, busy = false, onGenerate, onAccept, onRetry,
} = {}) {
  const actions = [];
  if (canGenerate && ['PENDING', 'GENERATION_AUTHORIZED', 'RETRY_AUTHORIZED'].includes(status)) {
    actions.push({ id: 'generate', label: '生成候选', disabled: busy, onInvoke: () => onGenerate?.() });
  }
  if (status === 'NEEDS_USER_REVIEW' && canAccept) {
    actions.push({ id: 'accept', label: '接受候选', disabled: busy, onInvoke: () => onAccept?.() });
  }
  if (status === 'NEEDS_USER_REVIEW' && canRetry) {
    actions.push({ id: 'retry', label: '重试此层', disabled: busy, onInvoke: () => onRetry?.() });
  }
  if (status === 'HARD_REJECTED' && canRetry) {
    actions.push({ id: 'retry', label: '重新生成此层', disabled: busy, onInvoke: () => onRetry?.() });
  }
  return {
    actions,
    statusLabel: posterCandidateStatusLabel(status),
    failures: (Array.isArray(failureCodes) ? failureCodes : []).map((code) => failureExplanation(code, facts)),
    preview: { kind: 'simulated-transparency', downloadable: false },
  };
}
