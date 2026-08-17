export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (!Number.isFinite(percentileValue) || percentileValue < 0 || percentileValue > 100) {
    throw new RangeError('percentile must be between 0 and 100');
  }
  const position = (sorted.length - 1) * (percentileValue / 100);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

export function reductionPercent(baseline, current) {
  return Math.round(((baseline - current) / baseline) * 1000) / 10;
}

export function summarizeDurations(samples) {
  return Object.fromEntries([...new Set(samples.map((item) => item.route))].map((route) => {
    const routeSamples = samples.filter((item) => item.route === route);
    const completed = routeSamples.filter((item) => item.status === 'completed');
    const postprocessSeconds = completed
      .map((item) => item.postprocessSeconds)
      .filter((value) => Number.isFinite(value));
    return [route, {
      completed: completed.length,
      failed: routeSamples.length - completed.length,
      medianSeconds: median(completed.map((item) => item.seconds)),
      p50Seconds: percentile(completed.map((item) => item.seconds), 50),
      p90Seconds: percentile(completed.map((item) => item.seconds), 90),
      medianPostprocessSeconds: median(postprocessSeconds),
      maxPostprocessSeconds: postprocessSeconds.length ? Math.max(...postprocessSeconds) : null,
    }];
  }));
}
