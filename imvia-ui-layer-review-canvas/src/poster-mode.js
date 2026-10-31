export function normalizeDocumentMode(value) {
  return value === 'poster' ? 'poster' : 'ui';
}

export function canChangeDocumentMode({ currentMode, nextMode, hasModeState, posterLayeringEnabled = true }) {
  const current = normalizeDocumentMode(currentMode);
  const next = normalizeDocumentMode(nextMode);
  if (!posterLayeringEnabled && current !== 'poster' && next === 'poster') return false;
  return current === next || !hasModeState;
}
