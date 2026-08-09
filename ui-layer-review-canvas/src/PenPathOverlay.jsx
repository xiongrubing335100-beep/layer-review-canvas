import { useEffect, useRef, useState } from 'react';
import {
  createPenEditorState,
  focusPenOverlayOwner,
  queuePenEditorEmission,
  reducePenEditor,
  syncPenEditorStateFromProps,
} from './pen-editor-state.js';

function svgPoint(point) {
  return { x: point.x * 100, y: point.y * 100 };
}

function svgPath(path) {
  const anchors = path?.anchors ?? [];
  if (!anchors.length) return '';
  const commands = [`M ${svgPoint(anchors[0]).x} ${svgPoint(anchors[0]).y}`];
  anchors.slice(1).forEach((anchor, index) => {
    const start = anchors[index];
    const out = svgPoint(start.out);
    const incoming = svgPoint(anchor.in);
    const end = svgPoint(anchor);
    commands.push(`C ${out.x} ${out.y} ${incoming.x} ${incoming.y} ${end.x} ${end.y}`);
  });
  if (path.closed && anchors.length > 1) {
    const start = anchors.at(-1);
    const end = anchors[0];
    const out = svgPoint(start.out);
    const incoming = svgPoint(end.in);
    const first = svgPoint(end);
    commands.push(`C ${out.x} ${out.y} ${incoming.x} ${incoming.y} ${first.x} ${first.y} Z`);
  }
  return commands.join(' ');
}

function eventPoint(event, svg) {
  const rect = svg.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

function EditablePenPath({
  path,
  selected,
  draft = false,
  previewPoint,
  onSelectPath,
  onStartAnchorDrag,
  onStartHandleDrag,
  onToggleAnchorMode,
  onCloseDraft,
}) {
  const pathClass = [
    'pen-path',
    `pen-path--${path.kind}`,
    selected ? 'pen-path--selected' : '',
    draft ? 'pen-path--draft' : '',
  ].filter(Boolean).join(' ');
  const lastAnchor = path.anchors.at(-1);

  return (
    <g className={draft ? 'pen-editable-path pen-editable-path--draft' : 'pen-editable-path'}>
      <path className={pathClass} d={svgPath(path)} onPointerDown={onSelectPath} />
      {draft && previewPoint && lastAnchor ? (
        <line
          className={`pen-preview pen-preview--${path.kind}`}
          x1={svgPoint(lastAnchor).x}
          y1={svgPoint(lastAnchor).y}
          x2={svgPoint(previewPoint).x}
          y2={svgPoint(previewPoint).y}
        />
      ) : null}
      {(selected || draft) ? path.anchors.map((anchor, anchorIndex) => {
        const anchorPoint = svgPoint(anchor);
        const isFirstDraftAnchor = draft && anchorIndex === 0 && path.anchors.length >= 3;
        return (
          <g className="pen-control" key={`${path.id}-${anchorIndex}`}>
            {selected ? (
              <>
                <line className="pen-control-line" x1={anchorPoint.x} y1={anchorPoint.y} x2={svgPoint(anchor.in).x} y2={svgPoint(anchor.in).y} />
                <line className="pen-control-line" x1={anchorPoint.x} y1={anchorPoint.y} x2={svgPoint(anchor.out).x} y2={svgPoint(anchor.out).y} />
                <circle
                  className="pen-handle"
                  cx={svgPoint(anchor.in).x}
                  cy={svgPoint(anchor.in).y}
                  r=".65"
                  onPointerDown={(event) => onStartHandleDrag(event, path.id, anchorIndex, 'in')}
                />
                <circle
                  className="pen-handle"
                  cx={svgPoint(anchor.out).x}
                  cy={svgPoint(anchor.out).y}
                  r=".65"
                  onPointerDown={(event) => onStartHandleDrag(event, path.id, anchorIndex, 'out')}
                />
              </>
            ) : null}
            <circle
              className={`pen-anchor ${isFirstDraftAnchor ? 'pen-anchor--close' : ''}`}
              cx={anchorPoint.x}
              cy={anchorPoint.y}
              r={isFirstDraftAnchor ? '1.25' : '.85'}
              onPointerDown={isFirstDraftAnchor
                ? (event) => { event.stopPropagation(); onCloseDraft(event); }
                : (event) => onStartAnchorDrag(event, path.id, anchorIndex, draft)}
              onDoubleClick={draft ? undefined : (event) => onToggleAnchorMode(event, path.id, anchorIndex)}
            />
          </g>
        );
      }) : null}
    </g>
  );
}

export function PenPathOverlay({
  paths = [],
  draft = null,
  selection = null,
  activeKind = 'foreground',
  disabled = false,
  onChange,
  ariaLabel,
}) {
  const initialState = () => ({ ...createPenEditorState(paths), draft, selection });
  const [editorState, setEditorState] = useState(initialState);
  const stateRef = useRef(editorState);
  const emittedRef = useRef([]);
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const [previewPoint, setPreviewPoint] = useState(null);

  useEffect(() => {
    const synced = syncPenEditorStateFromProps({
      current: stateRef.current,
      pendingEmissions: emittedRef.current,
      paths,
      draft,
      selection,
    });
    emittedRef.current = synced.pendingEmissions;
    if (synced.state === stateRef.current) return;
    stateRef.current = synced.state;
    setEditorState(synced.state);
  }, [paths, draft, selection]);

  const apply = (action) => {
    const next = reducePenEditor(stateRef.current, action);
    if (next === stateRef.current) return next;
    stateRef.current = next;
    setEditorState(next);
    const output = {
      paths: next.paths,
      draft: next.draft,
      selection: next.selection,
      history: next.history,
    };
    emittedRef.current = queuePenEditorEmission(emittedRef.current, output, {
      enabled: typeof onChange === 'function',
    });
    onChange?.(output);
    return next;
  };

  const beginDrag = (event, drag) => {
    if (disabled) return;
    event.stopPropagation();
    focusPenOverlayOwner(event.currentTarget);
    svgRef.current?.setPointerCapture?.(event.pointerId);
    dragRef.current = { ...drag, moved: false };
    if (drag.type === 'anchor') apply({ type: 'select-anchor', pathId: drag.pathId, anchorIndex: drag.anchorIndex });
  };

  const handlePointerDown = (event) => {
    if (disabled || event.target !== event.currentTarget) return;
    const svg = event.currentTarget;
    svg.focus();
    if (editorState.selection && !editorState.draft) {
      apply({ type: 'select-path' });
      return;
    }
    svg.setPointerCapture?.(event.pointerId);
    dragRef.current = { type: 'create', pointerId: event.pointerId };
    const point = eventPoint(event, svg);
    setPreviewPoint(point);
    apply({ type: 'pointer-down', point, kind: activeKind });
  };

  const handlePointerMove = (event) => {
    if (disabled) return;
    const point = eventPoint(event, event.currentTarget);
    setPreviewPoint(point);
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.type === 'create') apply({ type: 'pointer-move', point });
    if (drag.type === 'anchor') apply({
      type: 'move-anchor', pathId: drag.pathId, anchorIndex: drag.anchorIndex, point, transient: drag.moved,
    });
    if (drag.type === 'handle') apply({
      type: 'move-handle', pathId: drag.pathId, anchorIndex: drag.anchorIndex, side: drag.side,
      point, breakLink: event.altKey, transient: drag.moved,
    });
    drag.moved = true;
  };

  const endPointer = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.type === 'create') apply({ type: 'pointer-up', point: eventPoint(event, event.currentTarget) });
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
  };

  const handleKeyDown = (event) => {
    const focusedElement = document.activeElement;
    if (disabled || focusedElement !== svgRef.current || focusedElement?.closest?.('input, textarea, [contenteditable="true"]')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      apply({ type: 'cancel-draft' });
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      apply({ type: 'delete-selection' });
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      apply({ type: 'undo' });
    }
  };

  const selectedPathId = editorState.selection?.pathId;
  return (
    <svg
      ref={svgRef}
      className={`pen-overlay ${disabled ? 'pen-overlay--disabled' : ''}`}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      role="application"
      tabIndex={disabled ? -1 : 0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onKeyDown={handleKeyDown}
    >
      {editorState.paths.map((path) => (
        <EditablePenPath
          key={path.id}
          path={path}
          selected={selectedPathId === path.id}
          onSelectPath={(event) => {
            event.stopPropagation();
            focusPenOverlayOwner(event.currentTarget);
            apply({ type: 'select-path', pathId: path.id });
          }}
          onStartAnchorDrag={(event, pathId, anchorIndex, isDraft) => {
            if (!isDraft) beginDrag(event, { type: 'anchor', pathId, anchorIndex, pointerId: event.pointerId });
          }}
          onStartHandleDrag={(event, pathId, anchorIndex, side) => beginDrag(event, {
            type: 'handle', pathId, anchorIndex, side, pointerId: event.pointerId,
          })}
          onToggleAnchorMode={(event, pathId, anchorIndex) => {
            event.stopPropagation();
            apply({ type: 'toggle-anchor-mode', pathId, anchorIndex });
          }}
        />
      ))}
      {editorState.draft ? (
        <EditablePenPath
          path={editorState.draft}
          draft
          previewPoint={previewPoint}
          onCloseDraft={(event) => {
            focusPenOverlayOwner(event.currentTarget);
            apply({ type: 'close-draft' });
          }}
          onStartAnchorDrag={() => {}}
          onStartHandleDrag={() => {}}
          onToggleAnchorMode={() => {}}
        />
      ) : null}
    </svg>
  );
}
