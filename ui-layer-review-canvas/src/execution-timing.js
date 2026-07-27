export function markTiming(timing = {}, stage, value = new Date().toISOString()) {
  return { ...timing, [stage]: value };
}

export function mergeTiming(jobTiming = {}, reportTiming = {}) {
  return Object.fromEntries(
    Object.entries({ ...jobTiming, ...reportTiming }).filter(([, value]) => Boolean(value)),
  );
}

export function completionTimestamp({
  status,
  timing = {},
  planCompletedAt,
  turnCompletedAt,
  imageCompletedAt,
  fallbackCompletedAt,
}) {
  if (!['completed', 'failed'].includes(status)) return null;
  return timing.completed_at
    || planCompletedAt
    || turnCompletedAt
    || imageCompletedAt
    || fallbackCompletedAt;
}
