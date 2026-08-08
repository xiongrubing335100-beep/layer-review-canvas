let requestId = 1;
let initialization = null;

function nativeMcpApp() {
  return typeof window !== 'undefined' ? window.__IMVIA_MCP_APP__ : null;
}

async function waitForNativeMcpApp() {
  const app = nativeMcpApp();
  if (!app) return null;
  if (window.__IMVIA_MCP_APP_READY__) await window.__IMVIA_MCP_APP_READY__;
  if (window.__IMVIA_MCP_APP_ERROR__) throw window.__IMVIA_MCP_APP_ERROR__;
  return app;
}

function requestHost(message) {
  return new Promise((resolve, reject) => {
    const listener = (event) => {
      if (event.source !== window.parent || event.data?.id !== message.id) return;
      window.removeEventListener('message', listener);
      if (event.data.error) reject(new Error(event.data.error.message || 'Codex 请求失败'));
      else resolve(event.data.result || {});
    };
    window.addEventListener('message', listener);
    window.parent.postMessage(message, '*');
  });
}

async function initializeHost() {
  if (window.openai?.callTool) return;
  if (!initialization) {
    initialization = requestHost({
      jsonrpc: '2.0',
      id: requestId++,
      method: 'ui/initialize',
      params: {
        protocolVersion: '2026-01-26',
        appInfo: {
          name: 'imvia-layer-workbench',
          title: 'Imvia Layer',
          version: '1.0.0',
        },
        appCapabilities: {},
      },
    }).then(() => {
      window.parent.postMessage({
        jsonrpc: '2.0',
        method: 'ui/notifications/initialized',
        params: {},
      }, '*');
    });
  }
  await initialization;
}

export function isMcpAppHost() {
  return typeof window !== 'undefined'
    && (
      Boolean(nativeMcpApp())
      || Boolean(window.openai?.callTool)
      || Boolean(window.__IMVIA_MCP_APP_HOST__)
    );
}

export async function callMcpAppTool(name, args = {}) {
  const app = await waitForNativeMcpApp();
  if (app) {
    const result = await app.callServerTool({ name, arguments: args });
    if (result?.isError) {
      const detail = result.content?.find((item) => item.type === 'text')?.text;
      throw new Error(detail || `${name} 执行失败`);
    }
    return result?.structuredContent || result || {};
  }
  await initializeHost();
  const result = window.openai?.callTool
    ? await window.openai.callTool(name, args)
    : await requestHost({
      jsonrpc: '2.0',
      id: requestId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
  if (result?.isError) {
    const detail = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(detail || `${name} 执行失败`);
  }
  return result?.structuredContent || {};
}

export async function sendMcpAppFollowUpMessage(prompt) {
  const app = await waitForNativeMcpApp();
  if (app) {
    const result = await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: String(prompt || '') }],
    });
    if (result?.isError) {
      const detail = result.content?.find((item) => item.type === 'text')?.text;
      throw new Error(detail || '当前 Codex 会话拒绝接收拆分消息');
    }
    return result || {};
  }
  const sendFollowUpMessage = window.openai?.sendFollowUpMessage;
  if (typeof sendFollowUpMessage !== 'function') {
    const error = new Error('当前 Codex 插件未开放会话消息通道，请从当前任务重新打开 Imvia Layer');
    error.code = 'HOST_MESSAGE_UNSUPPORTED';
    throw error;
  }
  const result = await sendFollowUpMessage({
    prompt: String(prompt || ''),
    scrollToBottom: true,
  });
  if (result?.isError) {
    const detail = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(detail || '当前 Codex 会话拒绝接收拆分消息');
  }
  return result || {};
}

export async function requestMcpAppFullscreen() {
  if (!isMcpAppHost()) return;
  const app = await waitForNativeMcpApp().catch(() => null);
  if (app?.requestDisplayMode) {
    await app.requestDisplayMode({ mode: 'fullscreen' }).catch(() => {});
    return;
  }
  if (window.openai?.requestDisplayMode) {
    await window.openai.requestDisplayMode({ mode: 'fullscreen' }).catch(() => {});
  }
}
