export function documentInput(overrides = {}) {
  return { documentId: 'doc-test', workbenchSessionId: 'session-test', mode: 'poster',
    source: { path: '/fixture/source.png', width: 1562, height: 3396, fingerprint: 'source-test', revision: 1 }, ...overrides };
}

export function layerInput(overrides = {}) {
  return { layerId: 'a', name: '主体', displayCategory: '角色', processingCategory: 'subject',
    bounds: { x: 129, y: 1522, width: 1280, height: 1451 }, paths: [], requirements: '保留原位',
    strategy: { operation: 'extract', removeBackground: true, repairPaths: [] }, ...overrides };
}
