import { useEffect, useId, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { fitViewport, resizeRegionBounds, toSource } from './coordinates.js';
import { RegionResizeHandles } from './RegionResizeHandles.jsx';

export function RegionEditorCanvas({ source, sourceUrl, name, bounds, entryBounds, onResize, onOpenPen }) {
  const clipId = useId();
  const viewport = useRef(null);
  const gesture = useRef(null);
  const [size, setSize] = useState({ width: 600, height: 400 });
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    const node = viewport.current;
    const update = () => { const r = node.getBoundingClientRect(); if (r.width > 32 && r.height > 32) setSize({ width: r.width, height: r.height }); };
    update(); const observer = new ResizeObserver(update); observer.observe(node); return () => observer.disconnect();
  }, []);
  const t = fitViewport(entryBounds, size, 16);
  const screen = b => ({ x: b.x*t.scale+t.offsetX, y: b.y*t.scale+t.offsetY, width: b.width*t.scale, height: b.height*t.scale });
  const crop = screen(entryBounds);
  const selected = screen(preview || bounds);
  const point = event => { const r = viewport.current.getBoundingClientRect(); return toSource({ x: event.clientX-r.left, y: event.clientY-r.top }, t); };
  const start = (event, handle) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    gesture.current = { handle, start: point(event), bounds };
    event.currentTarget.ownerSVGElement.setPointerCapture(event.pointerId);
  };
  const resized = event => { const g = gesture.current, p = point(event); return resizeRegionBounds(g.bounds, g.handle,
    { x: p.x-g.start.x, y: p.y-g.start.y }, entryBounds); };
  const cancel = () => { gesture.current = null; setPreview(null); };
  const finish = event => { if (!gesture.current) return; const next = resized(event); cancel(); onResize(next); };
  return <div className="v2-canvas v2-region-preview" aria-label="当前拆分选区">
    <div className="v2-canvas__viewport" ref={viewport}>
      <svg className="v2-canvas__overlay" viewBox={`0 0 ${size.width} ${size.height}`}
        onPointerMove={event => { if (gesture.current) setPreview(resized(event)); }} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}>
        <svg x={crop.x} y={crop.y} width={crop.width} height={crop.height}
          viewBox={`${entryBounds.x} ${entryBounds.y} ${entryBounds.width} ${entryBounds.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`${name}框选内容`}>
          <defs><clipPath id={clipId}><rect {...entryBounds}/></clipPath></defs>
          <image href={sourceUrl} width={source.width} height={source.height} clipPath={`url(#${clipId})`}/>
        </svg>
        <rect className="v2-region-draft" {...selected}/>
        <RegionResizeHandles bounds={selected} onStart={start}/>
      </svg>
      <button type="button" className="v2-region-preview__zoom" aria-label="放大编辑当前选区" title="放大编辑当前选区" onClick={onOpenPen}><Maximize2 size={20}/></button>
    </div>
  </div>;
}
