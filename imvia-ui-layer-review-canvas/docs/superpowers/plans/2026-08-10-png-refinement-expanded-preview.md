# PNG Refinement Expanded Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an external expand/restore control to the PNG result editor so pen paths can be drawn on a much larger, aspect-ratio-safe preview without losing editing state.

**Architecture:** Keep one `ResultPreview` and one `PenPathOverlay`; a presentation-only `resultPreviewExpanded` state changes the existing result panel, canvas, and preview sizing. The same normalized pen coordinates and reducer state flow through both sizes, while an Escape handler and lifecycle reset keep the display mode scoped to the current PNG edit session.

**Tech Stack:** React 19, JavaScript ES modules, Lucide React icons, CSS, Node.js built-in test runner, Vite.

## Global Constraints

- The expand control is rendered outside the PNG image surface and never overlays the pen canvas.
- Expanded and normal modes use the same `PenPathOverlay` instance and `resultEditState`.
- Display expansion never rewrites PNG pixels, canvas dimensions, paths, selection, draft, feedback token, undo/redo history, or prompt.
- The preview preserves the authoritative aspect ratio and uses `object-fit: contain`; stretching, cropping, forced resizing, and `cover` are forbidden.
- The right-side workbench controls remain available.
- Escape or the restore button exits expanded mode.
- Exiting result editing, switching the selected layer, switching the active image, or changing the current base PNG resets expanded mode.
- Existing result version gallery, download, queue, polling, and refinement submission behavior remain unchanged.

---

### Task 1: Add the Page-Inline Expanded PNG Editor

**Files:**
- Modify: `src/main.jsx:457-500`
- Modify: `src/main.jsx:583-590`
- Modify: `src/main.jsx:1128-1145`
- Modify: `src/main.jsx:1390-1410`
- Modify: `src/main.jsx:2718-2745`
- Modify: `src/main.jsx:3910-4105`
- Modify: `src/styles.css:1015-1040`
- Modify: `src/styles.css:2510-2735`
- Test: `src/workbench-toolbar.test.mjs`

**Interfaces:**
- Consumes: `resultEditing: boolean`, `resultEditGeometry.canvas`, `resultEditState`, `resultEditPreviewRef`, and the existing `ResultPreview` and `PenPathOverlay` props.
- Produces: `resultPreviewExpanded: boolean`, `ResultPreview.expanded: boolean`, an external `result-editor__preview-toolbar`, and expanded layout modifier classes.

- [ ] **Step 1: Write failing source-contract tests for the external control and shared editor**

Append this test to `src/workbench-toolbar.test.mjs`:

```js
test('PNG refinement exposes an external expanded-preview control without duplicating the pen editor', () => {
  const resultPanel = source.slice(
    source.indexOf('<section className={`guided-result-panel'),
    source.indexOf('</section>', source.indexOf('<section className={`guided-result-panel')),
  );
  const previewEnd = resultPanel.indexOf('</ResultPreview>');
  const toolbarStart = resultPanel.indexOf('className="result-editor__preview-toolbar"');

  assert.match(resultPanel, /const result preview contract: one preview and one pen overlay/);
  assert.ok(previewEnd >= 0);
  assert.ok(toolbarStart > previewEnd, 'expand control must render below, not over, the PNG');
  assert.match(resultPanel.slice(toolbarStart), /放大 PNG 编辑预览/);
  assert.match(resultPanel.slice(toolbarStart), /还原 PNG 编辑预览/);
  assert.match(resultPanel, /aria-pressed={resultPreviewExpanded}/);
  assert.equal((resultPanel.match(/<PenPathOverlay/g) || []).length, 1);
});
```

The implementation will add this stable marker immediately before the preview:

```jsx
{/* const result preview contract: one preview and one pen overlay across display sizes */}
```

- [ ] **Step 2: Write failing tests for state lifetime, Escape, and proportional CSS**

Append:

```js
test('expanded PNG preview is presentation-only and resets with its edit session', () => {
  assert.match(source, /const \[resultPreviewExpanded, setResultPreviewExpanded\] = useState\(false\);/);
  assert.match(source, /if \(!resultPreviewExpanded\) return undefined;[\s\S]*?event\.key === 'Escape'[\s\S]*?setResultPreviewExpanded\(false\)/);
  assert.match(source, /setResultPreviewExpanded\(false\);[\s\S]*?}, \[activeImageId, resultEditBaseKey, selectedId\]\);/);
  assert.doesNotMatch(source, /dispatchResultEdit\([^)]*expand/i);
});

test('expanded PNG editor grows inside the page and preserves image proportions', () => {
  assert.match(styles, /\.guided-result-panel--expanded-editor\s*{[\s\S]*?max-width:\s*none;/);
  assert.match(styles, /\.guided-result-panel__canvas--expanded-editor\s*{[\s\S]*?width:\s*100%;/);
  assert.match(styles, /\.result-preview--result-editor-expanded\s*{[\s\S]*?max-height:\s*calc\(100vh - 220px\);/);
  assert.match(styles, /\.result-preview--result-editor-expanded\s+img\s*{[\s\S]*?object-fit:\s*contain;/);
  assert.match(styles, /\.result-editor__preview-toolbar\s*{[\s\S]*?position:\s*static;/);
  const rule = styles.slice(
    styles.indexOf('.result-preview--result-editor-expanded'),
    styles.indexOf('.result-editor__preview-toolbar'),
  );
  assert.doesNotMatch(rule, /object-fit:\s*cover|aspect-ratio:\s*auto/);
});
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test src/workbench-toolbar.test.mjs
```

Expected: Only the new contracts fail because the state, external toolbar, and expanded styles do not exist.

- [ ] **Step 4: Add presentation state, Escape handling, and lifecycle reset**

In `App`, place the state beside `candidatePreviewExpanded`:

```jsx
const [candidatePreviewExpanded, setCandidatePreviewExpanded] = useState(false);
const [resultPreviewExpanded, setResultPreviewExpanded] = useState(false);
```

Add a dedicated Escape effect:

```jsx
useEffect(() => {
  if (!resultPreviewExpanded) return undefined;
  const collapseResultPreviewOnEscape = (event) => {
    if (event.key === 'Escape') setResultPreviewExpanded(false);
  };
  window.addEventListener('keydown', collapseResultPreviewOnEscape);
  return () => window.removeEventListener('keydown', collapseResultPreviewOnEscape);
}, [resultPreviewExpanded]);
```

Extend the existing result-session reset effect:

```jsx
useEffect(() => {
  setResultEditing(false);
  setResultPreviewExpanded(false);
  dispatchResultEdit({ type: 'reset' });
  setResultEditBasePng(null);
  setResultEditBaseError('');
}, [activeImageId, resultEditBaseKey, selectedId]);
```

When `toggleResultEditing` exits, call `setResultPreviewExpanded(false)` immediately before `setResultEditing(false)`.

- [ ] **Step 5: Give `ResultPreview` a taller proportional height budget**

Add `expanded = false` to its props and replace the current height selection with:

```jsx
const expandedHeight = typeof window === 'undefined'
  ? 720
  : Math.max(420, window.innerHeight - 220);
const maxPreviewHeight = expanded
  ? expandedHeight
  : className.includes('guided-result')
    ? 300
    : className.includes('node') ? 118 : null;
```

Continue using the existing `resultPreviewMaxWidth(previewPixels, maxPreviewHeight)` and inline `aspectRatio: aspect`. This changes CSS display size only.

- [ ] **Step 6: Render one external expand/restore control below the existing preview**

Add expanded modifiers to the result section, body, canvas, and preview. Pass `expanded={resultEditing && resultPreviewExpanded}` to the existing `ResultPreview`. Immediately after its closing tag render:

```jsx
{resultEditing ? (
  <div className="result-editor__preview-toolbar">
    <span>{resultPreviewExpanded ? '大图编辑模式' : '需要更大画面时可放大编辑'}</span>
    <button
      type="button"
      className="result-editor__preview-toggle"
      aria-label={resultPreviewExpanded ? '还原 PNG 编辑预览' : '放大 PNG 编辑预览'}
      aria-pressed={resultPreviewExpanded}
      title={resultPreviewExpanded ? '还原预览' : '放大预览'}
      onClick={() => setResultPreviewExpanded((current) => !current)}
    >
      {resultPreviewExpanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
    </button>
  </div>
) : null}
```

The existing `PenPathOverlay` remains exactly where it is and retains these existing props: `ref`, `paths`, `draft`, `selection`, `feedbackToken`, `activeKind`, `disabled`, `onChange`, and `ariaLabel`.

Use these modifier expressions:

```jsx
<section className={`guided-result-panel ${resultPreviewExpanded ? 'guided-result-panel--expanded-editor' : ''} ${activeSelectedJob ? `guided-result-panel--${jobStatus(activeSelectedJob.status).tone}` : ''}`}>
<div className={`guided-result-panel__body ${resultPreviewExpanded ? 'guided-result-panel__body--expanded-editor' : ''} ${resultEditing ? 'guided-result-panel__body--editing' : ''} ${!resultEditing && selectedResultHistory.length > 1 ? 'guided-result-panel__body--versions' : ''}`}>
<div className={`guided-result-panel__canvas ${resultEditing ? 'guided-result-panel__canvas--editing' : ''} ${resultPreviewExpanded ? 'guided-result-panel__canvas--expanded-editor' : ''}`}>
className={`result-preview--guided-result ${resultEditing ? `result-preview--result-editor result-preview--tool-${resultEditTool}` : ''} ${resultPreviewExpanded ? 'result-preview--result-editor-expanded' : ''}`}
```

- [ ] **Step 7: Add page-inline expanded layout styles**

Add:

```css
.guided-result-panel--expanded-editor {
  max-width: none;
}

.guided-result-panel__body--expanded-editor {
  min-height: calc(100vh - 170px);
  max-height: none;
  align-items: start;
  overflow: auto;
}

.guided-result-panel__canvas--expanded-editor {
  width: 100%;
  max-width: none;
}

.result-preview--result-editor-expanded {
  max-height: calc(100vh - 220px);
}

.result-preview--result-editor-expanded img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.result-editor__preview-toolbar {
  position: static;
  width: 100%;
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.result-editor__preview-toolbar > span {
  color: #8d9b90;
  font-size: 9px;
}

.result-editor__preview-toggle {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, .18);
  border-radius: 7px;
  color: #ecefec;
  background: #191d1a;
}
```

Add hover and `:focus-visible` rules consistent with `.candidate-preview-toggle`. Do not use `position: absolute` or `position: fixed`.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
node --test src/workbench-toolbar.test.mjs src/pen-path.test.mjs src/pen-editor-state.test.mjs src/result-refinement-ui.test.mjs
```

Expected: All focused tests pass.

- [ ] **Step 9: Run full regression and production build**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: All Node tests pass; Vite exits 0 without warnings; diff check is clean.

- [ ] **Step 10: Manually verify the live workbench**

Use a successful PNG result:

1. Enter “编辑结果” and draw a closed path.
2. Click the icon below the image; verify the PNG becomes substantially larger without stretching or cropping.
3. Verify the right inspector remains visible.
4. Move one anchor and verify the original path, selection, history, and prompt remain intact.
5. Restore and verify the moved anchor retains the same normalized image position.
6. Expand again and press Escape; verify normal preview returns.
7. Exit and re-enter editing; verify it starts at normal size.

- [ ] **Step 11: Commit the implementation**

```bash
git add src/main.jsx src/styles.css src/workbench-toolbar.test.mjs
git commit -m "feat: expand PNG refinement preview"
```

Expected: The commit contains only the expanded-preview implementation and tests; `git status --short` is clean.
