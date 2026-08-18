import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { draftPreviewSegment } from './pen-path.js';
import {
  createPenEditorState,
  focusPenOverlayOwner,
  penEditorActionForKeyboard,
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

function screenSpaceRadii(overlaySize, radius) {
  return {
    rx: (radius * 100) / Math.max(1, overlaySize.width),
    ry: (radius * 100) / Math.max(1, overlaySize.height),
  };
}

function EditablePenPath({
  path,
  selected,
  draft = false,
  previewPoint,
  overlaySize,
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
  const previewSegment = draft && lastAnchor && previewPoint
    ? draftPreviewSegment(lastAnchor, previewPoint)
    : null;

  return (
    <g className={draft ? 'pen-editable-path pen-editable-path--draft' : 'pen-editable-path'}>
      <path className={pathClass} d={svgPath(path)} onPointerDown={onSelectPath} />
      {previewSegment ? (
        <path
          className={`pen-preview pen-preview--${path.kind}`}
          d={`M ${svgPoint(previewSegment.start).x} ${svgPoint(previewSegment.start).y} C ${svgPoint(previewSegment.control1).x} ${svgPoint(previewSegment.control1).y} ${svgPoint(previewSegment.control2).x} ${svgPoint(previewSegment.control2).y} ${svgPoint(previewSegment.end).x} ${svgPoint(previewSegment.end).y}`}
          fill="none"
        />
      ) : null}
      {(selected || draft) ? path.anchors.map((anchor, anchorIndex) => {
        const anchorPoint = svgPoint(anchor);
        const isFirstDraftAnchor = draft && anchorIndex === 0 && path.anchors.length >= 3;
        const anchorRadii = screenSpaceRadii(overlaySize, isFirstDraftAnchor ? 7 : 5);
        const handleRadii = screenSpaceRadii(overlaySize, 4);
        return (
          <g className="pen-control" key={`${path.id}-${anchorIndex}`}>
            {selected ? (
              <>
                <line className="pen-control-line" x1={anchorPoint.x} y1={anchorPoint.y} x2={svgPoint(anchor.in).x} y2={svgPoint(anchor.in).y} />
                <line className="pen-control-line" x1={anchorPoint.x} y1={anchorPoint.y} x2={svgPoint(anchor.out).x} y2={svgPoint(anchor.out).y} />
                <ellipse
                  className="pen-handle"
                  cx={svgPoint(anchor.in).x}
                  cy={svgPoint(anchor.in).y}
                  rx={handleRadii.rx}
                  ry={handleRadii.ry}
                  onPointerDown={(event) => onStartHandleDrag(event, path.id, anchorIndex, 'in')}
                />
                <ellipse
                  className="pen-handle"
                  cx={svgPoint(anchor.out).x}
                  cy={svgPoint(anchor.out).y}
                  rx={handleRadii.rx}
                  ry={handleRadii.ry}
                  onPointerDown={(event) => onStartHandleDrag(event, path.id, anchorIndex, 'out')}
                />
              </>
            ) : null}
            <ellipse
              className={`pen-anchor ${isFirstDraftAnchor ? 'pen-anchor--close' : ''}`}
              cx={anchorPoint.x}
              cy={anchorPoint.y}
              rx={anchorRadii.rx}
              ry={anchorRadii.ry}
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

export const PenPathOverlay = forwardRef(function PenPathOverlay({
  paths = [],
  draft = null,
  selection = null,
  activeKind = 'foreground',
  disabled = false,
  onChange,
  ariaLabel,
  feedbackToken = null,
}, ref) {
  const initialState = () => ({ ...createPenEditorState(paths), draft, selection });
  const [editorState, setEditorState] = useState(initialState);
  const stateRef = useRef(editorState);
  const emittedRef = useRef([]);
  const emissionOriginRef = useRef({});
  const emissionSequenceRef = useRef(0);
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const [previewPoint, setPreviewPoint] = useState(null);
  const [overlaySize, setOverlaySize] = useState({ width: 100, height: 100 });

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const updateSize = () => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setOverlaySize((current) => (
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height }
      ));
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateSize);
      return () => window.removeEventListener('resize', updateSize);
    }
    const observer = new ResizeObserver(updateSize);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const synced = syncPenEditorStateFromProps({
      current: stateRef.current,
      pendingEmissions: emittedRef.current,
      paths,
      draft,
      selection,
      feedbackToken,
    });
    emittedRef.current = synced.pendingEmissions;
    if (synced.state === stateRef.current) return;
    stateRef.current = synced.state;
    setEditorState(synced.state);
  }, [paths, draft, selection, feedbackToken]);

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
      future: next.future,
      feedbackToken: {
        origin: emissionOriginRef.current,
        sequence: emissionSequenceRef.current += 1,
      },
    };
    emittedRef.current = queuePenEditorEmission(emittedRef.current, output, {
      enabled: typeof onChange === 'function',
    });
    onChange?.(output);
    return next;
  };

  useImperativeHandle(ref, () => ({
    undo: () => apply({ type: 'undo' }),
    redo: () => apply({ type: 'redo' }),
    deleteSelection: () => apply({ type: 'delete-selection' }),
    cancelDraft: () => apply({ type: 'cancel-draft' }),
    clear: () => apply({ type: 'clear' }),
    get canUndo() { return stateRef.current.history.length > 0; },
    get canRedo() { return stateRef.current.future.length > 0; },
    get canDeleteSelection() { return Boolean(stateRef.current.selection?.pathId); },
  }));

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
    const action = penEditorActionForKeyboard(event);
    if (action) {
      event.preventDefault();
      apply(action);
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
          overlaySize={overlaySize}
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
          overlaySize={overlaySize}
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
});
