import { normalizeDocumentMode } from './poster-mode.js';

export function selectPosterMode({ choice, disabled = false, onChange } = {}) {
  if (disabled) return false;
  onChange?.(normalizeDocumentMode(choice));
  return true;
}

export function posterPlanReviewUiState(plan, validation = { valid: false, errors: [] }, busy = false) {
  return {
    canConfirm: plan?.status === 'PLAN_REVIEW' && validation.valid && !busy,
    errors: (validation.errors || []).map((error) => error?.message || error?.path).filter(Boolean),
  };
}
