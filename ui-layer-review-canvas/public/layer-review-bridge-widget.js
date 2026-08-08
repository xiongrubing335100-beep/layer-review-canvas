let requestId = 1;

function normalizeDispatch(value) {
  return typeof value === 'string'
    ? { prompt: value }
    : (value || { prompt: '' });
}

export function buildUiMessageRequest(value, id = requestId++) {
  const dispatch = normalizeDispatch(value);
  const content = [{ type: 'text', text: dispatch.prompt }];
  const preview = dispatch.presentation?.preview;
  if (preview?.data && preview?.mimeType) {
    content.push({
      type: 'image',
      mimeType: preview.mimeType,
      data: preview.data,
    });
  }
  return {
    jsonrpc: '2.0',
    id,
    method: 'ui/message',
    params: {
      role: 'user',
      content,
    },
  };
}

export function buildToolCallRequest(name, args = {}, id = requestId++) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
    },
  };
}

function requestHost(message) {
  return new Promise((resolve, reject) => {
    const listener = (event) => {
      if (event.source !== window.parent || event.data?.id !== message.id) return;
      window.removeEventListener('message', listener);
      if (event.data.error) reject(new Error(event.data.error.message || 'Codex 拒绝发送消息'));
      else resolve(event.data.result || {});
    };
    window.addEventListener('message', listener);
    window.parent.postMessage(message, '*');
  });
}

function buildUiInitializeRequest(id = requestId++) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'ui/initialize',
    params: {
      protocolVersion: '2026-01-26',
      appInfo: {
        name: 'imvia-layer-conversation-bridge',
        title: 'Imvia Layer 会话桥接',
        version: '1.0.0',
      },
      appCapabilities: {},
    },
  };
}

export async function connectHost(
  request = requestHost,
  notify = (message) => window.parent.postMessage(message, '*'),
) {
  try {
    await request(buildUiInitializeRequest());
    notify({
      jsonrpc: '2.0',
      method: 'ui/notifications/initialized',
      params: {},
    });
    return {
      mode: 'ui_message',
      sendMessage: (value) => request(buildUiMessageRequest(value)),
    };
  } catch (error) {
    const wrapped = new Error(
      error?.message || '当前 Codex 任务未挂载可见会话消息通道，无法发送拆分消息',
    );
    wrapped.code = 'HOST_MESSAGE_UNSUPPORTED';
    wrapped.retryable = false;
    throw wrapped;
  }
}

export async function sendForegroundMessage(
  dispatch,
  connection,
) {
  if (typeof connection?.sendMessage !== 'function') {
    const error = new Error('当前 Codex 版本未开放当前任务消息通道');
    error.code = 'HOST_MESSAGE_UNSUPPORTED';
    error.retryable = false;
    throw error;
  }
  const result = await connection.sendMessage(dispatch);
  if (result?.isError) {
    throw new Error('当前 Codex 任务拒绝接收拆分消息');
  }
  return result;
}

async function callBridgeTool(name, args = {}) {
  const result = window.openai?.callTool
    ? await window.openai.callTool(name, args)
    : await requestHost(buildToolCallRequest(name, args));
  if (result?.isError) {
    const detail = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(detail || `${name} 执行失败`);
  }
  return result?.structuredContent || {};
}

function setStatus(label, detail, tone = 'ready') {
  const root = document.querySelector('[data-bridge-status]');
  const detailNode = document.querySelector('[data-bridge-detail]');
  if (!root || !detailNode) return;
  root.textContent = label;
  root.dataset.tone = tone;
  detailNode.textContent = detail;
}

function setPendingPanel(dispatch, state = 'ready') {
  const action = document.querySelector('[data-bridge-action]');
  const job = document.querySelector('[data-bridge-job]');
  const preview = document.querySelector('[data-bridge-preview]');
  const layer = document.querySelector('[data-bridge-layer]');
  const meta = document.querySelector('[data-bridge-meta]');
  const summary = document.querySelector('[data-bridge-summary]');
  if (!action || !job) return;
  action.hidden = !dispatch;
  job.textContent = dispatch?.jobId || '';
  if (preview) {
    const image = dispatch?.presentation?.preview;
    preview.hidden = !image?.data;
    preview.src = image?.data
      ? `data:${image.mimeType || 'image/png'};base64,${image.data}`
      : '';
  }
  if (layer) layer.textContent = dispatch?.presentation?.layerName || '拆分项';
  if (meta) {
    const presentation = dispatch?.presentation;
    meta.textContent = presentation
      ? [
        presentation.width && presentation.height
          ? `${presentation.width} × ${presentation.height}`
          : '',
        presentation.category || '',
        presentation.removeBackground ? '去背景' : '保留背景',
      ].filter(Boolean).join(' · ')
      : '';
  }
  if (summary) {
    summary.textContent = dispatch?.presentation?.promptSummary || '';
    summary.hidden = !summary.textContent;
  }
}

function bindSendAction(handler) {
  const button = globalThis.document?.querySelector?.('[data-bridge-send]');
  if (button) button.onclick = handler;
}

export function createConversationBridgeId() {
  return globalThis.crypto?.randomUUID?.()
    || `bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function readWorkbenchSessionId() {
  return globalThis.window?.openai?.toolOutput?.workbenchSessionId
    || globalThis.window?.openai?.toolOutput?.workbench_session_id
    || null;
}

export function createForegroundDispatcher({
  bridgeId = createConversationBridgeId(),
  workbenchSessionId = null,
  readDispatch = async () => callBridgeTool(
    'get_layer_review_foreground_dispatch',
    { bridgeId, workbenchSessionId },
  ),
  sendMessage = sendForegroundMessage,
  autoSendPending = true,
  markDelivered = async (dispatch) => callBridgeTool(
    'mark_layer_review_foreground_dispatch_delivered',
    {
      jobId: dispatch.jobId,
      bridgeId,
      workbenchSessionId,
      claimToken: dispatch.claimToken,
    },
  ),
  confirmDispatch = async (dispatch) => callBridgeTool(
    'confirm_layer_review_foreground_dispatch',
    { jobId: dispatch.jobId },
  ),
  readJob = async (dispatch) => {
    const result = await callBridgeTool('get_layer_review_job', { jobId: dispatch.jobId });
    return result?.job || null;
  },
  onDispatchConfirmed = () => {},
  releaseClaim = async (dispatch, error) => callBridgeTool(
    'release_layer_review_foreground_dispatch_claim',
    {
      jobId: dispatch.jobId,
      bridgeId,
      workbenchSessionId,
      claimToken: dispatch.claimToken,
      error: error?.message || String(error),
    },
  ),
  setBridgeStatus = setStatus,
  setPendingDispatch = setPendingPanel,
} = {}) {
  let polling = false;
  let pendingDispatch = null;
  let requestInFlight = false;
  let confirmationRequested = false;
  let messageDelivered = false;
  let confirmationComplete = false;

  function parseDispatchResult(result) {
    return {
      active: result?.active ?? true,
      dispatch: Object.prototype.hasOwnProperty.call(result || {}, 'dispatch')
        ? result.dispatch
        : result,
    };
  }

  function sameDispatch(left, right) {
    return Boolean(left && right)
      && left.jobId === right.jobId
      && left.claimToken === right.claimToken;
  }

  async function sendPendingDispatch() {
    if (!pendingDispatch || requestInFlight || messageDelivered) return false;
    const dispatch = pendingDispatch;
    requestInFlight = true;
    setPendingDispatch(dispatch, 'requesting');
    setBridgeStatus('正在发送可见会话消息', dispatch.jobId, 'sending');
    try {
      const latest = parseDispatchResult(await readDispatch(bridgeId));
      if (!latest.active) {
        setBridgeStatus(
          '当前监听已被替代',
          '新的 Imvia Layer 会话桥接已经接管任务监听。',
          'error',
        );
        return false;
      }
      if (!sameDispatch(dispatch, latest.dispatch)) {
        pendingDispatch = latest.dispatch || null;
        setPendingDispatch(pendingDispatch);
        setBridgeStatus(
          pendingDispatch ? '确认卡已更新' : '待发送任务已失效',
          pendingDispatch
            ? '当前任务已失效，正在发送队列中的下一项。'
            : '该拆分任务已取消或被更新。',
          pendingDispatch ? 'sending' : 'ready',
        );
        if (pendingDispatch) void sendPendingDispatch();
        return false;
      }
      await sendMessage(dispatch);
      await markDelivered(dispatch);
      messageDelivered = true;
      confirmationRequested = true;
      setPendingDispatch(dispatch, 'awaiting_confirmation');
      setBridgeStatus(
        '消息请求已交给 Codex 宿主',
        '正在等待当前会话实际显示并由 Codex 确认。',
        'sending',
      );
      return true;
    } catch (error) {
      await releaseClaim(dispatch, error);
      pendingDispatch = null;
      confirmationRequested = false;
      messageDelivered = false;
      confirmationComplete = false;
      setPendingDispatch(null);
      setBridgeStatus('自动发送失败，可重试', error.message, 'error');
      return false;
    } finally {
      requestInFlight = false;
    }
  }

  async function confirmPendingDispatch() {
    if (!pendingDispatch || requestInFlight || confirmationComplete || !messageDelivered) {
      return false;
    }
    const dispatch = pendingDispatch;
    requestInFlight = true;
    setPendingDispatch(dispatch, 'confirming');
    setBridgeStatus('正在确认当前任务', dispatch.jobId, 'sending');
    try {
      await confirmDispatch(dispatch);
      confirmationComplete = true;
      setPendingDispatch(dispatch, 'requested');
      setBridgeStatus(
        '已确认当前任务',
        'Codex 已收到可见拆分消息，可以开始执行。',
        'sending',
      );
      return true;
    } catch (error) {
      setPendingDispatch(dispatch, 'awaiting_confirmation');
      setBridgeStatus('确认失败，可重试', error.message, 'error');
      return false;
    } finally {
      requestInFlight = false;
    }
  }

  async function handlePendingAction() {
    return messageDelivered
      ? confirmPendingDispatch()
      : sendPendingDispatch();
  }

  return {
    getPendingDispatch() {
      return pendingDispatch;
    },

    async sendPendingFromUserGesture() {
      return sendPendingDispatch();
    },

    async confirmPendingFromUserGesture() {
      return confirmPendingDispatch();
    },

    async handlePendingAction() {
      return handlePendingAction();
    },

    async poll() {
      if (polling) return;
      polling = true;
      try {
        const { active, dispatch } = parseDispatchResult(await readDispatch(bridgeId));
        if (!active) {
          setBridgeStatus(
            '当前监听已被替代',
            '新的 Imvia Layer 会话桥接已经接管任务监听。',
            'error',
          );
          return;
        }
        if (!dispatch) {
          if (confirmationRequested && pendingDispatch) {
            const job = await readJob(pendingDispatch);
            if (!['sent_to_codex', 'processing', 'partial', 'finalizing', 'completed', 'failed', 'needs_confirmation']
              .includes(job?.status)) return;
            const confirmedDispatch = pendingDispatch;
            pendingDispatch = null;
            confirmationRequested = false;
            messageDelivered = false;
            confirmationComplete = true;
            setPendingDispatch(null);
            await onDispatchConfirmed(confirmedDispatch, job);
            return;
          }
          if (pendingDispatch) {
            pendingDispatch = null;
            setPendingDispatch(null);
          }
          setBridgeStatus('会话桥接已就绪', '在工作台点击“拆分”，消息会自动发送到最近的当前对话。');
          return;
        }
        if (sameDispatch(pendingDispatch, dispatch)) return;
        confirmationRequested = false;
        messageDelivered = false;
        confirmationComplete = false;
        pendingDispatch = dispatch;
        setPendingDispatch(dispatch, 'requesting');
        setBridgeStatus(
          '正在发送可见会话消息',
          '已发现工作台任务，正在把拆分提示词写入当前 Codex 对话。',
          'sending',
        );
        if (autoSendPending) await sendPendingDispatch();
      } catch (error) {
        setBridgeStatus('会话桥接暂时不可用', error.message, 'error');
      } finally {
        polling = false;
      }
    },
  };
}

const activeBridgeId = createConversationBridgeId();
const activeBridgeConnectedAt = new Date().toISOString();
let activeHeartbeatStop = null;

export async function startConversationBridge({
  bridgeId = activeBridgeId,
  connectedAt = activeBridgeConnectedAt,
  workbenchSessionId = null,
  getWorkbenchSessionId = readWorkbenchSessionId,
  connect = connectHost,
  registerBridge = async (
    currentBridgeId,
    currentConnectedAt,
    currentWorkbenchSessionId,
  ) => callBridgeTool(
    'register_layer_review_conversation_bridge',
    {
      bridgeId: currentBridgeId,
      connectedAt: currentConnectedAt,
      workbenchSessionId: currentWorkbenchSessionId,
    },
  ),
  heartbeatBridge = async (currentBridgeId, currentWorkbenchSessionId) => callBridgeTool(
    'heartbeat_layer_review_conversation_bridge',
    {
      bridgeId: currentBridgeId,
      workbenchSessionId: currentWorkbenchSessionId,
    },
  ),
  createDispatcher = createForegroundDispatcher,
  pollOnce = null,
  setBridgeStatus = setStatus,
  bindPendingSend = bindSendAction,
  scheduleRetry = (callback) => window.setTimeout(callback, 1200),
  schedulePoll = (callback) => window.setInterval(callback, 1200),
  clearPoll = (timer) => globalThis.window?.clearInterval?.(timer),
  scheduleHeartbeat = (callback) => window.setInterval(callback, 1000),
  clearHeartbeat = (timer) => globalThis.window?.clearInterval?.(timer),
} = {}) {
  let stopBridge = null;
  try {
    const connection = await connect();
    const resolvedWorkbenchSessionId = workbenchSessionId || getWorkbenchSessionId();
    if (!resolvedWorkbenchSessionId) {
      throw new Error('工作台会话尚未绑定');
    }
    const registration = await registerBridge(
      bridgeId,
      connectedAt,
      resolvedWorkbenchSessionId,
    );
    if (registration?.active === false) {
      setBridgeStatus(
        '当前监听已被替代',
        '新的 Imvia Layer 会话桥接已经接管任务监听。',
        'error',
      );
      return false;
    }
    const refreshHeartbeat = async () => {
      const presence = await heartbeatBridge(bridgeId, resolvedWorkbenchSessionId);
      if (presence?.active === false) {
        const error = new Error('当前会话监听已失效');
        error.retryable = false;
        throw error;
      }
    };
    await refreshHeartbeat();
    if (activeHeartbeatStop) activeHeartbeatStop();
    let heartbeatTimer;
    let pollTimer;
    stopBridge = () => {
      if (heartbeatTimer !== undefined) clearHeartbeat(heartbeatTimer);
      if (pollTimer !== undefined) clearPoll(pollTimer);
      if (activeHeartbeatStop === stopBridge) activeHeartbeatStop = null;
    };
    activeHeartbeatStop = stopBridge;
    const recoverHeartbeat = (error) => {
      if (activeHeartbeatStop !== stopBridge) return;
      stopBridge();
      if (error.retryable === false) {
        setBridgeStatus('当前任务监听已失效', error.message, 'error');
        return;
      }
      setBridgeStatus('正在重连当前会话', '会话监听短暂中断，正在自动恢复。', 'error');
      scheduleRetry(() => startConversationBridge({
        bridgeId,
        connectedAt,
        workbenchSessionId,
        getWorkbenchSessionId,
        connect,
        registerBridge,
        heartbeatBridge,
        createDispatcher,
        pollOnce,
        setBridgeStatus,
        bindPendingSend,
        scheduleRetry,
        schedulePoll,
        clearPoll,
        scheduleHeartbeat,
        clearHeartbeat,
      }));
    };
    heartbeatTimer = scheduleHeartbeat(() => {
      void refreshHeartbeat().catch((error) => {
        recoverHeartbeat(error);
      });
    });
    const dispatcher = pollOnce
      ? null
        : createDispatcher({
          bridgeId,
          workbenchSessionId: resolvedWorkbenchSessionId,
          sendMessage: (dispatch) => sendForegroundMessage(dispatch, connection),
          setBridgeStatus,
        });
    if (dispatcher) {
      bindPendingSend(() => {
        void dispatcher.handlePendingAction();
      });
    }
    const activePollOnce = pollOnce || (() => dispatcher.poll());
    setBridgeStatus('会话桥接已就绪', '监听会持续在线；工作台点击“拆分”后会自动发送到最近的当前对话。');
    await activePollOnce();
    pollTimer = schedulePoll(activePollOnce);
    return true;
  } catch (error) {
    if (stopBridge) stopBridge();
    if (error.retryable === false) {
      setBridgeStatus('当前任务消息通道不可用', error.message, 'error');
      return false;
    }
    setBridgeStatus('正在重连当前会话', error.message, 'error');
    scheduleRetry(() => startConversationBridge({
      bridgeId,
      connectedAt,
      workbenchSessionId,
      getWorkbenchSessionId,
      connect,
      registerBridge,
      heartbeatBridge,
      createDispatcher,
      pollOnce,
      setBridgeStatus,
      bindPendingSend,
      scheduleRetry,
      schedulePoll,
      clearPoll,
      scheduleHeartbeat,
      clearHeartbeat,
    }));
    return false;
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void startConversationBridge();
}
