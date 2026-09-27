let requestId = 1;

function waitForParent(message, target = globalThis.window) {
  return new Promise((resolve, reject) => {
    const id = message.id;
    const listener = event => {
      if (event.source !== target.parent || event.data?.id !== id) return;
      target.removeEventListener('message', listener);
      if (event.data.error) reject(new Error(event.data.error.message || '宿主拒绝发送消息'));
      else resolve(event.data.result || {});
    };
    target.addEventListener('message', listener);
    target.parent.postMessage(message, '*');
  });
}

export async function sendVisibleWorkbenchMessage(prompt, environment = globalThis) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('EMPTY_BATCH_PROMPT');
  const openai = environment.window?.openai;
  if (typeof openai?.sendFollowUpMessage === 'function') {
    const result = await openai.sendFollowUpMessage({ prompt: text, title: '确认发送拆分任务到 Codex', scrollToBottom: true });
    if (result?.isError) throw Object.assign(new Error('HOST_MESSAGE_REJECTED'), { code: 'HOST_MESSAGE_REJECTED' });
    return { accepted: true, channel: 'send_follow_up_message' };
  }
  const app = environment.__IMVIA_MCP_APP__;
  if (typeof app?.sendMessage === 'function') {
    const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
    if (result?.isError) throw Object.assign(new Error('HOST_MESSAGE_REJECTED'), { code: 'HOST_MESSAGE_REJECTED' });
    return { accepted: true, channel: 'mcp_app' };
  }
  const target = environment.window;
  if (!target?.parent || target.parent === target || typeof target.parent.postMessage !== 'function') throw Object.assign(new Error('HOST_MESSAGE_UNAVAILABLE'), { code: 'HOST_MESSAGE_UNAVAILABLE' });
  const initializeId = requestId++;
  try {
    await waitForParent({ jsonrpc: '2.0', id: initializeId, method: 'ui/initialize', params: { protocolVersion: '2026-01-26',
      appInfo: { name: 'imvia-layer-workbench-v2', title: 'Imvia Layer V2', version: '1.0.0' }, appCapabilities: {} } }, target);
    target.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
    const id = requestId++;
    const result = await waitForParent({ jsonrpc: '2.0', id, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text }] } }, target);
    if (result?.isError) throw new Error('HOST_MESSAGE_REJECTED');
    return { accepted: true, channel: 'ui_message' };
  } catch (cause) {
    throw Object.assign(new Error(cause?.message || 'HOST_MESSAGE_UNAVAILABLE'), { code: 'HOST_MESSAGE_UNAVAILABLE' });
  }
}
