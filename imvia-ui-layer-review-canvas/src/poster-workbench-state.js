const QUEUED = new Set(['queued', 'pending', 'awaiting_codex_message']);
const PROCESSING = new Set(['claimed', 'delivered', 'sent', 'sending_to_codex', 'host_accepted', 'sent_to_codex', 'submitted_to_conversation', 'processing', 'finalizing', 'ANALYZING']);

export function createPosterPlanningRunGuard(runId, getCurrentRunId = () => runId) {
  const isCurrent = () => !runId || getCurrentRunId() === runId;
  return {
    isCurrent,
    async awaitCurrent(promise) {
      const value = await promise;
      return isCurrent() ? value : undefined;
    },
    ifCurrent(callback) {
      if (!isCurrent()) return false;
      callback();
      return true;
    },
  };
}

export async function runPosterFastPlanningPipeline({
  runGuard,
  materializeSource,
  uploadSource,
  createPlan,
  submitJob,
  persist,
  onStage,
} = {}) {
  if (!runGuard?.isCurrent?.()) return { status: 'stale' };
  const materialized = await runGuard.awaitCurrent(materializeSource());
  if (materialized === undefined) return { status: 'stale' };
  const storedSource = await runGuard.awaitCurrent(uploadSource(materialized));
  if (storedSource === undefined) return { status: 'stale' };
  let plan;
  if (!runGuard.ifCurrent(() => {
    plan = createPlan(storedSource, materialized);
  })) return { status: 'stale' };
  const submitted = await runGuard.awaitCurrent(submitJob(plan));
  if (submitted === undefined) return { status: 'stale' };
  if (!runGuard.ifCurrent(() => {
    persist?.({ plan, submitted });
    onStage?.({ plan, submitted });
  })) return { status: 'stale' };
  return { status: 'completed', plan, submitted };
}

export function posterFastCandidateAuthorizationId(jobId, planVersion, layerIndex, manifest = {}) {
  const candidateNumber = (Array.isArray(manifest?.candidates) ? manifest.candidates : [])
    .filter((candidate) => candidate?.layer_index === layerIndex).length + 1;
  return `${jobId}:${planVersion}:${layerIndex}:${candidateNumber}`;
}

export function posterWorkbenchView(job) {
  if (job?.planning_mode === 'targeted_fast' || job?.plan?.planning_mode === 'targeted_fast') return { kind: 'fast' };
  const status = job?.status || job?.plan?.status || '';
  if (job?.plan?.status === 'PLAN_REVIEW' || status === 'PLAN_REVIEW') return { kind: 'review' };
  if (job?.plan?.status === 'PLAN_CONFIRMED' || status === 'PLAN_CONFIRMED') return { kind: 'confirmed' };
  if (job?.plan?.status === 'ANALYSIS_FAILED' || ['ANALYSIS_FAILED', 'failed', 'send_failed', 'cancelled'].includes(status)) return { kind: 'failed' };
  if (QUEUED.has(status)) return { kind: 'queued' };
  if (PROCESSING.has(status)) return { kind: 'processing' };
  return { kind: 'empty' };
}
