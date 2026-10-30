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
const PENDING_EMISSION_LIMIT = 50;

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
    future: [],
  };
}

function replacePath(paths, pathId, nextPath) {
  return paths.map((path) => (path.id === pathId ? nextPath : path));
}

function hasSamePoint(first, second) {
  return first?.x === second?.x && first?.y === second?.y;
}

function initialNextPathId(paths) {
  return (paths ?? []).reduce((nextId, path) => {
    const match = /^pen-(\d+)$/.exec(path?.id ?? '');
    return match ? Math.max(nextId, Number(match[1]) + 1) : nextId;
  }, 1);
}

function allocatePathId(state, preferredId) {
  const ids = new Set(state.paths.map((path) => path.id));
  if (preferredId && !ids.has(preferredId)) return { id: preferredId, nextPathId: state.nextPathId };
  let nextPathId = Math.max(1, state.nextPathId);
  while (ids.has(`pen-${nextPathId}`)) nextPathId += 1;
  return { id: `pen-${nextPathId}`, nextPathId: nextPathId + 1 };
}

export function focusPenOverlayOwner(element) {
  const owner = element?.ownerSVGElement ?? element;
  owner?.focus?.();
  return owner ?? null;
}

function createDraft(state, point, kind, id) {
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
    future: [],
    nextPathId: initialNextPathId(paths),
    draftHistoryStart: null,
    pointerStart: null,
  };
}

export function penEditorActionForKeyboard(event = {}) {
  const modifier = event.metaKey || event.ctrlKey;
  const key = String(event.key || '').toLowerCase();
  if (modifier && key === 'z') return { type: event.shiftKey ? 'redo' : 'undo' };
  if (modifier && key === 'y') return { type: 'redo' };
  return null;
}

export function syncPenEditorStateFromProps({
  current,
  pendingEmissions = [],
  paths = [],
  draft = null,
  selection = null,
  feedbackToken = null,
}) {
  const emissionIndex = feedbackToken === null ? -1 : pendingEmissions.findIndex((emission) => (
    feedbackToken === emission.feedbackToken
    && paths === emission.paths
    && draft === emission.draft
    && selection === emission.selection
  ));
  if (emissionIndex >= 0) {
    return {
      state: current,
      pendingEmissions: pendingEmissions.filter((_, index) => index !== emissionIndex),
    };
  }
  return {
    state: { ...createPenEditorState(paths), draft, selection },
    pendingEmissions: [],
  };
}

export function queuePenEditorEmission(pendingEmissions = [], output, { enabled = true } = {}) {
  if (!enabled || !output) return [];
  return [...pendingEmissions.slice(-(PENDING_EMISSION_LIMIT - 1)), output];
}

export function reducePenEditor(state, action = {}) {
  const current = state ?? createPenEditorState();

  switch (action.type) {
    case 'pointer-down': {
      if (!action.point) return current;
      const allocation = current.draft ? null : allocatePathId(current, action.pathId);
      const draft = current.draft
        ? appendAnchor(current.draft, action.point)
        : createDraft(current, action.point, action.kind, allocation.id);
      return withHistory(current, {
        draft,
        nextPathId: current.draft ? current.nextPathId : allocation.nextPathId,
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

    case 'set-path-requirements': {
      const path = current.paths.find(candidate => candidate.id === action.pathId);
      if (!path?.closed || typeof action.value !== 'string' || (path.requirements ?? '') === action.value) return current;
      return withHistory(current, { paths: replacePath(current.paths, path.id, { ...path, requirements: action.value }) });
    }

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
        future: [...current.future.slice(-(HISTORY_LIMIT - 1)), snapshot(current)],
        pointerStart: null,
      };
    }

    case 'redo': {
      const next = current.future.at(-1);
      if (!next) return current;
      return {
        ...current,
        ...next,
        history: [...current.history.slice(-(HISTORY_LIMIT - 1)), snapshot(current)],
        future: current.future.slice(0, -1),
        pointerStart: null,
      };
    }

    default:
      return current;
  }
}
