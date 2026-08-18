const GROUP_ORIGIN = { x: 90, y: 100 };
const GROUP_WIDTH = 1180;
const GROUP_HEIGHT = 960;
const GROUP_GAP_X = 60;
const GROUP_GAP_Y = 70;
const CHILD_OFFSET_X = 360;
const CHILD_COLUMN_GAP = 330;
const CHILD_OFFSET_Y = 40;
const CHILD_ROW_GAP = 250;

export function arrangeImageDocuments(documents, { columns = 2 } = {}) {
  const safeColumns = Math.max(1, Math.floor(columns));
  return documents.map((document, index) => {
    const groupColumn = index % safeColumns;
    const groupRow = Math.floor(index / safeColumns);
    const sourceNodePosition = {
      x: GROUP_ORIGIN.x + groupColumn * (GROUP_WIDTH + GROUP_GAP_X),
      y: GROUP_ORIGIN.y + groupRow * (GROUP_HEIGHT + GROUP_GAP_Y),
    };
    const nodes = (document.nodes || []).map((node, nodeIndex) => ({
      ...node,
      x: sourceNodePosition.x + CHILD_OFFSET_X + (nodeIndex % 2) * CHILD_COLUMN_GAP,
      y: sourceNodePosition.y + CHILD_OFFSET_Y + Math.floor(nodeIndex / 2) * CHILD_ROW_GAP,
    }));
    const resultNodePositions = Object.fromEntries(
      Object.keys(document.resultNodePositions || {}).map((id, resultIndex) => [id, {
        x: sourceNodePosition.x + CHILD_OFFSET_X + (resultIndex % 2) * CHILD_COLUMN_GAP,
        y: sourceNodePosition.y + CHILD_OFFSET_Y + 3 * CHILD_ROW_GAP + Math.floor(resultIndex / 2) * CHILD_ROW_GAP,
      }]),
    );
    return {
      ...document,
      sourceNodePosition,
      nodes,
      resultNodePositions,
      canvasLayoutVersion: 1,
    };
  });
}
