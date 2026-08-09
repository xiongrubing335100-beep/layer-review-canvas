import { spawn } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExecutionFeatureEnabled } from './src/execution-features.js';
import { RMBG_MODEL, transparencyStrategy } from './src/split-execution.js';

const startupTimeoutMs = 8_000;
const requestTimeoutMs = 20_000;
const splitSkillName = 'split-ui-design-layers-workbench-targeted';
const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));
const splitSkillPath = path.resolve(
  process.env.IMVIA_LAYER_SKILL_PATH
    || path.join(repositoryRoot, 'plugin-template', 'imvia-layer', 'skills', splitSkillName, 'SKILL.md'),
);
let bridgePromise = null;

async function resolveCodexExecutable() {
  const candidates = [];
  if (process.env.CODEX_CLI_PATH) candidates.push(process.env.CODEX_CLI_PATH);

  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const binRoot = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const entries = await readdir(binRoot, { withFileTypes: true });
      const bundled = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const executable = path.join(binRoot, entry.name, 'codex.exe');
          try {
            return { executable, modified: (await stat(executable)).mtimeMs };
          } catch {
            return null;
          }
        }));
      candidates.push(...bundled
        .filter(Boolean)
        .sort((a, b) => b.modified - a.modified)
        .map((item) => item.executable));
    } catch {
      // Conventional install locations are checked below.
    }
    candidates.push(
      path.join(process.env.LOCALAPPDATA, 'Programs', 'Codex', 'codex.exe'),
      path.join(process.env.LOCALAPPDATA, 'Codex', 'codex.exe'),
    );
  }

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking.
    }
  }

  const pathEntries = (process.env.PATH || process.env.Path || '')
    .split(path.delimiter)
    .filter(Boolean);
  const names = process.platform === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex']
    : ['codex'];
  for (const directory of pathEntries) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Keep looking.
      }
    }
  }
  throw new Error('未找到 Codex 运行时。请确认 Codex CLI 已安装并在 PATH 中，或设置 CODEX_CLI_PATH 后重新运行 npm run setup。');
}

export function resolvePythonInvocation(environment = process.env, platform = process.platform) {
  const command = environment.IMVIA_LAYER_PYTHON_COMMAND
    || (platform === 'win32' ? 'python' : 'python3');
  let args = [];
  try {
    const parsed = JSON.parse(environment.IMVIA_LAYER_PYTHON_ARGS || '[]');
    args = Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    args = [];
  }
  return [command, ...args]
    .map((part) => /\s/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part)
    .join(' ');
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port;
      server.close(() => Number.isInteger(port) ? resolve(port) : reject(new Error('无法分配 Codex 本地端口')));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function connectWebSocket(url) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const socket = new WebSocket(url);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('连接 Codex 超时')), 700);
        socket.addEventListener('open', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
        socket.addEventListener('error', () => {
          clearTimeout(timeout);
          reject(new Error('Codex 尚未就绪'));
        }, { once: true });
      });
      return socket;
    } catch (error) {
      lastError = error;
      await delay(120);
    }
  }
  throw lastError || new Error('Codex 启动超时');
}

class RpcClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.notificationWaiters = [];
    socket.addEventListener('message', (event) => this.handleMessage(String(event.data)));
    socket.addEventListener('close', () => this.rejectAll(new Error('Codex 连接已关闭')));
  }

  notify(method, params = {}) {
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  request(method, params, timeoutMs = requestTimeoutMs) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return promise;
  }

  waitForNotification(method, predicate = () => true, timeoutMs = requestTimeoutMs) {
    const existing = this.notifications.find((message) => message.method === method && predicate(message.params || {}));
    if (existing) return Promise.resolve(existing.params || {});
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.notificationWaiters = this.notificationWaiters.filter((candidate) => candidate !== waiter);
          reject(new Error(`Codex 等待事件超时：${method}`));
        }, timeoutMs),
      };
      waiter.timeout.unref?.();
      this.notificationWaiters.push(waiter);
    });
  }

  handleMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex 请求失败'));
      else pending.resolve(message.result);
      return;
    }

    if (message.id === undefined && message.method) {
      this.notifications.push(message);
      if (this.notifications.length > 80) this.notifications.shift();
      const matches = this.notificationWaiters.filter((waiter) => (
        waiter.method === message.method && waiter.predicate(message.params || {})
      ));
      matches.forEach((waiter) => {
        clearTimeout(waiter.timeout);
        waiter.resolve(message.params || {});
      });
      this.notificationWaiters = this.notificationWaiters.filter((waiter) => !matches.includes(waiter));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: '此工作台不处理交互式审批，请在当前 Codex 任务中继续' },
      }));
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.notificationWaiters = [];
  }
}

async function startBridge() {
  const executable = await resolveCodexExecutable();
  const port = await allocatePort();
  const child = spawn(executable, ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 8_000) stderr += chunk.toString('utf8');
  });

  try {
    const socket = await connectWebSocket(`ws://127.0.0.1:${port}`);
    const client = new RpcClient(socket);
    await client.request('initialize', {
      clientInfo: { name: 'ui-layer-review-canvas', title: 'Imvia Layer', version: '0.5.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    client.notify('initialized');
    child.once('close', () => {
      bridgePromise = null;
      client.rejectAll(new Error('Codex 桥接进程已退出'));
    });
    process.once('exit', () => child.kill());
    return { client, child };
  } catch (error) {
    child.kill();
    const detail = stderr.trim().split(/\r?\n/).at(-1);
    if (detail) error.message = `${error.message}：${detail}`;
    throw error;
  }
}

async function getBridge() {
  if (!bridgePromise) bridgePromise = startBridge().catch((error) => {
    bridgePromise = null;
    throw error;
  });
  return bridgePromise;
}
export function buildWorkbenchPrompt({
  jobId,
  jobPath,
  sourcePath,
  outputDirectory,
  plan,
  requireForegroundConfirmation = true,
}) {
  const pythonInvocation = resolvePythonInvocation();
  const projectRoot = path.resolve(
    path.dirname(jobPath),
    '..',
    '..',
    '..',
  );
  const confirmScriptPath = path.resolve(
    projectRoot,
    'scripts',
    'confirm-layer-review-dispatch.mjs',
  );
  const rmbgScriptPath = path.resolve(projectRoot, 'scripts', 'finalize-rmbg.py');
  const imagegenCanvasScriptPath = path.resolve(projectRoot, 'scripts', 'prepare-targeted-imagegen-canvas.py');
  const targetedFinalizerPath = path.resolve(projectRoot, 'scripts', 'finalize-targeted-job.py');
  const removeBackgroundLayers = (plan?.layers || [])
    .filter((layer) => layer.remove_background)
    .map((layer) => layer.name || layer.id)
    .filter(Boolean);
  const layerTransparencyStrategy = (layer) => layer.transparency_strategy
    || transparencyStrategy({ category: layer.category, removeBackground: Boolean(layer.remove_background) });
  const codexRgbaLayers = (plan?.layers || [])
    .filter((layer) => layer.remove_background && layerTransparencyStrategy(layer) === 'codex_rgba')
    .map((layer) => layer.name || layer.id)
    .filter(Boolean);
  const rmbgLayers = (plan?.layers || [])
    .filter((layer) => layer.remove_background && layerTransparencyStrategy(layer) === 'rembg')
    .map((layer) => layer.name || layer.id)
    .filter(Boolean);
  const targetedRepairLayers = (plan?.layers || [])
    .filter((layer) => (
      layer.execution_route_hint === 'targeted_repair'
      && layerTransparencyStrategy(layer) !== 'codex_rgba'
    ))
    .map((layer) => layer.name || layer.id)
    .filter(Boolean);
  const nativeResolutionRmbgLayers = (plan?.layers || [])
    .filter((layer) => (
      layer.execution_route_hint === 'targeted_repair'
      && layerTransparencyStrategy(layer) === 'rembg'
      && (!layer.output_resolution_policy
        || layer.output_resolution_policy === 'native_imagegen_content')
    ))
    .map((layer) => layer.name || layer.id)
    .filter(Boolean);
  const previewLines = (plan?.layers || [])
    .map((layer) => {
      const previewPath = layer.review_snapshot?.local_crop_path;
      if (!previewPath) return '';
      return `框选预览图（${layer.name || layer.id || '拆分项'}）：\n![${layer.name || '拆分项'}](${previewPath})`;
    })
    .filter(Boolean);
  return [
    '执行本地 UI 拆图工作台的已确认任务。',
    `任务编号：${jobId}`,
    `权威计划：${jobPath}`,
    `原图路径：${sourcePath}`,
    `唯一输出目录：${outputDirectory}`,
    ...previewLines,
    `严格调用：[$${splitSkillName}](${splitSkillPath})`,
    requireForegroundConfirmation
      ? `收到后先调用 confirm_layer_review_foreground_dispatch，参数 jobId=${jobId}；确认成功后再执行拆分。`
      : '',
    requireForegroundConfirmation
      ? `若确认工具尚未出现在工具目录，改为运行：node "${confirmScriptPath}" "${jobId}"。`
      : '',
    '只处理计划 layers[]；在同一 turn 内规范化简短需求并执行。',
    '遵守 execution_mode、execution_route_hint 与 execution_policy；不要全页诊断或增加图层。',
    '快速 ImageGen 路由：首个工作结果通过尺寸、标注、明显排除和结构完整性验收就立即结束；仅在失败时允许一次定向 ImageGen 重试，第二次仍失败则停止，禁止绕过尺寸校验。',
    removeBackgroundLayers.length
      ? `去背景已开启：${removeBackgroundLayers.join('、')}。这些图层必须输出真实透明 RGBA PNG。`
      : '',
    codexRgbaLayers.length
      ? `文字/标志透明层：${codexRgbaLayers.join('、')}。先运行 ${pythonInvocation} "${imagegenCanvasScriptPath}" --job-id ${jobId} --layer-id <layerId>，再让 ImageGen 在返回的标准参考画布上输出黑底白主体语义 matte；禁止让 ImageGen 重绘最终文字 RGB。最后运行 ${pythonInvocation} "${targetedFinalizerPath}" --job-id ${jobId} --layer-id <layerId> --generated-input <matte PNG> --imagegen-mapping <mapping JSON>。最终 RGB 必须锁定原框选像素且不得调用 RMBG；画布变化、全不透明底图、字形断裂或结构缺失均须失败，禁止写入 final。`
      : '',
    targetedRepairLayers.length
      ? `定向修复层：${targetedRepairLayers.join('、')}。先运行 ${pythonInvocation} "${imagegenCanvasScriptPath}" --job-id ${jobId} --layer-id <layerId>，只让 ImageGen 在返回的标准参考画布 content_region 内完成已批准修复，并保持整张标准画布不变。将原生结果保存到 generated/ 后运行 ${pythonInvocation} "${targetedFinalizerPath}" --job-id ${jobId} --layer-id <layerId> --generated-input <修复画布 PNG> --imagegen-mapping <mapping JSON>。返回画布尺寸变化则失败；禁止把任意 ImageGen 输出强制缩放成最终尺寸。`
      : '',
    nativeResolutionRmbgLayers.length
      ? `高分辨率透明输出层：${nativeResolutionRmbgLayers.join('、')}。最终处理器必须让原生 content_region 分辨率直接进入 BRIA RMBG，并回传同分辨率透明 PNG；框选宽高仅作为画布逻辑尺寸和定位元数据。禁止在 RMBG 前缩小到框选尺寸。`
      : '',
    rmbgLayers.length
      ? `RMBG 图层：${rmbgLayers.join('、')}。先完成 Codex 最终拆分结果，再运行 ${pythonInvocation} "${rmbgScriptPath}" --input <中间PNG> --output <final PNG> --model ${RMBG_MODEL} --expected-width <宽> --expected-height <高>。`
      : '',
    rmbgLayers.length
      ? 'RMBG 成功并通过结构验收后才写入 final；禁止用色差、轮廓、膨胀、模糊或自制蒙版代替。'
      : '',
    '终态快速结束：最终处理器写入 PNG 和 completed execution-report 后，该调用必须是本 turn 最后一个工具调用；禁止再预览、读取或重复校验，立即交付返回的 PNG 路径并结束回复。',
    '开始时发送一条简短进度，完成时交付 PNG；处理中不要重复发送耗时消息。',
  ].filter(Boolean).join('\n');
}

export function buildWorkbenchTurnInput({
  prompt,
  plan,
  sourcePath,
  reviewCropPaths,
}) {
  if (!isExecutionFeatureEnabled('route_aware_context_v1')) {
    const legacyNeedsSource = plan.layers.some((layer) => (
      layer.execution_mode === 'quality'
      || layer.execution_route_hint === 'targeted_repair'
      || layer.category === 'kvBackground'
    )) || plan.task === 'refine_split_result';
    return [
      { type: 'text', text: prompt, text_elements: [] },
      ...(legacyNeedsSource ? [{ type: 'localImage', path: sourcePath, detail: 'high' }] : []),
      ...reviewCropPaths.map((path) => ({ type: 'localImage', path, detail: 'high' })),
    ];
  }
  const attachments = plan.task === 'refine_split_result'
    ? selectExecutionAttachments({}, {
      task: plan.task,
      sourcePath,
      reviewCropPaths,
    })
    : plan.layers.flatMap((layer) => selectExecutionAttachments(layer, {
      sourcePath,
      reviewCropPaths,
    }));
  const uniqueAttachments = [...new Map(attachments.map((item) => [item.path, item])).values()];
  return [
    { type: 'text', text: prompt, text_elements: [] },
    ...uniqueAttachments,
  ];
}

export function selectExecutionAttachments(layer = {}, {
  sourcePath = null,
  reviewCropPaths = [],
  task = null,
} = {}) {
  if (task === 'refine_split_result') {
    return sourcePath ? [{ type: 'localImage', path: sourcePath, detail: 'high' }] : [];
  }

  const route = layer.execution_route_hint || 'direct_crop';
  if (route === 'direct_crop') return [];
  const attachments = reviewCropPaths.map((path) => ({ type: 'localImage', path, detail: 'high' }));
  const needsSource = layer.requires_global_context === true
    || (layer.requires_global_context === undefined && (
      layer.execution_mode === 'quality'
      || route === 'targeted_repair'
      || layer.category === 'kvBackground'
    ));
  return needsSource && sourcePath
    ? [{ type: 'localImage', path: sourcePath, detail: 'high' }, ...attachments]
    : attachments;
}

export async function probeCurrentThread(threadId = process.env.CODEX_THREAD_ID) {
  if (!threadId) throw new Error('未识别到当前 Codex 任务，请从该任务中启动工作台');
  const { client } = await getBridge();
  const result = await client.request('thread/resume', { threadId, excludeTurns: true });
  return {
    threadId: result?.thread?.id || threadId,
    cwd: result?.cwd || null,
    model: result?.model || null,
  };
}

export async function readCodexTurnStatus(threadId, turnId) {
  if (!threadId || !turnId) return null;
  const { client } = await getBridge();
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const result = await client.request('thread/turns/list', {
      threadId,
      cursor,
      limit: 50,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    });
    const turn = result?.data?.find((item) => item.id === turnId);
    if (turn) {
      return {
        status: turn.status,
        completedAt: turn.completedAt ? new Date(turn.completedAt * 1000).toISOString() : null,
      };
    }
    cursor = result?.nextCursor || null;
    if (!cursor) break;
  }
  return { status: 'missing', completedAt: null };
}
