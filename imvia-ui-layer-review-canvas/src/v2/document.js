import { z } from 'zod';
import { moveRegionBounds } from './coordinates.js';
import { canonicalJson, digestCanonicalJson } from '../poster-plan.js';
import { defaultPosterFastPrompt } from '../poster-fast-workbench-model.js';

export const processingCategories = ['text', 'subject', 'brand_ui', 'decoration_prop', 'effect', 'background'];
export const categoryPresets = [
  ['主标题', 'text'], ['文案', 'text'], ['角色', 'subject'], ['品牌/Logo', 'brand_ui'],
  ['UI 组件', 'brand_ui'], ['装饰', 'decoration_prop'], ['光效', 'effect'], ['背景', 'background'],
];
export function defaultLayerStrategy(processingCategory) {
  return { operation: processingCategory === 'background' ? 'reconstruct' : 'extract',
    removeBackground: processingCategory !== 'background', repairPaths: [],
    ...(processingCategory !== 'background' ? { fidelityPolicy: 'source_faithful_repair', localRepairPolicy: 'scoped_once_v1' } : {}) };
}
export const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const positive = z.number().int().positive().safe();
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const penPath = z.object({
  id: idSchema, kind: z.enum(['include', 'exclude']), shape: z.literal('bezier_path'),
  closed: z.boolean(), order: z.number().int().default(0),
  requirements: z.string().optional(),
  anchors: z.array(point.extend({ in: point, out: point, handlesLinked: z.boolean() })),
});
const sourceSchema = z.object({ path: z.string().min(1), width: positive, height: positive,
  fingerprint: z.string().min(1), revision: positive }).strict();
export const layerSchema = z.object({
  layerId: idSchema, layerRevision: positive.default(1), name: z.string().trim().min(1),
  displayCategory: z.string().trim().min(1), processingCategory: z.enum(processingCategories),
  bounds: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: positive, height: positive }).strict(),
  paths: z.array(penPath).default([]), requirements: z.string().default(''),
  strategy: z.object({ operation: z.enum(['extract', 'reconstruct']), removeBackground: z.boolean(), repairPaths: z.array(penPath).default([]),
    fidelityPolicy: z.enum(['strict_source', 'source_faithful_repair']).optional(),
    localRepairPolicy: z.literal('scoped_once_v1').optional() }).strict(),
  acceptedVersionId: idSchema.nullable().default(null),
  acceptedQualityReview: z.object({ kind: z.literal('uncertain_edges'), versionId: idSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/), snapshotId: z.string().min(1), policyVersion: positive,
    reviewedAt: z.string().datetime() }).strict().nullable().optional(),
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

export function replaceDocumentSource(document, input) {
  const source = sourceSchema.parse(input);
  if (source.revision !== document.source.revision + 1) throw new Error('INVALID_SOURCE_REVISION');
  const scaleX = source.width / document.source.width;
  const scaleY = source.height / document.source.height;
  const layers = Object.fromEntries(Object.entries(document.layers).map(([id, layer]) => {
    const old = layer.bounds;
    const x = Math.min(source.width - 1, Math.round(old.x * scaleX));
    const y = Math.min(source.height - 1, Math.round(old.y * scaleY));
    const bounds = { x, y,
      width: Math.max(1, Math.min(source.width, Math.round((old.x + old.width) * scaleX)) - x),
      height: Math.max(1, Math.min(source.height, Math.round((old.y + old.height) * scaleY)) - y) };
    // Map within the rounded region so edge anchors stay inside it, even on tiny images.
    const point = p => ({ ...p, x: bounds.x + (p.x - old.x) / old.width * bounds.width,
      y: bounds.y + (p.y - old.y) / old.height * bounds.height });
    const paths = values => values.map(p => ({ ...p, anchors: p.anchors.map(a => ({
      ...point(a), in: point(a.in), out: point(a.out),
    })) }));
    const sameSize = source.width === document.source.width && source.height === document.source.height;
    return [id, { ...layer, layerRevision: layer.layerRevision + 1, bounds,
      paths: sameSize ? layer.paths : paths(layer.paths),
      strategy: { ...layer.strategy, repairPaths: sameSize ? layer.strategy.repairPaths : paths(layer.strategy.repairPaths) } }];
  }));
  return validateDocument({ ...document, source, layers, revision: document.revision + 1 });
}

export function addLayer(document, definition) {
  const layer = layerSchema.parse({ ...definition,
    requirements: definition.requirements ?? defaultPosterFastPrompt(definition.processingCategory),
    strategy: definition.strategy ?? defaultLayerStrategy(definition.processingCategory),
    layerRevision: 1, acceptedVersionId: null, ...(definition.acceptedQualityReview ? { acceptedQualityReview: null } : {}) });
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

export function moveLayerRegion(document, layerId, delta) {
  const layer = activeLayer(document, layerId);
  const bounds = moveRegionBounds(layer.bounds, delta, document.source);
  const dx = bounds.x - layer.bounds.x; const dy = bounds.y - layer.bounds.y;
  if (!dx && !dy) return document;
  const point = value => ({ ...value, x: value.x + dx, y: value.y + dy });
  const paths = values => values.map(path => ({ ...path, anchors: path.anchors.map(anchor => ({
    ...point(anchor), in: point(anchor.in), out: point(anchor.out),
  })) }));
  return applyLayerEdit(document, layerId, { bounds, paths: paths(layer.paths),
    strategy: { ...layer.strategy, repairPaths: paths(layer.strategy.repairPaths) } });
}

export function freezeLayer(document, layerId) {
  const valid = validateDocument(document);
  const layer = activeLayer(valid, layerId);
  const content = { source: valid.source, layerId, layerRevision: layer.layerRevision,
    ...Object.fromEntries(pixelKeys.map(key => [key, layer[key]])) };
  // Compact identity only; dispatch manifests additionally bind a server SHA-256.
  return deepFreeze(clone({ snapshotId: digestCanonicalJson(content), ...content }));
}
