import {
  callMcpAppTool,
  isMcpAppHost,
} from './mcp-app-client.js';

const workbenchOrigin = 'http://127.0.0.1:4173';

export function resolveWorkbenchUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return value;
  return new URL(value, `${workbenchOrigin}/`).href;
}

export async function getConversationBridgePresence(fetchImpl = fetch) {
  const response = await fetchImpl(resolveWorkbenchUrl('/api/layer-review/bridge-status'), {
    cache: 'no-store',
  });
  if (!response.ok) return { online: false, last_seen: null };
  return response.json();
}

export async function markLayerReviewMessageSent(jobId, fetchImpl = fetch) {
  if (isMcpAppHost()) {
    return callMcpAppTool('mark_layer_review_message_sent', { jobId });
  }
  const response = await fetchImpl(resolveWorkbenchUrl(
    `/api/layer-review/jobs/${encodeURIComponent(jobId)}/message-sent`,
  ), { method: 'POST' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `消息确认失败：HTTP ${response.status}`);
  return result;
}

export async function markLayerReviewMessageFailed(jobId, error, fetchImpl = fetch) {
  if (isMcpAppHost()) {
    return callMcpAppTool('mark_layer_review_message_failed', {
      jobId,
      error: error?.message || String(error || '发送失败'),
    });
  }
  const response = await fetchImpl(resolveWorkbenchUrl(
    `/api/layer-review/jobs/${encodeURIComponent(jobId)}/message-failed`,
  ), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: error?.message || String(error || '发送失败') }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `消息失败状态写入失败：HTTP ${response.status}`);
  return result;
}

export async function cancelQueuedSplit(jobId, fetchImpl = fetch) {
  if (isMcpAppHost()) {
    return callMcpAppTool('cancel_layer_review_job', { jobId });
  }
  const response = await fetchImpl(resolveWorkbenchUrl(
    `/api/layer-review/foreground-dispatch/${encodeURIComponent(jobId)}/cancel`,
  ), { method: 'POST' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `取消失败：HTTP ${response.status}`);
  return result;
}

export async function getLayerReviewJob(jobId, fetchImpl = fetch) {
  if (isMcpAppHost()) {
    const result = await callMcpAppTool('get_layer_review_job', { jobId });
    return result.job;
  }
  const response = await fetchImpl(resolveWorkbenchUrl(
    `/api/layer-review/jobs/${encodeURIComponent(jobId)}`,
  ), { cache: 'no-store' });
  if (response.status === 404) return { job_id: jobId, status: 'failed', images: [] };
  if (response.status === 410) return { job_id: jobId, status: 'discarded' };
  if (!response.ok) return null;
  return response.json();
}

export async function uploadMcpSourcePreview(file, fetchImpl = fetch) {
  if (!isMcpAppHost()) return null;
  const response = await fetchImpl(resolveWorkbenchUrl('/api/layer-review/source-preview'), {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.url) {
    throw new Error(result.error || `图片上传失败：HTTP ${response.status}`);
  }
  return resolveWorkbenchUrl(result.url);
}

export async function submitLayerReviewPlan(plan, fetchImpl = fetch) {
  if (isMcpAppHost()) {
    const prepared = await callMcpAppTool('submit_layer_review_job', {
      plan,
      delivery: 'current_conversation',
    });
    return prepared.submission;
  }

  const response = await fetchImpl(resolveWorkbenchUrl('/api/layer-review/submit'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(plan),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
