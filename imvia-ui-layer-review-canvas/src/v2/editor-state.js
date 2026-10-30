import { applyLayerEdit, categoryPresets, defaultLayerStrategy, processingCategories } from './document.js';
import { defaultPosterFastPrompt } from '../poster-fast-workbench-model.js';
import { hasLocalRepairRequirements } from './layer-requirements.js';

const editableFields = new Set(['name', 'displayCategory', 'processingCategory', 'bounds', 'paths', 'requirements', 'strategy']);
const clone = value => structuredClone(value);

export const quickLayerActions = [
  { id: 'preserve-pixels', label: '保留原图可见像素', prompt: '保留框选区域内原有可见像素，不改变其外观。' },
  { id: 'remove-text', label: '去字后补全底板', prompt: '移除文字后自然补全被遮挡的背景底板。', operation: 'reconstruct' },
  { id: 'repair-occlusion', label: '补全被遮挡区域', prompt: '按周围纹理与光影补全被遮挡区域。', operation: 'reconstruct' },
  { id: 'preserve-placement', label: '保留框选尺寸和位置', prompt: '保持原图中的框选尺寸、位置与比例。' },
];

export function createEditorDraft(document, layerId) {
  const layer = document.layers[layerId];
  if (!layer || !document.layerOrder.includes(layerId)) throw new Error('INACTIVE_LAYER');
  return {
    status: 'editing',
    documentId: document.documentId,
    layerId,
    baseLayerRevision: layer.layerRevision,
    initialValues: { ...Object.fromEntries([...editableFields].map(field => [field, clone(layer[field])])),
      requirements: layer.requirements.trim() ? layer.requirements : defaultPosterFastPrompt(layer.processingCategory) },
    customCategory: !categoryPresets.some(([label, route]) => label === layer.displayCategory && route === layer.processingCategory),
    source: clone(document.source),
    values: { ...Object.fromEntries([...editableFields].map(field => [field, clone(layer[field])])),
      requirements: layer.requirements.trim() ? layer.requirements : defaultPosterFastPrompt(layer.processingCategory) },
  };
}

export function hasDraftChanges(document, draft) {
  if (!draft || draft.documentId !== document?.documentId || draft.status !== 'editing') return false;
  const baseline = draft.initialValues || createEditorDraft(document, draft.layerId).values;
  return JSON.stringify(draft.values) !== JSON.stringify(baseline) || Object.values(draft.penSessions || {}).some(session => session.draft);
}

export function resumeEditorDraft(document, layerId, cached) {
  if (cached?.documentId === document.documentId && cached.layerId === layerId && cached.status === 'editing') {
    if (cached.baseLayerRevision === document.layers[layerId]?.layerRevision) return cached;
    if (hasDraftChanges(document, cached)) throw new Error('LAYER_EDIT_CONFLICT：草稿已保留，当前图层已被修改，请先核对');
  }
  return createEditorDraft(document, layerId);
}

export function reduceEditorDraft(draft, event = {}) {
  if (!draft || draft.status !== 'editing') return draft;
  if (event.type === 'cancel') return { ...draft, status: 'cancelled' };
  if (event.type === 'apply-quick-prompt') {
    const action = quickLayerActions.find(item => item.id === event.id);
    if (!action) return draft;
    const requirements = draft.values.requirements.split('\n');
    if (!requirements.includes(action.prompt)) requirements.push(action.prompt);
    const strategy = { ...draft.values.strategy, ...(action.operation ? { operation: action.operation } : {}) };
    // Explicit interior edits must not be reduced to the automatic edge-only repair band.
    if (action.operation === 'reconstruct' && !strategy.repairPaths.length) delete strategy.fidelityPolicy;
    return { ...draft, values: { ...draft.values, requirements: requirements.filter(Boolean).join('\n'),
      strategy } };
  }
  if (event.type === 'set-pen-state' && ['paths', 'repairPaths'].includes(event.target)) {
    const updated = reduceEditorDraft(draft, event.target === 'repairPaths'
      ? { type: 'set-strategy', field: 'repairPaths', value: event.paths }
      : { type: 'set-field', field: 'paths', value: event.paths });
    return { ...updated, penSessions: { ...updated.penSessions, [event.target]: clone(event.session) } };
  }
  if (event.type === 'set-category' && event.value === '__custom__') {
    if (draft.customCategory) return draft;
    return { ...draft, customCategory: true, values: { ...draft.values, displayCategory: '' } };
  }
  if (event.type === 'set-category' || event.type === 'set-processing-category') {
    const preset = categoryPresets.find(([label]) => label === event.value);
    const processingCategory = event.type === 'set-category' ? preset?.[1] : event.value;
    if (!processingCategories.includes(processingCategory)) return draft;
    const current = draft.values;
    const useDefault = !current.requirements.trim()
      || current.requirements.trim() === defaultPosterFastPrompt(current.processingCategory);
    const defaults = defaultLayerStrategy(processingCategory);
    const adoptDefaults = useDefault && current.strategy.operation === defaultLayerStrategy(current.processingCategory).operation
      && !hasLocalRepairRequirements(current) && !current.strategy.repairPaths.length;
    const operation = adoptDefaults ? defaults.operation : current.strategy.operation;
    const strategy = { ...current.strategy, operation, removeBackground: defaults.removeBackground };
    if (adoptDefaults && current.strategy.fidelityPolicy !== 'strict_source') {
      delete strategy.fidelityPolicy;
      if (defaults.fidelityPolicy) strategy.fidelityPolicy = defaults.fidelityPolicy;
    }
    return { ...draft, customCategory: event.type === 'set-category' ? false : draft.customCategory,
      values: { ...current, displayCategory: preset?.[0] ?? current.displayCategory, processingCategory,
        strategy,
        requirements: useDefault ? defaultPosterFastPrompt(processingCategory) : current.requirements } };
  }
  if (event.type === 'set-field' && editableFields.has(event.field)) {
    return { ...draft, values: { ...draft.values, [event.field]: clone(event.value) } };
  }
  if (event.type === 'set-strategy' && ['operation', 'removeBackground', 'repairPaths'].includes(event.field)) {
    const strategy = { ...draft.values.strategy, [event.field]: clone(event.value) };
    if ((event.field === 'repairPaths' || event.field === 'operation') && hasLocalRepairRequirements({ ...draft.values, strategy })) strategy.operation = 'reconstruct';
    if (event.field === 'operation') strategy.fidelityPolicy = strategy.operation === 'reconstruct' ? 'source_faithful_repair' : 'strict_source';
    return { ...draft, values: { ...draft.values, strategy } };
  }
  return draft;
}

export function commitEditorDraft(document, draft) {
  if (!draft || draft.status !== 'editing') throw new Error('EDITOR_DRAFT_CLOSED');
  if (Object.values(draft.penSessions || {}).some(session => session.draft)) throw new Error('请先闭合当前选区，或撤销未完成的路径');
  if (draft.customCategory && !draft.values.displayCategory.trim()) throw new Error('CUSTOM_CATEGORY_NAME_REQUIRED');
  if (document.documentId !== draft.documentId) throw new Error('DOCUMENT_EDIT_CONFLICT');
  const layer = document.layers[draft.layerId];
  if (!layer || layer.layerRevision !== draft.baseLayerRevision) throw new Error('LAYER_EDIT_CONFLICT');
  const patch = Object.fromEntries([...editableFields]
    .filter(field => JSON.stringify(layer[field]) !== JSON.stringify(draft.values[field]))
    .map(field => [field, clone(draft.values[field])]));
  return Object.keys(patch).length ? applyLayerEdit(document, draft.layerId, patch) : document;
}
