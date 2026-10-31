import { useEffect, useMemo, useRef, useState } from 'react';
import { fitViewport, toSource, quantizeBounds, moveRegionBounds, resizeRegionBounds } from './coordinates.js';
import { RegionResizeHandles } from './RegionResizeHandles.jsx';

function sourcePoint(event, node, source) {
  const rect = node.getBoundingClientRect();
  const transform = fitViewport({ x: 0, y: 0, width: source.width, height: source.height }, { width: rect.width, height: rect.height }, 0);
  return toSource({ x: event.clientX - rect.left, y: event.clientY - rect.top }, transform);
}

export function DocumentCanvas({ document, sourceUrl, transform: suppliedTransform, selection, regionsVisible = true, onSelect, onBoundsChange, onRegionMove, onRegionResize }) {
  const viewport = useRef(null);
  const gesture = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState(null);
  const source = document.source;
  const transform = useMemo(() => suppliedTransform || (size.width && size.height
    ? fitViewport({ x: 0, y: 0, width: source.width, height: source.height }, size, 0) : null), [suppliedTransform, size, source.width, source.height]);
  // The list is top-first; SVG paints and hit-tests later siblings on top.
  // Reverse a copy so visual stacking follows the list without mutating the document.
  const layers = [...document.layerOrder].reverse().map(id => document.layers[id]);
  const measure = node => { viewport.current = node; };
  useEffect(() => {
    const node=viewport.current;if(!node)return;
    const update=()=>{const rect=node.getBoundingClientRect();setSize({width:rect.width,height:rect.height});};
    update();const observer=new ResizeObserver(update);observer.observe(node);return()=>observer.disconnect();
  },[Boolean(document)]);
  const pointerDown = event => {
    if (!onBoundsChange || event.button !== 0 || !viewport.current) return;
    const start = sourcePoint(event, viewport.current, source);
    gesture.current = { kind: 'draw', start, point: start };
    setDraft(gesture.current); event.currentTarget.setPointerCapture(event.pointerId);
  };
  const startMove = (event, layer) => {
    if (onBoundsChange || event.button !== 0) return;
    event.stopPropagation(); onSelect?.(layer.layerId);
    if (!onRegionMove || !viewport.current) return;
    const start = sourcePoint(event, viewport.current, source);
    gesture.current = { kind: 'move', layerId: layer.layerId, bounds: layer.bounds, start, point: start };
    setDraft(gesture.current); event.currentTarget.ownerSVGElement.setPointerCapture(event.pointerId);
  };
  const startResize = (event, handle) => {
    if (event.button !== 0 || !viewport.current) return;
    event.preventDefault(); event.stopPropagation();
    const start = sourcePoint(event, viewport.current, source);
    gesture.current = { kind: 'resize', layerId: selection, bounds: document.layers[selection].bounds, handle, start, point: start };
    setDraft(gesture.current); event.currentTarget.ownerSVGElement.setPointerCapture(event.pointerId);
  };
  const resize = (current, point) => resizeRegionBounds(current.bounds, current.handle,
    { x: point.x-current.start.x, y: point.y-current.start.y }, { x: 0, y: 0, width: source.width, height: source.height });
  const pointerMove = event => {
    if (!gesture.current || !viewport.current) return;
    gesture.current = { ...gesture.current, point: sourcePoint(event, viewport.current, source) };
    setDraft(gesture.current);
  };
  const cancelGesture = () => { gesture.current = null; setDraft(null); };
  const pointerUp = event => {
    const current = gesture.current;
    if (!current || !viewport.current) return;
    const a = current.start; const b = sourcePoint(event, viewport.current, source);
    cancelGesture();
    if (current.kind === 'move') { onRegionMove?.(current.layerId, { x: b.x-a.x, y: b.y-a.y }); return; }
    if (current.kind === 'resize') { onRegionResize?.(current.layerId, resize(current, b)); return; }
    // A click or a gesture outside the image does not create an empty selection.
    try {
      const region = quantizeBounds({ x: Math.min(a.x,b.x), y: Math.min(a.y,b.y), width: Math.abs(b.x-a.x), height: Math.abs(b.y-a.y) }, source);
      onBoundsChange?.(region);
    } catch (cause) { if (cause.message !== 'EMPTY_BOUNDS') throw cause; }
  };
  const bounds = layer => ({ x: layer.bounds.x * (transform?.scale || 0) + (transform?.offsetX || 0),
    y: layer.bounds.y * (transform?.scale || 0) + (transform?.offsetY || 0),
    width: layer.bounds.width * (transform?.scale || 0), height: layer.bounds.height * (transform?.scale || 0) });
  const draftRect = draft?.kind === 'draw' && transform ? { x: Math.min(draft.start.x,draft.point.x)*transform.scale+transform.offsetX,
    y: Math.min(draft.start.y,draft.point.y)*transform.scale+transform.offsetY,
    width: Math.abs(draft.point.x-draft.start.x)*transform.scale, height: Math.abs(draft.point.y-draft.start.y)*transform.scale } : null;
  return <div className="v2-canvas v2-canvas--document" aria-label="原图与拆分选区">
    <div className={`v2-canvas__viewport ${onBoundsChange ? 'v2-canvas__viewport--draw' : ''}`} ref={measure}>
      {transform ? <>
        <img className="v2-canvas__image" src={sourceUrl} alt="上传的原图" draggable="false"
          style={{ left: transform.offsetX, top: transform.offsetY, width: source.width*transform.scale, height: source.height*transform.scale }} />
        {regionsVisible ? <svg className="v2-canvas__overlay" viewBox={`0 0 ${size.width} ${size.height}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}>
          {layers.map((layer,index) => { const region = draft?.layerId === layer.layerId
            ? draft.kind === 'resize' ? resize(draft, draft.point) : moveRegionBounds(draft.bounds, { x: draft.point.x-draft.start.x, y: draft.point.y-draft.start.y }, source) : layer.bounds;
            const b=bounds({ bounds: region });
            const selected = selection === layer.layerId;
            const label = layer.name || `${layer.displayCategory} ${index+1}`;
            const viewportWidth = size.width || source.width * (transform?.scale || 1);
            const labelWidth = Math.min(180, viewportWidth - 4);
            const labelX = Math.max(2, Math.min(b.x + 1, viewportWidth - labelWidth - 2));
            return <g key={layer.layerId} data-layer-id={layer.layerId}
            className={`${selection===layer.layerId?'v2-region v2-region--selected':'v2-region'}${onRegionMove ? ' v2-region--movable' : ''}`} onPointerDown={event=>startMove(event,layer)}>
            {selected ? <rect className="v2-region__contrast" {...b} aria-hidden="true"/> : null}
            <rect className="v2-region__outline" {...b}/>
            {selected ? <foreignObject className="v2-region__label" x={labelX} y={Math.max(2,b.y-24)} width={labelWidth} height={22}>
              <div className="v2-region__label-text" title={label}>{label}</div>
            </foreignObject> : <text x={b.x+6} y={Math.max(15,b.y-6)}>{label}</text>}
          </g>; })}
          {onRegionResize && !onBoundsChange && document.layers[selection] ? <RegionResizeHandles
            bounds={bounds({ bounds: draft?.layerId === selection
              ? draft.kind === 'resize' ? resize(draft, draft.point) : moveRegionBounds(draft.bounds, { x: draft.point.x-draft.start.x, y: draft.point.y-draft.start.y }, source)
              : document.layers[selection].bounds })} onStart={startResize}/> : null}
          {draftRect ? <rect className="v2-region-draft" x={draftRect.x} y={draftRect.y} width={draftRect.width} height={draftRect.height} /> : null}
        </svg> : null}
      </> : <span>正在适配原图…</span>}
    </div>
  </div>;
}
