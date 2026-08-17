const supportedAlignments = new Set(['left', 'center', 'right', 'top', 'bottom']);

export function alignCanvasItems(items, alignment) {
  if (!Array.isArray(items) || items.length < 2 || !supportedAlignments.has(alignment)) {
    return {};
  }

  const left = Math.min(...items.map((item) => item.x));
  const right = Math.max(...items.map((item) => item.x + item.width));
  const top = Math.min(...items.map((item) => item.y));
  const bottom = Math.max(...items.map((item) => item.y + item.height));
  const center = (left + right) / 2;

  return Object.fromEntries(items.map((item) => {
    if (alignment === 'left') return [item.key, { x: left, y: item.y }];
    if (alignment === 'center') return [item.key, { x: center - item.width / 2, y: item.y }];
    if (alignment === 'right') return [item.key, { x: right - item.width, y: item.y }];
    if (alignment === 'top') return [item.key, { x: item.x, y: top }];
    return [item.key, { x: item.x, y: bottom - item.height }];
  }));
}
