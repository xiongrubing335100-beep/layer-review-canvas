function convert(paths, sourceSize, normalized) {
  const { width, height } = sourceSize;
  if (![width, height].every(n => Number.isFinite(n) && n > 0)) throw new Error('INVALID_SOURCE_SIZE');
  const kinds = normalized ? { include: 'foreground', exclude: 'background' }
    : { foreground: 'include', background: 'exclude', boundary: 'include' };
  const point = p => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('INVALID_PEN_POINT');
    return { x: normalized ? p.x / width : p.x * width, y: normalized ? p.y / height : p.y * height };
  };
  return paths.map(path => {
    if (!Object.hasOwn(kinds, path.kind)) throw new Error('UNKNOWN_PATH_KIND');
    return { ...structuredClone(path), kind: kinds[path.kind], anchors: path.anchors.map(anchor => ({
      ...anchor, ...point(anchor), in: point(anchor.in), out: point(anchor.out),
    })) };
  });
}
export const toLegacyPaths = (paths, sourceSize) => convert(paths, sourceSize, true);
export const fromLegacyPaths = (paths, sourceSize) => convert(paths, sourceSize, false);

function mapPoint(point, bounds, inverse = false) {
  return inverse
    ? { x: bounds.x + point.x * bounds.width, y: bounds.y + point.y * bounds.height }
    : { x: (point.x - bounds.x) / bounds.width, y: (point.y - bounds.y) / bounds.height };
}

function mapRegionPaths(paths, bounds, inverse = false) {
  const kinds = inverse ? { foreground: 'include', background: 'exclude' } : { include: 'foreground', exclude: 'background' };
  return (paths ?? []).map(path => {
    if (!Object.hasOwn(kinds, path.kind)) throw new Error('UNKNOWN_PATH_KIND');
    return { ...structuredClone(path), kind: kinds[path.kind], anchors: path.anchors.map(anchor => ({
      ...anchor, ...mapPoint(anchor, bounds, inverse), in: mapPoint(anchor.in, bounds, inverse), out: mapPoint(anchor.out, bounds, inverse),
    })) };
  });
}

export const toRegionPenPaths = (paths, bounds) => mapRegionPaths(paths, bounds);
export const fromRegionPenPaths = (paths, bounds) => mapRegionPaths(paths, bounds, true);
