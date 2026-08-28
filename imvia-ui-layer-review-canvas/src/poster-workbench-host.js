import { callMcpAppTool, isMcpAppHost } from './mcp-app-client.js';
import { resolveWorkbenchUrl } from './mcp-workbench-host.js';

function runtime(dependencies = {}) {
  return {
    isMcpHost: dependencies.isMcpHost || isMcpAppHost,
    callTool: dependencies.callTool || callMcpAppTool,
  };
}

async function post(pathname, body, fetchImpl) {
  const response = await fetchImpl(resolveWorkbenchUrl(pathname), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function patch(pathname, body, fetchImpl) {
  const response = await fetchImpl(resolveWorkbenchUrl(pathname), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

export async function submitPosterAnalysis(plan, fetchImpl = fetch, dependencies = {}) {
  const host = runtime(dependencies);
  if (host.isMcpHost()) return host.callTool('submit_poster_layer_analysis', { plan });
  return post('/api/poster-layer/jobs/analyze', { plan }, fetchImpl);
}

// Fast plans are created by the local workbench route.  In an MCP-hosted card
// there is deliberately no analysis-tool fallback: the caller keeps the plan
// local until it can use the normal HTTP workbench endpoint.
export async function submitPosterFastJob(plan, fetchImpl = fetch, dependencies = {}) {
  // This is intentionally an HTTP-only local persistence operation.  An MCP
  // host must not substitute the analysis tool or return an ephemeral plan.
  void runtime(dependencies);
  return post('/api/poster-layer/jobs/fast', { plan }, fetchImpl);
}

export async function submitPosterCandidate(jobId, layerIndex, authorization, fetchImpl = fetch, dependencies = {}) {
  const host = runtime(dependencies);
  const payload = { jobId, layerIndex, ...authorization };
  if (host.isMcpHost()) return host.callTool('submit_poster_layer_candidate', payload);
  return post(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/candidates/${encodeURIComponent(layerIndex)}`,
    authorization, fetchImpl);
}

export async function submitPosterTargetedCandidate(jobId, layerIndex, {
  snapshot, authorizationId, expectedManifestRevision, planVersion,
}, fetchImpl = fetch, dependencies = {}) {
  const host = runtime(dependencies);
  const payload = {
    jobId, layerIndex, planningMode: 'targeted_fast', planning_mode: 'targeted_fast',
    layerSnapshot: snapshot, layer_snapshot: snapshot, snapshotId: snapshot?.snapshot_id,
    snapshot_id: snapshot?.snapshot_id, authorizationId, authorization_id: authorizationId,
    expectedManifestRevision, expected_manifest_revision: expectedManifestRevision,
    planVersion, plan_version: planVersion, explicit_authorization: true,
  };
  if (host.isMcpHost()) return host.callTool('submit_poster_layer_candidate', payload);
  return post(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/candidates/${encodeURIComponent(layerIndex)}`,
    payload, fetchImpl);
}

export async function getPosterJob(jobId, fetchImpl = fetch, dependencies = {}) {
  const host = runtime(dependencies);
  if (host.isMcpHost()) {
    const result = await host.callTool('get_poster_layer_job', { jobId });
    return result.job || result;
  }
  const response = await fetchImpl(resolveWorkbenchUrl(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}`), {
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

export async function getPosterJobWithDispatch(jobId, dispatchId, fetchImpl = fetch, dependencies = {}) {
  const job = await getPosterJob(jobId, fetchImpl, dependencies);
  if (!job || !dispatchId) return job;
  const host = runtime(dependencies);
  if (host.isMcpHost()) {
    const result = await host.callTool('get_poster_layer_job', { jobId, dispatchId });
    return { ...job, dispatch: result.job || result };
  }
  const dispatchResponse = await fetchImpl(resolveWorkbenchUrl(
    `/api/poster-layer/jobs/${encodeURIComponent(jobId)}/dispatches/${encodeURIComponent(dispatchId)}`,
  ), { cache: 'no-store' });
  if (!dispatchResponse.ok) return job;
  return { ...job, dispatch: await dispatchResponse.json().catch(() => null) };
}

export async function updatePosterPlan(jobId, plan, expectedManifestRevision, fetchImpl = fetch, dependencies = {}) {
  const host = runtime(dependencies);
  const payload = { jobId, plan, expectedManifestRevision };
  if (host.isMcpHost()) return host.callTool('update_poster_layer_plan', payload);
  return patch(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/plan`, {
    plan, expected_manifest_revision: expectedManifestRevision,
  }, fetchImpl);
}

export async function confirmPosterPlan(jobId, expectedManifestRevision, fetchImpl = fetch, dependencies = {}) {
  const host = runtime(dependencies);
  const payload = { jobId, expectedManifestRevision };
  if (host.isMcpHost()) return host.callTool('confirm_poster_layer_plan', payload);
  return post(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/plan/confirm`, {
    expected_manifest_revision: expectedManifestRevision,
  }, fetchImpl);
}

export async function acceptPosterCandidate(jobId, layerIndex, candidateId, expectedManifestRevision, fetchImpl = fetch, dependencies = {}) {
  const host = runtime(dependencies);
  const payload = { jobId, layerIndex, candidateId, expectedManifestRevision };
  if (host.isMcpHost()) return host.callTool('accept_poster_layer_candidate', payload);
  return post(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/layers/${encodeURIComponent(layerIndex)}/accept`, {
    candidate_id: candidateId,
    expected_manifest_revision: expectedManifestRevision,
  }, fetchImpl);
}

export async function authorizePosterRetry(jobId, layerIndex, expectedManifestRevision, fetchImpl = fetch, dependencies = {}) {
  const host = runtime(dependencies);
  const payload = { jobId, layerIndex, expectedManifestRevision };
  if (host.isMcpHost()) return host.callTool('authorize_poster_layer_retry', payload);
  return post(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/layers/${encodeURIComponent(layerIndex)}/retry`, {
    expected_manifest_revision: expectedManifestRevision,
  }, fetchImpl);
}

export async function reprocessPosterFastCandidate(jobId, layerIndex, expectedManifestRevision, fetchImpl = fetch) {
  return post(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/layers/${encodeURIComponent(layerIndex)}/reprocess`, {
    expected_manifest_revision: expectedManifestRevision,
  }, fetchImpl);
}

export async function reauthorizePosterAuditLayer(jobId, layerIndex, expectedManifestRevision, fetchImpl = fetch, dependencies = {}) {
  const host = runtime(dependencies);
  const payload = { jobId, layerIndex, expectedManifestRevision };
  if (host.isMcpHost()) return host.callTool('reauthorize_poster_audit_layer', payload);
  return post(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/layers/${encodeURIComponent(layerIndex)}/audit-remediation`, {
    expected_manifest_revision: expectedManifestRevision,
  }, fetchImpl);
}

export async function runPosterAudit(jobId, expectedManifestRevision, fetchImpl = fetch, dependencies = {}) {
  const host = runtime(dependencies);
  const payload = { jobId, expectedManifestRevision };
  if (host.isMcpHost()) return host.callTool('run_poster_recomposition_audit', payload);
  return post(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/audit`, {
    expected_manifest_revision: expectedManifestRevision,
  }, fetchImpl);
}

export function posterExportUrl(jobId) {
  return resolveWorkbenchUrl(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/export`);
}

export async function cancelPosterJob(jobId, dispatchId, fetchImpl = fetch, dependencies = {}) {
  const host = runtime(dependencies);
  const payload = { jobId, dispatchId, rootKind: 'poster' };
  if (host.isMcpHost()) return host.callTool('cancel_poster_layer_job', payload);
  return post(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/cancel`, payload, fetchImpl);
}

export async function abandonPosterJob(jobId, dispatchId, fetchImpl = fetch, dependencies = {}) {
  const host = runtime(dependencies);
  const payload = { jobId, dispatchId, rootKind: 'poster' };
  if (host.isMcpHost()) return host.callTool('abandon_poster_layer_job', payload);
  return post(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/abandon`, payload, fetchImpl);
}

export async function confirmPosterDispatch(jobId, dispatchId, bridgeId, claimToken, fetchImpl = fetch, dependencies = {}) {
  const host = runtime(dependencies);
  const payload = { jobId, dispatchId, rootKind: 'poster', bridgeId, claimToken };
  if (host.isMcpHost()) return host.callTool('confirm_poster_foreground_dispatch', payload);
  return post(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/confirm-dispatch`, payload, fetchImpl);
}
