import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLayerReviewBridgeServer } from '../layer-review-mcp-server.mjs';

const source = await readFile(new URL('./main.jsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
const attributionSource = await readFile(new URL('./attribution.js', import.meta.url), 'utf8');
const penOverlay = await readFile(new URL('./PenPathOverlay.jsx', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const bridgeWidget = await readFile(new URL('../public/layer-review-bridge-widget.js', import.meta.url), 'utf8');
const viteConfig = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('the active workbench renders IMVIA Studio · Layer and the open tool returns its V2 page with a relay', async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia-brand-contract-'));
  let vite;
  let server;
  let client;
  t.after(async () => {
    await client?.close(); await server?.close(); await vite?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, plugins: [react()],
    cacheDir: path.join(temporaryRoot, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom',
  });
  server = createLayerReviewBridgeServer({
    v2BridgeRoot: path.join(temporaryRoot, 'bridge-requests'), ensureWorkbenchRunningImpl: async () => {},
  });
  client = new Client({ name: 'workbench-brand-test', version: '1' });
  const { WorkbenchV2 } = await vite.ssrLoadModule('/src/v2/WorkbenchV2.jsx');
  const markup = renderToStaticMarkup(createElement(WorkbenchV2, { api: {} }));
  assert.match(markup, /<strong>IMVIA Studio · Layer<\/strong>/);
  assert.match(markup, /class="v2-brand"/);
  assert.doesNotMatch(markup, /<strong>Layer Review<\/strong>/);

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const openTool = tools.find(tool => tool.name === 'open_layer_review_workbench');
  assert.ok(openTool);
  assert.equal(openTool._meta.ui.resourceUri, 'ui://imvia-layer/v2-conversation-relay.html');
  const result = await client.callTool({ name: openTool.name, arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.state, 'ready');
  const url = new URL(result.structuredContent.workbenchUrl);
  assert.equal(url.searchParams.get('workbench'), 'v2');
  assert.equal(url.searchParams.get('workbenchSessionId'), result.structuredContent.workbenchSessionId);
  assert.match(result.content.map(item => item.text || '').join('\n'), /open_in_codex/);
});

test('the retained legacy entry keeps its Imvia title and bridge status indicator', () => {
  assert.match(source, /<strong>Imvia Layer<\/strong>/);
  assert.doesNotMatch(source, /<strong>Layer Review<\/strong>/);
  assert.match(html, /<title>Imvia Layer<\/title>/);
  assert.match(bridgeWidget, /data-bridge-status/);
});

test('the browser workbench always opens in guided mode', () => {
  assert.match(source, /function defaultReviewMode\(\)\s*\{\s*return 'guided';\s*\}/);
  assert.match(source, /useState\(defaultReviewMode\)/);
  assert.match(source, /setReviewMode\(defaultReviewMode\(\)\)/);
  assert.doesNotMatch(source, /requestMcpAppFullscreen/);
});

test('the empty topbar omits upload-waiting and plan-reset actions', () => {
  assert.doesNotMatch(source, /等待上传原图/);
  assert.doesNotMatch(source, /清空拆分栏目/);
});

test('the workbench is temporarily fixed to the dark theme', () => {
  assert.match(source, /const FROZEN_THEME = 'dark';/);
  assert.match(source, /document\.documentElement\.dataset\.theme = FROZEN_THEME;/);
  assert.match(source, /localStorage\.setItem\('imvia-layer-theme', FROZEN_THEME\);/);
  assert.doesNotMatch(source, /className="theme-toggle"/);
  assert.doesNotMatch(source, /切换到白天模式/);
  assert.doesNotMatch(source, /切换到夜晚模式/);
  assert.match(styles, /:root\[data-theme='light'\]\s*\{/);
});

test('light theme keeps empty states and inspector surfaces on the light hierarchy', () => {
  assert.match(styles, /:root\[data-theme='light'\] \.guided-upload-state\s*\{[\s\S]*?background: #ffffff;/);
  assert.match(styles, /:root\[data-theme='light'\] \.canvas-empty-node-picker__option\s*\{[\s\S]*?background: #ffffff;/);
  assert.match(styles, /:root\[data-theme='light'\] \.canvas-summary__section\s*\{[\s\S]*?background: #f6f8f7;/);
  assert.match(styles, /:root\[data-theme='light'\] \.mode-switch \.mode-switch__active,[\s\S]*?background: #1a3e2b;/);
  assert.match(styles, /:root\[data-theme='light'\] \.canvas-command-controls\s*\{[\s\S]*?background: rgba\(255, 255, 255, \.94\);/);
});

test('the download icon menu owns both PNG and JSON exports', () => {
  assert.match(source, /label="下载与导出"/);
  assert.match(source, /<strong>下载全部 PNG<\/strong>/);
  assert.match(source, /<strong>下载拆分计划<\/strong><small>JSON 配置<\/small>/);
});

test('the uploaded-image intake offers automatic analysis controls and manual addition', () => {
  assert.match(source, /自动分层类目分析/);
  assert.match(source, /取消识别/);
  assert.match(source, /手动添加/);
});

test('the loaded source card exposes a direct original-canvas delete action', () => {
  assert.match(source, /aria-label="删除原始画布"/);
  assert.match(source, /data-tooltip="删除原始画布"/);
  assert.match(source, /onClick=\{deleteOriginalCanvas\}/);
});

test('automatic category analysis has visible motion feedback with a reduced-motion fallback', () => {
  assert.match(source, /className="guided-analysis-state__visual"/);
  assert.match(source, /className="guided-analysis-state__scan"/);
  assert.match(styles, /\.guided-analysis-state__visual::before\s*\{[\s\S]*animation:\s*guided-analysis-orbit/);
  assert.match(styles, /\.guided-analysis-state__scan::after\s*\{[\s\S]*animation:\s*guided-analysis-scan/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.guided-analysis-state__visual::before,[\s\S]*?\.guided-analysis-state__scan::after\s*\{[\s\S]*?animation:\s*none;/,
  );
});

test('uploaded images run the local fast category analyzer and leave the loading state', () => {
  assert.match(source, /import \{ analyzeFastCategories \} from '\.\/fast-category-analysis\.js';/);
  assert.match(source, /const runFastCategoryAnalysis = async \(image, runId\) =>/);
  assert.match(source, /const suggestions = analyzeFastCategories\(context\.getImageData/);
  assert.match(source, /setCategoryAnalysisStage\('complete'\)/);
  assert.match(source, /categoryAnalysisRunRef\.current \+= 1/);
});

test('topbar keeps confirmation progress but omits the repeated current-project filename', () => {
  const topbar = source.slice(
    source.indexOf('<header className="topbar">'),
    source.indexOf('<ModeSwitch value={reviewMode}'),
  );

  assert.match(topbar, /hasSource \? <small>\{`\$\{acceptedCount\} \/ \$\{nodes\.length\} 已确认`\}<\/small> : null/);
  assert.doesNotMatch(topbar, /<span>当前项目<\/span>/);
  assert.doesNotMatch(topbar, /<strong>\{sourceName \|\| '未选择图片'\}<\/strong>/);
  assert.doesNotMatch(source, />暂无</);
});

test('topbar conversation status stays inside its grid column', () => {
  assert.match(
    styles,
    /\.conversation-bridge-indicator\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow:\s*hidden;/,
  );
  assert.match(
    styles,
    /\.conversation-bridge-indicator__label\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;/,
  );
});

test('topbar uses a compact centered brand and an adjacent ready state', () => {
  const topbar = source.slice(
    source.indexOf('<header className="topbar">'),
    source.indexOf('<ModeSwitch value={reviewMode}'),
  );

  assert.match(topbar, /<strong>Imvia Layer<\/strong>/);
  assert.doesNotMatch(topbar, /交互式图层验收/);
  assert.match(topbar, /conversationBridge\.online \? '已就绪'/);
  assert.match(styles, /\.product-identity\s*\{[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*14px;/);
  assert.match(styles, /\.brand-lockup\s*\{[\s\S]*?align-items:\s*center;/);
});

test('topbar exposes an explicit reconnect action only while the conversation bridge is disconnected', () => {
  const topbar = source.slice(
    source.indexOf('<header className="topbar">'),
    source.indexOf('<ModeSwitch value={reviewMode}'),
  );

  assert.match(topbar, /conversationBridge\.online \? '已就绪' : '已断开'/);
  assert.match(topbar, /conversationBridge\.checked && !conversationBridge\.online/);
  assert.match(topbar, /onClick=\{reconnectConversation\}/);
  assert.match(topbar, />重新连接<\/button>/);
});

test('pen overlays use a pen cursor, circular green anchors, and animated dashed paths', () => {
  assert.match(penOverlay, /<ellipse[\s\S]*?className=\{`pen-anchor/);
  assert.match(penOverlay, /rx=\{anchorRadii\.rx\}/);
  assert.match(penOverlay, /ry=\{anchorRadii\.ry\}/);
  assert.match(styles, /\.pen-overlay\s*\{[\s\S]*?cursor:\s*url\("data:image\/svg\+xml/);
  assert.match(styles, /\.pen-anchor\s*\{[\s\S]*?fill:\s*#41e5a4/);
  assert.match(styles, /\.pen-path--draft\s*\{[\s\S]*?stroke-dasharray:\s*6 4/);
  assert.match(styles, /@keyframes pen-path-march/);
  assert.match(styles, /\.pen-path,[\s\S]*?\.pen-preview\s*\{[\s\S]*?animation:\s*pen-path-march/);
});

test('expanded crop preview preserves its source aspect ratio', () => {
  assert.match(source, /'--region-preview-aspect':\s*aspect/);
  assert.match(
    styles,
    /\.candidate-preview-panel--expanded \.region-preview--expanded\s*\{[\s\S]*?aspect-ratio:\s*var\(--region-preview-aspect\);[\s\S]*?height:\s*auto;/,
  );
  const expandedRule = styles.slice(
    styles.indexOf('.candidate-preview-panel--expanded .region-preview--expanded'),
    styles.indexOf('@media (max-width: 860px)', styles.indexOf('.candidate-preview-panel--expanded .region-preview--expanded')),
  );
  assert.doesNotMatch(expandedRule, /height:\s*100%/);
});

test('guided inspector omits the crop dimension and coordinate card', () => {
  const inspectorOutput = source.slice(
    source.indexOf('<section className="inspector-section inspector-section--output">'),
    source.indexOf('<section className="inspector-section inspector-section--boundary">'),
  );
  assert.doesNotMatch(inspectorOutput, /className=\{`region-readout|className="region-readout"/);
});

test('refinement prompt uses compact supporting text', () => {
  assert.match(
    styles,
    /\.refinement-prompt__field\s*\{[\s\S]*?font:\s*inherit;[\s\S]*?font-size:\s*10px;/,
  );
});

test('result panel omits the repeated selected layer title', () => {
  const resultHeader = source.slice(
    source.indexOf('<header className="guided-result-panel__header">'),
    source.indexOf('<div className="guided-result-panel__actions">'),
  );
  assert.match(resultHeader, /Codex 拆分结果/);
  assert.doesNotMatch(resultHeader, /<strong>\{selected\.name\}<\/strong>/);
});

test('crop preview keeps pen guidance and expand controls below the image surface', () => {
  const candidatePanel = source.slice(
    source.indexOf('<div className={`candidate-preview-panel'),
    source.indexOf('</div>\n            </div>\n\n            <section className={`guided-result-panel'),
  );
  const previewEnd = candidatePanel.indexOf('</RegionPreview>');
  const toolbarStart = candidatePanel.indexOf('className="candidate-preview-toolbar"');

  assert.doesNotMatch(source, /拖动框选，或拖动边框与四角调整/);
  assert.ok(previewEnd >= 0, 'candidate preview should close before its controls');
  assert.ok(toolbarStart > previewEnd, 'pen guidance and expand controls should render below the preview');
  assert.match(candidatePanel.slice(toolbarStart), /标注已隐藏/);
  assert.match(candidatePanel.slice(toolbarStart), /点击添加保留路径锚点/);
  assert.match(candidatePanel.slice(toolbarStart), /className="candidate-preview-toggle"/);
  assert.doesNotMatch(candidatePanel.slice(0, previewEnd), /annotation-mode-indicator|candidate-preview-toggle/);
  assert.doesNotMatch(candidatePanel, /className="candidate-summary"|<p>\{selected\.requirement\}<\/p>/);
});

test('PNG refinement exposes an external expanded-preview control without duplicating the pen editor', () => {
  const resultPanel = source.slice(
    source.indexOf('<section className={`guided-result-panel'),
    source.indexOf('</section>', source.indexOf('<section className={`guided-result-panel')),
  );
  const previewEnd = resultPanel.indexOf('</ResultPreview>');
  const toolbarStart = resultPanel.indexOf('className="result-editor__preview-toolbar"');

  assert.match(resultPanel, /expanded=\{resultEditing && resultPreviewExpanded\}/);
  assert.ok(previewEnd >= 0);
  assert.ok(toolbarStart > previewEnd, 'expand control must render below, not over, the PNG');
  assert.match(resultPanel.slice(toolbarStart), /放大 PNG 编辑预览/);
  assert.match(resultPanel.slice(toolbarStart), /还原 PNG 编辑预览/);
  assert.match(resultPanel, /aria-pressed=\{resultPreviewExpanded\}/);
  assert.equal((resultPanel.match(/<PenPathOverlay/g) || []).length, 1);
});

test('expanded PNG preview is presentation-only and resets with its edit session', () => {
  assert.match(source, /const \[resultPreviewExpanded, setResultPreviewExpanded\] = useState\(false\);/);
  assert.match(source, /if \(!resultPreviewExpanded\) return undefined;[\s\S]*?event\.key === 'Escape'[\s\S]*?setResultPreviewExpanded\(false\)/);
  assert.match(source, /setResultPreviewExpanded\(false\);[\s\S]*?\}, \[activeImageId, resultEditBaseKey, selectedId\]\);/);
  assert.doesNotMatch(source, /dispatchResultEdit\([^)]*expand/i);
});

test('expanded PNG editor grows inside the page and preserves image proportions', () => {
  assert.match(styles, /\.guided-result-panel--expanded-editor\s*\{[\s\S]*?max-width:\s*none;/);
  assert.match(styles, /\.guided-result-panel__canvas--expanded-editor\s*\{[\s\S]*?width:\s*100%;/);
  assert.match(styles, /\.result-preview--result-editor-expanded\s*\{[\s\S]*?max-height:\s*calc\(100vh - 220px\);/);
  assert.match(styles, /\.result-preview--result-editor-expanded\s+img\s*\{[\s\S]*?object-fit:\s*contain;/);
  assert.match(styles, /\.result-editor__preview-toolbar\s*\{[\s\S]*?position:\s*static;/);
  const expandedRule = styles.slice(
    styles.indexOf('.result-preview--result-editor-expanded'),
    styles.indexOf('.result-editor__preview-toolbar'),
  );
  assert.doesNotMatch(expandedRule, /object-fit:\s*cover|aspect-ratio:\s*auto/);
});

test('guided sidebar omits the repeated source filename and places KV background below UI components', () => {
  const sidebar = source.slice(
    source.indexOf('<aside className={`sidebar sidebar--left'),
    source.indexOf('</aside>', source.indexOf('<aside className={`sidebar sidebar--left')),
  );

  assert.doesNotMatch(sidebar, /<h1>\{sourceName \|\| '未选择图片'\}<\/h1>/);
  assert.match(source, /const categoryOrder = \['kvTitle', 'kvElement', 'ordinaryText', 'uiComponent', 'kvBackground'\];/);
});

test('hiding annotations keeps the active pen session out of crop mode', () => {
  const toggleOriginalOnly = source.slice(
    source.indexOf('const toggleOriginalOnly = () =>'),
    source.indexOf('const toggleBoundary = () =>'),
  );

  assert.match(source, /const annotationSessionActive = Boolean\(boundaryOpen && maskTool\);/);
  assert.match(source, /onPointerDown=\{annotationSessionActive \? undefined/);
  assert.match(source, /annotationSessionActive \? \(showOriginalOnly \? null : renderAnnotationOverlay\(\)\)/);
  assert.doesNotMatch(toggleOriginalOnly, /setMaskTool\(null\)/);
});

test('layer review exposes pen tools and no brush-size controls', () => {
  const reviewPanel = source.slice(
    source.indexOf('<section className="inspector-section inspector-section--boundary">'),
    source.indexOf('<div className="guided-actions">'),
  );

  assert.match(reviewPanel, /<PenTool size=\{16\} \/> \u4fdd\u7559\u94a2\u7b14/);
  assert.match(reviewPanel, /<PenTool size=\{16\} \/> \u6392\u9664\u94a2\u7b14/);
  assert.match(reviewPanel, /<PenTool size=\{16\} \/> \u8fb9\u754c\u94a2\u7b14/);
  assert.doesNotMatch(reviewPanel, /\u753b\u7b14\u5927\u5c0f|brushSize|<Brush size=\{16\}/);
});

test('PNG result refinement uses the shared pen editor and an independent requirement field', () => {
  const editor = source.slice(
    source.indexOf('<div className="result-editor__toolbar"'),
    source.indexOf('</section>', source.indexOf('<div className="result-editor__toolbar"')),
  );

  assert.match(source, /import \{[^}]*readPngPixelSize[^}]*\} from '\.\/result-refinement\.js';/s);
  assert.match(source, /import \{[^}]*coordinateResultRefinementSubmission,[^}]*reduceResultRefinementUi,[^}]*resultRefinementGeometry[^}]*\} from '\.\/result-refinement-ui\.js';/s);
  assert.match(editor, /<PenTool size=\{14\} \/> 保留钢笔/);
  assert.match(editor, /<PenTool size=\{14\} \/> 擦除钢笔/);
  assert.match(editor, /<PenTool size=\{14\} \/> 边界钢笔/);
  assert.match(editor, /<PenPathOverlay/);
  assert.match(editor, />修改目标</);
  assert.match(editor, /<textarea/);
  assert.match(editor, /className="result-editor__submit"[\s\S]*?发送调整/);
  assert.doesNotMatch(source, /resultEditBrushSize|startResultAnnotation|moveResultAnnotation|finishResultAnnotation|renderResultEditMark/);
});

test('PNG result refinement exposes explicit operation controls and guided copy', () => {
  const editor = source.slice(
    source.indexOf('<div className="result-editor__toolbar"'),
    source.indexOf('</section>', source.indexOf('<div className="result-editor__toolbar"')),
  );

  assert.match(source, /import \{[^}]*deriveRefinementPolicy,[^}]*refinementSubmissionState,[^}]*refinementSummary[^}]*\} from '\.\/result-refinement-policy\.js';/s);
  assert.match(editor, /仅保留路径内，路径外透明/);
  assert.match(editor, /设为主体范围/);
  assert.match(editor, /允许补入透明缺口/);
  assert.match(editor, /整图编辑（高风险）/);
  assert.match(editor, /系统理解/);
  assert.match(editor, /修改目标/);
  assert.match(editor, /例如：补全已标注的两个金币，保持原位置、大小、材质和光影/);
  assert.doesNotMatch(source, /非空要求或至少一条闭合路径即可发送/);
});

test('pending PNG revisions keep rendering the current successful image', () => {
  const panel = source.slice(
    source.indexOf('<section className={`guided-result-panel'),
    source.indexOf('</section>', source.indexOf('<section className={`guided-result-panel')),
  );

  assert.ok(panel.indexOf('latestSelectedResult?.image ? (') < panel.indexOf("jobStatus(activeSelectedJob.status).tone === 'pending'"));
  assert.match(panel, /selectedPendingRevision\?\.refinementSnapshot/);
});

test('README documents complete Bezier pen paths and PNG revision retention', () => {
  assert.match(readme, /完整贝塞尔钢笔路径/);
  assert.match(readme, /直线锚点/);
  assert.match(readme, /曲线控制柄/);
  assert.match(readme, /Option/);
  assert.match(readme, /当前成功 PNG/);
  assert.match(readme, /legacy.*画笔数据/i);
  assert.match(readme, /历史成功文件与任务记录/);
  assert.match(readme, /画布只显示当前 base 结果节点/);
  assert.doesNotMatch(readme, /历史成功版本保留为独立结果节点/);
});

test('read-only legacy annotations remain selectable above the pen canvas', () => {
  assert.match(
    styles,
    /\.annotation-overlay\s*\{[^}]*z-index:\s*8;[^}]*pointer-events:\s*none;/,
  );
  assert.match(styles, /\.annotation-mark\s*\{[\s\S]*?pointer-events:\s*visiblePainted;/);
});

test('topbar context shares the guided sidebar alignment edge', () => {
  assert.match(styles, /\.topbar\s*\{[\s\S]*?--workbench-left-edge:\s*288px;[\s\S]*?--topbar-inline-pad:\s*28px;/);
  assert.match(
    styles,
    /\.product-identity\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;/,
  );
  assert.match(styles, /@media \(max-width: 1240px\)\s*\{[\s\S]*?--workbench-left-edge:\s*258px;[\s\S]*?--topbar-inline-pad:\s*20px;/);
});

test('layer category headings do not show numeric counts', () => {
  assert.doesNotMatch(source, /<small>\{group\.items\.length\}<\/small>/);
});

test('layer statuses use lightweight tool markers instead of filled SaaS pills', () => {
  assert.match(
    styles,
    /\.status-pill\s*\{[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;/,
  );
  assert.match(styles, /\.status-pill::before\s*\{[\s\S]*?width:\s*2px;[\s\S]*?height:\s*12px;/);
  assert.match(styles, /\.status-pill--job-pending::after\s*\{[\s\S]*?animation:\s*status-marker-scan/);
});

test('canvas toolbar commands are icon-only and expose hover descriptions', () => {
  assert.match(source, /aria-label="全选节点"[\s\S]*data-tooltip="全选节点"/);
  assert.match(source, /aria-label="编组节点"[\s\S]*data-tooltip="编组节点"/);
  assert.doesNotMatch(source, /<Square size=\{15\} \/> 全选/);
  assert.doesNotMatch(source, /<Layers3 size=\{15\} \/> 编组/);
  assert.match(styles, /\.canvas-command\[data-tooltip\]::after/);
});

test('the add-node menu is left-aligned immediately above the canvas command dock', () => {
  assert.match(source, /const commandDockRect = canvasRef\.current\?\.querySelector\('\.canvas-command-controls'\)\?\.getBoundingClientRect\(\)/);
  assert.match(source, /const dockTop = commandDockRect\.top - rect\.top/);
  assert.match(source, /const dockLeft = commandDockRect\.left - rect\.left/);
  assert.match(source, /screenX = dockLeft/);
  assert.match(source, /screenY = dockTop - menuHeight - 10/);
});

test('the add-node menu keeps group labels and primary node names only', () => {
  assert.doesNotMatch(source, /className="node-type-menu__heading"/);
  assert.match(source, /className="node-type-menu__close"/);
  assert.match(source, /aria-label="关闭节点类型菜单"/);
  assert.match(source, /<strong>原图节点<\/strong>/);
  assert.match(source, /<strong>\{meta\.label\}<\/strong>/);
  assert.match(source, /<strong>拆分结果节点<\/strong>/);
  assert.doesNotMatch(source, /添加或定位当前工作流的原始图片/);
  assert.doesNotMatch(source, /<small>\{route\.label\}<\/small>/);
  assert.doesNotMatch(source, /承接拆分后产出的 PNG/);
  assert.match(styles, /\.node-type-menu__close\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*7px;[\s\S]*?right:\s*7px;/);
});

test('mode-switch hover keeps active and inactive states visually distinct', () => {
  assert.match(
    styles,
    /\.mode-switch button:not\(\.mode-switch__active\):hover\s*\{[\s\S]*?color:\s*#d8d8d8;[\s\S]*?background:\s*#292929;/,
  );
  assert.match(
    styles,
    /\.mode-switch \.mode-switch__active:hover\s*\{[\s\S]*?color:\s*#171717;[\s\S]*?background:\s*#ededed;/,
  );
});

test('canvas view controls expose an asset toggle and a compact symmetric zoom cluster', () => {
  assert.match(source, /className=\{`canvas-bottom-control canvas-asset-toggle/);
  assert.match(source, /label=\{panelVisibility\.left \? '关闭资产栏' : '打开资产栏'\}/);
  assert.match(source, /onClick=\{\(\) => setIsLeftOpen\(\(current\) => !current\)\}/);
  assert.match(source, /className="canvas-zoom-cluster"/);
  assert.match(source, /className="canvas-bottom-control" label="缩小画布"/);
  assert.match(source, /className="canvas-zoom-field canvas-bottom-control"/);
  assert.match(source, /className="canvas-bottom-control" label="放大画布"/);
  assert.match(source, /className="canvas-bottom-control" label="适配全部节点"/);
  assert.match(source, /className="canvas-bottom-control" label="聚焦选中节点"/);
  assert.ok(
    source.indexOf('label="缩小画布"') < source.indexOf('className="canvas-zoom-field canvas-bottom-control"')
      && source.indexOf('className="canvas-zoom-field canvas-bottom-control"') < source.indexOf('label="放大画布"'),
    'the zoom percentage should sit directly between zoom out and zoom in',
  );
  assert.match(
    styles,
    /\.canvas-bottom-controls\s*\{[\s\S]*?gap:\s*3px;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/,
  );
  assert.match(
    styles,
    /\.canvas-zoom-cluster\s*\{[\s\S]*?grid-template-columns:\s*34px 42px 34px;[\s\S]*?gap:\s*0;/,
  );
  assert.match(
    styles,
    /\.canvas-bottom-control\s*\{[\s\S]*?width:\s*34px;[\s\S]*?height:\s*34px;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/,
  );
  assert.match(
    styles,
    /\.canvas-zoom-field\s*\{[\s\S]*?width:\s*42px;[\s\S]*?height:\s*34px;[\s\S]*?padding:\s*0;/,
  );
  assert.match(
    styles,
    /\.canvas-bottom-controls \.icon-button\[data-tooltip\]::after\s*\{[\s\S]*?top:\s*auto;[\s\S]*?bottom:\s*calc\(100% \+ 10px\);/,
  );
});

test('canvas feedback sits above the command dock', () => {
  assert.match(source, /toast--canvas/);
  assert.match(styles, /\.toast--canvas\s*\{[\s\S]*bottom:/);
});

test('canvas selection supports keyboard deletion without hijacking text editing', () => {
  assert.match(source, /shouldHandleCanvasDelete\(event\)/);
  assert.match(source, /deleteCanvasSelection\(\)/);
  assert.match(source, /setHiddenCanvasResultKeys/);
});

test('deleting the selected layer clears its review pen feedback token', () => {
  const deleteSelected = source.slice(
    source.indexOf('const deleteSelected = () =>'),
    source.indexOf('const deleteCanvasSelection = () =>'),
  );

  assert.match(deleteSelected, /setReviewPenFeedbackTokens/);
  assert.match(deleteSelected, /nextTokens\.delete\(selected\.id\)/);
});

test('deleting selected canvas layers clears all matching review pen feedback tokens', () => {
  const deleteCanvasSelection = source.slice(
    source.indexOf('const deleteCanvasSelection = () =>'),
    source.indexOf('useEffect\(\(\) => \{', source.indexOf('const deleteCanvasSelection = () =>')),
  );

  assert.match(deleteCanvasSelection, /setReviewPenFeedbackTokens/);
  assert.match(deleteCanvasSelection, /splitIds\.forEach\(\(nodeId\) => nextTokens\.delete\(nodeId\)\)/);
});

test('both pen toolbars mount command refs and expose redo', () => {
  assert.match(source, /ref=\{reviewPenOverlayRef\}/);
  assert.match(source, /ref=\{resultPenOverlayRef\}/);
  assert.match(source, /resultPenOverlayRef\.current\?\.undo\(\)/);
  assert.match(source, /resultPenOverlayRef\.current\?\.redo\(\)/);
  assert.match(source, /> 重做<\/button>/);
});

test('PNG refinement deletes the overlay selection through the shared reducer', () => {
  assert.match(source, /resultPenOverlayRef\.current\?\.deleteSelection\(\)/);
  assert.match(source, /> 删除选中<\/button>/);
});

test('leaving PNG refinement cancels only the open pen draft', () => {
  const selectResultEditTool = source.slice(
    source.indexOf('const selectResultEditTool = (tool) =>'),
    source.indexOf('const updateResultPenEditor ='),
  );
  const toggleResultEditing = source.slice(
    source.indexOf('const toggleResultEditing = () =>'),
    source.indexOf('const openGuidedEditor ='),
  );

  assert.match(selectResultEditTool, /resultPenOverlayRef\.current\?\.cancelDraft\(\)/);
  assert.match(toggleResultEditing, /resultPenOverlayRef\.current\?\.cancelDraft\(\)/);
});

test('completed result nodes expose a direct download action', () => {
  assert.match(source, /className="result-node__download"/);
  assert.match(source, /download=\{image\.name \|\| `\$\{node\.id\}\.png`\}/);
});

test('empty guided workspace accepts image files dragged in from outside', () => {
  assert.match(source, /const \[sourceDropActive, setSourceDropActive\] = useState\(false\)/);
  assert.match(source, /const handleSourceDrop = \(event\) =>/);
  assert.match(source, /event\.dataTransfer\?\.files\?\.\[0\]/);
  assert.match(source, /onDragEnter=\{handleSourceDragEnter\}/);
  assert.match(source, /onDrop=\{handleSourceDrop\}/);
  assert.match(source, /或将图片拖到这里/);
  assert.match(styles, /\.guided-upload-state--drop-active/);
});

test('MCP app uploads source previews to an allowed workbench URL', () => {
  assert.match(source, /uploadMcpSourcePreview/);
  assert.match(source, /previewUrl \|\| dataUrl/);
  assert.match(source, /image\.crossOrigin = 'anonymous'/);
  assert.match(viteConfig, /\/api\/layer-review\/source-preview/);
  assert.match(viteConfig, /Content-Type', preview\.mimeType/);
});

test('empty canvas offers a single source-image node entry', () => {
  assert.match(source, /!hasSource \? \(\s*<div className=\{`canvas-empty-node-picker/);
  assert.match(source, /className="canvas-empty-node-picker__option"/);
  assert.match(source, /<strong>原图节点<\/strong>/);
  assert.match(source, /sourceFileInputRef\.current\?\.click\(\)/);
  assert.match(source, /\{hasSource \? \(\s*<>\s*<span className="node-type-menu__section-label">拆分节点<\/span>/);
  assert.match(styles, /\.canvas-empty-node-picker/);
  assert.match(
    styles,
    /\.canvas-empty-node-picker__icon\s*\{[\s\S]*?color:\s*#d8d8d8;[\s\S]*?background:\s*transparent;/,
  );
});

test('adding a source node with an existing image opens a second-image upload instead of moving the active source', () => {
  assert.match(source, /pendingSourceInsertRef\.current = \{[\s\S]*keepCanvas: reviewMode === 'canvas'/);
  assert.match(source, /if \(kind === 'source'\) \{[\s\S]*sourceFileInputRef\.current\?\.click\(\)/);
  assert.match(source, /aria-label=\{hasSource \? '上传另一张原图' : '原图节点'\}/);
  assert.match(source, /className="source-file-input"/);
  assert.match(source, /sourceNodePosition: sourceNodePositionForDocument/);
});

test('canvas overview renders split nodes and links for inactive image documents', () => {
  assert.match(source, /const inactiveCanvasNodes = useMemo\(/);
  assert.match(source, /imageSplitNodeKey\(document\.imageId, node\.id\)/);
  assert.match(source, /inactiveCanvasNodes\.map\(\(item\) => \{/);
  assert.match(source, /imageSourceNodeKey\(item\.imageId\)/);
  assert.match(source, /canvas-node--inactive/);
});

test('canvas overview keeps historical result nodes for every image document', () => {
  assert.match(source, /const inactiveResultNodes = useMemo\(/);
  assert.match(source, /jobs\s*\.filter\(\(job\) => jobMatchesSource\(job, documentSource\)\)/);
  assert.match(source, /inactiveResultNodes\.map\(\(resultNode\) => \(/);
  assert.match(source, /imageSplitNodeKey\(imageId, node\.id\)/);
});

test('switching images never deletes other images task history', () => {
  assert.doesNotMatch(source, /setJobs\(\(current\) => \{\s*const matching = current\.filter\(\(job\) => jobMatchesSource\(job, currentSource\)\)/);
  assert.match(source, /window\.localStorage\.setItem\('layer-review-jobs', JSON\.stringify\(jobs\)\)/);
});

test('primary workbench chrome uses monochrome emphasis while live status stays semantic', () => {
  assert.match(styles, /--accent:\s*#f2f2f2/);
  assert.match(styles, /\.brand-mark\s*\{[\s\S]*background:\s*#ededed/);
  assert.match(styles, /\.mode-switch \.mode-switch__active\s*\{[\s\S]*background:\s*#ededed/);
  assert.match(
    styles,
    /\.source-empty-upload\s*\{[\s\S]*?border:\s*1px dashed #454545;[\s\S]*?color:\s*#d8d8d8;[\s\S]*?background:\s*#1b1b1b;/,
  );
  assert.match(
    styles,
    /\.source-empty-upload:hover\s*\{[\s\S]*?border-color:\s*#6a6a6a;[\s\S]*?background:\s*#232323;/,
  );
  assert.match(styles, /\.conversation-bridge-indicator--online \.conversation-bridge-indicator__dot\s*\{[\s\S]*background:\s*#62d99b/);
});

test('the left sidebar has no visible developer attribution block', () => {
  const leftSidebarStart = source.indexOf('<aside className={`sidebar sidebar--left');
  const leftSidebar = source.slice(leftSidebarStart, source.indexOf('</aside>', leftSidebarStart) + '</aside>'.length);

  assert.doesNotMatch(leftSidebar, /DeveloperAttribution|developer-attribution|开发者\s*·\s*青木|xiaohongshu/i);
  assert.doesNotMatch(source, /import\s*\{\s*DeveloperAttribution\s*\}|<DeveloperAttribution\b/);
  assert.doesNotMatch(styles, /developer-attribution/);
  assert.doesNotMatch(attributionSource, /createElement|function\s+DeveloperAttribution/);
});
