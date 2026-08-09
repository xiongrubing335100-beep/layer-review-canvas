import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./main.jsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const bridgeWidget = await readFile(new URL('../public/layer-review-bridge-widget.js', import.meta.url), 'utf8');
const bridgeServer = await readFile(new URL('../layer-review-mcp-server.mjs', import.meta.url), 'utf8');
const viteConfig = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');

test('the user-visible workbench brand is Imvia Layer', () => {
  assert.match(source, /<strong>Imvia Layer<\/strong>/);
  assert.doesNotMatch(source, /<strong>Layer Review<\/strong>/);
  assert.match(html, /<title>Imvia Layer<\/title>/);
  assert.match(bridgeWidget, /data-bridge-status/);
  assert.match(bridgeServer, /title:\s*'打开 Imvia Layer 右侧工作台'/);
  assert.match(bridgeServer, /codex_app__open_in_codex/);
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

test('conversation presence precedes project context and empty projects show no status', () => {
  assert.ok(
    source.indexOf('conversation-bridge-indicator') < source.indexOf('className="project-context"'),
    'conversation presence should render before project context',
  );
  assert.match(source, /hasSource \? <small>\{`\$\{acceptedCount\} \/ \$\{nodes\.length\} 已确认`\}<\/small> : null/);
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

test('crop preview omits the redundant drag instruction while keeping annotation feedback', () => {
  assert.doesNotMatch(source, /拖动框选，或拖动边框与四角调整/);
  assert.match(source, /boundaryOpen && annotationSessionActive/);
  assert.match(source, /标注已隐藏/);
  assert.match(source, /点击添加保留路径锚点/);
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
    /\.product-identity\s*\{[\s\S]*?grid-template-columns:[\s\S]*?calc\(var\(--workbench-left-edge\) - var\(--topbar-inline-pad\) - 178px\)/,
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
