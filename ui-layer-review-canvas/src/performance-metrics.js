export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function reductionPercent(baseline, current) {
  return Math.round(((baseline - current) / baseline) * 1000) / 10;
}

export function summarizeDurations(samples) {
  return Object.fromEntries([...new Set(samples.map((item) => item.route))].map((route) => {
    const routeSamples = samples.filter((item) => item.route === route);
    const completed = routeSamples.filter((item) => item.status === 'completed');
    return [route, {
      completed: completed.length,
      failed: routeSamples.length - completed.length,
      medianSeconds: median(completed.map((item) => item.seconds)),
    }];
  }));
}
