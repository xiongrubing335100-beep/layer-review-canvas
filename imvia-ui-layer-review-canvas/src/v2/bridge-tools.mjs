import { z } from 'zod';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { createBridgeRequestStore } from './bridge-request-store.js';
import { createBatchBridge, buildBatchPrompt } from './batch-bridge.js';
import { idSchema } from './document.js';
import { buildV2ConfirmationProbeHtml } from '../mcp-bridge-resource.js';
import path from 'node:path';
import { createDocumentStore } from './document-store.js';
import { createBatchStore } from './batch-store.js';

export function registerV2BridgeTools(server, { root }) {
  const store = createBridgeRequestStore({ root });
  const bridge = createBatchBridge({ store });
  const runtimeRoot = path.dirname(path.resolve(root));
  const documents = createDocumentStore({ root: path.join(runtimeRoot, 'documents') });
  const cancelConfirmation = async id => {
    const record = await store.read(id);
    if (['pending', 'claimed'].includes(record.status)) {
      try { return await store.transition({ requestId: id, expectedStatus: record.status, nextStatus: 'cancelled' }); }
      catch (cause) { const current = await store.read(id); if (!['sent', 'cancelled'].includes(current.status)) throw cause; return current; }
    }
    return record;
  };
  const batches = createBatchStore({ root: runtimeRoot, getDocument: id => documents.read(id), readConfirmation: id => store.read(id), cancelConfirmation });
  const resourceUri = 'ui://imvia-layer/v2-confirmation-probe.html';
  registerAppResource(server, 'imvia-v2-confirmation-probe', resourceUri, {}, async () => ({
    contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: buildV2ConfirmationProbeHtml() }],
  }));
  registerAppTool(server, 'open_workbench_v2_confirmation_probe', {
    title: '打开 V2 无生成会话桥验证', description: 'Open a visible no-generation confirmation test. Never starts generation or modifies existing tasks.',
    inputSchema: {}, _meta: { ui: { resourceUri, visibility: ['model'] } },
  }, async () => ({ content: [{ type: 'text', text: '点击验证按钮请求宿主确认；不会生成图片。' }] }));
  registerAppTool(server, 'prepare_workbench_v2_confirmation_probe', {
    title: '准备 V2 无生成验证', description: 'Prepare only a two-item no-generation diagnostic envelope, never a generation task.',
    inputSchema: { batchId: idSchema, workbenchSessionId: idSchema },
    _meta: { ui: { resourceUri, visibility: ['app'] } },
  }, async ({ batchId, workbenchSessionId }) => {
    let record = await store.create({ batchId, envelope: { mode: 'confirmation_probe', workbenchSessionId,
      items: [{ layerId: 'one', action: 'no-generation' }, { layerId: 'two', action: 'no-generation' }] } });
    if (record.status === 'pending') record = await store.transition({ requestId: record.requestId, expectedStatus: 'pending', nextStatus: 'claimed' });
    if (record.status === 'cancelled') throw new Error('REQUEST_CANCELLED');
    return { content: [], structuredContent: { ...record, prompt: buildBatchPrompt(record) } };
  });
  registerAppTool(server, 'get_workbench_v2_confirmation', {
    title: '读取 V2 验证状态', description: 'Read one exact V2 request status.', inputSchema: { requestId: idSchema },
    annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri, visibility: ['app'] } },
  }, async ({ requestId }) => ({ content: [], structuredContent: await store.read(requestId) }));
  registerAppTool(server, 'cancel_workbench_v2_confirmation', {
    title: '取消 V2 验证请求', description: 'Cancel only an unconfirmed request; never restarts it.', inputSchema: { requestId: idSchema },
    _meta: { ui: { resourceUri, visibility: ['app'] } },
  }, async ({ requestId }) => {
    const record = await store.read(requestId);
    const result = ['pending', 'claimed'].includes(record.status)
      ? await store.transition({ requestId, expectedStatus: record.status, nextStatus: 'cancelled' }) : record;
    return { content: [], structuredContent: result };
  });
  registerAppTool(server, 'confirm_workbench_v2_batch', {
    title: '确认当前可见回合收到 V2 批次', description: 'Call only after this exact V2 batch message visibly arrived in this conversation. Do not infer delivery from host acceptance.',
    inputSchema: { batchId: idSchema, requestId: idSchema,
      receipt: z.object({ workbenchSessionId: idSchema, envelopeSha256: z.string().regex(/^[a-f0-9]{64}$/) }) },
    _meta: { ui: { visibility: ['model'] } },
  }, async args => {
    await bridge.acknowledgeBatchMessage(args);
    return { content: [], structuredContent: { ok: true, receipt: args.receipt } };
  });
  registerAppTool(server, 'get_workbench_v2_batch', {
    title: '读取冻结的 V2 拆分批次', description: 'Read one exact frozen V2 batch; does not start an attempt.',
    inputSchema: { batchId: idSchema }, annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ['model'] } },
  }, async ({ batchId }) => ({ content: [], structuredContent: await batches.getBatch(batchId) }));
  registerAppTool(server, 'claim_workbench_v2_batch_item', {
    title: '领取下一项 V2 区域处理', description: 'Claims exactly one serial item only after a matching visible confirmation receipt.',
    inputSchema: { batchId: idSchema, receipt: z.object({ workbenchSessionId: idSchema, envelopeSha256: z.string().regex(/^[a-f0-9]{64}$/) }) },
    _meta: { ui: { visibility: ['model'] } },
  }, async args => ({ content: [], structuredContent: await batches.claimNextBatchItem(args) }));
  registerAppTool(server, 'record_workbench_v2_attempt_event', {
    title: '记录 V2 拆分项结果', description: 'Record one idempotent event for the exact batch attempt and dispatch.',
    inputSchema: { batchId: idSchema, event: z.object({ eventId: idSchema, attemptId: idSchema, dispatchId: idSchema,
      type: z.enum(['sent', 'running', 'suggested', 'failed', 'cancelled']), timestamp: z.string().optional(), payload: z.record(z.string(), z.unknown()).optional() }) },
    _meta: { ui: { visibility: ['model'] } },
  }, async args => ({ content: [], structuredContent: await batches.applyEvent(args) }));
  registerAppTool(server, 'cancel_workbench_v2_attempt', {
    title: '取消 V2 拆分项', description: 'Cancel one exact attempt; terminal cancellation cannot be reversed.',
    inputSchema: { attemptId: idSchema }, _meta: { ui: { visibility: ['model', 'app'] } },
  }, async args => ({ content: [], structuredContent: await batches.cancelAttempt(args) }));
  registerAppTool(server, 'restart_workbench_v2_session', {
    title: '重启 V2 工作台会话', description: 'Cancel active attempts bound only to the specified V2 workbench session and preserve history.',
    inputSchema: { workbenchSessionId: idSchema }, _meta: { ui: { visibility: ['model', 'app'] } },
  }, async args => ({ content: [], structuredContent: await batches.restartSession(args) }));
}
