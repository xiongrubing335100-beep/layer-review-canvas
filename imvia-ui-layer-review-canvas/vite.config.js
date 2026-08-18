import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildWorkbenchPrompt,
  readCodexTurnStatus,
} from './codex-thread-bridge.mjs';
import { completionTimestamp, markTiming, mergeTiming } from './src/execution-timing.js';
import {
  cancelDirectConversationJob,
  markDirectConversationMessageFailed,
  markDirectConversationMessageSent,
  cancelForegroundDispatch,
  enqueueForegroundDispatch,
  readNextForegroundDispatch,
} from './src/foreground-dispatch.js';
import { withDirectoryLock } from './src/file-lock.js';
import { readConversationBridgePresence } from './src/conversation-bridge-presence.js';
import { reconcileTurnStatus, resolveExecutionReportStatus } from './src/job-state.js';
import { resolveSubmissionDeliveryMode } from './src/submission-delivery.js';
import { assertPlanSize, normalizeSubmissionPayload } from './src/submission-normalizer.js';
import { isExecutionFeatureEnabled } from './src/execution-features.js';
import { shouldHideAbandonedJob } from './src/workbench-lifecycle.js';
import {
  findBlockingJob,
  heartbeatPageLease,
  readDiscardedJob,
  readLifecycleRecords,
  suspectPageLeaseClosed,
  writeLifecycleRecord,
} from './src/workbench-lifecycle-store.js';

const IMVIA_COPYRIGHT_BANNER = '/*! Imvia Layer © 2026 青木 — Personal non-commercial use only; commercial license required. */';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));
const splitSkillPath = path.resolve(
  process.env.IMVIA_LAYER_SKILL_PATH
    || path.join(repositoryRoot, 'plugin-template', 'imvia-layer', 'skills', 'split-ui-design-layers-workbench-targeted', 'SKILL.md'),
);
const sourcePreviews = new Map();
// The lifecycle manager owns this ID so the Vite server and MCP App card keep
// the same current-task binding across a managed restart.
const workbenchSessionId = process.env.IMVIA_WORKBENCH_SESSION_ID || crypto.randomUUID();

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readBinaryBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('图片不能超过 32 MB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readExecutionReport(jobDirectory) {
  try {
    return JSON.parse(await readFile(path.join(jobDirectory, 'execution-report.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function layerReviewQueue() {
  return {
    name: 'layer-review-queue',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        if (!pathname.startsWith('/api/layer-review/')) {
          next();
          return;
        }
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (request.method === 'OPTIONS') {
          response.statusCode = 204;
          response.end();
          return;
        }
        next();
      });

      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        const previewMatch = pathname.match(/^\/api\/layer-review\/source-preview\/([a-f0-9-]+)$/);
        const isPreviewUpload = pathname === '/api/layer-review/source-preview';
        if (!isPreviewUpload && !previewMatch) {
          next();
          return;
        }

        try {
          if (isPreviewUpload && request.method === 'POST') {
            const mimeType = String(request.headers['content-type'] || '').split(';')[0];
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
              throw new Error('仅支持 PNG、JPG 或 WebP 图片');
            }
            const data = await readBinaryBody(request);
            if (!data.length) throw new Error('图片内容为空');
            const id = crypto.randomUUID();
            sourcePreviews.set(id, { data, mimeType });
            while (sourcePreviews.size > 8) {
              sourcePreviews.delete(sourcePreviews.keys().next().value);
            }
            response.statusCode = 201;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.end(JSON.stringify({
              url: `/api/layer-review/source-preview/${id}`,
            }));
            return;
          }

          if (previewMatch && request.method === 'GET') {
            const preview = sourcePreviews.get(previewMatch[1]);
            if (!preview) {
              response.statusCode = 404;
              response.end();
              return;
            }
            response.statusCode = 200;
            response.setHeader('Content-Type', preview.mimeType);
            response.setHeader('Cache-Control', 'no-store');
            response.end(preview.data);
            return;
          }

          response.statusCode = 405;
          response.end();
        } catch (error) {
          response.statusCode = 400;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: error.message }));
        }
      });

      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        const isPageLease = pathname === '/api/layer-review/page-lease';
        if (!isPageLease) {
          next();
          return;
        }

        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.setHeader('Cache-Control', 'no-store');
        if (request.method === 'OPTIONS') {
          response.statusCode = 204;
          response.end();
          return;
        }
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end();
          return;
        }

        try {
          const payload = await readJsonBody(request);
          if (!/^[a-zA-Z0-9._-]{1,128}$/.test(payload.pageId || '')) {
            throw new Error('无效页面租约');
          }
          const outputDirectory = path.resolve(process.cwd(), 'output');
          if (payload.event === 'close') {
            await suspectPageLeaseClosed(outputDirectory, { pageId: payload.pageId });
          } else {
            await heartbeatPageLease(outputDirectory, { pageId: payload.pageId });
          }
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ ok: true }));
        } catch (error) {
          response.statusCode = 400;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: error.message }));
        }
      });

      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        const cancelMatch = pathname.match(/^\/api\/layer-review\/foreground-dispatch\/([a-zA-Z0-9._-]+)\/cancel$/);
        const isQueueRead = pathname === '/api/layer-review/foreground-dispatch';
        const isBridgeStatus = pathname === '/api/layer-review/bridge-status';
        const isWorkbenchSession = pathname === '/api/layer-review/workbench-session';
        if (!isQueueRead && !isBridgeStatus && !isWorkbenchSession && !cancelMatch) {
          next();
          return;
        }

        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.setHeader('Cache-Control', 'no-store');
        if (request.method === 'OPTIONS') {
          response.statusCode = 204;
          response.end();
          return;
        }

        try {
          const jobsDirectory = path.resolve(process.cwd(), 'output', 'jobs');
          if (isWorkbenchSession && request.method === 'GET') {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({
              workbench_session_id: workbenchSessionId,
            }));
            return;
          }
          if (isBridgeStatus && request.method === 'GET') {
            const presence = await readConversationBridgePresence(
              path.resolve(process.cwd(), 'output'),
              { workbenchSessionId },
            );
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({
              online: presence.online,
              last_seen: presence.lastSeen,
              bridge_id: presence.bridgeId,
              workbench_session_id: workbenchSessionId,
            }));
            return;
          }
          if (isQueueRead && request.method === 'GET') {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({
              dispatch: await readNextForegroundDispatch(jobsDirectory),
            }));
            return;
          }
          if (cancelMatch && request.method === 'POST') {
            const jobDirectory = path.join(jobsDirectory, cancelMatch[1]);
            try {
              await cancelForegroundDispatch(jobDirectory, new Date().toISOString());
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              await cancelDirectConversationJob(jobDirectory, new Date().toISOString());
            }
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({ ok: true, status: 'cancelled' }));
            return;
          }
          response.statusCode = 405;
          response.end();
        } catch (error) {
          response.statusCode = error.code === 'ENOENT' ? 404 : 500;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: error.message }));
        }
      });

      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        const messageSentMatch = pathname.match(/^\/api\/layer-review\/jobs\/([a-zA-Z0-9._-]+)\/message-sent$/);
        const messageFailedMatch = pathname.match(/^\/api\/layer-review\/jobs\/([a-zA-Z0-9._-]+)\/message-failed$/);
        if (messageSentMatch || messageFailedMatch) {
          if (request.method !== 'POST') {
            response.statusCode = 405;
            response.end();
            return;
          }
          try {
            const jobId = messageSentMatch?.[1] || messageFailedMatch?.[1];
            const jobDirectory = path.resolve(process.cwd(), 'output', 'jobs', jobId);
            if (messageSentMatch) {
              await markDirectConversationMessageSent(jobDirectory);
            } else {
              const payload = await readJsonBody(request).catch(() => ({}));
              await markDirectConversationMessageFailed(jobDirectory, payload.error);
            }
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.end(JSON.stringify({ ok: true }));
          } catch (error) {
            response.statusCode = error.code === 'ENOENT' ? 404 : 409;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({ error: error.message }));
          }
          return;
        }
        if (request.method !== 'GET') {
          next();
          return;
        }

        const statusMatch = pathname.match(/^\/api\/layer-review\/jobs\/([a-zA-Z0-9._-]+)$/);
        const fileMatch = pathname.match(/^\/api\/layer-review\/jobs\/([a-zA-Z0-9._-]+)\/files\/([^/]+)$/);
        if (!statusMatch && !fileMatch) {
          next();
          return;
        }

        try {
          const jobId = statusMatch?.[1] || fileMatch?.[1];
          const rootOutputDirectory = path.resolve(process.cwd(), 'output');
          const tombstone = await readDiscardedJob(rootOutputDirectory, jobId);
          const lifecycle = (await readLifecycleRecords(rootOutputDirectory))[jobId] || null;
          if (tombstone || shouldHideAbandonedJob({ lifecycleStatus: lifecycle?.status })) {
            response.statusCode = 410;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.end(JSON.stringify({ job_id: jobId, status: 'discarded' }));
            return;
          }
          const jobDirectory = path.resolve(rootOutputDirectory, 'jobs', jobId);
          const outputDirectory = path.join(jobDirectory, 'final');

          if (fileMatch) {
            const fileName = decodeURIComponent(fileMatch[2]);
            if (path.basename(fileName) !== fileName || !fileName.toLowerCase().endsWith('.png')) throw new Error('无效结果文件');
            const image = await readFile(path.join(outputDirectory, fileName));
            response.statusCode = 200;
            response.setHeader('Content-Type', 'image/png');
            response.setHeader('Cache-Control', 'no-store');
            response.end(image);
            return;
          }

          const plan = JSON.parse(await readFile(path.join(jobDirectory, 'layer-review-plan.json'), 'utf8'));
          const executionReport = await readExecutionReport(jobDirectory);
          const files = await readdir(outputDirectory).catch(() => []);
          const imageNames = files
            .filter((fileName) => fileName.toLowerCase().endsWith('.png'))
            .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
          const imageStats = await Promise.all(imageNames.map((fileName) => stat(path.join(outputDirectory, fileName))));
          const images = imageNames.map((fileName, index) => ({
              name: fileName,
              url: `/api/layer-review/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(fileName)}?v=${Math.trunc(imageStats[index].mtimeMs)}`,
            }));
          const layerSnapshots = Object.fromEntries((plan.layers || []).map((layer) => [layer.id, {
            bounds: layer.review_snapshot?.bounds || layer.source_region_percent,
            sourceRegionPixels: layer.review_snapshot?.source_region_pixels || layer.source_region_pixels,
          }]));
          const expectedCount = Array.isArray(plan.layers) ? plan.layers.length : 0;
           const resultReady = expectedCount > 0 && images.length === expectedCount;
          const reportStatus = resolveExecutionReportStatus(executionReport, {
            expectedCount,
            resultReady,
          });
          const planStatus = ['completed', 'failed', 'needs_confirmation'].includes(reportStatus)
            ? reportStatus
            : plan.status || 'processing';
          let codexTurn = null;
          if (
            plan.codex_thread_id
            && plan.codex_turn_id
            && !['completed', 'failed', 'send_failed', 'needs_confirmation', 'cancelled'].includes(planStatus)
          ) {
            try {
              codexTurn = await readCodexTurnStatus(plan.codex_thread_id, plan.codex_turn_id);
            } catch {
              // Keep the persisted status while the local Codex bridge reconnects.
            }
          }
          const reconciled = reconcileTurnStatus({
            planStatus,
            reportStatus,
            reportError: executionReport?.error || null,
            turnStatus: codexTurn?.status || null,
            resultReady,
            imageCount: images.length,
          });
          const status = reconciled.status;
          const timing = mergeTiming(plan.execution_timing, executionReport?.timing);
          const completedAt = completionTimestamp({
            status,
            timing,
            planCompletedAt: plan.codex_completed_at,
            turnCompletedAt: codexTurn?.completedAt,
            imageCompletedAt: imageStats.length
              ? new Date(Math.max(...imageStats.map((item) => item.mtimeMs))).toISOString()
              : null,
            fallbackCompletedAt: new Date().toISOString(),
          });

          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify({
            job_id: jobId,
            status,
            expected_count: expectedCount,
            images,
            layer_snapshots: layerSnapshots,
            source_size: plan.review_source_size || plan.source?.canvas || null,
            source_name: plan.source?.file_name || null,
            project_id: plan.project_id || null,
            image_id: plan.image_id || plan.source?.image_id || null,
            source_fingerprint: plan.source_fingerprint || plan.source?.source_fingerprint || null,
            source_revision: plan.source_revision || plan.source?.source_revision || null,
            submitted_at: plan.submitted_at || null,
            completed_at: completedAt,
            status_detail: reconciled.detail || plan.send_error || null,
            thread_id: plan.codex_thread_id || null,
            turn_id: plan.codex_turn_id || null,
            skill_name: path.basename(path.dirname(plan.execution?.skill_path || splitSkillPath)),
            timing,
            execution_route: executionReport?.execution_route
              || plan.layers?.[0]?.execution_route_hint
              || null,
          }));
        } catch (error) {
          response.statusCode = error.code === 'ENOENT' ? 404 : 500;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: error.message }));
        }
      });

      server.middlewares.use('/api/layer-review/submit', async (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }

        try {
          const rootOutputDirectory = path.resolve(process.cwd(), 'output');
          const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
          const directConversation = requestUrl.searchParams.get('delivery') === 'current_conversation';
          const bridgePresence = await readConversationBridgePresence(rootOutputDirectory, { workbenchSessionId });
          const payload = await readJsonBody(request);
          const jobId = `layer-job-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          const jobsDirectory = path.join(rootOutputDirectory, 'jobs');
          const jobDirectory = path.join(jobsDirectory, jobId);
          const outputDirectory = path.join(jobDirectory, 'final');
          const submission = await withDirectoryLock(
            path.join(rootOutputDirectory, 'workbench-runtime', '.submission.lock'),
            async () => {
              const blockingJob = await findBlockingJob(rootOutputDirectory);
              const queued = Boolean(blockingJob);
              const deliveryMode = directConversation && !queued
                ? 'current_conversation'
                : resolveSubmissionDeliveryMode({
                  conversationBridgeOnline: bridgePresence.online,
                  queued,
                });
              if (deliveryMode === 'unavailable' && !directConversation) return { bridgeUnavailable: true };

              await mkdir(jobDirectory, { recursive: true });
               const { normalizedPayload, sourcePath } = await normalizeSubmissionPayload({
                 payload,
                 jobDirectory,
                 projectRoot: process.cwd(),
               });
               const jobPath = path.join(jobDirectory, 'layer-review-plan.json');
               const submittedAt = new Date().toISOString();
               const job = {
                ...normalizedPayload,
                job_id: jobId,
                status: queued ? 'queued' : 'awaiting_codex_message',
                submitted_at: submittedAt,
                output_directory: outputDirectory,
                execution_timing: markTiming({}, 'submitted_at', submittedAt),
                execution: {
                  skill_path: splitSkillPath,
                  plan_is_authoritative: true,
                  deliver_selected_layers_only: true,
                  auto_add_layers: false,
                   mode_contract: 'per_layer',
                 },
               };
               if (isExecutionFeatureEnabled('compact_plan_v1')) assertPlanSize(job);
               await writeFile(jobPath, JSON.stringify(job, null, 2));
              await writeLifecycleRecord(rootOutputDirectory, jobId, {
                status: 'active',
                createdAt: submittedAt,
              });
              return {
                jobDirectory,
                jobPath,
                submittedAt,
                sourcePath,
                queued,
                deliveryMode,
              };
            },
            { timeoutMs: 10_000 },
          );
          if (submission.bridgeUnavailable) {
            response.statusCode = 503;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({
              error: '会话消息通道离线，请从当前 Codex 任务打开 Imvia Layer 插件',
            }));
            return;
          }
          if (submission.blockingJob) {
            response.statusCode = 409;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({
              error: '当前 Codex 会话仍有拆分任务在执行，请等待当前任务结束',
              blocking_job_id: submission.blockingJob.jobId,
            }));
            return;
          }
          const {
            jobPath,
            submittedAt,
            sourcePath,
            queued,
            deliveryMode,
          } = submission;
          const plan = JSON.parse(await readFile(jobPath, 'utf8'));
          const prompt = buildWorkbenchPrompt({
            jobId,
            jobPath,
            sourcePath,
            outputDirectory,
            plan,
            requireForegroundConfirmation: !directConversation || queued,
          });
          const primaryLayer = plan.layers?.[0] || null;
          const sourceRegion = primaryLayer?.source_region_pixels || {};
          if (!directConversation || queued) {
            try {
              await enqueueForegroundDispatch(jobDirectory, {
                jobId,
                prompt,
                submittedAt,
                targetBridgeId: bridgePresence.bridgeId,
                workbenchSessionId,
                ...(primaryLayer ? {
                  presentation: {
                    layerName: primaryLayer.name || '拆分项',
                    category: primaryLayer.category_label || primaryLayer.category || '',
                    width: sourceRegion.width || null,
                    height: sourceRegion.height || null,
                    removeBackground: Boolean(primaryLayer.remove_background),
                    promptSummary: primaryLayer.requirement || '',
                    previewPath: primaryLayer.review_snapshot?.local_crop_path || null,
                  },
                } : {}),
              });
            } catch (error) {
              const failedAt = new Date().toISOString();
              const latestJob = JSON.parse(await readFile(jobPath, 'utf8'));
              await writeFile(jobPath, JSON.stringify({
                ...latestJob,
                status: 'send_failed',
                send_error: error.message,
              }, null, 2));
              await writeLifecycleRecord(rootOutputDirectory, jobId, {
                status: 'failed',
                failedAt,
              });
              throw error;
            }
          }

          response.statusCode = 202;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({
            job_id: jobId,
            status: queued ? 'queued' : 'awaiting_codex_message',
            submitted_at: submittedAt,
            skill_name: path.basename(path.dirname(splitSkillPath)),
            delivery_channel: deliveryMode,
            ...(directConversation || queued ? {
              prompt,
              plan_path: jobPath,
              source_path: sourcePath,
              output_directory: outputDirectory,
            } : {}),
          }));
        } catch (error) {
          response.statusCode = /正在|active|running/i.test(error.message) ? 409 : 500;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: error.message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), layerReviewQueue()],
  build: {
    rollupOptions: {
      output: {
        banner: IMVIA_COPYRIGHT_BANNER,
        comments: {
          legal: true,
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    cors: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
});
