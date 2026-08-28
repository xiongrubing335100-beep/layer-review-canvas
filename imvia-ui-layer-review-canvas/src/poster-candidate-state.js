const LEGAL_TRANSITIONS = Object.freeze({
  PENDING: ['GENERATION_AUTHORIZED'],
  RETRY_AUTHORIZED: ['GENERATION_STARTED'],
  GENERATION_AUTHORIZED: ['GENERATION_STARTED'],
  GENERATING: ['CANDIDATE_CREATED', 'GENERATION_FAILED'],
  CANDIDATE_CREATED: ['HARD_FAILURE_FOUND', 'REVIEW_READY'],
  NEEDS_USER_REVIEW: ['CANDIDATE_ACCEPTED', 'RETRY_AUTHORIZED'],
  HARD_REJECTED: ['RETRY_AUTHORIZED'],
  ACCEPTED: [],
});

const AUTHORIZED_STATUSES = new Set(['GENERATION_AUTHORIZED', 'RETRY_AUTHORIZED']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function task2Plan(state) {
  if (!isRecord(state)) return undefined;
  for (const key of ['plan', 'posterPlan', 'poster_plan', 'activePlan', 'active_plan']) {
    if (isRecord(state[key])) return state[key];
  }
  return undefined;
}

function activePlanVersion(state) {
  const plan = task2Plan(state);
  if (!plan || plan.status !== 'PLAN_CONFIRMED') return undefined;
  return plan.plan_version;
}

function candidatePlanVersion(state) {
  if (!isRecord(state)) return undefined;
  const candidate = state.candidate;
  return state.candidatePlanVersion ?? state.candidate_plan_version
    ?? candidate?.planVersion ?? candidate?.plan_version;
}

function authorizationPlanVersion(state) {
  return state.authorizationPlanVersion ?? state.authorization_plan_version
    ?? state.authorizedPlanVersion ?? state.authorized_plan_version;
}

function releaseGate(state) {
  if (!isRecord(state)) return undefined;
  const candidate = state.candidate;
  return state.releaseGate ?? state.release_gate ?? state.gate ?? state.releaseGateResult
    ?? candidate?.releaseGate ?? candidate?.release_gate ?? candidate?.gate;
}

function gateCandidateId(gate) {
  if (!isRecord(gate)) return undefined;
  return gate.candidateId ?? gate.candidate_id ?? gate.candidate?.id;
}

function gatePlanVersion(gate) {
  if (!isRecord(gate)) return undefined;
  return gate.planVersion ?? gate.plan_version;
}

function gatePassed(gate) {
  if (!isRecord(gate)) return false;
  const checks = Array.isArray(gate.checks) || isRecord(gate.checks);
  return gate.verdict === 'NEEDS_USER_REVIEW'
    && Array.isArray(gate.failureCodes) && gate.failureCodes.length === 0
    && checks;
}

function validPlanVersion(value) {
  return Number.isInteger(value) && value > 0;
}

function samePlanVersion(left, right) {
  return validPlanVersion(left) && validPlanVersion(right) && left === right;
}

function candidateId(state) {
  return state.candidateId ?? state.candidate_id ?? state.candidate?.candidateId
    ?? state.candidate?.candidate_id ?? state.candidate?.id;
}

function candidatePath(state) {
  return state.candidatePath ?? state.candidate_path ?? state.candidate?.candidatePath
    ?? state.candidate?.candidate_path ?? state.candidate?.path;
}

function gateMatchesCandidate(gate, id, version) {
  const gateId = gateCandidateId(gate);
  const gateVersion = gatePlanVersion(gate);
  return gateId === id && samePlanVersion(gateVersion, version);
}

function gateMatchesEventBinding(gate, id, version) {
  const gateId = gateCandidateId(gate);
  const gateVersion = gatePlanVersion(gate);
  return (gateId === undefined || gateId === id)
    && (gateVersion === undefined || samePlanVersion(gateVersion, version));
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export class PosterCandidateTransitionError extends Error {
  constructor(message, { code = 'ILLEGAL_TRANSITION', from, event } = {}) {
    super(message);
    this.name = 'PosterCandidateTransitionError';
    this.code = code;
    if (from !== undefined) this.from = from;
    if (event !== undefined) this.event = event;
  }
}

function transitionError(state, event, message, code = 'ILLEGAL_TRANSITION') {
  return new PosterCandidateTransitionError(message, { code, from: state.status, event: event.type });
}

function requireActivePlan(state, event) {
  const plan = task2Plan(state);
  if (!plan || plan.status !== 'PLAN_CONFIRMED') {
    throw transitionError(state, event, 'A confirmed Task 2 plan is required', 'PLAN_NOT_CONFIRMED');
  }
  const active = activePlanVersion(state);
  if (!validPlanVersion(active)) {
    throw transitionError(state, event, 'The confirmed plan must have a valid plan_version', 'PLAN_VERSION_REQUIRED');
  }
  return active;
}

function eventPlanVersion(event) {
  const binding = event.binding ?? event.candidateBinding ?? event.candidate_binding;
  return event.planVersion ?? event.plan_version ?? binding?.planVersion ?? binding?.plan_version;
}

function eventCandidateId(event) {
  const binding = event.binding ?? event.candidateBinding ?? event.candidate_binding;
  return event.candidateId ?? event.candidate_id ?? event.candidate?.id
    ?? binding?.candidateId ?? binding?.candidate_id ?? binding?.candidate?.id;
}

function requireMatchingPlan(state, event, value, code = 'PLAN_VERSION_MISMATCH') {
  const active = requireActivePlan(state, event);
  if (!samePlanVersion(value, active)) {
    throw transitionError(state, event, 'Event plan version does not match the active plan', code);
  }
  return active;
}

function assertLegalTransition(state, event) {
  if (!isRecord(state) || !nonEmptyString(state.status)) {
    throw new PosterCandidateTransitionError('A valid layer state is required', {
      code: 'STATE_REQUIRED', event: event?.type,
    });
  }
  if (!isRecord(event) || !nonEmptyString(event.type)) {
    throw transitionError(state, { type: undefined }, 'A valid event is required', 'EVENT_REQUIRED');
  }
  const legal = LEGAL_TRANSITIONS[state.status];
  if (!legal || !legal.includes(event.type)) {
    throw transitionError(state, event,
      `${event.type} is not legal from ${state.status}`);
  }
}

export function canGeneratePosterCandidate(layerState) {
  if (!isRecord(layerState) || !AUTHORIZED_STATUSES.has(layerState.status)) return false;
  const active = activePlanVersion(layerState);
  return samePlanVersion(authorizationPlanVersion(layerState), active);
}

export function canAcceptPosterCandidate(layerState) {
  if (!isRecord(layerState) || layerState.status !== 'NEEDS_USER_REVIEW') return false;
  const id = candidateId(layerState);
  const version = candidatePlanVersion(layerState);
  const gate = releaseGate(layerState);
  if (!nonEmptyString(id) || !nonEmptyString(candidatePath(layerState))) return false;
  return samePlanVersion(version, activePlanVersion(layerState))
    && gatePassed(gate)
    && gateMatchesCandidate(gate, id, version)
    && (!Array.isArray(layerState.failureCodes) || layerState.failureCodes.length === 0)
    && layerState.hardFailure !== true
    && layerState.valid !== false
    && layerState.invalidated !== true;
}

export function reducePosterLayerState(layerState, event) {
  assertLegalTransition(layerState, event);
  const state = { ...layerState };

  switch (event.type) {
    case 'GENERATION_AUTHORIZED': {
      const active = requireMatchingPlan(state, event, eventPlanVersion(event));
      return {
        ...state,
        status: 'GENERATION_AUTHORIZED',
        authorizationPlanVersion: active,
        generationPlanVersion: active,
        authorizationConsumed: false,
      };
    }
    case 'RETRY_AUTHORIZED': {
      const active = requireActivePlan(state, event);
      const requested = eventPlanVersion(event);
      if (requested !== undefined && !samePlanVersion(requested, active)) {
        throw transitionError(state, event, 'Retry plan version does not match the active plan', 'PLAN_VERSION_MISMATCH');
      }
      const history = Array.isArray(state.candidateHistory) ? [...state.candidateHistory] : [];
      const oldId = candidateId(state);
      const oldPath = candidatePath(state);
      const oldVersion = candidatePlanVersion(state);
      const oldGate = releaseGate(state);
      const oldFailureCodes = Array.isArray(state.failureCodes)
        ? [...state.failureCodes]
        : (Array.isArray(state.failure_codes)
          ? [...state.failure_codes]
          : (Array.isArray(state.candidate?.failureCodes) ? [...state.candidate.failureCodes] : []));
      if (oldId || oldPath || oldGate || oldFailureCodes.length > 0) {
        history.push({
          candidateId: oldId,
          candidatePath: oldPath,
          candidatePlanVersion: oldVersion,
          candidate: state.candidate,
          releaseGate: oldGate,
          failureCodes: oldFailureCodes,
          status: state.status,
          error: state.error,
        });
      }
      const next = { ...state };
      for (const key of [
        'candidateId', 'candidate_id', 'candidatePath', 'candidate_path',
        'candidatePlanVersion', 'candidate_plan_version', 'releaseGate', 'release_gate',
        'gate', 'releaseGateResult', 'failureCodes', 'failure_codes', 'candidateGate',
        'candidate_gate', 'candidateFailureCodes', 'candidate_failure_codes', 'hardFailure',
        'error', 'valid', 'invalidated', 'accepted', 'acceptedCandidateId', 'candidate',
      ]) delete next[key];
      if (history.length > 0 || Array.isArray(state.candidateHistory)) next.candidateHistory = history;
      return {
        ...next,
        status: 'RETRY_AUTHORIZED',
        authorizationPlanVersion: active,
        generationPlanVersion: active,
        authorizationConsumed: false,
      };
    }
    case 'GENERATION_STARTED': {
      if (!canGeneratePosterCandidate(state)) {
        throw transitionError(state, event,
          'Generation requires an explicit authorization for the active plan', 'GENERATION_NOT_AUTHORIZED');
      }
      const count = Number.isInteger(state.generationCount) && state.generationCount >= 0
        ? state.generationCount + 1 : 1;
      return {
        ...state,
        status: 'GENERATING',
        generationCount: count,
        authorizationConsumed: true,
      };
    }
    case 'GENERATION_FAILED':
      return {
        ...state,
        status: 'HARD_REJECTED',
        error: nonEmptyString(event.error) ? event.error : 'Generation failed',
        hardFailure: true,
      };
    case 'CANDIDATE_CREATED': {
      const active = requireMatchingPlan(state, event, eventPlanVersion(event));
      if (!nonEmptyString(event.candidateId ?? event.candidate_id ?? event.id)) {
        throw transitionError(state, event, 'Candidate ID is required', 'CANDIDATE_ID_REQUIRED');
      }
      if (!nonEmptyString(event.candidatePath ?? event.candidate_path ?? event.path)) {
        throw transitionError(state, event, 'Candidate path is required', 'CANDIDATE_PATH_REQUIRED');
      }
      if (!samePlanVersion(state.generationPlanVersion, active)) {
        throw transitionError(state, event,
          'Candidate is not bound to the authorized generation plan', 'PLAN_VERSION_MISMATCH');
      }
      const id = event.candidateId ?? event.candidate_id ?? event.id;
      const path = event.candidatePath ?? event.candidate_path ?? event.path;
      return {
        ...state,
        status: 'CANDIDATE_CREATED',
        candidateId: id,
        candidatePath: path,
        candidatePlanVersion: active,
        valid: true,
      };
    }
    case 'HARD_FAILURE_FOUND': {
      const codes = Array.isArray(event.failureCodes)
        ? [...event.failureCodes]
        : (event.failureCode ? [event.failureCode] : []);
      return {
        ...state,
        status: 'HARD_REJECTED',
        failureCodes: codes,
        hardFailure: true,
        error: nonEmptyString(event.error) ? event.error : state.error,
      };
    }
    case 'REVIEW_READY': {
      if (!samePlanVersion(candidatePlanVersion(state), activePlanVersion(state))) {
        throw transitionError(state, event,
          'Candidate cannot enter review without a current plan binding', 'PLAN_VERSION_MISMATCH');
      }
      const gate = event.releaseGate ?? event.release_gate ?? event.gate ?? event.releaseGateResult;
      const id = candidateId(state);
      const version = candidatePlanVersion(state);
      if (!isRecord(gate)) {
        throw transitionError(state, event, 'A release gate record is required before review', 'RELEASE_GATE_REQUIRED');
      }
      if (!gatePassed(gate)) {
        throw transitionError(state, event, 'The release gate did not pass', 'RELEASE_GATE_FAILED');
      }
      if (eventCandidateId(event) !== id || !samePlanVersion(eventPlanVersion(event), version)) {
        throw transitionError(state, event,
          'Review-ready release gate binding is required for the current candidate and plan', 'RELEASE_GATE_BINDING_REQUIRED');
      }
      if (!gateMatchesEventBinding(gate, id, version)) {
        throw transitionError(state, event,
          'The release gate does not match the current candidate and plan', 'RELEASE_GATE_MISMATCH');
      }
      return {
        ...state,
        status: 'NEEDS_USER_REVIEW',
        hardFailure: false,
        releaseGate: { ...gate, candidateId: id, planVersion: version },
      };
    }
    case 'CANDIDATE_ACCEPTED': {
      if (!canAcceptPosterCandidate(state)) {
        throw transitionError(state, event,
          'Only a current candidate in user review can be accepted', 'CANDIDATE_NOT_ACCEPTABLE');
      }
      const requestedId = event.candidateId ?? event.candidate_id;
      if (requestedId !== undefined && requestedId !== candidateId(state)) {
        throw transitionError(state, event, 'Accepted candidate does not match the reviewed candidate', 'CANDIDATE_MISMATCH');
      }
      const requestedVersion = eventPlanVersion(event);
      if (requestedVersion !== undefined && !samePlanVersion(requestedVersion, activePlanVersion(state))) {
        throw transitionError(state, event, 'Accepted candidate plan is stale', 'PLAN_VERSION_MISMATCH');
      }
      return { ...state, status: 'ACCEPTED', accepted: true, acceptedCandidateId: candidateId(state) };
    }
    default:
      throw transitionError(state, event, `${event.type} is not implemented`);
  }
}

function slugify(value) {
  if (!nonEmptyString(value)) throw new TypeError('slug must be a non-empty string');
  const slug = value.trim().toLocaleLowerCase().replace(/\s+/gu, '-');
  if (!slug || slug === '.' || slug === '..' || /[\\/\0\r\n]/u.test(slug)
    || !/^[\p{L}\p{N}_-]+$/u.test(slug)) {
    throw new TypeError('slug contains unsafe characters');
  }
  return slug;
}

export function candidateFileName({ layerIndex, slug, generationCount } = {}) {
  if (!Number.isInteger(layerIndex) || layerIndex < 1) throw new TypeError('layerIndex must be a positive integer');
  if (!Number.isInteger(generationCount) || generationCount < 1) throw new TypeError('generationCount must be a positive integer');
  const safeSlug = slugify(slug);
  return `layer_${layerIndex}_${safeSlug}_candidate-${String(generationCount).padStart(2, '0')}.png`;
}

export { LEGAL_TRANSITIONS };
