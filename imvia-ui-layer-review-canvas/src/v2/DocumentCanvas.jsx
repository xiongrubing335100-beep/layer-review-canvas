import { useEffect, useMemo, useRef, useState } from 'react';
import { fitViewport, toSource, quantizeBounds } from './coordinates.js';

function sourcePoint(event, node, source) {
  const rect = node.getBoundingClientRect();
  const transform = fitViewport({ x: 0, y: 0, width: source.width, height: source.height }, { width: rect.width, height: rect.height }, 0);
  return toSource({ x: event.clientX - rect.left, y: event.clientY - rect.top }, transform);
}

export function DocumentCanvas({ document, sourceUrl, transform: suppliedTransform, selection, onSelect, onBoundsChange }) {
  const viewport = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState(null);
  const source = document.source;
  const transform = useMemo(() => suppliedTransform || (size.width && size.height
    ? fitViewport({ x: 0, y: 0, width: source.width, height: source.height }, size, 0) : null), [suppliedTransform, size, source.width, source.height]);
  const layers = document.layerOrder.map(id => document.layers[id]);
  const measure = node => { viewport.current = node; };
  useEffect(() => {
    const node=viewport.current;if(!node)return;
    const update=()=>{const rect=node.getBoundingClientRect();setSize({width:rect.width,height:rect.height});};
    update();const observer=new ResizeObserver(update);observer.observe(node);return()=>observer.disconnect();
  },[Boolean(document)]);
  const pointerDown = event => {
    if (!onBoundsChange || event.button !== 0 || !viewport.current) return;
    const start = sourcePoint(event, viewport.current, source);
    setDraft({ start, point: start }); event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = event => { if (draft && viewport.current) setDraft(value => ({ ...value, point: sourcePoint(event, viewport.current, source) })); };
  const pointerUp = () => {
    if (!draft) return;
    const a = draft.start; const b = draft.point;
    const bounds = quantizeBounds({ x: Math.min(a.x,b.x), y: Math.min(a.y,b.y), width: Math.abs(b.x-a.x), height: Math.abs(b.y-a.y) }, source);
    setDraft(null); if (bounds) onBoundsChange?.(bounds);
  };
  const bounds = layer => ({ x: layer.bounds.x * (transform?.scale || 0) + (transform?.offsetX || 0),
    y: layer.bounds.y * (transform?.scale || 0) + (transform?.offsetY || 0),
    width: layer.bounds.width * (transform?.scale || 0), height: layer.bounds.height * (transform?.scale || 0) });
  const draftRect = draft && transform ? { x: Math.min(draft.start.x,draft.point.x)*transform.scale+transform.offsetX,
    y: Math.min(draft.start.y,draft.point.y)*transform.scale+transform.offsetY,
    width: Math.abs(draft.point.x-draft.start.x)*transform.scale, height: Math.abs(draft.point.y-draft.start.y)*transform.scale } : null;
  return <div className="v2-canvas" aria-label="原图与拆分选区">
    <div className={`v2-canvas__viewport ${onBoundsChange ? 'v2-canvas__viewport--draw' : ''}`} ref={measure}>
      {transform ? <>
        <img className="v2-canvas__image" src={sourceUrl} alt="上传的原图" draggable="false"
          style={{ left: transform.offsetX, top: transform.offsetY, width: source.width*transform.scale, height: source.height*transform.scale }} />
        <svg className="v2-canvas__overlay" viewBox={`0 0 ${size.width} ${size.height}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
          {layers.map((layer,index) => { const b=bounds(layer); return <g key={layer.layerId} data-layer-id={layer.layerId}
            className={selection===layer.layerId?'v2-region v2-region--selected':'v2-region'} onPointerDown={event=>{if(!onBoundsChange){event.stopPropagation();onSelect?.(layer.layerId);}}}>
            <rect x={b.x} y={b.y} width={b.width} height={b.height} />
            <text x={b.x+6} y={Math.max(15,b.y-6)}>{layer.name || `${layer.displayCategory} ${index+1}`}</text>
          </g>; })}
          {draftRect ? <rect className="v2-region-draft" x={draftRect.x} y={draftRect.y} width={draftRect.width} height={draftRect.height} /> : null}
        </svg>
      </> : <span>正在适配原图…</span>}
    </div>
  </div>;
}
