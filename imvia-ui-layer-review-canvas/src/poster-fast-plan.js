import { analyzeFastCategories } from './fast-category-analysis.js';
import {
  canonicalJson, createPosterPlan, digestCanonicalJson, validatePosterPlan,
} from './poster-plan.js';
import { defaultPosterFastPrompt, posterFastPromptIssue } from './poster-fast-workbench-model.js';

export const FAST_PLANNING_MODE = 'targeted_fast';
export const FAST_PLANNING_ORIGIN = 'workbench_local_suggestion';
export const FAST_ADAPTER = 'imvia-poster-layering-workbench-targeted-v1';

const CATEGORY_MAP = {
  kvTitle: ['主体', 'subject'],
  ordinaryText: ['普通文字', 'text'],
  uiComponent: ['品牌与界面', 'brand_ui'],
  kvElement: ['装饰与道具', 'decoration_prop'],
  effect: ['光效', 'effect'],
  kvBackground: ['背景', 'background'],
};
const CATEGORY_ORDER = ['kvTitle', 'ordinaryText', 'uiComponent', 'kvElement', 'effect', 'kvBackground'];

function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function normalizeBounds(bounds, width, height) {
  const source = bounds || { x: 0, y: 0, width: 100, height: 100 };
  const x = clamp(Number(source.x) || 0, 0, 100);
  const y = clamp(Number(source.y) || 0, 0, 100);
  const right = clamp(x + (Number(source.width) || 0), x, 100);
  const bottom = clamp(y + (Number(source.height) || 0), y, 100);
  const percentage = { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), width: Number((right - x).toFixed(1)), height: Number((bottom - y).toFixed(1)) };
  const pixelLeft = clamp(Math.round(x * width / 100), 0, width);
  const pixelRight = clamp(Math.round(right * width / 100), pixelLeft, width);
  const pixelTop = clamp(Math.round(y * height / 100), 0, height);
  const pixelBottom = clamp(Math.round(bottom * height / 100), pixelTop, height);
  return { percentage, source_pixels: { x: pixelLeft, y: pixelTop, width: pixelRight - pixelLeft, height: pixelBottom - pixelTop } };
}

function baseLayer(draft, index, source) {
  const [name, processing_category] = CATEGORY_MAP[draft.category];
  const bounds = normalizeBounds(draft.bounds, source.width, source.height);
  return {
    layer_index: index, layer_name: name, asset_role: processing_category === 'subject' ? 'person' : processing_category === 'text' ? 'title' : processing_category === 'brand_ui' ? 'ui' : processing_category === 'decoration_prop' ? 'decoration' : processing_category,
    layer_type: processing_category === 'text' ? 'text' : processing_category === 'background' ? 'background' : processing_category === 'effect' ? 'effect' : 'graphic',
    z_order: index, position: 'full canvas coordinates', visible_content: [], included_content: [], excluded_content: [],
    occludes: [], occluded_by: [], source_evidence: [], support_components: [], ui_independence: processing_category === 'brand_ui' ? 'independent' : 'not_applicable',
    repair_envelope: { description: '', covered_segment: [], seam_band: '', forbidden_regions: [] }, locked_visible_anchors: [], completion_required: false,
    completion_regions: [], risk_level: 'medium', processing_mode: processing_category === 'background' ? 'background_completion' : processing_category === 'effect' ? 'effect_completion' : 'graphic_completion',
    fill_color: processing_category === 'effect' ? '#000000' : '#00FF00', compositing_mode: processing_category === 'effect' ? 'Screen' : 'Normal', separation_reason: 'local fast suggestion',
    processing_category, prompt: String(draft.prompt || '').trim() || defaultPosterFastPrompt(processing_category),
    bounds, planning_confidence: 0.5, user_confirmed: false,
  };
}

export function suggestPosterFastLayers({ data, width, height } = {}) {
  const source = { width: Number.isInteger(width) && width > 0 ? width : 1, height: Number.isInteger(height) && height > 0 ? height : 1 };
  const drafts = analyzeFastCategories({ data, width: source.width, height: source.height });
  return CATEGORY_ORDER.map((category, index) => baseLayer(drafts.find((draft) => draft.category === category) || { category, bounds: { x: 0, y: 0, width: 100, height: 100 } }, index + 1, source));
}

export function createFastPosterPlan(input = {}) {
  const source = clone(input.source || {});
  const layers = (input.layers || []).map((layer, index) => ({ ...layer, layer_index: layer.layer_index || index + 1 }));
  return createPosterPlan({ ...input, source, layers, planning_mode: FAST_PLANNING_MODE, planning_origin: FAST_PLANNING_ORIGIN, display_language: 'zh-CN', skill_contract: { base: 'lovart-poster-layering-v3-1', adapter: FAST_ADAPTER, auto_retry: false, full_canvas: true } });
}

export function buildFastLayerSnapshot(plan, layerIndex, patch = {}, confirmedAt = new Date().toISOString()) {
  const copy = clone(plan); const target = copy.layers?.find((layer) => layer.layer_index === layerIndex);
  if (!target) throw new RangeError(`Unknown poster layer: ${layerIndex}`);
  const prompt = String(patch.prompt ?? target.prompt ?? target.requirement ?? '').trim()
    || defaultPosterFastPrompt(target.processing_category);
  const promptIssue = posterFastPromptIssue(target.processing_category, prompt);
  if (promptIssue) throw new Error(promptIssue.message);
  const layer = {
    ...target,
    remove_background: target.remove_background !== false,
    ...clone(patch),
    prompt,
    layer_index: target.layer_index,
    user_confirmed: true,
    confirmed_at: confirmedAt,
  };
  const snapshotBase = { job_id: copy.job_id, plan_version: copy.plan_version, layer_index: layerIndex, layer, source: copy.source };
  const snapshotId = digestCanonicalJson(snapshotBase);
  const confirmedSnapshot = {
    snapshot_id: snapshotId, job_id: copy.job_id, project_id: copy.project_id, image_id: copy.image_id,
    plan_version: copy.plan_version, layer_index: layerIndex, layer: clone(layer), source: clone(copy.source),
    skill_contract: clone(copy.skill_contract), planning_mode: copy.planning_mode, user_confirmed: true, confirmed_at: confirmedAt,
  };
  const confirmedLayer = {
    ...layer, snapshot_id: snapshotId, snapshot_plan_version: copy.plan_version,
    snapshot_user_confirmed: true, confirmed_snapshot: confirmedSnapshot,
  };
  const nextPlan = { ...copy, layers: copy.layers.map((item) => item.layer_index === layerIndex ? confirmedLayer : item) };
  const snapshot = clone(confirmedSnapshot);
  return { snapshot, plan: nextPlan };
}

export function fastLayerState(layer = {}) {
  return { SUGGESTED: '待确认', USER_CONFIRMED: '已确认', GENERATION_AUTHORIZED: '已授权生成', GENERATING: '生成中', CANDIDATE_CREATED: '候选已生成', HARD_REJECTED: '硬失败', NEEDS_USER_REVIEW: '待人工复核', ACCEPTED: '已接受' }[layer.state || layer.status] || '待确认';
}

export function removeFastPosterLayer(plan, layerIndex) {
  const copy = clone(plan);
  const layers = Array.isArray(copy.layers) ? copy.layers : [];
  if (layers.length <= 1) throw new Error('快速海报至少保留一个拆分项目');
  const sorted = [...layers].sort((left, right) => left.layer_index - right.layer_index);
  const removedAt = sorted.findIndex((layer) => layer.layer_index === layerIndex);
  if (removedAt < 0) throw new RangeError(`Unknown poster layer: ${layerIndex}`);
  const survivors = sorted.filter((layer) => layer.layer_index !== layerIndex);
  const nearest = survivors[removedAt] || survivors[removedAt - 1];
  return {
    plan: { ...copy, layers: survivors },
    selectedLayerIndex: nearest.layer_index,
  };
}

export { validatePosterPlan };
