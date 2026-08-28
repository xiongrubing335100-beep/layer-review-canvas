const FAILURE_CODE_VALUES = Object.freeze([
  'UNSUPPORTED_GRAPHIC_EFFECT', 'UI_BUNDLING_ERROR', 'VISIBLE_ANCHOR_MUTATION',
  'WHOLE_ASSET_REGENERATION', 'REPAIR_ENVELOPE_EXCEEDED', 'COMPLETION_MISSING',
  'ANATOMY_OR_STRUCTURE_BROKEN', 'TEXT_OR_LOGO_MUTATED', 'BACKGROUND_LAYOUT_DRIFT',
  'OCCLUDER_OWNERSHIP_ERROR', 'EFFECT_CONTINUITY_BROKEN', 'FOREIGN_CONTENT_LEAK',
  'REGISTRATION_UNCERTAIN', 'KEY_UNUSABLE', 'CANVAS_OR_GREEN_FIELD_INVALID',
]);

function immutableSet(values) {
  const result = new Set(values);
  const rejectMutation = () => { throw new TypeError('POSTER_FAILURE_CODES is read-only'); };
  for (const method of ['add', 'delete', 'clear']) {
    Object.defineProperty(result, method, { value: rejectMutation, enumerable: false });
  }
  return Object.freeze(result);
}

export const POSTER_FAILURE_CODES = immutableSet(FAILURE_CODE_VALUES);

const FAILURE_FLAGS = Object.freeze({
  unsupportedGraphicEffect: 'UNSUPPORTED_GRAPHIC_EFFECT',
  uiBundlingError: 'UI_BUNDLING_ERROR',
  visibleAnchorMutation: 'VISIBLE_ANCHOR_MUTATION',
  wholeAssetRegeneration: 'WHOLE_ASSET_REGENERATION',
  repairEnvelopeExceeded: 'REPAIR_ENVELOPE_EXCEEDED',
  completionMissing: 'COMPLETION_MISSING',
  anatomyOrStructureBroken: 'ANATOMY_OR_STRUCTURE_BROKEN',
  textOrLogoMutated: 'TEXT_OR_LOGO_MUTATED',
  backgroundLayoutDrift: 'BACKGROUND_LAYOUT_DRIFT',
  occluderOwnershipError: 'OCCLUDER_OWNERSHIP_ERROR',
  effectContinuityBroken: 'EFFECT_CONTINUITY_BROKEN',
  foreignContentLeak: 'FOREIGN_CONTENT_LEAK',
  registrationUncertain: 'REGISTRATION_UNCERTAIN',
  keyUnusable: 'KEY_UNUSABLE',
  canvasOrGreenFieldInvalid: 'CANVAS_OR_GREEN_FIELD_INVALID',
});

const CHECKS = Object.freeze({
  source_comparison: 'REGISTRATION_UNCERTAIN',
  locked_anchors: 'VISIBLE_ANCHOR_MUTATION',
  repair_envelope: 'REPAIR_ENVELOPE_EXCEEDED',
  canvas_dimensions: 'CANVAS_OR_GREEN_FIELD_INVALID',
  key_field: 'KEY_UNUSABLE',
});
const RELEASE_VERDICTS = new Set(['NEEDS_USER_REVIEW', 'HARD_REJECTED']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function candidateId(candidate) {
  return candidate.candidate_id ?? candidate.candidateId ?? candidate.id;
}

function candidatePlanVersion(candidate) {
  return candidate.plan_version ?? candidate.planVersion;
}

function candidateSha256(candidate) {
  const value = candidate.candidate_sha256 ?? candidate.candidateSha256 ?? candidate.sha256;
  if (value !== undefined && !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError('poster release candidate SHA-256 binding is invalid');
  }
  return value;
}

function declaredFailures(subject) {
  if (!isRecord(subject)) return [];
  const failures = subject.failure_codes ?? subject.failureCodes;
  if (failures === undefined) return [];
  if (!Array.isArray(failures)) throw new TypeError('poster failure codes must be an array');
  for (const code of failures) {
    if (!POSTER_FAILURE_CODES.has(code)) throw new TypeError(`unknown poster failure code: ${String(code)}`);
  }
  return failures;
}

function normalizedChecks(review) {
  const reported = review.checks;
  if (reported === undefined) throw new TypeError(`poster release report is missing checks: ${Object.keys(CHECKS).join(', ')}`);
  if (!isRecord(reported)) throw new TypeError('poster release checks must be an object');
  const reportedKeys = Object.keys(reported);
  const expectedKeys = Object.keys(CHECKS);
  const unexpected = reportedKeys.filter((key) => !expectedKeys.includes(key));
  if (unexpected.length > 0) throw new TypeError(`poster release report has unexpected checks: ${unexpected.join(', ')}`);
  const checks = {};
  for (const key of expectedKeys) {
    if (!(key in reported)) throw new TypeError(`poster release report is missing checks: ${key}`);
    if (typeof reported[key] !== 'boolean') {
      throw new TypeError(`poster release check must be boolean: ${key}`);
    }
    checks[key] = reported[key];
  }
  return checks;
}

export function evaluatePosterRelease({ layer, candidate, review } = {}) {
  if (!isRecord(layer) || !isRecord(candidate) || !isRecord(review)) {
    throw new TypeError('poster release requires layer, candidate, and review records');
  }
  if (!RELEASE_VERDICTS.has(review.verdict)) {
    throw new TypeError(`poster release verdict is invalid: ${String(review.verdict)}`);
  }
  const boundCandidateId = candidateId(candidate);
  const boundPlanVersion = candidatePlanVersion(candidate);
  const boundCandidateSha256 = candidateSha256(candidate);
  if (typeof boundCandidateId !== 'string' || boundCandidateId.length === 0
    || !Number.isInteger(boundPlanVersion) || boundPlanVersion < 1) {
    throw new TypeError('poster release candidate binding is invalid');
  }

  const failures = new Set([
    ...declaredFailures(layer),
    ...declaredFailures(candidate),
    ...declaredFailures(review),
  ]);
  for (const [flag, code] of Object.entries(FAILURE_FLAGS)) {
    const snakeFlag = flag.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if (review[flag] === true || review[snakeFlag] === true || review[code] === true) failures.add(code);
  }

  const checks = normalizedChecks(review);
  for (const [check, code] of Object.entries(CHECKS)) {
    if (checks[check] === false) failures.add(code);
  }
  if (failures.size === 0 && review.verdict === 'HARD_REJECTED') {
    failures.add('CANVAS_OR_GREEN_FIELD_INVALID');
  }

  const failureCodes = FAILURE_CODE_VALUES.filter((code) => failures.has(code));
  return {
    verdict: failureCodes.length > 0 ? 'HARD_REJECTED' : 'NEEDS_USER_REVIEW',
    failureCodes,
    checks,
    candidateId: boundCandidateId,
    planVersion: boundPlanVersion,
    ...(boundCandidateSha256 ? { candidateSha256: boundCandidateSha256 } : {}),
  };
}
