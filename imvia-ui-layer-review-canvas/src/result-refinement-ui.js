import { buildResultRefinementPlan } from './result-refinement.js';
import { refinementSummary } from './result-refinement-policy.js';

export function createResultRefinementUiState() {
  return {
    tool: 'background',
    prompt: '',
    paths: [],
    draft: null,
    selection: null,
    feedbackToken: null,
    operation: {
      mode: 'path_scoped',
      subject_path_ids: [],
      alpha_include_path_ids: [],
    },
  };
}

function operationAfterPathChange(operation, paths) {
  const pathIds = new Set(paths.map((path) => path.id));
  const subjectPathIds = operation.subject_path_ids.filter((id) => pathIds.has(id));
  const alphaIncludePathIds = operation.alpha_include_path_ids.filter((id) => pathIds.has(id));
  return {
    mode: operation.mode === 'keep_inside_delete_outside' && subjectPathIds.length === 0
      ? 'path_scoped'
      : operation.mode,
    subject_path_ids: subjectPathIds,
    alpha_include_path_ids: alphaIncludePathIds,
  };
}

export function reduceResultRefinementUi(state, action) {
  if (action.type === 'reset') return createResultRefinementUiState();
  if (action.type === 'set-prompt') return { ...state, prompt: action.prompt };
  if (action.type === 'select-tool') {
    return { ...state, tool: action.tool, draft: null };
  }
  if (action.type === 'cancel-draft') return { ...state, draft: null };
  if (action.type === 'editor-change') {
    return {
      ...state,
      paths: action.paths,
      draft: action.draft,
      selection: action.selection,
      feedbackToken: action.feedbackToken,
      operation: operationAfterPathChange(state.operation, action.paths),
    };
  }
  if (action.type === 'toggle-path-role') {
    const { field, pathId } = action;
    const addingRole = !state.operation[field].includes(pathId);
    const nextPathIds = addingRole
      ? [...state.operation[field], pathId]
      : state.operation[field].filter((id) => id !== pathId);
    const subjectPathIds = field === 'subject_path_ids'
      ? nextPathIds
      : state.operation.subject_path_ids;
    return {
      ...state,
      operation: {
        ...state.operation,
        mode: state.operation.mode === 'keep_inside_delete_outside' && subjectPathIds.length === 0
          ? 'path_scoped'
          : state.operation.mode,
        subject_path_ids: subjectPathIds,
        alpha_include_path_ids: field === 'alpha_include_path_ids'
          ? nextPathIds
          : addingRole
            ? state.operation.alpha_include_path_ids.filter((id) => id !== pathId)
            : state.operation.alpha_include_path_ids,
      },
    };
  }
  if (action.type === 'select-mode') {
    return { ...state, operation: { ...state.operation, mode: action.mode } };
  }
  if (action.type === 'clear-paths') {
    return {
      ...state,
      paths: [],
      draft: null,
      selection: null,
      feedbackToken: null,
      operation: createResultRefinementUiState().operation,
    };
  }
  return state;
}

export function resultRefinementGeometry({ pngSize, placement }) {
  const width = Number(pngSize?.width);
  const height = Number(pngSize?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('无法读取拆分结果 PNG 尺寸');
  }
  return {
    canvas: { width, height },
    aspect: width / height,
    placement: { ...placement },
  };
}

export function resultRefinementBaseKey({ imageId, result }) {
  if (!imageId || !result?.job?.id || !result?.image) return '';
  const version = result.image.versionId || result.image.version_id || result.image.url;
  return `${imageId}:${result.job.id}:${version}`;
}

export async function coordinateResultRefinementSubmission({
  prompt,
  paths,
  operation,
  policy,
  basePng,
  placement,
  baseResult,
  layer,
  project,
  confirmFullCanvas,
  submitPlan,
}) {
  if (operation.mode === 'full_canvas_explicit' && !await confirmFullCanvas()) {
    return { cancelled: true };
  }
  const refinementSnapshot = {
    prompt: String(prompt || '').trim(),
    paths: structuredClone(paths),
    operation: structuredClone(operation),
    summary: refinementSummary(policy),
  };
  const payload = buildResultRefinementPlan({
    pngSize: basePng.pngSize,
    placement,
    prompt: refinementSnapshot.prompt,
    paths: refinementSnapshot.paths,
    operation: refinementSnapshot.operation,
    baseResult: {
      ...baseResult,
      dataUrl: basePng.dataUrl,
    },
    layer,
    project,
  });
  const delivery = await submitPlan(payload);
  return {
    cancelled: false,
    delivery,
    payload,
    refinementSnapshot,
  };
}
