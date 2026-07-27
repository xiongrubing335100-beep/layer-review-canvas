export function markTiming(timing = {}, stage, value = new Date().toISOString()) {
  return { ...timing, [stage]: value };
}

export function mergeTiming(jobTiming = {}, reportTiming = {}) {
  return Object.fromEntries(
    Object.entries({ ...jobTiming, ...reportTiming }).filter(([, value]) => Boolean(value)),
  );
}
