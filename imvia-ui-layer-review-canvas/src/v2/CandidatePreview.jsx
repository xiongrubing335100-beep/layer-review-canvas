import { useEffect, useRef, useState } from 'react';
import { Focus, Minus, Plus } from 'lucide-react';
import { fitPreview, zoomPreview } from './preview-viewport.js';

export function CandidatePreview({ source, layers, bounds, label, regions = [], reference = null }) {
  const root = useRef(null), gesture = useRef(null), viewRef = useRef(null);
  const [size, setSize] = useState(null), [manualView, setManualView] = useState(null);
  const [dragging, setDragging] = useState(false);
  const view = manualView || (size ? fitPreview(bounds, size) : null);
  viewRef.current = view;
  const hasResult = layers.length > 0;

  useEffect(() => {
    const node = root.current;
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      if (width > 0 && height > 0) setSize({ width, height });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    const wheel = event => {
      if (!hasResult || event.target.closest('[data-preview-tools]')) return;
      event.preventDefault();
      if (!viewRef.current) return;
      const rect = node.getBoundingClientRect();
      setManualView(zoomPreview(viewRef.current, { x: event.clientX - rect.left, y: event.clientY - rect.top }, viewRef.current.scale * Math.exp(-event.deltaY * .0015)));
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); node.removeEventListener('wheel', wheel); };
  }, [hasResult]);

  const zoom = scale => {
    if (view && size) setManualView(zoomPreview(view, { x: size.width / 2, y: size.height / 2 }, scale));
  };
  const end = () => { gesture.current = null; setDragging(false); };
  return <div ref={root} className={`v2-review-preview ${hasResult ? 'has-result' : ''} ${dragging ? 'is-dragging' : ''}`}
    aria-label={label} tabIndex={0}
    onPointerDown={event => {
      if (!hasResult || !view || ![0, 1].includes(event.button) || event.target.closest('[data-preview-tools]')) return;
      event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { x: event.clientX, y: event.clientY, view }; setDragging(true);
    }}
    onPointerMove={event => {
      if (!gesture.current) return;
      const start = gesture.current;
      setManualView({ ...start.view, offsetX: start.view.offsetX + event.clientX - start.x, offsetY: start.view.offsetY + event.clientY - start.y });
    }} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || !hasResult || !view) return;
      if (['+', '=', '-', '0'].includes(event.key)) {
        event.preventDefault();
        if (event.key === '0') setManualView(null); else zoom(view.scale * (event.key === '-' ? 1 / 1.2 : 1.2));
      }
    }}>
    {hasResult && view ? <div className="v2-review-preview__canvas" style={{ width: source.width, height: source.height,
      transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})` }}>
      {layers.map(layer => <img key={`${layer.layerId}:${layer.versionId}`} src={layer.pngUrl} alt={`${layer.name} 候选图层`} draggable="false"
        style={{ left: layer.placement.x, top: layer.placement.y, width: layer.width, height: layer.height }} />)}
      {reference ? <div className="v2-preview-reference" style={{ left: reference.x, top: reference.y, width: reference.width, height: reference.height }}>
        <img src={reference.url} alt="相同位置的原图对照" style={{ left: -reference.x, top: -reference.y, width: source.width, height: source.height }}/>
      </div> : null}
      {regions.map((region, index) => <div key={index} className="v2-preview-uncertain" aria-hidden="true"
        style={{ left: region.x - 4 / view.scale, top: region.y - 4 / view.scale,
          width: region.width + 8 / view.scale, height: region.height + 8 / view.scale,
          borderWidth: 1 / view.scale }}><span style={{ transform: `scale(${1 / view.scale})` }}>{index + 1}</span></div>)}
    </div> : <span className="v2-preview-empty">{hasResult ? '正在适配结果…' : '暂无拆分结果'}</span>}
    <div className="v2-preview-tools" data-preview-tools role="toolbar" aria-label="候选预览工具">
      <button type="button" aria-label="缩小候选" title="缩小 −" disabled={!hasResult || !view} onClick={() => zoom(view.scale / 1.2)}><Minus size={16}/></button>
      <button type="button" aria-label="候选原始尺寸" title="原始尺寸 100%" disabled={!hasResult || !view} onClick={() => zoom(1)}><output aria-label="候选缩放比例">{hasResult && view ? `${Math.round(view.scale * 100)}%` : '—'}</output></button>
      <button type="button" aria-label="放大候选" title="放大 +" disabled={!hasResult || !view} onClick={() => zoom(view.scale * 1.2)}><Plus size={16}/></button>
      <button type="button" aria-label="适配候选" title="适配结果 0" disabled={!hasResult || !view} onClick={() => setManualView(null)}><Focus size={16}/></button>
    </div>
    {hasResult ? <small className="v2-preview-hint">滚轮缩放 · 拖动平移</small> : null}
  </div>;
}
