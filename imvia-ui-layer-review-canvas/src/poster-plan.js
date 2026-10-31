export const POSTER_PLAN_VERSION = '1.0';

const MAX_CANVAS_DIMENSION = 32768;
const MAX_CANVAS_PIXELS = 268_435_456;
const PLAN_STATUSES = new Set(['ANALYZING', 'PLAN_REVIEW', 'PLAN_CONFIRMED', 'ANALYSIS_FAILED']);
const ASSET_ROLES = new Set([
  'headline', 'title', 'logo', 'brand', 'date', 'cta', 'price', 'badge', 'icon', 'ui',
  'person', 'character', 'prop', 'product', 'effect', 'decoration', 'graphic', 'background',
]);
const LAYER_TYPES = new Set([
  'graphic', 'text', 'ui', 'character', 'person', 'prop', 'product', 'effect', 'decoration',
  'background',
]);
const UI_INDEPENDENCE = new Set(['independent', 'attached', 'not_applicable']);
const RISK_LEVELS = new Set(['low', 'medium', 'high']);
const PROCESSING_MODES = new Set([
  'full_asset_completion', 'graphic_completion', 'effect_completion', 'background_completion',
]);
export const PLANNING_MODES = new Set(['high_quality', 'targeted_fast']);
export const PLANNING_ORIGINS = new Set(['codex_analysis', 'workbench_local_suggestion']);
export const PROCESSING_CATEGORIES = new Set(['subject', 'text', 'brand_ui', 'decoration_prop', 'effect', 'background']);
export const TARGETED_ADAPTER = 'imvia-poster-layering-workbench-targeted-v1';
const COMPOSITING_MODES = new Set(['Normal', 'Screen', 'Add', 'Multiply']);
const KEY_COLORS = new Set(['#00FF00', '#000000']);
const TEXTUAL_TITLE_ROLES = new Set(['headline', 'title']);

const REQUIRED_LAYER_FIELDS = [
  'layer_index', 'layer_name', 'asset_role', 'layer_type', 'z_order', 'position',
  'visible_content', 'included_content', 'excluded_content', 'occludes', 'occluded_by',
  'source_evidence', 'support_components', 'ui_independence', 'repair_envelope',
  'locked_visible_anchors', 'completion_required', 'completion_regions', 'risk_level',
  'processing_mode', 'fill_color', 'compositing_mode', 'separation_reason',
];

const SKILL_CONTRACT = Object.freeze({
  base: 'lovart-poster-layering-v3-1',
  adapter: 'imvia-poster-layering-workbench-v1',
  auto_retry: false,
  full_canvas: true,
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestCanonicalJson(value) {
  const input = typeof value === 'string' ? value : canonicalJson(value);
  let first = 0x811c9dc5; let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    first = Math.imul(first ^ input.charCodeAt(index), 16777619);
    second = Math.imul(second ^ input.charCodeAt(index), 2246822519);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function cloneJsonValue(value, seen = new WeakSet()) {
  if (value === undefined) throw new TypeError('Poster plans must contain JSON-safe values');
  if (value === null) return value;
  if (typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
      || (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))) {
      throw new TypeError('Poster plans must contain JSON-safe values');
    }
    return value;
  }
  if (seen.has(value)) throw new TypeError('Poster plans cannot contain circular values');
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Poster plans must contain JSON-safe values');
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Poster plans must contain JSON-safe values');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError('Poster plans cannot contain sparse arrays');
      copy[index] = cloneJsonValue(value[index], seen);
    }
    for (const key of Object.keys(value)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        throw new TypeError('Poster plans must contain JSON-safe values');
      }
    }
    seen.delete(value);
    return copy;
  }
  const ownNames = Object.getOwnPropertyNames(value);
  if (ownNames.some((key) => !Object.prototype.propertyIsEnumerable.call(value, key))) {
    throw new TypeError('Poster plans must contain JSON-safe values');
  }
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      configurable: true, enumerable: true, writable: true, value: cloneJsonValue(item, seen),
    });
  }
  seen.delete(value);
  return copy;
}

function addError(errors, path, code, message) {
  errors.push({ path, code, message });
}

function requiredField(value, path, errors) {
  if (value === undefined || value === null) {
    addError(errors, path, 'REQUIRED_FIELD', `${path} is required`);
    return false;
  }
  return true;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateEnum(value, values, path, errors) {
  if (!values.has(value)) addError(errors, path, 'INVALID_ENUM', `${path} has an unsupported value`);
}

function validateArray(value, path, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    addError(errors, path, 'INVALID_TYPE', `${path} must be an array`);
  } else if (nonEmpty && value.length === 0) {
    addError(errors, path, 'EMPTY_ARRAY', `${path} must contain at least one item`);
  }
}

function validateSource(source, errors) {
  if (!isRecord(source)) {
    addError(errors, 'source', 'INVALID_TYPE', 'source must be an object');
    return;
  }
  for (const key of ['path', 'width', 'height', 'aspect_ratio', 'target_2x']) {
    if (!requiredField(source[key], `source.${key}`, errors)) continue;
    if (key === 'path' && (typeof source[key] !== 'string' || source[key].length === 0)) {
      addError(errors, 'source.path', 'INVALID_TYPE', 'source.path must be a non-empty string');
    }
    if (key === 'width' || key === 'height') {
      if (!Number.isInteger(source[key]) || source[key] < 1
        || source[key] > MAX_CANVAS_DIMENSION) {
        addError(errors, 'source', 'SOURCE_DIMENSIONS_INVALID',
          `source.${key} must be an integer between 1 and ${MAX_CANVAS_DIMENSION}`);
      }
    }
    if (key === 'aspect_ratio' && (!finiteNumber(source[key]) || source[key] <= 0)) {
      addError(errors, 'source.aspect_ratio', 'SOURCE_DIMENSIONS_INVALID',
        'source.aspect_ratio must be a positive finite number');
    }
    if (key === 'target_2x' && typeof source[key] !== 'boolean') {
      addError(errors, 'source.target_2x', 'INVALID_TYPE', 'source.target_2x must be boolean');
    }
  }
  if (Number.isInteger(source.width) && Number.isInteger(source.height)
    && source.width > 0 && source.height > 0
    && source.width * source.height > MAX_CANVAS_PIXELS) {
    addError(errors, 'source', 'SOURCE_DIMENSIONS_INVALID', 'source canvas has too many pixels');
  }
  if (finiteNumber(source.width) && finiteNumber(source.height)
    && source.width > 0 && source.height > 0 && finiteNumber(source.aspect_ratio)
    && Math.abs(source.aspect_ratio - source.width / source.height) > 0.0001) {
    addError(errors, 'source.aspect_ratio', 'SOURCE_DIMENSIONS_INVALID',
      'source.aspect_ratio must match source width and height');
  }
}

function validateEvidence(value, path, errors) {
  validateArray(value, path, errors, { nonEmpty: true });
  if (!Array.isArray(value)) return;
  value.forEach((evidence, index) => {
    const evidencePath = `${path}[${index}]`;
    if (!isRecord(evidence)) {
      addError(errors, evidencePath, 'INVALID_TYPE', `${evidencePath} must be an object`);
      return;
    }
    if (typeof evidence.description !== 'string' || evidence.description.length === 0) {
      addError(errors, `${evidencePath}.description`, 'REQUIRED_FIELD',
        `${evidencePath}.description is required`);
    }
    if (evidence.region !== undefined) {
      const region = evidence.region;
      const validArray = Array.isArray(region) && region.length === 4
        && region.every((item) => finiteNumber(item) && item >= 0 && item <= 1);
      const validObject = isRecord(region)
        && ['x', 'y', 'width', 'height'].every((key) => finiteNumber(region[key]));
      if (!validArray && !validObject) {
        addError(errors, `${evidencePath}.region`, 'INVALID_REGION',
          `${evidencePath}.region must describe a finite region`);
      }
    }
  });
}

function validateRepairEnvelope(value, path, errors) {
  if (!isRecord(value)) {
    addError(errors, path, 'INVALID_TYPE', `${path} must be an object`);
    return;
  }
  for (const key of ['description', 'covered_segment', 'seam_band', 'forbidden_regions']) {
    if (!requiredField(value[key], `${path}.${key}`, errors)) continue;
    if (key === 'description' || key === 'seam_band') {
      if (typeof value[key] !== 'string') addError(errors, `${path}.${key}`, 'INVALID_TYPE',
        `${path}.${key} must be a string`);
    } else if (!Array.isArray(value[key])) {
      addError(errors, `${path}.${key}`, 'INVALID_TYPE', `${path}.${key} must be an array`);
    }
  }
}

function containsIndependentUi(content) {
  return content.some((value) => typeof value === 'string' && /date|cta|badge|logo|price|label|ribbon|icon|角标|日期|价格|图标|按钮/i.test(value));
}

function validateLayer(layer, index, errors, {
  fast = false, planVersion, planJobId, planProjectId, planImageId, planSource,
} = {}) {
  const path = `layers[${index}]`;
  if (!isRecord(layer)) {
    addError(errors, path, 'INVALID_TYPE', `${path} must be an object`);
    return;
  }
  for (const field of REQUIRED_LAYER_FIELDS) {
    if (!requiredField(layer[field], `${path}.${field}`, errors)) continue;
    if (['visible_content', 'included_content', 'excluded_content', 'occludes', 'occluded_by',
      'support_components', 'locked_visible_anchors', 'completion_regions'].includes(field)) {
      validateArray(layer[field], `${path}.${field}`, errors);
    }
  }
  if (layer.layer_index !== undefined && layer.layer_index !== null
    && (Number.isInteger(layer.layer_index) === false || layer.layer_index < 1)) {
    addError(errors, `${path}.layer_index`, 'LAYER_INDEX_INVALID',
      `${path}.layer_index must be a positive integer`);
  }
  if (layer.layer_name !== undefined && layer.layer_name !== null
    && (typeof layer.layer_name !== 'string' || layer.layer_name.length === 0)) {
    addError(errors, `${path}.layer_name`, 'INVALID_TYPE', `${path}.layer_name must be a non-empty string`);
  }
  if (layer.position !== undefined && layer.position !== null
    && (typeof layer.position !== 'string' || layer.position.length === 0)) {
    addError(errors, `${path}.position`, 'INVALID_TYPE', `${path}.position must be a non-empty string`);
  }
  if (layer.z_order !== undefined && layer.z_order !== null
    && (!Number.isInteger(layer.z_order) || layer.z_order < 1)) {
    addError(errors, `${path}.z_order`, 'Z_ORDER_INVALID', `${path}.z_order must be a positive integer`);
  }
  if (layer.asset_role !== undefined) validateEnum(layer.asset_role, ASSET_ROLES, `${path}.asset_role`, errors);
  if (layer.layer_type !== undefined) validateEnum(layer.layer_type, LAYER_TYPES, `${path}.layer_type`, errors);
  if (layer.ui_independence !== undefined) validateEnum(layer.ui_independence, UI_INDEPENDENCE, `${path}.ui_independence`, errors);
  if (layer.risk_level !== undefined) validateEnum(layer.risk_level, RISK_LEVELS, `${path}.risk_level`, errors);
  if (layer.processing_mode !== undefined) validateEnum(layer.processing_mode, PROCESSING_MODES, `${path}.processing_mode`, errors);
  if (layer.compositing_mode !== undefined) validateEnum(layer.compositing_mode, COMPOSITING_MODES, `${path}.compositing_mode`, errors);
  if (layer.fill_color !== undefined && !KEY_COLORS.has(layer.fill_color)) {
    addError(errors, `${path}.fill_color`, 'INVALID_KEY_COLOR', `${path}.fill_color must be #00FF00 or #000000`);
  }
  if (KEY_COLORS.has(layer.fill_color) && COMPOSITING_MODES.has(layer.compositing_mode)) {
    const expected = ['Screen', 'Add'].includes(layer.compositing_mode) ? '#000000' : '#00FF00';
    if (layer.fill_color !== expected) {
      addError(errors, `${path}.fill_color`, 'KEY_COMPOSITING_MISMATCH',
        `${path}.fill_color is incompatible with ${layer.compositing_mode}`);
    }
  }
  if (layer.completion_required !== undefined && layer.completion_required !== null
    && typeof layer.completion_required !== 'boolean') {
    addError(errors, `${path}.completion_required`, 'INVALID_TYPE', `${path}.completion_required must be boolean`);
  }
  if (layer.source_evidence !== undefined && layer.source_evidence !== null) {
    if (fast && Array.isArray(layer.source_evidence) && layer.source_evidence.length === 0) {
      // Local suggestions cannot claim evidence that has not been user-confirmed.
    } else validateEvidence(layer.source_evidence, `${path}.source_evidence`, errors);
  }
  if (fast) {
    if (layer.processing_category === undefined || layer.processing_category === null) {
      addError(errors, `${path}.processing_category`, 'REQUIRED_FIELD', `${path}.processing_category is required`);
    } else validateEnum(layer.processing_category, PROCESSING_CATEGORIES, `${path}.processing_category`, errors);
    if (!finiteNumber(layer.planning_confidence) || layer.planning_confidence < 0 || layer.planning_confidence > 1) {
      addError(errors, `${path}.planning_confidence`, 'INVALID_TYPE', `${path}.planning_confidence must be between 0 and 1`);
    }
    if (typeof layer.user_confirmed !== 'boolean') {
      addError(errors, `${path}.user_confirmed`, 'REQUIRED_FIELD', `${path}.user_confirmed is required`);
    }
    if (['GENERATION_AUTHORIZED', 'GENERATING', 'CANDIDATE_CREATED'].includes(layer.state)) {
      const snapshot = layer.confirmed_snapshot;
      const snapshotPayload = snapshot && {
        job_id: snapshot.job_id, plan_version: snapshot.plan_version, layer_index: snapshot.layer_index,
        layer: snapshot.layer, source: snapshot.source,
      };
      const lifecycleFields = new Set(['snapshot_id', 'snapshot_user_confirmed', 'snapshot_plan_version', 'confirmed_snapshot', 'state', 'status', 'candidates', 'candidate_versions', 'candidate_history']);
      const currentContent = Object.fromEntries(Object.entries(layer).filter(([key]) => !lifecycleFields.has(key)));
      const validSnapshot = isRecord(snapshot) && isRecord(snapshot.layer)
        && snapshot.snapshot_id === layer.snapshot_id
        && snapshot.user_confirmed === true
        && snapshot.layer_index === layer.layer_index
        && snapshot.plan_version === planVersion
        && snapshot.job_id === planJobId
        && snapshot.project_id === planProjectId
        && snapshot.image_id === planImageId
        && canonicalJson(snapshot.source) === canonicalJson(planSource)
        && canonicalJson(snapshot.layer) === canonicalJson(currentContent)
        && digestCanonicalJson(snapshotPayload) === snapshot.snapshot_id;
      if (!validSnapshot) {
        addError(errors, `${path}.snapshot_id`, 'SNAPSHOT_REQUIRED', `${path}.snapshot_id must reference a confirmed immutable snapshot before targeted generation`);
      }
      if (layer.snapshot_plan_version !== undefined && layer.snapshot_plan_version !== planVersion) {
        addError(errors, `${path}.snapshot_plan_version`, 'SNAPSHOT_VERSION_MISMATCH', `${path}.snapshot_plan_version must match plan_version`);
      }
    }
  }
  if (layer.repair_envelope !== undefined && layer.repair_envelope !== null) {
    validateRepairEnvelope(layer.repair_envelope, `${path}.repair_envelope`, errors);
  }
  const ownershipContent = [
    ...(Array.isArray(layer.visible_content) ? layer.visible_content : []),
    ...(Array.isArray(layer.included_content) ? layer.included_content : []),
    ...(Array.isArray(layer.support_components) ? layer.support_components : []),
  ];
  if (TEXTUAL_TITLE_ROLES.has(layer.asset_role)
    && (layer.ui_independence === 'independent' || containsIndependentUi(ownershipContent))) {
    addError(errors, path, 'UI_BUNDLING_ERROR', 'independent UI must remain separate from a headline');
  }
}

function invalidateCandidate(candidate, nextVersion) {
  if (!isRecord(candidate) || candidate.status === 'ACCEPTED' || candidate.accepted === true) return candidate;
  const candidateVersion = candidate.plan_version ?? candidate.planVersion;
  if (candidateVersion !== undefined && Number(candidateVersion) >= nextVersion) return candidate;
  return {
    ...candidate,
    status: 'INVALID',
    valid: false,
    invalidated: true,
    invalidated_plan_version: nextVersion,
  };
}

function invalidateCandidatesInLayer(layer, nextVersion) {
  const result = { ...layer };
  for (const key of ['candidates', 'candidate_versions', 'candidate_history']) {
    if (Array.isArray(result[key])) result[key] = result[key].map((candidate) => invalidateCandidate(candidate, nextVersion));
  }
  return result;
}

function invalidateCandidatesInPlan(plan, nextVersion) {
  const result = { ...plan };
  for (const key of ['candidates', 'candidate_versions', 'candidate_history']) {
    if (Array.isArray(result[key])) result[key] = result[key].map((candidate) => invalidateCandidate(candidate, nextVersion));
  }
  if (Array.isArray(result.layers)) {
    result.layers = result.layers.map((layer) => invalidateCandidatesInLayer(layer, nextVersion));
  }
  return result;
}

export function createPosterPlan(input = {}) {
  const copy = cloneJsonValue(input);
  const plan = isRecord(copy) ? copy : {};
  return {
    ...plan,
    version: Object.hasOwn(plan, 'version') ? plan.version : POSTER_PLAN_VERSION,
    task: Object.hasOwn(plan, 'task') ? plan.task : 'poster_layering',
    document_mode: Object.hasOwn(plan, 'document_mode') ? plan.document_mode : 'poster',
    status: plan.status ?? 'PLAN_REVIEW',
    plan_version: Number.isInteger(plan.plan_version) && plan.plan_version > 0 ? plan.plan_version : 1,
    skill_contract: { ...SKILL_CONTRACT, ...(isRecord(plan.skill_contract) ? plan.skill_contract : {}) },
    layers: Array.isArray(plan.layers) ? plan.layers : [],
  };
}

export function validatePosterPlan(plan) {
  const errors = [];
  if (!isRecord(plan)) return { valid: false, errors: [{ path: '', code: 'INVALID_TYPE', message: 'plan must be an object' }] };
  if (plan.version !== POSTER_PLAN_VERSION) addError(errors, 'version', 'VERSION_UNSUPPORTED', 'unsupported poster plan version');
  if (plan.task !== 'poster_layering') addError(errors, 'task', 'TASK_INVALID', 'task must be poster_layering');
  if (plan.document_mode !== 'poster') addError(errors, 'document_mode', 'DOCUMENT_MODE_INVALID', 'document_mode must be poster');
  if (!PLAN_STATUSES.has(plan.status)) addError(errors, 'status', 'INVALID_ENUM', 'status has an unsupported value');
  if (!Number.isInteger(plan.plan_version) || plan.plan_version < 1) addError(errors, 'plan_version', 'VERSION_INVALID', 'plan_version must be a positive integer');
  const fast = plan.planning_mode === 'targeted_fast';
  if (plan.planning_mode !== undefined) validateEnum(plan.planning_mode, PLANNING_MODES, 'planning_mode', errors);
  if (plan.planning_origin !== undefined) validateEnum(plan.planning_origin, PLANNING_ORIGINS, 'planning_origin', errors);
  if (fast) {
    if (plan.planning_origin !== 'workbench_local_suggestion') addError(errors, 'planning_origin', 'PLANNING_ORIGIN_INVALID', 'targeted_fast plans must originate from workbench_local_suggestion');
    if (plan.display_language !== 'zh-CN') addError(errors, 'display_language', 'DISPLAY_LANGUAGE_INVALID', 'targeted_fast plans must use zh-CN');
  }
  for (const field of ['job_id', 'project_id', 'image_id', 'output_directory']) {
    if (!requiredField(plan[field], field, errors)) continue;
    if (typeof plan[field] !== 'string' || plan[field].length === 0) addError(errors, field, 'INVALID_TYPE', `${field} must be a non-empty string`);
  }
  validateSource(plan.source, errors);
  if (!isRecord(plan.skill_contract)) {
    addError(errors, 'skill_contract', 'INVALID_TYPE', 'skill_contract must be an object');
  } else {
    for (const [key, expected] of Object.entries(SKILL_CONTRACT)) {
      const accepted = key === 'adapter' && fast ? new Set([expected, TARGETED_ADAPTER]) : new Set([expected]);
      if (!accepted.has(plan.skill_contract[key])) addError(errors, `skill_contract.${key}`, 'SKILL_CONTRACT_INVALID', `skill_contract.${key} must be ${String(expected)}`);
    }
  }
  if (!Array.isArray(plan.layers)) {
    addError(errors, 'layers', 'INVALID_TYPE', 'layers must be an array');
  } else {
    if (plan.layers.length === 0 && plan.status !== 'ANALYZING') {
      addError(errors, 'layers', 'EMPTY_ARRAY', 'layers must contain at least one item');
    }
      plan.layers.forEach((layer, index) => validateLayer(layer, index, errors, {
        fast, planVersion: plan.plan_version, planJobId: plan.job_id, planProjectId: plan.project_id,
        planImageId: plan.image_id, planSource: plan.source,
      }));
    const indexPositions = new Map();
    for (const [index, layer] of plan.layers.entries()) {
      if (!Number.isInteger(layer?.layer_index) || layer.layer_index < 1) continue;
      if (indexPositions.has(layer.layer_index)) {
        addError(errors, `layers[${index}].layer_index`, 'LAYER_INDEX_DUPLICATE', 'layer_index must be unique');
      } else indexPositions.set(layer.layer_index, index);
    }
    const ordered = plan.layers
      .map((layer, index) => ({ layer, index }))
      .filter(({ layer }) => Number.isInteger(layer?.layer_index) && Number.isInteger(layer?.z_order))
      .sort((left, right) => left.layer.layer_index - right.layer.layer_index);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].layer.z_order <= ordered[index - 1].layer.z_order) {
        addError(errors, `layers[${ordered[index].index}].z_order`, 'Z_ORDER_INVALID', 'z_order must increase from front to back');
      }
    }
    if (indexPositions.size !== ordered.length) {
      addError(errors, 'layers', 'Z_ORDER_INVALID', 'z_order cannot be ordered with duplicate layer indexes');
    }
  }
  return { valid: errors.length === 0, errors };
}

export function updatePosterLayer(plan, layerIndex, patch = {}) {
  const copy = cloneJsonValue(plan);
  if (!isRecord(copy) || !Array.isArray(copy.layers)) throw new TypeError('plan must contain layers');
  const target = copy.layers.findIndex((layer) => layer?.layer_index === layerIndex);
  if (target === -1) throw new RangeError(`Unknown poster layer: ${layerIndex}`);
  if (!isRecord(patch)) throw new TypeError('layer patch must be an object');
  const next = { ...copy, layers: copy.layers.map((layer, index) => index === target ? { ...layer, ...cloneJsonValue(patch) } : layer) };
  if (copy.status === 'PLAN_CONFIRMED') {
    next.status = 'PLAN_REVIEW';
    next.plan_version = (Number.isInteger(copy.plan_version) ? copy.plan_version : 1) + 1;
    return invalidateCandidatesInPlan(next, next.plan_version);
  }
  return next;
}

export class PosterPlanValidationError extends Error {
  constructor(errors) {
    super('Poster plan validation failed');
    this.name = 'PosterPlanValidationError';
    this.errors = errors;
  }
}

function validateConfirmedAt(confirmedAt) {
  if (typeof confirmedAt !== 'string' || confirmedAt.length === 0) {
    throw new TypeError('confirmedAt must be a canonical ISO timestamp string');
  }
  const parsed = Date.parse(confirmedAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== confirmedAt) {
    throw new TypeError('confirmedAt must be a canonical ISO timestamp string');
  }
  return confirmedAt;
}

export function confirmPosterPlan(plan, confirmedAt = new Date().toISOString()) {
  const copy = cloneJsonValue(plan);
  const validation = validatePosterPlan(copy);
  if (!validation.valid) throw new PosterPlanValidationError(validation.errors);
  const timestamp = validateConfirmedAt(confirmedAt);
  const nextVersion = Number(copy.plan_version || 0) + 1;
  const next = invalidateCandidatesInPlan(copy, nextVersion);
  return {
    ...next,
    status: 'PLAN_CONFIRMED',
    plan_version: nextVersion,
    confirmed_at: timestamp,
  };
}
