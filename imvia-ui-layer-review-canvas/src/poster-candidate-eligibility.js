const CHECK_KEYS = Object.freeze([
  'source_comparison', 'locked_anchors', 'repair_envelope', 'canvas_dimensions', 'key_field',
]);
const SHA256 = /^[a-f0-9]{64}$/u;

function valueAt(value, ...keys) {
  for (const key of keys) if (value?.[key] !== undefined) return value[key];
  return undefined;
}

function sameEmptyFailures(value) {
  const failures = valueAt(value, 'failureCodes', 'failure_codes');
  return Array.isArray(failures) && failures.length === 0;
}

function exactPassingChecks(checks) {
  return checks !== null && typeof checks === 'object' && !Array.isArray(checks)
    && Object.keys(checks).length === CHECK_KEYS.length
    && CHECK_KEYS.every((key) => checks[key] === true);
}

function invalid(reason) { return { eligible: false, reason }; }

/**
 * The client and persistence layer share this fail-closed mirror of the Task7
 * acceptance binding.  It deliberately accepts only the exact candidate that
 * was inspected and gated for the current confirmed plan.
 */
export function posterCandidateEligibility({ plan, layer, candidate } = {}) {
  if (plan?.status !== 'PLAN_CONFIRMED' || !Number.isInteger(plan.plan_version)) return invalid('PLAN_NOT_CONFIRMED');
  if (!layer || !candidate) return invalid('CANDIDATE_MISSING');
  if (layer.status !== 'NEEDS_USER_REVIEW' || candidate.status !== 'NEEDS_USER_REVIEW') return invalid('REVIEW_STATE_MISMATCH');
  const candidateId = valueAt(candidate, 'candidate_id', 'candidateId');
  const candidatePath = valueAt(candidate, 'path', 'candidate_path', 'candidatePath');
  const candidateNumber = valueAt(candidate, 'candidate_number', 'candidateNumber');
  const candidatePlanVersion = valueAt(candidate, 'plan_version', 'planVersion');
  const candidateSha = valueAt(candidate, 'candidate_sha256', 'candidateSha256');
  if (typeof candidateId !== 'string' || !candidateId || typeof candidatePath !== 'string' || !candidatePath
    || !Number.isInteger(candidateNumber) || candidateNumber < 1 || !SHA256.test(candidateSha || '')) {
    return invalid('CANDIDATE_BINDING_INVALID');
  }
  if (candidate.layer_index !== layer.layer_index || candidatePlanVersion !== plan.plan_version
    || layer.candidate_output !== candidatePath || layer.generation_count !== candidateNumber) {
    return invalid('CANDIDATE_BINDING_MISMATCH');
  }
  const inspection = valueAt(layer, 'visual_inspection', 'visualInspection');
  if (inspection?.performed !== true || inspection.verdict !== 'NEEDS_USER_REVIEW'
    || !sameEmptyFailures(inspection)
    || valueAt(inspection, 'candidate_id', 'candidateId') !== candidateId
    || valueAt(inspection, 'plan_version', 'planVersion') !== plan.plan_version
    || valueAt(inspection, 'candidate_sha256', 'candidateSha256') !== candidateSha) {
    return invalid('INSPECTION_BINDING_MISMATCH');
  }
  const gate = valueAt(candidate, 'release_gate', 'releaseGate');
  if (gate?.verdict !== 'NEEDS_USER_REVIEW' || !sameEmptyFailures(gate) || !exactPassingChecks(gate.checks)
    || valueAt(gate, 'candidate_id', 'candidateId') !== candidateId
    || valueAt(gate, 'plan_version', 'planVersion') !== plan.plan_version
    || valueAt(gate, 'candidate_sha256', 'candidateSha256') !== candidateSha) {
    return invalid('RELEASE_GATE_MISMATCH');
  }
  if (!sameEmptyFailures(candidate)) return invalid('CANDIDATE_FAILURE');
  return { eligible: true, reason: null };
}
