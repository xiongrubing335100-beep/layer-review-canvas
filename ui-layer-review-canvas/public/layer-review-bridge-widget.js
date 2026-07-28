const workbenchOrigin = 'http://127.0.0.1:4173';
const pendingEndpoint = `${workbenchOrigin}/api/layer-review/foreground-dispatch`;
let requestId = 1;
let sendingJobId = null;
let pendingAckJobId = null;

export function buildUiMessageRequest(prompt, id = requestId++) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'ui/message',
    params: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
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

async function connectHost() {
  if (window.openai?.sendFollowUpMessage) return;
  const initialize = {
    jsonrpc: '2.0',
    id: requestId++,
    method: 'ui/initialize',
    params: {
      protocolVersion: '2026-01-26',
      appInfo: {
        name: 'layer-review-conversation-bridge',
        title: 'Layer Review 会话桥接',
        version: '0.1.0',
      },
      appCapabilities: {},
    },
  };
  await requestHost(initialize);
  window.parent.postMessage({
    jsonrpc: '2.0',
    method: 'ui/notifications/initialized',
    params: {},
  }, '*');
}

async function sendForegroundMessage(prompt) {
  if (window.openai?.sendFollowUpMessage) {
    return window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true });
  }
  return requestHost(buildUiMessageRequest(prompt));
}

async function acknowledge(jobId) {
  const response = await fetch(`${pendingEndpoint}/${encodeURIComponent(jobId)}/ack`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error(`确认发送失败：HTTP ${response.status}`);
}

function setStatus(label, detail, tone = 'ready') {
  const root = document.querySelector('[data-bridge-status]');
  const detailNode = document.querySelector('[data-bridge-detail]');
  if (!root || !detailNode) return;
  root.textContent = label;
  root.dataset.tone = tone;
  detailNode.textContent = detail;
}

async function poll() {
  try {
    if (pendingAckJobId) {
      await acknowledge(pendingAckJobId);
      pendingAckJobId = null;
      sendingJobId = null;
      setStatus('已发送到当前会话', '拆分消息已进入当前 Codex 任务。');
      return;
    }
    const response = await fetch(pendingEndpoint, { cache: 'no-store' });
    if (!response.ok) throw new Error(`工作台连接失败：HTTP ${response.status}`);
    const { dispatch } = await response.json();
    if (!dispatch || dispatch.jobId === sendingJobId) {
      if (!sendingJobId) setStatus('会话桥接已就绪', '在工作台点击“拆分”，消息会直接出现在这里。');
      return;
    }

    sendingJobId = dispatch.jobId;
    setStatus('正在发送到当前会话', dispatch.jobId, 'sending');
    await sendForegroundMessage(dispatch.prompt);
    pendingAckJobId = dispatch.jobId;
    await acknowledge(pendingAckJobId);
    pendingAckJobId = null;
    sendingJobId = null;
    setStatus('已发送到当前会话', '拆分消息已进入当前 Codex 任务。');
  } catch (error) {
    setStatus('会话桥接暂时不可用', error.message, 'error');
  }
}

async function start() {
  try {
    await connectHost();
    setStatus('会话桥接已就绪', '在工作台点击“拆分”，消息会直接出现在这里。');
    await poll();
    window.setInterval(poll, 1200);
  } catch (error) {
    setStatus('无法连接当前会话', error.message, 'error');
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void start();
}
