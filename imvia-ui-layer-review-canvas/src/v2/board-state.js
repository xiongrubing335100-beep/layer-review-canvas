// Board positions are presentation-only. Never write them into layer.bounds or PSD placement.
export const initialBoard = () => ({ viewport: { x: 0, y: 0, scale: 1 }, positions: {}, groups: [] });
export const boardStorageKey = (workspaceId, sessionId, documentId) =>
  `imvia-layer-v2-board-v1:${workspaceId}:${sessionId}:${documentId || 'empty'}`;
const finitePoint = value => Number.isFinite(value?.x) && Number.isFinite(value?.y);

export function restoreBoard(storage, key) {
  const fresh = initialBoard();
  try {
    const saved = JSON.parse(storage?.getItem(key) || 'null');
    if (!saved || saved.version !== 1) return fresh;
    if (finitePoint(saved.viewport) && Number.isFinite(saved.viewport.scale)) fresh.viewport = {
      ...saved.viewport, scale: Math.min(2.5, Math.max(0.15, saved.viewport.scale)),
    };
    fresh.positions = Object.fromEntries(Object.entries(saved.positions || {}).filter(([, value]) => finitePoint(value)).map(([key,{x,y}])=>[key,{x,y}]));
    fresh.groups = (Array.isArray(saved.groups) ? saved.groups : []).filter(group =>
      typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.keys) && group.keys.every(key => typeof key === 'string'));
  } catch { /* A damaged or unavailable browser store must not prevent opening an empty board. */ }
  return fresh;
}

export function saveBoard(storage, key, board) {
  storage?.setItem(key, JSON.stringify({ version: 1, ...board }));
}

export function buildBoardNodes(document, candidates = {}, positions = {}) {
  if (!document) return [];
  const source = { key: 'source', kind: 'source', name: '原图', x: 80, y: 100, width: 300,
    height: Math.min(400, Math.max(180, document.source.height / document.source.width * 300)) + 72 };
  const nodes = [source];
  document.layerOrder.forEach((id, index) => {
    const layer = document.layers[id];
    const node = { key: `layer:${id}`, kind: 'layer', layerId: id, name: layer.name,
      parent: 'source', x: 490, y: 100 + index * 300, width: 280, height: 240, bounds: layer.bounds };
    nodes.push(node);
    (candidates[id]?.versions || []).filter(version => version.artifactValid && candidates[id]?.state?.resultVersionId === version.versionId).forEach((version, i) => {
      nodes.push({ key: `result:${id}:${version.versionId}`, kind: 'result', layerId: id,
        name: layer.name, parent: node.key, versionId: version.versionId,
        adopted: candidates[id]?.state?.resultVersionId === version.versionId && candidates[id]?.state?.status === 'ready',
        current: (candidates[id]?.state?.versionIds || []).includes(version.versionId),
        x: 890 + i * 330, y: node.y, width: 280, height: 240 });
    });
  });
  return nodes.map(node => ({ ...node, ...(finitePoint(positions[node.key]) ? {x:positions[node.key].x,y:positions[node.key].y} : {}) }));
}

export function moveBoardNodes(positions, nodes, keys, delta) {
  const moving = new Set(keys);
  return { ...positions, ...Object.fromEntries(nodes.filter(node => moving.has(node.key)).map(node =>
    [node.key, { x: node.x + delta.x, y: node.y + delta.y }])) };
}

export function boardBounds(nodes, padding = 0) {
  if (!nodes.length) return null;
  const x = Math.min(...nodes.map(node => node.x)) - padding;
  const y = Math.min(...nodes.map(node => node.y)) - padding;
  return { x, y, width: Math.max(...nodes.map(node => node.x + node.width)) + padding - x,
    height: Math.max(...nodes.map(node => node.y + node.height)) + padding - y };
}

export function fitBoard(nodes, size) {
  const bounds = boardBounds(nodes, 70);
  if (!bounds) return initialBoard().viewport;
  const scale = Math.min(1, Math.max(0.15, Math.min(size.width / bounds.width, size.height / bounds.height)));
  return { scale, x: (size.width - bounds.width * scale) / 2 - bounds.x * scale,
    y: (size.height - bounds.height * scale) / 2 - bounds.y * scale };
}

export function zoomBoard(viewport, anchor, requestedScale) {
  const scale = Math.max(0.15, Math.min(2.5, requestedScale));
  return { scale, x: anchor.x - (anchor.x - viewport.x) * scale / viewport.scale,
    y: anchor.y - (anchor.y - viewport.y) * scale / viewport.scale };
}

export function selectBoardRect(nodes, rect) {
  return nodes.filter(node => node.x < rect.x + rect.width && node.x + node.width > rect.x
    && node.y < rect.y + rect.height && node.y + node.height > rect.y).map(node => node.key);
}
