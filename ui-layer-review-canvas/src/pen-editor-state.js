import {
  appendAnchor,
  closePenPath,
  createPenPath,
  deleteAnchor,
  moveAnchor,
  moveHandle,
  toggleAnchorMode,
} from './pen-path.js';

const HISTORY_LIMIT = 50;

function snapshot(state) {
  return {
    paths: state.paths,
    draft: state.draft,
    selection: state.selection,
    nextPathId: state.nextPathId,
    draftHistoryStart: state.draftHistoryStart,
  };
}

function withHistory(state, changes) {
  return {
    ...state,
    ...changes,
    history: [...state.history.slice(-(HISTORY_LIMIT - 1)), snapshot(state)],
  };
}

function replacePath(paths, pathId, nextPath) {
  return paths.map((path) => (path.id === pathId ? nextPath : path));
}

function hasSamePoint(first, second) {
  return first?.x === second?.x && first?.y === second?.y;
}

function createDraft(state, point, kind, pathId) {
  const id = pathId ?? `pen-${state.nextPathId}`;
  return {
    ...createPenPath({ id, kind: kind ?? 'foreground', point }),
    order: state.paths.length,
  };
}

export function createPenEditorState(paths = []) {
  return {
    paths: Array.isArray(paths) ? paths : [],
    draft: null,
    selection: null,
    history: [],
    nextPathId: Array.isArray(paths) ? paths.length + 1 : 1,
    draftHistoryStart: null,
    pointerStart: null,
  };
}

export function reducePenEditor(state, action = {}) {
  const current = state ?? createPenEditorState();

  switch (action.type) {
    case 'pointer-down': {
      if (!action.point) return current;
      const draft = current.draft
        ? appendAnchor(current.draft, action.point)
        : createDraft(current, action.point, action.kind, action.pathId);
      return withHistory(current, {
        draft,
        nextPathId: current.draft ? current.nextPathId : current.nextPathId + 1,
        draftHistoryStart: current.draft ? current.draftHistoryStart : current.history.length,
        pointerStart: { anchorIndex: draft.anchors.length - 1, point: action.point },
      });
    }

    case 'pointer-move': {
      if (!current.draft || !current.pointerStart || !action.point) return current;
      const { anchorIndex } = current.pointerStart;
      const draft = hasSamePoint(current.pointerStart.point, action.point)
        ? current.draft
        : moveHandle(current.draft, anchorIndex, 'out', action.point);
      return { ...current, draft };
    }

    case 'pointer-up': {
      const moved = action.point
        ? reducePenEditor(current, { type: 'pointer-move', point: action.point })
        : current;
      return moved.pointerStart ? { ...moved, pointerStart: null } : moved;
    }

    case 'close-draft': {
      if (!current.draft) return current;
      const closed = closePenPath(current.draft);
      if (!closed.closed) return current;
      return withHistory(current, {
        paths: [...current.paths, closed],
        draft: null,
        selection: { pathId: closed.id },
        pointerStart: null,
        draftHistoryStart: null,
      });
    }

    case 'cancel-draft':
      return current.draft
        ? {
          ...current,
          draft: null,
          history: current.history.slice(0, current.draftHistoryStart ?? current.history.length),
          pointerStart: null,
          draftHistoryStart: null,
        }
        : current;

    case 'select-path':
      return action.pathId && current.paths.some((path) => path.id === action.pathId)
        ? { ...current, selection: { pathId: action.pathId } }
        : { ...current, selection: null };

    case 'select-anchor':
      return current.paths.some((path) => path.id === action.pathId && path.anchors[action.anchorIndex])
        ? { ...current, selection: { pathId: action.pathId, anchorIndex: action.anchorIndex } }
        : current;

    case 'move-anchor': {
      const path = current.paths.find((candidate) => candidate.id === action.pathId);
      if (!path || !action.point) return current;
      const changes = {
        paths: replacePath(current.paths, path.id, moveAnchor(path, action.anchorIndex, action.point)),
      };
      return action.transient ? { ...current, ...changes } : withHistory(current, changes);
    }

    case 'move-handle': {
      const path = current.paths.find((candidate) => candidate.id === action.pathId);
      if (!path || !action.point) return current;
      const changes = {
        paths: replacePath(current.paths, path.id, moveHandle(path, action.anchorIndex, action.side, action.point, {
          breakLink: action.breakLink === true,
        })),
      };
      return action.transient ? { ...current, ...changes } : withHistory(current, changes);
    }

    case 'toggle-anchor-mode': {
      const path = current.paths.find((candidate) => candidate.id === action.pathId);
      if (!path) return current;
      return withHistory(current, {
        paths: replacePath(current.paths, path.id, toggleAnchorMode(path, action.anchorIndex)),
      });
    }

    case 'delete-path': {
      if (!current.paths.some((path) => path.id === action.pathId)) return current;
      return withHistory(current, {
        paths: current.paths.filter((path) => path.id !== action.pathId),
        selection: current.selection?.pathId === action.pathId ? null : current.selection,
      });
    }

    case 'delete-selection': {
      const selected = current.selection;
      if (!selected?.pathId) return current;
      const path = current.paths.find((candidate) => candidate.id === selected.pathId);
      if (!path) return { ...current, selection: null };
      if (Number.isInteger(selected.anchorIndex)) {
        const nextPath = deleteAnchor(path, selected.anchorIndex);
        const paths = !nextPath || nextPath.anchors.length < 3
          ? current.paths.filter((candidate) => candidate.id !== path.id)
          : replacePath(current.paths, path.id, nextPath);
        return withHistory(current, { paths, selection: null });
      }
      return reducePenEditor(current, { type: 'delete-path', pathId: path.id });
    }

    case 'clear':
      return current.paths.length || current.draft
        ? withHistory(current, { paths: [], draft: null, selection: null, pointerStart: null })
        : current;

    case 'undo': {
      const previous = current.history.at(-1);
      if (!previous) return current;
      return {
        ...current,
        ...previous,
        history: current.history.slice(0, -1),
        pointerStart: null,
      };
    }

    default:
      return current;
  }
}
