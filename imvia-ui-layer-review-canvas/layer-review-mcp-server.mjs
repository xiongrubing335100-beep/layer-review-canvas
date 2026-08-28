import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  buildBridgeWidgetHtml,
  buildWorkbenchWidgetHtml,
} from './src/mcp-bridge-resource.js';
import {
  activateConversationBridge,
  markConversationBridgeHeartbeat,
} from './src/conversation-bridge-presence.js';
import {
  acknowledgeDirectConversationMessage,
  acknowledgeForegroundDispatch,
  claimNextForegroundDispatchFromRoots,
  markDirectConversationMessageFailed,
  markDirectConversationMessageSent,
  markForegroundDispatchDelivered,
  releaseForegroundDispatchClaim,
  readForegroundQueueSummaryFromRoots,
} from './src/foreground-dispatch.js';
import { withDirectoryLock } from './src/file-lock.js';
import { resetPosterDispatchesForOpen } from './src/poster-dispatch-control.js';
import { resetWorkbenchForOpen } from './src/workbench-lifecycle-store.js';
import { isExecutionFeatureEnabled } from './src/execution-features.js';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(rootDirectory, 'output');
const jobsDirectory = path.join(rootDirectory, 'output', 'jobs');
const posterJobsDirectory = path.join(rootDirectory, 'output', 'poster-jobs');
const workbenchOrigin = 'http://127.0.0.1:4173';
const workbenchDomain = new URL(workbenchOrigin).origin;
const widgetResourceDomains = [workbenchDomain, 'data:', 'blob:'];
const widgetUri = 'ui://imvia-layer/workbench-v1.html';
const bridgeWidgetUri = 'ui://imvia-layer/conversation-bridge-v25.html';
const bridgeWidgetHtmlPath = path.join(rootDirectory, 'public', 'layer-review-bridge-widget.html');
const bridgeWidgetScriptPath = path.join(rootDirectory, 'public', 'layer-review-bridge-widget.js');

export function buildPosterCandidateSubmissionPayload({
  explicitAuthorization, explicit_authorization, expectedManifestRevision, planVersion,
  planningMode, layerSnapshot, snapshotId, authorizationId, processingCategory,
} = {}) {
  return Object.fromEntries(Object.entries({
    explicitAuthorization, explicit_authorization, expectedManifestRevision, planVersion,
    planningMode, layerSnapshot, snapshotId, authorizationId, processingCategory,
  }).filter(([, value]) => value !== undefined));
}

function foregroundJobDirectory({ jobId, rootKind }) {
  if (!/^[a-zA-Z0-9._-]+$/.test(jobId || '')) throw new Error('无效任务标识');
  if (rootKind === 'poster') return path.join(posterJobsDirectory, jobId);
  if (rootKind === 'ui' || rootKind === undefined) return path.join(jobsDirectory, jobId);
  throw new Error('无效 foreground 根类型');
}

async function isWorkbenchRunning() {
  try {
    const response = await fetch('http://127.0.0.1:4173/', {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isManagedWorkbenchRunning() {
  try {
    const owner = JSON.parse(await readFile(
      path.join(rootDirectory, 'output', 'workbench-runtime', 'manager-owner.json'),
      'utf8',
    ));
    return owner.version === 3
      && processIsAlive(owner.pid)
      && await isWorkbenchRunning()
      && owner.workbench?.mode === 'embedded_app';
  } catch {
    return false;
  }
}

async function ensureWorkbenchRunning() {
  if (await isManagedWorkbenchRunning()) return;
  if (await isWorkbenchRunning()) {
    throw new Error('4173 端口上存在未受管理的旧工作台，请先关闭旧进程再重新打开');
  }

  const child = spawn(process.execPath, [
    path.join(rootDirectory, 'scripts', 'start-workbench.mjs'),
    '--host',
    '127.0.0.1',
    '--port',
    '4173',
  ], {
    cwd: rootDirectory,
    detached: true,
    env: process.env,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await isManagedWorkbenchRunning()) return;
  }

  throw new Error('Imvia Layer workbench did not start on http://127.0.0.1:4173/.');
}

async function requestWorkbenchJson(pathname, options = {}, allowedStatuses = []) {
  await ensureWorkbenchRunning();
  const response = await fetch(`${workbenchOrigin}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !allowedStatuses.includes(response.status)) {
    throw new Error(body.error || `Imvia Layer 请求失败：HTTP ${response.status}`);
  }
  return body;
}

const appToolMeta = {
  ui: {
    resourceUri: widgetUri,
    visibility: ['app'],
  },
};

const bridgeToolMeta = {
  ui: {
    resourceUri: bridgeWidgetUri,
    visibility: ['app'],
  },
};

// The poster adapter runs inside the visible Codex task. Its first action is
// to acknowledge the exact poster dispatch before any generation starts, so
// this one lifecycle tool must be visible to the model as well as the bridge.
const posterDispatchToolMeta = {
  ui: {
    resourceUri: bridgeWidgetUri,
    visibility: ['model', 'app'],
  },
};

export function createLayerReviewBridgeServer({
  environment = process.env,
  requestWorkbenchJsonImpl = requestWorkbenchJson,
} = {}) {
  const server = new McpServer({
    name: 'layer-review-workbench',
    version: '1.0.0',
  });

  registerAppResource(
    server,
    'imvia-layer-native-canvas',
    widgetUri,
    {},
    async () => ({
      contents: [{
        uri: widgetUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: await buildWorkbenchWidgetHtml(
          path.join(rootDirectory, 'dist', 'index.html'),
        ),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: {
              connectDomains: [workbenchDomain],
              resourceDomains: widgetResourceDomains,
            },
          },
          'openai/widgetDescription': 'Imvia Layer 原生 fullscreen 图层画布。提交拆分后，请在桥接卡片点击发送并确认，任务才会进入当前 Codex 会话。',
          'openai/widgetCSP': {
            connect_domains: [workbenchDomain],
            resource_domains: widgetResourceDomains,
          },
        },
      }],
    }),
  );
  registerAppResource(
    server,
    'imvia-layer-legacy-conversation-bridge',
    bridgeWidgetUri,
    {},
    async () => ({
      contents: [{
        uri: bridgeWidgetUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: await buildBridgeWidgetHtml(
          bridgeWidgetHtmlPath,
          bridgeWidgetScriptPath,
        ),
        _meta: {
          ui: {
            prefersBorder: false,
          },
          'openai/widgetDescription': 'Imvia Layer 旧版会话桥接兼容卡片。',
        },
      }],
    }),
  );

  const toolDefinition = {
    title: '打开 Imvia Layer 右侧工作台',
    description: 'Use this when the user asks to open or use Imvia Layer. Return the workbench URL and mount the lightweight conversation bridge. The host must open the URL with codex_app__open_in_codex using placement right and target type browser. Do not render the full workbench as an inline or fullscreen MCP App. Split actions must appear in the current Codex conversation before execution.',
    inputSchema: {},
    outputSchema: {
      state: z.literal('ready'),
      workbenchUrl: z.string(),
      workbenchSessionId: z.string(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false,
    },
    _meta: {
      ui: {
        resourceUri: bridgeWidgetUri,
        visibility: ['model', 'app'],
      },
      'ui/resourceUri': bridgeWidgetUri,
      'openai/outputTemplate': bridgeWidgetUri,
      'openai/widgetAccessible': true,
      'openai/toolInvocation/invoking': '正在打开 Imvia Layer 右侧工作台…',
      'openai/toolInvocation/invoked': 'Imvia Layer 右侧工作台已打开',
    },
  };
  const toolHandler = async () => {
    const reopenedAt = new Date().toISOString();
    await withDirectoryLock(
      path.join(outputDirectory, 'workbench-runtime', '.submission.lock'),
      async () => {
        await resetWorkbenchForOpen(outputDirectory, reopenedAt);
        await resetPosterDispatchesForOpen(posterJobsDirectory, reopenedAt);
      },
      { timeoutMs: 10_000 },
    );
    const session = await requestWorkbenchJson('/api/layer-review/workbench-session');
    return {
      content: [{
        type: 'text',
        text: 'Imvia Layer 右侧工作台已就绪。请在当前任务中打开返回的工作台地址；提交拆分后，请在桥接卡片点击“发送到 Codex”并确认。',
      }],
      structuredContent: {
        state: 'ready',
        workbenchUrl: `${workbenchOrigin}/?open=${encodeURIComponent(randomUUID())}`,
        workbenchSessionId: session.workbench_session_id,
      },
    };
  };

  registerAppTool(server, 'connect_layer_review_workbench', toolDefinition, toolHandler);
  registerAppTool(server, 'open_layer_review_workbench', toolDefinition, toolHandler);
  registerAppTool(server, 'register_layer_review_conversation_bridge', {
    title: '连接当前任务监听器',
    description: 'Register the lightweight Imvia Layer listener for this Codex task.',
    inputSchema: {
      bridgeId: z.string(),
      connectedAt: z.string(),
      workbenchSessionId: z.string(),
    },
    outputSchema: {
      active: z.boolean(),
      bridgeId: z.string(),
      connectedAt: z.string(),
      lastSeen: z.string(),
      workbenchSessionId: z.string(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: bridgeToolMeta,
  }, async ({ bridgeId, connectedAt, workbenchSessionId }) => {
    const presence = await activateConversationBridge(
      outputDirectory,
      bridgeId,
      connectedAt,
      { workbenchSessionId },
    );
    return {
      content: [],
      structuredContent: presence,
    };
  });
  registerAppTool(server, 'heartbeat_layer_review_conversation_bridge', {
    title: '维持当前任务监听',
    description: 'Refresh the Imvia Layer listener while this current-task App card remains mounted.',
    inputSchema: {
      bridgeId: z.string(),
      workbenchSessionId: z.string(),
    },
    outputSchema: {
      active: z.boolean(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: bridgeToolMeta,
  }, async ({ bridgeId, workbenchSessionId }) => {
    const active = await markConversationBridgeHeartbeat(
      outputDirectory,
      bridgeId,
      new Date().toISOString(),
      { workbenchSessionId },
    );
    return {
      content: [],
      structuredContent: { active },
    };
  });
  registerAppTool(server, 'get_layer_review_foreground_dispatch', {
    title: '读取下一个拆分消息',
    description: 'Claim the next Imvia Layer split request for the current Codex task.',
    inputSchema: {
      bridgeId: z.string(),
      workbenchSessionId: z.string(),
    },
    outputSchema: {
      active: z.boolean(),
      queue: z.object({
        count: z.number().int().nonnegative(),
        jobIds: z.array(z.string()),
      }),
      dispatch: z.union([
        z.object({
          jobId: z.string(),
          prompt: z.string(),
          submittedAt: z.string(),
          bridgeId: z.string(),
          workbenchSessionId: z.string(),
          claimToken: z.string(),
          claimedAt: z.string(),
          leaseExpiresAt: z.string(),
          taskKind: z.string(),
          rootKind: z.enum(['ui', 'poster']),
          dispatchId: z.string(),
        }),
        z.null(),
      ]),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false,
    },
    _meta: bridgeToolMeta,
  }, async ({ bridgeId, workbenchSessionId }) => {
    const active = await markConversationBridgeHeartbeat(
      outputDirectory,
      bridgeId,
      new Date().toISOString(),
      { workbenchSessionId },
    );
    const dispatch = active
      ? await claimNextForegroundDispatchFromRoots([jobsDirectory, posterJobsDirectory], {
          bridgeId,
          workbenchSessionId,
      })
      : null;
    const queue = active
      ? await readForegroundQueueSummaryFromRoots([jobsDirectory, posterJobsDirectory], { bridgeId, workbenchSessionId })
      : { count: 0, jobIds: [] };
    return {
      content: [],
      structuredContent: { active, dispatch, queue },
    };
  });
  registerAppTool(server, 'mark_layer_review_foreground_dispatch_delivered', {
    title: '记录宿主已接收拆分请求',
    description: 'Record transport acceptance only; this does not confirm that the current Codex task displayed the message.',
    inputSchema: {
      jobId: z.string(),
      dispatchId: z.string(),
      rootKind: z.enum(['ui', 'poster']),
      bridgeId: z.string(),
      workbenchSessionId: z.string(),
      claimToken: z.string(),
    },
    outputSchema: {
      ok: z.literal(true),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: bridgeToolMeta,
  }, async ({
    jobId,
    dispatchId,
    rootKind,
    bridgeId,
    workbenchSessionId,
    claimToken,
  }) => {
    const active = await markConversationBridgeHeartbeat(
      outputDirectory,
      bridgeId,
      new Date().toISOString(),
      { workbenchSessionId },
    );
    if (!active) throw new Error('当前会话监听已失效');
    await markForegroundDispatchDelivered(foregroundJobDirectory({ jobId, rootKind }), {
      bridgeId,
      claimToken,
      dispatchId,
      rootKind,
    });
    return {
      content: [],
      structuredContent: { ok: true },
    };
  });
  registerAppTool(server, 'release_layer_review_foreground_dispatch_claim', {
    title: '释放拆分消息',
    description: 'Release a claimed Imvia Layer request after a delivery failure.',
    inputSchema: {
      jobId: z.string(),
      dispatchId: z.string(),
      rootKind: z.enum(['ui', 'poster']),
      bridgeId: z.string(),
      workbenchSessionId: z.string(),
      claimToken: z.string(),
      error: z.string().optional(),
    },
    outputSchema: {
      ok: z.boolean(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: bridgeToolMeta,
  }, async ({
    jobId,
    dispatchId,
    rootKind,
    bridgeId,
    workbenchSessionId,
    claimToken,
    error,
  }) => {
    const active = await markConversationBridgeHeartbeat(
      outputDirectory,
      bridgeId,
      new Date().toISOString(),
      { workbenchSessionId },
    );
    if (!active) {
      return {
        content: [],
        structuredContent: { ok: false },
      };
    }
    const ok = await releaseForegroundDispatchClaim(
      foregroundJobDirectory({ jobId, rootKind }),
      {
        bridgeId,
        claimToken,
        error,
        dispatchId,
        rootKind,
      },
    );
    return {
      content: [],
      structuredContent: { ok },
    };
  });
  registerAppTool(server, 'submit_layer_review_job', {
    title: '提交当前拆分任务',
    description: 'Prepare one confirmed Imvia Layer job and return the compact prompt for the current conversation.',
    inputSchema: {
      plan: z.record(z.unknown()),
      delivery: z.enum(['current_conversation', 'conversation_bridge']).optional(),
    },
    outputSchema: {
      submission: z.object({
        job_id: z.string(),
        status: z.string(),
        submitted_at: z.string(),
        skill_name: z.string(),
        delivery_channel: z.enum(['current_conversation', 'conversation_bridge', 'conversation_queue']),
        prompt: z.string().optional(),
        plan_path: z.string().optional(),
        source_path: z.string().optional(),
        output_directory: z.string().optional(),
      }),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false,
    },
    _meta: appToolMeta,
  }, async ({ plan, delivery = 'conversation_bridge' }) => {
    const prepared = await requestWorkbenchJson(
      `/api/layer-review/submit?delivery=${encodeURIComponent(delivery)}`,
      {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(plan),
      },
    );
    return {
      content: [],
      structuredContent: { submission: prepared },
    };
  });
  registerAppTool(server, 'get_layer_review_job', {
    title: '读取拆分任务状态',
    description: 'Read one Imvia Layer job and its returned PNG files.',
    inputSchema: {
      jobId: z.string(),
    },
    outputSchema: {
      job: z.record(z.unknown()),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: appToolMeta,
  }, async ({ jobId }) => {
    const returnedJob = await requestWorkbenchJson(
      `/api/layer-review/jobs/${encodeURIComponent(jobId)}`,
      { cache: 'no-store' },
      [404, 410],
    );
    const job = returnedJob.error
      ? { job_id: jobId, status: 'failed', images: [] }
      : returnedJob;
    return {
      content: [],
      structuredContent: { job },
    };
  });
  registerAppTool(server, 'mark_layer_review_message_sent', {
    title: '记录当前会话已接收拆分消息',
    description: 'Mark a follow-up message posted by the embedded workbench as accepted by the current conversation.',
    inputSchema: {
      jobId: z.string(),
    },
    outputSchema: {
      ok: z.literal(true),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: appToolMeta,
  }, async ({ jobId }) => {
    await markDirectConversationMessageSent(path.join(jobsDirectory, jobId));
    return {
      content: [],
      structuredContent: { ok: true },
    };
  });
  registerAppTool(server, 'mark_layer_review_message_failed', {
    title: '记录当前会话消息失败',
    description: 'Record a failed attempt to post a split request to the current conversation.',
    inputSchema: {
      jobId: z.string(),
      error: z.string().optional(),
    },
    outputSchema: {
      ok: z.literal(true),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: appToolMeta,
  }, async ({ jobId, error }) => {
    await markDirectConversationMessageFailed(
      path.join(jobsDirectory, jobId),
      error,
    );
    return {
      content: [],
      structuredContent: { ok: true },
    };
  });
  registerAppTool(server, 'cancel_layer_review_job', {
    title: '取消待发送拆分任务',
    description: 'Cancel one Imvia Layer job before Codex accepts it.',
    inputSchema: {
      jobId: z.string(),
    },
    outputSchema: {
      ok: z.boolean(),
      status: z.string(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: appToolMeta,
  }, async ({ jobId }) => {
    const result = await requestWorkbenchJson(
      `/api/layer-review/foreground-dispatch/${encodeURIComponent(jobId)}/cancel`,
      { method: 'POST' },
    );
    return {
      content: [],
      structuredContent: result,
    };
  });
  registerAppTool(server, 'abandon_layer_review_job', {
    title: '放弃当前拆分任务并释放队列',
    description: 'Mark one already-started Imvia Layer job as abandoned locally. This releases the workbench queue but does not interrupt the active Codex turn.',
    inputSchema: {
      jobId: z.string(),
    },
    outputSchema: {
      ok: z.boolean(),
      status: z.string(),
      codex_turn_may_continue: z.boolean(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: appToolMeta,
  }, async ({ jobId }) => {
    const result = await requestWorkbenchJson(
      `/api/layer-review/foreground-dispatch/${encodeURIComponent(jobId)}/abandon`,
      { method: 'POST' },
    );
    return {
      content: [],
      structuredContent: result,
    };
  });
  registerAppTool(server, 'confirm_layer_review_foreground_dispatch', {
    title: '确认当前任务已接收拆分消息',
    description: 'Call this immediately after an Imvia Layer split request appears in the current Codex task.',
    inputSchema: {
      jobId: z.string(),
      dispatchId: z.string().optional(),
      rootKind: z.literal('ui').optional(),
    },
    outputSchema: {
      ok: z.literal(true),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: {
      ui: {
        visibility: ['model', 'app'],
      },
    },
  }, async ({ jobId, dispatchId, rootKind }) => {
    const jobDirectory = path.join(jobsDirectory, jobId);
    try {
      await acknowledgeForegroundDispatch(
        jobDirectory,
        new Date().toISOString(),
        { confirmationSource: 'codex_model_tool', dispatchId, rootKind },
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await acknowledgeDirectConversationMessage(
        jobDirectory,
        new Date().toISOString(),
        { confirmationSource: 'codex_model_tool' },
      );
    }
    return {
      content: [],
      structuredContent: { ok: true },
    };
  });

  const posterJobSchema = z.record(z.unknown());
  // Existing poster roots are still claimable by the generic bridge while the
  // entry flag is off, so their owner must retain read and release controls.
  registerAppTool(server, 'get_poster_layer_job', {
    title: '读取海报分层任务', description: 'Read the authoritative poster plan and manifest.',
    inputSchema: { jobId: z.string(), dispatchId: z.string().optional() }, outputSchema: { job: posterJobSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, _meta: appToolMeta,
  }, async ({ jobId, dispatchId }) => ({ content: [], structuredContent: { job: await requestWorkbenchJson(
    dispatchId
      ? `/api/poster-layer/jobs/${encodeURIComponent(jobId)}/dispatches/${encodeURIComponent(dispatchId)}`
      : `/api/poster-layer/jobs/${encodeURIComponent(jobId)}`,
    { cache: 'no-store' },
  ) } }));
  for (const [toolName, suffix, title] of [
    ['cancel_poster_layer_job', 'cancel', '取消待发送海报任务'],
    ['abandon_poster_layer_job', 'abandon', '放弃运行中的海报任务'],
  ]) {
    registerAppTool(server, toolName, {
      title, description: 'Release local foreground ownership; an active Codex turn may continue and late results are ignored.',
      inputSchema: { jobId: z.string(), dispatchId: z.string(), rootKind: z.literal('poster') }, outputSchema: posterJobSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true }, _meta: appToolMeta,
    }, async ({ jobId, dispatchId, rootKind }) => ({ content: [], structuredContent: await requestWorkbenchJson(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/${suffix}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dispatchId, rootKind }),
    }) }));
  }
  registerAppTool(server, 'confirm_poster_foreground_dispatch', {
    title: '确认当前任务已接收海报消息', description: 'Confirm that the visible poster task message reached this Codex task.',
    inputSchema: { jobId: z.string(), dispatchId: z.string(), rootKind: z.literal('poster') }, outputSchema: { ok: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true }, _meta: posterDispatchToolMeta,
  }, async ({ jobId, dispatchId, rootKind }) => ({ content: [], structuredContent: await requestWorkbenchJson(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/confirm-dispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dispatchId, rootKind }) }) }));

  if (isExecutionFeatureEnabled('poster_layering_mode', environment)) {
  const posterMutationMeta = { ...appToolMeta };
  registerAppTool(server, 'submit_poster_layer_analysis', {
    title: '提交海报分层分析',
    description: 'Queue a poster ownership analysis in the current visible Codex conversation.',
    inputSchema: { plan: posterJobSchema }, outputSchema: posterJobSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: posterMutationMeta,
  }, async ({ plan }) => ({ content: [], structuredContent: await requestWorkbenchJson('/api/poster-layer/jobs/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }),
  }) }));
  registerAppTool(server, 'submit_poster_layer_candidate', {
    title: '提交海报图层候选',
    description: 'Queue exactly one explicitly authorized poster layer candidate in the current visible conversation.',
    inputSchema: {
      jobId: z.string(), layerIndex: z.number().int().positive(), explicitAuthorization: z.boolean().optional(),
      // The current fast workbench sends this existing spelling; Vite enforces
      // the same explicit-authorization requirement after the proxy forwards it.
      explicit_authorization: z.boolean().optional(),
      expectedManifestRevision: z.number().int().positive(), planVersion: z.number().int().positive(),
      planningMode: z.string().optional(), layerSnapshot: z.record(z.unknown()).optional(),
      snapshotId: z.string().optional(), authorizationId: z.string().optional(),
      processingCategory: z.string().optional(),
    }, outputSchema: posterJobSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: posterMutationMeta,
  }, async ({
    jobId, layerIndex, explicitAuthorization, explicit_authorization,
    expectedManifestRevision, planVersion, planningMode, layerSnapshot, snapshotId,
    authorizationId, processingCategory,
  }) => ({
    content: [], structuredContent: await requestWorkbenchJsonImpl(
      `/api/poster-layer/jobs/${encodeURIComponent(jobId)}/candidates/${layerIndex}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(
        buildPosterCandidateSubmissionPayload({
          explicitAuthorization, explicit_authorization, expectedManifestRevision, planVersion,
          planningMode, layerSnapshot, snapshotId, authorizationId, processingCategory,
        }),
      ) },
    ),
  }));
  registerAppTool(server, 'update_poster_layer_plan', {
    title: '更新海报分层计划', description: 'Update a poster plan using its expected manifest revision.',
    inputSchema: { jobId: z.string(), plan: posterJobSchema, expectedManifestRevision: z.number().int().positive() }, outputSchema: posterJobSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false }, _meta: posterMutationMeta,
  }, async ({ jobId, plan, expectedManifestRevision }) => ({ content: [], structuredContent: await requestWorkbenchJson(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/plan`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan, expectedManifestRevision }),
  }) }));
  registerAppTool(server, 'confirm_poster_layer_plan', {
    title: '确认海报分层计划', description: 'Lock the reviewed poster plan using its expected manifest revision.',
    inputSchema: { jobId: z.string(), expectedManifestRevision: z.number().int().positive() }, outputSchema: posterJobSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false }, _meta: posterMutationMeta,
  }, async ({ jobId, expectedManifestRevision }) => ({ content: [], structuredContent: await requestWorkbenchJson(`/api/poster-layer/jobs/${encodeURIComponent(jobId)}/plan/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedManifestRevision }),
  }) }));
  registerAppTool(server, 'accept_poster_layer_candidate', {
    title: '接受海报图层候选',
    description: 'Normalize and publish the exact reviewed candidate as the accepted canonical layer.',
    inputSchema: {
      jobId: z.string(), layerIndex: z.number().int().positive(), candidateId: z.string(),
      expectedManifestRevision: z.number().int().positive(),
    },
    outputSchema: posterJobSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: posterMutationMeta,
  }, async ({ jobId, layerIndex, candidateId, expectedManifestRevision }) => ({
    content: [], structuredContent: await requestWorkbenchJson(
      `/api/poster-layer/jobs/${encodeURIComponent(jobId)}/layers/${layerIndex}/accept`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId, expectedManifestRevision }) },
    ),
  }));
  registerAppTool(server, 'authorize_poster_layer_retry', {
    title: '授权海报图层重试',
    description: 'Record one explicit retry authorization without queueing or starting generation.',
    inputSchema: {
      jobId: z.string(), layerIndex: z.number().int().positive(),
      expectedManifestRevision: z.number().int().positive(),
    },
    outputSchema: posterJobSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: posterMutationMeta,
  }, async ({ jobId, layerIndex, expectedManifestRevision }) => ({
    content: [], structuredContent: await requestWorkbenchJson(
      `/api/poster-layer/jobs/${encodeURIComponent(jobId)}/layers/${layerIndex}/retry`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedManifestRevision }) },
    ),
  }));
  registerAppTool(server, 'reauthorize_poster_audit_layer', {
    title: '重新授权审计冲突图层',
    description: 'Archive one accepted layer implicated by the current failed audit and create a fresh explicit retry authorization.',
    inputSchema: {
      jobId: z.string(), layerIndex: z.number().int().positive(),
      expectedManifestRevision: z.number().int().positive(),
    },
    outputSchema: posterJobSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: posterMutationMeta,
  }, async ({ jobId, layerIndex, expectedManifestRevision }) => ({
    content: [], structuredContent: await requestWorkbenchJson(
      `/api/poster-layer/jobs/${encodeURIComponent(jobId)}/layers/${layerIndex}/audit-remediation`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedManifestRevision }) },
    ),
  }));
  registerAppTool(server, 'run_poster_recomposition_audit', {
    title: '运行海报重组审计',
    description: 'Audit the exact accepted full-canvas layers and record a revision-bound recomposition result.',
    inputSchema: {
      jobId: z.string(), expectedManifestRevision: z.number().int().positive(),
    },
    outputSchema: posterJobSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: posterMutationMeta,
  }, async ({ jobId, expectedManifestRevision }) => ({
    content: [], structuredContent: await requestWorkbenchJson(
      `/api/poster-layer/jobs/${encodeURIComponent(jobId)}/audit`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedManifestRevision }) },
    ),
  }));
  }
  return server;
}

const port = Number(process.env.LAYER_REVIEW_MCP_PORT || 4174);
const mcpPath = '/mcp';
const httpServer = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  if (request.method === 'OPTIONS' && url.pathname === mcpPath) {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, mcp-session-id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    });
    response.end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Imvia Layer MCP App');
    return;
  }
  if (url.pathname === mcpPath && ['POST', 'GET', 'DELETE'].includes(request.method || '')) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    const server = createLayerReviewBridgeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) response.writeHead(500).end('Internal server error');
    }
    return;
  }
  response.writeHead(404).end('Not Found');
});

if (process.env.IMVIA_LAYER_MCP_TEST_MODE !== '1') {
  if (process.argv.includes('--stdio')) {
    const server = createLayerReviewBridgeServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else {
    httpServer.listen(port, '127.0.0.1', () => {
      console.log(`Imvia Layer MCP App listening on http://127.0.0.1:${port}${mcpPath}`);
    });
  }
}
