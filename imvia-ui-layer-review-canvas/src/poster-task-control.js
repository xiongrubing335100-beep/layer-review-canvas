import { createElement } from 'react';

const CANCELABLE_STATUSES = new Set([
  'queued', 'pending', 'claimed', 'delivered', 'awaiting_codex_message',
  'sending_to_codex', 'host_accepted', 'submitted_to_conversation',
]);
const ABANDONABLE_STATUSES = new Set([
  'sent', 'sent_to_codex', 'analyzing', 'processing', 'finalizing',
]);

export const POSTER_ABANDON_WARNING = '这会放弃工作台中的当前海报任务并释放后续队列，但不能停止当前 active Codex turn。迟到结果将被忽略。是否继续？';

function dispatchBinding(job) {
  return {
    jobId: typeof job?.job_id === 'string' ? job.job_id : '',
    dispatchId: job?.dispatch?.dispatch_id ?? job?.dispatch?.dispatchId
      ?? job?.dispatch_id ?? job?.dispatchId ?? '',
    status: String(job?.dispatch?.status ?? job?.status ?? '').toLowerCase(),
  };
}

export function posterTaskControlView(job) {
  const binding = dispatchBinding(job);
  if (!binding.jobId || !binding.dispatchId) return { action: 'none', ...binding };
  if (CANCELABLE_STATUSES.has(binding.status)) {
    return {
      ...binding,
      action: 'cancel',
      label: '取消待接收任务',
      detail: '取消尚未发送到 Codex 的海报任务并释放队列。',
    };
  }
  if (ABANDONABLE_STATUSES.has(binding.status)) {
    return {
      ...binding,
      action: 'abandon',
      label: '放弃任务并释放队列',
      detail: '释放工作台队列，但不能停止当前 active Codex turn；迟到结果会被忽略。',
      warning: POSTER_ABANDON_WARNING,
    };
  }
  return { action: 'none', ...binding };
}

export async function executePosterTaskControl(job, {
  cancel,
  abandon,
  refresh,
  confirmAbandon = () => false,
} = {}) {
  const view = posterTaskControlView(job);
  if (view.action === 'none') return null;
  if (view.action === 'abandon' && !confirmAbandon(view.warning)) return null;
  if (view.action === 'cancel') await cancel(view.jobId, view.dispatchId);
  else await abandon(view.jobId, view.dispatchId);
  return refresh(view.jobId, view.dispatchId);
}

export function PosterTaskControl({ view, busy = false, onControl }) {
  if (!view || view.action === 'none') return null;
  return createElement('aside', {
    className: `poster-task-control poster-task-control--${view.action}`,
    'aria-label': '海报任务队列控制',
  }, [
    createElement('div', { key: 'copy' }, [
      createElement('strong', { key: 'title' }, view.label),
      createElement('p', { key: 'detail' }, view.detail),
    ]),
    createElement('button', {
      key: 'action',
      type: 'button',
      className: 'command-button',
      disabled: busy,
      onClick: onControl,
    }, busy ? '处理中…' : view.label),
  ]);
}
