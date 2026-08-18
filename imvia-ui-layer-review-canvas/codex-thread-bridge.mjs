// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
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

export function quoteShellArgument(value, platform = process.platform, force = false) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error('命令参数包含不安全的控制字符');
  const safe = platform === 'win32'
    ? /^[A-Za-z0-9_@+=:,./\\-]+$/
    : /^[A-Za-z0-9_@%+=:,./-]+$/;
  if (!force && safe.test(text)) return text;
  if (platform === 'win32') {
    if (/[%!$`"]/.test(text)) throw new Error('Windows 命令参数包含不安全的 shell 展开字符');
    const escaped = text
      .replace(/(\\*)"/g, '$1$1\\"')
      .replace(/(\\+)$/, '$1$1');
    return `"${escaped}"`;
  }
  return `"${text.replace(/(["\\$`])/g, '\\$1')}"`;
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
    .map((part) => quoteShellArgument(part, platform))
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
      clientInfo: { name: 'imvia-ui-layer-review-canvas', title: 'Imvia Layer', version: '0.5.0' },
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
  platform = process.platform,
  environment = process.env,
}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const pythonInvocation = resolvePythonInvocation(environment, platform);
  const projectRoot = pathApi.resolve(
    pathApi.dirname(jobPath),
    '..',
    '..',
    '..',
  );
  const confirmScriptPath = pathApi.resolve(
    projectRoot,
    'scripts',
    'confirm-layer-review-dispatch.mjs',
  );
  const rmbgScriptPath = pathApi.resolve(projectRoot, 'scripts', 'finalize-rmbg.py');
  const imagegenCanvasScriptPath = pathApi.resolve(projectRoot, 'scripts', 'prepare-targeted-imagegen-canvas.py');
  const targetedFinalizerPath = pathApi.resolve(projectRoot, 'scripts', 'finalize-targeted-job.py');
  const quotedConfirmScriptPath = quoteShellArgument(confirmScriptPath, platform, true);
  const quotedRmbgScriptPath = quoteShellArgument(rmbgScriptPath, platform, true);
  const quotedImagegenCanvasScriptPath = quoteShellArgument(imagegenCanvasScriptPath, platform, true);
  const quotedTargetedFinalizerPath = quoteShellArgument(targetedFinalizerPath, platform, true);
  const removeBackgroundLayers = (plan?.layers || [])
    .filter((layer) => layer.remove_background)
    .map((layer) => layer.name || layer.id)
    .filter(Boolean);
  const layerTransparencyStrategy = (layer) => layer.transparency_strategy
    || transparencyStrategy({ category: layer.category, removeBackground: Boolean(layer.remove_background) });
  const codexRgbaLayers = (plan?.layers || [])
    .filter((layer) => layer.remove_background
      && layerTransparencyStrategy(layer) === 'codex_rgba'
      && layer.execution_route_hint !== 'codex_rgba_repair')
    .map((layer) => layer.name || layer.id)
    .filter(Boolean);
  const codexRgbaRepairLayers = (plan?.layers || [])
    .filter((layer) => layer.remove_background
      && layerTransparencyStrategy(layer) === 'codex_rgba'
      && layer.execution_route_hint === 'codex_rgba_repair')
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
  const resultRefinementLayers = (plan?.layers || [])
    .filter((layer) => layer.execution_route_hint === 'result_refinement');
  const resultRefinementLines = resultRefinementLayers.flatMap((layer) => {
    const layerId = layer.id || '<layerId>';
    const quotedJobId = quoteShellArgument(jobId, platform);
    const quotedLayerId = quoteShellArgument(layerId, platform);
    const canvas = plan?.source?.canvas || layer.expected_output || {};
    const dimensions = Number.isInteger(canvas.width) && Number.isInteger(canvas.height)
      ? `${canvas.width}×${canvas.height}`
      : '计划声明的输入像素尺寸';
    const annotations = Array.isArray(layer.mask_annotations) ? layer.mask_annotations : [];
    const countRole = (ids, role, kinds) => {
      if (Array.isArray(ids)) return ids.length;
      return annotations.filter((annotation) => (
        annotation?.operation_role === role
        || (!annotation?.operation_role && kinds.includes(annotation?.kind))
      )).length;
    };
    const repairCount = countRole(layer.repair_path_ids, 'repair', ['boundary']);
    const eraseCount = countRole(layer.erase_path_ids, 'erase', ['background', 'exclude', 'erase']);
    const protectCount = countRole(layer.protect_path_ids, 'protect', ['foreground', 'keep']);
    const operationMode = layer.refinement_operation?.mode;
    const scopeSummary = operationMode === 'keep_inside_delete_outside' ? '路径外透明' : '路径外保持';
    const canvasSummary = operationMode === 'full_canvas_explicit' ? '整图编辑' : '非整图编辑';
    const callBudget = Number.isInteger(layer.maximum_imagegen_calls)
      ? layer.maximum_imagegen_calls
      : 0;
    const roiCount = Number.isInteger(layer.expected_roi_tile_count)
      ? layer.expected_roi_tile_count
      : Math.floor(callBudget / 2);
    const normalizedRequirement = String(
      layer.normalized_user_requirement ?? layer.requirement ?? '',
    ).trim().replace(/\s+/g, ' ');
    const candidateBinding = quoteShellArgument('roi-id=/absolute/path.png', platform, true);
    const manifestPath = quoteShellArgument(
      '/absolute/path/to/result_refinement_roi_manifest.json',
      platform,
      true,
    );
    const finalizerCommand = roiCount === 0
      ? `${pythonInvocation} ${quotedTargetedFinalizerPath} --job-id ${quotedJobId} --layer-id ${quotedLayerId} --imagegen-mapping ${manifestPath}`
      : `${pythonInvocation} ${quotedTargetedFinalizerPath} --job-id ${quotedJobId} --layer-id ${quotedLayerId} --generated-input ${candidateBinding} --imagegen-mapping ${manifestPath}`;
    return [
      `PNG 结果局部精修层：${layer.name || layerId}。`,
      `当前成功 PNG 是唯一权威 base；最终尺寸锁定为 ${dimensions}，禁止缩放或改变画布。`,
      `系统理解：${repairCount} 个修复路径、${eraseCount} 个删除路径、${protectCount} 个保护路径；${scopeSummary}；${canvasSummary}。`,
      `用户目标：${normalizedRequirement || '仅执行已提交的结构化 Alpha 操作。'}`,
      `精确修复 ROI 数：${roiCount}；ImageGen 调用预算：${callBudget}${roiCount > 0 ? '（每个 ROI 一次初始候选，失败时最多一次重试）' : ''}。`,
      `先运行选定 Python 与绝对脚本路径：${pythonInvocation} ${quotedImagegenCanvasScriptPath} --job-id ${quotedJobId} --layer-id ${quotedLayerId}`,
      '读取返回的 result_refinement_roi_manifest（version 2）；每个 roi_job 只使用自己的 reference_path，原生 1:1 生成候选，禁止强制缩放、整页分析或混用 ROI。',
      roiCount === 0
        ? 'ROI manifest 的 roi_jobs 为空时禁止调用 ImageGen；finalizer 仅执行确定性 Alpha 操作。'
        : '候选可为 RGB 或 RGBA；不得绘制棋盘格，候选 Alpha 不具有最终决定权；每个 ROI 仅在初始候选失败后重试一次。',
      `禁止调用 RMBG。最后运行选定 Python 与绝对脚本路径：${finalizerCommand}${roiCount > 0 ? '（每个 roi_job 重复 --generated-input，并绑定其 roi-id 与候选绝对路径）' : ''}。`,
      '上述 finalizer 必须是本 turn 最后一个工具调用；成功后禁止预览、读取或再次校验，立即返回其 PNG 路径并结束回复。',
    ];
  });
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
      ? `若确认工具尚未出现在工具目录，改为运行：node ${quotedConfirmScriptPath} ${quoteShellArgument(jobId, platform, true)}。`
      : '',
    '只处理计划 layers[]；在同一 turn 内规范化简短需求并执行。',
    '遵守 execution_mode、execution_route_hint 与 execution_policy；不要全页诊断或增加图层。',
    '快速 ImageGen 路由：首个工作结果通过尺寸、标注、明显排除和结构完整性验收就立即结束；仅在失败时允许一次定向 ImageGen 重试（组合修复阶段按 execution_policy 分阶段计数），达到上限后立即停止；第二次仍失败则停止，禁止绕过尺寸校验。',
    removeBackgroundLayers.length
      ? `去背景已开启：${removeBackgroundLayers.join('、')}。这些图层必须输出真实透明 RGBA PNG。`
      : '',
    codexRgbaLayers.length
      ? `文字/标志透明层：${codexRgbaLayers.join('、')}。先运行 ${pythonInvocation} ${quotedImagegenCanvasScriptPath} --job-id ${jobId} --layer-id <layerId>，再让 ImageGen 在返回的标准参考画布上输出黑底白主体语义 matte；禁止让 ImageGen 重绘最终文字 RGB。最后运行 ${pythonInvocation} ${quotedTargetedFinalizerPath} --job-id ${jobId} --layer-id <layerId> --generated-input <matte PNG> --imagegen-mapping <mapping JSON>。最终 RGB 必须锁定原框选像素且不得调用 RMBG；画布变化、全不透明底图、字形断裂或结构缺失均须失败，禁止写入 final。`
      : '',
    codexRgbaRepairLayers.length
      ? `透明层遮挡补全：${codexRgbaRepairLayers.join('、')}。先运行 ${pythonInvocation} ${quotedImagegenCanvasScriptPath} --job-id ${jobId} --layer-id <layerId>。严格按顺序执行两阶段：1）先补全隐藏 RGB，保留原图所有可见像素，只在已提交补全区域恢复被遮挡结构；补全结果必须通过字形连接、笔画宽度、轮廓、渐变、材质和光影一致性验收，原遮挡物残留或结构断裂必须重试。2）补全结果通过结构验收后，只把已验收的 repair RGB 作为参考，生成一张黑底白色的完整主体 alpha matte；不得生成其他独立蒙版。快速模式最多 3 次 ImageGen 调用，高质量最多 4 次（每阶段失败时最多重试一次）。最后运行 ${pythonInvocation} ${quotedTargetedFinalizerPath} --job-id ${jobId} --layer-id <layerId> --generated-input <repair RGB PNG> --alpha-matte-input <alpha matte PNG> --imagegen-mapping <mapping JSON>。最终处理器必须锁定原图可见 RGB，只在完整主体 alpha matte 与已提交补全区域的交集写入 repair RGB，并使用同一张 matte 完成透明抠图；禁止调用 RMBG、禁止重绘可见字形、禁止写入黑底或全不透明结果。`
      : '',
    targetedRepairLayers.length
      ? `定向修复层：${targetedRepairLayers.join('、')}。先运行 ${pythonInvocation} ${quotedImagegenCanvasScriptPath} --job-id ${jobId} --layer-id <layerId>，只让 ImageGen 在返回的标准参考画布 content_region 内完成已批准修复，并保持构图与宽高比一致。将原生结果保存到 generated/ 后运行 ${pythonInvocation} ${quotedTargetedFinalizerPath} --job-id ${jobId} --layer-id <layerId> --generated-input <修复画布 PNG> --imagegen-mapping <mapping JSON>。ImageGen 返回同比例的原生尺寸时直接接受，由最终处理器按比例换算 content_region；宽高比变化或构图偏移才失败。禁止把任意 ImageGen 输出强制缩放成最终尺寸。`
      : '',
    ...resultRefinementLines,
    nativeResolutionRmbgLayers.length
      ? `高分辨率透明输出层：${nativeResolutionRmbgLayers.join('、')}。最终处理器必须让原生 content_region 分辨率直接进入 BRIA RMBG，并回传同分辨率透明 PNG；框选宽高仅作为画布逻辑尺寸和定位元数据。禁止在 RMBG 前缩小到框选尺寸。`
      : '',
    rmbgLayers.length
      ? `RMBG 图层：${rmbgLayers.join('、')}。先完成 Codex 最终拆分结果，再运行 ${pythonInvocation} ${quotedRmbgScriptPath} --input <中间PNG> --output <final PNG> --model ${RMBG_MODEL} --expected-width <宽> --expected-height <高>。`
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
  if (plan.task === 'refine_split_result') {
    return [
      { type: 'text', text: prompt, text_elements: [] },
      ...selectExecutionAttachments({}, { task: plan.task, sourcePath, reviewCropPaths }),
    ];
  }
  if (!isExecutionFeatureEnabled('route_aware_context_v1')) {
    const legacyNeedsSource = plan.layers.some((layer) => (
      layer.execution_mode === 'quality'
      || layer.execution_route_hint === 'targeted_repair'
      || layer.category === 'kvBackground'
    ));
    return [
      { type: 'text', text: prompt, text_elements: [] },
      ...(legacyNeedsSource ? [{ type: 'localImage', path: sourcePath, detail: 'high' }] : []),
      ...reviewCropPaths.map((path) => ({ type: 'localImage', path, detail: 'high' })),
    ];
  }
  const attachments = plan.layers.flatMap((layer) => selectExecutionAttachments(layer, {
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
      || route === 'codex_rgba_repair'
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
