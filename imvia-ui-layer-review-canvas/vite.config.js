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
  acknowledgeForegroundDispatch,
  cancelDirectConversationJob,
  markDirectConversationMessageFailed,
  markDirectConversationMessageSent,
  abandonForegroundJob,
  cancelForegroundDispatch,
  enqueueForegroundDispatch,
  readNextForegroundDispatchFromRoots,
  readForegroundDispatch,
  withForegroundDispatchLock,
} from './src/foreground-dispatch.js';
import {
  acceptPosterCandidate,
  authorizePosterFastPostprocessRetry,
  authorizePosterRetry,
  createPosterExportArchive,
  initializePosterFastJob,
  initializePosterJob,
  mutatePosterJob,
  PosterJobConflictError,
  readPosterJob,
  recordPosterGenerationFailure,
  reauthorizePosterAuditLayer,
  runPosterRecompositionAudit,
  synchronizeFastPosterManifest,
} from './src/poster-job-store.js';
import { finalizePosterFastRmbgCandidate } from './scripts/finalize-poster-fast-rmbg-candidate.mjs';
import { controlPosterDispatch } from './src/poster-dispatch-control.js';
import { canonicalJson, confirmPosterPlan as confirmPosterPlanState, createPosterPlan, digestCanonicalJson, validatePosterPlan } from './src/poster-plan.js';
import { createFastPosterPlan } from './src/poster-fast-plan.js';
import { assertPosterSourceDimensions } from './src/poster-png.js';
import { storePosterSource } from './src/poster-source-store.js';
import {
  preparePosterJob,
  reconcilePreparedPosterCandidate,
  restoreUnsentPosterCandidateAuthorization,
  rollbackPreparedPosterCandidate,
} from './scripts/prepare-poster-job.mjs';
import { withDirectoryLock } from './src/file-lock.js';
import { readConversationBridgePresence } from './src/conversation-bridge-presence.js';
import { reconcileTurnStatus, resolveExecutionReportStatus } from './src/job-state.js';
import { resolveSubmissionDeliveryMode } from './src/submission-delivery.js';
import { assertPlanSize, normalizeSubmissionPayload } from './src/submission-normalizer.js';
import { isExecutionFeatureEnabled } from './src/execution-features.js';
import { shouldHideAbandonedJob } from './src/workbench-lifecycle.js';
import { readSafePosterCandidatePreview } from './src/poster-candidate-preview.js';
import { selectPosterFastDownloadAsset } from './src/poster-fast-download.js';
import { workbenchV2Middleware } from './src/v2/api.mjs';
import { buildPosterAnalysisPrompt, buildPosterCandidatePrompt, buildPosterTargetedCandidatePrompt } from './src/poster-prompt.js';
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

export function posterPrompt(prepared, { processingCategory, confirmedSnapshotPath } = {}) {
  const targeted = prepared.task_kind === 'poster_candidate' && prepared.planning_mode === 'targeted_fast';
  const envelope = {
    ...prepared,
    dispatchId: prepared.dispatch_id, rootKind: 'poster', taskKind: prepared.task_kind, jobId: prepared.job_id,
    planVersion: prepared.plan_version,
    ...(prepared.layer_index ? { layerIndex: prepared.layer_index, candidateNumber: prepared.candidate_number,
      authorizationId: prepared.authorization_id, planVersion: prepared.plan_version,
      ...(prepared.planning_mode === 'targeted_fast' ? { planningMode: prepared.planning_mode,
        snapshotId: prepared.snapshot_id, sourceFingerprint: prepared.source_fingerprint } : {}) } : {}),
  };
  const taskInstructions = targeted
    ? buildPosterTargetedCandidatePrompt({
      jobId: prepared.job_id, planPath: prepared.authoritative_plan_path || prepared.plan_path,
      snapshotPath: confirmedSnapshotPath || prepared.authoritative_plan_path || prepared.plan_path,
      sourcePath: prepared.source_path, layerIndex: prepared.layer_index,
      candidateNumber: prepared.candidate_number, processingCategory,
    })
    : prepared.task_kind === 'poster_candidate'
    ? buildPosterCandidatePrompt({
      jobId: prepared.job_id, planPath: prepared.authoritative_plan_path || prepared.plan_path,
      layerIndex: prepared.layer_index, candidateNumber: prepared.candidate_number,
    })
    : buildPosterAnalysisPrompt({
      jobId: prepared.job_id, planPath: prepared.plan_path, sourcePath: prepared.source_path,
    });
  if (targeted) {
    return `请先读取并执行已安装的 $imvia-poster-layering-workbench-targeted-v1 适配器。${taskInstructions}\n`
      + `请执行海报任务 ${prepared.job_id} 的可见 ${prepared.task_kind} 工作。`
      + `权威计划位于 ${prepared.authoritative_plan_path || prepared.plan_path}；`
      + `来源图为 ${prepared.source_path}；仅可写入 ${prepared.output_directory}。`
      + `调度信封（必须将每个字段传入最终归档）：${JSON.stringify(envelope)}。`
      + '不得启动隐藏后台任务或自动重试。';
  }
  return `Read and execute the installed $imvia-poster-layering-workbench-v1 adapter before work. ${taskInstructions}\n`
    + `Execute the visible ${prepared.task_kind} task for poster job ${prepared.job_id}. `
    + `Use the authoritative plan at ${prepared.authoritative_plan_path || prepared.plan_path}; `
    + `use source ${prepared.source_path}; write only to ${prepared.output_directory}. `
    + `Dispatch envelope (pass every field to finalization): ${JSON.stringify(envelope)}. `
    + 'Do not start a hidden background task or automatically retry.';
}

async function readReconciledPosterJob(outputRoot, jobId) {
  const existing = await readPosterJob(outputRoot, jobId);
  if (!existing) return null;
  return withPosterCandidateOrchestrationLock(outputRoot, jobId, () =>
    withForegroundDispatchLock(existing.paths.root, () => reconcilePreparedPosterCandidate({ outputRoot, jobId })));
}

function withPosterCandidateOrchestrationLock(outputRoot, jobId, action) {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(jobId)) throw new Error('poster job id is invalid');
  // Keep this lock outside the job package: a GET for an unknown id must not
  // create a directory inside poster-jobs just by attempting to synchronize.
  return withDirectoryLock(path.join(outputRoot, '.poster-candidate-locks', `${jobId}.lock`), action);
}

function posterSourcePath(payload) {
  const value = payload.sourcePath || payload.source_path || payload.plan?.source_path || payload.plan?.source?.path;
  if (typeof value !== 'string' || value.length === 0) throw new Error('海报分析需要 sourcePath');
  const sourcePath = path.resolve(process.cwd(), value);
  if (!sourcePath.startsWith(`${path.resolve(process.cwd())}${path.sep}`)) throw new Error('海报来源文件超出工作区');
  if (path.extname(sourcePath).toLowerCase() !== '.png') throw new Error('海报来源文件必须是 PNG');
  return sourcePath;
}

function posterJobId(payload) {
  const value = payload.jobId || payload.job_id || payload.plan?.job_id;
  return typeof value === 'string' && value.length > 0
    ? value
    : `poster-job-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function targetedFastSnapshot(record, layerIndex, payload) {
  const snapshot = payload.layer_snapshot ?? payload.layerSnapshot;
  const snapshotId = payload.snapshot_id ?? payload.snapshotId;
  const authorizationId = payload.authorization_id ?? payload.authorizationId;
  if (!snapshot || typeof snapshot !== 'object' || snapshot.snapshot_id !== snapshotId
    || snapshot.layer_index !== layerIndex || snapshot.user_confirmed !== true) {
    throw new Error('快速候选需要已确认的目标图层快照');
  }
  const layer = record.plan.layers?.find((entry) => entry?.layer_index === layerIndex);
  const expected = layer?.confirmed_snapshot;
  const snapshotPayload = {
    job_id: snapshot.job_id, plan_version: snapshot.plan_version, layer_index: snapshot.layer_index,
    layer: snapshot.layer, source: snapshot.source,
  };
  if (!expected || canonicalJson(snapshot) !== canonicalJson(expected)
    || snapshot.snapshot_id !== digestCanonicalJson(snapshotPayload)
    || snapshot.plan_version !== record.plan.plan_version
    || canonicalJson(snapshot.source) !== canonicalJson(record.plan.source)
    || snapshot.job_id !== record.plan.job_id
    || snapshot.snapshot_id !== layer.snapshot_id
    || layer.snapshot_user_confirmed !== true) {
    throw new Error('快速候选快照已过期或不完整');
  }
  const candidateNumber = (record.manifest.candidates || []).filter((entry) => entry?.layer_index === layerIndex).length + 1;
  const expectedAuthorization = `${record.plan.job_id}:${record.plan.plan_version}:${layerIndex}:${candidateNumber}`;
  if (authorizationId !== expectedAuthorization) throw new Error('快速候选授权与图层快照不匹配');
  return { snapshot, snapshotId, authorizationId, sourceFingerprint: digestCanonicalJson(record.plan.source) };
}

function posterResponse(record) {
  return {
    job_id: record.plan.job_id,
    status: record.plan.status,
    plan: record.plan,
    manifest: record.manifest,
    report: record.report,
    manifest_revision: record.manifest.revision,
  };
}

export function layerReviewQueue() {
  return {
    name: 'layer-review-queue',
    configureServer(server) {
      server.middlewares.use(workbenchV2Middleware({ root: path.resolve(process.cwd(), 'output', 'workbench-v2', 'documents') }));
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        if (!pathname.startsWith('/api/layer-review/') && !pathname.startsWith('/api/poster-layer/')) {
          next();
          return;
        }
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Poster-Source-Width, X-Poster-Source-Height');
        if (request.method === 'OPTIONS') {
          response.statusCode = 204;
          response.end();
          return;
        }
        next();
      });

      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        const isPosterSourceUpload = pathname === '/api/poster-layer/sources';
        if (!isPosterSourceUpload) {
          next();
          return;
        }
        try {
          if (request.method !== 'POST') {
            response.statusCode = 405;
            response.end();
            return;
          }
          if (String(request.headers['content-type'] || '').split(';')[0] !== 'image/png') {
            throw new Error('海报来源必须为 PNG');
          }
          const width = Number(request.headers['x-poster-source-width']);
          const height = Number(request.headers['x-poster-source-height']);
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
            throw new Error('海报来源尺寸无效');
          }
          const stored = await storePosterSource({
            outputRoot: path.resolve(process.cwd(), 'output'),
            bytes: await readBinaryBody(request),
            expectedSize: { width, height },
          });
          response.statusCode = 201;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ source_path: stored.sourcePath, width: stored.width, height: stored.height }));
        } catch (error) {
          response.statusCode = 400;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: error.message }));
        }
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
        const candidateMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/candidates\/(\d+)$/);
        const candidatePreviewMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/layers\/(\d+)\/candidate-preview$/);
        const candidateDownloadMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/layers\/(\d+)\/candidate-download$/);
        const dispatchMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/dispatches\/([a-zA-Z0-9-]+)$/);
        const jobMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)$/);
        const planMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/plan$/);
        const confirmPlanMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/plan\/confirm$/);
        const acceptMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/layers\/(\d+)\/accept$/);
        const retryMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/layers\/(\d+)\/retry$/);
        const reprocessMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/layers\/(\d+)\/reprocess$/);
        const auditRemediationMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/layers\/(\d+)\/audit-remediation$/);
        const cancelMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/cancel$/);
        const abandonMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/abandon$/);
        const confirmDispatchMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/confirm-dispatch$/);
        const auditMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/audit$/);
        const exportMatch = pathname.match(/^\/api\/poster-layer\/jobs\/([a-zA-Z0-9._-]+)\/export$/);
        const isAnalyze = pathname === '/api/poster-layer/jobs/analyze';
        const isFast = pathname === '/api/poster-layer/jobs/fast';
        if (!isAnalyze && !isFast && !candidateMatch && !candidatePreviewMatch && !candidateDownloadMatch && !dispatchMatch && !jobMatch && !planMatch && !confirmPlanMatch
          && !acceptMatch && !retryMatch && !reprocessMatch && !auditRemediationMatch && !cancelMatch && !abandonMatch && !confirmDispatchMatch && !auditMatch && !exportMatch) {
          next();
          return;
        }
        const rootOutputDirectory = path.resolve(process.cwd(), 'output');
        const posterJobsDirectory = path.join(rootOutputDirectory, 'poster-jobs');
        try {
          if (isFast && request.method === 'POST') {
            if (!isExecutionFeatureEnabled('poster_layering_mode')) {
              throw Object.assign(new Error('海报分层功能当前已关闭'), { statusCode: 403 });
            }
            const payload = await readJsonBody(request);
            if (payload.analysis_dispatch || payload.analysisDispatch || payload.submit_poster_layer_analysis) {
              throw new Error('快速海报任务不允许分析 dispatch');
            }
            const jobId = posterJobId(payload);
            const plan = createFastPosterPlan({ ...payload.plan, job_id: jobId, status: 'PLAN_REVIEW' });
            if (plan.document_mode !== 'poster') throw new Error('快速海报任务仅支持 poster 文档');
            const validation = validatePosterPlan(plan);
            if (!validation.valid) throw new Error(`快速海报计划无效: ${validation.errors.map((error) => error.code).join(', ')}`);
            const sourcePath = posterSourcePath(payload);
            await assertPosterSourceDimensions(sourcePath, plan.source);
            const record = await initializePosterFastJob({
              outputRoot: rootOutputDirectory, jobId, sourcePath, plan,
            });
            response.statusCode = 201;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify(posterResponse(record)));
            return;
          }
          if (isAnalyze && request.method === 'POST') {
            if (!isExecutionFeatureEnabled('poster_layering_mode')) {
              throw Object.assign(new Error('海报分层功能当前已关闭'), { statusCode: 403 });
            }
            const payload = await readJsonBody(request);
            const jobId = posterJobId(payload);
            const plan = createPosterPlan({ ...payload.plan, job_id: jobId, status: 'ANALYZING' });
            const record = await initializePosterJob({
              outputRoot: rootOutputDirectory,
              jobId,
              sourcePath: posterSourcePath(payload),
              plan,
            });
            const dispatchId = crypto.randomUUID();
            const prepared = await preparePosterJob({ outputRoot: rootOutputDirectory, jobId, phase: 'analysis', dispatchId });
            const submittedAt = new Date().toISOString();
            const dispatch = await enqueueForegroundDispatch(record.paths.root, {
              jobId,
              taskKind: 'poster_analysis',
              planPath: record.paths.plan,
              planVersion: prepared.plan_version,
              prompt: posterPrompt(prepared),
              submittedAt,
              workbenchSessionId,
              dispatchId,
            });
            response.statusCode = 202;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({
              job_id: jobId, status: 'queued', submitted_at: submittedAt,
              task_kind: 'poster_analysis', rootKind: 'poster', dispatch_id: dispatch.dispatchId, plan_path: record.paths.plan,
            }));
            return;
          }
          if (candidateMatch && request.method === 'POST') {
            if (!isExecutionFeatureEnabled('poster_layering_mode')) {
              throw Object.assign(new Error('海报分层功能当前已关闭'), { statusCode: 403 });
            }
            const payload = await readJsonBody(request);
            const jobId = candidateMatch[1];
            const layerIndex = Number(candidateMatch[2]);
            const jobDirectory = path.join(posterJobsDirectory, jobId);
            let dispatch;
            let submittedAt;
            await withPosterCandidateOrchestrationLock(rootOutputDirectory, jobId, async () => {
              let record = await readPosterJob(rootOutputDirectory, jobId);
              if (record) record = await withForegroundDispatchLock(record.paths.root, () =>
                reconcilePreparedPosterCandidate({ outputRoot: rootOutputDirectory, jobId }));
              if (!record) throw Object.assign(new Error('海报任务不存在'), { code: 'ENOENT' });
              const explicitAuthorization = payload.explicit_authorization ?? payload.explicitAuthorization ?? payload.authorization;
              if (explicitAuthorization !== true) throw new Error('生成候选需要明确授权');
              const expectedRevision = payload.expected_manifest_revision ?? payload.expectedManifestRevision;
              if (!Number.isInteger(expectedRevision) || expectedRevision !== record.manifest.revision) {
                throw new Error('海报任务版本已变化');
              }
            const planVersion = payload.plan_version ?? payload.planVersion;
            if (!Number.isInteger(planVersion) || planVersion !== record.plan.plan_version) {
              throw new Error('候选计划版本已过期');
            }
            const planningMode = payload.planning_mode ?? payload.planningMode;
            const fast = planningMode === 'targeted_fast';
            const fastBinding = fast ? targetedFastSnapshot(record, layerIndex, payload) : null;
            if (planningMode && !fast) throw new Error('未知的候选规划模式');
            if (!fast && record.plan.status !== 'PLAN_CONFIRMED') {
              throw new Error('候选生成需要已确认计划');
            }
              const dispatchId = crypto.randomUUID();
              const activeLayer = record.manifest.layers?.find((layer) => layer?.layer_index === layerIndex);
              const promotedFromPending = activeLayer?.status === 'PENDING';
              let prepared = null;
              try {
                if (promotedFromPending) {
                  record = await mutatePosterJob(rootOutputDirectory, jobId, expectedRevision, (current) => ({
                    ...current,
                    manifest: {
                      ...current.manifest,
                      layers: current.manifest.layers.map((layer) => layer.layer_index === layerIndex ? {
                        ...layer,
                        status: 'GENERATION_AUTHORIZED',
                        authorization_plan_version: current.plan.plan_version,
                        authorization_consumed: false,
                      } : layer),
                    },
                  }));
                }
                prepared = await preparePosterJob({
                  outputRoot: rootOutputDirectory, jobId, phase: 'candidate', layerIndex,
                  expectedManifestRevision: record.manifest.revision,
                  dispatchId, planningMode, snapshotPath: fast ? record.paths.plan : undefined,
                  processingCategory: fastBinding?.snapshot.layer.processing_category,
                  sourceFingerprint: fastBinding?.sourceFingerprint,
                });
                submittedAt = new Date().toISOString();
                dispatch = await enqueueForegroundDispatch(record.paths.root, {
                  jobId,
                  taskKind: 'poster_candidate',
                  planPath: record.paths.plan,
                  layerIndex: prepared.layer_index,
                  candidateNumber: prepared.candidate_number,
                  authorizationId: prepared.authorization_id,
                  planVersion: prepared.plan_version,
                  ...(fastBinding ? { planningMode: 'targeted_fast', snapshotId: fastBinding.snapshotId,
                    sourceFingerprint: fastBinding.sourceFingerprint,
                    manifestRevision: prepared.reservation_manifest_revision } : {}),
                  prompt: posterPrompt(prepared, fastBinding ? {
                    processingCategory: fastBinding.snapshot.layer.processing_category,
                    confirmedSnapshotPath: record.paths.plan,
                  } : undefined),
                  submittedAt,
                  workbenchSessionId,
                  presentation: { layerIndex },
                  dispatchId,
                });
              } catch (error) {
                if (prepared) {
                  await rollbackPreparedPosterCandidate({
                    outputRoot: rootOutputDirectory, jobId, authorizationId: prepared.authorization_id, dispatchId,
                  });
                }
                if (promotedFromPending) {
                  await restoreUnsentPosterCandidateAuthorization({
                    outputRoot: rootOutputDirectory, jobId, layerIndex,
                    planVersion: record.plan.plan_version, previousStatus: 'PENDING',
                  });
                }
                throw error;
              }
            });
            response.statusCode = 202;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({ job_id: jobId, dispatch_id: dispatch.dispatchId, rootKind: 'poster', layer_index: layerIndex, status: 'queued', submitted_at: submittedAt, task_kind: 'poster_candidate' }));
            return;
          }
          if (candidatePreviewMatch && request.method === 'GET') {
            const record = await readReconciledPosterJob(rootOutputDirectory, candidatePreviewMatch[1]);
            if (!record) throw Object.assign(new Error('海报任务不存在'), { code: 'ENOENT' });
            const layerIndex = Number(candidatePreviewMatch[2]);
            const layer = record.manifest.layers?.find((entry) => entry?.layer_index === layerIndex);
            const candidateId = layer?.visual_inspection?.candidate_id;
            const candidate = record.manifest.candidates?.find((entry) => entry?.candidate_id === candidateId
              && entry?.layer_index === layerIndex
              && entry?.plan_version === record.plan.plan_version
              && !['STALE', 'CANCELLED', 'CANCELLED_LATE', 'INVALID', 'DIAGNOSTIC'].includes(entry?.status));
            if (!candidate?.path) throw Object.assign(new Error('当前候选不可用于预览'), { code: 'ENOENT' });
            const transparentPreview = candidate.transparent_preview;
            const bytes = await readSafePosterCandidatePreview({
              candidatesRoot: transparentPreview?.path ? record.paths.evidence : record.paths.candidates,
              candidatePath: transparentPreview?.path || candidate.path,
            });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'image/png');
            response.setHeader('Cache-Control', 'no-store');
            response.end(bytes);
            return;
          }
          if (candidateDownloadMatch && request.method === 'GET') {
            const record = await readReconciledPosterJob(rootOutputDirectory, candidateDownloadMatch[1]);
            if (!record) throw Object.assign(new Error('海报任务不存在'), { code: 'ENOENT' });
            const asset = selectPosterFastDownloadAsset(record, Number(candidateDownloadMatch[2]));
            if (!asset) throw Object.assign(new Error('当前项目没有可下载的 PNG'), { code: 'ENOENT' });
            const bytes = await readSafePosterCandidatePreview({
              candidatesRoot: asset.root,
              candidatePath: asset.path,
            });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'image/png');
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`);
            response.end(bytes);
            return;
          }
          if (jobMatch && request.method === 'GET') {
            const record = await readReconciledPosterJob(rootOutputDirectory, jobMatch[1]);
            if (!record) throw Object.assign(new Error('海报任务不存在'), { code: 'ENOENT' });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify(posterResponse(record)));
            return;
          }
          if (dispatchMatch && request.method === 'GET') {
            const dispatch = await readForegroundDispatch(path.join(posterJobsDirectory, dispatchMatch[1]), {
              dispatchId: dispatchMatch[2], rootKind: 'poster',
            });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify(dispatch));
            return;
          }
          if (planMatch && request.method === 'PATCH') {
            const payload = await readJsonBody(request);
            const expectedRevision = payload.expected_manifest_revision ?? payload.expectedManifestRevision;
            const saved = await mutatePosterJob(rootOutputDirectory, planMatch[1], expectedRevision, (current) => {
              const plan = createPosterPlan({
                ...payload.plan,
                job_id: current.plan.job_id,
                project_id: current.plan.project_id,
                image_id: current.plan.image_id,
                source: {
                  ...payload.plan?.source,
                  path: 'source.png',
                  width: current.plan.source.width,
                  height: current.plan.source.height,
                  aspect_ratio: current.plan.source.aspect_ratio,
                },
                output_directory: current.paths.root,
                status: 'PLAN_REVIEW',
              });
              return {
                ...current,
                plan,
                manifest: synchronizeFastPosterManifest(current.manifest, plan),
              };
            });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify(posterResponse(saved)));
            return;
          }
          if (confirmPlanMatch && request.method === 'POST') {
            const payload = await readJsonBody(request);
            const expectedRevision = payload.expected_manifest_revision ?? payload.expectedManifestRevision;
            const saved = await mutatePosterJob(rootOutputDirectory, confirmPlanMatch[1], expectedRevision, (current) => ({
              ...current,
              plan: confirmPosterPlanState(current.plan),
            }));
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify(posterResponse(saved)));
            return;
          }
          if (acceptMatch && request.method === 'POST') {
            const payload = await readJsonBody(request);
            const saved = await acceptPosterCandidate({
              outputRoot: rootOutputDirectory,
              jobId: acceptMatch[1],
              layerIndex: Number(acceptMatch[2]),
              candidateId: payload.candidate_id ?? payload.candidateId,
              expectedRevision: payload.expected_manifest_revision ?? payload.expectedManifestRevision,
            });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify(posterResponse(saved)));
            return;
          }
          if (retryMatch && request.method === 'POST') {
            const payload = await readJsonBody(request);
            const saved = await authorizePosterRetry({
              outputRoot: rootOutputDirectory,
              jobId: retryMatch[1],
              layerIndex: Number(retryMatch[2]),
              expectedRevision: payload.expected_manifest_revision ?? payload.expectedManifestRevision,
            });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify(posterResponse(saved)));
            return;
          }
          if (reprocessMatch && request.method === 'POST') {
            const payload = await readJsonBody(request);
            const jobId = reprocessMatch[1];
            const layerIndex = Number(reprocessMatch[2]);
            const saved = await withPosterCandidateOrchestrationLock(rootOutputDirectory, jobId, async () => {
              const authorized = await authorizePosterFastPostprocessRetry({
                outputRoot: rootOutputDirectory,
                jobId,
                layerIndex,
                expectedRevision: payload.expected_manifest_revision ?? payload.expectedManifestRevision,
              });
              const layer = authorized.manifest.layers.find((entry) => entry.layer_index === layerIndex);
              try {
                await finalizePosterFastRmbgCandidate({
                  outputRoot: rootOutputDirectory,
                  jobId,
                  layerIndex,
                  rawInputPath: layer.fast_execution.raw_candidate_path,
                  dispatchId: layer.fast_execution.dispatch_id,
                  trustedInternal: true,
                });
              } catch (error) {
                const current = await readPosterJob(rootOutputDirectory, jobId);
                const currentLayer = current?.manifest.layers?.find((entry) => entry.layer_index === layerIndex);
                if (currentLayer?.status === 'GENERATING') {
                  await recordPosterGenerationFailure({
                    outputRoot: rootOutputDirectory,
                    jobId,
                    layerIndex,
                    authorizationId: currentLayer.fast_execution.authorization_id,
                    candidateNumber: currentLayer.generation_count,
                    planVersion: current.plan.plan_version,
                    error,
                  }).catch(() => {});
                }
                throw error;
              }
              return readPosterJob(rootOutputDirectory, jobId);
            });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify(posterResponse(saved)));
            return;
          }
          if (auditRemediationMatch && request.method === 'POST') {
            const payload = await readJsonBody(request);
            const saved = await reauthorizePosterAuditLayer({
              outputRoot: rootOutputDirectory,
              jobId: auditRemediationMatch[1],
              layerIndex: Number(auditRemediationMatch[2]),
              expectedRevision: payload.expected_manifest_revision ?? payload.expectedManifestRevision,
            });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify(posterResponse(saved)));
            return;
          }
          if (auditMatch && request.method === 'POST') {
            const payload = await readJsonBody(request);
            const saved = await runPosterRecompositionAudit({
              outputRoot: rootOutputDirectory,
              jobId: auditMatch[1],
              expectedRevision: payload.expected_manifest_revision ?? payload.expectedManifestRevision,
            });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify(posterResponse(saved)));
            return;
          }
          if (exportMatch && request.method === 'GET') {
            const archive = await createPosterExportArchive({
              outputRoot: rootOutputDirectory,
              jobId: exportMatch[1],
            });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/zip');
            response.setHeader('Content-Disposition', `attachment; filename="${archive.fileName}"`);
            response.setHeader('Cache-Control', 'no-store');
            response.end(archive.bytes);
            return;
          }
          if ((cancelMatch || abandonMatch) && request.method === 'POST') {
            const jobId = (cancelMatch || abandonMatch)[1];
            const payload = await readJsonBody(request);
            if (typeof payload.dispatchId !== 'string' || payload.rootKind !== 'poster') {
              throw new Error('海报取消或放弃需要精确 dispatchId');
            }
            const record = await readPosterJob(rootOutputDirectory, jobId);
            if (!record) throw Object.assign(new Error('海报任务不存在'), { code: 'ENOENT' });
            const jobDirectory = path.join(posterJobsDirectory, jobId);
            const control = await controlPosterDispatch(jobDirectory, { dispatchId: payload.dispatchId, action: cancelMatch ? 'cancel' : 'abandon' });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify(control));
            return;
          }
          if (confirmDispatchMatch && request.method === 'POST') {
            const payload = await readJsonBody(request);
            if (typeof payload.dispatchId !== 'string' || payload.rootKind !== 'poster') {
              throw new Error('海报确认需要精确 dispatchId');
            }
            await acknowledgeForegroundDispatch(path.join(posterJobsDirectory, confirmDispatchMatch[1]), new Date().toISOString(), {
              confirmationSource: 'codex_model_tool',
              dispatchId: payload.dispatchId,
              rootKind: payload.rootKind,
            });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({ ok: true }));
            return;
          }
          response.statusCode = 405;
          response.end();
        } catch (error) {
          response.statusCode = error.statusCode || (error.code === 'ENOENT' ? 404
            : error instanceof PosterJobConflictError || /版本|过期|授权|GENERATING|confirmed/i.test(error.message) ? 409 : 400);
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: error.message }));
        }
      });

      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        const cancelMatch = pathname.match(/^\/api\/layer-review\/foreground-dispatch\/([a-zA-Z0-9._-]+)\/cancel$/);
        const abandonMatch = pathname.match(/^\/api\/layer-review\/foreground-dispatch\/([a-zA-Z0-9._-]+)\/abandon$/);
        const isQueueRead = pathname === '/api/layer-review/foreground-dispatch';
        const isBridgeStatus = pathname === '/api/layer-review/bridge-status';
        const isWorkbenchSession = pathname === '/api/layer-review/workbench-session';
        if (!isQueueRead && !isBridgeStatus && !isWorkbenchSession && !cancelMatch && !abandonMatch) {
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
              dispatch: await readNextForegroundDispatchFromRoots([
                jobsDirectory,
                path.resolve(process.cwd(), 'output', 'poster-jobs'),
              ]),
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
          if (abandonMatch && request.method === 'POST') {
            const jobDirectory = path.join(jobsDirectory, abandonMatch[1]);
            await abandonForegroundJob(jobDirectory, new Date().toISOString());
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({
              ok: true,
              status: 'cancelled',
              codex_turn_may_continue: true,
            }));
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
          const planStatus = plan.status === 'cancelled'
            ? 'cancelled'
            : ['completed', 'failed', 'needs_confirmation'].includes(reportStatus)
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
        comments: { legal: true },
      },
    },
  },
  define: {
    __IMVIA_POSTER_LAYERING_MODE_ENABLED__: JSON.stringify(isExecutionFeatureEnabled('poster_layering_mode')),
  },
  server: {
    host: '127.0.0.1',
    cors: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
});
