import { canonicalJson } from '../poster-plan.js';

export function buildBatchPrompt(record) {
  const binding = { batchId: record.batchId, requestId: record.requestId,
    receipt: { workbenchSessionId: record.workbenchSessionId, envelopeSha256: record.envelopeSha256 } };
  const probe = record.envelope.mode === 'confirmation_probe';
  return [probe ? 'Imvia Layer V2 会话桥验证。仅确认消息，不生成、不调用 ImageGen/RMBG，不读取其他任务。' : 'Imvia Layer V2 可见批次任务。仅处理冻结清单，不自动重试或采用结果。',
    `请先调用 confirm_workbench_v2_batch，参数：${JSON.stringify(binding)}`,
    probe ? '确认成功后仅回复“已收到 V2 测试批次”，然后停止。' : `冻结批次记录：${record.envelope.manifestPath}；调度信封 SHA-256：${record.envelopeSha256}（不是清单文件哈希）。确认工具会返回 receipt。之后先调用 claim_workbench_v2_batch_item，传 batchId 和该 receipt；一次只处理返回的一项。完成后调用 record_workbench_v2_attempt_event，再领取下一项，直到返回 done。严格按 V2 批次适配器；不处理清单以外内容。`,
  ].join('\n');
}

export function createBatchBridge({ store, host }) {
  const inFlight = new Map();
  async function send({ batchId, envelope, signal }) {
    signal?.throwIfAborted();
    let record = await store.create({ batchId, envelope });
    if (record.status === 'cancelled') throw new Error('REQUEST_CANCELLED');
    if (record.status !== 'pending') return { requestId: record.requestId, status: 'requested' };
    try { record = await store.transition({ requestId: record.requestId, expectedStatus: 'pending', nextStatus: 'claimed' }); }
    catch (error) {
      const current = await store.read(record.requestId);
      if (['claimed', 'sent'].includes(current.status)) return { requestId: record.requestId, status: 'requested' };
      throw error;
    }
    let onAbort;
    try {
      signal?.throwIfAborted();
      if (typeof host?.sendMessage !== 'function') throw new Error('HOST_MESSAGE_UNSUPPORTED');
      const visibleSend = Promise.resolve(host.sendMessage({ prompt: buildBatchPrompt(record) }));
      const result = signal ? await Promise.race([visibleSend, new Promise((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('REQUEST_ABORTED'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]) : await visibleSend;
      if (result?.isError) throw new Error('HOST_MESSAGE_REJECTED');
      signal?.throwIfAborted();
      // SDK resolution says only that the host accepted the request, not that
      // a user sent it or that a visible Codex turn received it.
      return { requestId: record.requestId, status: 'requested' };
    } catch (error) {
      const current = await store.read(record.requestId);
      if (current.status === 'claimed') await store.transition({ requestId: record.requestId, expectedStatus: 'claimed', nextStatus: 'cancelled' });
      throw error;
    } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
  }
  return {
    requestBatchConfirmation(options) {
      const envelopeKey = canonicalJson(options.envelope);
      if (inFlight.has(options.batchId)) {
        const current = inFlight.get(options.batchId);
        return current.envelopeKey === envelopeKey ? current.promise : Promise.reject(new Error('BINDING_MISMATCH'));
      }
      const promise = send(options).finally(() => inFlight.delete(options.batchId));
      inFlight.set(options.batchId, { promise, envelopeKey });
      return promise;
    },
    async acknowledgeBatchMessage({ batchId, requestId, receipt }) {
      const record = await store.read(requestId);
      if (record.batchId !== batchId) throw new Error('BATCH_MISMATCH');
      await store.transition({ requestId, expectedStatus: 'claimed', nextStatus: 'sent', receipt });
    },
  };
}
