export function applyPosterJobResult({ documents, activeImageId, visibleJob }, imageId, job) {
  const nextDocuments = (Array.isArray(documents) ? documents : []).map((document) => {
    if (document.imageId !== imageId) return document;
    return {
      ...document,
      posterJobId: job.job_id,
      posterDispatchId: job.dispatch_id || job.dispatch?.dispatch_id || document.posterDispatchId || '',
      posterPlanVersion: job.plan?.plan_version || document.posterPlanVersion || 0,
    };
  });
  const visibleUpdated = activeImageId === imageId;
  return {
    documents: nextDocuments,
    visibleJob: visibleUpdated ? job : visibleJob,
    visibleUpdated,
  };
}
