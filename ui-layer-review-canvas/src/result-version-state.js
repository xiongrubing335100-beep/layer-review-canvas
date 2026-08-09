function normalizedFileKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function jobOrder(job, index) {
  const value = job.completedAt ?? job.submittedAt;
  const timestamp = typeof value === 'number' ? value : Date.parse(value || '');
  return { timestamp: Number.isFinite(timestamp) ? timestamp : -Infinity, index };
}

function compareByOrder(left, right) {
  return left.order.timestamp - right.order.timestamp || left.order.index - right.order.index;
}

function imageForNode(job, node) {
  if (!job?.nodeIds?.includes(node.id)) return null;
  const images = Array.isArray(job.images) ? job.images : [];
  const nodeKey = normalizedFileKey(node.id);
  const namedImage = images.find((image) => normalizedFileKey(image?.name).includes(nodeKey));
  const nodeIndex = job.nodeIds.indexOf(node.id);
  const image = namedImage || (job.nodeIds.length === 1 ? images[0] : images[nodeIndex]);
  return typeof image?.url === 'string' && image.url.length > 0 ? image : null;
}

function resultForNode(job, node, sourceSize) {
  const image = imageForNode(job, node);
  if (!image) return null;
  const snapshot = job.layerSnapshots?.[node.id];
  return {
    job,
    image,
    bounds: snapshot?.bounds ?? node.bounds,
    sourceSize: job.sourceSize ?? sourceSize,
  };
}

function parentJobId(job) {
  return job?.parentJobId ?? job?.parent_job_id ?? null;
}

function isFailed(job) {
  return job.status === 'failed' || job.status === 'send_failed';
}

function isCancelled(job) {
  return job.status === 'cancelled' || job.status === 'discarded';
}

/**
 * Resolves the versioned PNG state for one layer without allowing an unfinished
 * revision to replace the last completed image.
 */
export function resolveNodeResultState({ jobs, node, sourceSize }) {
  const relevantJobs = (Array.isArray(jobs) ? jobs : [])
    .map((job, index) => ({ job, index, order: jobOrder(job, index) }))
    .filter(({ job }) => job?.nodeIds?.includes(node?.id));
  const successful = relevantJobs
    .filter(({ job }) => job.status === 'completed')
    .map((entry) => ({ ...entry, result: resultForNode(entry.job, node, sourceSize) }))
    .filter(({ result }) => result)
    .sort(compareByOrder);
  const revisions = relevantJobs.filter(({ job }) => parentJobId(job));
  const pending = revisions
    .filter(({ job }) => job.status !== 'completed' && !isFailed(job) && !isCancelled(job))
    .sort(compareByOrder);
  const failed = revisions.filter(({ job }) => isFailed(job)).sort(compareByOrder);

  return {
    baseResult: successful.at(-1)?.result ?? null,
    pendingRevision: pending.at(-1) ? { job: pending.at(-1).job } : null,
    failedRevision: failed.at(-1) ? { job: failed.at(-1).job } : null,
    history: successful.map(({ result }) => result),
  };
}
