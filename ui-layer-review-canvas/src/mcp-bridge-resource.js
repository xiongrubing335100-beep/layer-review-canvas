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
