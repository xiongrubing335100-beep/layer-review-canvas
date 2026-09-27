import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const scriptPlaceholder = '/*__LAYER_REVIEW_BRIDGE_SCRIPT__*/';
const workbenchOrigin = 'http://127.0.0.1:4173/';
const require = createRequire(import.meta.url);
let cachedMcpAppsBundle = '';

export async function buildBridgeWidgetHtml(htmlPath, scriptPath) {
  const [html, script] = await Promise.all([
    readFile(htmlPath, 'utf8'),
    readFile(scriptPath, 'utf8'),
  ]);
  return html.replace(scriptPlaceholder, script);
}

/** Isolated diagnostic: never uses the V1 polling or pre-delivery receipt path. */
export function buildV2ConfirmationProbeHtml() {
  return injectMcpAppsBridge(`<!doctype html><html><head><meta charset="utf-8">
  <style>body{font:15px system-ui;background:#101719;color:#e6f2ef;padding:24px}button{padding:12px;margin:8px 8px 0 0}p{line-height:1.6}</style></head><body>
  <h2>V2 会话桥验证</h2><p>仅验证两项测试清单的消息投递，不生成图片，也不修改已有任务。</p>
  <p id="state" role="status">连接宿主并准备测试请求…</p>
  <button id="send" disabled>请求发送确认</button><button id="cancel" disabled>取消测试请求</button>
  <script>
  (async () => {
    const status = document.getElementById('state');
    const send = document.getElementById('send');
    const cancel = document.getElementById('cancel');
    let record, poll;
    const call = async (name, args) => {
      const result = await window.openai.callTool(name, args);
      if (result.isError) throw new Error(result.content?.find(x=>x.type==='text')?.text || '工具调用失败');
      return result.structuredContent;
    };
    try {
      await globalThis.__IMVIA_MCP_APP_READY__;
      if (!globalThis.__IMVIA_MCP_APP__) throw new Error('宿主消息接口不可用');
      record = await call('prepare_workbench_v2_confirmation_probe', {
        batchId: 'probe-' + crypto.randomUUID(), workbenchSessionId: 'probe-session-' + crypto.randomUUID()
      });
      status.textContent = '测试请求已准备。点击下方按钮应出现宿主确认框；只有你发送后才会进入当前会话。';
      send.disabled = false; cancel.disabled = false;
      cancel.onclick = async () => {
        send.disabled = true;
        try {
          const result = await call('cancel_workbench_v2_confirmation', {requestId:record.requestId});
          status.textContent = result.status === 'sent' ? '可见回合已确认接收，无生成任务可取消。' : '测试请求已取消；迟到确认不会恢复它。';
          cancel.disabled = true; clearInterval(poll);
        } catch(error) {status.textContent = error.message;}
      };
      send.onclick = () => {
        send.disabled = true;
        status.textContent = '等待宿主发送确认与当前可见回合接收；尚未确认送达。';
        // Ready was resolved before enabling this button. Send directly from
        // the user's click, rather than after a network preparation round trip.
        new Promise(resolve => resolve(globalThis.__IMVIA_MCP_APP__.sendMessage({role:'user',content:[{type:'text',text:record.prompt}]})))
          .then(result => { if (result?.isError) throw new Error('宿主拒绝消息'); })
          .catch(async error => {
            await call('cancel_workbench_v2_confirmation',{requestId:record.requestId}).catch(()=>{});
            status.textContent = '未确认送达：' + error.message; cancel.disabled = true; clearInterval(poll);
          });
        poll = setInterval(async () => {
          try {
            const latest = await call('get_workbench_v2_confirmation',{requestId:record.requestId});
            if (latest.status === 'sent' || latest.status === 'cancelled') {
              status.textContent = latest.status === 'sent' ? '当前可见回合已确认收到测试批次。没有执行生成。' : '请求已取消。';
              cancel.disabled = true; clearInterval(poll);
            }
          } catch(error) { status.textContent = '状态读取失败：' + error.message; clearInterval(poll); }
        }, 1500);
      };
      window.addEventListener('pagehide', () => clearInterval(poll), {once:true});
    } catch(error) { status.textContent = '无法开始验证：' + error.message; }
  })();
  </script></body></html>`);
}

function assetPath(indexPath, source) {
  return path.join(path.dirname(indexPath), source.replace(/^\/+/, ''));
}

export async function buildWorkbenchWidgetHtml(indexPath) {
  let html = await readFile(indexPath, 'utf8');
  const scriptMatches = [...html.matchAll(/<script\b([^>]*?)\bsrc="([^"]+)"([^>]*)><\/script>/gi)];
  const styleMatches = [...html.matchAll(/<link\b([^>]*?)\bhref="([^"]+\.css)"([^>]*)>/gi)];

  for (const match of scriptMatches) {
    const script = await readFile(assetPath(indexPath, match[2]), 'utf8');
    const inlineScript = `<script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script>`;
    html = html.replace(match[0], () => inlineScript);
  }
  for (const match of styleMatches) {
    const style = await readFile(assetPath(indexPath, match[2]), 'utf8');
    const inlineStyle = `<style>${style.replace(/<\/style/gi, '<\\/style')}</style>`;
    html = html.replace(match[0], () => inlineStyle);
  }

  return injectMcpAppsBridge(
    html.replace(/<head>/i, `<head>\n    <base href="${workbenchOrigin}">`),
  );
}

export async function buildWorkbenchDevWidgetHtml(indexPath) {
  let html = await readFile(indexPath, 'utf8');
  html = html.replace(
    /<script\b[^>]*\bsrc="\/src\/main\.jsx"[^>]*><\/script>/i,
    [
      `<script type="module" src="${workbenchOrigin}@vite/client"></script>`,
      `<script type="module" src="${workbenchOrigin}src/main.jsx"></script>`,
    ].join('\n    '),
  );
  return injectMcpAppsBridge(
    html.replace(
      /<head>/i,
      `<head>\n    <base href="${workbenchOrigin}">\n    <style>html,body,#root{height:100%;margin:0}</style>`,
    ),
  );
}

function injectMcpAppsBridge(html) {
  const bridge = [
    '<script id="imviaMcpAppsBundle">',
    escapeInlineScript(mcpAppsBundle()),
    '</script>',
    '<script id="imviaMcpHostBridge">',
    mcpHostBridgeScript(),
    '</script>',
  ].join('\n');
  return html.replace(/<head>/i, `<head>\n    ${bridge}`);
}

function mcpAppsBundle() {
  if (cachedMcpAppsBundle) return cachedMcpAppsBundle;
  const source = require('node:fs').readFileSync(
    require.resolve('@modelcontextprotocol/ext-apps/app-with-deps'),
    'utf8',
  );
  const exportStart = source.lastIndexOf('export{');
  if (exportStart === -1) throw new Error('MCP Apps 浏览器 bundle 缺少导出块');
  const exportBlock = source.slice(exportStart).match(/^export\{([^}]+)\};?\s*$/s);
  if (!exportBlock) throw new Error('无法解析 MCP Apps 浏览器 bundle');
  const exportMap = new Map();
  for (const rawEntry of exportBlock[1].split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const parts = entry.split(/\s+as\s+/);
    exportMap.set((parts[1] || parts[0]).trim(), parts[0].trim());
  }
  const requiredExports = ['App', 'applyDocumentTheme', 'applyHostFonts', 'applyHostStyleVariables'];
  for (const name of requiredExports) {
    if (!exportMap.has(name)) throw new Error(`MCP Apps bundle 缺少 ${name}`);
  }
  cachedMcpAppsBundle = [
    source.slice(0, exportStart),
    `;globalThis.__IMVIA_MCP_APPS__={${requiredExports
      .map((name) => `${JSON.stringify(name)}:${exportMap.get(name)}`)
      .join(',')}};`,
  ].join('');
  return cachedMcpAppsBundle;
}

function escapeInlineScript(source) {
  return source.replaceAll('</script', '<\\/script').replaceAll('</SCRIPT', '<\\/SCRIPT');
}

function mcpHostBridgeScript() {
  return `(() => {
  const apps = globalThis.__IMVIA_MCP_APPS__;
  if (!apps || typeof apps.App !== 'function') return;
  globalThis.__IMVIA_MCP_APP_HOST__ = true;
  let app;
  try {
    app = new apps.App(
      { name: 'imvia-layer-workbench', version: '1.0.0' },
      { availableDisplayModes: ['inline', 'fullscreen'] },
      { autoResize: true },
    );
    globalThis.__IMVIA_MCP_APP__ = app;
    const ready = app.connect();
    globalThis.__IMVIA_MCP_APP_READY__ = ready;
    const callWhenReady = (callback) => (...args) => ready.then(() => callback(...args));
    window.openai = Object.assign(window.openai || {}, {
      callTool: callWhenReady((name, args = {}) => app.callServerTool({ name, arguments: args })),
      sendFollowUpMessage: callWhenReady((message) => app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: typeof message === 'string' ? message : String(message?.prompt || message?.content || '') }],
      })),
      requestDisplayMode: callWhenReady((request) => app.requestDisplayMode(request)),
    });
    ready.then(() => {
      window.openai = Object.assign(window.openai || {}, {
        hostCapabilities: app.getHostCapabilities?.(),
        hostInfo: app.getHostVersion?.(),
        hostContext: app.getHostContext?.(),
      });
      window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: window.openai } }));
    }).catch((error) => {
      globalThis.__IMVIA_MCP_APP_ERROR__ = error;
    });
  } catch (error) {
    globalThis.__IMVIA_MCP_APP_ERROR__ = error;
  }
})();`;
}
