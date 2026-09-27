import { applyLayerEdit } from './document.js';

const editableFields = new Set(['name', 'displayCategory', 'processingCategory', 'bounds', 'paths', 'requirements', 'strategy']);
const clone = value => structuredClone(value);

export function createEditorDraft(document, layerId) {
  const layer = document.layers[layerId];
  if (!layer || !document.layerOrder.includes(layerId)) throw new Error('INACTIVE_LAYER');
  return {
    status: 'editing',
    documentId: document.documentId,
    layerId,
    baseLayerRevision: layer.layerRevision,
    source: clone(document.source),
    values: Object.fromEntries([...editableFields].map(field => [field, clone(layer[field])])),
  };
}

export function reduceEditorDraft(draft, event = {}) {
  if (!draft || draft.status !== 'editing') return draft;
  if (event.type === 'cancel') return { ...draft, status: 'cancelled' };
  if (event.type === 'set-field' && editableFields.has(event.field)) {
    return { ...draft, values: { ...draft.values, [event.field]: clone(event.value) } };
  }
  if (event.type === 'set-strategy' && ['operation', 'removeBackground', 'repairPaths'].includes(event.field)) {
    return { ...draft, values: { ...draft.values, strategy: { ...draft.values.strategy, [event.field]: clone(event.value) } } };
  }
  return draft;
}

export function commitEditorDraft(document, draft) {
  if (!draft || draft.status !== 'editing') throw new Error('EDITOR_DRAFT_CLOSED');
  if (document.documentId !== draft.documentId) throw new Error('DOCUMENT_EDIT_CONFLICT');
  const layer = document.layers[draft.layerId];
  if (!layer || layer.layerRevision !== draft.baseLayerRevision) throw new Error('LAYER_EDIT_CONFLICT');
  const patch = Object.fromEntries([...editableFields]
    .filter(field => JSON.stringify(layer[field]) !== JSON.stringify(draft.values[field]))
    .map(field => [field, clone(draft.values[field])]));
  return Object.keys(patch).length ? applyLayerEdit(document, draft.layerId, patch) : document;
}
