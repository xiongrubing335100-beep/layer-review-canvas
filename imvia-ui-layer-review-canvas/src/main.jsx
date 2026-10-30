// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  Brush,
  Check,
  CheckCircle2,
  CircleX,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eraser,
  Eye,
  FileJson,
  Focus,
  Hand,
  ImagePlus,
  Layers3,
  LoaderCircle,
  LocateFixed,
  Maximize2,
  Minimize2,
  Move,
  PanelLeft,
  PenTool,
  PencilLine,
  Plus,
  ScanSearch,
  Send,
  Sparkles,
  Square,
  Trash2,
  Type,
  Redo2,
  RefreshCw,
  Undo2,
  Upload,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { zipSync } from 'fflate';
import { elapsedEnd, jobMatchesSource, jobsForPolling, posterCandidateViewModel } from './job-state.js';
import {
  createImageDocument,
  createImageId,
  createProjectId,
  seedStoredProjectForWorkbenchOpen,
  writeStoredProjectState,
} from './project-state.js';
import {
  isAbandonablePlanStatus,
  PAGE_HEARTBEAT_INTERVAL_MS,
} from './workbench-lifecycle.js';
import {
  abandonRunningSplit,
  cancelQueuedSplit,
  getLayerReviewJob,
  markLayerReviewMessageFailed,
  markLayerReviewMessageSent,
  reconnectConversationBridge,
  resolveWorkbenchUrl,
  submitLayerReviewPlan,
  uploadMcpSourcePreview,
} from './mcp-workbench-host.js';
import { sendMcpAppFollowUpMessage } from './mcp-app-client.js';
import {
  buildExecutionPolicy,
  buildRouteMetadata,
  classifyExecutionRoute,
  combinedRequirement,
  isNodeRunning,
  nextPaint,
  transparencyStrategy,
  RMBG_MODEL,
} from './split-execution.js';
import { createInitialWorkbenchState } from './workbench-state.js';
import { ModeSwitch } from './mode-switch.js';
import { resultPreviewMaxWidth } from './result-preview-sizing.js';
import { alignCanvasItems } from './canvas-alignment.js';
import { arrangeImageDocuments } from './canvas-layout.js';
import { canvasDeletionPlan, shouldHandleCanvasDelete } from './canvas-deletion.js';
import { analyzeFastCategories } from './fast-category-analysis.js';
import { resolvePanelVisibility } from './workbench-layout.js';
import { annotationForPlan, selectionForPenOverlay } from './annotation-plan.js';
import { PenPathOverlay } from './PenPathOverlay.jsx';
import {
  canDeleteReviewMark,
  canInvokePenOverlayCommand,
  invokePenOverlayCommand,
  reduceReviewPenParentState,
} from './review-pen-actions.js';
import {
  mergeResultRefinementPollUpdate,
  recordResultRefinementDelivery,
  readPngPixelSize,
} from './result-refinement.js';
import {
  deriveRefinementPolicy,
  refinementSubmissionState,
  refinementSummary,
} from './result-refinement-policy.js';
import {
  coordinateResultRefinementSubmission,
  createResultRefinementUiState,
  reduceResultRefinementUi,
  resultRefinementBaseKey,
  resultRefinementGeometry,
} from './result-refinement-ui.js';
import { resolveNodeResultState } from './result-version-state.js';
import { ResultVersionGallery } from './result-version-gallery.js';
import { PosterModePicker } from './PosterModePicker.jsx';
import { PosterPlanReview } from './PosterPlanReview.jsx';
import { PosterCandidateReview } from './PosterCandidateReview.jsx';
import { PosterFastWorkbench } from './PosterFastWorkbench.jsx';
import { createPosterPlan, updatePosterLayer, validatePosterPlan } from './poster-plan.js';
import {
  buildFastLayerSnapshot,
  createFastPosterPlan,
  removeFastPosterLayer,
  suggestPosterFastLayers,
} from './poster-fast-plan.js';
import { posterFastCandidateDownloadPath, posterFastCandidatePreviewPath } from './poster-fast-workbench-model.js';
import {
  confirmPosterPlan as confirmPosterPlanRequest,
  cancelPosterJob,
  abandonPosterJob,
  getPosterJobWithDispatch,
  acceptPosterCandidate as acceptPosterCandidateRequest,
  authorizePosterRetry as authorizePosterRetryRequest,
  reprocessPosterFastCandidate as reprocessPosterFastCandidateRequest,
  reauthorizePosterAuditLayer as reauthorizePosterAuditLayerRequest,
  posterExportUrl,
  runPosterAudit as runPosterAuditRequest,
  submitPosterCandidate,
  submitPosterFastJob,
  submitPosterTargetedCandidate,
  submitPosterAnalysis,
  updatePosterPlan as updatePosterPlanRequest,
} from './poster-workbench-host.js';
import { posterAuditUiState } from './poster-recomposition.js';
import { materializePosterSource, uploadPosterSource } from './poster-source-handoff.js';
import { validatePosterMerge } from './poster-plan-merge.js';
import {
  createPosterPlanningRunGuard,
  posterFastCandidateAuthorizationId,
  posterWorkbenchView,
  runPosterFastPlanningPipeline,
} from './poster-workbench-state.js';
import { documentNavigationItems } from './document-navigation.js';
import { applyPosterJobResult } from './poster-job-binding.js';
import { finishPosterBusy as removePosterBusy, isPosterBusy, startPosterBusy as addPosterBusy } from './poster-busy-state.js';
import { mergePosterJobUpdate } from './poster-job-ui-state.js';
import {
  executePosterTaskControl,
  PosterTaskControl,
  posterTaskControlView,
} from './poster-task-control.js';
import { workbenchShellStructure } from './workbench-shell-structure.js';
import './styles.css';

const posterLayeringModeEnabled = __IMVIA_POSTER_LAYERING_MODE_ENABLED__;

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

const categoryOrder = ['kvTitle', 'kvElement', 'ordinaryText', 'uiComponent', 'kvBackground'];

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
  '保留框选逻辑尺寸和位置',
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
  queued: { label: '排队中', tone: 'pending' },
  sending_to_codex: { label: '正在发送到当前会话', tone: 'pending' },
  awaiting_codex_message: { label: '等待发送到当前会话', tone: 'pending' },
  host_accepted: { label: '宿主已接收，等待会话确认', tone: 'pending' },
  submitted_to_conversation: { label: '旧版宿主已接收，等待当前任务确认', tone: 'pending' },
  sent_to_codex: { label: 'Codex 已接收', tone: 'pending' },
  processing: { label: 'Codex 处理中', tone: 'pending' },
  repair_rgb: { label: '正在补全隐藏结构', tone: 'pending' },
  repair_matte: { label: '正在生成补全蒙版', tone: 'pending' },
  alpha_matte: { label: '正在生成透明蒙版', tone: 'pending' },
  partial: { label: '结果生成中', tone: 'pending' },
  finalizing: { label: '正在验收', tone: 'pending' },
  needs_confirmation: { label: '需要确认', tone: 'confirmation' },
  completed: { label: '拆分完成', tone: 'completed' },
  cancelled: { label: '已取消', tone: 'neutral' },
  failed: { label: '处理失败', tone: 'failed' },
  send_failed: { label: '发送失败', tone: 'failed' },
};

const cancelableDeliveryStatuses = new Set([
  'queued',
  'awaiting_codex_message',
  'sending_to_codex',
  'host_accepted',
  'submitted_to_conversation',
]);

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

function splitProgress(status) {
  if (status === 'queued') {
    return { stage: '等待', label: '任务已排队', detail: '当前 Codex 拆分结束后，会话监听会自动发送这一项。' };
  }
  if (status === 'awaiting_codex_message') {
    return { stage: '1 / 3', label: '等待发送到当前 Codex 会话', detail: '当前会话监听领取任务后会立即发送。' };
  }
  if (status === 'sending_to_codex') {
    return { stage: '1 / 3', label: '正在发送框选图与拆分提示词', detail: '素材发送成功后，Codex 会在当前任务中开始执行。' };
  }
  if (status === 'submitted_to_conversation') {
    return { stage: '1 / 3', label: '旧版宿主已接收', detail: '等待拆分消息在当前 Codex 任务中显示并确认。' };
  }
  if (status === 'host_accepted') {
    return { stage: '1 / 3', label: '宿主已接收消息请求', detail: '正在等待消息实际显示在当前会话并由 Codex 确认。' };
  }
  if (status === 'partial') {
    return { stage: '3 / 3', label: '正在回传拆分 PNG', detail: '已有部分结果生成，页面会继续自动更新。' };
  }
  if (status === 'repair_rgb') {
    return { stage: '2 / 4', label: '正在补全隐藏结构', detail: '先完成并验收隐藏 RGB 结构，区域外原图像素保持锁定。' };
  }
  if (status === 'repair_matte') {
    return { stage: '3 / 5', label: '正在生成补全蒙版', detail: '使用已验收的补全图定位本次新增像素，防止蒙版与修复内容错位。' };
  }
  if (status === 'alpha_matte') {
    return { stage: '3 / 4', label: '正在生成透明蒙版', detail: '只使用已验收的完整补全图生成主体透明范围。' };
  }
  if (status === 'finalizing') {
    return { stage: '4 / 4', label: '正在校验修复结果', detail: '正在校验补全结果与透明蒙版，并完成尺寸、透明度和原像素锁定验收。' };
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
  image.crossOrigin = 'anonymous';
  image.src = resolveWorkbenchUrl(source);
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

function defaultRemoveBackground(category) {
  return category !== 'kvBackground';
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
  { id: 1, title: '等待载入 UI 原图', time: '现在' },
];

const overviewViewport = { x: 34, y: 74, scale: 0.72 };
const initialWorkbenchState = createInitialWorkbenchState();
const sourceNodeKey = 'source';
const imageSourceNodeKey = (imageId) => `image:${imageId}:source`;
const imageSplitNodeKey = (imageId, nodeId) => `image:${imageId}:split:${nodeId}`;
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
  const expandedPreviewHeight = typeof window === 'undefined' ? 720 : Math.max(160, window.innerHeight - 214);
  return (
    <div
      ref={previewRef}
      className={`region-preview ${compact ? 'region-preview--compact' : ''} ${className}`}
      style={{
        width: compact ? `${compactWidth}px` : undefined,
        height: compact ? `${compactHeight}px` : undefined,
        aspectRatio: aspect,
        '--region-preview-aspect': aspect,
        '--region-preview-expanded-max-width': `${Math.max(24, Math.round(aspect * expandedPreviewHeight))}px`,
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
  canvasSize = null,
  authoritativeCanvas = false,
  expanded = false,
  compact = false,
  className = '',
  previewRef,
  interactive = false,
  children,
  ...props
}) {
  const [isFullCanvas, setIsFullCanvas] = useState(true);
  const placementRegion = pixelBounds(bounds, sourceSize);
  const previewPixels = authoritativeCanvas
    ? canvasSize || { width: 1, height: 1 }
    : placementRegion;
  const aspect = Math.max(0.12, previewPixels.width / Math.max(1, previewPixels.height));
  const compactWidth = aspect >= 38 / 42 ? 38 : Math.max(8, 42 * aspect);
  const compactHeight = aspect >= 38 / 42 ? Math.max(8, 38 / aspect) : 42;
  const expandedHeight = typeof window === 'undefined'
    ? 720
    : Math.max(420, window.innerHeight - 220);
  const maxPreviewHeight = expanded
    ? expandedHeight
    : className.includes('guided-result')
      ? 300
      : className.includes('node') ? 118 : null;
  const maxPreviewWidth = compact ? null : resultPreviewMaxWidth(previewPixels, maxPreviewHeight);
  const imageStyle = authoritativeCanvas || !isFullCanvas
    ? { inset: 0, width: '100%', height: '100%', objectFit: 'contain' }
    : cropImageStyle(bounds);

  return (
    <div
      ref={previewRef}
      className={`result-preview ${compact ? 'result-preview--compact' : ''} ${className}`}
      style={{
        width: compact ? `${compactWidth}px` : undefined,
        height: compact ? `${compactHeight}px` : undefined,
        aspectRatio: aspect,
        maxWidth: compact ? undefined : `min(100%, ${maxPreviewWidth}px)`,
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
          if (authoritativeCanvas) return;
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

function defaultReviewMode() {
  return 'guided';
}

function normalizeStoredReviewMark(mark) {
  return mark?.kind === 'brush' ? { ...mark, kind: 'boundary' } : mark;
}

const FROZEN_THEME = 'dark';

function App() {
  const [projectSeed] = useState(() => seedStoredProjectForWorkbenchOpen());
  const [projectId] = useState(() => projectSeed.projectId || createProjectId());
  const [activeImageId, setActiveImageId] = useState(projectSeed.activeImageId || '');
  const [imageDocuments, setImageDocuments] = useState(() => Object.values(projectSeed.images || {}));
  const [sourceImage, setSourceImage] = useState(initialWorkbenchState.sourceImage);
  const [sourceDataUrl, setSourceDataUrl] = useState(initialWorkbenchState.sourceDataUrl);
  const [sourceName, setSourceName] = useState(initialWorkbenchState.sourceName);
  const [pendingDocumentMode, setPendingDocumentMode] = useState('ui');
  const [pendingPosterPlanningMode, setPendingPosterPlanningMode] = useState('targeted_fast');
  const [posterJob, setPosterJob] = useState(null);
  const [posterJobImageId, setPosterJobImageId] = useState('');
  const posterJobRef = useRef(null);
  const posterJobImageIdRef = useRef('');
  const fastPosterMutationChainRef = useRef(Promise.resolve());
  const [posterBusyImageIds, setPosterBusyImageIds] = useState(() => new Set());
  const [selectedPosterFastLayerIndex, setSelectedPosterFastLayerIndex] = useState(null);
  const [fastPosterPenLayerIndex, setFastPosterPenLayerIndex] = useState(null);
  const [fastPosterPenTool, setFastPosterPenTool] = useState('foreground');
  const [fastPosterPenDraft, setFastPosterPenDraft] = useState(null);
  const [fastPosterPenSelectedMarkId, setFastPosterPenSelectedMarkId] = useState(null);
  const [sourceSize, setSourceSize] = useState(initialWorkbenchState.sourceSize);
  const [nodes, setNodes] = useState(initialWorkbenchState.nodes);
  const [selectedId, setSelectedId] = useState(initialWorkbenchState.selectedId);
  const [reviewMode, setReviewMode] = useState(defaultReviewMode);
  const [viewport, setViewport] = useState(overviewViewport);
  const [sourceNodePosition, setSourceNodePosition] = useState({ x: 110, y: 240 });
  const [canvasLayoutVersion, setCanvasLayoutVersion] = useState(0);
  const [resultNodePositions, setResultNodePositions] = useState({});
  const [manualResultNodes, setManualResultNodes] = useState([]);
  const [manualEdges, setManualEdges] = useState([]);
  const [canvasSelectedKeys, setCanvasSelectedKeys] = useState([]);
  const [canvasGroups, setCanvasGroups] = useState([]);
  const [hiddenCanvasResultKeys, setHiddenCanvasResultKeys] = useState([]);
  const [nodeInsertMenu, setNodeInsertMenu] = useState(null);
  const [alignmentMenuOpen, setAlignmentMenuOpen] = useState(false);
  const [sourceDropActive, setSourceDropActive] = useState(false);
  const [linkPreview, setLinkPreview] = useState(null);
  const [maskTool, setMaskTool] = useState(null);
  const [marks, setMarks] = useState([]);
  const [boundaryOpen, setBoundaryOpen] = useState(true);
  const [activity, setActivity] = useState(initialActivity);
  const [toast, setToast] = useState('');
  const [conversationBridge, setConversationBridge] = useState({
    online: false,
    lastSeen: null,
    checked: true,
  });

  const [isLeftOpen, setIsLeftOpen] = useState(false);
  const [isRightOpen, setIsRightOpen] = useState(false);
  const [categoryAnalysisStage, setCategoryAnalysisStage] = useState('idle');
  const [draftMark, setDraftMark] = useState(null);
  const [selectedMarkId, setSelectedMarkId] = useState(null);
  const [reviewPenSelections, setReviewPenSelections] = useState(() => new Map());
  const [reviewPenFeedbackTokens, setReviewPenFeedbackTokens] = useState(() => new Map());
  const [showOriginalOnly, setShowOriginalOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingJobId, setCancellingJobId] = useState(null);
  const [localSubmissions, setLocalSubmissions] = useState({});
  const [jobs, setJobs] = useState(readStoredJobs);
  const [clockNow, setClockNow] = useState(Date.now());
  const [candidateContext, setCandidateContext] = useState(null);
  const [candidatePreviewExpanded, setCandidatePreviewExpanded] = useState(false);
  const [resultPreviewExpanded, setResultPreviewExpanded] = useState(false);
  const [resultViewer, setResultViewer] = useState(null);
  const [resultEditing, setResultEditing] = useState(false);
  const [resultEditState, dispatchResultEdit] = useReducer(
    reduceResultRefinementUi,
    undefined,
    createResultRefinementUiState,
  );
  const {
    tool: resultEditTool,
    prompt: resultEditPrompt,
    paths: resultEditPaths,
    draft: resultEditDraft,
    selection: resultEditSelection,
    feedbackToken: resultEditFeedbackToken,
    operation: resultEditOperation,
  } = resultEditState;
  const [resultEditBasePng, setResultEditBasePng] = useState(null);
  const [resultEditBaseError, setResultEditBaseError] = useState('');
  const [submittingResultEdit, setSubmittingResultEdit] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [topbarMenuOpen, setTopbarMenuOpen] = useState(false);
  const [spacePanReady, setSpacePanReady] = useState(false);
  const [canvasPanning, setCanvasPanning] = useState(false);
  const canvasRef = useRef(null);
  const guidedImageRef = useRef(null);
  const annotationPreviewRef = useRef(null);
  const resultEditPreviewRef = useRef(null);
  const reviewPenOverlayRef = useRef(null);
  const resultPenOverlayRef = useRef(null);
  const bridgeRefreshSequenceRef = useRef(0);
  const initialJobReconciliationRef = useRef(true);
  const reviewPenPathsRef = useRef(new Map());
  const topbarMenuRef = useRef(null);
  const gestureRef = useRef(null);
  const linkPreviewPathRef = useRef(null);
  const canvasDragConsumedRef = useRef(false);
  const canvasZoomInputRef = useRef(null);
  const sourceFileInputRef = useRef(null);
  const pendingSourceInsertRef = useRef(null);
  const sourceDragDepthRef = useRef(0);
  const categoryAnalysisRunRef = useRef(0);
  const spacePanRef = useRef(false);
  const runningNodeIdsRef = useRef(new Set());
  const imageDocumentsRef = useRef(new Map(Object.values(projectSeed.images || {}).map((document) => [document.imageId, document])));
  const activeImageIdRef = useRef(projectSeed.activeImageId || '');
  const projectHydrationRef = useRef(false);
  const canvasLayoutSignatureRef = useRef('');

  useEffect(() => {
    document.documentElement.dataset.theme = FROZEN_THEME;
    window.localStorage.setItem('imvia-layer-theme', FROZEN_THEME);
  }, []);

  const snapshotActiveImage = () => {
    if (!activeImageId) return;
    imageDocumentsRef.current.set(activeImageId, createImageDocument({
      imageId: activeImageId,
      sourceImage,
      sourceDataUrl,
      sourceName,
      sourceSize,
      sourceFingerprint: currentSourceFingerprint,
      sourceRevision: currentSourceRevision,
      documentMode: currentDocument?.documentMode || 'ui',
      posterJobId: posterJobImageId === activeImageId ? posterJob?.job_id || '' : currentDocument?.posterJobId || '',
      posterDispatchId: posterJobImageId === activeImageId ? posterJob?.dispatch_id || posterJob?.dispatch?.dispatch_id || '' : currentDocument?.posterDispatchId || '',
      posterPlanVersion: posterJobImageId === activeImageId ? posterJob?.plan?.plan_version || 0 : currentDocument?.posterPlanVersion || 0,
      nodes,
      selectedId,
      sourceNodePosition,
      canvasLayoutVersion,
      resultNodePositions,
      manualResultNodes,
      manualEdges,
      marks,
    }));
    setImageDocuments([...imageDocumentsRef.current.values()]);
  };

  const restoreImageDocument = (document) => {
    reviewPenPathsRef.current.clear();
    setReviewPenSelections(new Map());
    setReviewPenFeedbackTokens(new Map());
    activeImageIdRef.current = document?.imageId || '';
    setActiveImageId(document?.imageId || '');
    setSourceImage(document?.sourceDataUrl || document?.sourceImage || '');
    setSourceDataUrl(document?.sourceDataUrl || '');
    setSourceName(document?.sourceName || '');
    setSourceSize(document?.sourceSize || { width: 0, height: 0 });
    setNodes(document?.nodes || []);
    setSelectedId(document?.selectedId || document?.nodes?.[0]?.id || '');
    setSourceNodePosition(document?.sourceNodePosition || { x: 110, y: 240 });
    setCanvasLayoutVersion(document?.canvasLayoutVersion || 0);
    setResultNodePositions(document?.resultNodePositions || {});
    setManualResultNodes(document?.manualResultNodes || []);
    setManualEdges(document?.manualEdges || []);
    setMarks((document?.marks || []).map(normalizeStoredReviewMark));
    posterJobRef.current = null;
    posterJobImageIdRef.current = '';
    setPosterJob(null);
    setPosterJobImageId('');
  };

  const activateImageDocument = (imageId) => {
    const document = imageDocumentsRef.current.get(imageId);
    if (!document || document.imageId === activeImageId) return false;
    snapshotActiveImage();
    restoreImageDocument(document);
    setCanvasSelectedKeys([]);
    setReviewMode(defaultReviewMode());
    setIsLeftOpen(Boolean(document.nodes?.length));
    setIsRightOpen(Boolean(document.nodes?.length));
    setToast(`已切换到 ${document.sourceName || '图片'}`);
    return true;
  };

  const currentDocument = imageDocumentsRef.current.get(activeImageId);
  const documentMode = currentDocument?.documentMode || 'ui';
  const hasSelectedLayer = nodes.some((node) => node.id === selectedId);
  const hasSource = Boolean(sourceImage && sourceSize.width && sourceSize.height);
  const panelVisibility = resolvePanelVisibility({
    reviewMode,
    hasSource: documentMode === 'ui' && hasSource,
    hasSelectedLayer,
    hasCanvasInspectorSelection: canvasSelectedKeys.length === 1,
    isLeftOpen,
    isRightOpen,
  });
  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[0] ?? emptySelectedNode;
  const selectedIndex = nodes.findIndex((node) => node.id === selected.id);
  const annotationSessionActive = Boolean(boundaryOpen && maskTool);
  const visibleCandidateContext = annotationSessionActive
    ? selected.bounds
    : candidateContext ?? expandedBounds(selected.bounds);
  const candidateSelectionBounds = boundsInsideContext(selected.bounds, visibleCandidateContext);
  const acceptedCount = nodes.filter((node) => node.status === 'accepted').length;
  const repairCount = nodes.filter((node) => node.status === 'needs-repair').length;
  const currentSourceFingerprint = currentDocument?.sourceFingerprint || '';
  const currentSourceRevision = currentDocument?.sourceRevision || 1;
  const currentSource = useMemo(() => ({
    projectId,
    imageId: activeImageId,
    sourceFingerprint: currentSourceFingerprint,
    sourceRevision: currentSourceRevision,
    name: sourceName,
    width: sourceSize.width,
    height: sourceSize.height,
  }), [activeImageId, currentSourceFingerprint, currentSourceRevision, projectId, sourceName, sourceSize.height, sourceSize.width]);
  const visiblePosterJob = posterJobImageId === activeImageId ? posterJob : null;
  const posterBusy = isPosterBusy(posterBusyImageIds, activeImageId);
  const isFastPosterPlan = visiblePosterJob?.plan?.planning_mode === 'targeted_fast';
  const posterFastLayers = isFastPosterPlan ? visiblePosterJob.plan.layers || [] : [];
  const activePosterFastLayerIndex = posterFastLayers.some((layer) => layer.layer_index === selectedPosterFastLayerIndex)
    ? selectedPosterFastLayerIndex
    : posterFastLayers[0]?.layer_index ?? null;
  const shellStructure = workbenchShellStructure(imageDocuments.length);
  const activePosterView = posterWorkbenchView({
    ...visiblePosterJob,
    status: visiblePosterJob?.dispatch?.status || visiblePosterJob?.status,
  });
  const posterCandidateViews = useMemo(() => {
    if (!visiblePosterJob?.plan || (!isFastPosterPlan && visiblePosterJob.plan.status !== 'PLAN_CONFIRMED')) return [];
    return (visiblePosterJob.plan.layers || []).map((layer) => posterCandidateViewModel(
      visiblePosterJob,
      layer.layer_index,
    ));
  }, [isFastPosterPlan, visiblePosterJob]);
  const activePosterFastCandidate = posterCandidateViews.find((candidate) => (
    candidate.layerIndex === activePosterFastLayerIndex
  )) || null;
  const activePosterFastLayer = posterFastLayers.find((layer) => (
    layer.layer_index === activePosterFastLayerIndex
  )) || null;
  const fastDispatchLayerIndex = visiblePosterJob?.dispatch?.layer_index ?? visiblePosterJob?.dispatch?.layerIndex;
  const displayPosterFastCandidate = activePosterFastLayer?.confirmed_snapshot || activePosterFastLayer?.status === 'ACCEPTED'
    ? activePosterFastCandidate || (fastDispatchLayerIndex === activePosterFastLayerIndex ? { status: 'GENERATING' } : null)
    : null;
  const posterFastPreviewPath = displayPosterFastCandidate && posterFastCandidatePreviewPath({
      jobId: visiblePosterJob?.job_id,
      layerIndex: activePosterFastLayerIndex,
      candidate: displayPosterFastCandidate,
    });
  const posterFastDownloadPath = displayPosterFastCandidate && posterFastCandidateDownloadPath({
    jobId: visiblePosterJob?.job_id,
    layerIndex: activePosterFastLayerIndex,
    candidate: displayPosterFastCandidate,
  });
  const displayPosterFastCandidateWithPreview = posterFastPreviewPath ? {
    ...displayPosterFastCandidate,
    candidateUrl: resolveWorkbenchUrl(posterFastPreviewPath),
  } : displayPosterFastCandidate;
  const posterAuditState = useMemo(
    () => posterAuditUiState(visiblePosterJob),
    [visiblePosterJob],
  );
  const posterTaskControl = posterTaskControlView(visiblePosterJob);

  useEffect(() => {
    activeImageIdRef.current = activeImageId;
  }, [activeImageId]);

  useEffect(() => {
    if (!isFastPosterPlan || activePosterFastLayerIndex == null) return;
    if (selectedPosterFastLayerIndex !== activePosterFastLayerIndex) {
      setSelectedPosterFastLayerIndex(activePosterFastLayerIndex);
    }
  }, [activePosterFastLayerIndex, isFastPosterPlan, selectedPosterFastLayerIndex]);

  useEffect(() => {
    if (activeImageId) {
      const document = imageDocumentsRef.current.get(activeImageId);
      if (document) restoreImageDocument(document);
      else setActiveImageId('');
    }
    projectHydrationRef.current = true;
  }, []);

  useEffect(() => {
    if (!projectHydrationRef.current || !activeImageId) return;
    imageDocumentsRef.current.set(activeImageId, createImageDocument({
      imageId: activeImageId,
      sourceImage,
      sourceDataUrl,
      sourceName,
      sourceSize,
      sourceFingerprint: currentSourceFingerprint,
      sourceRevision: currentSourceRevision,
      documentMode,
      posterJobId: posterJobImageId === activeImageId ? posterJob?.job_id || '' : currentDocument?.posterJobId || '',
      posterDispatchId: posterJobImageId === activeImageId ? posterJob?.dispatch_id || posterJob?.dispatch?.dispatch_id || '' : currentDocument?.posterDispatchId || '',
      posterPlanVersion: posterJobImageId === activeImageId ? posterJob?.plan?.plan_version || 0 : currentDocument?.posterPlanVersion || 0,
      nodes,
      selectedId,
      sourceNodePosition,
      canvasLayoutVersion,
      resultNodePositions,
      manualResultNodes,
      manualEdges,
      marks,
    }));
    writeStoredProjectState({
      version: 1,
      projectId,
      activeImageId,
      images: Object.fromEntries(imageDocumentsRef.current.entries()),
    });
  }, [activeImageId, canvasLayoutVersion, currentDocument?.posterJobId, currentDocument?.posterPlanVersion, currentSourceFingerprint, currentSourceRevision, documentMode, manualEdges, manualResultNodes, marks, nodes, posterJob?.job_id, posterJob?.plan?.plan_version, posterJobImageId, projectId, resultNodePositions, selectedId, sourceDataUrl, sourceImage, sourceName, sourceSize]);

  useEffect(() => {
    if (documentMode !== 'poster' || !currentDocument?.posterJobId) return undefined;
    const imageId = currentDocument.imageId;
    let cancelled = false;
    const refresh = async () => {
      try {
        const job = await getPosterJobWithDispatch(currentDocument.posterJobId, currentDocument.posterDispatchId);
        if (!cancelled && job) savePosterJob(job, imageId);
      } catch {
        if (!cancelled && activeImageIdRef.current === imageId) setToast('无法读取海报任务状态，请稍后重试');
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 3500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [currentDocument?.posterDispatchId, currentDocument?.posterJobId, documentMode]);
  const jobsForCurrentSource = useMemo(
    () => jobs.filter((job) => jobMatchesSource(job, currentSource)),
    [currentSource, jobs],
  );
  const selectedNodeRunning = isNodeRunning(selected.id, localSubmissions, jobsForCurrentSource);
  const sentNodeIds = useMemo(() => new Set(jobsForCurrentSource
    .filter((job) => !['failed', 'send_failed', 'cancelled'].includes(job.status))
    .flatMap((job) => job.nodeIds || [])), [jobsForCurrentSource]);
  const batchReadyNodeIds = nodes
    .filter((node) => node.status === 'accepted' && !sentNodeIds.has(node.id))
    .map((node) => node.id);
  const selectedMarks = useMemo(
    () => marks.filter((mark) => mark.layer_id === selectedId),
    [marks, selectedId],
  );
  const storedSelectedPenPaths = useMemo(
    () => selectedMarks.filter((mark) => mark.shape === 'bezier_path'),
    [selectedMarks],
  );
  const selectedPenPaths = reviewPenPathsRef.current.get(selectedId) ?? storedSelectedPenPaths;
  const fastPosterPenKey = activePosterFastLayerIndex == null ? '' : `poster-fast-${activePosterFastLayerIndex}`;
  const fastPosterMarks = useMemo(
    () => fastPosterPenKey ? marks.filter((mark) => mark.layer_id === fastPosterPenKey) : [],
    [fastPosterPenKey, marks],
  );
  const storedFastPosterPenPaths = useMemo(
    () => fastPosterMarks.filter((mark) => mark.shape === 'bezier_path'),
    [fastPosterMarks],
  );
  const fastPosterPenPaths = reviewPenPathsRef.current.get(fastPosterPenKey) ?? storedFastPosterPenPaths;
  const fastPosterPenSelection = useMemo(
    () => selectionForPenOverlay(reviewPenSelections, fastPosterPenKey, fastPosterPenSelectedMarkId, fastPosterPenPaths),
    [fastPosterPenKey, fastPosterPenPaths, fastPosterPenSelectedMarkId, reviewPenSelections],
  );
  const fastPosterPenFeedbackToken = reviewPenFeedbackTokens.get(fastPosterPenKey) ?? null;
  const selectedLegacyMarks = useMemo(
    () => selectedMarks.filter((mark) => mark.shape !== 'bezier_path'),
    [selectedMarks],
  );
  const selectedPenSelection = useMemo(() => {
    return selectionForPenOverlay(reviewPenSelections, selectedId, selectedMarkId, selectedPenPaths);
  }, [reviewPenSelections, selectedId, selectedMarkId, selectedPenPaths]);
  const selectedPenFeedbackToken = reviewPenFeedbackTokens.get(selectedId) ?? null;
  const groupedNodes = useMemo(() => categoryOrder.map((category) => ({
    category,
    items: nodes.filter((node) => node.category === category),
  })), [nodes]);
  const nodeResultStates = useMemo(() => new Map(nodes.map((node) => [node.id, resolveNodeResultState({
    jobs: jobsForCurrentSource,
    node,
    sourceSize,
  })])), [jobsForCurrentSource, nodes, sourceSize]);
  const nodeResults = useMemo(() => new Map(
    [...nodeResultStates].flatMap(([nodeId, state]) => (state.baseResult ? [[nodeId, state.baseResult]] : [])),
  ), [nodeResultStates]);
  const latestSelectedResult = nodeResults.get(selected.id);
  const selectedResultState = nodeResultStates.get(selected.id);
  const selectedResultHistory = selectedResultState?.history || [];
  const selectedPendingRevision = selectedResultState?.pendingRevision?.job;
  const selectedFailedRevision = selectedResultState?.failedRevision?.job;
  const latestSelectedJob = latestSelectedResult?.job;
  const resultEditBaseKey = resultRefinementBaseKey({
    imageId: activeImageId,
    result: latestSelectedResult,
  });
  const resultEditBaseReady = Boolean(
    resultEditBaseKey && resultEditBasePng?.key === resultEditBaseKey,
  );
  const resultEditPlacement = latestSelectedResult
    ? pixelBounds(latestSelectedResult.bounds, latestSelectedResult.sourceSize)
    : { x: 0, y: 0, width: 1, height: 1 };
  const resultEditGeometry = resultEditBaseReady
    ? resultRefinementGeometry({
      pngSize: resultEditBasePng.pngSize,
      placement: resultEditPlacement,
    })
    : null;
  const resultEditCanvas = resultEditGeometry?.canvas || { width: 1, height: 1 };
  const resultEditAnnotations = useMemo(() => resultEditPaths
    .filter((path) => path?.shape === 'bezier_path' && path.closed === true && path.anchors?.length >= 3)
    .map((path, index) => annotationForPlan(
      path,
      { x: 0, y: 0, width: 100, height: 100 },
      resultEditCanvas,
      index,
    )), [resultEditCanvas.height, resultEditCanvas.width, resultEditPaths]);
  const resultEditPolicy = useMemo(() => deriveRefinementPolicy({
    prompt: resultEditPrompt,
    annotations: resultEditAnnotations,
    operation: resultEditOperation,
    canvas: resultEditCanvas,
  }), [resultEditAnnotations, resultEditCanvas.height, resultEditCanvas.width, resultEditOperation, resultEditPrompt]);
  const resultEditSubmission = refinementSubmissionState({
    prompt: resultEditPrompt,
    paths: resultEditPaths,
    draft: resultEditDraft,
    operation: resultEditOperation,
    canvas: resultEditCanvas,
  });
  const selectedResultEditBoundary = resultEditPaths.find((path) => (
    path.id === resultEditSelection?.pathId
    && path.shape === 'bezier_path'
    && path.kind === 'boundary'
    && path.closed === true
    && path.anchors?.length >= 3
  ));
  const selectedResultEditRepairBoundary = selectedResultEditBoundary
    && !resultEditOperation.subject_path_ids.includes(selectedResultEditBoundary.id)
    ? selectedResultEditBoundary
    : null;
  const selectedFallbackJob = [...jobsForCurrentSource].reverse().find((job) => job.nodeIds?.includes(selected.id));
  const activeSelectedJob = localSubmissions[selected.id]
    || selectedPendingRevision
    || selectedFailedRevision
    || latestSelectedJob
    || selectedFallbackJob;
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
      const state = nodeResultStates.get(node.id);
      const region = pixelBounds(result.bounds, result.sourceSize);
      const { width: previewWidth, height: previewHeight } = fitCanvasPreviewSize(
        region.width,
        region.height,
        260,
        280,
      );
      const resultId = `${result.job.id}-${node.id}`;
      if (hiddenCanvasResultKeys.includes(resultNodeKey(resultId))) return [];
      const position = resultNodePositions[resultId] || { x: 1760, y: nextY };
      const item = {
        ...result,
        pendingRevision: state?.pendingRevision?.job ?? null,
        failedRevision: state?.failedRevision?.job ?? null,
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
  }, [hiddenCanvasResultKeys, nodeResultStates, nodeResults, nodes, resultNodePositions]);
  const inactiveImageDocuments = useMemo(
    () => imageDocuments.filter((document) => document.imageId !== activeImageId && (document.sourceDataUrl || document.sourceImage)),
    [activeImageId, imageDocuments],
  );
  const inactiveCanvasNodes = useMemo(
    () => inactiveImageDocuments.flatMap((document) => {
      const sourcePosition = document.sourceNodePosition || { x: 110, y: 240 };
      const offsetX = sourcePosition.x - 110;
      const offsetY = sourcePosition.y - 240;
      const useAbsolutePositions = document.canvasLayoutVersion === 1;
      return (document.nodes || []).map((node) => {
        const region = pixelBounds(node.bounds, document.sourceSize);
        const preview = fitCanvasPreviewSize(region.width, region.height);
        return {
          key: imageSplitNodeKey(document.imageId, node.id),
          kind: 'image-split',
          imageId: document.imageId,
          linkedNodeId: node.id,
          node,
          x: useAbsolutePositions ? node.x : node.x + offsetX,
          y: useAbsolutePositions ? node.y : node.y + offsetY,
          width: preview.width,
          height: preview.height + 32,
          portY: preview.height / 2 + 32,
          preview,
        };
      });
    }),
    [inactiveImageDocuments],
  );
  const inactiveResultNodes = useMemo(
    () => inactiveImageDocuments.flatMap((document) => {
      const documentSource = {
        projectId,
        imageId: document.imageId,
        sourceFingerprint: document.sourceFingerprint,
        sourceRevision: document.sourceRevision,
        name: document.sourceName,
        width: document.sourceSize.width,
        height: document.sourceSize.height,
      };
      const documentJobs = jobs.filter((job) => jobMatchesSource(job, documentSource));
      let nextIndex = 0;
      return (document.nodes || []).flatMap((node) => {
        const state = resolveNodeResultState({ jobs: documentJobs, node, sourceSize: document.sourceSize });
        const result = state.baseResult;
        if (!result) return [];
        const { job, image, bounds, sourceSize: resultSourceSize } = result;
        const region = pixelBounds(bounds, resultSourceSize);
        const { width: previewWidth, height: previewHeight } = fitCanvasPreviewSize(
          region.width,
          region.height,
          260,
          280,
        );
        const resultId = `${job.id}-${node.id}`;
        const savedPosition = document.resultNodePositions?.[resultId];
        const position = savedPosition || {
          x: node.x + previewWidth + 110,
          y: node.y + nextIndex * 12,
        };
        nextIndex += 1;
        return [{
          ...result,
          pendingRevision: state?.pendingRevision?.job ?? null,
          failedRevision: state?.failedRevision?.job ?? null,
          id: resultId,
          imageId: document.imageId,
          node,
          job,
          image,
          x: position.x,
          y: position.y,
          previewWidth,
          previewHeight,
        }];
      });
    }),
    [inactiveImageDocuments, jobs, projectId],
  );
  const canvasItems = useMemo(() => [
    ...inactiveImageDocuments.map((document, index) => {
      const width = 220;
      const height = Math.round(width * document.sourceSize.height / Math.max(1, document.sourceSize.width));
      const position = document.sourceNodePosition || { x: 110 + index * 300, y: 240 };
      return {
        key: imageSourceNodeKey(document.imageId),
        kind: 'image-source',
        imageId: document.imageId,
        x: position.x,
        y: position.y,
        width,
        height: height + 32,
        portY: height / 2 + 32,
      };
    }),
    ...(hasSource ? [{
      key: sourceNodeKey,
      kind: 'source',
      x: sourceNodePosition.x,
      y: sourceNodePosition.y,
      width: sourcePreviewWidth,
      height: sourcePreviewHeight + 32,
      portY: sourcePreviewHeight / 2 + 32,
    }] : []),
    ...inactiveCanvasNodes,
    ...inactiveResultNodes.map((resultNode) => ({
      key: resultNodeKey(resultNode.id),
      kind: 'result',
      imageId: resultNode.imageId,
      linkedNodeId: resultNode.node.id,
      x: resultNode.x,
      y: resultNode.y,
      width: resultNode.previewWidth,
      height: resultNode.previewHeight + 32,
      portY: resultNode.previewHeight / 2 + 32,
    })),
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
  ], [activeImageId, hasSource, inactiveCanvasNodes, inactiveImageDocuments, inactiveResultNodes, manualResultNodes, nodes, resultNodes, sourceNodePosition, sourcePreviewHeight, sourceSize]);
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

  const arrangeAllImageDocuments = ({ silent = false } = {}) => {
    snapshotActiveImage();
    const documents = [...imageDocumentsRef.current.values()]
      .filter((document) => document.sourceDataUrl || document.sourceImage);
    if (!documents.length) return false;
    const arrangedDocuments = arrangeImageDocuments(documents);
    imageDocumentsRef.current = new Map(arrangedDocuments.map((document) => [document.imageId, document]));
    setImageDocuments(arrangedDocuments);
    const activeDocument = imageDocumentsRef.current.get(activeImageId);
    if (activeDocument) restoreImageDocument(activeDocument);
    setCanvasSelectedKeys([]);
    canvasLayoutSignatureRef.current = arrangedDocuments.map((document) => document.imageId).join('|');
    if (!silent) setToast(`已按原图整理 ${arrangedDocuments.length} 个分组`);
    window.setTimeout(() => fitCanvasOverview(), 0);
    return true;
  };

  useEffect(() => {
    if (reviewMode !== 'canvas' || imageDocuments.length < 2 || categoryAnalysisStage === 'active') return;
    const signature = imageDocuments.map((document) => document.imageId).join('|');
    if (canvasLayoutSignatureRef.current === signature) return;
    arrangeAllImageDocuments({ silent: true });
  }, [categoryAnalysisStage, imageDocuments, reviewMode]);

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
    if (!resultPreviewExpanded) return undefined;
    const collapseResultPreviewOnEscape = (event) => {
      if (event.key === 'Escape') setResultPreviewExpanded(false);
    };
    window.addEventListener('keydown', collapseResultPreviewOnEscape);
    return () => window.removeEventListener('keydown', collapseResultPreviewOnEscape);
  }, [resultPreviewExpanded]);

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
        setAlignmentMenuOpen(false);
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
    if (canvasSelectedKeys.length < 2) setAlignmentMenuOpen(false);
  }, [canvasSelectedKeys.length]);

  useEffect(() => {
    if (
      canvasZoomInputRef.current
      && document.activeElement !== canvasZoomInputRef.current
    ) {
      canvasZoomInputRef.current.value = String(Math.round(viewport.scale * 100));
    }
  }, [viewport.scale]);

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

  const refreshConversationBridge = useCallback(async ({ showConnecting = false } = {}) => {
    const sequence = bridgeRefreshSequenceRef.current + 1;
    bridgeRefreshSequenceRef.current = sequence;
    if (showConnecting) {
      setConversationBridge((current) => ({ ...current, checked: false }));
    }
    const next = await reconnectConversationBridge();
    if (bridgeRefreshSequenceRef.current === sequence) setConversationBridge(next);
    return next;
  }, []);

  const reconnectConversation = () => {
    refreshConversationBridge({ showConnecting: true });
  };

  useEffect(() => {
    refreshConversationBridge();
    const interval = window.setInterval(refreshConversationBridge, 2000);
    return () => {
      bridgeRefreshSequenceRef.current += 1;
      window.clearInterval(interval);
    };
  }, [refreshConversationBridge]);

  useEffect(() => {
    const pageId = window.crypto.randomUUID();
    const leaseUrl = resolveWorkbenchUrl('/api/layer-review/page-lease');
    const sendLease = (event = 'heartbeat') => fetch(leaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, event }),
      cache: 'no-store',
      keepalive: true,
    }).catch(() => {});
    const markClosing = () => {
      const payload = JSON.stringify({ pageId, event: 'close' });
      if (!window.navigator.sendBeacon?.(
        leaseUrl,
        new Blob([payload], { type: 'application/json' }),
      )) {
        sendLease('close');
      }
    };

    sendLease();
    const interval = window.setInterval(sendLease, PAGE_HEARTBEAT_INTERVAL_MS);
    window.addEventListener('pagehide', markClosing);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('pagehide', markClosing);
      markClosing();
    };
  }, []);

  useEffect(() => {
    const reconcileAll = initialJobReconciliationRef.current;
    initialJobReconciliationRef.current = false;
    const pendingJobs = jobsForPolling(jobs, { reconcileAll });
    if (!pendingJobs.length) return undefined;

    let cancelled = false;
    const refresh = async () => {
      const updates = await Promise.all(pendingJobs.map(async (job) => {
        try {
          return await getLayerReviewJob(job.id);
        } catch {
          return null;
        }
      }));
      if (cancelled) return;
      const discardedIds = new Set(
        updates.filter((item) => item?.status === 'discarded').map((item) => item.job_id),
      );
      setJobs((current) => current.filter((job) => !discardedIds.has(job.id)).map((job) => {
        if (job.status === 'cancelled') return job;
        const update = updates.find((item) => item?.job_id === job.id);
        if (!update) return job;
        const polledJob = {
          ...job,
          projectId: update.project_id || job.projectId,
          imageId: update.image_id || job.imageId,
          sourceFingerprint: update.source_fingerprint || job.sourceFingerprint,
          sourceRevision: update.source_revision || job.sourceRevision,
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
        };
        return mergeResultRefinementPollUpdate(job, polledJob);
      }));
    };

    refresh();
    const interval = window.setInterval(refresh, 1000);
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
  }, [selectedId]);

  useEffect(() => {
    setResultEditing(false);
    setResultPreviewExpanded(false);
    dispatchResultEdit({ type: 'reset' });
    setResultEditBasePng(null);
    setResultEditBaseError('');
  }, [activeImageId, resultEditBaseKey, selectedId]);

  useEffect(() => {
    if (!resultEditing || !latestSelectedResult?.image || !resultEditBaseKey) return undefined;
    if (resultEditBasePng?.key === resultEditBaseKey) return undefined;
    let cancelled = false;
    setResultEditBaseError('');
    const loadBasePng = async () => {
      try {
        const response = await fetch(resolveWorkbenchUrl(latestSelectedResult.image.url), { cache: 'no-store' });
        if (!response.ok) throw new Error(`无法读取拆分结果（HTTP ${response.status}）`);
        const blob = await response.blob();
        const pngSize = await readPngPixelSize(blob);
        const dataUrl = await blobToDataUrl(blob);
        if (!cancelled) setResultEditBasePng({ key: resultEditBaseKey, pngSize, dataUrl });
      } catch (error) {
        if (cancelled) return;
        setResultEditBaseError(error.message);
        setToast(`结果精修准备失败：${error.message}`);
      }
    };
    loadBasePng();
    return () => { cancelled = true; };
  }, [latestSelectedResult?.image?.url, resultEditBaseKey, resultEditBasePng?.key, resultEditing]);

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

  const deleteOriginalCanvas = () => {
    categoryAnalysisRunRef.current += 1;
    const activeTask = jobs.find((job) => (
      job.imageId === activeImageId
      && !['completed', 'failed', 'send_failed', 'cancelled', 'discarded'].includes(job.status)
    ));
    if (activeTask) {
      setToast('当前图片仍有排队或执行中的任务，完成后才能删除');
      return;
    }
    if (activeImageId) {
      imageDocumentsRef.current.delete(activeImageId);
      setImageDocuments([...imageDocumentsRef.current.values()]);
      activeImageIdRef.current = '';
      setActiveImageId('');
    }
    if (sourceImage.startsWith('blob:')) URL.revokeObjectURL(sourceImage);
    setSourceImage('');
    setSourceDataUrl('');
    setSourceName('');
    setSourceSize({ width: 0, height: 0 });
    setNodes([]);
    setSelectedId('');
    setSourceNodePosition({ x: 110, y: 240 });
    setResultNodePositions({});
    setManualResultNodes([]);
    setManualEdges([]);
    setCanvasSelectedKeys([]);
    setCanvasGroups([]);
    setHiddenCanvasResultKeys([]);
    setNodeInsertMenu(null);
    setAlignmentMenuOpen(false);
    reviewPenPathsRef.current.clear();
    setReviewPenSelections(new Map());
    setReviewPenFeedbackTokens(new Map());
    setMarks([]);
    setCandidateContext(null);
    setResultViewer(null);
    setResultEditing(false);
    setIsLeftOpen(false);
    setIsRightOpen(false);
    setCategoryAnalysisStage('idle');
    setActivity(initialActivity);
    runningNodeIdsRef.current.clear();
    setToast('原始画布已删除');
  };

  const deleteDocumentFromSwitcher = (imageId) => {
    if (imageId === activeImageId) {
      deleteOriginalCanvas();
      return;
    }
    if (!window.confirm('删除这张图片及其本地工作台记录？')) return;
    imageDocumentsRef.current.delete(imageId);
    setImageDocuments([...imageDocumentsRef.current.values()]);
  };

  const dismissJob = (job) => {
    setJobs((current) => current.filter((item) => item.id !== job.id));
    setLocalSubmissions((current) => Object.fromEntries(
      Object.entries(current).filter(([, item]) => item.id !== job.id),
    ));
    addActivity('已移除失效的拆分任务状态');
    setToast('任务状态已从工作台移除');
  };

  const cancelPendingJob = async (job) => {
    if (!cancelableDeliveryStatuses.has(job.status) || cancellingJobId) return;
    setCancellingJobId(job.id);
    try {
      await cancelQueuedSplit(job.id);
      const cancelledAt = Date.now();
      setJobs((current) => current.map((item) => (
        item.id === job.id
          ? {
              ...item,
              status: 'cancelled',
              statusDetail: '待接收任务已取消',
              completedAt: cancelledAt,
            }
          : item
      )));
      (job.nodeIds || []).forEach((nodeId) => runningNodeIdsRef.current.delete(nodeId));
      addActivity('已取消尚未被 Codex 接收的拆分任务');
      setToast('待接收任务已取消');
    } catch (error) {
      setToast(`取消失败：${error.message}`);
    } finally {
      setCancellingJobId(null);
    }
  };

  const abandonRunningJob = async (job) => {
    if (!isAbandonablePlanStatus(job.status) || cancellingJobId) return;
    const confirmed = window.confirm(
      '这会放弃工作台中的当前任务并释放后续队列，但不能停止 Codex 已经开始的生成。迟到结果将被忽略。是否继续？',
    );
    if (!confirmed) return;
    setCancellingJobId(job.id);
    try {
      await abandonRunningSplit(job.id);
      const cancelledAt = Date.now();
      setJobs((current) => current.map((item) => (
        item.id === job.id
          ? {
              ...item,
              status: 'cancelled',
              statusDetail: '已放弃当前任务并释放队列；Codex 中的旧任务可能仍会继续',
              completedAt: cancelledAt,
              images: [],
            }
          : item
      )));
      (job.nodeIds || []).forEach((nodeId) => runningNodeIdsRef.current.delete(nodeId));
      addActivity('已放弃当前拆分任务并释放队列');
      setToast('队列已释放；如 Codex 仍在生成，请在对话中手动停止');
    } catch (error) {
      setToast(`放弃任务失败：${error.message}`);
    } finally {
      setCancellingJobId(null);
    }
  };

  const updateSelected = (patch) => {
    setNodes((current) => current.map((node) => (
      node.id === selected.id ? { ...node, ...patch } : node
    )));
  };

  const selectNode = (node, focusCanvas = false) => {
    setSelectedId(node.id);
    if (reviewMode === 'guided') setIsRightOpen(true);
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

  const alignCanvasSelection = (alignment, label) => {
    const items = canvasSelectedKeys
      .map((key) => canvasItemMap.get(key))
      .filter(Boolean);
    const positions = alignCanvasItems(items, alignment);
    if (!Object.keys(positions).length) {
      setToast('请先选择至少两个节点');
      return;
    }
    applyCanvasPositions(positions);
    setAlignmentMenuOpen(false);
    addActivity(`${items.length} 个节点已${label}`);
    setToast(`已${label} ${items.length} 个节点`);
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
    const commandDockRect = canvasRef.current?.querySelector('.canvas-command-controls')?.getBoundingClientRect();
    const menuHeight = hasSource ? 356 : 74;
    let x;
    let y;
    const hasDropPoint = Number.isFinite(dropX) && Number.isFinite(dropY);
    if (hasDropPoint) {
      x = dropX + (side === 'left' ? -244 : 20);
      y = dropY - 58;
    } else if (anchor) {
      x = side === 'left' ? anchor.x - 218 : anchor.x + anchor.width + 42;
      y = anchor.y + Math.min(72, anchor.portY - 18);
    } else if (rect && commandDockRect) {
      const dockLeft = commandDockRect.left - rect.left;
      const dockTop = commandDockRect.top - rect.top;
      const screenX = dockLeft;
      const screenY = dockTop - menuHeight - 10;
      x = (screenX - viewport.x) / viewport.scale;
      y = (screenY - viewport.y) / viewport.scale;
    } else {
      x = rect ? (rect.width / 2 - viewport.x) / viewport.scale - 95 : 920;
      y = rect ? (rect.height - 320 - viewport.y) / viewport.scale : 420;
    }
    if (rect) {
      const screenX = clamp(viewport.x + x * viewport.scale, 12, Math.max(12, rect.width - 264));
      const maxScreenY = commandDockRect && !anchor && !hasDropPoint
        ? commandDockRect.top - rect.top - menuHeight - 10
        : rect.height - menuHeight - 84;
      const screenY = clamp(viewport.y + y * viewport.scale, 12, Math.max(12, maxScreenY));
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
    const targetWidth = kind === 'source' ? sourcePreviewWidth : kind === 'split' ? 260 : 250;
    const targetPortY = kind === 'source' ? sourcePreviewHeight / 2 + 32 : kind === 'split' ? 91 : 80;
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
    if (kind === 'source') {
      pendingSourceInsertRef.current = {
        position: { x, y },
        keepCanvas: reviewMode === 'canvas',
      };
      setNodeInsertMenu(null);
      sourceFileInputRef.current?.click();
      return;
    }
    let key;
    let linkedNodeId = '';

    if (kind === 'source') {
      setSourceNodePosition({ x, y });
      key = sourceNodeKey;
      setSelectedId('');
      addActivity('原图节点已定位到画布');
    } else if (kind === 'split') {
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

    if (anchor && key && anchor.key !== key) {
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
    setToast(kind === 'source' ? '已添加原图节点' : kind === 'split' ? '已添加拆分节点' : '已添加拆分结果节点');
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
      setAlignmentMenuOpen(false);
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

  const commitCanvasZoom = (event) => {
    const requested = Number(event.currentTarget.value);
    const percent = Number.isFinite(requested)
      ? Math.round(clamp(requested, 22, 135))
      : Math.round(viewport.scale * 100);
    event.currentTarget.value = String(percent);
    setViewport((current) => ({ ...current, scale: percent / 100 }));
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

  const addLayer = (category, { select = true } = {}) => {
    if (!hasSource) {
      setToast('请先上传 UI 原图');
      return;
    }
    const categoryNodes = nodes.filter((node) => node.category === category);
    const count = categoryNodes.length + 1;
    const imageKey = String(activeImageId || 'image').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
    const id = `${imageKey}-${category.replace(/([A-Z])/g, '-$1').toLowerCase()}-${Date.now()}`;
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
    if (select) {
      setSelectedId(id);
      if (reviewMode === 'guided') setIsRightOpen(true);
      if (reviewMode === 'canvas') setCanvasSelectedKeys([splitNodeKey(id)]);
    }
    addActivity(`${next.name} 已添加`);
    setToast(`已添加新的${categoryMeta[category].label}，请框选区域`);
  };

  const startManualLayering = () => {
    categoryAnalysisRunRef.current += 1;
    setCategoryAnalysisStage('manual');
    setIsLeftOpen(true);
    setIsRightOpen(false);
    addLayer('uiComponent', { select: false });
  };

  const deleteSelected = () => {
    if (!hasSelectedLayer) return;
    const deletedKey = splitNodeKey(selected.id);
    const remaining = nodes.filter((node) => node.id !== selected.id);
    const next = remaining[Math.min(selectedIndex, remaining.length - 1)];
    reviewPenPathsRef.current.delete(selected.id);
    setReviewPenSelections((current) => {
      if (!current.has(selected.id)) return current;
      const nextSelections = new Map(current);
      nextSelections.delete(selected.id);
      return nextSelections;
    });
    setReviewPenFeedbackTokens((current) => {
      if (!current.has(selected.id)) return current;
      const nextTokens = new Map(current);
      nextTokens.delete(selected.id);
      return nextTokens;
    });
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

  const deleteCanvasSelection = () => {
    if (!canvasSelectedKeys.length) return;
    const plan = canvasDeletionPlan(canvasSelectedKeys);
    if (plan.sourceImageIds?.length) {
      const deletingActiveImage = plan.sourceImageIds.includes(activeImageId);
      const hasRunningTask = jobs.some((job) => (
        plan.sourceImageIds.includes(job.imageId)
        && !['completed', 'failed', 'send_failed', 'cancelled', 'discarded'].includes(job.status)
      ));
      if (hasRunningTask) {
        setToast('该图片仍有排队或执行中的任务，完成后才能删除');
        return;
      }
      if (deletingActiveImage) {
        deleteOriginalCanvas();
        return;
      }
      plan.sourceImageIds.forEach((imageId) => imageDocumentsRef.current.delete(imageId));
      setImageDocuments([...imageDocumentsRef.current.values()]);
      setCanvasSelectedKeys([]);
      setToast(`已删除 ${plan.sourceImageIds.length} 张原图`);
      return;
    }
    if (plan.deleteSource) {
      deleteOriginalCanvas();
      return;
    }

    const splitIds = new Set(plan.splitNodeIds);
    const manualResultIds = new Set(plan.manualResultIds);
    const deletedKeys = [
      ...plan.splitNodeIds.map(splitNodeKey),
      ...plan.resultKeys,
      ...plan.manualResultIds.map(manualResultNodeKey),
    ];
    const remainingNodes = nodes.filter((node) => !splitIds.has(node.id));

    splitIds.forEach((nodeId) => {
      reviewPenPathsRef.current.delete(nodeId);
    });
    setReviewPenSelections((current) => {
      const nextSelections = new Map(current);
      splitIds.forEach((nodeId) => nextSelections.delete(nodeId));
      return nextSelections.size === current.size ? current : nextSelections;
    });
    setReviewPenFeedbackTokens((current) => {
      const nextTokens = new Map(current);
      splitIds.forEach((nodeId) => nextTokens.delete(nodeId));
      return nextTokens.size === current.size ? current : nextTokens;
    });
    setNodes(remainingNodes);
    setMarks((current) => current.filter((mark) => !splitIds.has(mark.layer_id)));
    setManualResultNodes((current) => current.filter((node) => !manualResultIds.has(node.id)));
    setHiddenCanvasResultKeys((current) => [...new Set([...current, ...plan.resultKeys])]);
    setManualEdges((current) => current.filter(
      (edge) => !deletedKeys.includes(edge.from) && !deletedKeys.includes(edge.to),
    ));
    setCanvasGroups((current) => current
      .map((group) => ({ ...group, keys: group.keys.filter((key) => !deletedKeys.includes(key)) }))
      .filter((group) => group.keys.length > 1));
    setCanvasSelectedKeys([]);
    setNodeInsertMenu(null);
    setAlignmentMenuOpen(false);
    if (splitIds.has(selectedId)) setSelectedId(remainingNodes[0]?.id ?? '');
    addActivity(`${deletedKeys.length} 个画布节点已删除`);
    setToast(`已删除 ${deletedKeys.length} 个画布节点`);
  };

  useEffect(() => {
    if (reviewMode !== 'canvas') return undefined;
    const handleCanvasDelete = (event) => {
      if (!canvasSelectedKeys.length || !shouldHandleCanvasDelete(event)) return;
      event.preventDefault();
      deleteCanvasSelection();
    };
    window.addEventListener('keydown', handleCanvasDelete);
    return () => window.removeEventListener('keydown', handleCanvasDelete);
  }, [canvasSelectedKeys, nodes, reviewMode, selectedId, sourceImage]);

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

  const updateReviewPenSelection = (layerId, selection) => {
    setReviewPenSelections((current) => {
      if (selection ? current.get(layerId) === selection : !current.has(layerId)) return current;
      const nextSelections = new Map(current);
      if (selection) nextSelections.set(layerId, selection);
      else nextSelections.delete(layerId);
      return nextSelections;
    });
  };

  const updateReviewPenFeedbackToken = (layerId, feedbackToken) => {
    setReviewPenFeedbackTokens((current) => {
      if (feedbackToken ? current.get(layerId) === feedbackToken : !current.has(layerId)) return current;
      const nextTokens = new Map(current);
      if (feedbackToken) nextTokens.set(layerId, feedbackToken);
      else nextTokens.delete(layerId);
      return nextTokens;
    });
  };

  const currentReviewPenParentState = () => ({
    layerId: selectedId,
    marks,
    paths: selectedPenPaths,
    draft: draftMark,
    selection: selectedPenSelection,
    feedbackToken: selectedPenFeedbackToken,
    selectedMarkId,
  });

  const applyReviewPenParentState = (next) => {
    if (next.paths.length) reviewPenPathsRef.current.set(selectedId, next.paths);
    else reviewPenPathsRef.current.delete(selectedId);
    setMarks(next.marks);
    setDraftMark(next.draft);
    updateReviewPenSelection(selectedId, next.selection);
    updateReviewPenFeedbackToken(selectedId, next.feedbackToken);
    setSelectedMarkId(next.selectedMarkId);
  };

  const cancelReviewPenDraft = () => {
    if (invokePenOverlayCommand(reviewPenOverlayRef.current, 'cancelDraft')) return;
    const current = currentReviewPenParentState();
    const next = reduceReviewPenParentState(current, { type: 'cancel-draft' });
    if (next !== current) applyReviewPenParentState(next);
  };

  const selectMaskTool = (tool) => {
    cancelReviewPenDraft();
    if (maskTool === tool && !showOriginalOnly) {
      setMaskTool(null);
      setToast('已退出边界工具');
      return;
    }
    setMaskTool(tool);
    setShowOriginalOnly(false);
    setBoundaryOpen(true);
    const label = tool === 'foreground'
      ? '保留钢笔'
      : tool === 'background'
        ? '排除钢笔'
        : tool === 'repair' ? '补全钢笔' : '边界钢笔';
    setToast(`${label}已开启，请在右侧大预览中操作`);
  };

  const toggleOriginalOnly = () => {
    setShowOriginalOnly((current) => !current);
    setToast(showOriginalOnly ? '已显示精修标注' : '已临时隐藏精修标注');
  };

  const toggleBoundary = () => {
    setBoundaryOpen((current) => {
      if (current) {
        setMaskTool(null);
        setDraftMark(null);
        setSelectedMarkId(null);
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
      project_id: projectId,
      image_id: activeImageId,
      source_fingerprint: currentSourceFingerprint || null,
      source_revision: currentSourceRevision,
      source: {
        file_name: sourceName,
        canvas: sourceSize,
        image_id: activeImageId,
        source_fingerprint: currentSourceFingerprint || null,
        source_revision: currentSourceRevision,
        coordinate_space: 'source_pixels',
        source_uri: sourceImage.startsWith('blob:') ? null : sourceImage,
        embedded_data_url: includeSource ? sourceDataUrl || null : undefined,
      },
      layers: planLayers.map((node, index) => {
        const normalizedRequirement = combinedRequirement({
          category: node.category,
          categoryDefault: categoryMeta[node.category].defaultRequirement,
          requirement: node.requirement,
          refinementPrompt: node.refinementPrompt,
          removeBackground: Boolean(node.removeBackground),
        });
        const executionMode = node.executionMode || 'fast';
        const sourceRegionPixels = pixelBounds(node.bounds, sourceSize);
        const layerMarks = marks.filter((mark) => mark.layer_id === node.id);
        const layerAnnotations = layerMarks.map((mark, annotationIndex) => (
          annotationForPlan(mark, node.bounds, sourceSize, annotationIndex)
        ));
        const transparency = transparencyStrategy({
          category: node.category,
          removeBackground: Boolean(node.removeBackground),
        });
        let executionRoute = classifyExecutionRoute({
          category: node.category,
          requirement: normalizedRequirement,
          removeBackground: Boolean(node.removeBackground),
        });
        if (transparency === 'codex_rgba' && layerAnnotations.some((annotation) => annotation.kind === 'repair')) {
          executionRoute = 'codex_rgba_repair';
        }
        const routeMetadata = buildRouteMetadata({
          category: node.category,
          requirement: normalizedRequirement,
          executionMode,
          executionRoute,
          removeBackground: Boolean(node.removeBackground),
          sourceRegionPixels,
        });
        const repairRegions = layerAnnotations.flatMap((annotation) => {
          if (annotation.kind !== 'repair') return [];
          if (annotation.shape === 'rect') {
            const rect = annotation.source_rect_pixels;
            return [{
              shape: 'rect',
              x: rect.x - sourceRegionPixels.x,
              y: rect.y - sourceRegionPixels.y,
              width: rect.width,
              height: rect.height,
            }];
          }
          if (annotation.shape === 'bezier_path') {
            return [{
              shape: 'polygon',
              points: annotation.source_polygon_pixels.map((point) => ({
                x: point.x - sourceRegionPixels.x,
                y: point.y - sourceRegionPixels.y,
              })),
            }];
          }
          return [];
        });
        return {
          layer_index: index + 1,
          id: node.id,
          category: node.category,
          category_label: categoryMeta[node.category].label,
          name: node.name,
          requirement: normalizedRequirement,
          refinement_requirement: String(node.refinementPrompt || '').trim() || null,
          execution_route_hint: executionRoute,
          source_region_percent: node.bounds,
          source_region_pixels: sourceRegionPixels,
          mask_annotations: layerAnnotations,
          mask_policy: {
            selected_region: 'candidate_scope_only',
            keep_region: 'force_include',
            exclude_region: 'force_remove',
            overlapping_keep_exclude: 'later_annotation_wins',
            manual_boundary: 'highest_priority_edge_override',
            repair_region: 'model_authored_hidden_content_intersected_with_submitted_repair_regions',
            remove_background: 'post_mask_alpha_output_only',
          },
          repair_regions: repairRegions.length ? repairRegions : null,
          repair_region_source: repairRegions.length ? 'submitted_annotation' : null,
          execution_mode: executionMode,
          execution_policy: buildExecutionPolicy({
            executionMode,
            executionRoute,
          }),
          ...routeMetadata,
          remove_background: Boolean(node.removeBackground),
          remove_background_processor: executionRoute === 'codex_rgba_repair' ? {
            engine: 'codex_rgba_repair',
            model: 'imagegen_repair_rgb_then_alpha_matte',
            stage: 'codex_repair_then_cutout',
            input: 'prepared_source_locked_canvas',
            output: 'source_rgb_with_model_authored_repair_and_alpha',
          } : transparency === 'codex_rgba' ? {
            engine: 'codex_rgba',
            model: 'imagegen_alpha_matte',
            stage: 'codex_final_split',
            input: 'prepared_source_locked_canvas',
            output: 'source_rgb_with_model_authored_alpha',
          } : transparency === 'rembg' ? {
            engine: 'rembg',
            model: RMBG_MODEL,
            stage: 'after_codex_final_split_before_delivery',
            input: 'codex_final_split_result',
          } : null,
          processing_route: categoryMeta[node.category].route,
          workflow_position: { x: node.x, y: node.y },
          output: {
            crop_to_source_region: true,
            width: sourceRegionPixels.width,
            height: sourceRegionPixels.height,
            original_source_x: sourceRegionPixels.x,
            original_source_y: sourceRegionPixels.y,
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
        remove_background_processor: 'category_routed_codex_rgba_or_rembg',
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
        const response = await fetch(resolveWorkbenchUrl(image.url), { cache: 'no-store' });
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
        projectId,
        imageId: activeImageId,
        sourceFingerprint: currentSourceFingerprint || null,
        sourceRevision: currentSourceRevision,
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
    let submissionResult = null;
    let followUpPosted = false;
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
      const result = await submitLayerReviewPlan(plan);
      submissionResult = result;
      if (result.delivery_channel === 'current_conversation') {
        await sendMcpAppFollowUpMessage(result.prompt);
        followUpPosted = true;
        await markLayerReviewMessageSent(result.job_id);
      }
      setNodes((current) => current.map((node) => (
        submittedNodeIds.includes(node.id) ? { ...node, status: 'accepted' } : node
      )));
      setJobs((current) => [...current, {
        id: result.job_id,
        projectId,
        imageId: activeImageId,
        sourceFingerprint: currentSourceFingerprint || null,
        sourceRevision: currentSourceRevision,
        nodeIds: submittedNodeIds,
        layerSnapshots,
        sourceSize: submittedSourceSize,
        sourceName,
        status: result.status || 'awaiting_codex_message',
        statusDetail: null,
        images: [],
        submittedAt: result.submitted_at ? new Date(result.submitted_at).getTime() : Date.now(),
        completedAt: null,
        threadId: result.thread_id || null,
        turnId: result.turn_id || null,
        skillName: result.skill_name || 'split-ui-design-layers-workbench-targeted',
        timing: result.timing || {},
        executionRoute: result.execution_route || null,
      }]);
      const queued = result.status === 'queued';
      addActivity(queued
        ? `${submittedNodeIds.length} 个拆分项已加入队列`
        : result.delivery_channel === 'current_conversation'
          ? `${submittedNodeIds.length} 个拆分项已发送到当前会话`
          : `${submittedNodeIds.length} 个拆分项已交给会话监听，等待当前任务确认`);
      setToast(
        queued
          ? `${submittedNodeIds.length} 个拆分项已加入队列`
          : scope === 'batch'
            ? `${submittedNodeIds.length} 个拆分项已提交`
            : `${nodes.find((node) => node.id === submittedNodeIds[0])?.name || '当前项'}已提交`,
      );
    } catch (error) {
      if (submissionResult?.job_id && !followUpPosted) {
        await markLayerReviewMessageFailed(submissionResult.job_id, error).catch(() => {});
      }
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

  const sourceFingerprintFor = (file, dataUrl) => (
    `${file.name}:${file.size}:${file.lastModified || 0}:${String(dataUrl || '').length}`
  );

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

  const updatePenPaths = ({ paths: nextPaths, draft, selection, feedbackToken }) => {
    reviewPenPathsRef.current.set(selectedId, nextPaths);
    updateReviewPenSelection(selectedId, selection);
    updateReviewPenFeedbackToken(selectedId, feedbackToken);
    const persistedPaths = nextPaths.map((path) => ({
      ...path,
      layer_id: selectedId,
      kind: path.kind === 'brush' ? 'boundary' : path.kind,
    }));
    setMarks((current) => [
      ...current.filter((mark) => mark.layer_id !== selectedId || mark.shape !== 'bezier_path'),
      ...persistedPaths,
    ]);
    setDraftMark(draft);
    setSelectedMarkId(selection?.pathId ?? null);
  };

  const updateFastPosterPenPaths = ({ paths: nextPaths, draft, selection, feedbackToken }) => {
    if (!fastPosterPenKey) return;
    reviewPenPathsRef.current.set(fastPosterPenKey, nextPaths);
    updateReviewPenSelection(fastPosterPenKey, selection);
    updateReviewPenFeedbackToken(fastPosterPenKey, feedbackToken);
    const persistedPaths = nextPaths.map((path) => ({
      ...path,
      layer_id: fastPosterPenKey,
      kind: path.kind === 'brush' ? 'boundary' : path.kind,
    }));
    setMarks((current) => [
      ...current.filter((mark) => mark.layer_id !== fastPosterPenKey || mark.shape !== 'bezier_path'),
      ...persistedPaths,
    ]);
    setFastPosterPenDraft(draft);
    setFastPosterPenSelectedMarkId(selection?.pathId ?? null);
  };

  const undoLastMark = () => {
    if (invokePenOverlayCommand(reviewPenOverlayRef.current, 'undo')) {
      setToast('已撤销上一步标注');
    }
  };

  const redoLastMark = () => {
    if (invokePenOverlayCommand(reviewPenOverlayRef.current, 'redo')) {
      setToast('已重做钢笔操作');
    }
  };

  const deleteSelectedMark = () => {
    const current = currentReviewPenParentState();
    const selectedMark = current.marks.find((mark) => (
      mark.layer_id === current.layerId && mark.id === current.selectedMarkId
    ));
    if (!selectedMark) return;
    if (selectedMark.shape === 'bezier_path'
      && invokePenOverlayCommand(reviewPenOverlayRef.current, 'deleteSelection')) {
      setToast('已删除选中的标注');
      return;
    }
    applyReviewPenParentState(reduceReviewPenParentState(current, { type: 'delete-selection' }));
    setToast('已删除选中的标注');
  };

  const clearMarks = () => {
    const current = currentReviewPenParentState();
    if (!current.marks.some((mark) => mark.layer_id === current.layerId) && !current.draft) return;
    if (invokePenOverlayCommand(reviewPenOverlayRef.current, 'clear')) {
      if (current.paths.length || current.draft) {
        setMarks((latest) => latest.filter((mark) => (
          mark.layer_id !== selectedId || mark.shape === 'bezier_path'
        )));
        setSelectedMarkId(null);
      } else {
        applyReviewPenParentState(reduceReviewPenParentState(current, { type: 'clear' }));
      }
    } else {
      applyReviewPenParentState(reduceReviewPenParentState(current, { type: 'clear' }));
    }
    setToast('当前项目的边界标注已清空');
  };

  const toggleResultEditing = () => {
    if (resultEditing) {
      resultPenOverlayRef.current?.cancelDraft();
      dispatchResultEdit({ type: 'cancel-draft' });
      setResultPreviewExpanded(false);
      setResultEditing(false);
      return;
    }
    dispatchResultEdit({ type: 'select-tool', tool: 'background' });
    setResultEditing(true);
    window.requestAnimationFrame(() => {
      resultEditPreviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      resultEditPreviewRef.current?.focus({ preventScroll: true });
    });
  };

  const openGuidedEditor = (nodeId, editResult = false) => {
    setSelectedId(nodeId);
    setCanvasSelectedKeys([splitNodeKey(nodeId)]);
    setReviewMode('guided');
    setResultPreviewExpanded(false);
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

  const selectResultEditTool = (tool) => {
    resultPenOverlayRef.current?.cancelDraft();
    dispatchResultEdit({ type: 'select-tool', tool });
  };

  const updateResultPenEditor = ({ paths, draft, selection, feedbackToken }) => {
    dispatchResultEdit({ type: 'editor-change', paths, draft, selection, feedbackToken });
  };

  const toggleSelectedResultEditPathRole = (field, selectedPath) => {
    if (!selectedPath) return;
    dispatchResultEdit({ type: 'toggle-path-role', field, pathId: selectedPath.id });
  };

  const selectResultEditMode = (mode) => {
    dispatchResultEdit({ type: 'select-mode', mode });
  };

  const undoResultPenEdit = () => {
    resultPenOverlayRef.current?.undo();
  };

  const redoResultPenEdit = () => {
    resultPenOverlayRef.current?.redo();
  };

  const deleteSelectedResultPenEdit = () => {
    resultPenOverlayRef.current?.deleteSelection();
  };

  const clearResultPenEdit = () => {
    resultPenOverlayRef.current?.clear();
    dispatchResultEdit({ type: 'clear-paths' });
  };

  const submitResultEdit = async () => {
    if (!latestSelectedResult?.image || submittingResultEdit) return;
    if (selectedPendingRevision) {
      setToast('当前结果精修仍在处理中，请等待完成后再提交');
      return;
    }
    if (!resultEditBaseReady || !resultEditGeometry) {
      setToast(resultEditBaseError || '正在读取当前 PNG 像素尺寸，请稍候');
      return;
    }
    if (!resultEditSubmission.ok) {
      setToast(resultEditSubmission.reason);
      return;
    }
    setSubmittingResultEdit(true);
    let submissionResult = null;
    let followUpPosted = false;
    try {
      const coordinated = await coordinateResultRefinementSubmission({
        prompt: resultEditPrompt,
        paths: resultEditPaths,
        operation: resultEditOperation,
        policy: resultEditPolicy,
        basePng: resultEditBasePng,
        placement: resultEditGeometry.placement,
        baseResult: {
          jobId: latestSelectedResult.job.id,
          versionId: latestSelectedResult.image.versionId || latestSelectedResult.image.version_id || latestSelectedResult.job.id,
          fileName: latestSelectedResult.image.name || `${selected.id}.png`,
        },
        layer: {
          id: selected.id,
          category: selected.category,
          categoryLabel: categoryMeta[selected.category].label,
          name: selected.name,
          executionMode: selected.executionMode || 'fast',
        },
        project: {
          projectId,
          imageId: activeImageId,
          sourceFingerprint: currentSourceFingerprint || null,
          sourceRevision: currentSourceRevision,
        },
        confirmFullCanvas: () => window.confirm('整图编辑可能改变构图、位置和比例。确认允许整张 PNG 参与生成式修改吗？'),
        submitPlan: submitLayerReviewPlan,
      });
      if (coordinated.cancelled) return;
      const { delivery: result, refinementSnapshot } = coordinated;
      submissionResult = result;
      const resultRegion = resultEditGeometry.placement;
      const revisionJob = {
        id: result.job_id,
        projectId,
        imageId: activeImageId,
        sourceFingerprint: currentSourceFingerprint || null,
        sourceRevision: currentSourceRevision,
        nodeIds: [selected.id],
        layerSnapshots: {
          [selected.id]: {
            bounds: { ...latestSelectedResult.bounds },
            sourceRegionPixels: resultRegion,
          },
        },
        sourceSize: { ...latestSelectedResult.sourceSize },
        sourceName,
        status: result.status || 'awaiting_codex_message',
        statusDetail: null,
        images: [],
        submittedAt: result.submitted_at ? new Date(result.submitted_at).getTime() : Date.now(),
        completedAt: null,
        threadId: result.thread_id || null,
        turnId: result.turn_id || null,
        skillName: result.skill_name || 'split-ui-design-layers-workbench-targeted',
        parentJobId: latestSelectedResult.job.id,
        editKind: 'result_refinement',
        refinementSnapshot,
      };
      const deliveryOutcome = await recordResultRefinementDelivery({
        delivery: result,
        revisionJob,
        setJobs,
        sendFollowUpMessage: sendMcpAppFollowUpMessage,
        markMessageSent: markLayerReviewMessageSent,
      });
      followUpPosted = deliveryOutcome.followUpPosted;
      addActivity(result.delivery_channel === 'current_conversation'
        ? `${selected.name} 的二次精修已发送到当前会话`
        : `${selected.name} 的二次精修已交给会话监听，等待当前任务确认`);
      setToast(deliveryOutcome.acknowledgementError
        ? '结果修整已发送并保留本地记录，状态回写未确认'
        : '结果修整已提交，原结果版本已保留');
      dispatchResultEdit({
        type: 'editor-change',
        paths: resultEditPaths,
        draft: null,
        selection: resultEditSelection,
        feedbackToken: null,
      });
    } catch (error) {
      if (submissionResult?.job_id && !followUpPosted) {
        await markLayerReviewMessageFailed(submissionResult.job_id, error).catch(() => {});
      }
      setToast(`结果修整提交失败：${error.message}`);
    } finally {
      setSubmittingResultEdit(false);
    }
  };

  const runFastCategoryAnalysis = async (image, runId) => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    if (categoryAnalysisRunRef.current !== runId) return;

    const sampleScale = Math.min(1, 160 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(image.naturalWidth * sampleScale));
    canvas.height = Math.max(2, Math.round(image.naturalHeight * sampleScale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      setCategoryAnalysisStage('cancelled');
      setToast('当前浏览器无法读取图片像素，请改用手动添加');
      return;
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const suggestions = analyzeFastCategories(context.getImageData(0, 0, canvas.width, canvas.height));
    if (categoryAnalysisRunRef.current !== runId) return;

    const createdAt = Date.now();
    const defaultNames = {
      kvTitle: 'KV 标题',
      kvElement: 'KV 元素',
      kvBackground: 'KV 背景',
      ordinaryText: '普通文字',
      uiComponent: 'UI 组件',
    };
    const categoryX = {
      kvTitle: 1010,
      kvElement: 650,
      kvBackground: 1370,
      ordinaryText: 650,
      uiComponent: 1370,
    };
    const imageKey = String(activeImageId || 'image').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
    const analyzedNodes = suggestions.map(({ category, bounds }, index) => ({
      id: `${imageKey}-${category.replace(/([A-Z])/g, '-$1').toLowerCase()}-${createdAt + index}`,
      name: `${defaultNames[category]} 1`,
      category,
      status: ['kvBackground', 'uiComponent'].includes(category) ? 'needs-repair' : 'candidate',
      isCustom: false,
      removeBackground: defaultRemoveBackground(category),
      executionMode: 'fast',
      requirement: categoryMeta[category].defaultRequirement,
      refinementPrompt: '',
      bounds,
      x: categoryX[category],
      y: 220 + index * 190,
    }));
    setCanvasLayoutVersion(0);
    setNodes(analyzedNodes);
    setSelectedId(analyzedNodes[0]?.id || '');
    setCategoryAnalysisStage('complete');
    setIsLeftOpen(true);
    setIsRightOpen(Boolean(analyzedNodes.length));
    addActivity(`快速识别完成，已生成 ${analyzedNodes.length} 个候选拆分项`);
    setToast(`已快速识别 ${analyzedNodes.length} 个候选项，可继续调整框选`);
  };

  const startFastCategoryAnalysis = (imageSource = sourceImage) => {
    if (!imageSource) return;
    const runId = categoryAnalysisRunRef.current + 1;
    categoryAnalysisRunRef.current = runId;
    setCategoryAnalysisStage('active');
    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => runFastCategoryAnalysis(image, runId);
    image.onerror = () => {
      if (categoryAnalysisRunRef.current !== runId) return;
      setCategoryAnalysisStage('cancelled');
      setToast('图片读取失败，请重新上传或手动添加');
    };
    image.src = imageSource;
  };

  const cancelFastCategoryAnalysis = () => {
    categoryAnalysisRunRef.current += 1;
    setCategoryAnalysisStage('cancelled');
  };

  const loadSourceFile = async (file, options = {}) => {
    if (!file) return;
    const pendingInsert = pendingSourceInsertRef.current;
    pendingSourceInsertRef.current = null;
    const sourceNodePositionForDocument = pendingInsert?.position || options.position || { x: 110, y: 240 };
    const keepCanvas = pendingInsert?.keepCanvas ?? options.keepCanvas ?? false;
    const nextDocumentMode = pendingDocumentMode;
    const nextPosterPlanningMode = options.posterPlanningMode || pendingPosterPlanningMode;
    snapshotActiveImage();
    const nextImageId = createImageId();
    const runId = categoryAnalysisRunRef.current + 1;
    categoryAnalysisRunRef.current = runId;
    const nextDocument = createImageDocument({
      imageId: nextImageId,
      sourceName: file.name,
      documentMode: nextDocumentMode,
      sourceNodePosition: sourceNodePositionForDocument,
      sourceRevision: 1,
    });
    imageDocumentsRef.current.set(nextImageId, nextDocument);
    setImageDocuments([...imageDocumentsRef.current.values()]);
    activeImageIdRef.current = nextImageId;
    setActiveImageId(nextImageId);
    setSourceName(file.name);
    setNodes([]);
    setSelectedId('');
    setSourceNodePosition(sourceNodePositionForDocument);
    setResultNodePositions({});
    setManualResultNodes([]);
    setManualEdges([]);
    setCanvasSelectedKeys([]);
    setCanvasGroups([]);
    setHiddenCanvasResultKeys([]);
    setNodeInsertMenu(null);
    setMarks([]);
    setCandidateContext(null);
    setReviewMode(keepCanvas ? 'canvas' : defaultReviewMode());
    setIsLeftOpen(false);
    setIsRightOpen(false);
    setCategoryAnalysisStage(nextDocumentMode === 'poster' && nextPosterPlanningMode === 'targeted_fast' ? 'active' : nextDocumentMode === 'poster' ? 'idle' : 'active');
    try {
      const [dataUrl, previewUrl] = await Promise.all([
        blobToDataUrl(file),
        uploadMcpSourcePreview(file),
      ]);
      const imageSource = previewUrl || dataUrl;
      const sourceFingerprint = sourceFingerprintFor(file, dataUrl);
      const document = createImageDocument({
        imageId: nextImageId,
        sourceImage: imageSource,
        sourceDataUrl: dataUrl,
        sourceName: file.name,
        documentMode: nextDocumentMode,
        sourceNodePosition: sourceNodePositionForDocument,
        sourceFingerprint,
        sourceRevision: 1,
      });
      imageDocumentsRef.current.set(nextImageId, document);
      setImageDocuments([...imageDocumentsRef.current.values()]);
      setSourceDataUrl(dataUrl);
      const image = new window.Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        const nextSize = { width: image.naturalWidth, height: image.naturalHeight };
        setSourceSize(nextSize);
        imageDocumentsRef.current.set(nextImageId, createImageDocument({
          ...document,
          sourceSize: nextSize,
        }));
        setImageDocuments([...imageDocumentsRef.current.values()]);
        if (nextDocumentMode === 'poster' && nextPosterPlanningMode === 'targeted_fast') {
          startPosterFastPlanning({
            image,
            imageId: nextImageId,
            imageSource,
            sourceSize: nextSize,
            runId,
          });
        } else if (nextDocumentMode === 'poster') {
          setCategoryAnalysisStage('idle');
        } else {
          runFastCategoryAnalysis(image, runId);
        }
      };
      image.onerror = () => {
        if (categoryAnalysisRunRef.current !== runId) return;
        setCategoryAnalysisStage('cancelled');
        setToast('图片读取失败，请重新上传');
      };
      image.src = imageSource;
      setSourceImage(imageSource);
    } catch {
      if (categoryAnalysisRunRef.current !== runId) return;
      setCategoryAnalysisStage('cancelled');
      setToast('图片读取失败，请重新上传');
    }
    addActivity(`已载入 ${file.name}`);
    setToast(nextDocumentMode === 'poster'
      ? nextPosterPlanningMode === 'targeted_fast' ? '海报已载入，正在生成快速定向计划' : '海报已载入，等待高质量分析'
      : '原图已载入，正在本地快速识别');
  };

  const handleFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    loadSourceFile(file);
    event.target.value = '';
  };

  const savePosterJob = (job, imageId) => {
    if (!job?.job_id) return;
    const targetImageId = imageId || activeImageIdRef.current;
    if (!imageDocumentsRef.current.has(targetImageId)) return;
    const nextJob = targetImageId === posterJobImageIdRef.current
      ? mergePosterJobUpdate(posterJobRef.current, job)
      : job;
    const update = applyPosterJobResult({
      documents: [...imageDocumentsRef.current.values()],
      activeImageId: activeImageIdRef.current,
      visibleJob: null,
    }, targetImageId, nextJob);
    imageDocumentsRef.current = new Map(update.documents.map((document) => [document.imageId, createImageDocument(document)]));
    setImageDocuments([...imageDocumentsRef.current.values()]);
    writeStoredProjectState({
      version: 1,
      projectId,
      activeImageId: activeImageIdRef.current,
      images: Object.fromEntries(imageDocumentsRef.current.entries()),
    });
    if (update.visibleUpdated) {
      posterJobRef.current = update.visibleJob;
      posterJobImageIdRef.current = targetImageId;
      setPosterJob(update.visibleJob);
      setPosterJobImageId(targetImageId);
    }
  };

  const setPosterToast = (imageId, message) => {
    if (activeImageIdRef.current === imageId) setToast(message);
  };

  const beginPosterBusy = (imageId) => {
    setPosterBusyImageIds((imageIds) => addPosterBusy(imageIds, imageId));
  };

  const finishPosterBusy = (imageId) => {
    setPosterBusyImageIds((imageIds) => removePosterBusy(imageIds, imageId));
  };

  const startPosterFastPlanning = async ({ image, imageId, imageSource, sourceSize: loadedSize, runId } = {}) => {
    if (!posterLayeringModeEnabled || !image || !imageSource || !imageId || posterBusy) return;
    const planningGuard = createPosterPlanningRunGuard(runId, () => categoryAnalysisRunRef.current);
    if (!planningGuard.isCurrent()) return;
    const size = {
      width: Number(loadedSize?.width || image.naturalWidth || image.width),
      height: Number(loadedSize?.height || image.naturalHeight || image.height),
    };
    if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1) {
      setCategoryAnalysisStage('cancelled');
      setPosterToast(imageId, '海报尺寸读取失败，请重新上传');
      return;
    }
    beginPosterBusy(imageId);
    try {
      // Use the same local category analyzer as the H5 workbench on a bounded
      // sample.  The returned percentage bounds are then projected back to
      // the complete source canvas before the fast plan is persisted.
      const sampleScale = Math.min(1, 160 / Math.max(size.width, size.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, Math.round(size.width * sampleScale));
      canvas.height = Math.max(2, Math.round(size.height * sampleScale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('当前浏览器无法读取海报像素');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const roughLayers = suggestPosterFastLayers({
        data: context.getImageData(0, 0, canvas.width, canvas.height),
        width: canvas.width,
        height: canvas.height,
      });
      const layers = roughLayers.map((layer) => {
        const percentage = layer.bounds?.percentage || layer.bounds || { x: 0, y: 0, width: 100, height: 100 };
        const x = Math.round((Number(percentage.x) || 0) * size.width / 100);
        const y = Math.round((Number(percentage.y) || 0) * size.height / 100);
        const right = Math.round(((Number(percentage.x) || 0) + (Number(percentage.width) || 0)) * size.width / 100);
        const bottom = Math.round(((Number(percentage.y) || 0) + (Number(percentage.height) || 0)) * size.height / 100);
        return {
          ...layer,
          bounds: {
            ...layer.bounds,
            source_pixels: {
              x: Math.max(0, Math.min(size.width, x)),
              y: Math.max(0, Math.min(size.height, y)),
              width: Math.max(0, Math.min(size.width, right) - Math.max(0, Math.min(size.width, x))),
              height: Math.max(0, Math.min(size.height, bottom) - Math.max(0, Math.min(size.height, y))),
            },
          },
        };
      });
      const jobId = `poster-${imageId || 'image'}-${Date.now()}`.replace(/[^a-zA-Z0-9._-]/g, '-');
      const pipeline = await runPosterFastPlanningPipeline({
        runGuard: planningGuard,
        materializeSource: () => materializePosterSource(imageSource),
        uploadSource: (source) => uploadPosterSource(source.blob, source.size),
        createPlan: (storedSource) => createFastPosterPlan({
          job_id: jobId,
          project_id: projectId,
          image_id: imageId,
          source: {
            path: storedSource.sourcePath,
            width: size.width,
            height: size.height,
            aspect_ratio: size.width / size.height,
            target_2x: false,
          },
          document_mode: 'poster',
          status: 'PLAN_REVIEW',
          output_directory: `output/poster-jobs/${jobId}`,
          layers,
        }),
        submitJob: (plan) => submitPosterFastJob(plan),
        persist: ({ plan: nextPlan, submitted }) => {
          const savedPlan = submitted.plan || { ...nextPlan, job_id: submitted.job_id || jobId };
          savePosterJob({ ...submitted, job_id: submitted.job_id || jobId, plan: savedPlan }, imageId);
        },
        onStage: () => setCategoryAnalysisStage('complete'),
      });
      if (pipeline.status === 'stale') return;
      setPosterToast(imageId, '快速定向计划已生成，可直接选择项目并拆分');
    } catch (error) {
      if (planningGuard.isCurrent()) {
        setCategoryAnalysisStage('cancelled');
        setPosterToast(imageId, error.message || '快速海报计划生成失败，请重试');
      }
    } finally {
      finishPosterBusy(imageId);
    }
  };

  const startPosterAnalysis = async () => {
    if (!posterLayeringModeEnabled) {
      setToast('海报分层功能当前已关闭');
      return;
    }
    if (!hasSource || posterBusy) return;
    const imageId = activeImageId;
    const imageSource = sourceImage;
    beginPosterBusy(imageId);
    try {
      const jobId = `poster-${imageId || 'image'}-${Date.now()}`.replace(/[^a-zA-Z0-9._-]/g, '-');
      const materialized = await materializePosterSource(imageSource);
      const storedSource = await uploadPosterSource(materialized.blob, materialized.size);
      const plan = createPosterPlan({
        job_id: jobId,
        project_id: projectId,
        image_id: imageId,
        source: {
          path: storedSource.sourcePath,
          width: storedSource.size.width,
          height: storedSource.size.height,
          aspect_ratio: storedSource.size.width / storedSource.size.height,
          target_2x: false,
        },
        document_mode: 'poster',
        status: 'PLAN_REVIEW',
        output_directory: `output/poster-jobs/${jobId}`,
      });
      const submitted = await submitPosterAnalysis(plan);
      savePosterJob({ ...submitted, plan: { ...plan, job_id: submitted.job_id, status: 'ANALYZING' } }, imageId);
      setPosterToast(imageId, '海报层级分析已提交到当前 Codex 会话');
    } catch (error) {
      setPosterToast(imageId, error.message || '海报分析提交失败');
    } finally {
      finishPosterBusy(imageId);
    }
  };

  const controlActivePosterTask = async () => {
    const job = visiblePosterJob;
    const imageId = activeImageId;
    if (!job?.job_id || posterBusy || posterTaskControl.action === 'none') return;
    beginPosterBusy(imageId);
    try {
      const refreshed = await executePosterTaskControl(job, {
        cancel: cancelPosterJob,
        abandon: abandonPosterJob,
        refresh: getPosterJobWithDispatch,
        confirmAbandon: (warning) => window.confirm(warning),
      });
      if (!refreshed) return;
      savePosterJob(refreshed, imageId);
      setPosterToast(imageId, posterTaskControl.action === 'cancel'
        ? '待接收海报任务已取消，队列已释放，可以提交新任务'
        : '海报任务已放弃，队列已释放；当前 active Codex turn 可能仍会继续');
    } catch (error) {
      setPosterToast(imageId, error.message || '海报任务队列控制失败，请刷新后重试');
    } finally {
      finishPosterBusy(imageId);
    }
  };

  const savePosterPlan = async (nextPlan, imageId = activeImageId, job = visiblePosterJob) => {
    if (!job?.job_id || posterBusy) return null;
    beginPosterBusy(imageId);
    try {
      const saved = await updatePosterPlanRequest(
        job.job_id,
        nextPlan,
        job.manifest_revision,
      );
      savePosterJob(saved, imageId);
      return saved;
    } catch (error) {
      setPosterToast(imageId, error.message || '海报计划保存失败，请刷新后重试');
      return null;
    } finally {
      finishPosterBusy(imageId);
    }
  };

  const changePosterLayer = (layerIndex, patch) => {
    if (!visiblePosterJob?.plan) return;
    savePosterPlan(updatePosterLayer(visiblePosterJob.plan, layerIndex, patch), activeImageId, visiblePosterJob);
  };

  const changeFastPosterLayer = (layerIndex, patch) => {
    const imageId = activeImageId;
    const queued = fastPosterMutationChainRef.current.catch(() => null).then(async () => {
      const job = posterJobRef.current;
      if (posterJobImageIdRef.current !== imageId
        || !job?.plan
        || job.plan.planning_mode !== 'targeted_fast') return null;
      const invalidatesSnapshot = ['bounds', 'prompt', 'processing_category', 'layer_name', 'remove_background']
        .some((key) => Object.hasOwn(patch, key));
      let nextPlan = updatePosterLayer(job.plan, layerIndex, patch);
      if (invalidatesSnapshot) {
        nextPlan = {
          ...nextPlan,
          layers: nextPlan.layers.map((layer) => {
            if (layer.layer_index !== layerIndex) return layer;
            const {
              snapshot_id, snapshot_plan_version, snapshot_user_confirmed, confirmed_snapshot,
              ...unsnapshotted
            } = layer;
            void snapshot_id; void snapshot_plan_version; void snapshot_user_confirmed; void confirmed_snapshot;
            return { ...unsnapshotted, user_confirmed: false, state: 'SUGGESTED' };
          }),
        };
      }
      beginPosterBusy(imageId);
      try {
        const saved = await updatePosterPlanRequest(job.job_id, nextPlan, job.manifest_revision);
        savePosterJob(saved, imageId);
        return saved;
      } catch (error) {
        setPosterToast(imageId, error.message || '海报计划保存失败，请刷新后重试');
        return null;
      } finally {
        finishPosterBusy(imageId);
      }
    });
    fastPosterMutationChainRef.current = queued;
  };

  const addFastPosterLayer = async (category) => {
    const imageId = activeImageId;
    await fastPosterMutationChainRef.current.catch(() => null);
    const job = posterJobImageIdRef.current === imageId ? posterJobRef.current : null;
    if (!job?.plan || job.plan.planning_mode !== 'targeted_fast' || posterBusy) return;
    const siblings = job.plan.layers.filter((layer) => layer.processing_category === category);
    const template = siblings[0];
    if (!template) return;
    const layerIndex = Math.max(0, ...job.plan.layers.map((layer) => layer.layer_index || 0)) + 1;
    const {
      snapshot_id, snapshot_plan_version, snapshot_user_confirmed, confirmed_snapshot,
      ...newLayerBase
    } = template;
    void snapshot_id; void snapshot_plan_version; void snapshot_user_confirmed; void confirmed_snapshot;
    const nextPlan = {
      ...job.plan,
      layers: [...job.plan.layers, {
        ...newLayerBase,
        layer_index: layerIndex,
        z_order: layerIndex,
        layer_name: `${template.layer_name || '新项目'} ${siblings.length + 1}`,
        user_confirmed: false,
        state: 'SUGGESTED',
      }],
    };
    const saved = await savePosterPlan(nextPlan, imageId, job);
    if (saved) setSelectedPosterFastLayerIndex(layerIndex);
  };

  const deleteFastPosterLayer = async (layerIndex) => {
    const imageId = activeImageId;
    await fastPosterMutationChainRef.current.catch(() => null);
    const job = posterJobImageIdRef.current === imageId ? posterJobRef.current : null;
    if (!job?.plan || job.plan.planning_mode !== 'targeted_fast' || posterBusy) return;
    try {
      const result = removeFastPosterLayer(job.plan, layerIndex);
      setSelectedPosterFastLayerIndex(result.selectedLayerIndex);
      await savePosterPlan(result.plan, imageId, job);
    } catch (error) {
      setPosterToast(imageId, error.message || '当前项目无法删除');
    }
  };

  const splitFastPosterLayer = async (layerIndex) => {
    const imageId = activeImageId;
    await fastPosterMutationChainRef.current.catch(() => null);
    const job = posterJobImageIdRef.current === imageId ? posterJobRef.current : null;
    if (!job?.job_id || job.plan?.planning_mode !== 'targeted_fast' || posterBusy) return;
    beginPosterBusy(imageId);
    try {
      const { snapshot, plan } = buildFastLayerSnapshot(job.plan, layerIndex);
      const saved = await updatePosterPlanRequest(job.job_id, plan, job.manifest_revision);
      savePosterJob(saved, imageId);
      const authorizationId = posterFastCandidateAuthorizationId(
        job.job_id,
        plan.plan_version,
        layerIndex,
        { candidates: saved.manifest?.candidates || job.manifest?.candidates || [] },
      );
      const submitted = await submitPosterTargetedCandidate(job.job_id, layerIndex, {
        snapshot,
        authorizationId,
        expectedManifestRevision: saved.manifest_revision,
        planVersion: plan.plan_version,
      });
      savePosterJob({ ...saved, dispatch: { ...submitted, layer_index: submitted.layer_index ?? layerIndex, status: submitted.status || 'queued' } }, imageId);
      setPosterToast(imageId, '当前项目已提交，候选 PNG 将回传到此项目。');
    } catch (error) {
      setPosterToast(imageId, error.message || '当前项目提交失败，请刷新后重试');
    } finally {
      finishPosterBusy(imageId);
    }
  };

  const acceptFastPosterCandidate = async (layerIndex) => {
    const job = visiblePosterJob;
    const imageId = activeImageId;
    const candidate = posterCandidateViewModel(job, layerIndex);
    if (!job?.job_id || posterBusy || candidate.status !== 'NEEDS_USER_REVIEW' || !candidate.candidateId) return;
    beginPosterBusy(imageId);
    try {
      const saved = await acceptPosterCandidateRequest(job.job_id, layerIndex, candidate.candidateId, job.manifest_revision);
      savePosterJob(saved, imageId);
      setPosterToast(imageId, '候选已接受并写入正式图层');
    } catch (error) {
      setPosterToast(imageId, error.message || '接受候选失败，请刷新后重试');
    } finally {
      finishPosterBusy(imageId);
    }
  };

  const retryFastPosterCandidate = async (layerIndex, recoveryKind = 'regenerate') => {
    const job = visiblePosterJob;
    const imageId = activeImageId;
    const candidate = posterCandidateViewModel(job, layerIndex);
    if (!job?.job_id || posterBusy || !['NEEDS_USER_REVIEW', 'HARD_REJECTED'].includes(candidate.status)) return;
    beginPosterBusy(imageId);
    try {
      if (recoveryKind === 'postprocess_only') {
        const saved = await reprocessPosterFastCandidateRequest(job.job_id, layerIndex, job.manifest_revision);
        savePosterJob(saved, imageId);
        setPosterToast(imageId, '原始 PNG 已重新完成去背景和全画布归位。');
        return;
      }
      const saved = await authorizePosterRetryRequest(job.job_id, layerIndex, job.manifest_revision);
      savePosterJob(saved, imageId);
      setPosterToast(imageId, '已重新授权；请点击“拆分当前项目”生成一张新候选。');
    } catch (error) {
      setPosterToast(imageId, error.message || '重试授权失败，请刷新后重试');
    } finally {
      finishPosterBusy(imageId);
    }
  };

  const reorderPosterLayer = (layerIndex, direction) => {
    const job = visiblePosterJob;
    const imageId = activeImageId;
    const layers = [...(job?.plan?.layers || [])].sort((left, right) => left.layer_index - right.layer_index);
    const currentIndex = layers.findIndex((layer) => layer.layer_index === layerIndex);
    const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= layers.length) return;
    [layers[currentIndex], layers[nextIndex]] = [layers[nextIndex], layers[currentIndex]];
    savePosterPlan({
      ...job.plan,
      layers: layers.map((layer, index) => ({ ...layer, layer_index: index + 1, z_order: index + 1 })),
    }, imageId, job);
  };

  const deletePosterLayer = (layerIndex) => {
    const job = visiblePosterJob;
    const imageId = activeImageId;
    if (!job?.plan || !window.confirm('删除该海报图层？此操作会使未接受候选失效。')) return;
    const layers = job.plan.layers.filter((layer) => layer.layer_index !== layerIndex)
      .map((layer, index) => ({ ...layer, layer_index: index + 1, z_order: index + 1 }));
    savePosterPlan({ ...job.plan, layers }, imageId, job);
  };

  const mergePosterLayers = (firstIndex, secondIndex) => {
    const job = visiblePosterJob;
    const imageId = activeImageId;
    if (!job?.plan) return;
    const first = job.plan.layers.find((layer) => layer.layer_index === firstIndex);
    const second = job.plan.layers.find((layer) => layer.layer_index === secondIndex);
    const mergeValidation = validatePosterMerge(first, second);
    if (!mergeValidation.valid) {
      setToast(mergeValidation.message);
      return;
    }
    if (!first || !second || !window.confirm(`合并“${first.layer_name}”与“${second.layer_name}”？`)) return;
    const merged = {
      ...first,
      layer_name: `${first.layer_name} + ${second.layer_name}`,
      visible_content: [...(first.visible_content || []), ...(second.visible_content || [])],
      included_content: [...(first.included_content || []), ...(second.included_content || [])],
      source_evidence: [...(first.source_evidence || []), ...(second.source_evidence || [])],
      support_components: [...(first.support_components || []), ...(second.support_components || [])],
      occludes: [...new Set([...(first.occludes || []), ...(second.occludes || [])])],
      occluded_by: [...new Set([...(first.occluded_by || []), ...(second.occluded_by || [])])],
      separation_reason: `${first.separation_reason || ''}；合并 ${second.layer_name}`,
    };
    const layers = job.plan.layers
      .filter((layer) => layer.layer_index !== secondIndex)
      .map((layer) => layer.layer_index === firstIndex ? merged : layer)
      .sort((left, right) => left.layer_index - right.layer_index)
      .map((layer, index) => ({ ...layer, layer_index: index + 1, z_order: index + 1 }));
    savePosterPlan({ ...job.plan, layers }, imageId, job);
  };

  const confirmPosterPlan = async () => {
    const job = visiblePosterJob;
    const imageId = activeImageId;
    if (!job?.plan || !validatePosterPlan(job.plan).valid || posterBusy) return;
    beginPosterBusy(imageId);
    try {
      const saved = await confirmPosterPlanRequest(job.job_id, job.manifest_revision);
      savePosterJob(saved, imageId);
      setPosterToast(imageId, '海报计划已确认，可以逐层生成候选');
    } catch (error) {
      setPosterToast(imageId, error.message || '海报计划确认失败，请刷新后重试');
    } finally {
      finishPosterBusy(imageId);
    }
  };

  const generatePosterCandidate = async (layerIndex) => {
    const job = visiblePosterJob;
    const imageId = activeImageId;
    const candidate = posterCandidateViewModel(job, layerIndex);
    if (!job?.job_id || posterBusy || !candidate.canGenerate) return;
    beginPosterBusy(imageId);
    try {
      const submitted = await submitPosterCandidate(job.job_id, layerIndex, {
        explicitAuthorization: true,
        expectedManifestRevision: job.manifest_revision,
        planVersion: job.plan?.plan_version,
      });
      savePosterJob({ ...job, dispatch: { ...submitted, status: submitted.status || 'queued' } }, imageId);
      setPosterToast(imageId, '已明确授权并提交这一层的一张候选生成');
    } catch (error) {
      setPosterToast(imageId, error.message || '候选生成提交失败，请刷新后重试');
    } finally {
      finishPosterBusy(imageId);
    }
  };

  const acceptPosterLayerCandidate = async (layerIndex) => {
    const job = visiblePosterJob;
    const imageId = activeImageId;
    const candidate = posterCandidateViewModel(job, layerIndex);
    if (!job?.job_id || posterBusy || !candidate.canAccept || !candidate.candidateId) return;
    beginPosterBusy(imageId);
    try {
      const saved = await acceptPosterCandidateRequest(job.job_id, layerIndex, candidate.candidateId, job.manifest_revision);
      savePosterJob(saved, imageId);
      setPosterToast(imageId, '候选已接受并规范化为正式图层');
    } catch (error) {
      setPosterToast(imageId, error.message || '接受候选失败，请刷新后重试');
    } finally {
      finishPosterBusy(imageId);
    }
  };

  const retryPosterLayerCandidate = async (layerIndex) => {
    const job = visiblePosterJob;
    const imageId = activeImageId;
    const candidate = posterCandidateViewModel(job, layerIndex);
    if (!job?.job_id || posterBusy || !candidate.canRetry) return;
    beginPosterBusy(imageId);
    try {
      const saved = await authorizePosterRetryRequest(job.job_id, layerIndex, job.manifest_revision);
      savePosterJob(saved, imageId);
      setPosterToast(imageId, '已授权重试；请再次点击“生成候选”提交这一层。');
    } catch (error) {
      setPosterToast(imageId, error.message || '重试授权失败，请刷新后重试');
    } finally {
      finishPosterBusy(imageId);
    }
  };

  const runPosterRecompositionAudit = async () => {
    const job = visiblePosterJob;
    const imageId = activeImageId;
    if (!job?.job_id || posterBusy || !posterAuditState.canAudit) return;
    beginPosterBusy(imageId);
    try {
      const saved = await runPosterAuditRequest(job.job_id, job.manifest_revision);
      savePosterJob(saved, imageId);
      const nextAudit = posterAuditUiState(saved);
      setPosterToast(imageId, nextAudit.status === 'passed'
        ? '重组审计通过，可以下载海报分层包'
        : '重组审计未通过，请返回冲突图层审核');
    } catch (error) {
      setPosterToast(imageId, error.message || '重组审计失败，请刷新后重试');
    } finally {
      finishPosterBusy(imageId);
    }
  };

  const reauthorizePosterAuditLayer = async (layerIndex) => {
    const job = visiblePosterJob;
    const imageId = activeImageId;
    if (!job?.job_id || posterBusy || !posterAuditState.conflictLayers.includes(layerIndex)) return;
    beginPosterBusy(imageId);
    try {
      const saved = await reauthorizePosterAuditLayerRequest(
        job.job_id, layerIndex, job.manifest_revision,
      );
      savePosterJob(saved, imageId);
      setPosterToast(imageId, `第 ${layerIndex} 层的旧正式文件已归档；已创建新授权，请手动生成候选。`);
    } catch (error) {
      setPosterToast(imageId, error.message || '审计修复授权失败，请刷新后重试');
    } finally {
      finishPosterBusy(imageId);
    }
  };

  const focusPosterAuditConflict = () => {
    const layerIndex = posterAuditState.conflictLayers[0];
    if (!layerIndex) return;
    document.getElementById(`poster-layer-${layerIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleSourceDragEnter = (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    sourceDragDepthRef.current += 1;
    setSourceDropActive(true);
  };

  const handleSourceDragOver = (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleSourceDragLeave = (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    sourceDragDepthRef.current = Math.max(0, sourceDragDepthRef.current - 1);
    if (!sourceDragDepthRef.current) setSourceDropActive(false);
  };

  const handleSourceDrop = (event) => {
    event.preventDefault();
    sourceDragDepthRef.current = 0;
    setSourceDropActive(false);
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) {
      setToast('请拖入 PNG、JPG 或 WebP 图片');
      return;
    }
    loadSourceFile(file);
  };

  const openSourceFilePicker = () => {
    sourceFileInputRef.current?.click();
  };

  const openSourcePickerFromEmptyCanvas = (event) => {
    if (
      hasSource
      || event.target.closest(
        '.canvas-bottom-controls, .canvas-command-controls, .canvas-empty-node-picker__option, .node-type-menu',
      )
    ) return;
    openSourceFilePicker();
  };

  const renderLegacyAnnotationMark = (mark) => {
    const selectedClass = selectedMarkId === mark.id ? 'annotation-mark--selected' : '';
    const commonProps = {
      onPointerDown: (event) => {
        event.stopPropagation();
        updateReviewPenSelection(selectedId, null);
        setSelectedMarkId(mark.id);
      },
    };
    if (mark.shape === 'rect') {
      return (
        <rect
          key={mark.id}
          className={`annotation-mark annotation-mark--${mark.kind} ${selectedClass}`}
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
          className={`annotation-mark annotation-mark--${mark.kind} ${selectedClass}`}
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
        className={`annotation-mark annotation-mark--${mark.kind} ${selectedClass}`}
        points={mark.points.map((point) => `${point.x},${point.y}`).join(' ')}
        style={{ strokeWidth: `${mark.brush_size_px}px` }}
        vectorEffect="non-scaling-stroke"
        {...commonProps}
      />
    );
  };

  const renderAnnotationOverlay = () => (
    <>
      {selectedLegacyMarks.length ? (
        <svg className="annotation-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="旧版边界精修标注">
          {selectedLegacyMarks.map((mark) => renderLegacyAnnotationMark(mark))}
        </svg>
      ) : null}
      <PenPathOverlay
        ref={reviewPenOverlayRef}
        paths={selectedPenPaths}
        draft={draftMark}
        selection={selectedPenSelection}
        feedbackToken={selectedPenFeedbackToken}
        activeKind={maskTool || 'foreground'}
        onChange={updatePenPaths}
        ariaLabel="边界精修钢笔标注"
      />
    </>
  );

  const renderFastPosterPenOverlay = (layer) => {
    if (layer?.layer_index !== fastPosterPenLayerIndex) return null;
    return <PenPathOverlay
      paths={fastPosterPenPaths}
      draft={fastPosterPenDraft}
      selection={fastPosterPenSelection}
      feedbackToken={fastPosterPenFeedbackToken}
      activeKind={fastPosterPenTool}
      disabled={posterBusy}
      onChange={updateFastPosterPenPaths}
      ariaLabel="当前海报项目钢笔边界精修"
    />;
  };

  const renderRequestPanel = () => {
    if (!hasSource) {
      return (
        <div className="canvas-summary canvas-summary--empty">
          <ImagePlus size={22} />
          <strong>尚未载入原图</strong>
          <span>上传 UI 图片后，才能建立拆分项。</span>
        </div>
      );
    }
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
                        : activeSelectedJob.status === 'queued'
                          ? '当前任务完成后将按提交顺序自动发送'
                        : activeSelectedJob.status === 'awaiting_codex_message'
                          ? '等待当前会话监听领取拆分任务'
                        : activeSelectedJob.status === 'sending_to_codex'
                          ? '正在提交框选预览、拆分提示词与执行计划'
                        : activeSelectedJob.status === 'host_accepted'
                          ? '宿主已接收请求，等待当前 Codex 任务显示并确认'
                        : activeSelectedJob.status === 'submitted_to_conversation'
                            ? '旧版宿主已接收，等待当前 Codex 任务确认'
                          : `开始于 ${formatClock(activeSelectedJob.submittedAt)}，正在当前任务中执行`
                  )}
                </small>
              </span>
              {!activeSelectedJob.images?.length ? (
                <button
                  type="button"
                  className="job-strip__dismiss"
                  aria-label={cancelableDeliveryStatuses.has(activeSelectedJob.status)
                    ? '取消待接收任务'
                    : isAbandonablePlanStatus(activeSelectedJob.status)
                      ? '放弃任务并释放队列'
                      : '移除当前任务状态'}
                  data-tooltip={cancelableDeliveryStatuses.has(activeSelectedJob.status)
                    ? '取消待接收任务'
                    : isAbandonablePlanStatus(activeSelectedJob.status)
                      ? '放弃任务并释放队列'
                      : '移除当前任务状态'}
                  onClick={() => (
                    cancelableDeliveryStatuses.has(activeSelectedJob.status)
                      ? cancelPendingJob(activeSelectedJob)
                      : isAbandonablePlanStatus(activeSelectedJob.status)
                        ? abandonRunningJob(activeSelectedJob)
                        : dismissJob(activeSelectedJob)
                  )}
                  disabled={cancellingJobId === activeSelectedJob.id}
                >
                  {cancellingJobId === activeSelectedJob.id
                    ? <LoaderCircle size={13} className="spin" />
                    : <X size={13} />}
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
            <span><strong>{selectedMarks.length ? '边界已调整' : '边界精修'}</strong><small>{selectedMarks.length ? `${selectedMarks.length} 个精修标注` : '在右侧大预览中精确编辑'}</small></span>
            <ChevronDown size={16} className={boundaryOpen ? 'chevron-open' : ''} />
          </button>
          {boundaryOpen ? (
            <div className="boundary-tools">
              <div className="boundary-tool-grid">
                <button type="button" aria-pressed={maskTool === 'foreground' && !showOriginalOnly} className={maskTool === 'foreground' && !showOriginalOnly ? 'boundary-tool boundary-tool--active boundary-tool--foreground' : 'boundary-tool'} onClick={() => selectMaskTool('foreground')}><PenTool size={16} /> 保留钢笔</button>
                <button type="button" aria-pressed={maskTool === 'background' && !showOriginalOnly} className={maskTool === 'background' && !showOriginalOnly ? 'boundary-tool boundary-tool--active boundary-tool--background' : 'boundary-tool'} onClick={() => selectMaskTool('background')}><PenTool size={16} /> 排除钢笔</button>
                <button type="button" aria-pressed={maskTool === 'boundary' && !showOriginalOnly} className={maskTool === 'boundary' && !showOriginalOnly ? 'boundary-tool boundary-tool--active boundary-tool--boundary' : 'boundary-tool'} onClick={() => selectMaskTool('boundary')}><PenTool size={16} /> 边界钢笔</button>
                <button type="button" aria-pressed={maskTool === 'repair' && !showOriginalOnly} className={maskTool === 'repair' && !showOriginalOnly ? 'boundary-tool boundary-tool--active boundary-tool--repair' : 'boundary-tool'} onClick={() => selectMaskTool('repair')}><WandSparkles size={16} /> 补全钢笔</button>
                <button type="button" aria-pressed={showOriginalOnly} className={showOriginalOnly ? 'boundary-tool boundary-tool--active' : 'boundary-tool'} onClick={toggleOriginalOnly}><Hand size={16} /> {showOriginalOnly ? '显示标注' : '隐藏标注'}</button>
              </div>
              <p className="boundary-help">
                {showOriginalOnly
                  ? '当前只显示框选区域原图，再点“显示标注”继续编辑。'
                  : maskTool === 'foreground'
                    ? '点击添加锚点，拖动可建立曲线手柄；闭合区域内的像素必须保留。'
                    : maskTool === 'background'
                      ? '点击添加锚点，拖动可建立曲线手柄；闭合区域内的内容需要排除。'
                      : maskTool === 'boundary'
                        ? '沿目标边缘添加锚点，点击起点闭合路径；Alt 拖动可断开手柄联动。'
                        : maskTool === 'repair'
                          ? '圈出被遮挡或被移除后需要补全的区域；最终只允许在该区域内写入模型修复内容。'
                        : '请选择一种钢笔。选中后可再次点击同一按钮退出。'}
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
                      onClick={() => {
                        updateReviewPenSelection(
                          selectedId,
                          mark.shape === 'bezier_path' ? { pathId: mark.id } : null,
                        );
                        setSelectedMarkId(mark.id);
                      }}
                    >
                      {mark.shape === 'bezier_path' ? <PenTool size={12} /> : mark.shape === 'stroke' ? <Brush size={12} /> : <Square size={12} />}
                      {mark.kind === 'foreground' ? '保留' : mark.kind === 'background' ? '排除' : mark.kind === 'repair' ? '补全' : '边界'}{mark.shape === 'bezier_path' ? '路径' : '笔划'} {index + 1}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="annotation-actions">
                <button type="button" onClick={undoLastMark} disabled={!canInvokePenOverlayCommand(reviewPenOverlayRef.current, 'undo', { mounted: annotationSessionActive && !showOriginalOnly })}><Undo2 size={13} /> 撤销</button>
                <button type="button" onClick={redoLastMark} disabled={!canInvokePenOverlayCommand(reviewPenOverlayRef.current, 'redo', { mounted: annotationSessionActive && !showOriginalOnly })}><Redo2 size={13} /> 重做</button>
                <button type="button" onClick={deleteSelectedMark} disabled={!canDeleteReviewMark(currentReviewPenParentState())}><Trash2 size={13} /> 删除选中</button>
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
          <button type="button" className="command-button command-button--wide" onClick={submitCurrent} disabled={selectedNodeRunning || Boolean(selectedPendingRevision)}>
            {selectedNodeRunning || selectedPendingRevision ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}
            {selectedNodeRunning || selectedPendingRevision ? '拆分中' : latestSelectedResult?.image ? '重新拆分' : '拆分'}
          </button>
          {selected.status === 'accepted' ? <IconButton label="撤销当前确认" onClick={undoConfirmation}><Undo2 size={17} /></IconButton> : <span />}
        </div>
      </>
    );
  };

  const renderCanvasSummary = () => {
    if (singleSelectedCanvasItem?.kind === 'source') {
      return (
        <div className="canvas-summary">
          <div className="request-category">
            <span><ImagePlus size={17} />原图节点</span>
            <span className="status-pill status-pill--accepted">已载入</span>
          </div>
          <div className="canvas-summary__section">
            <span>节点状态</span>
            <p>当前工作流的原始 UI 图片，是所有拆分节点的上游来源。</p>
          </div>
          <div className="region-readout">
            <span>
              <small>原图尺寸</small>
              <strong>{sourceSize.width} x {sourceSize.height}</strong>
              <em>位置 {Math.round(singleSelectedCanvasItem.x)}, {Math.round(singleSelectedCanvasItem.y)}</em>
            </span>
          </div>
        </div>
      );
    }

    if (
      singleSelectedCanvasItem?.kind === 'result'
      || singleSelectedCanvasItem?.kind === 'manual-result'
    ) {
      const resultItem = resultNodes.find(
        (item) => resultNodeKey(item.id) === singleSelectedCanvasItem.key,
      );
      const resultPixels = resultItem
        ? pixelBounds(resultItem.bounds, resultItem.sourceSize)
        : null;
      const complete = Boolean(resultItem?.image);
      return (
        <div className="canvas-summary">
          <div className="request-category">
            <span><ImagePlus size={17} />拆分结果节点</span>
            <span className={`status-pill ${complete ? 'status-pill--job-completed' : 'status-pill--job-pending'}`}>
              {complete ? '结果已产出' : '等待结果'}
            </span>
          </div>
          <div className="canvas-summary__section">
            <span>节点状态</span>
            <p>{complete ? '已接收拆分 PNG，可继续预览或编辑结果。' : '该节点等待上游拆分节点产出 PNG。'}</p>
          </div>
          <div className="region-readout">
            <span>
              <small>{resultPixels ? '输出尺寸' : '画布位置'}</small>
              <strong>{resultPixels ? `${resultPixels.width} x ${resultPixels.height}` : `${Math.round(singleSelectedCanvasItem.x)}, ${Math.round(singleSelectedCanvasItem.y)}`}</strong>
              <em>{resultPixels ? `位置 ${resultPixels.x}, ${resultPixels.y}` : '尚未生成图片'}</em>
            </span>
          </div>
          {hasSelectedLayer ? (
            <div className={`canvas-summary__actions ${complete ? '' : 'canvas-summary__actions--single'}`}>
              <button
                type="button"
                className="command-button command-button--quiet canvas-summary__edit"
                onClick={() => openGuidedEditor(selected.id)}
              >
                <ScanSearch size={16} /> 编辑拆分
              </button>
              {complete ? (
                <button
                  type="button"
                  className="command-button canvas-summary__edit"
                  onClick={() => openGuidedEditor(selected.id, true)}
                >
                  <PencilLine size={16} /> 编辑结果
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    }

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
      <input
        ref={sourceFileInputRef}
        className="source-file-input"
        type="file"
        accept="image/*"
        onChange={handleFile}
        aria-label="上传原图"
      />
      <header className="topbar">
        <div className="product-identity">
          <div className="brand-lockup">
            <div className="brand-mark"><img src="/imvia-logo.png" alt="" /></div>
            <strong>Imvia Layer</strong>
          </div>
          <div
            className={`conversation-bridge-indicator ${
              conversationBridge.online
                ? 'conversation-bridge-indicator--online'
                : 'conversation-bridge-indicator--offline'
            }`}
            title={conversationBridge.lastSeen || ''}
          >
            <span className="conversation-bridge-indicator__dot" />
            <span className="conversation-bridge-indicator__label">
              {conversationBridge.checked
                ? (conversationBridge.online ? '已就绪' : '已断开')
                : '连接中'}
            </span>
            {conversationBridge.checked && !conversationBridge.online ? (
              <button
                type="button"
                className="conversation-bridge-indicator__reconnect"
                onClick={reconnectConversation}
              >
                <RefreshCw size={11} />重新连接</button>
            ) : null}
          </div>
          <div className="project-context" aria-label="拆分确认进度">
            {hasSource ? <small>{`${acceptedCount} / ${nodes.length} 已确认`}</small> : null}
          </div>
        </div>

        <ModeSwitch value={reviewMode} onChange={(mode) => {
          setReviewMode(mode);
          if (mode === 'canvas') {
            setIsLeftOpen(false);
            setCanvasSelectedKeys(hasSelectedLayer ? [splitNodeKey(selected.id)] : []);
            window.scrollTo({ top: 0, left: 0 });
            window.setTimeout(() => {
              if (canvasRef.current) {
                canvasRef.current.scrollTop = 0;
                canvasRef.current.scrollLeft = 0;
              }
              fitCanvasOverview();
            }, 220);
          } else {
            setIsLeftOpen(Boolean(nodes.length));
            setIsRightOpen(hasSelectedLayer);
          }
        }} />

        <div className="topbar-actions">
          <div ref={topbarMenuRef} className={`topbar-more ${topbarMenuOpen ? 'topbar-more--open' : ''}`}>
            <IconButton
              label="下载与导出"
              aria-haspopup="menu"
              aria-expanded={topbarMenuOpen}
              onClick={() => setTopbarMenuOpen((current) => !current)}
            >
              {downloadingAll ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />}
            </IconButton>
            {topbarMenuOpen ? (
              <div className="topbar-menu" role="menu" aria-label="下载与导出">
                <button
                  type="button"
                  role="menuitem"
                  disabled={!downloadableResults.length || downloadingAll}
                  onClick={() => {
                    setTopbarMenuOpen(false);
                    downloadAllResults();
                  }}
                >
                  <Download size={17} />
                  <span>
                    <strong>下载全部 PNG</strong>
                    <small>{downloadableResults.length ? `${downloadableResults.length} 张拆分结果` : '暂无可下载结果'}</small>
                  </span>
                </button>
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
                  <span><strong>下载拆分计划</strong><small>JSON 配置</small></span>
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

      {shellStructure.switcher ? (
        <nav className="document-switcher" aria-label="项目图片">
          {documentNavigationItems(imageDocuments, activeImageId).map((document) => (
            <div key={document.imageId} className={`document-switcher__item ${document.active ? 'document-switcher__item--active' : ''}`}>
              <button
                type="button"
                aria-current={document.active ? 'page' : undefined}
                onClick={() => activateImageDocument(document.imageId)}
              >
                <span>{document.label}</span><small>{document.mode === 'poster' ? '海报分层' : 'UI/运营图'}</small>
              </button>
              <button type="button" aria-label={`删除 ${document.label}`} onClick={() => deleteDocumentFromSwitcher(document.imageId)}><Trash2 size={13} /></button>
            </div>
          ))}
        </nav>
      ) : null}

      <section
        data-shell-grid-row={shellStructure.workspace.gridRow}
        className={[
          'workspace',
          `workspace--${reviewMode}`,
          !panelVisibility.left ? 'workspace--left-collapsed' : '',
          !panelVisibility.right ? 'workspace--right-collapsed' : '',
        ].filter(Boolean).join(' ')}
      >
        {documentMode === 'poster' ? (
          <section className={`poster-workbench ${isFastPosterPlan && activePosterView.kind === 'fast' ? 'poster-workbench--fast' : ''}`} aria-label="海报分层工作台">
            {!isFastPosterPlan ? <PosterTaskControl
              view={posterTaskControl}
              busy={posterBusy}
              onControl={controlActivePosterTask}
            /> : null}
            {!visiblePosterJob ? (
              <div className="poster-workbench__empty poster-workbench__empty--fast-loading">
                <LoaderCircle size={34} className="spin" />
                <small>海报快速分层</small>
                <h2>正在准备快速定向工作台</h2>
                <p>正在生成类别和可编辑框选，完成后直接进入当前项目拆分。</p>
              </div>
            ) : isFastPosterPlan && activePosterView.kind === 'fast' ? (
              <PosterFastWorkbench
                sourceUrl={sourceDataUrl || sourceImage}
                sourceName={sourceName}
                sourceSize={sourceSize}
                plan={visiblePosterJob.plan}
                selectedLayerIndex={activePosterFastLayerIndex}
                candidate={displayPosterFastCandidateWithPreview}
                busy={posterBusy}
                clockNow={clockNow}
                taskControl={posterTaskControl}
                onTaskControl={controlActivePosterTask}
                downloadUrl={posterFastDownloadPath ? resolveWorkbenchUrl(posterFastDownloadPath) : null}
                onDeleteSource={deleteOriginalCanvas}
                onSelectLayer={(layerIndex) => {
                  setSelectedPosterFastLayerIndex(layerIndex);
                  setFastPosterPenLayerIndex(null);
                  setFastPosterPenTool('foreground');
                  setFastPosterPenDraft(null);
                  setFastPosterPenSelectedMarkId(null);
                }}
                onAddLayer={addFastPosterLayer}
                onDeleteLayer={deleteFastPosterLayer}
                onUpdateLayer={changeFastPosterLayer}
                onOpenPen={(layerIndex, tool = 'foreground') => {
                  setSelectedPosterFastLayerIndex(layerIndex);
                  setFastPosterPenTool(tool || 'foreground');
                  setFastPosterPenLayerIndex(tool ? layerIndex : null);
                }}
                onSplit={splitFastPosterLayer}
                onAccept={acceptFastPosterCandidate}
                onRetry={retryFastPosterCandidate}
                renderPenOverlay={renderFastPosterPenOverlay}
              />
            ) : activePosterView.kind === 'review' ? (
              <PosterPlanReview
                plan={visiblePosterJob.plan}
                validation={validatePosterPlan(visiblePosterJob.plan)}
                busy={posterBusy}
                onLayerChange={changePosterLayer}
                onReorder={reorderPosterLayer}
                onDelete={deletePosterLayer}
                onMerge={mergePosterLayers}
                onConfirm={confirmPosterPlan}
              />
            ) : activePosterView.kind === 'confirmed' ? (
              <div className="poster-candidate-workbench">
                <header className="poster-candidate-workbench__intro">
                  <CheckCircle2 size={26} />
                  <div><small>计划已确认</small><h2>逐层生成并审核候选</h2>
                    <p>每次只提交一层的一张候选。原始绿幕/黑底 PNG 是唯一正式候选；透明视图仅用于比较。</p></div>
                </header>
                <section className={`poster-completion poster-completion--${posterAuditState.status}`} aria-label="海报重组审计与导出">
                  <div>
                    <small>最终交付</small>
                    <h3>{posterAuditState.status === 'passed' ? '重组审计已通过' : '重组审计'}</h3>
                    {posterAuditState.status === 'failed' ? (
                      <p>冲突图层：{posterAuditState.conflictLayers.length ? posterAuditState.conflictLayers.join('、') : '未定位'}；失败码：{posterAuditState.failureCodes.join('、') || 'AUDIT_FAILED'}。已接受文件保持不变。</p>
                    ) : posterAuditState.status === 'stale' ? (
                      <p>计划或清单已变化，之前的审计不能用于导出，请重新运行。</p>
                    ) : posterAuditState.status === 'passed' ? (
                      <p>审计已绑定当前计划、清单版本、合成顺序和正式图层摘要。</p>
                    ) : (
                      <p>全部计划图层接受后，可按从背景到前景的确定顺序运行审计。</p>
                    )}
                  </div>
                  <div className="poster-completion__actions">
                    {posterAuditState.status === 'failed' && posterAuditState.conflictLayers.length ? (
                      <>
                        <button type="button" className="command-button" onClick={focusPosterAuditConflict}>返回相关图层审核</button>
                        {posterAuditState.conflictLayers.map((layerIndex) => (
                          <button
                            key={`audit-remediation-${layerIndex}`}
                            type="button"
                            className="command-button"
                            onClick={() => reauthorizePosterAuditLayer(layerIndex)}
                            disabled={posterBusy}
                          >
                            归档并重新授权第 {layerIndex} 层
                          </button>
                        ))}
                      </>
                    ) : null}
                    <button type="button" className="command-button" onClick={runPosterRecompositionAudit} disabled={posterBusy || !posterAuditState.canAudit}>
                      {posterBusy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} 运行重组审计
                    </button>
                    {posterAuditState.canExport ? (
                      <a className="command-button command-button--primary" href={posterExportUrl(visiblePosterJob.job_id)}>
                        <Download size={15} /> 下载海报分层包
                      </a>
                    ) : null}
                  </div>
                </section>
                {posterCandidateViews.map((candidate) => (
                  <div key={candidate.layerIndex} id={`poster-layer-${candidate.layerIndex}`}>
                    <PosterCandidateReview
                      sourceUrl={sourceDataUrl || sourceImage}
                      candidateUrl={candidate.candidateUrl || (candidate.candidateId
                        ? resolveWorkbenchUrl(`/api/poster-layer/jobs/${encodeURIComponent(visiblePosterJob.job_id)}/layers/${candidate.layerIndex}/candidate-preview`)
                        : null)}
                      layer={candidate.layer}
                      review={{ ...candidate.review, canGenerate: candidate.canGenerate, canAccept: candidate.canAccept, canRetry: candidate.canRetry, busy: posterBusy }}
                      onGenerate={() => generatePosterCandidate(candidate.layerIndex)}
                      onAccept={() => acceptPosterLayerCandidate(candidate.layerIndex)}
                      onRetry={() => retryPosterLayerCandidate(candidate.layerIndex)}
                    />
                  </div>
                ))}
              </div>
            ) : activePosterView.kind === 'failed' ? (
              <div className="poster-workbench__empty poster-workbench__empty--failed">
                <CircleX size={34} />
                <h2>海报分析未完成</h2>
                <p>保留原图不变；请检查任务消息后重新分析。</p>
                <button type="button" className="command-button" onClick={startPosterAnalysis} disabled={posterBusy}>重新分析</button>
              </div>
            ) : activePosterView.kind === 'queued' ? (
              <div className="poster-workbench__empty" aria-busy="true">
                <LoaderCircle size={34} className="spin" />
                <small>海报层级分析</small>
                <h2>分析任务正在排队</h2>
                <p>等待当前 Codex 任务结束后，海报分析会发送到同一会话。</p>
              </div>
            ) : (
              <div className="poster-workbench__empty" aria-busy="true">
                <LoaderCircle size={34} className="spin" />
                <small>分析海报层级</small>
                <h2>正在发送到当前 Codex 会话并分析</h2>
                <p>任务进入队列后会显示处理进度；分析阶段不会调用候选生成。</p>
              </div>
            )}
          </section>
        ) : (
          <>
        <aside className={`sidebar sidebar--left ${!panelVisibility.left ? 'sidebar--collapsed' : ''}`}>
          <div className="panel-title-row">
            <span className="eyebrow">拆分栏目</span>
          </div>

          {hasSource ? (
            <div className="source-meta">
              <div className="source-meta__thumbnail"><img src={sourceImage} alt="当前原图" /></div>
              <div className="source-meta__copy"><strong>原始画布</strong><span>{sourceSize.width} x {sourceSize.height} RGBA</span></div>
              <label className="icon-button source-meta__upload" aria-label="重新载入原图" data-tooltip="重新载入原图">
                <Upload size={16} /><input type="file" accept="image/*" onChange={handleFile} />
              </label>
              <button type="button" className="icon-button source-meta__delete" aria-label="删除原始画布" data-tooltip="删除原始画布" onClick={deleteOriginalCanvas}>
                <Trash2 size={16} />
              </button>
            </div>
          ) : (
            <label className="source-empty-upload">
              <ImagePlus size={20} />
              <span><strong>上传 UI 原图</strong><small>PNG、JPG 或 WebP</small></span>
              <input type="file" accept="image/*" onChange={handleFile} />
            </label>
          )}

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
                      <button type="button" disabled={!hasSource} className="add-layer-button add-layer-button--icon" aria-label={`添加${meta.label}`} data-tooltip={hasSource ? `添加${meta.label}` : '请先上传 UI 原图'} onClick={() => addLayer(group.category)}><Plus size={13} /></button>
                    </div>
                  </div>
                  <div className="layer-list">
                    {group.items.map((node) => {
                      const rowResult = nodeResults.get(node.id);
                      const rowState = nodeResultStates.get(node.id);
                      const rowJob = localSubmissions[node.id]
                        || rowState?.pendingRevision?.job
                        || rowState?.failedRevision?.job
                        || rowResult?.job;
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
                  style={{
                    aspectRatio: `${sourceSize.width} / ${sourceSize.height}`,
                    maxWidth: `min(100%, ${Math.max(96, Math.round((sourceSize.width / sourceSize.height) * 330))}px)`,
                  }}
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
                  className={`region-preview--guided region-preview--editable ${candidatePreviewExpanded ? 'region-preview--expanded' : ''} ${annotationSessionActive ? `region-preview--tool-${maskTool}` : 'region-preview--crop-editor'}`}
                  onPointerDown={annotationSessionActive ? undefined : (event) => startCandidateSelection(event, 'draw')}
                >
                  {annotationSessionActive ? (showOriginalOnly ? null : renderAnnotationOverlay()) : (
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
                </RegionPreview>
                <div className="candidate-preview-toolbar">
                  {boundaryOpen && annotationSessionActive ? (
                    <span className="candidate-preview-hint">
                      {showOriginalOnly
                        ? '标注已隐藏'
                        : maskTool === 'foreground'
                          ? '点击添加保留路径锚点'
                          : maskTool === 'background'
                            ? '点击添加排除路径锚点'
                            : maskTool === 'boundary'
                              ? '点击添加边界路径锚点'
                              : '请在右侧选择精修工具'}
                    </span>
                  ) : <span aria-hidden="true" />}
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
                </div>
              </div>
            </div>

            <section className={`guided-result-panel ${resultPreviewExpanded ? 'guided-result-panel--expanded-editor' : ''} ${activeSelectedJob ? `guided-result-panel--${jobStatus(activeSelectedJob.status).tone}` : ''}`}>
              <header className="guided-result-panel__header">
                <div>
                  <span>Codex 拆分结果</span>
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
                    <>
                      {cancelableDeliveryStatuses.has(activeSelectedJob.status) ? (
                        <button
                          type="button"
                          className="guided-result-panel__cancel"
                          onClick={() => cancelPendingJob(activeSelectedJob)}
                          disabled={cancellingJobId === activeSelectedJob.id}
                        >
                          {cancellingJobId === activeSelectedJob.id
                            ? <LoaderCircle size={14} className="spin" />
                            : <X size={14} />}
                          <span>{cancellingJobId === activeSelectedJob.id ? '取消中' : '取消发送'}</span>
                        </button>
                      ) : isAbandonablePlanStatus(activeSelectedJob.status) ? (
                        <button
                          type="button"
                          className="guided-result-panel__cancel"
                          onClick={() => abandonRunningJob(activeSelectedJob)}
                          disabled={cancellingJobId === activeSelectedJob.id}
                          title="只释放工作台队列，不能停止 Codex 当前生成"
                        >
                          {cancellingJobId === activeSelectedJob.id
                            ? <LoaderCircle size={14} className="spin" />
                            : <CircleX size={14} />}
                          <span>{cancellingJobId === activeSelectedJob.id ? '放弃中' : '放弃任务并释放队列'}</span>
                        </button>
                      ) : null}
                      <div className={`guided-result-panel__status guided-result-panel__status--${jobStatus(activeSelectedJob.status).tone}`}>
                        {jobStatus(activeSelectedJob.status).tone === 'pending' ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}
                        <span>{jobStatus(activeSelectedJob.status).label}</span>
                        <small>{formatElapsed(activeSelectedJob.submittedAt, elapsedEnd(activeSelectedJob, clockNow))}</small>
                        {jobStatus(activeSelectedJob.status).tone === 'failed' && activeSelectedJob.statusDetail ? <small>{activeSelectedJob.statusDetail}</small> : null}
                      </div>
                    </>
                  ) : (
                    <span className="guided-result-panel__idle-status">尚未发送</span>
                  )}
                </div>
              </header>

              <div className={`guided-result-panel__body ${resultPreviewExpanded ? 'guided-result-panel__body--expanded-editor' : ''} ${resultEditing ? 'guided-result-panel__body--editing' : ''} ${!resultEditing && selectedResultHistory.length > 1 ? 'guided-result-panel__body--versions' : ''}`}>
                {latestSelectedResult?.image ? (
                  <div className={`guided-result-panel__canvas ${resultEditing ? 'guided-result-panel__canvas--editing' : ''} ${resultPreviewExpanded ? 'guided-result-panel__canvas--expanded-editor' : ''}`}>
                    {resultEditing ? (
                      <div className="result-editor__toolbar" role="toolbar" aria-label="结果精修工具">
                        <button
                          type="button"
                          aria-pressed={resultEditTool === 'foreground'}
                          className={resultEditTool === 'foreground' ? 'result-editor__tool result-editor__tool--active result-editor__tool--foreground' : 'result-editor__tool'}
                          onClick={() => selectResultEditTool('foreground')}
                          disabled={Boolean(selectedPendingRevision)}
                        >
                          <PenTool size={14} /> 保留钢笔
                        </button>
                        <button
                          type="button"
                          aria-pressed={resultEditTool === 'background'}
                          className={resultEditTool === 'background' ? 'result-editor__tool result-editor__tool--active result-editor__tool--background' : 'result-editor__tool'}
                          onClick={() => selectResultEditTool('background')}
                          disabled={Boolean(selectedPendingRevision)}
                        >
                          <PenTool size={14} /> 擦除钢笔
                        </button>
                        <button
                          type="button"
                          aria-pressed={resultEditTool === 'boundary'}
                          className={resultEditTool === 'boundary' ? 'result-editor__tool result-editor__tool--active result-editor__tool--boundary' : 'result-editor__tool'}
                          onClick={() => selectResultEditTool('boundary')}
                          disabled={Boolean(selectedPendingRevision)}
                        >
                          <PenTool size={14} /> 边界钢笔
                        </button>
                      </div>
                    ) : null}
                    {resultEditing ? (
                      <div className={`result-editor__hint result-editor__hint--${resultEditTool}`}>
                        {resultEditTool === 'foreground'
                          ? '保留钢笔：闭合路径内的结果像素必须保留'
                          : resultEditTool === 'background'
                            ? '擦除钢笔：闭合路径内的区域将变为透明'
                            : '边界钢笔：用闭合路径精确重定义结果边缘'}
                      </div>
                    ) : null}
                    {resultEditing ? (
                      <div className="result-editor__operation-controls">
                        <div className="result-editor__path-roles" role="group" aria-label="选中路径角色">
                          <button
                            type="button"
                            aria-pressed={Boolean(selectedResultEditBoundary && resultEditOperation.subject_path_ids.includes(selectedResultEditBoundary.id))}
                            onClick={() => toggleSelectedResultEditPathRole('subject_path_ids', selectedResultEditBoundary)}
                            disabled={!selectedResultEditBoundary || Boolean(selectedPendingRevision)}
                          >
                            设为主体范围
                          </button>
                          <button
                            type="button"
                            aria-pressed={Boolean(selectedResultEditRepairBoundary && resultEditOperation.alpha_include_path_ids.includes(selectedResultEditRepairBoundary.id))}
                            onClick={() => toggleSelectedResultEditPathRole('alpha_include_path_ids', selectedResultEditRepairBoundary)}
                            disabled={!selectedResultEditRepairBoundary || Boolean(selectedPendingRevision)}
                          >
                            允许补入透明缺口
                          </button>
                        </div>
                        <div className="result-editor__modes" role="group" aria-label="修改范围">
                          <button
                            type="button"
                            aria-pressed={resultEditOperation.mode === 'path_scoped'}
                            onClick={() => selectResultEditMode('path_scoped')}
                            disabled={Boolean(selectedPendingRevision)}
                          >
                            局部精修（仅路径内）
                          </button>
                          <button
                            type="button"
                            aria-pressed={resultEditOperation.mode === 'keep_inside_delete_outside'}
                            onClick={() => selectResultEditMode('keep_inside_delete_outside')}
                            disabled={!resultEditOperation.subject_path_ids.length || Boolean(selectedPendingRevision)}
                          >
                            仅保留路径内，路径外透明
                          </button>
                          <button
                            type="button"
                            className="result-editor__mode--danger"
                            aria-pressed={resultEditOperation.mode === 'full_canvas_explicit'}
                            onClick={() => selectResultEditMode('full_canvas_explicit')}
                            disabled={Boolean(selectedPendingRevision)}
                          >
                            整图编辑（高风险）
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {!resultEditing && selectedResultHistory.length > 1 ? (
                      <ResultVersionGallery
                        history={selectedResultHistory}
                        nodeName={selected.name}
                      />
                    ) : (
                      <ResultPreview
                        image={latestSelectedResult.image}
                        sourceSize={latestSelectedResult.sourceSize}
                        bounds={latestSelectedResult.bounds}
                        canvasSize={resultEditGeometry?.canvas}
                        authoritativeCanvas={resultEditing}
                        expanded={resultEditing && resultPreviewExpanded}
                        previewRef={resultEditPreviewRef}
                        className={`result-preview--guided-result ${resultEditing ? `result-preview--result-editor result-preview--tool-${resultEditTool}` : ''} ${resultPreviewExpanded ? 'result-preview--result-editor-expanded' : ''}`}
                        aria-busy={resultEditing && !resultEditBaseReady}
                      >
                        {resultEditing ? (
                          <PenPathOverlay
                            ref={resultPenOverlayRef}
                            paths={resultEditPaths}
                            draft={resultEditDraft}
                            selection={resultEditSelection}
                            feedbackToken={resultEditFeedbackToken}
                            activeKind={resultEditTool}
                            disabled={Boolean(selectedPendingRevision) || !resultEditBaseReady}
                            onChange={updateResultPenEditor}
                            ariaLabel="拆分结果精修钢笔标注"
                          />
                        ) : null}
                      </ResultPreview>
                    )}
                    {resultEditing ? (
                      <div className="result-editor__preview-toolbar">
                        <span>{resultPreviewExpanded ? '大图编辑模式' : '需要更大画面时可放大编辑'}</span>
                        <button
                          type="button"
                          className="result-editor__preview-toggle"
                          aria-label={resultPreviewExpanded ? '还原 PNG 编辑预览' : '放大 PNG 编辑预览'}
                          aria-pressed={resultPreviewExpanded}
                          title={resultPreviewExpanded ? '还原预览' : '放大预览'}
                          onClick={() => setResultPreviewExpanded((current) => !current)}
                        >
                          {resultPreviewExpanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                        </button>
                      </div>
                    ) : null}
                    {resultEditing ? (
                      <div className="result-editor__request">
                        <label className="result-editor__prompt">
                          <span>修改目标</span>
                          <textarea
                            className="refinement-prompt__field"
                            value={resultEditPrompt}
                            onChange={(event) => dispatchResultEdit({ type: 'set-prompt', prompt: event.target.value })}
                            placeholder="例如：补全已标注的两个金币，保持原位置、大小、材质和光影"
                            rows="3"
                            readOnly={Boolean(selectedPendingRevision)}
                          />
                        </label>
                        <div className="result-editor__summary" aria-label="系统理解">
                          <strong>系统理解</strong>
                          <span>{refinementSummary(resultEditPolicy)}</span>
                          {resultEditPolicy.warnings.map((warning) => (
                            <small key={warning}>{warning}</small>
                          ))}
                        </div>
                        <div className="result-editor__actions">
                          <span>发送前会校验路径角色、修改范围与风险</span>
                          <div>
                            <button
                              type="button"
                              onClick={undoResultPenEdit}
                              disabled={!resultPenOverlayRef.current?.canUndo || Boolean(selectedPendingRevision)}
                            >
                              <Undo2 size={13} /> 撤销
                            </button>
                            <button
                              type="button"
                              onClick={redoResultPenEdit}
                              disabled={!resultPenOverlayRef.current?.canRedo || Boolean(selectedPendingRevision)}
                            >
                              <Redo2 size={13} /> 重做
                            </button>
                            <button
                              type="button"
                              onClick={deleteSelectedResultPenEdit}
                              disabled={!resultPenOverlayRef.current?.canDeleteSelection || Boolean(selectedPendingRevision)}
                            >
                              <Trash2 size={13} /> 删除选中
                            </button>
                            <button
                              type="button"
                              onClick={clearResultPenEdit}
                              disabled={(!resultEditPaths.length && !resultEditDraft) || Boolean(selectedPendingRevision)}
                            >
                              <Trash2 size={13} /> 清空路径
                            </button>
                            <button
                              type="button"
                              className="result-editor__submit"
                              onClick={submitResultEdit}
                              disabled={!resultEditBaseReady || !resultEditSubmission.ok || submittingResultEdit || Boolean(selectedPendingRevision)}
                            >
                              {submittingResultEdit ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
                              发送调整
                            </button>
                          </div>
                        </div>
                        {!resultEditBaseReady ? (
                          <small className="result-editor__validation result-editor__validation--blocking">
                            {resultEditBaseError || '正在读取当前 PNG 像素尺寸…'}
                          </small>
                        ) : !resultEditSubmission.ok ? (
                          <small className={`result-editor__validation ${resultEditDraft ? 'result-editor__validation--blocking' : ''}`}>
                            {resultEditSubmission.reason}
                          </small>
                        ) : null}
                        {selectedPendingRevision?.refinementSnapshot ? (
                          <div className="result-editor__submitted-snapshot" aria-label="已提交的二次编辑输入">
                            <strong>已提交输入</strong>
                            <span>{selectedPendingRevision.refinementSnapshot.prompt || '仅使用钢笔路径'}</span>
                            <small>{selectedPendingRevision.refinementSnapshot.summary || `${selectedPendingRevision.refinementSnapshot.paths.length} 条闭合路径`}</small>
                          </div>
                        ) : null}
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
                ) : activeSelectedJob && jobStatus(activeSelectedJob.status).tone === 'failed' ? (
                  <div className="guided-result-panel__failure">
                    <CircleX size={30} />
                    <strong>终态校验未通过</strong>
                    <small>{activeSelectedJob.statusDetail || '终态校验未通过，请调整遮挡标注后重试'}</small>
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
                  {resultEditing && resultEditGeometry
                    ? resultEditGeometry.canvas.width
                    : pixelBounds(latestSelectedResult?.bounds ?? selected.bounds, latestSelectedResult?.sourceSize ?? sourceSize).width}
                  {' x '}
                  {resultEditing && resultEditGeometry
                    ? resultEditGeometry.canvas.height
                    : pixelBounds(latestSelectedResult?.bounds ?? selected.bounds, latestSelectedResult?.sourceSize ?? sourceSize).height} px
                </span>
                <small>{resultEditing && resultEditGeometry
                  ? '精修坐标锁定为当前成功 PNG 的解码像素'
                  : latestSelectedResult
                    ? '输出尺寸锁定为提交拆分时的框选区域'
                    : '输出尺寸将在点击拆分时锁定'}</small>
              </footer>
            </section>
          </section>
          ) : (
            <section
              className={`guided-viewport guided-viewport--empty ${sourceDropActive ? 'guided-viewport--drop-active' : ''}`}
              onDragEnter={handleSourceDragEnter}
              onDragOver={handleSourceDragOver}
              onDragLeave={handleSourceDragLeave}
              onDrop={handleSourceDrop}
            >
              {hasSource ? (
                <div className={`guided-empty-state guided-analysis-state guided-analysis-state--${categoryAnalysisStage}`}>
                  <div className="guided-analysis-state__visual" aria-hidden="true">
                    {categoryAnalysisStage === 'cancelled' ? <X size={26} /> : categoryAnalysisStage === 'manual' ? <Layers3 size={28} /> : <WandSparkles size={28} />}
                  </div>
                  <small className="guided-analysis-state__eyebrow">自动分层类目分析</small>
                  <strong>
                    {categoryAnalysisStage === 'cancelled'
                      ? '自动识别已取消'
                      : categoryAnalysisStage === 'manual'
                        ? '从左侧选择分层类目'
                        : '正在识别可拆分的 UI 类目'}
                  </strong>
                  <span>
                    {categoryAnalysisStage === 'cancelled'
                      ? '你可以重新开始识别，或改用手动方式建立拆分项。'
                      : categoryAnalysisStage === 'manual'
                        ? '已添加一个 UI 组件项。选择左侧具体项后，右侧才会显示拆分设置。'
                        : '识别标题、视觉元素、背景、普通文字和 UI 组件；也可以随时转为手动添加。'}
                  </span>
                  {categoryAnalysisStage === 'active' ? <span className="guided-analysis-state__scan" aria-hidden="true" /> : null}
                  <div className="guided-analysis-state__actions">
                    {categoryAnalysisStage === 'active' ? (
                      <button
                        type="button"
                        className="guided-analysis-state__cancel"
                        onClick={cancelFastCategoryAnalysis}
                      >
                        <X size={15} /> 取消识别
                      </button>
                    ) : categoryAnalysisStage === 'cancelled' ? (
                      <button
                        type="button"
                        className="guided-analysis-state__cancel"
                        onClick={() => startFastCategoryAnalysis()}
                      >
                        <WandSparkles size={15} /> 重新识别
                      </button>
                    ) : null}
                    <button type="button" onClick={startManualLayering}>
                      <Plus size={16} /> 手动添加
                    </button>
                  </div>
                </div>
              ) : (
                <div className={`guided-empty-state guided-upload-state ${sourceDropActive ? 'guided-upload-state--drop-active' : ''}`}>
                  <ImagePlus size={28} />
                  <strong>选择图片用途后开始处理</strong>
                  <span>{sourceDropActive ? '松开鼠标即可载入图片' : '选择图片，或将图片拖到这里'}</span>
                  <PosterModePicker
                    value={pendingDocumentMode}
                    onChange={setPendingDocumentMode}
                    posterPlanningMode={pendingPosterPlanningMode}
                    onPosterPlanningModeChange={setPendingPosterPlanningMode}
                    disabled={sourceDropActive}
                    includePoster={posterLayeringModeEnabled}
                  />
                  <label className="guided-empty-state__upload" onClick={openSourceFilePicker}>
                    <Upload size={16} /> 选择图片
                  </label>
                </div>
              )}
            </section>
          )
        ) : (
          <section
            ref={canvasRef}
            className={`canvas-viewport ${!hasSource ? 'canvas-viewport--empty' : ''} ${sourceDropActive ? 'canvas-viewport--drop-active' : ''} ${spacePanReady ? 'canvas-viewport--pan-ready' : ''} ${canvasPanning ? 'canvas-viewport--panning' : ''}`}
            aria-label="无限画布，按住空格并拖动鼠标移动画布"
            onPointerDown={startPan}
            onWheel={handleWheel}
            onDoubleClick={openSourcePickerFromEmptyCanvas}
            onDragEnter={handleSourceDragEnter}
            onDragOver={handleSourceDragOver}
            onDragLeave={handleSourceDragLeave}
            onDrop={handleSourceDrop}
          >
            {!hasSource ? (
              <div className={`canvas-empty-node-picker ${sourceDropActive ? 'canvas-empty-node-picker--drop-active' : ''}`}>
                <div className="canvas-empty-node-picker__intro">
                  <ImagePlus size={22} />
                  <strong>{sourceDropActive ? '松开鼠标添加原图节点' : '添加第一个节点'}</strong>
                  <span>双击画布，拖入图片，或选择下方节点</span>
                </div>
                <button className="canvas-empty-node-picker__option" type="button" onClick={openSourceFilePicker}>
                  <span className="canvas-empty-node-picker__icon"><ImagePlus size={22} /></span>
                  <span className="canvas-empty-node-picker__option-copy">
                    <strong>原图节点</strong>
                    <small>上传 PNG、JPG 或 WebP</small>
                  </span>
                  <Plus size={17} />
                </button>
              </div>
            ) : null}
            <div className="canvas-bottom-controls" onPointerDown={(event) => event.stopPropagation()}>
              <IconButton
                className={`canvas-bottom-control canvas-asset-toggle ${panelVisibility.left ? 'canvas-asset-toggle--active' : ''}`}
                label={panelVisibility.left ? '关闭资产栏' : '打开资产栏'}
                aria-pressed={panelVisibility.left}
                onClick={() => setIsLeftOpen((current) => !current)}
              >
                <PanelLeft size={17} />
              </IconButton>
              <div className="canvas-zoom-cluster">
                <IconButton className="canvas-bottom-control" label="缩小画布" onClick={() => changeZoom(-0.1)}><ZoomOut size={17} /></IconButton>
                <label className="canvas-zoom-field canvas-bottom-control">
                  <input
                    ref={canvasZoomInputRef}
                    type="number"
                    min="22"
                    max="135"
                    step="1"
                    defaultValue={Math.round(viewport.scale * 100)}
                    aria-label="画布缩放百分比"
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={commitCanvasZoom}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                  />
                  <span>%</span>
                </label>
                <IconButton className="canvas-bottom-control" label="放大画布" onClick={() => changeZoom(0.1)}><ZoomIn size={17} /></IconButton>
              </div>
              <IconButton className="canvas-bottom-control" label="适配全部节点" onClick={fitCanvasOverview}><LocateFixed size={17} /></IconButton>
              <IconButton className="canvas-bottom-control" label="聚焦选中节点" onClick={focusCanvasSelection}><Focus size={17} /></IconButton>
            </div>
            <div className="canvas-command-controls" onPointerDown={(event) => event.stopPropagation()}>
              {alignmentMenuOpen ? (
                <div className="canvas-alignment-menu" role="menu" aria-label="节点对齐方式">
                  <button type="button" role="menuitem" onClick={() => alignCanvasSelection('left', '左对齐')}><AlignHorizontalJustifyStart size={16} /><span>左对齐</span></button>
                  <button type="button" role="menuitem" onClick={() => alignCanvasSelection('center', '中对齐')}><AlignHorizontalJustifyCenter size={16} /><span>中对齐</span></button>
                  <button type="button" role="menuitem" onClick={() => alignCanvasSelection('right', '右对齐')}><AlignHorizontalJustifyEnd size={16} /><span>右对齐</span></button>
                  <button type="button" role="menuitem" onClick={() => alignCanvasSelection('top', '上对齐')}><AlignVerticalJustifyStart size={16} /><span>上对齐</span></button>
                  <button type="button" role="menuitem" onClick={() => alignCanvasSelection('bottom', '下对齐')}><AlignVerticalJustifyEnd size={16} /><span>下对齐</span></button>
                </div>
              ) : null}
              <button className="canvas-command canvas-command--primary canvas-command--icon" type="button" aria-label="新增节点" data-tooltip="新增节点" onClick={(event) => openNodeInsertMenu(event)}>
                <Plus size={18} />
              </button>
              <button className="canvas-command canvas-command--icon" type="button" aria-label="按原图整理" data-tooltip="按原图整理" onClick={() => arrangeAllImageDocuments()}>
                <Move size={16} />
              </button>
              <span className="canvas-control-divider" />
              <button className="canvas-command canvas-command--icon" type="button" aria-label="全选节点" data-tooltip="全选节点" onClick={selectAllCanvasNodes}>
                <Square size={16} />
              </button>
              <button
                className={`canvas-command canvas-command--icon ${alignmentMenuOpen ? 'canvas-command--active' : ''}`}
                type="button"
                aria-label="对齐节点"
                data-tooltip={canvasSelectedKeys.length < 2 ? '请先选择至少两个节点' : '对齐节点'}
                aria-expanded={alignmentMenuOpen}
                disabled={canvasSelectedKeys.length < 2}
                onClick={() => setAlignmentMenuOpen((current) => !current)}
              >
                <WandSparkles size={16} />
              </button>
              <button className="canvas-command canvas-command--icon" type="button" aria-label="编组节点" data-tooltip="编组节点" onClick={groupCanvasSelection} disabled={canvasSelectedKeys.length < 2}>
                <Layers3 size={16} />
              </button>
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
                {inactiveCanvasNodes.map((item) => {
                  const sourceItem = canvasItemMap.get(imageSourceNodeKey(item.imageId));
                  const route = routeMeta[categoryMeta[item.node.category].route];
                  const targetItem = canvasItemMap.get(item.key);
                  if (!sourceItem || !targetItem) return null;
                  return (
                    <path
                      key={item.key}
                      d={connectionPath(
                        sourceItem.x + sourceItem.width,
                        sourceItem.y + sourceItem.portY,
                        targetItem.x,
                        targetItem.y + targetItem.portY,
                      )}
                      className={`flow-link flow-link--${route.color} ${canvasSelectedKeys.includes(sourceItem.key) || canvasSelectedKeys.includes(item.key) ? 'flow-link--active' : ''}`}
                    />
                  );
                })}
                {inactiveResultNodes.map(({ id, imageId, node, job }) => {
                  const sourceItem = canvasItemMap.get(imageSplitNodeKey(imageId, node.id));
                  const key = resultNodeKey(id);
                  const targetItem = canvasItemMap.get(key);
                  if (!sourceItem || !targetItem) return null;
                  return (
                    <path
                      key={key}
                      d={connectionPath(
                        sourceItem.x + sourceItem.width,
                        sourceItem.y + sourceItem.portY,
                        targetItem.x,
                        targetItem.y + targetItem.portY,
                      )}
                      className={`flow-link flow-link--result ${canvasSelectedKeys.includes(imageSplitNodeKey(imageId, node.id)) || canvasSelectedKeys.includes(key) ? 'flow-link--active' : ''}`}
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

              {inactiveImageDocuments.map((document, index) => {
                const key = imageSourceNodeKey(document.imageId);
                const item = canvasItemMap.get(key);
                if (!item) return null;
                const previewHeight = item.height - 32;
                return (
                  <article
                    key={key}
                    className={`source-node source-node--inactive ${canvasSelectedKeys.includes(key) ? 'source-node--selected' : ''}`}
                    style={{ left: item.x, top: item.y, width: item.width }}
                    role="button"
                    tabIndex={0}
                    aria-label={`打开 ${document.sourceName || `图片 ${index + 1}`}`}
                    aria-pressed={canvasSelectedKeys.includes(key)}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setCanvasSelectedKeys([key]);
                    }}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      activateImageDocument(document.imageId);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        activateImageDocument(document.imageId);
                      }
                    }}
                  >
                    <div className="canvas-node-meta">
                      <span><ImagePlus size={14} /><strong>{document.sourceName || `图片 ${index + 1}`}</strong></span>
                      <small>{document.sourceSize.width} x {document.sourceSize.height}</small>
                    </div>
                    <div className="canvas-node-frame">
                      <div className="source-node__image" style={{ height: previewHeight }}>
                        <img src={document.sourceDataUrl || document.sourceImage} alt={document.sourceName || '原图'} draggable="false" />
                      </div>
                    </div>
                  </article>
                );
              })}

              {inactiveCanvasNodes.map((item) => {
                const document = imageDocuments.find((entry) => entry.imageId === item.imageId);
                if (!document) return null;
                const node = item.node;
                const route = routeMeta[categoryMeta[node.category].route];
                const RouteIcon = route.icon;
                const region = pixelBounds(node.bounds, document.sourceSize);
                return (
                  <article
                    key={item.key}
                    className={`canvas-node canvas-node--${route.color} canvas-node--inactive ${canvasSelectedKeys.includes(item.key) ? 'canvas-node--selected' : ''}`}
                    style={{ left: item.x, top: item.y, width: item.width }}
                    role="button"
                    tabIndex={0}
                    aria-label={`选择 ${node.name}（${document.sourceName || '其他原图'}）`}
                    aria-pressed={canvasSelectedKeys.includes(item.key)}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setCanvasSelectedKeys([item.key]);
                    }}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      activateImageDocument(item.imageId);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        activateImageDocument(item.imageId);
                      }
                    }}
                  >
                    <div className="canvas-node-meta">
                      <span><RouteIcon size={14} /><strong>{node.name}</strong></span>
                      <small>{region.width} x {region.height}</small>
                    </div>
                    <div className="canvas-node-frame">
                      <div className="canvas-node__media" style={{ height: item.preview.height }}>
                        <RegionPreview sourceImage={document.sourceDataUrl || document.sourceImage} sourceSize={document.sourceSize} bounds={node.bounds} className="region-preview--node" />
                      </div>
                    </div>
                  </article>
                );
              })}

              {inactiveResultNodes.map((resultNode) => {
                const document = imageDocuments.find((entry) => entry.imageId === resultNode.imageId);
                if (!document) return null;
                const {
                  job,
                  node,
                  image,
                  pendingRevision,
                  failedRevision,
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
                    className={`result-node result-node--${meta.tone} result-node--inactive ${canvasSelectedKeys.includes(key) ? 'result-node--selected' : ''}`}
                    style={{ left: x, top: y, width: previewWidth }}
                    role="button"
                    tabIndex={0}
                    aria-label={`选择 ${node.name} 的历史拆分结果`}
                    aria-pressed={canvasSelectedKeys.includes(key)}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setCanvasSelectedKeys([key]);
                    }}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      activateImageDocument(resultNode.imageId);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        activateImageDocument(resultNode.imageId);
                      }
                    }}
                  >
                    <div className="canvas-node-meta">
                      <span>{pendingRevision ? <LoaderCircle size={14} className="spin" /> : <ImagePlus size={14} />}<strong>{node.name} - 拆分结果</strong></span>
                      <small>{region.width} x {region.height}</small>
                    </div>
                    <div className="canvas-node-frame">
                      {image ? (
                        <a
                          className="result-node__image"
                          style={{ height: previewHeight }}
                          href={resolveWorkbenchUrl(image.url)}
                          download={image.name || `${node.id}.png`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <ResultPreview image={image} sourceSize={resultSourceSize} bounds={bounds} />
                        </a>
                      ) : (
                        <div className="result-node__pending">
                          <LoaderCircle size={22} className="spin" />
                          <span>等待输出 PNG</span>
                        </div>
                      )}
                      {failedRevision ? <small>{failedRevision.statusDetail || '最近一次精修失败，已保留上一版 PNG'}</small> : null}
                    </div>
                  </article>
                );
              })}

              {hasSource ? <article
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
              </article> : null}

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
                          {nodeResultStates.get(node.id)?.pendingRevision ? (
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
                  pendingRevision,
                  failedRevision,
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
                      <span>{pendingRevision ? <LoaderCircle size={14} className="spin" /> : <ImagePlus size={14} />}<strong>{node.name} - 拆分结果</strong></span>
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
                        <>
                          <a
                            className="result-node__download"
                            href={resolveWorkbenchUrl(image.url)}
                            download={image.name || `${node.id}.png`}
                            aria-label={`下载结果 ${node.name}`}
                            data-tooltip="下载 PNG"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Download size={17} />
                          </a>
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
                        </>
                      ) : (
                        <div className="result-node__pending">
                          <LoaderCircle size={22} className="spin" />
                          <span>等待输出 PNG</span>
                        </div>
                      )}
                      {failedRevision ? <small>{failedRevision.statusDetail || '最近一次精修失败，已保留上一版 PNG'}</small> : null}
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
                  <button
                    type="button"
                    className="node-type-menu__close"
                    aria-label="关闭节点类型菜单"
                    onClick={() => setNodeInsertMenu(null)}
                  >
                    <X size={14} />
                  </button>
                  <span className="node-type-menu__section-label">源节点</span>
                  <button
                    type="button"
                    role="menuitem"
                    className="node-type-menu__source"
                    aria-label={hasSource ? '上传另一张原图' : '原图节点'}
                    onClick={() => addCanvasNode('source')}
                  >
                    <ImagePlus size={17} />
                    <strong>{hasSource ? '上传另一张原图' : '原图节点'}</strong>
                  </button>
                  {hasSource ? (
                    <>
                      <span className="node-type-menu__section-label">拆分节点</span>
                      {categoryOrder.map((category) => {
                        const meta = categoryMeta[category];
                        const CategoryIcon = meta.icon;
                        return (
                          <button
                            key={category}
                            type="button"
                            role="menuitem"
                            className="node-type-menu__category"
                            onClick={() => addCanvasNode('split', category)}
                          >
                            <CategoryIcon size={17} />
                            <strong>{meta.label}</strong>
                          </button>
                        );
                      })}
                      <span className="node-type-menu__section-label">结果节点</span>
                      <button type="button" role="menuitem" className="node-type-menu__result" onClick={() => addCanvasNode('result')}>
                        <ImagePlus size={17} />
                        <strong>拆分结果节点</strong>
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        )}

        <aside className={`sidebar sidebar--right ${!panelVisibility.right ? 'sidebar--collapsed' : ''}`}>
          <div className="panel-title-row">
            <div>
              <span className="eyebrow">{reviewMode === 'canvas' ? '当前节点' : '当前拆分项'}</span>
              <h2>
                {reviewMode === 'canvas'
                  ? singleSelectedCanvasItem?.kind === 'source'
                    ? '原图'
                    : singleSelectedCanvasItem?.kind === 'result'
                      ? `${selected.name} · 拆分结果`
                      : singleSelectedCanvasItem?.kind === 'manual-result'
                        ? '拆分结果节点'
                        : hasSelectedLayer ? selected.name : '未选择节点'
                  : hasSelectedLayer ? selected.name : '未选择图层'}
              </h2>
            </div>
          </div>
          {reviewMode === 'canvas' ? renderCanvasSummary() : renderRequestPanel()}
        </aside>
          </>
        )}
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
              <div className="result-lightbox__actions">
                <a
                  className="icon-button result-lightbox__download"
                  href={resolveWorkbenchUrl(resultViewer.image.url)}
                  download={pngDownloadName(resultViewer.image.name, resultViewer.node.id)}
                  aria-label="下载 PNG"
                  data-tooltip="下载 PNG"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Download size={18} />
                </a>
                <IconButton label="关闭预览" onClick={() => setResultViewer(null)}>
                  <X size={18} />
                </IconButton>
              </div>
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

      {toast ? <div className={`toast ${reviewMode === 'canvas' ? 'toast--canvas' : ''}`}><Check size={16} /> {toast}</div> : null}
    </main>
  );
}

const container = document.getElementById('root');
const root = window.__layerReviewRoot ?? createRoot(container);
window.__layerReviewRoot = root;
const params = new URLSearchParams(window.location.search);
if (params.get('workbench') === 'v2') {
  import('./v2/WorkbenchV2.jsx').then(({ WorkbenchV2 }) => root.render(<WorkbenchV2 />));
} else root.render(<App />);
