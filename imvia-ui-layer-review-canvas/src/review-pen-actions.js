export function invokePenOverlayCommand(overlay, command) {
  const handler = overlay?.[command];
  if (typeof handler !== 'function') return false;
  handler.call(overlay);
  return true;
}

export function canInvokePenOverlayCommand(overlay, command, { mounted = true } = {}) {
  if (!mounted || !overlay) return false;
  const capability = `can${command.charAt(0).toUpperCase()}${command.slice(1)}`;
  return overlay[capability] === true;
}

export function canDeleteReviewMark({ marks = [], layerId, selectedMarkId } = {}) {
  return Boolean(selectedMarkId && marks.some((mark) => (
    mark.layer_id === layerId && mark.id === selectedMarkId
  )));
}

export function reduceReviewPenParentState(state, action = {}) {
  if (!state || !state.layerId) return state;
  if (action.type === 'cancel-draft') {
    return state.draft || state.feedbackToken
      ? { ...state, draft: null, feedbackToken: null }
      : state;
  }
  if (action.type === 'clear') {
    const hasLayerState = state.marks.some((mark) => mark.layer_id === state.layerId)
      || state.paths.length
      || state.draft;
    if (!hasLayerState) return state;
    return {
      ...state,
      marks: state.marks.filter((mark) => mark.layer_id !== state.layerId),
      paths: [],
      draft: null,
      selection: null,
      feedbackToken: null,
      selectedMarkId: null,
    };
  }
  if (action.type === 'delete-selection') {
    const selected = state.marks.find((mark) => (
      mark.layer_id === state.layerId && mark.id === state.selectedMarkId
    ));
    if (!selected) return state;
    return {
      ...state,
      marks: state.marks.filter((mark) => mark !== selected),
      paths: selected.shape === 'bezier_path'
        ? state.paths.filter((path) => path.id !== selected.id)
        : state.paths,
      selection: selected.shape === 'bezier_path' ? null : state.selection,
      feedbackToken: selected.shape === 'bezier_path' ? null : state.feedbackToken,
      selectedMarkId: null,
    };
  }
  return state;
}
