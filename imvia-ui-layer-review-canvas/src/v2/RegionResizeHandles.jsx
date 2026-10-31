const handles = [
  ['nw', 0, 0, '左上角'], ['n', .5, 0, '上边'], ['ne', 1, 0, '右上角'], ['e', 1, .5, '右边'],
  ['se', 1, 1, '右下角'], ['s', .5, 1, '下边'], ['sw', 0, 1, '左下角'], ['w', 0, .5, '左边'],
];

// Screen-space handles keep the same hit size regardless of image zoom.
export function RegionResizeHandles({ bounds, onStart }) {
  return <g className="v2-resize-handles">{handles.map(([side, x, y, label]) =>
    <g key={side} data-resize-handle={side} className={`v2-resize-handle v2-resize-handle--${side}`}
      aria-label={`拖动${label}调整选区大小`} onPointerDown={event => onStart(event, side)}
      transform={`translate(${bounds.x + bounds.width*x} ${bounds.y + bounds.height*y})`}>
      <title>{`拖动${label}调整选区大小`}</title>
      <rect className="v2-resize-hit" x={-10} y={-10} width={20} height={20}/>
      <rect className="v2-resize-knob" x={-4} y={-4} width={8} height={8} rx={1}/>
    </g>)}</g>;
}
