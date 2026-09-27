import { z } from 'zod';
import { canonicalJson, digestCanonicalJson } from '../poster-plan.js';

export const processingCategories = ['text', 'subject', 'brand_ui', 'decoration_prop', 'effect', 'background'];
export const categoryPresets = [
  ['主标题', 'text'], ['文案', 'text'], ['角色', 'subject'], ['品牌/Logo', 'brand_ui'],
  ['UI 组件', 'brand_ui'], ['装饰', 'decoration_prop'], ['光效', 'effect'], ['背景', 'background'],
];
export const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const positive = z.number().int().positive().safe();
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const penPath = z.object({
  id: idSchema, kind: z.enum(['include', 'exclude']), shape: z.literal('bezier_path'),
  closed: z.boolean(), order: z.number().int().default(0),
  anchors: z.array(point.extend({ in: point, out: point, handlesLinked: z.boolean() })),
});
const sourceSchema = z.object({ path: z.string().min(1), width: positive, height: positive,
  fingerprint: z.string().min(1), revision: positive }).strict();
export const layerSchema = z.object({
  layerId: idSchema, layerRevision: positive.default(1), name: z.string().trim().min(1),
  displayCategory: z.string().trim().min(1), processingCategory: z.enum(processingCategories),
  bounds: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: positive, height: positive }).strict(),
  paths: z.array(penPath).default([]), requirements: z.string().default(''),
  strategy: z.object({ operation: z.enum(['extract', 'reconstruct']), removeBackground: z.boolean(), repairPaths: z.array(penPath).default([]) }).strict(),
  acceptedVersionId: idSchema.nullable().default(null),
}).strict();
const schema = z.object({ schemaVersion: z.literal(2), documentId: idSchema,
  workbenchSessionId: idSchema, mode: z.enum(['poster', 'h5']), source: sourceSchema,
  revision: positive, layers: z.record(layerSchema), layerOrder: z.array(idSchema), activeLayerId: idSchema.nullable(),
}).strict();
const pixelKeys = ['bounds', 'paths', 'requirements', 'processingCategory', 'strategy'];
const editable = new Set(['name', 'displayCategory', ...pixelKeys]);
const clone = value => structuredClone(value);

export function validateDocument(input) {
  const document = schema.parse(input);
  const { width, height } = document.source;
  if (new Set(document.layerOrder).size !== document.layerOrder.length) throw new Error('DUPLICATE_LAYER_ORDER');
  if (document.layerOrder.some(id => !Object.hasOwn(document.layers, id))) throw new Error('UNKNOWN_LAYER');
  if (document.activeLayerId !== null && !document.layerOrder.includes(document.activeLayerId)) throw new Error('INACTIVE_LAYER');
  for (const [id, layer] of Object.entries(document.layers)) {
    if (id !== layer.layerId) throw new Error('LAYER_ID_MISMATCH');
    const b = layer.bounds;
    if (b.x + b.width > width || b.y + b.height > height) throw new Error('BOUNDS_OUTSIDE_SOURCE');
    for (const p of [...layer.paths, ...layer.strategy.repairPaths]) {
      if (p.anchors.some(a => a.x < b.x || a.x > b.x + b.width || a.y < b.y || a.y > b.y + b.height)) throw new Error('PATH_OUTSIDE_BOUNDS');
      if (p.closed && new Set(p.anchors.map(a => `${a.x},${a.y}`)).size < 3) throw new Error('INVALID_CLOSED_PATH');
    }
  }
  return document;
}

export function createDocument({ documentId, workbenchSessionId, mode, source }) {
  return validateDocument({ schemaVersion: 2, documentId, workbenchSessionId, mode, source,
    revision: 1, layers: {}, layerOrder: [], activeLayerId: null });
}

export function addLayer(document, definition) {
  const layer = layerSchema.parse({ ...definition, layerRevision: 1, acceptedVersionId: null });
  if (Object.hasOwn(document.layers, layer.layerId)) throw new Error('LAYER_EXISTS');
  return validateDocument({ ...document, revision: document.revision + 1,
    layers: { ...document.layers, [layer.layerId]: layer },
    layerOrder: [...document.layerOrder, layer.layerId], activeLayerId: layer.layerId });
}

function activeLayer(document, layerId) {
  if (!document.layerOrder.includes(layerId)) throw new Error('INACTIVE_LAYER');
  return document.layers[layerId];
}

export function removeLayer(document, layerId) {
  activeLayer(document, layerId);
  const layerOrder = document.layerOrder.filter(id => id !== layerId);
  return validateDocument({ ...document, revision: document.revision + 1, layerOrder,
    activeLayerId: document.activeLayerId === layerId ? (layerOrder[0] ?? null) : document.activeLayerId });
}

export function reorderLayers(document, layerIds) {
  if (canonicalJson([...layerIds].sort()) !== canonicalJson([...document.layerOrder].sort())) throw new Error('INVALID_LAYER_ORDER');
  return validateDocument({ ...document, revision: document.revision + 1, layerOrder: layerIds });
}

export function applyLayerEdit(document, layerId, patch) {
  const previous = activeLayer(document, layerId);
  if (Object.keys(patch).some(key => !editable.has(key))) throw new Error('IMMUTABLE_LAYER_FIELD');
  const next = layerSchema.parse({ ...previous, ...clone(patch) });
  const changed = pixelKeys.some(key => canonicalJson(previous[key]) !== canonicalJson(next[key]));
  next.layerRevision = previous.layerRevision + Number(changed);
  return validateDocument({ ...document, revision: document.revision + 1,
    layers: { ...document.layers, [layerId]: next } });
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

export function freezeLayer(document, layerId) {
  const valid = validateDocument(document);
  const layer = activeLayer(valid, layerId);
  const content = { source: valid.source, layerId, layerRevision: layer.layerRevision,
    ...Object.fromEntries(pixelKeys.map(key => [key, layer[key]])) };
  // Compact identity only; dispatch manifests additionally bind a server SHA-256.
  return deepFreeze(clone({ snapshotId: digestCanonicalJson(content), ...content }));
}
