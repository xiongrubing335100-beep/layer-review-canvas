import { useEffect, useRef, useState } from 'react';
import {
  Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Download, Eraser, Hand, RefreshCw,
  Maximize2, Minimize2, Move, PenTool, Plus, Scissors, Send, Trash2, WandSparkles,
} from 'lucide-react';
import { PosterFastCandidateResult } from './PosterFastCandidateResult.jsx';
import {
  posterFastContainedImageRect,
  posterFastCropPreviewGeometry,
  createPosterFastInspectorDraft,
  posterFastPointerPercent,
  posterFastInspectorCommitPatch,
  posterFastExecutionView,
  posterFastPngReturnState,
  posterFastRecoveryAction,
  posterFastWorkbenchContract,
  posterFastWorkbenchState,
  defaultPosterFastPrompt,
  posterFastPromptIssue,
  reducePosterFastInspectorDraft,
} from './poster-fast-workbench-model.js';

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value));
}

function percentBounds(bounds, sourceSize) {
  const x = clamp(Number(bounds?.x) || 0, 0, 100);
  const y = clamp(Number(bounds?.y) || 0, 0, 100);
  const width = clamp(Number(bounds?.width) || 0, 0, 100 - x);
  const height = clamp(Number(bounds?.height) || 0, 0, 100 - y);
  return {
    percentage: { x, y, width, height },
    source_pixels: {
      x: Math.round((x / 100) * sourceSize.width),
      y: Math.round((y / 100) * sourceSize.height),
      width: Math.round((width / 100) * sourceSize.width),
      height: Math.round((height / 100) * sourceSize.height),
    },
  };
}

function SelectionCanvas({ layer, bounds, sourceUrl, sourceSize, disabled, onUpdateLayer, renderPenOverlay }) {
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const [localBounds, setLocalBounds] = useState(bounds);
  const [containedRect, setContainedRect] = useState(null);
  useEffect(() => {
    setLocalBounds(bounds);
  }, [bounds.height, bounds.width, bounds.x, bounds.y, layer.layer_index]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const updateContainedRect = () => {
      const rect = canvas.getBoundingClientRect();
      setContainedRect(posterFastContainedImageRect({ width: rect.width, height: rect.height }, sourceSize));
    };
    updateContainedRect();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateContainedRect);
      return () => window.removeEventListener('resize', updateContainedRect);
    }
    const observer = new ResizeObserver(updateContainedRect);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [sourceSize.height, sourceSize.width]);
  const commit = (nextBounds) => onUpdateLayer?.(layer.layer_index, {
    bounds: percentBounds(nextBounds, sourceSize),
  });
  const point = (event, clampToImage = false) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect?.height) return null;
    const imageRect = posterFastContainedImageRect({ width: rect.width, height: rect.height }, sourceSize);
    if (!imageRect) return null;
    const rawPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const imagePoint = clampToImage ? {
      x: clamp(rawPoint.x, imageRect.left, imageRect.left + imageRect.width),
      y: clamp(rawPoint.y, imageRect.top, imageRect.top + imageRect.height),
    } : rawPoint;
    return posterFastPointerPercent(imagePoint, imageRect);
  };
  const start = (event, action) => {
    if (disabled) return;
    const startPoint = point(event); if (!startPoint) return;
    dragRef.current = { action, startPoint, bounds: localBounds, nextBounds: localBounds, captureTarget: event.currentTarget };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event) => {
    const drag = dragRef.current; const current = point(event, true);
    if (!drag || !current) return;
    const dx = current.x - drag.startPoint.x; const dy = current.y - drag.startPoint.y;
    let next = { ...drag.bounds };
    if (drag.action === 'move') {
      next.x = clamp(drag.bounds.x + dx, 0, 100 - drag.bounds.width);
      next.y = clamp(drag.bounds.y + dy, 0, 100 - drag.bounds.height);
    } else if (drag.action === 'se') {
      next.width = clamp(drag.bounds.width + dx, 1, 100 - drag.bounds.x);
      next.height = clamp(drag.bounds.height + dy, 1, 100 - drag.bounds.y);
    } else if (drag.action === 'nw') {
      next.x = clamp(drag.bounds.x + dx, 0, drag.bounds.x + drag.bounds.width - 1);
      next.y = clamp(drag.bounds.y + dy, 0, drag.bounds.y + drag.bounds.height - 1);
      next.width = drag.bounds.width - (next.x - drag.bounds.x);
      next.height = drag.bounds.height - (next.y - drag.bounds.y);
    } else if (drag.action === 'ne') {
      next.y = clamp(drag.bounds.y + dy, 0, drag.bounds.y + drag.bounds.height - 1);
      next.width = clamp(drag.bounds.width + dx, 1, 100 - drag.bounds.x);
      next.height = drag.bounds.height - (next.y - drag.bounds.y);
    } else if (drag.action === 'sw') {
      next.x = clamp(drag.bounds.x + dx, 0, drag.bounds.x + drag.bounds.width - 1);
      next.width = drag.bounds.width - (next.x - drag.bounds.x);
      next.height = clamp(drag.bounds.height + dy, 1, 100 - drag.bounds.y);
    }
    drag.nextBounds = next;
    setLocalBounds(next);
  };
  const end = (event, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    drag.captureTarget.releasePointerCapture?.(event.pointerId);
    const changed = ['x', 'y', 'width', 'height'].some((key) => Math.abs(drag.nextBounds[key] - drag.bounds[key]) > 0.01);
    if (!cancelled && changed) commit(drag.nextBounds);
  };
  const frameStyle = containedRect ? {
    left: `${containedRect.left + (localBounds.x / 100) * containedRect.width}px`,
    top: `${containedRect.top + (localBounds.y / 100) * containedRect.height}px`,
    width: `${(localBounds.width / 100) * containedRect.width}px`,
    height: `${(localBounds.height / 100) * containedRect.height}px`,
  } : { left: `${localBounds.x}%`, top: `${localBounds.y}%`, width: `${localBounds.width}%`, height: `${localBounds.height}%` };
  return <div
    className="guided-source-image poster-fast-workbench__selection-canvas"
    style={{ aspectRatio: `${sourceSize.width} / ${sourceSize.height}` }}
    ref={canvasRef}
    onPointerMove={move}
    onPointerUp={end}
    onPointerCancel={(event) => end(event, true)}
  >
    {sourceUrl ? <img src={sourceUrl} alt="当前项目框选参考图" draggable="false" /> : <div>原图暂不可用</div>}
    <div
      className="poster-fast-workbench__selection-frame"
      style={frameStyle}
      onPointerDown={(event) => start(event, 'move')}
      aria-label="可拖动的当前项目框选"
    >{['nw', 'ne', 'sw', 'se'].map((corner) => <button
      key={corner}
      type="button"
      className={`selection-handle selection-handle--${corner} poster-fast-workbench__selection-handle`}
      aria-label={`从${corner.toUpperCase()}角缩放当前项目框选`}
      onPointerDown={(event) => { event.stopPropagation(); start(event, corner); }}
    />)}</div>
    {renderPenOverlay?.(layer)}
  </div>;
}

function CropPreview({ sourceUrl, bounds, sourceSize, expanded = false }) {
  const expandedPreviewHeight = typeof window === 'undefined' ? 720 : Math.max(160, window.innerHeight - 214);
  const geometry = posterFastCropPreviewGeometry(bounds, sourceSize, { expandedPreviewHeight });
  const style = {
    aspectRatio: geometry.aspectRatioCss,
    maxWidth: `min(100%, ${expanded ? geometry.expandedMaxWidth : geometry.maxWidth})`,
    '--region-preview-aspect': geometry.aspectRatio,
    '--region-preview-expanded-max-width': geometry.expandedMaxWidth,
  };
  return <div className={`region-preview region-preview--guided poster-fast-workbench__crop-preview ${expanded ? 'region-preview--expanded' : ''}`} style={style}>
    {sourceUrl ? <img src={sourceUrl} alt="当前框选预览" draggable="false" style={geometry.imageStyle} /> : <span>当前框选暂不可用</span>}
  </div>;
}

const QUICK_REQUIREMENTS = Object.freeze([
  '保留原图可见像素', '保持原字体和材质', '去字后补全底板', '补全被遮挡区域', '保持框选尺寸和位置',
]);

export function PosterFastWorkbench({
  sourceUrl, sourceName = '原始画布', sourceSize = { width: 0, height: 0 }, plan, selectedLayerIndex,
  onDeleteSource, onSelectLayer, onAddLayer, onDeleteLayer, onUpdateLayer, onOpenPen, onSplit, onAccept, onRetry,
  renderPenOverlay, candidate = null, busy = false, clockNow = Date.now(), taskControl = null, onTaskControl,
  downloadUrl = null,
}) {
  const contract = posterFastWorkbenchContract({ layers: plan.layers, selectedLayerIndex });
  const selectedCandidate = candidate;
  const executionView = selectedCandidate?.execution ? posterFastExecutionView(selectedCandidate.execution, clockNow) : null;
  const model = posterFastWorkbenchState({ plan, selectedLayerIndex, busy, sourceUrl, candidate: selectedCandidate });
  const selected = model.selection.layer;
  const candidateReturn = posterFastPngReturnState(selectedCandidate || { status: selected?.status || selected?.state });
  const candidateRecovery = posterFastRecoveryAction(selectedCandidate || {});
  const [inspectorDraft, setInspectorDraft] = useState(() => createPosterFastInspectorDraft(selected));
  useEffect(() => {
    setInspectorDraft((current) => reducePosterFastInspectorDraft(current, { type: 'replace-layer', layer: selected }));
  }, [selected?.layer_index, selected?.layer_name, selected?.prompt, selected?.requirement]);
  const promptIssue = selected ? posterFastPromptIssue(selected.processing_category, inspectorDraft.prompt) : null;
  const update = (patch) => selected && onUpdateLayer?.(selected.layer_index, patch);
  const commitInspectorField = (field) => {
    const patch = posterFastInspectorCommitPatch(inspectorDraft, field);
    if (patch) update(patch);
  };
  const [boundaryOpen, setBoundaryOpen] = useState(true);
  const [penTool, setPenTool] = useState('foreground');
  const [cropPreviewExpanded, setCropPreviewExpanded] = useState(false);
  useEffect(() => {
    if (!cropPreviewExpanded) return undefined;
    const collapseOnEscape = (event) => {
      if (event.key === 'Escape') setCropPreviewExpanded(false);
    };
    window.addEventListener('keydown', collapseOnEscape);
    return () => window.removeEventListener('keydown', collapseOnEscape);
  }, [cropPreviewExpanded]);
  const acceptedCount = (plan.layers || []).filter((layer) => layer.status === 'ACCEPTED' || layer.state === 'ACCEPTED').length;
  const layerCount = plan.layers?.length || 0;
  const selectedIndex = Math.max(0, (plan.layers || []).findIndex((layer) => layer.layer_index === selected?.layer_index));
  const canGoPrevious = selectedIndex > 0;
  const canGoNext = selectedIndex >= 0 && selectedIndex < layerCount - 1;
  const goToIndex = (index) => {
    const next = plan.layers?.[index];
    if (next) onSelectLayer?.(next.layer_index);
  };
  const appendRequirement = (value) => {
    const current = inspectorDraft.prompt.trim();
    setInspectorDraft((draft) => reducePosterFastInspectorDraft(draft, {
      type: 'prompt-input', value: current ? `${current}；${value}` : value,
    }));
  };
  const choosePenTool = (tool) => {
    const next = penTool === tool && boundaryOpen ? null : tool;
    setPenTool(next || 'foreground');
    setBoundaryOpen(Boolean(next));
    onOpenPen?.(selected?.layer_index, next);
  };
  const confirmAndNext = () => {
    if (!selected) return;
    update({ user_confirmed: true });
    if (canGoNext) goToIndex(selectedIndex + 1);
  };
  const selectionStatus = selected?.user_confirmed ? '框选已确认' : '框选未确认';

  return (
    <section className="poster-fast-workbench" aria-label="海报快速分层工作台">
      <aside className="sidebar sidebar--left poster-fast-workbench__projects" aria-label="类别与具体拆分项目">
        <div className="panel-title-row"><span className="eyebrow">拆分栏目</span></div>
        <div className="source-meta poster-fast-workbench__source-meta">
          <div className="source-meta__thumbnail">{sourceUrl ? <img src={sourceUrl} alt="当前原图" /> : null}</div>
          <div className="source-meta__copy"><strong>{sourceName || '原始画布'}</strong><span>{sourceSize.width} × {sourceSize.height} RGBA</span></div>
          <button type="button" className="icon-button source-meta__delete" aria-label="删除原始画布" data-tooltip="删除原始画布" onClick={() => onDeleteSource?.()}>
            <Trash2 size={16} />
          </button>
        </div>
        <div className="review-progress"><span style={{ width: `${layerCount ? (acceptedCount / layerCount) * 100 : 0}%` }} /></div>
        <div className="review-progress__copy"><span>{acceptedCount} 个已确认</span><strong>{layerCount - acceptedCount} 个待处理</strong></div>
        <div className="layer-groups poster-fast-workbench__groups">
        {model.groups.map((group) => <section key={group.category} className="layer-group poster-fast-workbench__group">
          <header className="layer-group__heading"><span>{group.label}</span><small>{group.items.length} 个项目</small>
            <div className="layer-group__actions poster-fast-workbench__group-actions">
              <button
                type="button"
                className="delete-layer-button poster-fast-workbench__delete"
                aria-label={`删除当前选中的${group.label}项目`}
                data-tooltip={selected?.processing_category === group.category ? `删除 ${selected.layer_name || '当前项目'}` : `先选择一个${group.label}项目`}
                onClick={() => selected && onDeleteLayer?.(selected.layer_index)}
                disabled={busy || plan.layers.length <= 1 || selected?.processing_category !== group.category}
              ><Trash2 size={13} /></button>
              <button type="button" className="add-layer-button add-layer-button--icon" aria-label={`添加${group.label}项目`} data-tooltip={`添加${group.label}项目`} onClick={() => onAddLayer?.(group.category)} disabled={busy}><Plus size={14} /></button>
            </div></header>
          <div className="layer-list">{group.items.map((item) => <button
            key={item.layer_index}
            type="button"
            className={`layer-row poster-fast-workbench__project ${item.layer_index === selected?.layer_index ? 'layer-row--selected poster-fast-workbench__project--selected' : ''}`}
            aria-current={item.layer_index === selected?.layer_index ? 'true' : undefined}
            onClick={() => onSelectLayer?.(item.layer_index)}
          ><span className="layer-row__copy"><strong>{item.layer_name || '未命名项目'}</strong><small>{group.label} · {item.state || item.status || '待检查'}</small></span></button>)}</div>
        </section>)}
        </div>
      </aside>

      <main className="guided-viewport poster-fast-workbench__center">
        <header className="guided-header poster-fast-workbench__workspace-header">
          <div><span>第 {selectedIndex + 1} / {layerCount} 项</span><h2>{selected?.layer_name || '选择一个项目'}</h2></div>
          <div className="guided-header__nav">
            <button type="button" className="icon-button" aria-label="上一个拆分项" onClick={() => goToIndex(selectedIndex - 1)} disabled={!canGoPrevious}><ChevronLeft size={17} /></button>
            <button type="button" className="icon-button" aria-label="下一个拆分项" onClick={() => goToIndex(selectedIndex + 1)} disabled={!canGoNext}><ChevronRight size={17} /></button>
          </div>
        </header>
        <div className="guided-preview-layout poster-fast-workbench__preview-layout">
          <div className="source-position-panel" aria-label={contract.centerPanels[0]}>
            <div className="preview-label"><span>原图位置</span><small><Move size={12} /> {model.selection.bounds.x.toFixed(1)}%, {model.selection.bounds.y.toFixed(1)}%</small></div>
            {selected ? <SelectionCanvas layer={selected} bounds={model.selection.bounds} sourceUrl={sourceUrl} sourceSize={sourceSize} disabled={busy} onUpdateLayer={onUpdateLayer} renderPenOverlay={renderPenOverlay} /> : <div className="poster-fast-workbench__empty">选择左侧的具体拆分项目</div>}
          </div>
          <div className={`candidate-preview-panel ${cropPreviewExpanded ? 'candidate-preview-panel--expanded' : ''}`} aria-label={contract.centerPanels[1]}>
            <div className="preview-label"><span>当前框选</span><small className="status-pill">{selectionStatus}</small></div>
            {selected ? <CropPreview sourceUrl={sourceUrl} bounds={model.selection.bounds} sourceSize={sourceSize} expanded={cropPreviewExpanded} /> : <div className="poster-fast-workbench__empty">选择左侧的具体拆分项目</div>}
            <div className="candidate-preview-toolbar poster-fast-workbench__crop-toolbar">
              <span>{selected ? `${Math.round(model.selection.bounds.width)}% × ${Math.round(model.selection.bounds.height)}%` : ''}</span>
              <button
                type="button"
                className="candidate-preview-toggle"
                onClick={() => setCropPreviewExpanded((current) => !current)}
                disabled={!selected}
                aria-label={cropPreviewExpanded ? '缩小当前框选预览' : '放大当前框选预览'}
                aria-pressed={cropPreviewExpanded}
                title={cropPreviewExpanded ? '缩小预览' : '放大预览'}
              >{cropPreviewExpanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
            </div>
          </div>
        </div>
        <section className="guided-result-panel poster-fast-workbench__result-panel" aria-label={contract.centerPanels[2]}>
          <header className="guided-result-panel__header"><div><span>Codex 拆分结果</span>{executionView ? <small>{executionView.stageLabel} · {executionView.elapsedLabel}</small> : null}</div><div className="guided-result-panel__actions">
            {downloadUrl ? <a className="poster-fast-workbench__result-action" href={downloadUrl} download aria-label="下载 PNG"><Download size={15} /> 下载 PNG</a> : null}
            {candidateReturn.kind === 'review-ready' ? <>
              <button type="button" className="poster-fast-workbench__result-action poster-fast-workbench__result-action--accept" onClick={() => selected && onAccept?.(selected.layer_index)} disabled={busy} aria-label="接受候选"><Check size={15} /> 接受候选</button>
              <button type="button" className="poster-fast-workbench__result-action" onClick={() => selected && onRetry?.(selected.layer_index, candidateRecovery.kind)} disabled={busy} aria-label="重新生成此项目"><RefreshCw size={15} /> 重新生成此项目</button>
            </> : null}
            {taskControl?.action && taskControl.action !== 'none' ? <button type="button" className="poster-fast-workbench__result-action poster-fast-workbench__result-action--danger" onClick={() => onTaskControl?.()} disabled={busy}>{taskControl.action === 'cancel' ? '取消任务' : '放弃任务'}</button> : null}
          </div></header>
          <div className="guided-result-panel__body poster-fast-workbench__result-body"><PosterFastCandidateResult candidate={selectedCandidate || { status: selected?.status || selected?.state }} layer={selected || {}} executionView={executionView} onAccept={() => selected && onAccept?.(selected.layer_index)} onRetry={(kind) => selected && onRetry?.(selected.layer_index, kind)} busy={busy} /></div>
          <footer className="guided-result-panel__footer"><span>{sourceSize.width} × {sourceSize.height} px</span><small>完整画布坐标锁定</small></footer>
        </section>
      </main>

      <aside className="sidebar sidebar--right poster-fast-workbench__inspector" aria-label="当前拆分项目操作">
        <div className="panel-title-row"><div><span className="eyebrow">当前项目设置</span><h2>{selected?.layer_name || '未选择项目'}</h2></div></div>
        <section className="inspector-section inspector-section--identity">
          <div className="request-category"><span><CheckCircle2 size={17} />{model.inspector?.category || '项目'}</span><span className="status-pill">{selected?.state || selected?.status || '待确认'}</span></div>
          <label className="field-label" htmlFor="poster-fast-layer-name">图层名称</label>
          <div className="name-field-row">
            <input id="poster-fast-layer-name" className="text-field" value={inspectorDraft.name} onChange={(event) => setInspectorDraft((current) => reducePosterFastInspectorDraft(current, { type: 'name-input', value: event.target.value }))} onBlur={() => commitInspectorField('name')} disabled={!selected} />
            <button type="button" className="icon-button icon-button--danger" aria-label="删除当前拆分项" onClick={() => selected && onDeleteLayer?.(selected.layer_index)} disabled={!selected || busy || layerCount <= 1}><Trash2 size={16} /></button>
          </div>
        </section>
        <section className="inspector-section">
          <label className="field-label" htmlFor="poster-fast-requirement">具体拆分需求</label>
          <textarea id="poster-fast-requirement" className={`requirement-field${promptIssue ? ' requirement-field--invalid' : ''}`} rows="5" value={inspectorDraft.prompt} placeholder={selected ? defaultPosterFastPrompt(selected.processing_category) : ''} aria-invalid={promptIssue ? 'true' : 'false'} onChange={(event) => setInspectorDraft((current) => reducePosterFastInspectorDraft(current, { type: 'prompt-input', value: event.target.value }))} onBlur={() => commitInspectorField('prompt')} disabled={!selected} />
          <p className={`poster-fast-workbench__prompt-hint ${promptIssue ? 'poster-fast-workbench__prompt-hint--error' : ''}`} role={promptIssue ? 'alert' : undefined}>{promptIssue?.message || (selected ? `默认提示词：${defaultPosterFastPrompt(selected.processing_category)}` : '')}</p>
          <div className="requirement-shortcuts" aria-label="常用拆分要求">{QUICK_REQUIREMENTS.map((item) => <button type="button" key={item} onClick={() => appendRequirement(item)}><Plus size={13} />{item}</button>)}</div>
        </section>
        <section className="inspector-section inspector-section--output">
          <div className="execution-mode-field">
            <div className="execution-mode-field__heading"><span>拆分模式</span><small>仅作用于当前拆分项</small></div>
            <div className="execution-mode-options" role="radiogroup" aria-label="拆分模式">
              <button type="button" role="radio" aria-checked="true" className="execution-mode-option execution-mode-option--active"><strong>快速</strong><small>原图提取优先，必要时单次补全</small></button>
              <button type="button" role="radio" aria-checked="false" className="execution-mode-option" disabled title="高质量模式将在后续入口接入"><strong>高质量</strong><small>完整补全、边缘复检</small></button>
            </div>
          </div>
          <label className={`processing-option ${model.inspector?.removeBackground ? 'processing-option--active' : ''}`}>
            <input type="checkbox" checked={model.inspector?.removeBackground || false} onChange={(event) => update({ remove_background: event.target.checked })} disabled={!selected || busy} />
            <span className="processing-option__icon"><Eraser size={17} /></span>
            <span className="processing-option__copy"><strong>去除背景</strong><small>默认开启；输出真实透明 RGBA PNG</small></span>
            <span className="processing-option__switch" aria-hidden="true" />
          </label>
        </section>
        <section className="inspector-section inspector-section--boundary">
          <div className="boundary-section">
            <button type="button" className="boundary-toggle" onClick={() => { const next = !boundaryOpen; setBoundaryOpen(next); onOpenPen?.(selected?.layer_index, next ? penTool : null); }} aria-expanded={boundaryOpen}>
              <CheckCircle2 size={18} /><span><strong>边界精修</strong><small>在原图位置中精确编辑</small></span><ChevronDown size={16} className={boundaryOpen ? 'chevron-open' : ''} />
            </button>
            {boundaryOpen ? <div className="boundary-tools">
              <div className="boundary-tool-grid">
                <button type="button" aria-pressed={penTool === 'foreground'} className={penTool === 'foreground' ? 'boundary-tool boundary-tool--active boundary-tool--foreground' : 'boundary-tool'} onClick={() => choosePenTool('foreground')}><PenTool size={16} /> 保留钢笔</button>
                <button type="button" aria-pressed={penTool === 'background'} className={penTool === 'background' ? 'boundary-tool boundary-tool--active boundary-tool--background' : 'boundary-tool'} onClick={() => choosePenTool('background')}><PenTool size={16} /> 排除钢笔</button>
                <button type="button" aria-pressed={penTool === 'boundary'} className={penTool === 'boundary' ? 'boundary-tool boundary-tool--active boundary-tool--boundary' : 'boundary-tool'} onClick={() => choosePenTool('boundary')}><PenTool size={16} /> 边界钢笔</button>
                <button type="button" aria-pressed={penTool === 'repair'} className={penTool === 'repair' ? 'boundary-tool boundary-tool--active boundary-tool--repair' : 'boundary-tool'} onClick={() => choosePenTool('repair')}><WandSparkles size={16} /> 补全钢笔</button>
                <button type="button" aria-pressed={!boundaryOpen} className="boundary-tool" onClick={() => { setBoundaryOpen(false); onOpenPen?.(selected?.layer_index, null); }}><Hand size={16} /> 隐藏标注</button>
              </div>
              <p className="boundary-help">点击添加锚点并闭合路径；标注会随当前拆分需求一起发送。</p>
            </div> : null}
          </div>
        </section>
        <div className="guided-actions poster-fast-workbench__actions">
          <button type="button" className="command-button command-button--quiet" onClick={() => goToIndex(selectedIndex - 1)} disabled={!canGoPrevious}><ChevronLeft size={16} /> 上一个</button>
          <button type="button" className="command-button command-button--quiet" onClick={confirmAndNext} disabled={!selected}><Check size={17} /> 确认并下一个</button>
          <button type="button" className="command-button command-button--wide" onClick={() => selected && onSplit?.(selected.layer_index)} disabled={!selected || busy || Boolean(promptIssue)} title={promptIssue?.message}>{busy ? <Scissors size={16} /> : <Send size={16} />}{busy ? '拆分中' : '拆分'}</button>
        </div>
      </aside>
    </section>
  );
}
