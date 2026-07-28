import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';

const workbenchOrigin = 'http://127.0.0.1:4173';
let requestId = 1;
let appPromise = null;

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

export function resolveWorkbenchUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return value;
  return new URL(value, `${workbenchOrigin}/`).href;
}

export async function deliverSplitPrompt({
  jobId,
  prompt,
  request,
  acknowledge,
}) {
  if (!request) return false;
  await request('ui/message', buildUiMessageRequest(prompt, 0).params);
  await acknowledge(jobId);
  return true;
}

async function connectWorkbenchApp(windowLike) {
  if (!windowLike || windowLike.parent === windowLike) return null;
  const app = new App(
    { name: 'layer-review-workbench', version: '0.4.0' },
    { availableDisplayModes: ['inline', 'fullscreen'] },
    { autoResize: false },
  );
  await app.connect(new PostMessageTransport(windowLike.parent, windowLike.parent));
  try {
    await app.requestDisplayMode({ mode: 'fullscreen' });
  } catch {
    // Fullscreen is optional; the workbench still functions inline.
  }
  return app;
}

export function getWorkbenchApp(windowLike = globalThis.window) {
  if (!appPromise) {
    appPromise = connectWorkbenchApp(windowLike).catch((error) => {
      console.warn('Layer Review MCP App connection failed', error);
      return null;
    });
  }
  return appPromise;
}

export async function sendSplitPromptToCurrentTask({ jobId, prompt }) {
  if (!prompt) return false;
  const app = await getWorkbenchApp();
  return deliverSplitPrompt({
    jobId,
    prompt,
    request: app ? (method, params) => (
      method === 'ui/message'
        ? app.sendMessage(params)
        : Promise.reject(new Error(`Unsupported MCP App request: ${method}`))
    ) : null,
    acknowledge: async (id) => {
      const response = await fetch(resolveWorkbenchUrl(
        `/api/layer-review/foreground-dispatch/${encodeURIComponent(id)}/ack`,
      ), { method: 'POST' });
      if (!response.ok) throw new Error(`确认发送失败：HTTP ${response.status}`);
    },
  });
}

if (typeof window !== 'undefined') {
  void getWorkbenchApp(window);
}
