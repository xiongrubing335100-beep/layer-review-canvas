const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function clone(value) {
  return structuredClone(value);
}

function planLayers(job) {
  return Array.isArray(job?.plan?.layers) ? job.plan.layers : [];
}

function manifestLayers(job) {
  return Array.isArray(job?.manifest?.layers) ? job.manifest.layers : [];
}

function emptyFailures(value, ...keys) {
  for (const key of keys) {
    if (value?.[key] !== undefined) return Array.isArray(value[key]) && value[key].length === 0;
  }
  return false;
}

function exactReleaseChecks(checks) {
  const keys = ['source_comparison', 'locked_anchors', 'repair_envelope', 'canvas_dimensions', 'key_field'];
  return checks !== null && typeof checks === 'object' && !Array.isArray(checks)
    && Object.keys(checks).length === keys.length && keys.every((key) => checks[key] === true);
}

function exactAcceptedCandidate(job, state, layerIndex) {
  const candidateId = state?.accepted_candidate_id;
  const candidates = Array.isArray(job?.manifest?.candidates) ? job.manifest.candidates : [];
  if (typeof candidateId !== 'string' || candidateId.length === 0) return null;
  const matches = candidates.filter((candidate) => candidate?.candidate_id === candidateId);
  if (matches.length !== 1) return null;
  const candidate = matches[0];
  const candidateDigest = candidate.candidate_sha256;
  const inspection = state.visual_inspection;
  const gate = candidate.release_gate;
  if (candidate.layer_index !== layerIndex || candidate.plan_version !== job.plan.plan_version
    || candidate.status !== 'NEEDS_USER_REVIEW' || candidate.accepted !== true
    || candidate.path !== state.candidate_output || state.generation_count !== candidate.candidate_number
    || !SHA256_PATTERN.test(candidateDigest || '') || !emptyFailures(candidate, 'failure_codes', 'failureCodes')
    || inspection?.performed !== true || inspection.verdict !== 'NEEDS_USER_REVIEW'
    || !emptyFailures(inspection, 'failure_codes', 'failureCodes')
    || inspection.candidate_id !== candidateId || inspection.plan_version !== job.plan.plan_version
    || inspection.candidate_sha256 !== candidateDigest
    || gate?.verdict !== 'NEEDS_USER_REVIEW' || !emptyFailures(gate, 'failureCodes', 'failure_codes')
    || !exactReleaseChecks(gate.checks) || gate.candidateId !== candidateId
    || gate.planVersion !== job.plan.plan_version || gate.candidateSha256 !== candidateDigest
    || candidate.accepted_source_output !== state.source_output
    || candidate.accepted_source_sha256 !== state.source_sha256) return null;
  return { candidateId, candidateDigest };
}

function acceptedBinding(job) {
  if (job?.plan?.status !== 'PLAN_CONFIRMED' || !Number.isInteger(job.plan.plan_version)
    || !Number.isInteger(job?.manifest?.revision)) return null;
  const planned = planLayers(job);
  const states = manifestLayers(job);
  if (planned.length === 0 || states.length !== planned.length) return null;
  let order;
  try {
    order = buildPosterCompositeOrder(job.plan);
  } catch {
    return null;
  }
  const stateByIndex = new Map(states.map((layer) => [layer?.layer_index, layer]));
  if (stateByIndex.size !== states.length || order.some((index) => !stateByIndex.has(index))) return null;
  const acceptedLayers = [];
  for (const layerIndex of order) {
    const state = stateByIndex.get(layerIndex);
    if (state.status !== 'ACCEPTED' || state.accepted_plan_version !== job.plan.plan_version
      || typeof state.source_output !== 'string' || !state.source_output.endsWith('.png')
      || !SHA256_PATTERN.test(state.source_sha256 || '')) return null;
    const exactCandidate = exactAcceptedCandidate(job, state, layerIndex);
    if (!exactCandidate) return null;
    acceptedLayers.push({
      layer_index: layerIndex,
      candidate_id: exactCandidate.candidateId,
      candidate_sha256: exactCandidate.candidateDigest,
      candidate_output: state.candidate_output,
      source_output: state.source_output,
      source_sha256: state.source_sha256,
    });
  }
  return {
    plan_version: job.plan.plan_version,
    manifest_revision: job.manifest.revision,
    composite_order: order,
    accepted_layers: acceptedLayers,
  };
}

export function canRunPosterAudit(job) {
  return acceptedBinding(job) !== null;
}

export function buildPosterCompositeOrder(plan) {
  const layers = Array.isArray(plan?.layers) ? plan.layers : [];
  const indices = layers.map((layer) => layer?.layer_index);
  if (indices.some((index) => !Number.isInteger(index) || index < 1)
    || new Set(indices).size !== indices.length) {
    throw new TypeError('poster layer indices must be unique positive integers');
  }
  if (layers.some((layer) => !Number.isInteger(layer?.z_order) || layer.z_order < 1)) {
    throw new TypeError('poster layer z_order values must be positive integers');
  }
  const frontToBack = [...layers].sort((left, right) => left.layer_index - right.layer_index);
  for (let offset = 1; offset < frontToBack.length; offset += 1) {
    if (frontToBack[offset].z_order <= frontToBack[offset - 1].z_order) {
      throw new TypeError('poster layer z_order must increase from front to back');
    }
  }
  return [...frontToBack]
    .sort((left, right) => right.z_order - left.z_order)
    .map((layer) => layer.layer_index);
}

function reportMatchesBinding(report, binding) {
  const checks = report?.checks;
  const measurements = report?.measurements;
  if (report?.status !== 'passed' || !Array.isArray(report.failure_codes)
    || report.failure_codes.length !== 0
    || !Array.isArray(report.composite_order)
    || !Array.isArray(report.accepted_layers)
    || checks === null || typeof checks !== 'object' || Array.isArray(checks)
    || Object.keys(checks).length === 0 || Object.values(checks).some((value) => value !== true)
    || measurements === null || typeof measurements !== 'object' || Array.isArray(measurements)
    || !SHA256_PATTERN.test(measurements.source_sha256 || '')
    || !Number.isInteger(measurements.total_pixels) || measurements.total_pixels < 1
    || !Number.isFinite(measurements.coverage_ratio)
    || !Number.isFinite(measurements.source_similarity)
    || !Number.isFinite(measurements.mean_absolute_error)
    || measurements.coverage_ratio < 0.999 || measurements.source_similarity < 0.995
    || measurements.mean_absolute_error > 1 || measurements.missing_owned_pixels !== 0
    || measurements.undeclared_overlap_pixels !== 0
    || !Number.isInteger(measurements.mismatch_pixels) || measurements.mismatch_pixels < 0
    || measurements.mismatch_pixels > measurements.total_pixels
    || Math.abs((measurements.total_pixels - measurements.mismatch_pixels)
      / measurements.total_pixels - measurements.source_similarity) > 0.0000005) return false;
  if (report.composite_order.length !== binding.composite_order.length
    || report.composite_order.some((index, offset) => index !== binding.composite_order[offset])
    || report.accepted_layers.length !== binding.accepted_layers.length) return false;
  return report.accepted_layers.every((entry, offset) => (
    entry?.layer_index === binding.accepted_layers[offset].layer_index
    && entry?.candidate_id === binding.accepted_layers[offset].candidate_id
    && entry?.candidate_sha256 === binding.accepted_layers[offset].candidate_sha256
    && entry?.candidate_output === binding.accepted_layers[offset].candidate_output
    && entry?.source_output === binding.accepted_layers[offset].source_output
    && entry?.source_sha256 === binding.accepted_layers[offset].source_sha256
  ));
}

export function recordRecompositionAudit(job, report) {
  const next = clone(job);
  const binding = acceptedBinding(next);
  const matches = binding !== null && reportMatchesBinding(report, binding);
  const audit = {
    ...clone(report || {}),
    status: matches ? 'passed' : 'failed',
    failure_codes: matches
      ? []
      : [...new Set([
        ...(Array.isArray(report?.failure_codes) ? report.failure_codes : []),
        ...(report?.status === 'passed' ? ['AUDIT_BINDING_MISMATCH'] : []),
      ])],
    binding,
  };
  next.report = { ...(next.report || {}), recomposition_audit: audit };
  return next;
}

export function canExportPosterPackage(job) {
  const binding = acceptedBinding(job);
  const audit = job?.report?.recomposition_audit;
  if (!binding || audit?.status !== 'passed' || !Array.isArray(audit.failure_codes)
    || audit.failure_codes.length !== 0) return false;
  return JSON.stringify(audit.binding) === JSON.stringify(binding)
    && reportMatchesBinding(audit, binding);
}

export function posterAuditConflictLayers(job) {
  const audit = job?.report?.recomposition_audit;
  const binding = acceptedBinding(job);
  if (audit?.status !== 'failed' || binding === null
    || JSON.stringify(audit.binding) !== JSON.stringify(binding)) return [];
  const layers = audit.conflict_layers;
  return Array.isArray(layers)
    ? layers.filter((index) => Number.isInteger(index) && index > 0)
    : [];
}

export function posterAuditUiState(job) {
  const audit = job?.report?.recomposition_audit;
  const canAudit = canRunPosterAudit(job);
  const canExport = canExportPosterPackage(job);
  const currentBinding = acceptedBinding(job);
  const auditFresh = currentBinding !== null
    && JSON.stringify(audit?.binding) === JSON.stringify(currentBinding);
  let status = 'waiting';
  if (canExport) status = 'passed';
  else if (audit?.status === 'failed' && auditFresh) status = 'failed';
  else if (audit?.status === 'passed' || audit?.status === 'failed') status = 'stale';
  else if (canAudit) status = 'ready';
  const freshFailure = status === 'failed';
  return {
    status,
    canAudit,
    canExport,
    conflictLayers: posterAuditConflictLayers(job),
    failureCodes: freshFailure && Array.isArray(audit?.failure_codes)
      ? audit.failure_codes.filter((code) => typeof code === 'string')
      : [],
  };
}
