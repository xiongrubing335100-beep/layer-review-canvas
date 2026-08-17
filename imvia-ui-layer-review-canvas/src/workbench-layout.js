export function resolvePanelVisibility({
  reviewMode,
  hasSource,
  hasSelectedLayer,
  hasCanvasInspectorSelection,
  isLeftOpen,
  isRightOpen,
}) {
  if (reviewMode === 'canvas') {
    return {
      left: Boolean(isLeftOpen),
      right: Boolean(hasCanvasInspectorSelection),
    };
  }
  return {
    left: Boolean(hasSource && isLeftOpen),
    right: Boolean(hasSource && hasSelectedLayer && isRightOpen),
  };
}
