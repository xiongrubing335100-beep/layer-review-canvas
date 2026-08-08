export const TIMING_STAGE_KEYS = [
  'submitted_at',
  'confirmation_presented_at',
  'confirmation_accepted_at',
  'codex_turn_started_at',
  'preflight_started_at',
  'preflight_completed_at',
  'imagegen_requested_at',
  'imagegen_completed_at',
  'postprocess_started_at',
  'rmbg_started_at',
  'rmbg_completed_at',
  'validation_started_at',
  'completed_at',
];

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

function timestampMs(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    return null;
  }
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intervalMs(timing, startKey, endKey, invalidIntervals) {
  const start = timestampMs(timing[startKey]);
  const end = timestampMs(timing[endKey]);
  if (start === null || end === null) return null;
  if (end < start) {
    invalidIntervals.push(`${startKey}->${endKey}`);
    return null;
  }
  return end - start;
}

function firstTimestampKey(timing, keys) {
  return keys.find((key) => timestampMs(timing[key]) !== null) || null;
}

/**
 * Derive comparable stage durations from execution timestamps.
 * Missing or reverse-ordered intervals stay null and never become negative.
 */
export function deriveDurations(timing = {}) {
  const invalidIntervals = [];
  const postprocessEnd = firstTimestampKey(timing, [
    'rmbg_started_at',
    'validation_started_at',
    'completed_at',
  ]);
  const durations = {
    user_confirmation_dwell_ms: intervalMs(
      timing,
      'confirmation_presented_at',
      'confirmation_accepted_at',
      invalidIntervals,
    ),
    dispatch_ms: intervalMs(
      timing,
      'confirmation_accepted_at',
      'codex_turn_started_at',
      invalidIntervals,
    ),
    preflight_ms: intervalMs(
      timing,
      'preflight_started_at',
      'preflight_completed_at',
      invalidIntervals,
    ),
    imagegen_ms: intervalMs(
      timing,
      'imagegen_requested_at',
      'imagegen_completed_at',
      invalidIntervals,
    ),
    postprocess_ms: postprocessEnd
      ? intervalMs(timing, 'postprocess_started_at', postprocessEnd, invalidIntervals)
      : null,
    rmbg_ms: intervalMs(timing, 'rmbg_started_at', 'rmbg_completed_at', invalidIntervals),
    validation_ms: intervalMs(timing, 'validation_started_at', 'completed_at', invalidIntervals),
    total_machine_ms: intervalMs(
      timing,
      'confirmation_accepted_at',
      'completed_at',
      invalidIntervals,
    ),
    total_user_visible_ms: intervalMs(
      timing,
      'submitted_at',
      'completed_at',
      invalidIntervals,
    ),
  };

  return {
    ...durations,
    invalid_intervals: invalidIntervals,
  };
}
