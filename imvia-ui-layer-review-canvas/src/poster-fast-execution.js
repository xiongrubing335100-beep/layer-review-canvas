const STAGE_ORDER = Object.freeze([
  'imagegen', 'rmbg', 'canvas_mapping', 'finalizing', 'review_ready',
]);

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function timestamp(value, label) {
  requiredString(value, label);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an ISO timestamp`);
  return value;
}

function stageIndex(stage) {
  const index = STAGE_ORDER.indexOf(stage);
  if (index < 0) throw new RangeError(`unknown poster fast stage: ${stage}`);
  return index;
}

function initialStage(status = 'pending') {
  return { status, started_at: null, completed_at: null };
}

export function createPosterFastExecution({
  dispatchId, authorizationId, removeBackground = true, startedAt = new Date().toISOString(),
} = {}) {
  const start = timestamp(startedAt, 'startedAt');
  return {
    dispatch_id: requiredString(dispatchId, 'dispatchId'),
    authorization_id: requiredString(authorizationId, 'authorizationId'),
    status: 'running',
    current_stage: 'imagegen',
    started_at: start,
    completed_at: null,
    failure_stage: null,
    recoverability: null,
    raw_candidate_available: false,
    stages: {
      imagegen: { status: 'running', started_at: start, completed_at: null },
      rmbg: initialStage(removeBackground ? 'pending' : 'skipped'),
      canvas_mapping: initialStage(),
      finalizing: initialStage(),
      review_ready: initialStage(),
    },
  };
}

export function advancePosterFastExecution(execution, nextStage, at = new Date().toISOString()) {
  if (!execution || execution.status !== 'running') throw new Error('poster fast execution is not running');
  const nextIndex = stageIndex(nextStage);
  const currentIndex = stageIndex(execution.current_stage);
  if (nextIndex < currentIndex) throw new Error('poster fast execution cannot move backward');
  const moment = timestamp(at, 'at');
  if (Date.parse(moment) < Date.parse(execution.started_at)) throw new Error('poster fast execution timestamp moved backward');
  const stages = Object.fromEntries(STAGE_ORDER.map((stage, index) => {
    const current = execution.stages?.[stage] || initialStage();
    if (current.status === 'skipped') return [stage, current];
    if (index < nextIndex) return [stage, {
      ...current,
      status: 'completed',
      started_at: current.started_at || execution.started_at,
      completed_at: current.completed_at || moment,
    }];
    if (index === nextIndex) return [stage, nextStage === 'review_ready' ? {
      ...current, status: 'completed', started_at: current.started_at || moment, completed_at: moment,
    } : {
      ...current, status: 'running', started_at: current.started_at || moment, completed_at: null,
    }];
    return [stage, current];
  }));
  const completed = nextStage === 'review_ready';
  return {
    ...execution,
    status: completed ? 'completed' : 'running',
    current_stage: nextStage,
    completed_at: completed ? moment : null,
    stages,
  };
}

export function failPosterFastExecution(execution, failureStage, at = new Date().toISOString()) {
  if (!execution || execution.status !== 'running') throw new Error('poster fast execution is not running');
  stageIndex(failureStage);
  const moment = timestamp(at, 'at');
  const stages = {
    ...execution.stages,
    [failureStage]: {
      ...(execution.stages?.[failureStage] || initialStage()),
      status: 'failed',
      started_at: execution.stages?.[failureStage]?.started_at || execution.started_at,
      completed_at: moment,
    },
  };
  const postprocess = failureStage !== 'imagegen';
  return {
    ...execution,
    status: 'failed',
    current_stage: failureStage,
    completed_at: moment,
    failure_stage: failureStage,
    recoverability: postprocess ? 'postprocess_only' : 'regenerate_required',
    raw_candidate_available: postprocess,
    stages,
  };
}

export function resumePosterFastPostprocess(execution, at = new Date().toISOString()) {
  if (!execution || execution.status !== 'failed' || execution.recoverability !== 'postprocess_only') {
    throw new Error('poster fast execution is not recoverable by postprocess');
  }
  if (execution.raw_candidate_available !== true || !execution.raw_candidate_path) {
    throw new Error('poster fast postprocess recovery requires the retained raw PNG');
  }
  const moment = timestamp(at, 'at');
  return {
    ...execution,
    status: 'running',
    current_stage: 'rmbg',
    completed_at: null,
    failure_stage: null,
    recoverability: null,
    stages: {
      ...execution.stages,
      imagegen: { ...execution.stages.imagegen, status: 'completed' },
      rmbg: { status: 'running', started_at: moment, completed_at: null },
      canvas_mapping: initialStage(),
      finalizing: initialStage(),
      review_ready: initialStage(),
    },
  };
}

export const POSTER_FAST_STAGE_ORDER = STAGE_ORDER;
