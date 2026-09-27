import { z } from 'zod';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { createBridgeRequestStore } from './bridge-request-store.js';
import { createBatchBridge, buildBatchPrompt } from './batch-bridge.js';
import { idSchema } from './document.js';
import { buildV2ConfirmationProbeHtml } from '../mcp-bridge-resource.js';

export function registerV2BridgeTools(server, { root }) {
  const store = createBridgeRequestStore({ root });
  const bridge = createBatchBridge({ store });
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
    return { content: [], structuredContent: { ok: true } };
  });
}
