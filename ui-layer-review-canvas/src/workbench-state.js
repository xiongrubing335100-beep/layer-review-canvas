export function createInitialWorkbenchState() {
  return {
    sourceImage: '',
    sourceDataUrl: '',
    sourceName: '',
    sourceSize: { width: 0, height: 0 },
    nodes: [],
    selectedId: '',
  };
}
