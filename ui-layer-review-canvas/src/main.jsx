import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Brush,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Ellipsis,
  Eraser,
  Eye,
  FileJson,
  Focus,
  Hand,
  ImagePlus,
  Layers3,
  ListChecks,
  LoaderCircle,
  LocateFixed,
  Maximize2,
  Minimize2,
  Move,
  Network,
  PanelLeft,
  PanelRight,
  PencilLine,
  Plus,
  ScanSearch,
  Send,
  Sparkles,
  Square,
  Trash2,
  Type,
  Undo2,
  Upload,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { zipSync } from 'fflate';
import { jobMatchesSource } from './job-state.js';
import { classifyExecutionRoute, combinedRequirement, isNodeRunning, nextPaint } from './split-execution.js';
import './styles.css';

const categoryMeta = {
  kvTitle: {
    label: 'KV-标题',
    icon: Type,
    route: 'composite',
    defaultRequirement: '单独拆出 KV 主标题，保留原字体、描边、材质和附着光效；锁定原图可见像素，被遮挡处仅补全隐藏部分。',
  },
  kvElement: {
    label: 'KV-元素',
    icon: Sparkles,
    route: 'extract',
    defaultRequirement: '拆出 KV 主视觉元素，保留原图可见像素、阴影和附着装饰；仅补全被其他元素遮挡的部分。',
  },
  kvBackground: {
    label: 'KV-背景',
    icon: ImagePlus,
    route: 'background',
    defaultRequirement: '输出完整 KV 背景，移除标题与 KV 前景元素，只修复遮挡形成的洞，不重绘未遮挡区域。',
  },
  ordinaryText: {
    label: '普通文字',
    icon: Type,
    route: 'extract',
    defaultRequirement: '页面内普通 UI 文字统一合并为一个透明图层，保持原始坐标、字号、抗锯齿和颜色。',
  },
  uiComponent: {
    label: 'UI组件',
    icon: Square,
    route: 'repair',
    defaultRequirement: '输出干净 UI 组件底板，移除普通文字和可替换内容；文字挖空及遮挡处需要补全，保留边框、渐变、阴影和光效。',
  },
};

const categoryOrder = ['kvTitle', 'kvElement', 'kvBackground', 'ordinaryText', 'uiComponent'];

const routeMeta = {
  extract: { label: '原图提取', color: 'mint', icon: Layers3 },
  composite: { label: '组合保留', color: 'violet', icon: Sparkles },
  repair: { label: '去字与补全', color: 'orange', icon: WandSparkles },
  background: { label: '背景补全', color: 'sky', icon: ImagePlus },
};

const quickRequirements = [
  '保留原图可见像素',
  '普通文字单独成层',
  '去字后补全底板',
  '补全被遮挡区域',
  '按框选尺寸输出透明 PNG',
];

function pngDownloadName(value, fallback) {
  const base = String(value || '')
    .replace(/\.png$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  return `${base || fallback}.png`;
}

const jobStatusMeta = {
  sending_to_codex: { label: '正在发送素材', tone: 'pending' },
  sent_to_codex: { label: 'Codex 已接收', tone: 'pending' },
  processing: { label: 'Codex 处理中', tone: 'pending' },
  partial: { label: '结果生成中', tone: 'pending' },
  finalizing: { label: 'Codex 正在收尾', tone: 'pending' },
  needs_confirmation: { label: '需要确认', tone: 'confirmation' },
  completed: { label: '拆分完成', tone: 'completed' },
  failed: { label: '处理失败', tone: 'failed' },
  send_failed: { label: '发送失败', tone: 'failed' },
};

function readStoredJobs() {
  try {
    const value = JSON.parse(window.localStorage.getItem('layer-review-jobs') || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function jobStatus(status) {
  return jobStatusMeta[status] || jobStatusMeta.processing;
}

function elapsedEnd(job, clockNow) {
  if (job.status === 'needs_confirmation') {
    return job.confirmationRequestedAt || job.completedAt || job.submittedAt;
  }
  return job.completedAt || clockNow;
}

function splitProgress(status) {
  if (status === 'sending_to_codex') {
    return { stage: '1 / 3', label: '正在发送框选图与拆分提示词', detail: '素材发送成功后，Codex 会在当前任务中开始执行。' };
  }
  if (status === 'partial') {
    return { stage: '3 / 3', label: '正在回传拆分 PNG', detail: '已有部分结果生成，页面会继续自动更新。' };
  }
  if (status === 'finalizing') {
    return { stage: '3 / 3', label: '结果已生成，Codex 正在收尾', detail: 'PNG 已回流，等待当前 Codex 会话执行结束。' };
  }
  return { stage: '2 / 3', label: 'Codex 正在拆分', detail: '已在当前任务中执行，完成后结果会自动回流。' };
}

function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function formatElapsed(start, end = Date.now()) {
  const milliseconds = Math.max(0, end - new Date(start).getTime());
  if (!Number.isFinite(milliseconds)) return '--:--';
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

async function cropRegionDataUrl(source, bounds, sourceSize) {
  const image = new Image();
  image.decoding = 'async';
  image.src = source;
  await new Promise((resolve, reject) => {
    if (image.complete && image.naturalWidth) {
      resolve();
      return;
    }
    image.onload = resolve;
    image.onerror = () => reject(new Error('无法生成框选预览图'));
  });

  const region = pixelBounds(bounds, sourceSize);
  const canvas = document.createElement('canvas');
  canvas.width = region.width;
  canvas.height = region.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持框选预览图');
  const scaleX = image.naturalWidth / Math.max(1, sourceSize.width);
  const scaleY = image.naturalHeight / Math.max(1, sourceSize.height);
  context.drawImage(
    image,
    region.x * scaleX,
    region.y * scaleY,
    region.width * scaleX,
    region.height * scaleY,
    0,
    0,
    region.width,
    region.height,
  );
  return canvas.toDataURL('image/png');
}

function normalizedFileKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function defaultRemoveBackground(category) {
  return category !== 'kvBackground';
}

function createInitialNodes() {
  return [
    {
      id: 'kv-title',
      name: 'KV 主标题',
      category: 'kvTitle',
      status: 'candidate',
      requirement: categoryMeta.kvTitle.defaultRequirement,
      bounds: { x: 3, y: 2, width: 53, height: 16 },
      x: 1010,
      y: 112,
    },
    {
      id: 'kv-element',
      name: 'KV 主视觉元素',
      category: 'kvElement',
      status: 'candidate',
      requirement: categoryMeta.kvElement.defaultRequirement,
      bounds: { x: 48, y: 1, width: 49, height: 29 },
      x: 650,
      y: 150,
    },
    {
      id: 'kv-background',
      name: 'KV 完整背景',
      category: 'kvBackground',
      status: 'needs-repair',
      requirement: categoryMeta.kvBackground.defaultRequirement,
      bounds: { x: 0, y: 0, width: 100, height: 37 },
      x: 1370,
      y: 115,
    },
    {
      id: 'ordinary-text',
      name: '普通 UI 文字',
      category: 'ordinaryText',
      status: 'candidate',
      requirement: categoryMeta.ordinaryText.defaultRequirement,
      bounds: { x: 3, y: 37, width: 94, height: 61 },
      x: 650,
      y: 455,
    },
    {
      id: 'ui-host-card',
      name: '主播推荐卡',
      category: 'uiComponent',
      status: 'needs-repair',
      requirement: categoryMeta.uiComponent.defaultRequirement,
      bounds: { x: 3, y: 37, width: 94, height: 19 },
      x: 1370,
      y: 390,
    },
    {
      id: 'ui-date-tabs',
      name: '日期切换组件',
      category: 'uiComponent',
      status: 'needs-repair',
      requirement: categoryMeta.uiComponent.defaultRequirement,
      bounds: { x: 3, y: 63, width: 94, height: 7 },
      x: 1370,
      y: 590,
    },
    {
      id: 'ui-ranking-list',
      name: '榜单列表组件',
      category: 'uiComponent',
      status: 'needs-repair',
      requirement: categoryMeta.uiComponent.defaultRequirement,
      bounds: { x: 3, y: 72, width: 94, height: 25 },
      x: 1370,
      y: 790,
    },
    {
      id: 'ui-floating-entry',
      name: '侧边浮动入口',
      category: 'uiComponent',
      status: 'needs-repair',
      requirement: categoryMeta.uiComponent.defaultRequirement,
      bounds: { x: 80, y: 50, width: 17, height: 9 },
      x: 1370,
      y: 990,
    },
  ].map((node) => ({
    ...node,
    removeBackground: defaultRemoveBackground(node.category),
    executionMode: 'fast',
  }));
}

const emptySelectedNode = {
  id: '',
  name: '',
  category: 'uiComponent',
  status: 'candidate',
  requirement: categoryMeta.uiComponent.defaultRequirement,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  removeBackground: true,
  executionMode: 'fast',
};

const initialActivity = [
  { id: 1, title: '基础拆分栏目已建立', time: '刚刚' },
  { id: 2, title: '等待框选与需求确认', time: '现在' },
];

const overviewViewport = { x: 34, y: 74, scale: 0.72 };
const sourceNodeKey = 'source';
const splitNodeKey = (id) => `split:${id}`;
const resultNodeKey = (id) => `result:${id}`;
const manualResultNodeKey = (id) => `manual-result:${id}`;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cropImageStyle(bounds) {
  const width = Math.max(bounds.width, 0.5);
  const height = Math.max(bounds.height, 0.5);
  return {
    width: `${10000 / width}%`,
    height: `${10000 / height}%`,
    left: `${(-100 * bounds.x) / width}%`,
    top: `${(-100 * bounds.y) / height}%`,
  };
}

function pixelBounds(bounds, sourceSize) {
  return {
    x: Math.round((bounds.x / 100) * sourceSize.width),
    y: Math.round((bounds.y / 100) * sourceSize.height),
    width: Math.round((bounds.width / 100) * sourceSize.width),
    height: Math.round((bounds.height / 100) * sourceSize.height),
  };
}

function fitCanvasPreviewSize(width, height, maxWidth = 260, maxHeight = 240) {
  const aspect = Math.max(0.12, width / Math.max(1, height));
  if (aspect >= maxWidth / maxHeight) {
    return { width: maxWidth, height: Math.max(24, Math.round(maxWidth / aspect)) };
  }
  return { width: Math.max(24, Math.round(maxHeight * aspect)), height: maxHeight };
}

function jobLayerSnapshot(job, node, fallbackSourceSize) {
  const snapshot = job?.layerSnapshots?.[node.id];
  return {
    bounds: snapshot?.bounds ?? node.bounds,
    sourceSize: job?.sourceSize ?? fallbackSourceSize,
  };
}

function expandedBounds(bounds) {
  const paddingX = Math.max(4, bounds.width * 0.18);
  const paddingY = Math.max(3, bounds.height * 0.18);
  const x = Math.max(0, bounds.x - paddingX);
  const y = Math.max(0, bounds.y - paddingY);
  const right = Math.min(100, bounds.x + bounds.width + paddingX);
  const bottom = Math.min(100, bounds.y + bounds.height + paddingY);
  return { x, y, width: right - x, height: bottom - y };
}

function boundsInsideContext(bounds, context) {
  return {
    x: ((bounds.x - context.x) / context.width) * 100,
    y: ((bounds.y - context.y) / context.height) * 100,
    width: (bounds.width / context.width) * 100,
    height: (bounds.height / context.height) * 100,
  };
}

function connectionPath(sourceX, sourceY, targetX, targetY) {
  if (Math.abs(targetY - sourceY) <= 2) {
    return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }
  const direction = targetX >= sourceX ? 1 : -1;
  const handle = clamp(Math.abs(targetX - sourceX) * 0.46, 84, 320);
  return `M ${sourceX} ${sourceY} C ${sourceX + direction * handle} ${sourceY}, ${targetX - direction * handle} ${targetY}, ${targetX} ${targetY}`;
}

function annotationForPlan(mark, bounds, sourceSize, orderIndex) {
  const region = pixelBounds(bounds, sourceSize);
  if (mark.shape === 'rect') {
    const sourceRectPercent = {
      x: bounds.x + (mark.x / 100) * bounds.width,
      y: bounds.y + (mark.y / 100) * bounds.height,
      width: (mark.width / 100) * bounds.width,
      height: (mark.height / 100) * bounds.height,
    };
    return {
      id: mark.id,
      order_index: orderIndex,
      kind: mark.kind,
      semantics: mark.kind === 'foreground' ? 'force_keep' : 'force_exclude',
      shape: 'rect',
      coordinate_space: 'selected_region_percent',
      region_percent: { x: mark.x, y: mark.y, width: mark.width, height: mark.height },
      source_rect_percent: sourceRectPercent,
      source_rect_pixels: pixelBounds(sourceRectPercent, sourceSize),
    };
  }

  const sourcePointsPixels = mark.points.map((point) => ({
    x: Math.round(region.x + (point.x / 100) * region.width),
    y: Math.round(region.y + (point.y / 100) * region.height),
  }));
  return {
    id: mark.id,
    order_index: orderIndex,
    kind: mark.kind,
    semantics: mark.kind === 'foreground'
      ? 'force_keep'
      : mark.kind === 'background'
        ? 'force_exclude'
        : 'edge_override',
    shape: 'stroke',
    coordinate_space: 'selected_region_percent',
    points: mark.points,
    source_points_pixels: sourcePointsPixels,
    brush_size_percent: mark.brush_size_percent,
    brush_size_source_pixels: Math.max(1, Math.round((mark.brush_size_percent / 100) * region.width)),
  };
}

function IconButton({ label, children, className = '', ...props }) {
  return (
    <button className={`icon-button ${className}`} type="button" aria-label={label} data-tooltip={label} {...props}>
      {children}
    </button>
  );
}

function StatusPill({ status, label }) {
  const text = label || (status === 'accepted' ? '已确认' : status === 'needs-repair' ? '需补全' : '待确认');
  return <span className={`status-pill status-pill--${status}`}>{text}</span>;
}

function LayerStatusPill({ node, result }) {
  if (!result) return <StatusPill status={node.status} />;
  const meta = jobStatus(result.job.status);
  const label = meta.tone === 'completed'
    ? '结果已产出'
    : meta.tone === 'failed'
      ? '处理失败'
      : meta.tone === 'confirmation'
        ? meta.label
        : '处理中';
  return <span className={`status-pill status-pill--job-${meta.tone}`}>{label}</span>;
}

function RegionPreview({
  sourceImage,
  sourceSize,
  bounds,
  compact = false,
  className = '',
  previewRef,
  interactive = false,
  children,
  ...props
}) {
  const aspect = Math.max(0.12, (sourceSize.width * bounds.width) / (sourceSize.height * bounds.height));
  const compactWidth = aspect >= 38 / 42 ? 38 : Math.max(8, 42 * aspect);
  const compactHeight = aspect >= 38 / 42 ? Math.max(8, 38 / aspect) : 42;
  const maxPreviewHeight = className.includes('expanded')
    ? null
    : className.includes('node')
    ? null
    : className.includes('inspector')
      ? 180
      : className.includes('guided')
        ? 330
        : 510;
  return (
    <div
      ref={previewRef}
      className={`region-preview ${compact ? 'region-preview--compact' : ''} ${className}`}
      style={{
        width: compact ? `${compactWidth}px` : undefined,
        height: compact ? `${compactHeight}px` : undefined,
        aspectRatio: aspect,
        maxWidth: compact || !maxPreviewHeight
          ? undefined
          : `min(100%, ${Math.max(24, Math.round(aspect * maxPreviewHeight))}px)`,
      }}
      role={interactive ? 'application' : 'img'}
      aria-label="当前框选区域预览"
      {...props}
    >
      <img className="region-preview__image" src={sourceImage} alt="" draggable="false" style={cropImageStyle(bounds)} />
      {children}
    </div>
  );
}

function ResultPreview({
  image,
  bounds,
  sourceSize,
  compact = false,
  className = '',
  previewRef,
  interactive = false,
  children,
  ...props
}) {
  const [isFullCanvas, setIsFullCanvas] = useState(true);
  const region = pixelBounds(bounds, sourceSize);
  const aspect = Math.max(0.12, region.width / Math.max(1, region.height));
  const compactWidth = aspect >= 38 / 42 ? 38 : Math.max(8, 42 * aspect);
  const compactHeight = aspect >= 38 / 42 ? Math.max(8, 38 / aspect) : 42;
  const maxPreviewHeight = className.includes('guided-result') ? 300 : className.includes('node') ? 118 : null;
  const imageStyle = isFullCanvas
    ? cropImageStyle(bounds)
    : { inset: 0, width: '100%', height: '100%', objectFit: 'contain' };

  return (
    <div
      ref={previewRef}
      className={`result-preview ${compact ? 'result-preview--compact' : ''} ${className}`}
      style={{
        width: compact ? `${compactWidth}px` : undefined,
        height: compact ? `${compactHeight}px` : undefined,
        aspectRatio: aspect,
        maxWidth: compact || !maxPreviewHeight ? undefined : `min(100%, ${Math.max(96, Math.round(aspect * maxPreviewHeight))}px)`,
      }}
      role={interactive ? 'application' : 'img'}
      aria-label={interactive ? '拆分结果编辑画布' : '拆分结果预览'}
      {...props}
    >
      <img
        src={image.url}
        alt=""
        draggable="false"
        style={imageStyle}
        onLoad={(event) => {
          const element = event.currentTarget;
          setIsFullCanvas(element.naturalWidth === sourceSize.width && element.naturalHeight === sourceSize.height);
        }}
      />
      {children}
    </div>
  );
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('无法读取拆分结果图片'));
    reader.readAsDataURL(blob);
  });
}

function ModeSwitch({ value, onChange }) {
  return (
    <div className="mode-switch" role="tablist" aria-label="复核模式">
      <button type="button" className={value === 'guided' ? 'mode-switch__active' : ''} onClick={() => onChange('guided')}>
        <ListChecks size={15} /> 框选拆分
      </button>
      <button type="button" className={value === 'canvas' ? 'mode-switch__active' : ''} onClick={() => onChange('canvas')}>
        <Network size={15} /> 画布总览
      </button>
    </div>
  );
}

function App() {
  const [sourceImage, setSourceImage] = useState('/demo-source.png');
  const [sourceDataUrl, setSourceDataUrl] = useState('');
  const [sourceName, setSourceName] = useState('source.png');
  const [sourceSize, setSourceSize] = useState({ width: 1500, height: 3664 });
  const [nodes, setNodes] = useState(createInitialNodes);
  const [selectedId, setSelectedId] = useState('kv-title');
  const [reviewMode, setReviewMode] = useState('guided');
  const [viewport, setViewport] = useState(overviewViewport);
  const [sourceNodePosition, setSourceNodePosition] = useState({ x: 110, y: 240 });
  const [resultNodePositions, setResultNodePositions] = useState({});
  const [manualResultNodes, setManualResultNodes] = useState([]);
  const [manualEdges, setManualEdges] = useState([]);
  const [canvasSelectedKeys, setCanvasSelectedKeys] = useState([]);
  const [canvasGroups, setCanvasGroups] = useState([]);
  const [nodeInsertMenu, setNodeInsertMenu] = useState(null);
  const [linkPreview, setLinkPreview] = useState(null);
  const [maskTool, setMaskTool] = useState(null);
  const [marks, setMarks] = useState([]);
  const [boundaryOpen, setBoundaryOpen] = useState(true);
  const [activity, setActivity] = useState(initialActivity);
  const [toast, setToast] = useState('');
  const [isLeftOpen, setIsLeftOpen] = useState(true);
  const [isRightOpen, setIsRightOpen] = useState(true);
  const [draftMark, setDraftMark] = useState(null);
  const [selectedMarkId, setSelectedMarkId] = useState(null);
  const [brushSize, setBrushSize] = useState(24);
  const [showOriginalOnly, setShowOriginalOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localSubmissions, setLocalSubmissions] = useState({});
  const [jobs, setJobs] = useState(readStoredJobs);
  const [clockNow, setClockNow] = useState(Date.now());
  const [candidateContext, setCandidateContext] = useState(null);
  const [candidatePreviewExpanded, setCandidatePreviewExpanded] = useState(false);
  const [resultViewer, setResultViewer] = useState(null);
  const [resultEditing, setResultEditing] = useState(false);
  const [resultEditTool, setResultEditTool] = useState('background');
  const [resultEditMarks, setResultEditMarks] = useState([]);
  const [resultEditDraft, setResultEditDraft] = useState(null);
  const [resultEditBrushSize, setResultEditBrushSize] = useState(24);
  const [submittingResultEdit, setSubmittingResultEdit] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [topbarMenuOpen, setTopbarMenuOpen] = useState(false);
  const [spacePanReady, setSpacePanReady] = useState(false);
  const [canvasPanning, setCanvasPanning] = useState(false);
  const canvasRef = useRef(null);
  const guidedImageRef = useRef(null);
  const annotationPreviewRef = useRef(null);
  const annotationGestureRef = useRef(null);
  const resultEditPreviewRef = useRef(null);
  const resultEditGestureRef = useRef(null);
  const topbarMenuRef = useRef(null);
  const gestureRef = useRef(null);
  const linkPreviewPathRef = useRef(null);
  const canvasDragConsumedRef = useRef(false);
  const spacePanRef = useRef(false);
  const runningNodeIdsRef = useRef(new Set());

  const hasSelectedLayer = nodes.some((node) => node.id === selectedId);
  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[0] ?? emptySelectedNode;
  const selectedIndex = nodes.findIndex((node) => node.id === selected.id);
  const annotationModeActive = Boolean(boundaryOpen && maskTool && !showOriginalOnly);
  const visibleCandidateContext = annotationModeActive
    ? selected.bounds
    : candidateContext ?? expandedBounds(selected.bounds);
  const candidateSelectionBounds = boundsInsideContext(selected.bounds, visibleCandidateContext);
  const acceptedCount = nodes.filter((node) => node.status === 'accepted').length;
  const repairCount = nodes.filter((node) => node.status === 'needs-repair').length;
  const currentSource = useMemo(() => ({
    name: sourceName,
    width: sourceSize.width,
    height: sourceSize.height,
  }), [sourceName, sourceSize.height, sourceSize.width]);
  const jobsForCurrentSource = useMemo(
    () => jobs.filter((job) => jobMatchesSource(job, currentSource)),
    [currentSource, jobs],
  );
  const selectedNodeRunning = isNodeRunning(selected.id, localSubmissions, jobsForCurrentSource);
  const sentNodeIds = useMemo(() => new Set(jobsForCurrentSource
    .filter((job) => !['failed', 'send_failed'].includes(job.status))
    .flatMap((job) => job.nodeIds || [])), [jobsForCurrentSource]);
  const batchReadyNodeIds = nodes
    .filter((node) => node.status === 'accepted' && !sentNodeIds.has(node.id))
    .map((node) => node.id);
  const selectedMarks = marks.filter((mark) => mark.layer_id === selectedId);
  const groupedNodes = useMemo(() => categoryOrder.map((category) => ({
    category,
    items: nodes.filter((node) => node.category === category),
  })), [nodes]);
  const nodeResults = useMemo(() => {
    const latestByNode = new Map();
    jobsForCurrentSource.forEach((job) => job.nodeIds?.forEach((nodeId) => latestByNode.set(nodeId, job)));
    const results = new Map();
    nodes.forEach((node) => {
      const job = latestByNode.get(node.id);
      if (!job) return;
      const jobNodeIndex = job.nodeIds.indexOf(node.id);
      const nodeKey = normalizedFileKey(node.id);
      const image = job.images?.find((item) => normalizedFileKey(item.name).includes(nodeKey))
        || (job.nodeIds.length === 1 ? job.images?.[0] : job.images?.[jobNodeIndex]);
      const snapshot = jobLayerSnapshot(job, node, sourceSize);
      results.set(node.id, { job, image, ...snapshot });
    });
    return results;
  }, [jobsForCurrentSource, nodes, sourceSize]);
  const latestSelectedResult = nodeResults.get(selected.id);
  const latestSelectedJob = latestSelectedResult?.job;
  const activeSelectedJob = localSubmissions[selected.id] || latestSelectedJob;
  const activeSelectedResult = latestSelectedResult || (activeSelectedJob ? { job: activeSelectedJob } : null);
  const sourcePreviewWidth = 275;
  const sourcePreviewHeight = Math.round(
    sourcePreviewWidth * sourceSize.height / Math.max(1, sourceSize.width),
  );
  const downloadableResults = useMemo(() => nodes.flatMap((node, index) => {
    const result = nodeResults.get(node.id);
    if (!result?.image?.url) return [];
    return [{ node, image: result.image, index }];
  }), [nodeResults, nodes]);
  const resultNodes = useMemo(() => {
    let nextY = 145;
    return nodes.flatMap((node) => {
      const result = nodeResults.get(node.id);
      if (!result) return [];
      const region = pixelBounds(result.bounds, result.sourceSize);
      const { width: previewWidth, height: previewHeight } = fitCanvasPreviewSize(
        region.width,
        region.height,
        260,
        280,
      );
      const resultId = `${result.job.id}-${node.id}`;
      const position = resultNodePositions[resultId] || { x: 1760, y: nextY };
      const item = {
        ...result,
        id: resultId,
        node,
        x: position.x,
        y: position.y,
        previewWidth,
        previewHeight,
      };
      nextY += previewHeight + 92;
      return [item];
    });
  }, [nodeResults, nodes, resultNodePositions]);
  const canvasItems = useMemo(() => [
    {
      key: sourceNodeKey,
      kind: 'source',
      x: sourceNodePosition.x,
      y: sourceNodePosition.y,
      width: sourcePreviewWidth,
      height: sourcePreviewHeight + 32,
      portY: sourcePreviewHeight / 2 + 32,
    },
    ...nodes.map((node) => {
      const region = pixelBounds(node.bounds, sourceSize);
      const preview = fitCanvasPreviewSize(region.width, region.height);
      return {
        key: splitNodeKey(node.id),
        kind: 'split',
        linkedNodeId: node.id,
        x: node.x,
        y: node.y,
        width: preview.width,
        height: preview.height + 32,
        portY: preview.height / 2 + 32,
      };
    }),
    ...resultNodes.map((resultNode) => ({
      key: resultNodeKey(resultNode.id),
      kind: 'result',
      linkedNodeId: resultNode.node.id,
      x: resultNode.x,
      y: resultNode.y,
      width: resultNode.previewWidth,
      height: resultNode.previewHeight + 32,
      portY: resultNode.previewHeight / 2 + 32,
    })),
    ...manualResultNodes.map((resultNode) => ({
      key: manualResultNodeKey(resultNode.id),
      kind: 'manual-result',
      linkedNodeId: resultNode.linkedNodeId,
      x: resultNode.x,
      y: resultNode.y,
      width: 250,
      height: 128,
      portY: 80,
    })),
  ], [manualResultNodes, nodes, resultNodes, sourceNodePosition, sourcePreviewHeight, sourceSize]);
  const canvasItemMap = useMemo(
    () => new Map(canvasItems.map((item) => [item.key, item])),
    [canvasItems],
  );
  const allCanvasKeys = useMemo(() => canvasItems.map((item) => item.key), [canvasItems]);
  const canvasGroupsWithBounds = useMemo(() => canvasGroups.flatMap((group) => {
    const items = group.keys.map((key) => canvasItemMap.get(key)).filter(Boolean);
    if (items.length < 2) return [];
    const minX = Math.min(...items.map((item) => item.x));
    const minY = Math.min(...items.map((item) => item.y));
    const maxX = Math.max(...items.map((item) => item.x + item.width));
    const maxY = Math.max(...items.map((item) => item.y + item.height));
    return [{
      ...group,
      keys: items.map((item) => item.key),
      x: minX - 28,
      y: minY - 52,
      width: maxX - minX + 56,
      height: maxY - minY + 80,
    }];
  }), [canvasGroups, canvasItemMap]);
  const singleSelectedCanvasItem = canvasSelectedKeys.length === 1
    ? canvasItemMap.get(canvasSelectedKeys[0])
    : null;

  const applyCanvasPositions = (positions) => {
    if (positions[sourceNodeKey]) {
      setSourceNodePosition(positions[sourceNodeKey]);
    }
    setNodes((current) => current.map((node) => (
      positions[splitNodeKey(node.id)]
        ? { ...node, ...positions[splitNodeKey(node.id)] }
        : node
    )));
    setResultNodePositions((current) => {
      const next = { ...current };
      Object.entries(positions).forEach(([key, position]) => {
        if (key.startsWith('result:')) next[key.slice('result:'.length)] = position;
      });
      return next;
    });
    setManualResultNodes((current) => current.map((node) => (
      positions[manualResultNodeKey(node.id)]
        ? { ...node, ...positions[manualResultNodeKey(node.id)] }
        : node
    )));
  };

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(''), 3000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!resultViewer) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setResultViewer(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [resultViewer]);

  useEffect(() => {
    if (!candidatePreviewExpanded) return undefined;
    const collapseOnEscape = (event) => {
      if (event.key === 'Escape') setCandidatePreviewExpanded(false);
    };
    window.addEventListener('keydown', collapseOnEscape);
    return () => window.removeEventListener('keydown', collapseOnEscape);
  }, [candidatePreviewExpanded]);

  useEffect(() => {
    if (!topbarMenuOpen) return undefined;
    const closeMenu = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'pointerdown' && topbarMenuRef.current?.contains(event.target)) return;
      setTopbarMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenu);
    window.addEventListener('keydown', closeMenu);
    return () => {
      document.removeEventListener('pointerdown', closeMenu);
      window.removeEventListener('keydown', closeMenu);
    };
  }, [topbarMenuOpen]);

  useEffect(() => {
    if (reviewMode !== 'canvas') return undefined;
    const handleCanvasShortcut = (event) => {
      if (event.key === 'Escape') {
        setNodeInsertMenu(null);
        return;
      }
      if (
        event.key.toLowerCase() !== 'a'
        || (!event.ctrlKey && !event.metaKey)
        || event.target.closest('input, textarea, [contenteditable="true"]')
      ) return;
      event.preventDefault();
      setCanvasSelectedKeys(allCanvasKeys);
      setToast(`已选择全部 ${allCanvasKeys.length} 个节点`);
    };
    window.addEventListener('keydown', handleCanvasShortcut);
    return () => window.removeEventListener('keydown', handleCanvasShortcut);
  }, [allCanvasKeys, reviewMode]);

  useEffect(() => {
    if (reviewMode !== 'canvas') return undefined;
    const stopSpacePan = () => {
      spacePanRef.current = false;
      setSpacePanReady(false);
      setCanvasPanning(false);
      if (gestureRef.current?.kind === 'pan') gestureRef.current = null;
    };
    const handleSpaceDown = (event) => {
      if (
        event.code !== 'Space'
        || event.target?.closest?.('input, textarea, select, [contenteditable="true"]')
      ) return;
      event.preventDefault();
      spacePanRef.current = true;
      setSpacePanReady(true);
    };
    const handleSpaceUp = (event) => {
      if (event.code === 'Space') stopSpacePan();
    };
    window.addEventListener('keydown', handleSpaceDown);
    window.addEventListener('keyup', handleSpaceUp);
    window.addEventListener('blur', stopSpacePan);
    return () => {
      window.removeEventListener('keydown', handleSpaceDown);
      window.removeEventListener('keyup', handleSpaceUp);
      window.removeEventListener('blur', stopSpacePan);
      stopSpacePan();
    };
  }, [reviewMode]);

  useEffect(() => {
    setJobs((current) => {
      let migratedAny = false;
      const migrated = current.map((job) => {
        let jobChanged = false;
        const layerSnapshots = { ...(job.layerSnapshots || {}) };
        (job.nodeIds || []).forEach((nodeId) => {
          if (layerSnapshots[nodeId]) return;
          const node = nodes.find((candidate) => candidate.id === nodeId);
          if (!node) return;
          layerSnapshots[nodeId] = {
            bounds: { ...node.bounds },
            sourceRegionPixels: pixelBounds(node.bounds, sourceSize),
          };
          jobChanged = true;
        });
        if (!jobChanged && job.sourceSize) return job;
        if (!Object.keys(layerSnapshots).length) return job;
        if (!job.sourceSize) jobChanged = true;
        if (!jobChanged) return job;
        migratedAny = true;
        return {
          ...job,
          layerSnapshots,
          sourceSize: job.sourceSize || { ...sourceSize },
        };
      });
      return migratedAny ? migrated : current;
    });
  }, []);

  useEffect(() => {
    setJobs((current) => {
      const matching = current.filter((job) => jobMatchesSource(job, currentSource));
      return matching.length === current.length ? current : matching;
    });
  }, [currentSource]);

  useEffect(() => {
    window.localStorage.setItem('layer-review-jobs', JSON.stringify(jobs));
  }, [jobs]);

  useEffect(() => {
    runningNodeIdsRef.current.forEach((nodeId) => {
      if (!isNodeRunning(nodeId, localSubmissions, jobsForCurrentSource)) {
        runningNodeIdsRef.current.delete(nodeId);
      }
    });
  }, [jobsForCurrentSource, localSubmissions]);

  useEffect(() => {
    const interval = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const pendingJobs = jobs.filter((job) => (
      !['failed', 'send_failed'].includes(job.status)
      && (job.status !== 'completed' || !job.completedAt || !job.snapshotVerified)
    ));
    if (!pendingJobs.length) return undefined;

    let cancelled = false;
    const refresh = async () => {
      const updates = await Promise.all(pendingJobs.map(async (job) => {
        try {
          const response = await fetch(`/api/layer-review/jobs/${encodeURIComponent(job.id)}`, { cache: 'no-store' });
          if (response.status === 404) return { job_id: job.id, status: 'failed', images: [] };
          if (!response.ok) return null;
          return await response.json();
        } catch {
          return null;
        }
      }));
      if (cancelled) return;
      setJobs((current) => current.map((job) => {
        const update = updates.find((item) => item?.job_id === job.id);
        return update ? {
          ...job,
          status: update.status,
          images: update.images || [],
          layerSnapshots: update.layer_snapshots || job.layerSnapshots,
          sourceSize: update.source_size || job.sourceSize,
          sourceName: update.source_name || job.sourceName,
          snapshotVerified: Boolean(update.layer_snapshots),
          submittedAt: update.submitted_at ? new Date(update.submitted_at).getTime() : job.submittedAt,
          completedAt: update.completed_at ? new Date(update.completed_at).getTime() : job.completedAt,
          threadId: update.thread_id || job.threadId,
          turnId: update.turn_id || job.turnId,
          skillName: update.skill_name || job.skillName,
          statusDetail: update.status_detail || null,
          timing: update.timing || job.timing || {},
          executionRoute: update.execution_route || job.executionRoute || null,
          confirmationRequestedAt: update.status === 'needs_confirmation'
            ? job.confirmationRequestedAt || Date.now()
            : job.confirmationRequestedAt,
        } : job;
      }));
    };

    refresh();
    const interval = window.setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [jobs.map((job) => `${job.id}:${job.status}:${job.images?.length || 0}:${job.snapshotVerified ? 1 : 0}`).join('|')]);

  useEffect(() => {
    setBoundaryOpen(true);
    setShowOriginalOnly(false);
    setMaskTool(null);
    setDraftMark(null);
    setSelectedMarkId(null);
    setCandidatePreviewExpanded(false);
    setCandidateContext(expandedBounds(selected.bounds));
    annotationGestureRef.current = null;
  }, [selectedId]);

  useEffect(() => {
    setResultEditing(false);
    setResultEditMarks([]);
    setResultEditDraft(null);
    resultEditGestureRef.current = null;
  }, [selectedId, latestSelectedJob?.id]);

  useEffect(() => {
    const handleMove = (event) => {
      const gesture = gestureRef.current;
      if (!gesture) return;

      if (gesture.kind === 'pan') {
        setViewport((current) => ({
          ...current,
          x: gesture.originX + event.clientX - gesture.startX,
          y: gesture.originY + event.clientY - gesture.startY,
        }));
      }

      if (gesture.kind === 'canvas-nodes') {
        const dx = (event.clientX - gesture.startX) / viewport.scale;
        const dy = (event.clientY - gesture.startY) / viewport.scale;
        gesture.moved = gesture.moved
          || Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 4;
        const positions = {};
        gesture.origins.forEach(({ key, x, y }) => {
          positions[key] = { x: x + dx, y: y + dy };
        });
        applyCanvasPositions(positions);
      }

      if (gesture.kind === 'connect') {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const endX = (event.clientX - rect.left - gesture.viewportX) / gesture.scale;
        const endY = (event.clientY - rect.top - gesture.viewportY) / gesture.scale;
        gesture.endX = endX;
        gesture.endY = endY;
        gesture.moved = Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY) > 4;
        linkPreviewPathRef.current?.setAttribute(
          'd',
          connectionPath(gesture.sourceX, gesture.sourceY, endX, endY),
        );
      }

      if (gesture.kind === 'selection') {
        const coordinateWidth = gesture.context?.width ?? 100;
        const coordinateHeight = gesture.context?.height ?? 100;
        const dx = ((event.clientX - gesture.startX) / gesture.rect.width) * coordinateWidth;
        const dy = ((event.clientY - gesture.startY) / gesture.rect.height) * coordinateHeight;
        const original = gesture.bounds;
        let next = original;

        if (gesture.mode === 'move') {
          next = {
            ...original,
            x: clamp(original.x + dx, 0, 100 - original.width),
            y: clamp(original.y + dy, 0, 100 - original.height),
          };
        }

        if (gesture.mode === 'draw') {
          const currentX = clamp(gesture.anchorX + dx, 0, 100);
          const currentY = clamp(gesture.anchorY + dy, 0, 100);
          next = {
            x: Math.min(gesture.anchorX, currentX),
            y: Math.min(gesture.anchorY, currentY),
            width: Math.max(2, Math.abs(currentX - gesture.anchorX)),
            height: Math.max(2, Math.abs(currentY - gesture.anchorY)),
          };
          next.width = Math.min(next.width, 100 - next.x);
          next.height = Math.min(next.height, 100 - next.y);
        }

        if (!['move', 'draw'].includes(gesture.mode)) {
          if (gesture.mode.includes('e')) {
            next = { ...next, width: clamp(original.width + dx, 2, 100 - original.x) };
          }
          if (gesture.mode.includes('s')) {
            next = { ...next, height: clamp(original.height + dy, 2, 100 - original.y) };
          }
          if (gesture.mode.includes('w')) {
            const x = clamp(original.x + dx, 0, original.x + original.width - 2);
            next = { ...next, x, width: original.width + original.x - x };
          }
          if (gesture.mode.includes('n')) {
            const y = clamp(original.y + dy, 0, original.y + original.height - 2);
            next = { ...next, y, height: original.height + original.y - y };
          }
        }

        gesture.latestBounds = next;
        setNodes((current) => current.map((node) => (
          node.id === gesture.nodeId ? { ...node, bounds: next, status: node.status === 'accepted' ? 'candidate' : node.status } : node
        )));
      }
    };

    const handleUp = (event) => {
      const gesture = gestureRef.current;
      if (gesture?.kind === 'pan') setCanvasPanning(false);
      if (gesture?.kind === 'selection' && gesture.latestBounds) {
        setCandidateContext(expandedBounds(gesture.latestBounds));
      }
      if (gesture?.kind === 'connect') {
        const endX = gesture.endX ?? gesture.sourceX;
        const endY = gesture.endY ?? gesture.sourceY;
        setLinkPreview(null);
        openNodeInsertMenuAt(
          gesture.anchorKey,
          gesture.side,
          endX,
          endY,
        );
        event.preventDefault();
      }
      if (gesture?.kind === 'canvas-nodes' && gesture.moved) {
        canvasDragConsumedRef.current = true;
        window.setTimeout(() => {
          canvasDragConsumedRef.current = false;
        }, 0);
      }
      gestureRef.current = null;
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [viewport.scale]);

  const addActivity = (title) => {
    setActivity((current) => [{ id: Date.now(), title, time: '刚刚' }, ...current].slice(0, 5));
  };

  const dismissJob = (job) => {
    setJobs((current) => current.filter((item) => item.id !== job.id));
    setLocalSubmissions((current) => Object.fromEntries(
      Object.entries(current).filter(([, item]) => item.id !== job.id),
    ));
    addActivity('已移除失效的拆分任务状态');
    setToast('任务状态已从工作台移除');
  };

  const updateSelected = (patch) => {
    setNodes((current) => current.map((node) => (
      node.id === selected.id ? { ...node, ...patch } : node
    )));
  };

  const selectNode = (node, focusCanvas = false) => {
    setSelectedId(node.id);
    if (reviewMode === 'canvas') setCanvasSelectedKeys([splitNodeKey(node.id)]);
    if (focusCanvas) window.setTimeout(() => centerOn(node), 0);
  };

  const startCanvasNodeDrag = (event, key, linkedNodeId = '', groupKeys = null) => {
    if (spacePanRef.current) {
      startPan(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0) return;
    const multi = event.ctrlKey || event.metaKey || event.shiftKey;
    let dragKeys = groupKeys || canvasSelectedKeys;
    if (!groupKeys) {
      if (!canvasSelectedKeys.includes(key)) {
        dragKeys = multi ? [...canvasSelectedKeys, key] : [key];
      }
      if (!multi && !canvasSelectedKeys.includes(key)) dragKeys = [key];
    }
    dragKeys = dragKeys.filter((itemKey) => canvasItemMap.has(itemKey));
    if (!dragKeys.length) dragKeys = [key];
    setCanvasSelectedKeys(dragKeys);
    setNodeInsertMenu(null);
    if (linkedNodeId) setSelectedId(linkedNodeId);
    gestureRef.current = {
      kind: 'canvas-nodes',
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      origins: dragKeys.map((itemKey) => {
        const item = canvasItemMap.get(itemKey);
        return { key: itemKey, x: item.x, y: item.y };
      }),
    };
  };

  const selectAllCanvasNodes = () => {
    setCanvasSelectedKeys(allCanvasKeys);
    setNodeInsertMenu(null);
    setToast(`已选择全部 ${allCanvasKeys.length} 个节点`);
  };

  const arrangeCanvasNodes = () => {
    const keys = canvasSelectedKeys.length > 1 ? canvasSelectedKeys : allCanvasKeys;
    const items = keys.map((key) => canvasItemMap.get(key)).filter(Boolean);
    if (!items.length) return;
    const positions = {};
    const startX = keys.length === allCanvasKeys.length
      ? 120
      : Math.min(...items.map((item) => item.x));
    const startY = keys.length === allCanvasKeys.length
      ? 120
      : Math.min(...items.map((item) => item.y));
    const columnGap = 180;
    const rowGap = 92;
    const resultSiblingGap = 44;
    const sourceItem = items.find((item) => item.kind === 'source');
    const splitItems = items.filter((item) => item.kind === 'split');
    const resultItems = items.filter((item) => item.kind === 'result' || item.kind === 'manual-result');
    const maxSplitWidth = Math.max(0, ...splitItems.map((item) => item.width));
    const splitX = sourceItem ? startX + sourceItem.width + columnGap : startX;
    const resultX = splitItems.length ? splitX + maxSplitWidth + columnGap : splitX;
    const positionedResults = new Set();
    const splitPortYs = [];
    let nextRowY = startY;

    splitItems.forEach((splitItem) => {
      const children = resultItems.filter((item) => item.linkedNodeId === splitItem.linkedNodeId);
      const childrenHeight = children.reduce((height, item) => height + item.height, 0)
        + Math.max(0, children.length - 1) * resultSiblingGap;
      const rowHeight = Math.max(splitItem.height, childrenHeight);
      const splitY = nextRowY + (rowHeight - splitItem.height) / 2;
      positions[splitItem.key] = { x: splitX, y: splitY };
      splitPortYs.push(splitY + splitItem.portY);

      let childY = nextRowY + (rowHeight - childrenHeight) / 2;
      children.forEach((child) => {
        positions[child.key] = { x: resultX, y: childY };
        positionedResults.add(child.key);
        childY += child.height + resultSiblingGap;
      });
      nextRowY += rowHeight + rowGap;
    });

    const orphanResults = resultItems.filter((item) => !positionedResults.has(item.key));
    let orphanY = splitItems.length ? nextRowY : startY;
    orphanResults.forEach((item) => {
      positions[item.key] = { x: resultX, y: orphanY };
      orphanY += item.height + rowGap;
    });

    if (sourceItem) {
      const targetPortY = splitPortYs.length
        ? (splitPortYs[0] + splitPortYs[splitPortYs.length - 1]) / 2
        : startY + sourceItem.portY;
      positions[sourceItem.key] = { x: startX, y: targetPortY - sourceItem.portY };
    }

    const arrangedY = Object.values(positions).map((position) => position.y);
    const minArrangedY = arrangedY.length ? Math.min(...arrangedY) : startY;
    if (minArrangedY < startY) {
      const offsetY = startY - minArrangedY;
      Object.values(positions).forEach((position) => {
        position.y += offsetY;
      });
    }
    applyCanvasPositions(positions);
    setCanvasSelectedKeys(keys);
    addActivity(`已整理 ${items.length} 个画布节点`);
    setToast(`已整理 ${items.length} 个节点`);
    const arrangedItems = canvasItems.map((item) => (
      positions[item.key] ? { ...item, ...positions[item.key] } : item
    ));
    window.setTimeout(() => fitCanvasOverview(arrangedItems), 0);
  };

  const groupCanvasSelection = () => {
    const keys = canvasSelectedKeys.filter((key) => canvasItemMap.has(key));
    if (keys.length < 2) {
      setToast('请先选择至少两个节点');
      return;
    }
    const id = `group-${Date.now()}`;
    setCanvasGroups((current) => {
      const remaining = current
        .map((group) => ({ ...group, keys: group.keys.filter((key) => !keys.includes(key)) }))
        .filter((group) => group.keys.length > 1);
      return [...remaining, { id, name: `编组 ${current.length + 1}`, keys }];
    });
    addActivity(`${keys.length} 个节点已编组`);
    setToast(`已将 ${keys.length} 个节点编为一组`);
  };

  const ungroupCanvasNodes = (groupId) => {
    setCanvasGroups((current) => current.filter((group) => group.id !== groupId));
    setToast('已取消编组');
  };

  const openNodeInsertMenuAt = (anchorKey = null, side = 'right', dropX = null, dropY = null) => {
    const anchor = anchorKey ? canvasItemMap.get(anchorKey) : null;
    const rect = canvasRef.current?.getBoundingClientRect();
    let x;
    let y;
    const hasDropPoint = Number.isFinite(dropX) && Number.isFinite(dropY);
    if (hasDropPoint) {
      x = dropX + (side === 'left' ? -244 : 20);
      y = dropY - 58;
    } else if (anchor) {
      x = side === 'left' ? anchor.x - 218 : anchor.x + anchor.width + 42;
      y = anchor.y + Math.min(72, anchor.portY - 18);
    } else {
      x = rect ? (rect.width / 2 - viewport.x) / viewport.scale - 95 : 920;
      y = rect ? (rect.height - 320 - viewport.y) / viewport.scale : 420;
    }
    if (rect) {
      const menuHeight = 126 + categoryOrder.length * 48;
      const screenX = clamp(viewport.x + x * viewport.scale, 12, Math.max(12, rect.width - 264));
      const screenY = clamp(viewport.y + y * viewport.scale, 12, Math.max(12, rect.height - menuHeight - 84));
      x = (screenX - viewport.x) / viewport.scale;
      y = (screenY - viewport.y) / viewport.scale;
    }
    setNodeInsertMenu({
      anchorKey,
      side,
      x,
      y,
      insertPoint: hasDropPoint ? { x: dropX, y: dropY } : null,
    });
  };

  const openNodeInsertMenu = (event, anchorKey = null, side = 'right') => {
    event.preventDefault();
    event.stopPropagation();
    openNodeInsertMenuAt(anchorKey, side);
  };

  const startConnectionDrag = (event, item, side) => {
    if (spacePanRef.current) {
      startPan(event);
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceX = side === 'left' ? item.x : item.x + item.width;
    const sourceY = item.y + item.portY;
    setCanvasSelectedKeys([item.key]);
    setSelectedId(item.linkedNodeId || '');
    setNodeInsertMenu(null);
    setLinkPreview({ anchorKey: item.key, side, sourceX, sourceY });
    gestureRef.current = {
      kind: 'connect',
      anchorKey: item.key,
      side,
      sourceX,
      sourceY,
      endX: sourceX,
      endY: sourceY,
      startClientX: event.clientX,
      startClientY: event.clientY,
      viewportX: viewport.x,
      viewportY: viewport.y,
      scale: viewport.scale,
      moved: false,
    };
  };

  const addCanvasNode = (kind, requestedCategory = null) => {
    if (!nodeInsertMenu) return;
    const anchor = nodeInsertMenu.anchorKey ? canvasItemMap.get(nodeInsertMenu.anchorKey) : null;
    const anchorNode = anchor?.linkedNodeId
      ? nodes.find((node) => node.id === anchor.linkedNodeId)
      : null;
    const targetWidth = kind === 'split' ? 260 : 250;
    const targetPortY = kind === 'split' ? 91 : 80;
    const x = nodeInsertMenu.insertPoint
      ? nodeInsertMenu.side === 'left'
        ? nodeInsertMenu.insertPoint.x - targetWidth
        : nodeInsertMenu.insertPoint.x
      : anchor
        ? nodeInsertMenu.side === 'left'
          ? anchor.x - 360
          : anchor.x + anchor.width + 110
        : nodeInsertMenu.x;
    const y = nodeInsertMenu.insertPoint
      ? nodeInsertMenu.insertPoint.y - targetPortY
      : anchor
        ? anchor.y
        : nodeInsertMenu.y + 110;
    let key;
    let linkedNodeId = '';

    if (kind === 'split') {
      const category = requestedCategory
        || anchorNode?.category
        || (hasSelectedLayer ? selected.category : 'uiComponent');
      const id = `canvas-split-${Date.now()}`;
      const count = nodes.filter((node) => node.category === category).length + 1;
      const next = {
        id,
        name: `新拆分节点 ${count}`,
        category,
        status: ['kvBackground', 'uiComponent'].includes(category) ? 'needs-repair' : 'candidate',
        isCustom: true,
        removeBackground: defaultRemoveBackground(category),
        executionMode: 'fast',
        requirement: categoryMeta[category].defaultRequirement,
        refinementPrompt: '',
        bounds: anchorNode?.bounds
          ? { ...anchorNode.bounds }
          : { x: 10, y: 10, width: 30, height: 20 },
        x,
        y,
      };
      setNodes((current) => [...current, next]);
      key = splitNodeKey(id);
      linkedNodeId = id;
      setSelectedId(id);
      addActivity(`${next.name} 已从画布添加`);
    } else {
      const id = `canvas-result-${Date.now()}`;
      linkedNodeId = anchorNode?.id || anchor?.linkedNodeId || '';
      setManualResultNodes((current) => [...current, {
        id,
        name: anchorNode ? `${anchorNode.name} · 拆分结果` : `拆分结果节点 ${current.length + 1}`,
        linkedNodeId,
        x,
        y,
      }]);
      key = manualResultNodeKey(id);
      if (linkedNodeId) setSelectedId(linkedNodeId);
      addActivity('拆分结果节点已从画布添加');
    }

    if (anchor && key) {
      const from = nodeInsertMenu.side === 'left' ? key : anchor.key;
      const to = nodeInsertMenu.side === 'left' ? anchor.key : key;
      setManualEdges((current) => [...current, {
        id: `edge-${Date.now()}`,
        from,
        to,
      }]);
    }
    setCanvasSelectedKeys(key ? [key] : []);
    setNodeInsertMenu(null);
    setToast(kind === 'split' ? '已添加拆分节点' : '已添加拆分结果节点');
  };

  const startPan = (event) => {
    if (event.button !== 0) return;
    const hitInteractiveCanvasItem = event.target.closest(
      '.canvas-node, .result-node, .source-node, .canvas-group, .canvas-top-controls, .canvas-bottom-controls, .canvas-command-controls, .canvas-node-add, .node-type-menu',
    );
    if (!hitInteractiveCanvasItem) {
      setSelectedId('');
      setCanvasSelectedKeys([]);
      setNodeInsertMenu(null);
    }
    if (!spacePanRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    setCanvasPanning(true);
    gestureRef.current = {
      kind: 'pan',
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
    };
  };

  const startSelection = (event, mode) => {
    if (event.button !== 0) return;
    const rect = guidedImageRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    const anchorX = clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100);
    const anchorY = clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100);
    gestureRef.current = {
      kind: 'selection',
      mode,
      nodeId: selected.id,
      startX: event.clientX,
      startY: event.clientY,
      anchorX,
      anchorY,
      rect,
      bounds: { ...selected.bounds },
      context: { x: 0, y: 0, width: 100, height: 100 },
    };
    if (mode === 'draw') {
      updateSelected({ bounds: { x: anchorX, y: anchorY, width: 2, height: 2 }, status: 'candidate' });
    }
  };

  const startCandidateSelection = (event, mode) => {
    if (event.button !== 0 || (boundaryOpen && maskTool && !showOriginalOnly)) return;
    const rect = annotationPreviewRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    const context = candidateContext ?? expandedBounds(selected.bounds);
    const anchorX = clamp(context.x + ((event.clientX - rect.left) / rect.width) * context.width, 0, 100);
    const anchorY = clamp(context.y + ((event.clientY - rect.top) / rect.height) * context.height, 0, 100);
    gestureRef.current = {
      kind: 'selection',
      mode,
      nodeId: selected.id,
      startX: event.clientX,
      startY: event.clientY,
      anchorX,
      anchorY,
      rect,
      bounds: { ...selected.bounds },
      context,
    };
    if (mode === 'draw') {
      updateSelected({ bounds: { x: anchorX, y: anchorY, width: 2, height: 2 }, status: 'candidate' });
    }
  };

  const centerOnCanvasItem = (item) => {
    const canvas = canvasRef.current;
    if (!canvas || !item) return;
    const rect = canvas.getBoundingClientRect();
    setViewport((current) => {
      const scale = Math.max(current.scale, overviewViewport.scale);
      return {
        scale,
        x: rect.width / 2 - (item.x + item.width / 2) * scale,
        y: rect.height / 2 - (item.y + item.height / 2) * scale,
      };
    });
  };

  const centerOn = (node = selected) => {
    if (!node) return;
    centerOnCanvasItem(canvasItemMap.get(splitNodeKey(node.id)));
  };

  const focusCanvasSelection = () => {
    if (singleSelectedCanvasItem) {
      centerOnCanvasItem(singleSelectedCanvasItem);
      return;
    }
    fitCanvasOverview();
  };

  const fitCanvasOverview = (itemsOverride) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      setViewport(overviewViewport);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const stageRect = canvas.querySelector('.canvas-stage')?.getBoundingClientRect();
    const baseX = stageRect ? stageRect.left - viewport.x : rect.left;
    const baseY = stageRect ? stageRect.top - viewport.y : rect.top;
    const items = Array.isArray(itemsOverride) ? itemsOverride : canvasItems;
    if (!items.length) return;
    const minX = Math.min(...items.map((item) => item.x));
    const minY = Math.min(...items.map((item) => item.y));
    const maxX = Math.max(...items.map((item) => item.x + item.width));
    const maxY = Math.max(...items.map((item) => item.y + item.height));
    const padding = 64;
    const scale = clamp(Math.min(
      (rect.width - padding * 2) / (maxX - minX),
      (rect.height - padding * 2) / (maxY - minY),
      overviewViewport.scale,
    ), 0.22, overviewViewport.scale);

    setViewport({
      scale,
      x: Math.round(rect.left + (rect.width - (maxX - minX) * scale) / 2 - baseX - minX * scale),
      y: Math.round(rect.top + (rect.height - (maxY - minY) * scale) / 2 - baseY - minY * scale),
    });
  };

  const changeZoom = (delta) => {
    setViewport((current) => ({
      ...current,
      scale: Math.min(1.35, Math.max(0.22, Number((current.scale + delta).toFixed(2)))),
    }));
  };

  const handleWheel = (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    changeZoom(event.deltaY > 0 ? -0.08 : 0.08);
  };

  const goToIndex = (index) => {
    if (index < 0 || index >= nodes.length) return;
    selectNode(nodes[index], reviewMode === 'canvas');
  };

  const approveNode = (advance = false) => {
    setNodes((current) => current.map((node) => (
      node.id === selected.id ? { ...node, status: 'accepted' } : node
    )));
    addActivity(`${selected.name} 已确认`);

    if (!advance) {
      setToast(`${selected.name} 已确认`);
      return;
    }

    const next = nodes.slice(selectedIndex + 1).find((node) => node.status !== 'accepted')
      ?? nodes.slice(0, selectedIndex).find((node) => node.status !== 'accepted');
    if (next) {
      setSelectedId(next.id);
      setToast('已保存，继续下一项');
    } else {
      setToast('全部栏目已确认，可以发送到当前 Codex');
    }
  };

  const undoConfirmation = () => {
    const status = ['kvBackground', 'uiComponent'].includes(selected.category) ? 'needs-repair' : 'candidate';
    updateSelected({ status });
    setToast('已撤销当前确认');
  };

  const addLayer = (category) => {
    const categoryNodes = nodes.filter((node) => node.category === category);
    const count = categoryNodes.length + 1;
    const id = `${category.replace(/([A-Z])/g, '-$1').toLowerCase()}-${Date.now()}`;
    const lastNode = categoryNodes[categoryNodes.length - 1];
    const categoryX = {
      kvTitle: 1010,
      kvElement: 650,
      kvBackground: 1370,
      ordinaryText: 650,
      uiComponent: 1370,
    };
    const defaultNames = {
      kvTitle: 'KV 标题',
      kvElement: 'KV 元素',
      kvBackground: 'KV 背景',
      ordinaryText: '普通文字',
      uiComponent: 'UI 组件',
    };
    const next = {
      id,
      name: `${defaultNames[category]} ${count}`,
      category,
      status: ['kvBackground', 'uiComponent'].includes(category) ? 'needs-repair' : 'candidate',
      isCustom: true,
      removeBackground: defaultRemoveBackground(category),
      executionMode: 'fast',
      requirement: categoryMeta[category].defaultRequirement,
      refinementPrompt: '',
      bounds: lastNode
        ? {
            ...lastNode.bounds,
            x: clamp(lastNode.bounds.x + 2, 0, 100 - lastNode.bounds.width),
            y: clamp(lastNode.bounds.y + 2, 0, 100 - lastNode.bounds.height),
          }
        : { x: 10, y: clamp(12 + count * 8, 8, 84), width: 80, height: 10 },
      x: lastNode?.x ?? categoryX[category],
      y: Math.max(112, ...categoryNodes.map((node) => node.y)) + 190,
    };
    setNodes((current) => [...current, next]);
    setSelectedId(id);
    if (reviewMode === 'canvas') setCanvasSelectedKeys([splitNodeKey(id)]);
    addActivity(`${next.name} 已添加`);
    setToast(`已添加新的${categoryMeta[category].label}，请框选区域`);
  };

  const deleteSelected = () => {
    if (!hasSelectedLayer) return;
    const deletedKey = splitNodeKey(selected.id);
    const remaining = nodes.filter((node) => node.id !== selected.id);
    const next = remaining[Math.min(selectedIndex, remaining.length - 1)];
    setNodes(remaining);
    setMarks((current) => current.filter((mark) => mark.layer_id !== selected.id));
    setCanvasSelectedKeys((current) => current.filter((key) => key !== deletedKey));
    setCanvasGroups((current) => current
      .map((group) => ({ ...group, keys: group.keys.filter((key) => key !== deletedKey) }))
      .filter((group) => group.keys.length > 1));
    setManualEdges((current) => current.filter((edge) => edge.from !== deletedKey && edge.to !== deletedKey));
    setSelectedId(next?.id ?? '');
    addActivity(`${selected.name} 已删除`);
    setToast(`${selected.name} 已删除`);
  };

  const openResultViewer = (image, node, bounds = node.bounds, resultSourceSize = sourceSize) => {
    setResultViewer({
      image,
      node,
      bounds,
      sourceSize: resultSourceSize,
      region: pixelBounds(bounds, resultSourceSize),
    });
  };

  const appendRequirement = (value) => {
    const current = selected.requirement.trim();
    if (current.includes(value)) return;
    updateSelected({ requirement: current ? `${current}\n${value}。` : `${value}。`, status: selected.status === 'accepted' ? 'candidate' : selected.status });
  };

  const selectMaskTool = (tool) => {
    if (maskTool === tool && !showOriginalOnly) {
      setMaskTool(null);
      setDraftMark(null);
      annotationGestureRef.current = null;
      setToast('已退出边界工具');
      return;
    }
    setMaskTool(tool);
    setShowOriginalOnly(false);
    setBoundaryOpen(true);
    const label = tool === 'foreground' ? '保留画笔' : tool === 'background' ? '排除画笔' : '边界画笔';
    setToast(`${label}已开启，请在右侧大预览中操作`);
  };

  const toggleOriginalOnly = () => {
    setShowOriginalOnly((current) => !current);
    setMaskTool(null);
    setDraftMark(null);
    annotationGestureRef.current = null;
    setToast(showOriginalOnly ? '已显示精修标注' : '已临时隐藏精修标注');
  };

  const toggleBoundary = () => {
    setBoundaryOpen((current) => {
      if (current) {
        setMaskTool(null);
        setDraftMark(null);
        setSelectedMarkId(null);
        annotationGestureRef.current = null;
      }
      return !current;
    });
  };

  const buildPlan = (includeSource = false, explicitNodeIds = null) => {
    const planLayers = explicitNodeIds
      ? explicitNodeIds.map((nodeId) => nodes.find((node) => node.id === nodeId)).filter(Boolean)
      : nodes.filter((node) => node.status === 'accepted');
    const includesOrdinaryText = planLayers.some((node) => node.category === 'ordinaryText');
    const includesBackground = planLayers.some((node) => node.category === 'kvBackground');
    return {
      version: '0.7',
      task: 'split_ui_design_layers_with_manual_regions',
      source: {
        file_name: sourceName,
        canvas: sourceSize,
        coordinate_space: 'source_pixels',
        source_uri: sourceImage.startsWith('blob:') ? null : sourceImage,
        embedded_data_url: includeSource ? sourceDataUrl || null : undefined,
      },
      layers: planLayers.map((node, index) => {
        const normalizedRequirement = combinedRequirement({
          categoryDefault: categoryMeta[node.category].defaultRequirement,
          requirement: node.requirement,
          refinementPrompt: node.refinementPrompt,
        });
        return {
          layer_index: index + 1,
          id: node.id,
          category: node.category,
          category_label: categoryMeta[node.category].label,
          name: node.name,
          requirement: normalizedRequirement,
          refinement_requirement: String(node.refinementPrompt || '').trim() || null,
          execution_route_hint: classifyExecutionRoute({
            category: node.category,
            requirement: node.requirement,
            refinementPrompt: node.refinementPrompt,
            removeBackground: Boolean(node.removeBackground),
          }),
          source_region_percent: node.bounds,
          source_region_pixels: pixelBounds(node.bounds, sourceSize),
          mask_annotations: marks
            .filter((mark) => mark.layer_id === node.id)
            .map((mark, annotationIndex) => annotationForPlan(mark, node.bounds, sourceSize, annotationIndex)),
          mask_policy: {
            selected_region: 'candidate_scope_only',
            keep_region: 'force_include',
            exclude_region: 'force_remove',
            overlapping_keep_exclude: 'later_annotation_wins',
            manual_boundary: 'highest_priority_edge_override',
            remove_background: 'post_mask_alpha_output_only',
          },
          execution_mode: node.executionMode || 'fast',
          remove_background: Boolean(node.removeBackground),
          processing_route: categoryMeta[node.category].route,
          workflow_position: { x: node.x, y: node.y },
          output: {
            crop_to_source_region: true,
            width: pixelBounds(node.bounds, sourceSize).width,
            height: pixelBounds(node.bounds, sourceSize).height,
            original_source_x: pixelBounds(node.bounds, sourceSize).x,
            original_source_y: pixelBounds(node.bounds, sourceSize).y,
          },
        };
      }),
      constraints: {
        output_scope: 'selected_layers_only',
        auto_add_layers: false,
        mask_priority: [
          'manual_boundary_edge',
          'latest_keep_or_exclude_annotation',
          'selected_region_candidate_scope',
          'category_default',
          'remove_background_as_final_alpha_step',
        ],
        final_png_canvas: 'exact_source_region_crop',
        original_position: 'metadata_only',
        ordinary_ui_text: includesOrdinaryText ? 'one_shared_selected_layer' : 'not_requested',
        visible_pixels: 'source_pixel_locked_when_usable',
        repair_scope: 'only_occluded_or_text_removed_holes',
        background: includesBackground ? 'selected_original_clean_plate' : 'not_requested',
        remove_background_output: 'cropped_rgba_with_real_alpha',
      },
    };
  };

  const exportAccepted = () => {
    if (!acceptedCount) {
      setToast('先确认至少一个拆分项');
      return;
    }
    const file = new Blob([JSON.stringify(buildPlan(false), null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = 'layer-review-plan.json';
    anchor.click();
    URL.revokeObjectURL(href);
    addActivity(`${acceptedCount} 个拆分项已导出`);
    setToast('拆分计划已下载');
  };

  const downloadAllResults = async () => {
    if (!downloadableResults.length || downloadingAll) return;
    setDownloadingAll(true);
    setToast(`正在打包 ${downloadableResults.length} 张 PNG`);
    try {
      const entries = await Promise.all(downloadableResults.map(async ({ node, image, index }) => {
        const response = await fetch(image.url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${node.name} 下载失败（HTTP ${response.status}）`);
        const fileName = `${String(index + 1).padStart(2, '0')}-${pngDownloadName(image.name || node.name, node.id)}`;
        return [fileName, new Uint8Array(await response.arrayBuffer())];
      }));
      const archive = zipSync(Object.fromEntries(entries), { level: 0 });
      const href = URL.createObjectURL(new Blob([archive], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = 'layer-review-pngs.zip';
      anchor.click();
      URL.revokeObjectURL(href);
      addActivity(`${downloadableResults.length} 张拆分 PNG 已下载`);
      setToast(`已下载 ${downloadableResults.length} 张 PNG`);
    } catch (error) {
      setToast(`批量下载失败：${error.message}`);
    } finally {
      setDownloadingAll(false);
    }
  };

  const submitLayers = async (nodeIds, scope) => {
    if (!nodeIds.length) return;
    const submittedNodeIds = nodeIds.filter((nodeId) => (
      !runningNodeIdsRef.current.has(nodeId)
      && !isNodeRunning(nodeId, localSubmissions, jobsForCurrentSource)
    ));
    if (!submittedNodeIds.length) return;
    submittedNodeIds.forEach((nodeId) => runningNodeIdsRef.current.add(nodeId));
    if (scope === 'batch') setSubmitting(true);
    const localSubmittedAt = Date.now();
    setLocalSubmissions((current) => ({
      ...current,
      ...Object.fromEntries(submittedNodeIds.map((nodeId) => [nodeId, {
        id: `local-${nodeId}-${localSubmittedAt}`,
        nodeIds: [nodeId],
        status: 'sending_to_codex',
        images: [],
        submittedAt: localSubmittedAt,
        completedAt: null,
      }])),
    }));
    await nextPaint();
    const layerSnapshots = Object.fromEntries(submittedNodeIds.map((nodeId) => {
      const node = nodes.find((candidate) => candidate.id === nodeId);
      return [nodeId, {
        bounds: { ...node.bounds },
        sourceRegionPixels: pixelBounds(node.bounds, sourceSize),
      }];
    }));
    const submittedSourceSize = { ...sourceSize };
    try {
      const plan = buildPlan(true, submittedNodeIds);
      const cropDataUrls = await Promise.all(plan.layers.map((layer) => (
        cropRegionDataUrl(sourceImage, layer.source_region_percent, sourceSize)
      )));
      plan.layers = plan.layers.map((layer, index) => ({
        ...layer,
        review_snapshot: {
          bounds: layer.source_region_percent,
          source_region_pixels: layer.source_region_pixels,
          embedded_crop_data_url: cropDataUrls[index],
        },
      }));
      const response = await fetch('/api/layer-review/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plan),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setNodes((current) => current.map((node) => (
        submittedNodeIds.includes(node.id) ? { ...node, status: 'accepted' } : node
      )));
      setJobs((current) => [...current, {
        id: result.job_id,
        nodeIds: submittedNodeIds,
        layerSnapshots,
        sourceSize: submittedSourceSize,
        sourceName,
        status: result.status || 'sent_to_codex',
        images: [],
        submittedAt: result.submitted_at ? new Date(result.submitted_at).getTime() : Date.now(),
        completedAt: null,
        threadId: result.thread_id || null,
        turnId: result.turn_id || null,
        skillName: result.skill_name || 'split-ui-design-layers-workbench-targeted',
        timing: result.timing || {},
        executionRoute: result.execution_route || null,
      }]);
      addActivity(`${submittedNodeIds.length} 个拆分项已发送到当前 Codex 任务`);
      setToast(scope === 'batch' ? `已批量发送 ${submittedNodeIds.length} 项` : `${nodes.find((node) => node.id === submittedNodeIds[0])?.name || '当前项'}已发送`);
    } catch (error) {
      setToast(`提交失败：${error.message}`);
    } finally {
      setLocalSubmissions((current) => {
        const next = { ...current };
        submittedNodeIds.forEach((nodeId) => delete next[nodeId]);
        return next;
      });
      if (scope === 'batch') setSubmitting(false);
    }
  };

  const submitAccepted = () => {
    if (!batchReadyNodeIds.length) {
      setToast(acceptedCount ? '已确认项均已发送，可在单项中重试' : '先确认至少一个拆分项');
      return;
    }
    submitLayers(batchReadyNodeIds, 'batch');
  };

  const submitCurrent = () => submitLayers([selected.id], 'single');

  const annotationPoint = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100),
      y: clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100),
      previewWidth: rect.width,
    };
  };

  const startAnnotation = (event) => {
    if (!boundaryOpen || !maskTool || showOriginalOnly || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const point = annotationPoint(event);
    const id = `${selectedId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mark = {
      id,
      layer_id: selectedId,
      kind: maskTool,
      shape: 'stroke',
      points: [{ x: point.x, y: point.y }],
      brush_size_px: brushSize,
      brush_size_percent: (brushSize / point.previewWidth) * 100,
    };
    annotationGestureRef.current = {
      pointerId: event.pointerId,
      anchor: point,
      mark,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSelectedMarkId(null);
    setDraftMark(mark);
  };

  const moveAnnotation = (event) => {
    const gesture = annotationGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = annotationPoint(event);
    let next;
    if (gesture.mark.shape === 'rect') {
      next = {
        ...gesture.mark,
        x: Math.min(gesture.anchor.x, point.x),
        y: Math.min(gesture.anchor.y, point.y),
        width: Math.abs(point.x - gesture.anchor.x),
        height: Math.abs(point.y - gesture.anchor.y),
      };
    } else {
      const previous = gesture.mark.points.at(-1);
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
      if (distance < 0.22) return;
      next = { ...gesture.mark, points: [...gesture.mark.points, { x: point.x, y: point.y }] };
    }
    gesture.mark = next;
    setDraftMark(next);
  };

  const finishAnnotation = (event) => {
    const gesture = annotationGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const mark = gesture.mark;
    annotationGestureRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDraftMark(null);

    if (mark.shape === 'rect' && (mark.width < 1 || mark.height < 1)) {
      setToast('请在大预览中拖动，画出一个区域框');
      return;
    }
    setMarks((current) => [...current, mark]);
    setSelectedMarkId(mark.id);
  };

  const cancelAnnotation = (event) => {
    const gesture = annotationGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    annotationGestureRef.current = null;
    setDraftMark(null);
  };

  const undoLastMark = () => {
    const last = selectedMarks.at(-1);
    if (!last) return;
    setMarks((current) => current.filter((mark) => mark.id !== last.id));
    setSelectedMarkId((current) => (current === last.id ? null : current));
    setToast('已撤销上一步标注');
  };

  const deleteSelectedMark = () => {
    if (!selectedMarkId) return;
    setMarks((current) => current.filter((mark) => mark.id !== selectedMarkId));
    setSelectedMarkId(null);
    setToast('已删除选中的标注');
  };

  const clearMarks = () => {
    setMarks((current) => current.filter((mark) => mark.layer_id !== selectedId));
    setSelectedMarkId(null);
    setDraftMark(null);
    annotationGestureRef.current = null;
    setToast('当前项目的边界标注已清空');
  };

  const toggleResultEditing = () => {
    setResultEditing((current) => {
      const next = !current;
      if (next) {
        setResultEditTool('background');
        window.requestAnimationFrame(() => {
          resultEditPreviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          resultEditPreviewRef.current?.focus({ preventScroll: true });
        });
      }
      return next;
    });
  };

  const openGuidedEditor = (nodeId, editResult = false) => {
    setSelectedId(nodeId);
    setCanvasSelectedKeys([splitNodeKey(nodeId)]);
    setReviewMode('guided');
    setResultEditing(false);
    if (editResult) {
      window.setTimeout(() => {
        setResultEditing(true);
        window.requestAnimationFrame(() => {
          resultEditPreviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          resultEditPreviewRef.current?.focus({ preventScroll: true });
        });
      }, 0);
    }
  };

  const startResultAnnotation = (event) => {
    if (!resultEditing || !resultEditTool || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const point = annotationPoint(event);
    const id = `result-${selectedId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mark = {
      id,
      layer_id: selectedId,
      kind: resultEditTool,
      shape: 'stroke',
      points: [{ x: point.x, y: point.y }],
      brush_size_px: resultEditBrushSize,
      brush_size_percent: (resultEditBrushSize / point.previewWidth) * 100,
    };
    resultEditGestureRef.current = {
      pointerId: event.pointerId,
      anchor: point,
      mark,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setResultEditDraft(mark);
  };

  const moveResultAnnotation = (event) => {
    const gesture = resultEditGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = annotationPoint(event);
    let next;
    if (gesture.mark.shape === 'rect') {
      next = {
        ...gesture.mark,
        x: Math.min(gesture.anchor.x, point.x),
        y: Math.min(gesture.anchor.y, point.y),
        width: Math.abs(point.x - gesture.anchor.x),
        height: Math.abs(point.y - gesture.anchor.y),
      };
    } else {
      const previous = gesture.mark.points.at(-1);
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
      if (distance < 0.22) return;
      next = { ...gesture.mark, points: [...gesture.mark.points, { x: point.x, y: point.y }] };
    }
    gesture.mark = next;
    setResultEditDraft(next);
  };

  const finishResultAnnotation = (event) => {
    const gesture = resultEditGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const mark = gesture.mark;
    resultEditGestureRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setResultEditDraft(null);
    if (mark.shape === 'rect' && (mark.width < 1 || mark.height < 1)) {
      setToast('请在结果图上拖动，画出需要修整的区域');
      return;
    }
    setResultEditMarks((current) => [...current, mark]);
  };

  const cancelResultAnnotation = (event) => {
    const gesture = resultEditGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    resultEditGestureRef.current = null;
    setResultEditDraft(null);
  };

  const renderResultEditMark = (mark, draft = false) => {
    if (mark.shape === 'rect') {
      return (
        <rect
          key={mark.id}
          className={`annotation-mark annotation-mark--${mark.kind} ${draft ? 'annotation-mark--draft' : ''}`}
          x={mark.x}
          y={mark.y}
          width={mark.width}
          height={mark.height}
          vectorEffect="non-scaling-stroke"
        />
      );
    }
    if (mark.points.length === 1) {
      return (
        <circle
          key={mark.id}
          className={`annotation-mark annotation-mark--${mark.kind} ${draft ? 'annotation-mark--draft' : ''}`}
          cx={mark.points[0].x}
          cy={mark.points[0].y}
          r="0.7"
          vectorEffect="non-scaling-stroke"
        />
      );
    }
    return (
      <polyline
        key={mark.id}
        className={`annotation-mark annotation-mark--${mark.kind} ${draft ? 'annotation-mark--draft' : ''}`}
        points={mark.points.map((point) => `${point.x},${point.y}`).join(' ')}
        style={{ strokeWidth: `${mark.brush_size_px}px` }}
        vectorEffect="non-scaling-stroke"
      />
    );
  };

  const submitResultEdit = async () => {
    if (!latestSelectedResult?.image || submittingResultEdit) return;
    if (!resultEditMarks.length) {
      setToast('先在拆分结果上标注需要修整的区域');
      return;
    }

    setSubmittingResultEdit(true);
    try {
      const imageResponse = await fetch(latestSelectedResult.image.url, { cache: 'no-store' });
      if (!imageResponse.ok) throw new Error(`无法读取拆分结果（HTTP ${imageResponse.status}）`);
      const embeddedSource = await blobToDataUrl(await imageResponse.blob());
      const resultRegion = pixelBounds(latestSelectedResult.bounds, latestSelectedResult.sourceSize);
      const editSourceSize = { width: resultRegion.width, height: resultRegion.height };
      const fullResultBounds = { x: 0, y: 0, width: 100, height: 100 };
      const payload = {
        version: '0.7',
        task: 'refine_split_result',
        parent_job_id: latestSelectedResult.job.id,
        review_source_size: latestSelectedResult.sourceSize,
        source: {
          file_name: latestSelectedResult.image.name || `${selected.id}.png`,
          canvas: editSourceSize,
          coordinate_space: 'result_pixels',
          source_uri: null,
          embedded_data_url: embeddedSource,
        },
        layers: [{
          layer_index: 1,
          id: selected.id,
          category: selected.category,
          category_label: categoryMeta[selected.category].label,
          name: selected.name,
          requirement: '基于已有拆分结果继续精修，只修改本次标注区域；未标注像素、已有透明通道、画布尺寸和原始位置必须保持不变。',
          source_region_percent: fullResultBounds,
          source_region_pixels: { x: 0, y: 0, ...editSourceSize },
          review_snapshot: {
            bounds: latestSelectedResult.bounds,
            source_region_pixels: resultRegion,
          },
          mask_annotations: resultEditMarks.map((mark, index) => (
            annotationForPlan(mark, fullResultBounds, editSourceSize, index)
          )),
          mask_policy: {
            selected_region: 'existing_result_full_canvas',
            keep_region: 'force_include_existing_result_pixels',
            exclude_region: 'force_remove_to_transparent',
            manual_boundary: 'highest_priority_edge_override',
            preserve_unmarked_pixels: true,
          },
          execution_mode: selected.executionMode || 'fast',
          remove_background: true,
          processing_route: 'result_refinement',
          output: {
            crop_to_source_region: true,
            width: editSourceSize.width,
            height: editSourceSize.height,
            original_source_x: resultRegion.x,
            original_source_y: resultRegion.y,
          },
        }],
        constraints: {
          output_scope: 'selected_layers_only',
          auto_add_layers: false,
          edit_base: 'existing_split_result_png',
          preserve_unmarked_pixels: true,
          preserve_existing_alpha: true,
          final_png_canvas: 'exact_existing_result_canvas',
          visible_pixels: 'existing_result_pixel_locked_outside_annotations',
        },
      };

      const response = await fetch('/api/layer-review/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setJobs((current) => [...current, {
        id: result.job_id,
        nodeIds: [selected.id],
        layerSnapshots: {
          [selected.id]: {
            bounds: { ...latestSelectedResult.bounds },
            sourceRegionPixels: resultRegion,
          },
        },
        sourceSize: { ...latestSelectedResult.sourceSize },
        sourceName,
        status: result.status || 'sent_to_codex',
        images: [],
        submittedAt: result.submitted_at ? new Date(result.submitted_at).getTime() : Date.now(),
        completedAt: null,
        threadId: result.thread_id || null,
        turnId: result.turn_id || null,
        skillName: result.skill_name || 'split-ui-design-layers-workbench-targeted',
        parentJobId: latestSelectedResult.job.id,
        editKind: 'result_refinement',
      }]);
      addActivity(`${selected.name} 的拆分结果已提交二次精修`);
      setToast('结果修整已提交，原结果版本已保留');
    } catch (error) {
      setToast(`结果修整提交失败：${error.message}`);
    } finally {
      setSubmittingResultEdit(false);
    }
  };

  const resetPlan = () => {
    const nextNodes = sourceImage === '/demo-source.png' ? createInitialNodes() : [];
    setNodes(nextNodes);
    setSelectedId(nextNodes[0]?.id || '');
    setSourceNodePosition({ x: 110, y: 240 });
    setResultNodePositions({});
    setManualResultNodes([]);
    setManualEdges([]);
    setCanvasSelectedKeys([]);
    setCanvasGroups([]);
    setNodeInsertMenu(null);
    setMarks([]);
    setJobs([]);
    setLocalSubmissions({});
    setReviewMode('guided');
    addActivity(nextNodes.length ? '基础拆分栏目已刷新' : '拆分栏目已清空');
    setToast(nextNodes.length ? '拆分栏目已刷新' : '拆分栏目已清空');
  };

  const handleFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setSourceImage(objectUrl);
    setSourceName(file.name);
    setNodes([]);
    setSelectedId('');
    setSourceNodePosition({ x: 110, y: 240 });
    setResultNodePositions({});
    setManualResultNodes([]);
    setManualEdges([]);
    setCanvasSelectedKeys([]);
    setCanvasGroups([]);
    setNodeInsertMenu(null);
    setMarks([]);
    setJobs([]);
    setLocalSubmissions({});
    setCandidateContext(null);
    setReviewMode('guided');
    const reader = new FileReader();
    reader.onload = () => setSourceDataUrl(String(reader.result || ''));
    reader.readAsDataURL(file);
    const image = new window.Image();
    image.onload = () => setSourceSize({ width: image.naturalWidth, height: image.naturalHeight });
    image.src = objectUrl;
    addActivity(`已载入 ${file.name}`);
    setToast('原图已载入，请按实际内容添加拆分项');
    event.target.value = '';
  };

  const renderAnnotationMark = (mark, draft = false) => {
    const selectedClass = selectedMarkId === mark.id ? 'annotation-mark--selected' : '';
    const commonProps = draft ? {} : {
      onPointerDown: (event) => {
        event.stopPropagation();
        setSelectedMarkId(mark.id);
      },
    };
    if (mark.shape === 'rect') {
      return (
        <rect
          key={mark.id}
          className={`annotation-mark annotation-mark--${mark.kind} ${selectedClass} ${draft ? 'annotation-mark--draft' : ''}`}
          x={mark.x}
          y={mark.y}
          width={mark.width}
          height={mark.height}
          vectorEffect="non-scaling-stroke"
          {...commonProps}
        />
      );
    }
    if (mark.points.length === 1) {
      return (
        <circle
          key={mark.id}
          className={`annotation-mark annotation-mark--${mark.kind} ${selectedClass} ${draft ? 'annotation-mark--draft' : ''}`}
          cx={mark.points[0].x}
          cy={mark.points[0].y}
          r="0.7"
          vectorEffect="non-scaling-stroke"
          {...commonProps}
        />
      );
    }
    return (
      <polyline
        key={mark.id}
        className={`annotation-mark annotation-mark--${mark.kind} ${selectedClass} ${draft ? 'annotation-mark--draft' : ''}`}
        points={mark.points.map((point) => `${point.x},${point.y}`).join(' ')}
        style={{ strokeWidth: `${mark.brush_size_px}px` }}
        vectorEffect="non-scaling-stroke"
        {...commonProps}
      />
    );
  };

  const renderAnnotationOverlay = () => (
    <svg className="annotation-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="边界精修标注">
      {selectedMarks.map((mark) => renderAnnotationMark(mark))}
      {draftMark ? renderAnnotationMark(draftMark, true) : null}
    </svg>
  );

  const renderRequestPanel = () => {
    if (!hasSelectedLayer) {
      return (
        <div className="canvas-summary canvas-summary--empty">
          <ImagePlus size={22} />
          <strong>尚未建立拆分项</strong>
          <span>请从左侧分类添加与当前图片对应的拆分项。</span>
        </div>
      );
    }
    const CategoryIcon = categoryMeta[selected.category].icon;
    const pixels = pixelBounds(selected.bounds, sourceSize);
    const submittedPixels = latestSelectedResult
      ? pixelBounds(latestSelectedResult.bounds, latestSelectedResult.sourceSize)
      : null;
    const selectionChanged = submittedPixels
      ? pixels.x !== submittedPixels.x
        || pixels.y !== submittedPixels.y
        || pixels.width !== submittedPixels.width
        || pixels.height !== submittedPixels.height
      : false;
    return (
      <>
        <section className="inspector-section inspector-section--identity">
          <div className="request-category">
            <span><CategoryIcon size={17} />{categoryMeta[selected.category].label}</span>
            <LayerStatusPill node={selected} result={activeSelectedResult} />
          </div>

          {activeSelectedJob ? (
            <div className={`job-strip job-strip--${jobStatus(activeSelectedJob.status).tone}`}>
              {jobStatus(activeSelectedJob.status).tone === 'pending' ? <LoaderCircle size={15} className="spin" /> : <CheckCircle2 size={15} />}
              <span>
                <strong>{jobStatus(activeSelectedJob.status).label}，已用时 {formatElapsed(activeSelectedJob.submittedAt, elapsedEnd(activeSelectedJob, clockNow))}</strong>
                <small>
                  {activeSelectedJob.statusDetail || (
                    jobStatus(activeSelectedJob.status).tone === 'failed'
                      ? '任务已结束，可移除状态或重新拆分'
                      : activeSelectedJob.images?.length
                        ? `${activeSelectedJob.images.length} 张结果已回流`
                        : activeSelectedJob.status === 'sending_to_codex'
                          ? '正在提交框选预览、拆分提示词与执行计划'
                          : `开始于 ${formatClock(activeSelectedJob.submittedAt)}，正在当前任务中执行`
                  )}
                </small>
              </span>
              {!activeSelectedJob.images?.length ? (
                <button
                  type="button"
                  className="job-strip__dismiss"
                  aria-label="移除当前任务状态"
                  data-tooltip="移除当前任务状态"
                  onClick={() => dismissJob(activeSelectedJob)}
                >
                  <X size={13} />
                </button>
              ) : null}
            </div>
          ) : null}

          <label className="field-label" htmlFor="layer-name">图层名称</label>
          <div className="name-field-row">
            <input
              id="layer-name"
              className="text-field"
              value={selected.name}
              onChange={(event) => updateSelected({ name: event.target.value, status: selected.status === 'accepted' ? 'candidate' : selected.status })}
            />
            <IconButton label="删除当前拆分项" className="icon-button--danger" onClick={deleteSelected}><Trash2 size={16} /></IconButton>
          </div>
        </section>

        <section className="inspector-section">
          <label className="field-label" htmlFor="layer-requirement">具体拆分需求</label>
          <textarea
            id="layer-requirement"
            className="requirement-field"
            rows="5"
            value={selected.requirement}
            onChange={(event) => updateSelected({ requirement: event.target.value, status: selected.status === 'accepted' ? 'candidate' : selected.status })}
            placeholder="描述要保留什么、移除什么，以及哪些位置需要补全"
          />

          <div className="requirement-shortcuts" aria-label="常用拆分要求">
            {quickRequirements.map((item) => (
              <button type="button" key={item} onClick={() => appendRequirement(item)}><Plus size={13} />{item}</button>
            ))}
          </div>
        </section>

        <section className="inspector-section inspector-section--output">
          <div className="execution-mode-field">
            <div className="execution-mode-field__heading">
              <span>拆分模式</span>
              <small>仅作用于当前拆分项</small>
            </div>
            <div className="execution-mode-options" role="radiogroup" aria-label="拆分模式">
              <button
                type="button"
                role="radio"
                aria-checked={(selected.executionMode || 'fast') === 'fast'}
                className={(selected.executionMode || 'fast') === 'fast' ? 'execution-mode-option execution-mode-option--active' : 'execution-mode-option'}
                onClick={() => updateSelected({
                  executionMode: 'fast',
                  status: selected.status === 'accepted' ? 'candidate' : selected.status,
                })}
              >
                <strong>快速</strong>
                <small>原图提取优先，必要时单次补全</small>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={selected.executionMode === 'quality'}
                className={selected.executionMode === 'quality' ? 'execution-mode-option execution-mode-option--active' : 'execution-mode-option'}
                onClick={() => updateSelected({
                  executionMode: 'quality',
                  status: selected.status === 'accepted' ? 'candidate' : selected.status,
                })}
              >
                <strong>高质量</strong>
                <small>完整补全、边缘复检，可定向重试一次</small>
              </button>
            </div>
          </div>

          <label className={`processing-option ${selected.removeBackground ? 'processing-option--active' : ''}`}>
            <input
              type="checkbox"
              checked={Boolean(selected.removeBackground)}
              onChange={(event) => updateSelected({
                removeBackground: event.target.checked,
                status: selected.status === 'accepted' ? 'candidate' : selected.status,
              })}
            />
            <span className="processing-option__icon"><Eraser size={17} /></span>
            <span className="processing-option__copy"><strong>去除背景</strong><small>默认开启；完成边界判断后输出真实透明 RGBA PNG</small></span>
            <span className="processing-option__switch" aria-hidden="true" />
          </label>

          <div className={`region-readout ${submittedPixels ? 'region-readout--versions' : ''}`}>
            <span>
              <small>当前框选</small>
              <strong>{pixels.width} x {pixels.height}</strong>
              <em>位置 {pixels.x}, {pixels.y}</em>
            </span>
            {submittedPixels ? (
              <span>
                <small>{latestSelectedResult?.image ? '已产出版本' : '已提交版本'}</small>
                <strong>{submittedPixels.width} x {submittedPixels.height}</strong>
                <em>位置 {submittedPixels.x}, {submittedPixels.y}</em>
              </span>
            ) : (
              <span><strong>{pixels.x}, {pixels.y}</strong><small>左上坐标</small></span>
            )}
          </div>
          {selectionChanged ? (
            <div className="selection-version-note">
              <Move size={14} />
              <span>框选已修改。重新拆分后才会更新已产出版本。</span>
            </div>
          ) : null}
        </section>

        <section className="inspector-section inspector-section--boundary">
          <div className="boundary-section">
          <button type="button" className="boundary-toggle" onClick={toggleBoundary} aria-expanded={boundaryOpen}>
            <CheckCircle2 size={18} />
            <span><strong>{selectedMarks.length ? '边界已调整' : '边界精修'}</strong><small>{selectedMarks.length ? `${selectedMarks.length} 个精修笔划` : '在右侧大预览中精确编辑'}</small></span>
            <ChevronDown size={16} className={boundaryOpen ? 'chevron-open' : ''} />
          </button>
          {boundaryOpen ? (
            <div className="boundary-tools">
              <div className="boundary-tool-grid">
                <button type="button" aria-pressed={maskTool === 'foreground' && !showOriginalOnly} className={maskTool === 'foreground' && !showOriginalOnly ? 'boundary-tool boundary-tool--active boundary-tool--foreground' : 'boundary-tool'} onClick={() => selectMaskTool('foreground')}><Brush size={16} /> 保留画笔</button>
                <button type="button" aria-pressed={maskTool === 'background' && !showOriginalOnly} className={maskTool === 'background' && !showOriginalOnly ? 'boundary-tool boundary-tool--active boundary-tool--background' : 'boundary-tool'} onClick={() => selectMaskTool('background')}><Brush size={16} /> 排除画笔</button>
                <button type="button" aria-pressed={maskTool === 'brush' && !showOriginalOnly} className={maskTool === 'brush' && !showOriginalOnly ? 'boundary-tool boundary-tool--active boundary-tool--brush' : 'boundary-tool'} onClick={() => selectMaskTool('brush')}><Brush size={16} /> 边界画笔</button>
                <button type="button" aria-pressed={showOriginalOnly} className={showOriginalOnly ? 'boundary-tool boundary-tool--active' : 'boundary-tool'} onClick={toggleOriginalOnly}><Hand size={16} /> {showOriginalOnly ? '显示标注' : '隐藏标注'}</button>
              </div>
              {maskTool && !showOriginalOnly ? (
                <label className="brush-size-control">
                  <span>画笔大小</span>
                  <input type="range" min="1" max="52" step="1" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} />
                  <strong>{brushSize}px</strong>
                </label>
              ) : null}
              <p className="boundary-help">
                {showOriginalOnly
                  ? '当前只显示框选区域原图，再点“显示标注”继续编辑。'
                  : maskTool === 'foreground'
                    ? '在右侧大预览中涂抹，绿色笔划内的像素必须保留。'
                    : maskTool === 'background'
                      ? '在右侧大预览中涂抹，橙色笔划内的内容需要排除。'
                      : maskTool === 'brush'
                        ? '沿目标边缘拖动画笔，绘制紫色边界修整线。'
                        : '请选择一种画笔。选中后可再次点击同一按钮退出。'}
              </p>
              <div className="refinement-prompt">
                <label htmlFor="refinement-prompt">
                  <span>精修提示词</span>
                  <small>随具体拆分需求一起发送</small>
                </label>
                <textarea
                  id="refinement-prompt"
                  className="refinement-prompt__field"
                  rows="3"
                  value={selected.refinementPrompt || ''}
                  onChange={(event) => updateSelected({
                    refinementPrompt: event.target.value,
                    status: selected.status === 'accepted' ? 'candidate' : selected.status,
                  })}
                  placeholder="补充框内需要排除的内容、边缘处理方式和期望产出效果"
                />
              </div>
              {selectedMarks.length ? (
                <div className="annotation-history" aria-label="当前标注">
                  {selectedMarks.map((mark, index) => (
                    <button
                      type="button"
                      key={mark.id}
                      className={selectedMarkId === mark.id ? 'annotation-history__item annotation-history__item--selected' : 'annotation-history__item'}
                      onClick={() => setSelectedMarkId(mark.id)}
                    >
                      {mark.shape === 'stroke' ? <Brush size={12} /> : <Square size={12} />}
                      {mark.kind === 'foreground' ? '保留笔划' : mark.kind === 'background' ? '排除笔划' : '边界笔划'} {index + 1}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="annotation-actions">
                <button type="button" onClick={undoLastMark} disabled={!selectedMarks.length}><Undo2 size={13} /> 撤销</button>
                <button type="button" onClick={deleteSelectedMark} disabled={!selectedMarkId}><Trash2 size={13} /> 删除选中</button>
                <button type="button" onClick={clearMarks} disabled={!selectedMarks.length}>清空全部</button>
              </div>
            </div>
          ) : null}
          </div>
        </section>

        <div className="guided-actions">
          <button type="button" className="command-button command-button--quiet" onClick={() => goToIndex(selectedIndex - 1)} disabled={selectedIndex === 0}>
            <ChevronLeft size={16} /> 上一个
          </button>
          <button type="button" className="command-button command-button--quiet" onClick={() => approveNode(true)}>
            <Check size={17} /> 确认并下一个
          </button>
          <button type="button" className="command-button command-button--wide" onClick={submitCurrent} disabled={selectedNodeRunning}>
            {selectedNodeRunning ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}
            {selectedNodeRunning ? '拆分中' : latestSelectedResult?.image ? '重新拆分' : '拆分'}
          </button>
          {selected.status === 'accepted' ? <IconButton label="撤销当前确认" onClick={undoConfirmation}><Undo2 size={17} /></IconButton> : <span />}
        </div>
      </>
    );
  };

  const renderCanvasSummary = () => {
    if (!hasSelectedLayer) {
      return (
        <div className="canvas-summary canvas-summary--empty">
          <ScanSearch size={22} />
          <strong>选择一个拆分节点</strong>
          <span>这里只显示当前节点的拆分信息。</span>
        </div>
      );
    }
    const CategoryIcon = categoryMeta[selected.category].icon;
    const pixels = pixelBounds(selected.bounds, sourceSize);
    const submittedPixels = latestSelectedResult
      ? pixelBounds(latestSelectedResult.bounds, latestSelectedResult.sourceSize)
      : null;
    const selectionChanged = submittedPixels
      ? pixels.x !== submittedPixels.x
        || pixels.y !== submittedPixels.y
        || pixels.width !== submittedPixels.width
        || pixels.height !== submittedPixels.height
      : false;
    return (
      <div className="canvas-summary">
        <div className="request-category">
          <span><CategoryIcon size={17} />{categoryMeta[selected.category].label}</span>
          <span className="canvas-summary__heading-actions">
            <LayerStatusPill node={selected} result={latestSelectedResult} />
            <IconButton label="删除当前拆分项" className="icon-button--danger" onClick={deleteSelected}><Trash2 size={15} /></IconButton>
          </span>
        </div>
        <div className="canvas-summary__section">
          <span>拆分提示词</span>
          <p>{selected.requirement}</p>
        </div>
        <div className={`region-readout ${submittedPixels ? 'region-readout--versions' : ''}`}>
          <span>
            <small>当前框选</small>
            <strong>{pixels.width} x {pixels.height}</strong>
            <em>位置 {pixels.x}, {pixels.y}</em>
          </span>
          {submittedPixels ? (
            <span>
              <small>{latestSelectedResult?.image ? '已产出版本' : '已提交版本'}</small>
              <strong>{submittedPixels.width} x {submittedPixels.height}</strong>
              <em>位置 {submittedPixels.x}, {submittedPixels.y}</em>
            </span>
          ) : (
            <span><strong>{pixels.x}, {pixels.y}</strong><small>左上坐标</small></span>
          )}
        </div>
        {selectionChanged ? (
          <div className="selection-version-note">
            <Move size={14} />
            <span>框选已修改。重新拆分后才会更新已产出版本。</span>
          </div>
        ) : null}
        {latestSelectedResult?.image ? (
          <div className="canvas-summary__complete">
            <CheckCircle2 size={16} />
            <span>拆分已完成，点击结果节点查看大图</span>
          </div>
        ) : null}
        <div className={`canvas-summary__actions ${latestSelectedResult?.image ? '' : 'canvas-summary__actions--single'}`}>
          <button
            type="button"
            className="command-button command-button--quiet canvas-summary__edit"
            onClick={() => openGuidedEditor(selected.id)}
          >
            <ScanSearch size={16} /> 编辑拆分
          </button>
          {latestSelectedResult?.image ? (
            <button
              type="button"
              className="command-button canvas-summary__edit"
              onClick={() => openGuidedEditor(selected.id, true)}
            >
              <PencilLine size={16} /> 编辑结果
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="product-identity">
          <div className="brand-lockup">
            <div className="brand-mark"><Layers3 size={19} /></div>
            <div><strong>Layer Review</strong><span>交互式图层验收</span></div>
          </div>
          <div className="project-context" title={sourceName}>
            <span>当前项目</span>
            <strong>{sourceName}</strong>
            <small>{acceptedCount} / {nodes.length} 已确认</small>
          </div>
        </div>

        <ModeSwitch value={reviewMode} onChange={(mode) => {
          if (mode === 'guided' && !hasSelectedLayer) setSelectedId(nodes[0]?.id ?? '');
          setReviewMode(mode);
          if (mode === 'canvas') {
            setIsLeftOpen(false);
            setIsRightOpen(true);
            setCanvasSelectedKeys(hasSelectedLayer ? [splitNodeKey(selected.id)] : []);
            window.scrollTo({ top: 0, left: 0 });
            window.setTimeout(() => {
              if (canvasRef.current) {
                canvasRef.current.scrollTop = 0;
                canvasRef.current.scrollLeft = 0;
              }
              fitCanvasOverview();
            }, 220);
          }
        }} />

        <div className="topbar-actions">
          <button className="command-button command-button--quiet refresh-button" type="button" onClick={resetPlan}>
            <ScanSearch size={16} /> {sourceImage === '/demo-source.png' ? '恢复默认栏目' : '清空拆分栏目'}
          </button>
          <button
            className="command-button command-button--quiet download-all-button"
            type="button"
            onClick={downloadAllResults}
            disabled={!downloadableResults.length || downloadingAll}
            aria-label={`下载全部拆分 PNG${downloadableResults.length ? `，共 ${downloadableResults.length} 张` : '，暂无可下载结果'}`}
          >
            {downloadingAll ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
            <span>{downloadingAll ? '打包中' : `下载全部 PNG${downloadableResults.length ? ` ${downloadableResults.length}` : ''}`}</span>
          </button>
          <div ref={topbarMenuRef} className={`topbar-more ${topbarMenuOpen ? 'topbar-more--open' : ''}`}>
            <IconButton
              label="更多操作"
              aria-haspopup="menu"
              aria-expanded={topbarMenuOpen}
              onClick={() => setTopbarMenuOpen((current) => !current)}
            >
              <Ellipsis size={18} />
            </IconButton>
            {topbarMenuOpen ? (
              <div className="topbar-menu" role="menu" aria-label="更多操作">
                <button
                  type="button"
                  role="menuitem"
                  disabled={!acceptedCount}
                  onClick={() => {
                    setTopbarMenuOpen(false);
                    exportAccepted();
                  }}
                >
                  <FileJson size={17} />
                  <span>
                    <strong>导出拆分计划</strong>
                    <small>下载 JSON 配置</small>
                  </span>
                </button>
              </div>
            ) : null}
          </div>
          <div className="toolbar-divider" />
          <button className="command-button" type="button" onClick={submitAccepted} disabled={submitting || !batchReadyNodeIds.length}>
            {submitting ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}
            {submitting ? '发送中' : `发送已确认${batchReadyNodeIds.length ? ` ${batchReadyNodeIds.length}` : ''}`}
          </button>
        </div>
      </header>

      <section
        className={[
          'workspace',
          `workspace--${reviewMode}`,
          reviewMode === 'canvas' && !isLeftOpen ? 'workspace--left-collapsed' : '',
          reviewMode === 'canvas' && !isRightOpen ? 'workspace--right-collapsed' : '',
        ].filter(Boolean).join(' ')}
      >
        <aside className={`sidebar sidebar--left ${reviewMode === 'canvas' && !isLeftOpen ? 'sidebar--collapsed' : ''}`}>
          <div className="panel-title-row">
            <div>
              <span className="eyebrow">拆分栏目</span>
              <h1>{sourceName}</h1>
            </div>
            {reviewMode === 'canvas' ? <IconButton label="收起图层面板" onClick={() => setIsLeftOpen(false)}><PanelLeft size={17} /></IconButton> : null}
          </div>

          <div className="source-meta">
            <div className="source-meta__thumbnail"><img src={sourceImage} alt="当前原图" /></div>
            <div className="source-meta__copy"><strong>原始画布</strong><span>{sourceSize.width} x {sourceSize.height} RGBA</span></div>
            <label className="icon-button source-meta__upload" aria-label="重新载入原图" data-tooltip="重新载入原图">
              <Upload size={16} /><input type="file" accept="image/*" onChange={handleFile} />
            </label>
          </div>

          <div className="review-progress"><span style={{ width: `${nodes.length ? (acceptedCount / nodes.length) * 100 : 0}%` }} /></div>
          <div className="review-progress__copy"><span>{acceptedCount} 个已确认</span><strong>{nodes.length - acceptedCount} 个待处理</strong></div>

          <div className="layer-groups">
            {groupedNodes.map((group) => {
              const meta = categoryMeta[group.category];
              const CategoryIcon = meta.icon;
              const canDeleteSelected = hasSelectedLayer
                && selected.category === group.category;
              return (
                <section className="layer-group" key={group.category}>
                  <div className="layer-group__heading">
                    <span><CategoryIcon size={13} />{meta.label}</span>
                    <div className="layer-group__actions">
                      <small>{group.items.length}</small>
                      <button
                        type="button"
                        className={`delete-layer-button ${canDeleteSelected ? 'delete-layer-button--active' : ''}`}
                        aria-label={`删除当前选中的${meta.label}`}
                        data-tooltip={canDeleteSelected ? `删除 ${selected.name}` : `先选择一个${meta.label}图层`}
                        disabled={!canDeleteSelected}
                        onClick={deleteSelected}
                      >
                        <Trash2 size={13} />
                      </button>
                      <button type="button" className="add-layer-button add-layer-button--icon" aria-label={`添加${meta.label}`} data-tooltip={`添加${meta.label}`} onClick={() => addLayer(group.category)}><Plus size={13} /></button>
                    </div>
                  </div>
                  <div className="layer-list">
                    {group.items.map((node) => {
                      const rowResult = nodeResults.get(node.id);
                      const rowJob = localSubmissions[node.id] || rowResult?.job;
                      const rowPending = rowJob && jobStatus(rowJob.status).tone === 'pending';
                      return (
                        <button key={node.id} type="button" className={`layer-row ${selectedId === node.id ? 'layer-row--selected' : ''}`} onClick={() => selectNode(node, reviewMode === 'canvas')}>
                          <div className="layer-row__preview">
                            <RegionPreview sourceImage={sourceImage} sourceSize={sourceSize} bounds={node.bounds} compact />
                            {rowPending ? <span className="layer-row__progress" role="progressbar" aria-label={`${node.name}正在拆分`}><span /></span> : null}
                          </div>
                          <span className="layer-row__copy"><strong>{node.name}</strong><small>{categoryMeta[node.category].label} · {Math.round(node.bounds.width)}% x {Math.round(node.bounds.height)}%</small></span>
                          <LayerStatusPill node={node} result={rowResult || (rowJob ? { job: rowJob } : null)} />
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          {reviewMode === 'canvas' ? (
            <>
              <div className="queue-summary">
                <div><span>已确认</span><strong>{acceptedCount}</strong></div>
                <div><span>需补全</span><strong>{repairCount}</strong></div>
              </div>
              <div className="activity-feed">
                <div className="section-heading"><span>操作记录</span></div>
                {activity.map((item) => <div className="activity-row" key={item.id}><span className="activity-dot" /><span>{item.title}</span><small>{item.time}</small></div>)}
              </div>
            </>
          ) : null}
        </aside>

        {reviewMode === 'guided' ? (
          hasSelectedLayer ? (
          <section className="guided-viewport">
            <header className="guided-header">
              <div>
                <span>第 {selectedIndex + 1} / {nodes.length} 项</span>
                <h2>{selected.name}</h2>
              </div>
              <div className="guided-header__nav">
                <IconButton label="上一个拆分项" onClick={() => goToIndex(selectedIndex - 1)} disabled={selectedIndex === 0}><ChevronLeft size={17} /></IconButton>
                <IconButton label="下一个拆分项" onClick={() => goToIndex(selectedIndex + 1)} disabled={selectedIndex === nodes.length - 1}><ChevronRight size={17} /></IconButton>
              </div>
            </header>

            <div className="guided-preview-layout">
              <div className="source-position-panel">
                <div className="preview-label"><span>原图位置</span><small><Move size={12} /> {selected.bounds.x.toFixed(1)}%, {selected.bounds.y.toFixed(1)}%</small></div>
                <div
                  ref={guidedImageRef}
                  className="guided-source-image"
                  style={{ aspectRatio: `${sourceSize.width} / ${sourceSize.height}` }}
                  onPointerDown={(event) => startSelection(event, 'draw')}
                >
                  <img src={sourceImage} alt="原图位置" draggable="false" />
                  <span
                    className="source-highlight"
                    style={{ left: `${selected.bounds.x}%`, top: `${selected.bounds.y}%`, width: `${selected.bounds.width}%`, height: `${selected.bounds.height}%` }}
                    onPointerDown={(event) => startSelection(event, 'move')}
                  >
                    <i className="selection-handle selection-handle--nw" onPointerDown={(event) => startSelection(event, 'nw')} />
                    <i className="selection-handle selection-handle--ne" onPointerDown={(event) => startSelection(event, 'ne')} />
                    <i className="selection-handle selection-handle--sw" onPointerDown={(event) => startSelection(event, 'sw')} />
                    <i className="selection-handle selection-handle--se" onPointerDown={(event) => startSelection(event, 'se')} />
                  </span>
                </div>
              </div>

              <div className={`candidate-preview-panel ${candidatePreviewExpanded ? 'candidate-preview-panel--expanded' : ''}`}>
                <div className="preview-label">
                  <span>当前框选</span>
                  <StatusPill
                    status={selected.status}
                    label={selected.status === 'accepted' ? '框选已确认' : selected.status === 'needs-repair' ? '框选需补全' : '框选未确认'}
                  />
                </div>
                <RegionPreview
                  sourceImage={sourceImage}
                  sourceSize={sourceSize}
                  bounds={visibleCandidateContext}
                  previewRef={annotationPreviewRef}
                  interactive
                  className={`region-preview--guided region-preview--editable ${candidatePreviewExpanded ? 'region-preview--expanded' : ''} ${annotationModeActive ? `region-preview--tool-${maskTool}` : 'region-preview--crop-editor'}`}
                  onPointerDown={annotationModeActive ? startAnnotation : (event) => startCandidateSelection(event, 'draw')}
                  onPointerMove={annotationModeActive ? moveAnnotation : undefined}
                  onPointerUp={annotationModeActive ? finishAnnotation : undefined}
                  onPointerCancel={annotationModeActive ? cancelAnnotation : undefined}
                >
                  {annotationModeActive ? renderAnnotationOverlay() : (
                    <span
                      className="candidate-selection-frame"
                      style={{
                        left: `${candidateSelectionBounds.x}%`,
                        top: `${candidateSelectionBounds.y}%`,
                        width: `${candidateSelectionBounds.width}%`,
                        height: `${candidateSelectionBounds.height}%`,
                      }}
                      onPointerDown={(event) => startCandidateSelection(event, 'move')}
                    >
                      <i className="selection-handle selection-handle--nw" onPointerDown={(event) => startCandidateSelection(event, 'nw')} />
                      <i className="selection-handle selection-handle--ne" onPointerDown={(event) => startCandidateSelection(event, 'ne')} />
                      <i className="selection-handle selection-handle--sw" onPointerDown={(event) => startCandidateSelection(event, 'sw')} />
                      <i className="selection-handle selection-handle--se" onPointerDown={(event) => startCandidateSelection(event, 'se')} />
                    </span>
                  )}
                  {boundaryOpen || !annotationModeActive ? (
                    <span className="annotation-mode-indicator">
                      {!annotationModeActive
                        ? '拖动框选，或拖动边框与四角调整'
                        : showOriginalOnly
                        ? '标注已隐藏'
                        : maskTool === 'foreground'
                          ? '拖动绘制保留框'
                          : maskTool === 'background'
                            ? '拖动绘制排除框'
                            : maskTool === 'brush'
                              ? `画笔 ${brushSize}px`
                              : '请在右侧选择精修工具'}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="candidate-preview-toggle"
                    aria-label={candidatePreviewExpanded ? '缩小当前框选预览' : '放大当前框选预览'}
                    aria-pressed={candidatePreviewExpanded}
                    title={candidatePreviewExpanded ? '缩小预览' : '放大预览'}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setCandidatePreviewExpanded((current) => !current);
                    }}
                  >
                    {candidatePreviewExpanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                  </button>
                </RegionPreview>
                <div className="candidate-summary">
                  <span>{categoryMeta[selected.category].label}</span>
                  <ChevronRight size={14} />
                  <strong>{selected.name}</strong>
                  {selected.removeBackground ? <span className="candidate-option-badge"><Eraser size={12} /> 去背景</span> : null}
                </div>
                <p>{selected.requirement}</p>
              </div>
            </div>

            <section className={`guided-result-panel ${activeSelectedJob ? `guided-result-panel--${jobStatus(activeSelectedJob.status).tone}` : ''}`}>
              <header className="guided-result-panel__header">
                <div>
                  <span>Codex 拆分结果</span>
                  <strong>{selected.name}</strong>
                </div>
                <div className="guided-result-panel__actions">
                  {latestSelectedResult?.image ? (
                    <>
                      <button
                        type="button"
                        className={`guided-result-panel__edit ${resultEditing ? 'guided-result-panel__edit--active' : ''}`}
                        aria-pressed={resultEditing}
                        onClick={toggleResultEditing}
                      >
                        {resultEditing ? <X size={15} /> : <PencilLine size={15} />}
                        <span>{resultEditing ? '退出编辑' : '编辑结果'}</span>
                      </button>
                      <a
                        className="guided-result-panel__download"
                        href={latestSelectedResult.image.url}
                        download={latestSelectedResult.image.name || `${selected.id}.png`}
                        aria-label={`下载 ${selected.name}`}
                      >
                        <Download size={15} />
                        <span>下载 PNG</span>
                      </a>
                    </>
                  ) : null}
                  {activeSelectedJob ? (
                    <div className={`guided-result-panel__status guided-result-panel__status--${jobStatus(activeSelectedJob.status).tone}`}>
                      {jobStatus(activeSelectedJob.status).tone === 'pending' ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}
                      <span>{jobStatus(activeSelectedJob.status).label}</span>
                      <small>{formatElapsed(activeSelectedJob.submittedAt, elapsedEnd(activeSelectedJob, clockNow))}</small>
                    </div>
                  ) : (
                    <span className="guided-result-panel__idle-status">尚未发送</span>
                  )}
                </div>
              </header>

              <div className={`guided-result-panel__body ${resultEditing ? 'guided-result-panel__body--editing' : ''}`}>
                {localSubmissions[selected.id] ? (
                  <div className="guided-result-panel__pending">
                    <LoaderCircle size={30} className="spin" />
                    <strong>{splitProgress(activeSelectedJob.status).label}</strong>
                    <small>{splitProgress(activeSelectedJob.status).detail}</small>
                    <div className="split-progress-track" role="progressbar" aria-label="拆分任务进度"><span /></div>
                    <div className="split-progress-meta">
                      <span>{splitProgress(activeSelectedJob.status).stage}</span>
                      <span>已用时 {formatElapsed(activeSelectedJob.submittedAt, clockNow)}</span>
                    </div>
                  </div>
                ) : latestSelectedResult?.image ? (
                  <div className={`guided-result-panel__canvas ${resultEditing ? 'guided-result-panel__canvas--editing' : ''}`}>
                    {resultEditing ? (
                      <div className="result-editor__toolbar" role="toolbar" aria-label="结果精修工具">
                        <button
                          type="button"
                          aria-pressed={resultEditTool === 'foreground'}
                          className={resultEditTool === 'foreground' ? 'result-editor__tool result-editor__tool--active result-editor__tool--foreground' : 'result-editor__tool'}
                          onClick={() => setResultEditTool('foreground')}
                        >
                          <Brush size={14} /> 保留画笔
                        </button>
                        <button
                          type="button"
                          aria-pressed={resultEditTool === 'background'}
                          className={resultEditTool === 'background' ? 'result-editor__tool result-editor__tool--active result-editor__tool--background' : 'result-editor__tool'}
                          onClick={() => setResultEditTool('background')}
                        >
                          <Brush size={14} /> 擦除画笔
                        </button>
                        <button
                          type="button"
                          aria-pressed={resultEditTool === 'brush'}
                          className={resultEditTool === 'brush' ? 'result-editor__tool result-editor__tool--active result-editor__tool--brush' : 'result-editor__tool'}
                          onClick={() => setResultEditTool('brush')}
                        >
                          <Brush size={14} /> 边界画笔
                        </button>
                        <label className="result-editor__brush-size">
                          <span>笔刷</span>
                          <input
                            type="range"
                            min="1"
                            max="52"
                            step="1"
                            value={resultEditBrushSize}
                            onChange={(event) => setResultEditBrushSize(Number(event.target.value))}
                          />
                          <strong>{resultEditBrushSize}px</strong>
                        </label>
                      </div>
                    ) : null}
                    {resultEditing ? (
                      <div className={`result-editor__hint result-editor__hint--${resultEditTool}`}>
                        {resultEditTool === 'foreground'
                          ? `保留画笔：涂过的结果像素必须保留 · ${resultEditBrushSize}px`
                          : resultEditTool === 'background'
                            ? `擦除画笔：涂过的区域将变为透明 · ${resultEditBrushSize}px`
                            : `边界画笔：沿结果边缘绘制修整线 · ${resultEditBrushSize}px`}
                      </div>
                    ) : null}
                    <ResultPreview
                      image={latestSelectedResult.image}
                      sourceSize={latestSelectedResult.sourceSize}
                      bounds={latestSelectedResult.bounds}
                      previewRef={resultEditPreviewRef}
                      interactive={resultEditing}
                      tabIndex={resultEditing ? 0 : undefined}
                      className={`result-preview--guided-result ${resultEditing ? `result-preview--result-editor result-preview--tool-${resultEditTool}` : ''}`}
                      onPointerDown={resultEditing ? startResultAnnotation : undefined}
                      onPointerMove={resultEditing ? moveResultAnnotation : undefined}
                      onPointerUp={resultEditing ? finishResultAnnotation : undefined}
                      onPointerCancel={resultEditing ? cancelResultAnnotation : undefined}
                    >
                      {resultEditing ? (
                        <svg className="annotation-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="拆分结果精修标注">
                          {resultEditMarks.map((mark) => renderResultEditMark(mark))}
                          {resultEditDraft ? renderResultEditMark(resultEditDraft, true) : null}
                        </svg>
                      ) : null}
                    </ResultPreview>
                    {resultEditing ? (
                      <div className="result-editor__actions">
                        <span>以当前拆分 PNG 为底图，只修整标注区域</span>
                        <div>
                          <button
                            type="button"
                            onClick={() => setResultEditMarks((current) => current.slice(0, -1))}
                            disabled={!resultEditMarks.length}
                          >
                            <Undo2 size={13} /> 撤销
                          </button>
                          <button
                            type="button"
                            onClick={() => setResultEditMarks([])}
                            disabled={!resultEditMarks.length}
                          >
                            <Trash2 size={13} /> 清空
                          </button>
                          <button
                            type="button"
                            className="result-editor__submit"
                            onClick={submitResultEdit}
                            disabled={!resultEditMarks.length || submittingResultEdit}
                          >
                            {submittingResultEdit ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
                            {submittingResultEdit ? '提交中' : '提交修整'}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : activeSelectedJob && jobStatus(activeSelectedJob.status).tone === 'pending' ? (
                  <div className="guided-result-panel__pending">
                    <LoaderCircle size={30} className="spin" />
                    <strong>{splitProgress(activeSelectedJob.status).label}</strong>
                    <small>{splitProgress(activeSelectedJob.status).detail}</small>
                    <div className="split-progress-track" role="progressbar" aria-label="拆分任务进度"><span /></div>
                    <div className="split-progress-meta">
                      <span>{splitProgress(activeSelectedJob.status).stage}</span>
                      <span>已用时 {formatElapsed(activeSelectedJob.submittedAt, clockNow)}</span>
                    </div>
                  </div>
                ) : (
                  <div className="guided-result-panel__empty">
                    <ImagePlus size={26} />
                    <strong>拆分图将在这里显示</strong>
                    <small>上方原图框选会一直保留，方便继续调整后重新发送。</small>
                  </div>
                )}
              </div>

              <footer className="guided-result-panel__footer">
                <span>
                  {pixelBounds(latestSelectedResult?.bounds ?? selected.bounds, latestSelectedResult?.sourceSize ?? sourceSize).width}
                  {' x '}
                  {pixelBounds(latestSelectedResult?.bounds ?? selected.bounds, latestSelectedResult?.sourceSize ?? sourceSize).height} px
                </span>
                <small>{latestSelectedResult ? '输出尺寸锁定为提交拆分时的框选区域' : '输出尺寸将在点击拆分时锁定'}</small>
              </footer>
            </section>
          </section>
          ) : (
            <section className="guided-viewport guided-viewport--empty">
              <div className="guided-empty-state">
                <ImagePlus size={28} />
                <strong>原图已载入，尚未建立拆分项</strong>
                <span>工作台不会再根据旧演示图自动填充列表。请从左侧对应分类的“+”开始添加。</span>
                <button type="button" onClick={() => addLayer('uiComponent')}>
                  <Plus size={16} /> 新增拆分项
                </button>
              </div>
            </section>
          )
        ) : (
          <section
            ref={canvasRef}
            className={`canvas-viewport ${spacePanReady ? 'canvas-viewport--pan-ready' : ''} ${canvasPanning ? 'canvas-viewport--panning' : ''}`}
            aria-label="无限画布，按住空格并拖动鼠标移动画布"
            onPointerDown={startPan}
            onWheel={handleWheel}
          >
            {!isLeftOpen || !isRightOpen ? (
              <div className="canvas-top-controls">
                {!isLeftOpen ? <IconButton label="展开图层面板" onClick={() => setIsLeftOpen(true)}><PanelLeft size={17} /></IconButton> : null}
                {!isRightOpen ? <IconButton label="展开检查器" onClick={() => setIsRightOpen(true)}><PanelRight size={17} /></IconButton> : null}
              </div>
            ) : null}
            <div className="canvas-bottom-controls" onPointerDown={(event) => event.stopPropagation()}>
              <IconButton label="缩小画布" onClick={() => changeZoom(-0.1)}><ZoomOut size={17} /></IconButton>
              <button className="zoom-readout" type="button" aria-label="适配全部节点" onClick={fitCanvasOverview}>{Math.round(viewport.scale * 100)}%</button>
              <IconButton label="放大画布" onClick={() => changeZoom(0.1)}><ZoomIn size={17} /></IconButton>
              <span className="canvas-control-divider" />
              <span className={`canvas-pan-hint ${spacePanReady ? 'canvas-pan-hint--active' : ''}`}>
                <Hand size={14} /> 空格 + 拖动
              </span>
              <span className="canvas-control-divider" />
              <button className="canvas-overview-button" type="button" onClick={fitCanvasOverview}><LocateFixed size={16} /> 总览</button>
              <IconButton label="聚焦选中图层" onClick={focusCanvasSelection}><Focus size={17} /></IconButton>
            </div>
            <div className="canvas-command-controls" onPointerDown={(event) => event.stopPropagation()}>
              <button className="canvas-command canvas-command--primary" type="button" onClick={(event) => openNodeInsertMenu(event)}>
                <Plus size={17} /> 新增节点
              </button>
              <span className="canvas-control-divider" />
              <button className="canvas-command" type="button" onClick={selectAllCanvasNodes}>
                <Square size={15} /> 全选
              </button>
              <button className="canvas-command" type="button" onClick={arrangeCanvasNodes}>
                <WandSparkles size={15} /> 整理
              </button>
              <button className="canvas-command" type="button" onClick={groupCanvasSelection} disabled={canvasSelectedKeys.length < 2}>
                <Layers3 size={15} /> 编组
              </button>
              <span className="canvas-selection-count">
                {canvasSelectedKeys.length ? `已选 ${canvasSelectedKeys.length}` : '未选择'}
              </span>
            </div>

            <div
              className={`canvas-stage ${viewport.scale < 0.68 ? 'canvas-stage--compact' : ''} ${canvasSelectedKeys.length ? 'canvas-stage--has-selection' : ''}`}
              style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}
            >
              <svg className="flow-links" viewBox="0 0 2500 1600" aria-hidden="true">
                {nodes.map((node) => {
                  const sourceItem = canvasItemMap.get(sourceNodeKey);
                  const targetItem = canvasItemMap.get(splitNodeKey(node.id));
                  if (!sourceItem || !targetItem) return null;
                  return (
                    <path
                      key={node.id}
                      d={connectionPath(
                        sourceItem.x + sourceItem.width,
                        sourceItem.y + sourceItem.portY,
                        targetItem.x,
                        targetItem.y + targetItem.portY,
                      )}
                      className={`flow-link flow-link--${categoryMeta[node.category].route} ${
                        canvasSelectedKeys.includes(sourceNodeKey) || canvasSelectedKeys.includes(splitNodeKey(node.id))
                          ? 'flow-link--active'
                          : ''
                      }`}
                    />
                  );
                })}
                {resultNodes.map(({ node, job }) => {
                  const sourceItem = canvasItemMap.get(splitNodeKey(node.id));
                  const key = resultNodeKey(`${job.id}-${node.id}`);
                  const targetItem = canvasItemMap.get(key);
                  if (!sourceItem || !targetItem) return null;
                  return (
                    <path
                      key={`${job.id}-${node.id}`}
                      d={connectionPath(
                        sourceItem.x + sourceItem.width,
                        sourceItem.y + sourceItem.portY,
                        targetItem.x,
                        targetItem.y + targetItem.portY,
                      )}
                      className={`flow-link flow-link--result ${
                        canvasSelectedKeys.includes(splitNodeKey(node.id)) || canvasSelectedKeys.includes(key)
                          ? 'flow-link--active'
                          : ''
                      }`}
                    />
                  );
                })}
                {manualEdges.map((edge) => {
                  const from = canvasItemMap.get(edge.from);
                  const to = canvasItemMap.get(edge.to);
                  if (!from || !to) return null;
                  const forward = to.x >= from.x;
                  const sourceX = forward ? from.x + from.width : from.x;
                  const targetX = forward ? to.x : to.x + to.width;
                  return (
                    <path
                      key={edge.id}
                      d={connectionPath(sourceX, from.y + from.portY, targetX, to.y + to.portY)}
                      className={`flow-link flow-link--manual ${canvasSelectedKeys.includes(edge.from) || canvasSelectedKeys.includes(edge.to) ? 'flow-link--active' : ''}`}
                    />
                  );
                })}
                {linkPreview ? (
                  <path
                    ref={linkPreviewPathRef}
                    d={connectionPath(linkPreview.sourceX, linkPreview.sourceY, linkPreview.sourceX, linkPreview.sourceY)}
                    className="flow-link flow-link--draft"
                  />
                ) : null}
              </svg>

              {canvasGroupsWithBounds.map((group) => (
                <section
                  key={group.id}
                  className={`canvas-group ${group.keys.every((key) => canvasSelectedKeys.includes(key)) ? 'canvas-group--selected' : ''}`}
                  style={{ left: group.x, top: group.y, width: group.width, height: group.height }}
                  aria-label={`${group.name}，${group.keys.length} 个节点`}
                >
                  <header onPointerDown={(event) => startCanvasNodeDrag(event, group.keys[0], '', group.keys)}>
                    <span><Layers3 size={14} /> {group.name}<small>{group.keys.length} 个节点</small></span>
                    <button
                      type="button"
                      aria-label={`取消${group.name}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        ungroupCanvasNodes(group.id);
                      }}
                    >
                      <X size={13} />
                    </button>
                  </header>
                </section>
              ))}

              <article
                className={`source-node ${canvasSelectedKeys.includes(sourceNodeKey) ? 'source-node--selected' : ''}`}
                style={{ left: sourceNodePosition.x, top: sourceNodePosition.y, width: sourcePreviewWidth }}
                role="button"
                tabIndex={0}
                aria-label="选择原图节点"
                aria-pressed={canvasSelectedKeys.includes(sourceNodeKey)}
                onPointerDown={(event) => startCanvasNodeDrag(event, sourceNodeKey)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setCanvasSelectedKeys([sourceNodeKey]);
                    setSelectedId('');
                  }
                }}
              >
                <div className="canvas-node-meta">
                  <span><ImagePlus size={14} /><strong>原图</strong></span>
                  <small>{sourceSize.width} x {sourceSize.height}</small>
                </div>
                <div className="canvas-node-frame">
                  <div className="source-node__image" style={{ height: sourcePreviewHeight }}>
                    <img src={sourceImage} alt="图层拆分原图" draggable="false" />
                  </div>
                </div>
              </article>

              {nodes.map((node) => {
                const route = routeMeta[categoryMeta[node.category].route];
                const RouteIcon = route.icon;
                const key = splitNodeKey(node.id);
                const region = pixelBounds(node.bounds, sourceSize);
                const preview = fitCanvasPreviewSize(region.width, region.height);
                return (
                  <article
                    key={node.id}
                    className={`canvas-node canvas-node--${route.color} ${canvasSelectedKeys.includes(key) ? 'canvas-node--selected' : ''}`}
                    style={{ left: node.x, top: node.y, width: preview.width }}
                    role="button"
                    tabIndex={0}
                    aria-label={`选择 ${node.name}`}
                    aria-pressed={canvasSelectedKeys.includes(key)}
                    onPointerDown={(event) => startCanvasNodeDrag(event, key, node.id)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setCanvasSelectedKeys([key]);
                        setSelectedId(node.id);
                      }
                    }}
                  >
                    <div className="canvas-node-meta">
                      <span><RouteIcon size={14} /><strong>{node.name}</strong></span>
                      <span className="canvas-node-meta__actions">
                        <small>{region.width} x {region.height}</small>
                        <button
                          type="button"
                          className="canvas-node-meta__edit"
                          aria-label={`编辑拆分 ${node.name}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            openGuidedEditor(node.id);
                          }}
                        >
                          <PencilLine size={13} />
                        </button>
                      </span>
                    </div>
                    <div className="canvas-node-frame">
                      <div className="canvas-node__media" style={{ height: preview.height }}>
                        <RegionPreview sourceImage={sourceImage} sourceSize={sourceSize} bounds={node.bounds} className="region-preview--node">
                          {nodeResults.get(node.id)?.job && jobStatus(nodeResults.get(node.id).job.status).tone === 'pending' ? (
                            <span className="node-processing"><LoaderCircle size={18} className="spin" /></span>
                          ) : null}
                        </RegionPreview>
                      </div>
                    </div>
                  </article>
                );
              })}

              {resultNodes.map((resultNode) => {
                const {
                  job,
                  node,
                  image,
                  bounds,
                  sourceSize: resultSourceSize,
                  x,
                  y,
                  previewWidth,
                  previewHeight,
                } = resultNode;
                const meta = jobStatus(job.status);
                const key = resultNodeKey(resultNode.id);
                const region = pixelBounds(bounds, resultSourceSize);
                return (
                  <article
                    key={resultNode.id}
                    className={`result-node result-node--${meta.tone} ${canvasSelectedKeys.includes(key) ? 'result-node--selected' : ''}`}
                    style={{ left: x, top: y, width: previewWidth }}
                    role="button"
                    tabIndex={0}
                    aria-label={`选择拆分结果 ${node.name}`}
                    aria-pressed={canvasSelectedKeys.includes(key)}
                    onPointerDown={(event) => startCanvasNodeDrag(event, key, node.id)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setCanvasSelectedKeys([key]);
                        setSelectedId(node.id);
                      }
                    }}
                  >
                    <div className="canvas-node-meta">
                      <span>{meta.tone === 'pending' ? <LoaderCircle size={14} className="spin" /> : <ImagePlus size={14} />}<strong>{node.name} - 拆分结果</strong></span>
                      <span className="canvas-node-meta__actions">
                        <small>{region.width} x {region.height}</small>
                        {image ? (
                          <button
                            type="button"
                            className="canvas-node-meta__edit"
                            aria-label={`编辑结果 ${node.name}`}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              openGuidedEditor(node.id, true);
                            }}
                          >
                            <PencilLine size={13} />
                          </button>
                        ) : null}
                      </span>
                    </div>
                    <div className="canvas-node-frame">
                      {image ? (
                        <button type="button" className="result-node__image" style={{ height: previewHeight }} onClick={(event) => {
                          if (canvasDragConsumedRef.current) {
                            event.preventDefault();
                            event.stopPropagation();
                            return;
                          }
                          event.stopPropagation();
                          openResultViewer(image, node, bounds, resultSourceSize);
                        }}>
                          <ResultPreview image={image} sourceSize={resultSourceSize} bounds={bounds} />
                        </button>
                      ) : (
                        <div className="result-node__pending">
                          <LoaderCircle size={22} className="spin" />
                          <span>等待输出 PNG</span>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}

              {manualResultNodes.map((resultNode) => {
                const key = manualResultNodeKey(resultNode.id);
                return (
                  <article
                    key={resultNode.id}
                    className={`result-node result-node--manual ${canvasSelectedKeys.includes(key) ? 'result-node--selected' : ''}`}
                    style={{ left: resultNode.x, top: resultNode.y }}
                    role="button"
                    tabIndex={0}
                    aria-label={`选择 ${resultNode.name}`}
                    aria-pressed={canvasSelectedKeys.includes(key)}
                    onPointerDown={(event) => startCanvasNodeDrag(event, key, resultNode.linkedNodeId)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setCanvasSelectedKeys([key]);
                        setSelectedId(resultNode.linkedNodeId);
                      }
                    }}
                  >
                    <div className="canvas-node-meta">
                      <span><ImagePlus size={14} /><strong>{resultNode.name}</strong></span>
                      <small>待生成</small>
                    </div>
                    <div className="canvas-node-frame">
                      <div className="result-node__pending">
                        <Plus size={22} />
                        <span>等待拆分结果</span>
                      </div>
                    </div>
                  </article>
                );
              })}

              {singleSelectedCanvasItem ? (
                <>
                  {singleSelectedCanvasItem.kind !== 'source' ? (
                    <button
                      type="button"
                      className={`canvas-node-add canvas-node-add--left ${linkPreview?.anchorKey === singleSelectedCanvasItem.key && linkPreview.side === 'left' ? 'canvas-node-add--dragging' : ''}`}
                      style={{
                        left: singleSelectedCanvasItem.x - 18 / viewport.scale - 13,
                        top: singleSelectedCanvasItem.y + singleSelectedCanvasItem.portY - 13,
                        transform: `scale(${1 / viewport.scale})`,
                        transformOrigin: 'center',
                      }}
                      aria-label="从左侧连接节点"
                      onPointerDown={(event) => startConnectionDrag(event, singleSelectedCanvasItem, 'left')}
                      onClick={(event) => {
                        if (event.detail === 0) openNodeInsertMenu(event, singleSelectedCanvasItem.key, 'left');
                      }}
                    >
                      <Plus size={15} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`canvas-node-add canvas-node-add--right ${linkPreview?.anchorKey === singleSelectedCanvasItem.key && linkPreview.side === 'right' ? 'canvas-node-add--dragging' : ''}`}
                    style={{
                      left: singleSelectedCanvasItem.x + singleSelectedCanvasItem.width + 18 / viewport.scale - 13,
                      top: singleSelectedCanvasItem.y + singleSelectedCanvasItem.portY - 13,
                      transform: `scale(${1 / viewport.scale})`,
                      transformOrigin: 'center',
                    }}
                    aria-label="从右侧连接节点"
                    onPointerDown={(event) => startConnectionDrag(event, singleSelectedCanvasItem, 'right')}
                    onClick={(event) => {
                      if (event.detail === 0) openNodeInsertMenu(event, singleSelectedCanvasItem.key, 'right');
                    }}
                  >
                    <Plus size={15} />
                  </button>
                </>
              ) : null}

              {nodeInsertMenu ? (
                <div
                  className="node-type-menu"
                  style={{
                    left: nodeInsertMenu.x,
                    top: nodeInsertMenu.y,
                    transform: `scale(${1 / viewport.scale})`,
                    transformOrigin: 'top left',
                  }}
                  role="menu"
                  aria-label="选择新增节点类型"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <div className="node-type-menu__heading">
                    <span>新增节点</span>
                    <button type="button" aria-label="关闭节点类型菜单" onClick={() => setNodeInsertMenu(null)}><X size={14} /></button>
                  </div>
                  <span className="node-type-menu__section-label">拆分节点</span>
                  {categoryOrder.map((category) => {
                    const meta = categoryMeta[category];
                    const CategoryIcon = meta.icon;
                    const route = routeMeta[meta.route];
                    return (
                      <button
                        key={category}
                        type="button"
                        role="menuitem"
                        className="node-type-menu__category"
                        onClick={() => addCanvasNode('split', category)}
                      >
                        <CategoryIcon size={17} />
                        <span><strong>{meta.label}</strong><small>{route.label}</small></span>
                      </button>
                    );
                  })}
                  <span className="node-type-menu__section-label">结果节点</span>
                  <button type="button" role="menuitem" className="node-type-menu__result" onClick={() => addCanvasNode('result')}>
                    <ImagePlus size={17} />
                    <span><strong>拆分结果节点</strong><small>承接拆分后产出的 PNG</small></span>
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        )}

        <aside className={`sidebar sidebar--right ${reviewMode === 'canvas' && !isRightOpen ? 'sidebar--collapsed' : ''}`}>
          <div className="panel-title-row">
            <div><span className="eyebrow">当前拆分项</span><h2>{hasSelectedLayer ? selected.name : '未选择图层'}</h2></div>
            {reviewMode === 'canvas' ? <IconButton label="收起检查器" onClick={() => setIsRightOpen(false)}><PanelRight size={17} /></IconButton> : null}
          </div>
          {reviewMode === 'canvas' ? renderCanvasSummary() : renderRequestPanel()}
        </aside>
      </section>

      {resultViewer ? (
        <div
          className="result-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`${resultViewer.node.name} 大图预览`}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setResultViewer(null);
          }}
        >
          <section className="result-lightbox__dialog">
            <header className="result-lightbox__header">
              <div>
                <span>拆分结果</span>
                <strong>{resultViewer.node.name}</strong>
              </div>
              <IconButton label="关闭预览" onClick={() => setResultViewer(null)}>
                <X size={18} />
              </IconButton>
            </header>
            <div className="result-lightbox__body">
              <div
                className="result-lightbox__preview"
                style={{ aspectRatio: `${resultViewer.region.width} / ${resultViewer.region.height}` }}
              >
                <ResultPreview
                  image={resultViewer.image}
                  sourceSize={resultViewer.sourceSize}
                  bounds={resultViewer.bounds}
                  className="result-preview--lightbox"
                />
              </div>
            </div>
            <footer className="result-lightbox__footer">
              <span>{resultViewer.region.width} x {resultViewer.region.height} px</span>
              <span>点击空白处或按 Esc 关闭</span>
            </footer>
          </section>
        </div>
      ) : null}

      {toast ? <div className="toast"><Check size={16} /> {toast}</div> : null}
    </main>
  );
}

const container = document.getElementById('root');
const root = window.__layerReviewRoot ?? createRoot(container);
window.__layerReviewRoot = root;
root.render(<App />);
