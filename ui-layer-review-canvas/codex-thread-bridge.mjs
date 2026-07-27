import { spawn } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const startupTimeoutMs = 8_000;
const requestTimeoutMs = 20_000;
const turnCompletionTimeoutMs = 6 * 60 * 60 * 1_000;
const splitSkillName = 'split-ui-design-layers-workbench-targeted';
const splitSkillPath = 'C:\\Users\\Amoiz\\.codex\\skills\\split-ui-design-layers-workbench-targeted\\SKILL.md';
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
  throw new Error('未找到 Codex 桌面运行时，请从当前 Codex 任务重新启动工作台');
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
      clientInfo: { name: 'ui-layer-review-canvas', title: 'UI Layer Review Canvas', version: '0.5.0' },
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
}) {
  return [
    '执行本地 UI 拆图工作台的已确认任务。',
    `任务编号：${jobId}`,
    `权威计划：${jobPath}`,
    `原图路径：${sourcePath}`,
    `唯一输出目录：${outputDirectory}`,
    `严格调用：[$${splitSkillName}](${splitSkillPath})`,
    '只处理计划 layers[]；在同一 turn 内规范化简短需求并执行。',
    '遵守 execution_mode 与 execution_route_hint；不要全页诊断、增加图层或生成候选。',
    '开始时发送一条简短进度，完成时交付 PNG；处理中不要重复发送耗时消息。',
  ].join('\n');
}

export function buildWorkbenchTurnInput({
  prompt,
  plan,
  sourcePath,
  reviewCropPaths,
}) {
  const needsSource = plan.layers.some((layer) => (
    layer.execution_mode === 'quality'
    || layer.execution_route_hint === 'targeted_repair'
    || layer.category === 'kvBackground'
  )) || plan.task === 'refine_split_result';
  return [
    { type: 'text', text: prompt, text_elements: [] },
    ...(needsSource ? [{ type: 'localImage', path: sourcePath, detail: 'high' }] : []),
    ...reviewCropPaths.map((path) => ({ type: 'localImage', path, detail: 'high' })),
  ];
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

export async function sendPlanToCurrentThread({
  jobId,
  jobPath,
  sourcePath,
  reviewCropPaths = [],
  outputDirectory,
}) {
  const threadId = process.env.CODEX_THREAD_ID;
  if (!threadId) throw new Error('未识别到当前 Codex 任务，请从该任务中重新运行工作台');

  const { client } = await getBridge();
  await client.request('thread/resume', { threadId, excludeTurns: true });
  const plan = JSON.parse(await readFile(jobPath, 'utf8'));
  const prompt = buildWorkbenchPrompt({
    jobId,
    jobPath,
    sourcePath,
    outputDirectory,
  });
  const input = buildWorkbenchTurnInput({
    prompt,
    plan,
    sourcePath,
    reviewCropPaths,
  });

  const turn = await client.request('turn/start', {
    threadId,
    clientUserMessageId: randomUUID(),
    input,
    responsesapiClientMetadata: { source: 'ui-layer-review-canvas', job_id: jobId },
  });
  const turnId = turn?.turn?.id || null;
  if (!turnId) throw new Error('Codex 未返回拆分任务标识');
  await client.waitForNotification('turn/started', (params) => (
    params.turn?.id === turnId || params.turnId === turnId
  ));
  const completion = client.waitForNotification('turn/completed', (params) => (
    params.threadId === threadId && (params.turn?.id === turnId || params.turnId === turnId)
  ), turnCompletionTimeoutMs);
  return { threadId, turnId, completion };
}
