import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildWorkbenchPrompt, readCodexTurnStatus } from './codex-thread-bridge.mjs';
import { completionTimestamp, markTiming, mergeTiming } from './src/execution-timing.js';
import {
  acknowledgeForegroundDispatch,
  enqueueForegroundDispatch,
  readNextForegroundDispatch,
} from './src/foreground-dispatch.js';
import { reconcileTurnStatus } from './src/job-state.js';

const splitSkillPath = 'C:\\Users\\Amoiz\\.codex\\skills\\split-ui-design-layers-workbench-targeted\\SKILL.md';

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
        const ackMatch = pathname.match(/^\/api\/layer-review\/foreground-dispatch\/([a-zA-Z0-9._-]+)\/ack$/);
        const isQueueRead = pathname === '/api/layer-review/foreground-dispatch';
        if (!isQueueRead && !ackMatch) {
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
          if (isQueueRead && request.method === 'GET') {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({
              dispatch: await readNextForegroundDispatch(jobsDirectory),
            }));
            return;
          }
          if (ackMatch && request.method === 'POST') {
            const jobDirectory = path.join(jobsDirectory, ackMatch[1]);
            await acknowledgeForegroundDispatch(jobDirectory, new Date().toISOString());
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(JSON.stringify({ ok: true }));
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
        if (request.method !== 'GET') {
          next();
          return;
        }

        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        const statusMatch = pathname.match(/^\/api\/layer-review\/jobs\/([a-zA-Z0-9._-]+)$/);
        const fileMatch = pathname.match(/^\/api\/layer-review\/jobs\/([a-zA-Z0-9._-]+)\/files\/([^/]+)$/);
        if (!statusMatch && !fileMatch) {
          next();
          return;
        }

        try {
          const jobId = statusMatch?.[1] || fileMatch?.[1];
          const jobDirectory = path.resolve(process.cwd(), 'output', 'jobs', jobId);
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
          const images = imageNames.map((fileName) => ({
              name: fileName,
              url: `/api/layer-review/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(fileName)}`,
            }));
          const layerSnapshots = Object.fromEntries((plan.layers || []).map((layer) => [layer.id, {
            bounds: layer.review_snapshot?.bounds || layer.source_region_percent,
            sourceRegionPixels: layer.review_snapshot?.source_region_pixels || layer.source_region_pixels,
          }]));
          const expectedCount = Array.isArray(plan.layers) ? plan.layers.length : 0;
          const resultReady = expectedCount > 0 && images.length >= expectedCount;
          const reportStatus = executionReport?.status || null;
          const planStatus = ['failed', 'needs_confirmation'].includes(reportStatus)
            ? reportStatus
            : plan.status || 'processing';
          let codexTurn = null;
          if (
            plan.codex_thread_id
            && plan.codex_turn_id
            && !['completed', 'failed', 'send_failed', 'needs_confirmation'].includes(planStatus)
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
            submitted_at: plan.submitted_at || null,
            completed_at: completedAt,
            status_detail: reconciled.detail,
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
          const payload = await readJsonBody(request);
          const jobId = `layer-job-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          const jobsDirectory = path.resolve(process.cwd(), 'output', 'jobs');
          const jobDirectory = path.join(jobsDirectory, jobId);
          const outputDirectory = path.join(jobDirectory, 'final');
          await mkdir(jobDirectory, { recursive: true });

          const normalizedPayload = JSON.parse(JSON.stringify(payload));
          const embeddedSource = normalizedPayload.source?.embedded_data_url;
          let sourcePath = null;
          if (typeof embeddedSource === 'string') {
            const match = embeddedSource.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
            if (!match) throw new Error('原图数据格式不受支持');
            const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
            sourcePath = path.join(jobDirectory, `source.${extension}`);
            await writeFile(sourcePath, Buffer.from(match[2], 'base64'));
          } else if (typeof normalizedPayload.source?.source_uri === 'string') {
            const sourceUri = normalizedPayload.source.source_uri;
            sourcePath = sourceUri.startsWith('/')
              ? path.resolve(process.cwd(), 'public', sourceUri.slice(1))
              : path.resolve(process.cwd(), sourceUri);
          }
          if (!sourcePath) throw new Error('没有可提交的原始 UI 图片');

          delete normalizedPayload.source.embedded_data_url;
          normalizedPayload.source.local_path = sourcePath;
          for (const [index, layer] of (normalizedPayload.layers || []).entries()) {
            const embeddedCrop = layer.review_snapshot?.embedded_crop_data_url;
            if (typeof embeddedCrop !== 'string') continue;
            const match = embeddedCrop.match(/^data:image\/png;base64,(.+)$/s);
            if (!match) throw new Error(`${layer.name || `拆分项 ${index + 1}`}的框选预览图格式不受支持`);
            const safeId = String(layer.id || `layer-${index + 1}`).replace(/[^a-zA-Z0-9._-]+/g, '-');
            const cropPath = path.join(jobDirectory, `${String(index + 1).padStart(2, '0')}-${safeId}-selection.png`);
            await writeFile(cropPath, Buffer.from(match[1], 'base64'));
            delete layer.review_snapshot.embedded_crop_data_url;
            layer.review_snapshot.local_crop_path = cropPath;
          }
          const jobPath = path.join(jobDirectory, 'layer-review-plan.json');
          const submittedAt = new Date().toISOString();
          const job = {
            ...normalizedPayload,
            job_id: jobId,
            status: 'awaiting_codex_message',
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
          await writeFile(jobPath, JSON.stringify(job, null, 2));
          const prompt = buildWorkbenchPrompt({
            jobId,
            jobPath,
            sourcePath,
            outputDirectory,
          });
          await enqueueForegroundDispatch(jobDirectory, {
            jobId,
            prompt,
            submittedAt,
          });
          response.statusCode = 202;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({
            job_id: jobId,
            status: 'awaiting_codex_message',
            submitted_at: submittedAt,
            skill_name: path.basename(path.dirname(splitSkillPath)),
            prompt,
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
  server: {
    host: '127.0.0.1',
    cors: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
});
