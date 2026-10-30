import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleMinus, Hand, Maximize2, Minus, PenTool, Plus, Redo2, Save, Trash2, Undo2 } from 'lucide-react';
import { PenPathOverlay } from '../PenPathOverlay.jsx';
import { toRegionPenPaths, fromRegionPenPaths } from './pen-adapter.js';
import { fitPreview, zoomPreview } from './preview-viewport.js';
import { WorkspaceBack, WorkspaceHeading } from './WorkspaceChrome.jsx';

export function PenEditor({ source, sourceUrl, draft, target = 'paths', onChange, onClose, onSave, dirty = false, saving = false, saveError = '' }) {
  const bounds = draft.values.bounds;
  const startPaths = useMemo(() => toRegionPenPaths(target === 'repairPaths' ? draft.values.strategy.repairPaths : draft.values.paths, bounds), []);
  const [overlayState, setOverlayState] = useState(() => draft.penSessions?.[target] || ({ paths: startPaths, draft: null, selection: null, history: [], future: [], feedbackToken: null }));
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [manualView, setManualView] = useState(null);
  const [tool, setTool] = useState('pen');
  const activeKind = tool === 'exclude' ? 'background' : 'foreground';
  const penRef = useRef(null);
  const viewportRef = useRef(null);
  const panRef = useRef(null);
  const transform = manualView || (viewport.width && viewport.height ? fitPreview(bounds, viewport) : null);
  const targetLabel = target === 'repairPaths' ? '修复区域' : '钢笔编辑';
  const selectedPath = overlayState.paths.find(path => path.id === overlayState.selection?.pathId);
  const selectedIndex = overlayState.paths.findIndex(path => path.id === selectedPath?.id);
  const operationHint = tool === 'pan' ? '拖动画布调整查看位置。'
    : overlayState.draft ? (overlayState.draft.anchors.length < 3 ? '继续点击添加锚点，至少需要 3 个。' : '点击起点闭合选区。')
      : selectedPath?.closed ? (selectedPath.requirements?.trim() ? '拖动锚点调整轮廓，或修改当前要求。' : '填写当前选区的处理要求。')
        : tool === 'exclude' ? '用钢笔圈出需要排除的区域。' : '用钢笔圈出需要处理的区域。';

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return undefined;
    const resize = () => { const rect = node.getBoundingClientRect(); setViewport({ width: rect.width, height: rect.height }); };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const emitPaths = output => {
    setOverlayState(output);
    const sourcePaths = fromRegionPenPaths(output.paths, bounds);
    onChange({ type: 'set-pen-state', target, session: output, paths: sourcePaths });
  };
  const fit = () => setManualView(null);
  const startPan = event => {
    if (!transform || tool !== 'pan' || event.button !== 0 || event.target.closest('.v2-pen-tools')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = { x: event.clientX, y: event.clientY, view: transform };
  };
  const movePan = event => {
    if (!panRef.current) return;
    const start = panRef.current;
    setManualView({ ...start.view, offsetX: start.view.offsetX + event.clientX - start.x, offsetY: start.view.offsetY + event.clientY - start.y });
  };
  const endPan = () => { panRef.current = null; };
  const zoomTo = scale => {
    if (transform) setManualView(zoomPreview(transform, { x: viewport.width / 2, y: viewport.height / 2 }, scale));
  };

  return <section className="v2-pen-editor v2-workspace-page" role="dialog" aria-modal="true" aria-label="放大钢笔编辑">
    <div className="v2-workspace-grid">
    <div className="v2-workspace-canvas-panel">
    <WorkspaceHeading title="精细编辑" detail={draft.values.name} actions={<>
      <button type="button" className="v2-pen-zoom-value" aria-label="精细编辑原始尺寸" title="原始尺寸 100% · 1 图像像素对应 1 CSS 像素" disabled={!transform} onClick={() => zoomTo(1)}>
        <output aria-label="精细编辑缩放比例">{transform ? `${Math.round(transform.scale * 100)}%` : '—'}</output>
      </button>
      <div className="v2-pen-toolbar__actions">
        <button type="button" aria-label="撤销" title="撤销" onClick={() => penRef.current?.undo()} disabled={!overlayState.history.length}><Undo2 size={18}/></button>
        <button type="button" aria-label="重做" title="重做" onClick={() => penRef.current?.redo()} disabled={!overlayState.future.length}><Redo2 size={18}/></button>
        <button type="button" aria-label="缩小" title="缩小" disabled={!transform || transform.scale <= .01} onClick={() => zoomTo(transform.scale / 1.2)}><Minus size={18}/></button>
        <button type="button" aria-label="放大" title="放大" disabled={!transform || transform.scale >= 32} onClick={() => zoomTo(transform.scale * 1.2)}><Plus size={18}/></button>
        <button type="button" aria-label="适配选区" title="适配选区" onClick={fit}><Maximize2 size={18}/></button>
      </div>
    </>}/>
    <div className="v2-pen-viewport" ref={viewportRef} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}>
      {transform ? <div className={`v2-pen-region ${tool === 'pan' ? 'is-pan' : ''}`} style={{ width: bounds.width * transform.scale, height: bounds.height * transform.scale,
        left: bounds.x * transform.scale + transform.offsetX, top: bounds.y * transform.scale + transform.offsetY }}>
        <img src={sourceUrl} alt="当前拆分选区原图" draggable="false" style={{ width: source.width * transform.scale, height: source.height * transform.scale, left: -bounds.x * transform.scale, top: -bounds.y * transform.scale }} />
        <PenPathOverlay ref={penRef} paths={overlayState.paths} draft={overlayState.draft} selection={overlayState.selection} activeKind={activeKind} disabled={tool === 'pan'} feedbackToken={overlayState.feedbackToken} initialHistory={overlayState.history} initialFuture={overlayState.future} ariaLabel={`${targetLabel}路径编辑`} onChange={emitPaths} />
      </div> : <span className="v2-pen-loading">正在适配当前选区…</span>}
    </div>
    </div>
    <aside className="v2-pen-sidebar v2-workspace-side-panel" aria-label="选区处理要求">
      <WorkspaceHeading title="选区处理要求" level={2} actions={<>
        <WorkspaceBack onClick={onClose} label="返回单项编辑"/>
        <button type="button" className="v2-workspace-save" onClick={onSave} disabled={!onSave || saving || !dirty || Boolean(overlayState.draft)}
          title={overlayState.draft ? '请先闭合当前选区再保存' : '保存当前图层及所有选区要求'}><Save size={14}/>{saving ? '保存中…' : '保存'}</button>
      </>}/>
      <div className="v2-workspace-panel-body v2-pen-panel-body">
      {saveError ? <p className="v2-editor-feedback" role="alert">{saveError}</p> : <span className="v2-editor-save-status" role="status">{saving ? '正在保存' : dirty || overlayState.draft ? '未保存' : '已保存'}</span>}
      <div className="v2-pen-tools" role="group" aria-label="精细编辑工具">
        <button type="button" aria-pressed={tool === 'pen'} aria-label="钢笔工具" title={overlayState.draft?.kind === 'background' ? '先闭合当前排除选区' : '钢笔工具 · 圈选保留区域'} disabled={overlayState.draft?.kind === 'background'} onClick={() => setTool('pen')}><PenTool size={18}/></button>
        <button type="button" aria-pressed={tool === 'exclude'} aria-label="绘制排除区域" title={overlayState.draft?.kind === 'foreground' ? '先闭合当前保留选区' : '钢笔工具 · 圈选排除区域'} disabled={overlayState.draft?.kind === 'foreground'} onClick={() => setTool('exclude')}><CircleMinus size={18}/></button>
        <button type="button" aria-pressed={tool === 'pan'} aria-label="移动画布" title="拖动移动画布" onClick={() => setTool('pan')}><Hand size={18}/></button>
        <button type="button" aria-label="删除选中路径或锚点" title="删除选中路径或锚点" onClick={() => penRef.current?.deleteSelection()} disabled={!overlayState.selection?.pathId}><Trash2 size={18}/></button>
      </div>
      <div className="v2-region-instructions">
        <p role="status" aria-live="polite">{operationHint}</p>
        <div className="v2-region-instructions__list" aria-label="当前选区">
          {overlayState.paths.map((path, index) => <button type="button" key={path.id} aria-pressed={selectedPath?.id === path.id}
            onClick={() => penRef.current?.selectPath(path.id)}>
            <span>区域 {index + 1}{path.kind === 'background' ? ' · 排除' : ''}</span><small>{path.requirements?.trim() ? '已填写' : '待填写'}</small>
          </button>)}
        </div>
        {selectedPath?.closed ? <label className="v2-field"><span>区域 {selectedIndex + 1} 的处理要求</span>
          <textarea aria-label="当前选区处理要求" value={selectedPath.requirements ?? ''}
            onChange={event => penRef.current?.setPathRequirements(selectedPath.id, event.target.value)}
            placeholder={target === 'repairPaths' ? '例如：去掉这里的昵称，补全后面的蓝色底板。' : '例如：完整保留这块边框和高光，去除外围背景。'} />
        </label> : null}
      </div>
      </div>
    </aside>
    </div>
  </section>;
}
