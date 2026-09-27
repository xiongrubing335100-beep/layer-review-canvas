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
  <style>
  *{box-sizing:border-box}html,body{margin:0;background:transparent;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8eeee}
  .card{background:#101617;border:1px solid #253033;border-radius:14px;padding:18px 20px;max-width:640px}
  header{display:flex;align-items:center;gap:10px}h2{font-size:14px;line-height:20px;font-weight:600;margin:0;flex:1}
  .mark{color:#6dd9ce;width:20px;height:20px;flex:none}.badge{font-size:11px;color:#8caaa6;white-space:nowrap}
  p{margin:12px 0 0;color:#94a5a7;overflow-wrap:anywhere}#state{color:#d3dfe0}
  .actions{display:flex;gap:8px;margin-top:16px}button{font:500 12px/20px inherit;font-family:inherit;font-size:12px;line-height:20px;border:1px solid #344346;border-radius:8px;padding:7px 14px;background:transparent;color:#bac8ca;cursor:pointer}
  #send{background:#73ddd1;border-color:#73ddd1;color:#0b2925;font-weight:600}button:hover:not(:disabled){filter:brightness(1.1)}button:focus-visible{outline:2px solid #b6fff2;outline-offset:3px}button:disabled{opacity:.45;cursor:default}[hidden]{display:none!important}
  body[data-result="sent"] .mark,body[data-result="sent"] .badge{color:#74dbad}
  @media(max-width:360px){.card{padding:16px}.actions{flex-wrap:wrap}.badge{font-size:10px}}
  </style></head><body>
  <section class="card" aria-label="会话桥验证">
  <header><svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z M3 12l9 5 9-5 M3 16l9 5 9-5"/></svg><h2 id="title">IMVIA · 会话桥验证</h2><span class="badge" id="badge">连接中</span></header>
  <p id="description">2 项测试 · 不生成图片，不修改已有任务</p>
  <p id="state" role="status">连接宿主并准备测试请求…</p>
  <div class="actions" id="actions"><button id="send" disabled>发送到 Codex</button><button id="cancel" disabled>取消</button></div></section>
  <script>
  (async () => {
    const status = document.getElementById('state');
    const send = document.getElementById('send');
    const cancel = document.getElementById('cancel');
    const badge = document.getElementById('badge');
    const finish = (state) => {
      document.getElementById('actions').hidden = true;
      document.getElementById('description').hidden = true;
      document.body.dataset.result = state;
      badge.textContent = state === 'sent' ? '已收到' : '已取消';
      document.getElementById('title').textContent = state === 'sent' ? '会话桥连接成功' : '验证已取消';
      status.textContent = state === 'sent' ? '测试消息已收到，未执行图片生成。' : '未执行图片生成，可重新打开验证卡片。';
    };
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
      badge.textContent = '待发送';
      status.textContent = '发送后，请在 Codex 弹窗中确认。';
      send.disabled = false; cancel.disabled = false;
      cancel.onclick = async () => {
        send.disabled = true;
        try {
          const result = await call('cancel_workbench_v2_confirmation', {requestId:record.requestId});
          finish(result.status === 'sent' ? 'sent' : 'cancelled');
          cancel.disabled = true; clearInterval(poll);
        } catch(error) {status.textContent = error.message;}
      };
      send.onclick = () => {
        send.disabled = true;
        badge.textContent = '等待确认';
        status.textContent = '等待宿主发送确认与当前可见回合接收；尚未确认送达。';
        // Ready was resolved before enabling this button. Send directly from
        // the user's click, rather than after a network preparation round trip.
        new Promise(resolve => resolve(globalThis.__IMVIA_MCP_APP__.sendMessage({role:'user',content:[{type:'text',text:record.prompt}]})))
          .then(result => { if (result?.isError) throw new Error('宿主拒绝消息'); })
          .catch(async error => {
            await call('cancel_workbench_v2_confirmation',{requestId:record.requestId}).catch(()=>{});
            badge.textContent = '未送达';
            status.textContent = '未确认送达：' + error.message; cancel.disabled = true; clearInterval(poll);
          });
        poll = setInterval(async () => {
          try {
            const latest = await call('get_workbench_v2_confirmation',{requestId:record.requestId});
            if (latest.status === 'sent' || latest.status === 'cancelled') {
              finish(latest.status);
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
  // A replacement string would interpret SDK literals such as $& and $'.
  return html.replace(/<head>/i, () => `<head>\n    ${bridge}`);
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
