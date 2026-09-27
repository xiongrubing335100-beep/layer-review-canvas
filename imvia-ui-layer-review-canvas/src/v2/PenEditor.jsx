import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minus, MousePointer2, PenTool, Plus, Redo2, Trash2, Undo2, WandSparkles, X } from 'lucide-react';
import { PenPathOverlay } from '../PenPathOverlay.jsx';
import { toRegionPenPaths, fromRegionPenPaths } from './pen-adapter.js';
import { fitViewport } from './coordinates.js';

export function PenEditor({ source, sourceUrl, draft, target = 'paths', onChange, onClose }) {
  const bounds = draft.values.bounds;
  const startPaths = useMemo(() => toRegionPenPaths(target === 'repairPaths' ? draft.values.strategy.repairPaths : draft.values.paths, bounds), []);
  const [overlayState, setOverlayState] = useState(() => ({ paths: startPaths, draft: null, selection: null, history: [], future: [], feedbackToken: null }));
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [tool, setTool] = useState('pen');
  const [activeKind, setActiveKind] = useState('foreground');
  const penRef = useRef(null);
  const viewportRef = useRef(null);
  const panRef = useRef(null);
  const transform = viewport.width && viewport.height ? fitViewport(bounds, viewport, 28) : null;
  const fittedWidth = transform ? bounds.width * transform.scale : 0;
  const fittedHeight = transform ? bounds.height * transform.scale : 0;
  const targetLabel = target === 'repairPaths' ? '修复区域' : '钢笔编辑';

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
    if (target === 'repairPaths') onChange({ type: 'set-strategy', field: 'repairPaths', value: sourcePaths });
    else onChange({ type: 'set-field', field: 'paths', value: sourcePaths });
  };
  const fit = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const startPan = event => {
    if (tool !== 'pan' || event.button !== 0 || event.target.closest('.v2-pen-tools')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = { x: event.clientX, y: event.clientY, pan };
  };
  const movePan = event => {
    if (!panRef.current) return;
    setPan({ x: panRef.current.pan.x + event.clientX - panRef.current.x, y: panRef.current.pan.y + event.clientY - panRef.current.y });
  };
  const endPan = () => { panRef.current = null; };
  const adjustZoom = amount => setZoom(value => Math.max(.5, Math.min(8, Number((value + amount).toFixed(2)))));

  return <section className="v2-pen-editor" role="dialog" aria-modal="true" aria-label="放大钢笔编辑">
    <header className="v2-pen-toolbar">
      <div className="v2-pen-toolbar__title"><strong>放大钢笔编辑</strong><span>{targetLabel} · {Math.round(zoom * 100)}%</span></div>
      <div className="v2-pen-toolbar__actions">
        <button type="button" aria-label="撤销" title="撤销" onClick={() => penRef.current?.undo()} disabled={!overlayState.history.length}><Undo2 size={18}/></button>
        <button type="button" aria-label="重做" title="重做" onClick={() => penRef.current?.redo()} disabled={!overlayState.future.length}><Redo2 size={18}/></button>
        <button type="button" aria-label="缩小" title="缩小" onClick={() => adjustZoom(-.25)}><Minus size={18}/></button>
        <button type="button" aria-label="放大" title="放大" onClick={() => adjustZoom(.25)}><Plus size={18}/></button>
        <button type="button" aria-label="适配选区" title="适配选区" onClick={fit}><Maximize2 size={18}/></button>
        <button className="v2-pen-close" type="button" aria-label="返回编辑" title="返回编辑" onClick={onClose}><X size={18}/></button>
      </div>
    </header>
    <div className="v2-pen-viewport" ref={viewportRef} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan}>
      {transform ? <div className={`v2-pen-region ${tool === 'pan' ? 'is-pan' : ''}`} style={{ width: fittedWidth, height: fittedHeight, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        <img src={sourceUrl} alt="当前拆分选区原图" draggable="false" style={{ width: source.width * transform.scale, height: source.height * transform.scale, left: -bounds.x * transform.scale, top: -bounds.y * transform.scale }} />
        <PenPathOverlay ref={penRef} paths={overlayState.paths} draft={overlayState.draft} selection={overlayState.selection} activeKind={activeKind} disabled={tool !== 'pen'} feedbackToken={overlayState.feedbackToken} ariaLabel={`${targetLabel}路径编辑`} onChange={emitPaths} />
      </div> : <span className="v2-pen-loading">正在适配当前选区…</span>}
      <div className="v2-pen-tools" aria-label="精细编辑工具">
        <button className={tool === 'pen' ? 'is-active' : ''} type="button" aria-label="钢笔工具" title="钢笔工具" onClick={() => setTool('pen')}><PenTool size={18}/></button>
        <button type="button" aria-label="魔棒不可用" title="当前版本尚无可靠的魔棒选区算法" disabled><WandSparkles size={18}/></button>
        <button className={tool === 'pan' ? 'is-active' : ''} type="button" aria-label="移动画布" title="拖动移动画布" onClick={() => setTool('pan')}><MousePointer2 size={18}/></button>
        <button type="button" aria-label="删除选中路径或锚点" title="删除选中路径或锚点" onClick={() => penRef.current?.deleteSelection()} disabled={!overlayState.selection?.pathId}><Trash2 size={18}/></button>
        <button className={activeKind === 'foreground' ? 'is-active' : ''} type="button" aria-label="绘制保留区域" title="绘制保留区域" onClick={() => { setActiveKind('foreground'); setTool('pen'); }}><i className="v2-pen-kind v2-pen-kind--include"/></button>
        <button className={activeKind === 'background' ? 'is-active' : ''} type="button" aria-label="绘制排除区域" title="绘制排除区域" onClick={() => { setActiveKind('background'); setTool('pen'); }}><i className="v2-pen-kind v2-pen-kind--exclude"/></button>
      </div>
    </div>
    <footer className="v2-pen-footer"><div><strong>{overlayState.selection?.pathId ? '已选中路径 · 可编辑锚点' : `${overlayState.paths.length} 条路径 · ${targetLabel}`}</strong><span>拖动锚点调整轮廓；点击首个锚点闭合；⌘/Ctrl+Z 撤销</span></div><button type="button" onClick={onClose}>返回编辑</button></footer>
  </section>;
}
