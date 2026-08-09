# Pen Path and PNG Result Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every freehand annotation brush with one shared Photoshop-style Bézier pen editor and make PNG result refinement preserve the last successful PNG, accept independent text instructions, and execute through a supported result-refinement route.

**Architecture:** Add a dependency-free normalized Bézier path model and an SVG overlay component shared by the layer-review and PNG-result editors. Extract result-version selection and refinement-plan construction from `main.jsx` into pure modules, then extend preflight, prompt generation, and the existing ImageGen canvas/finalizer scripts with an explicit `result_refinement` contract.

**Tech Stack:** React, SVG, modern JavaScript ES modules, Node `node:test`, Vite, Python 3, Pillow, existing Codex bridge and plugin skill.

## Global Constraints

- Do not add Fabric.js, Konva, or another canvas framework.
- Store pen anchors and handles in normalized `0..1` coordinates.
- Require at least three distinct anchors and a closed path before a path is submit-eligible.
- Closed paths use a dashed outline and semantic translucent fill; drafts have no fill.
- Preserve the existing keep, exclude, later-annotation-wins, and boundary-priority semantics.
- Remove all user-facing freehand brush entries and brush-size controls from both editors.
- A PNG revision must use the latest successful transparent PNG and its decoded pixel dimensions, not the original design image or logical placement dimensions.
- Pending, failed, and cancelled revisions must not replace the visible successful PNG.
- A revision may be submitted with non-empty text, one or more valid closed paths, or both.
- Only a completed, validated PNG revision may become the new base result.
- Preserve unrelated existing worktree changes; stage and commit only files belonging to the current task.

---

### Task 1: Normalized Bézier path model

**Files:**
- Create: `src/pen-path.js`
- Create: `src/pen-path.test.mjs`

**Interfaces:**
- Produces: `createPenPath({ id, kind, point }) -> PenPath`
- Produces: `appendAnchor(path, point, handles?) -> PenPath`
- Produces: `closePenPath(path) -> PenPath`
- Produces: `moveAnchor(path, index, point) -> PenPath`
- Produces: `moveHandle(path, index, side, point, { breakLink }) -> PenPath`
- Produces: `toggleAnchorMode(path, index) -> PenPath`
- Produces: `deleteAnchor(path, index) -> PenPath | null`
- Produces: `isValidClosedPath(path) -> boolean`
- Produces: `pathToSvgD(path, { close }) -> string`
- Produces: `flattenPenPath(path, { width, height, maxErrorPx }) -> Array<{x, y}>`

- [ ] **Step 1: Write failing path-model tests**

```js
test('a path needs three distinct anchors before it can close', () => {
  let path = createPenPath({ id: 'p1', kind: 'foreground', point: { x: .1, y: .1 } });
  path = appendAnchor(path, { x: .9, y: .1 });
  assert.equal(isValidClosedPath(closePenPath(path)), false);
  path = appendAnchor(path, { x: .9, y: .9 });
  assert.equal(isValidClosedPath(closePenPath(path)), true);
});

test('linked handles stay collinear until option breaks the link', () => {
  const path = closePenPath(appendAnchor(appendAnchor(
    createPenPath({ id: 'p1', kind: 'boundary', point: { x: .1, y: .1 } }),
    { x: .9, y: .1 },
  ), { x: .5, y: .9 }));
  const linked = moveHandle(path, 0, 'out', { x: .3, y: .1 }, { breakLink: false });
  assert.deepEqual(linked.anchors[0].in, { x: -.1, y: .1 });
  const broken = moveHandle(linked, 0, 'out', { x: .3, y: .2 }, { breakLink: true });
  assert.deepEqual(broken.anchors[0].in, linked.anchors[0].in);
  assert.equal(broken.anchors[0].handlesLinked, false);
});

test('flattening a closed curve is deterministic and stays inside source pixels', () => {
  const points = flattenPenPath(curvedFixture(), { width: 640, height: 360, maxErrorPx: 1 });
  assert.deepEqual(points, flattenPenPath(curvedFixture(), { width: 640, height: 360, maxErrorPx: 1 }));
  assert.ok(points.length > curvedFixture().anchors.length);
  assert.ok(points.every(({ x, y }) => x >= 0 && x <= 640 && y >= 0 && y <= 360));
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test src/pen-path.test.mjs`

Expected: FAIL because `src/pen-path.js` and its exports do not exist.

- [ ] **Step 3: Implement immutable path operations and adaptive cubic sampling**

```js
export function createPenPath({ id, kind, point }) {
  return { id, kind, shape: 'bezier_path', closed: false, anchors: [straightAnchor(point)], order: 0 };
}

export function closePenPath(path) {
  return isDistinctAnchorSet(path.anchors) ? { ...path, closed: true } : path;
}

export function isValidClosedPath(path) {
  return path?.shape === 'bezier_path'
    && path.closed === true
    && isDistinctAnchorSet(path.anchors)
    && path.anchors.every(validAnchor);
}
```

Implement SVG `M/C/Z` serialization and recursively subdivide each cubic segment until its control-point distance from the chord is at most `maxErrorPx`. Clamp emitted pixel samples to the declared source dimensions and deduplicate adjacent identical samples.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test src/pen-path.test.mjs`

Expected: all path-model tests PASS.

- [ ] **Step 5: Commit the path model**

```bash
git add src/pen-path.js src/pen-path.test.mjs
git commit -m "feat: add normalized bezier path model"
```

### Task 2: Shared SVG pen interaction state and overlay

**Files:**
- Create: `src/pen-editor-state.js`
- Create: `src/pen-editor-state.test.mjs`
- Create: `src/PenPathOverlay.jsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: path operations from `src/pen-path.js`
- Produces: `createPenEditorState(paths?) -> PenEditorState`
- Produces: `reducePenEditor(state, action) -> PenEditorState`
- Produces: `<PenPathOverlay paths draft selection activeKind disabled onChange ariaLabel />`
- `onChange` receives `{ paths, draft, selection, history }`

- [ ] **Step 1: Write failing editor-state tests**

```js
test('clicks append anchors and clicking the first anchor closes the draft', () => {
  let state = createPenEditorState();
  state = reducePenEditor(state, { type: 'pointer-down', point: { x: .1, y: .1 }, kind: 'foreground' });
  state = reducePenEditor(state, { type: 'pointer-up', point: { x: .1, y: .1 } });
  state = addClick(state, .9, .1);
  state = addClick(state, .9, .9);
  state = reducePenEditor(state, { type: 'close-draft' });
  assert.equal(state.paths.length, 1);
  assert.equal(state.paths[0].closed, true);
  assert.equal(state.draft, null);
});

test('escape discards only the open draft and undo restores the previous closed path state', () => {
  const drafted = addClick(createPenEditorState([closedFixture()]), .2, .2);
  const cancelled = reducePenEditor(drafted, { type: 'cancel-draft' });
  assert.equal(cancelled.paths.length, 1);
  const deleted = reducePenEditor(cancelled, { type: 'delete-path', pathId: closedFixture().id });
  assert.equal(deleted.paths.length, 0);
  assert.equal(reducePenEditor(deleted, { type: 'undo' }).paths.length, 1);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test src/pen-editor-state.test.mjs`

Expected: FAIL because the pen editor reducer is missing.

- [ ] **Step 3: Implement the reducer and SVG overlay**

Use one reducer action for each user-visible operation: pointer down/move/up, close draft, cancel draft, select path, select anchor, move anchor, move handle, toggle anchor mode, delete selection, clear, and undo. Store complete snapshots in a bounded history of 50 entries.

```jsx
export function PenPathOverlay({
  paths,
  draft,
  selection,
  activeKind,
  disabled = false,
  onChange,
  ariaLabel,
}) {
  return (
    <svg className="pen-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label={ariaLabel}>
      {paths.map((path) => <EditablePenPath key={path.id} path={path} selected={selection?.pathId === path.id} />)}
      {draft ? <EditablePenPath path={draft} draft /> : null}
    </svg>
  );
}
```

Translate normalized coordinates to the `0..100` SVG viewBox only at render time. Use pointer capture for drags. `Option/Alt` sets `breakLink: true`; double-click toggles anchor mode; `Escape`, `Backspace/Delete`, and `Command/Ctrl+Z` are handled only while the overlay owns focus and not while a textarea or input is focused.

- [ ] **Step 4: Add visual styles for paths, handles, drafts, and semantic fill**

```css
.pen-path { vector-effect: non-scaling-stroke; stroke-dasharray: 6 4; fill-opacity: .18; }
.pen-path--foreground { stroke: #41e5a4; fill: #41e5a4; }
.pen-path--background { stroke: #ff8f5b; fill: #ff8f5b; }
.pen-path--boundary { stroke: #c480ff; fill: #c480ff; }
.pen-path--draft { stroke-dasharray: none; fill: none; }
.pen-anchor, .pen-handle { vector-effect: non-scaling-stroke; }
```

- [ ] **Step 5: Run focused tests and build**

Run: `node --test src/pen-path.test.mjs src/pen-editor-state.test.mjs`

Run: `npm run build`

Expected: tests PASS and Vite builds without JSX or import errors.

- [ ] **Step 6: Commit the shared editor**

```bash
git add src/pen-editor-state.js src/pen-editor-state.test.mjs src/PenPathOverlay.jsx src/styles.css
git commit -m "feat: add shared SVG pen editor"
```

### Task 3: Replace layer-review brushes with the pen editor

**Files:**
- Create: `src/annotation-plan.js`
- Create: `src/annotation-plan.test.mjs`
- Modify: `src/main.jsx`
- Modify: `src/styles.css`
- Modify: `src/workbench-toolbar.test.mjs`

**Interfaces:**
- Consumes: `<PenPathOverlay />` and `flattenPenPath()`
- Produces: `annotationForPlan(mark, bounds, sourceSize, orderIndex) -> plan annotation`
- Produces: `bezier_path` annotations containing original anchors plus `source_polygon_pixels`

- [ ] **Step 1: Write failing serialization and toolbar tests**

```js
test('serializes a closed pen path into editable anchors and source pixel samples', () => {
  const annotation = annotationForPlan(closedFixture(), { x: 10, y: 20, width: 50, height: 40 }, { width: 1000, height: 500 }, 0);
  assert.equal(annotation.shape, 'bezier_path');
  assert.deepEqual(annotation.anchors, closedFixture().anchors);
  assert.ok(annotation.source_polygon_pixels.length >= 3);
  assert.equal(annotation.coordinate_space, 'selected_region_normalized');
});

test('workbench exposes pen tools and no brush-size controls', async () => {
  const source = await readFile(new URL('./main.jsx', import.meta.url), 'utf8');
  assert.match(source, /保留钢笔/);
  assert.match(source, /排除钢笔/);
  assert.match(source, /边界钢笔/);
  assert.doesNotMatch(source, /画笔大小|brushSize/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test src/annotation-plan.test.mjs src/workbench-toolbar.test.mjs`

Expected: FAIL because Bézier serialization and pen labels are absent.

- [ ] **Step 3: Extract and extend annotation serialization**

Move `annotationForPlan` out of `main.jsx`. Preserve rectangle serialization for crop annotations, preserve read-only rendering of already stored legacy strokes, and serialize new paths as:

```js
{
  id: mark.id,
  order_index: orderIndex,
  kind: mark.kind,
  semantics: semanticForKind(mark.kind),
  shape: 'bezier_path',
  coordinate_space: 'selected_region_normalized',
  anchors: mark.anchors,
  closed: true,
  source_polygon_pixels: flattenPenPath(mark, {
    width: region.width,
    height: region.height,
    maxErrorPx: 1,
  }).map(({ x, y }) => ({ x: region.x + x, y: region.y + y })),
}
```

- [ ] **Step 4: Replace the layer-review brush state and handlers**

Remove `brushSize`, freehand pointer gesture refs, stroke drafts, and the three brush-size-dependent handlers. Keep `marks` as the persisted closed-path collection and integrate `PenPathOverlay` with only marks for `selectedId`.

Rename kinds at the UI boundary to `foreground`, `background`, and `boundary`; accept legacy `brush` as `boundary` only when reading existing stored data. Replace button icons with Lucide `PenTool`, update helper copy, and retain hide/show annotations, undo, delete selected, and clear actions.

- [ ] **Step 5: Run focused tests and build**

Run: `node --test src/pen-path.test.mjs src/pen-editor-state.test.mjs src/annotation-plan.test.mjs src/workbench-toolbar.test.mjs`

Run: `npm run build`

Expected: tests PASS; no freehand creation control or brush-size control remains in the layer-review editor.

- [ ] **Step 6: Commit the layer-review integration**

```bash
git add src/annotation-plan.js src/annotation-plan.test.mjs src/main.jsx src/styles.css src/workbench-toolbar.test.mjs
git commit -m "feat: replace review brushes with pen paths"
```

### Task 4: Stable PNG result selection and version state

**Files:**
- Create: `src/result-version-state.js`
- Create: `src/result-version-state.test.mjs`
- Modify: `src/main.jsx`

**Interfaces:**
- Produces: `resolveNodeResultState({ jobs, node, sourceSize }) -> { baseResult, pendingRevision, failedRevision, history }`
- `baseResult` is the newest completed job with a valid image for the node.
- `pendingRevision` and `failedRevision` never replace `baseResult`.

- [ ] **Step 1: Write failing result-version tests**

```js
test('a pending revision keeps the previous completed PNG visible', () => {
  const state = resolveNodeResultState({
    jobs: [completedJob('base', 'base.png'), pendingJob('revision', 'base')],
    node: fixtureNode,
    sourceSize: { width: 658, height: 1424 },
  });
  assert.equal(state.baseResult.job.id, 'base');
  assert.equal(state.baseResult.image.name, 'base.png');
  assert.equal(state.pendingRevision.job.id, 'revision');
});

test('a failed revision keeps the base PNG and a completed revision atomically becomes the base', () => {
  assert.equal(resolveState([baseJob, failedRevision]).baseResult.job.id, 'base');
  assert.equal(resolveState([baseJob, completedRevision]).baseResult.job.id, 'revision-complete');
  assert.deepEqual(resolveState([baseJob, completedRevision]).history.map((item) => item.job.id), ['base', 'revision-complete']);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test src/result-version-state.test.mjs`

Expected: FAIL because result-version selection is still embedded in `main.jsx`.

- [ ] **Step 3: Implement result-state resolution**

Classify jobs by status and `parentJobId`/`parent_job_id`. Resolve the image using the existing normalized node filename rule. Ignore pending, failed, cancelled, or image-less jobs when selecting `baseResult`. Sort successful history by submission/completion order without mutating the input jobs.

- [ ] **Step 4: Replace latest-job-wins maps in active and inactive documents**

Use `resolveNodeResultState` for `nodeResults`, canvas result nodes, inactive document result nodes, downloads, and guided result panels. Show a pending badge beside the still-visible `baseResult`; show the failure reason without removing the image. Disable another revision submission for the same node while `pendingRevision` exists.

- [ ] **Step 5: Run focused state and workbench tests**

Run: `node --test src/result-version-state.test.mjs src/job-state.test.mjs src/workbench-toolbar.test.mjs src/workbench-layout.test.mjs`

Expected: all tests PASS and existing completed results remain discoverable.

- [ ] **Step 6: Commit stable result versioning**

```bash
git add src/result-version-state.js src/result-version-state.test.mjs src/main.jsx
git commit -m "fix: preserve PNG results during revisions"
```

### Task 5: PNG refinement editor, prompt, and plan builder

**Files:**
- Create: `src/result-refinement.js`
- Create: `src/result-refinement.test.mjs`
- Modify: `src/main.jsx`
- Modify: `src/styles.css`
- Modify: `src/workbench-toolbar.test.mjs`

**Interfaces:**
- Consumes: `<PenPathOverlay />`, `annotationForPlan()`, and `baseResult`
- Produces: `readPngPixelSize(blob, createBitmap?) -> Promise<{width, height}>`
- Produces: `canSubmitResultRefinement({ prompt, paths, draft }) -> { ok, reason }`
- Produces: `buildResultRefinementPlan(input) -> layer review plan`

- [ ] **Step 1: Write failing submission tests**

```js
test('text alone can submit a PNG refinement', () => {
  assert.deepEqual(canSubmitResultRefinement({ prompt: '增强按钮高光', paths: [], draft: null }), { ok: true, reason: null });
});

test('an open pen draft blocks submission', () => {
  const result = canSubmitResultRefinement({ prompt: '调整', paths: [], draft: openFixture() });
  assert.equal(result.ok, false);
  assert.match(result.reason, /闭合或取消/);
});

test('the refinement plan separates PNG pixels from logical placement', () => {
  const plan = buildResultRefinementPlan({
    pngSize: { width: 1536, height: 837 },
    placement: { x: 422, y: 1252, width: 156, height: 85 },
    prompt: '增强按钮高光',
    paths: [closedFixture()],
    baseResult: { jobId: 'base-job', versionId: 'base-v1', fileName: 'button.png', dataUrl: 'data:image/png;base64,AA==' },
    layer: fixtureLayer,
    project: fixtureProject,
  });
  assert.equal(plan.source.canvas.width, 1536);
  assert.equal(plan.layers[0].output.width, 1536);
  assert.equal(plan.layers[0].placement.width, 156);
  assert.equal(plan.layers[0].execution_route_hint, 'result_refinement');
  assert.equal(plan.layers[0].requirement, '增强按钮高光');
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test src/result-refinement.test.mjs`

Expected: FAIL because the refinement helpers do not exist.

- [ ] **Step 3: Implement PNG-size decoding and the pure plan builder**

`readPngPixelSize` must call `createImageBitmap(blob)`, read `width` and `height`, and always call `bitmap.close()`. The plan builder must use those decoded dimensions for `source.canvas`, `source_region_pixels`, `expected_output`, and `output`, while storing logical bounds only under `placement` and `review_snapshot`.

Build the route contract explicitly:

```js
{
  execution_route_hint: 'result_refinement',
  repair_engine: 'imagegen',
  maximum_imagegen_calls: 2,
  transparency_strategy: 'preserve_existing_alpha',
  rmbg_required: false,
  structure_validation_required: true,
  imagegen_input_kind: 'existing_result_png',
  imagegen_canvas_policy: 'prepared_result_locked_canvas',
  output_resolution_policy: 'existing_result_pixels',
}
```

- [ ] **Step 4: Replace the PNG brush editor with the shared pen editor**

Remove `resultEditBrushSize`, freehand gesture handlers, and result polylines. Add `resultEditPrompt`, closed path state, selection state, and a textarea labelled “二次编辑要求”. Use labels “保留钢笔”“擦除钢笔”“边界钢笔”.

Enable “发送调整” when `canSubmitResultRefinement` succeeds and there is no pending revision. On submission fetch the current `baseResult` PNG, decode its actual dimensions, convert it to a data URL, and call `buildResultRefinementPlan`. Clear only the active draft after successful delivery; retain a read-only submitted snapshot on the local job record.

- [ ] **Step 5: Run focused tests and build**

Run: `node --test src/result-refinement.test.mjs src/result-version-state.test.mjs src/annotation-plan.test.mjs src/workbench-toolbar.test.mjs`

Run: `npm run build`

Expected: tests PASS; text-only and path-only submission are both enabled; the UI keeps the base PNG visible.

- [ ] **Step 6: Commit the PNG editor and plan builder**

```bash
git add src/result-refinement.js src/result-refinement.test.mjs src/main.jsx src/styles.css src/workbench-toolbar.test.mjs
git commit -m "feat: rebuild PNG result refinement editor"
```

### Task 6: Supported result-refinement route and Codex prompt

**Files:**
- Modify: `src/split-execution.js`
- Modify: `src/split-execution.test.mjs`
- Modify: `src/targeted-preflight.js`
- Modify: `src/targeted-preflight.test.mjs`
- Modify: `codex-thread-bridge.mjs`
- Modify: `src/codex-thread-bridge.test.mjs`

**Interfaces:**
- Consumes: `execution_route_hint: 'result_refinement'`
- Produces: preflight layer with `crop_path` equal to the current PNG source path, `expected_output` equal to PNG pixels, and `transparency_strategy: 'preserve_existing_alpha'`
- Produces: a result-refinement prompt that attaches only the base PNG and gives the exact preparation/finalization commands.

- [ ] **Step 1: Write failing route and preflight tests**

```js
test('result refinement metadata preserves existing PNG alpha and pixels', () => {
  const metadata = buildRouteMetadata({ executionRoute: 'result_refinement', sourceRegionPixels: { x: 0, y: 0, width: 1536, height: 837 } });
  assert.equal(metadata.transparency_strategy, 'preserve_existing_alpha');
  assert.equal(metadata.rmbg_required, false);
  assert.equal(metadata.output_resolution_policy, 'existing_result_pixels');
});

test('preflight accepts result refinement without a separate crop preview', async () => {
  const context = await fixture();
  context.plan.task = 'refine_split_result';
  context.plan.layers[0] = resultRefinementLayer(context.plan.layers[0]);
  delete context.plan.layers[0].review_snapshot.local_crop_path;
  const spec = await buildTargetedExecutionSpec(context);
  assert.equal(spec.layers[0].crop_path, context.sourcePath);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test src/split-execution.test.mjs src/targeted-preflight.test.mjs src/codex-thread-bridge.test.mjs`

Expected: FAIL because `result_refinement` is not an allowed route.

- [ ] **Step 3: Extend route metadata and preflight validation**

Add `result_refinement` to the allowed route set. For this route, use `plan.source.local_path` as `crop_path` and do not require `review_snapshot.local_crop_path`. Require `task === 'refine_split_result'`, a readable PNG source, exact declared dimensions, `preserve_existing_alpha`, and either a normalized non-empty requirement or at least one valid closed `bezier_path` annotation.

Validate every anchor and flattened polygon point as finite and in bounds. Reject a path with fewer than three anchors, `closed !== true`, or fewer than three flattened pixels.

- [ ] **Step 4: Add a dedicated Codex prompt branch**

The prompt must say that the attached image is the authoritative base PNG; only the submitted text and closed path regions may change; unmarked RGBA pixels are locked; the input pixel dimensions are the required output dimensions; RMBG must not run; and the result finalizer must be the last tool call.

Add these commands to the prompt:

```text
python3 scripts/prepare-targeted-imagegen-canvas.py --job-id <jobId> --layer-id <layerId>
python3 scripts/finalize-targeted-job.py --job-id <jobId> --layer-id <layerId> --generated-input <PNG> --imagegen-mapping <JSON>
```

Retain `selectExecutionAttachments` behavior that attaches only `sourcePath` for `refine_split_result`.

- [ ] **Step 5: Run focused bridge and preflight tests**

Run: `node --test src/split-execution.test.mjs src/targeted-preflight.test.mjs src/codex-thread-bridge.test.mjs`

Expected: all route, prompt, and attachment tests PASS.

- [ ] **Step 6: Commit the supported route**

```bash
git add src/split-execution.js src/split-execution.test.mjs src/targeted-preflight.js src/targeted-preflight.test.mjs codex-thread-bridge.mjs src/codex-thread-bridge.test.mjs
git commit -m "feat: support PNG result refinement route"
```

### Task 7: Preserve PNG pixels and alpha in the ImageGen finalizer

**Files:**
- Modify: `scripts/prepare-targeted-imagegen-canvas.py`
- Modify: `scripts/test_prepare_targeted_imagegen_canvas.py`
- Modify: `scripts/finalize-targeted-job.py`
- Modify: `scripts/test_finalize_targeted_job.py`

**Interfaces:**
- Consumes: preflight route `result_refinement`, base PNG `crop_path`, normalized pen annotations, and `prepared_result_locked_canvas` mapping.
- Produces: `generated_input_kind: 'result_refinement_canvas'`
- Produces: final RGBA PNG at exactly the base PNG pixel dimensions without RMBG.

- [ ] **Step 1: Write failing Python preparation and finalization tests**

```python
def test_result_refinement_reference_preserves_transparent_rgba(self):
    self.layer.update({
        "execution_route_hint": "result_refinement",
        "transparency_strategy": "preserve_existing_alpha",
    })
    mapping_path, mapping = prepare_canvas(self.job_id, self.layer_id, jobs_root=self.jobs_root)
    with Image.open(mapping["reference_path"]) as reference:
        self.assertEqual(reference.mode, "RGBA")
    self.assertEqual(mapping["generated_input_kind"], "result_refinement_canvas")

def test_result_refinement_locks_unmarked_rgba_and_keeps_base_dimensions(self):
    report = finalize_layer(
        self.job_id,
        self.layer_id,
        self.generated_canvas,
        jobs_root=self.jobs_root,
        imagegen_mapping=self.mapping_path,
    )
    with Image.open(report["output_path"]) as output:
        self.assertEqual(output.size, self.base_png_size)
        self.assertEqual(output.mode, "RGBA")
        self.assertEqual(output.getpixel((0, 0)), self.base_pixel_at_0_0)
```

- [ ] **Step 2: Run Python tests and verify RED**

Run: `python3 -m unittest scripts.test_prepare_targeted_imagegen_canvas scripts.test_finalize_targeted_job`

Expected: FAIL because preparation and finalization reject `result_refinement`.

- [ ] **Step 3: Extend canvas preparation**

Allow `result_refinement`, read the current PNG as RGBA, resize it into the canonical ImageGen `content_region`, and save an RGBA reference canvas with transparent padding. Emit `generated_input_kind: 'result_refinement_canvas'`, `execution_route: 'result_refinement'`, canonical canvas dimensions, content region, and expected base PNG dimensions.

- [ ] **Step 4: Extend mapping and alpha validation**

Allow `result_refinement_canvas` in `load_imagegen_mapping` and require its execution route and canonical geometry to match. Crop the generated canvas back from `content_region` and resize only to the base PNG's actual dimensions when the mapped region differs. Never use the logical placement dimensions.

Rasterize submitted flattened polygons with Pillow `ImageDraw.polygon`. For path-scoped edits, copy every unmarked RGBA pixel from the base PNG after mapping the candidate back to base pixels. Apply explicit erase paths to alpha only because they are direct user annotations. For text-only edits, allow the full PNG to change but still require an RGBA output and identical dimensions.

- [ ] **Step 5: Write the completed report only after structural checks**

Require the result to be PNG, RGBA, exact base dimensions, and to retain visible pixels. If the base contains transparent pixels, require the result to retain a non-empty transparent range. Write a new versioned file in `final/`; never overwrite `source.png` or the parent result. Record parent job/version, input/output dimensions, annotation count, and `preserve_existing_alpha` in `execution-report.json`.

- [ ] **Step 6: Run Python tests and verify GREEN**

Run: `python3 -m unittest scripts.test_prepare_targeted_imagegen_canvas scripts.test_finalize_targeted_job`

Expected: all preparation, legacy route, native-resolution, alpha-lock, and result-refinement tests PASS.

- [ ] **Step 7: Commit finalization support**

```bash
git add scripts/prepare-targeted-imagegen-canvas.py scripts/test_prepare_targeted_imagegen_canvas.py scripts/finalize-targeted-job.py scripts/test_finalize_targeted_job.py
git commit -m "feat: finalize PNG result refinements"
```

### Task 8: Update the local plugin instructions and run full verification

**Files:**
- Modify: `plugin-template/imvia-layer/skills/split-ui-design-layers-workbench-targeted/SKILL.md`
- Modify: `README.md`
- Modify: `src/workbench-toolbar.test.mjs`
- Modify: `src/codex-thread-bridge.test.mjs`

**Interfaces:**
- Consumes: completed pen editor and `result_refinement` route.
- Produces: installed local plugin instructions that tell Codex how to execute PNG result refinements and stop after finalization.

- [ ] **Step 1: Add failing documentation-contract assertions**

```js
test('the workbench skill documents PNG result refinement source locking', async () => {
  const skill = await readFile(new URL('../plugin-template/imvia-layer/skills/split-ui-design-layers-workbench-targeted/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /result_refinement/);
  assert.match(skill, /当前成功 PNG/);
  assert.match(skill, /未标注 RGBA 像素/);
  assert.match(skill, /不得调用 RMBG/);
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `node --test src/codex-thread-bridge.test.mjs`

Expected: FAIL because the source plugin skill does not yet document the route.

- [ ] **Step 3: Update plugin and README instructions**

Document the exact result-refinement preparation/finalization commands, base-PNG attachment rule, path/text scope, pixel-size lock, alpha preservation, no-RMBG rule, and final-tool-call termination rule. Update the README's annotation section from brushes to full Bézier pen paths and describe PNG version retention.

- [ ] **Step 4: Run the entire automated suite**

Run: `npm test`

Run: `python3 -m unittest scripts.test_prepare_targeted_imagegen_canvas scripts.test_finalize_targeted_job scripts.test_finalize_rmbg`

Run: `npm run build`

Expected: all Node tests, all Python tests, and the production build PASS without warnings caused by this change.

- [ ] **Step 5: Search for stale brush UI and ambiguous result sizing**

Run: `rg -n "保留画笔|排除画笔|擦除画笔|边界画笔|画笔大小|resultEditBrushSize|brushSize" src README.md`

Expected: no active UI or state matches; a match is allowed only in a migration comment or historical test fixture that explicitly says `legacy`.

Run: `rg -n "result_refinement|preserve_existing_alpha|existing_result_pixels" src scripts codex-thread-bridge.mjs plugin-template/imvia-layer/skills`

Expected: the route appears in plan construction, preflight, prompt construction, finalization, tests, and the plugin skill.

- [ ] **Step 6: Install the updated local plugin and verify the generated package**

Run: `node scripts/install-codex-plugin.mjs`

Expected: the personal `imvia-layer` plugin installs successfully with a new local build version and includes the updated skill, logo, bridge, and workbench files.

- [ ] **Step 7: Manually verify the browser workflow**

Open the workbench and verify one rounded button and one irregular subject:

1. Create straight and curved anchors, break one handle with `Option`, close the path, and confirm dashed outline plus translucent fill.
2. Edit an anchor, undo, delete an anchor, and cancel an open draft.
3. Submit one text-only PNG revision and one path-plus-text revision.
4. Confirm the old PNG remains visible while queued and after a forced failed revision.
5. Confirm a successful revision switches to the new PNG only after completion and retains its actual pixel dimensions and alpha.

- [ ] **Step 8: Commit documentation and installation-source changes**

```bash
git add plugin-template/imvia-layer/skills/split-ui-design-layers-workbench-targeted/SKILL.md README.md src/workbench-toolbar.test.mjs src/codex-thread-bridge.test.mjs
git commit -m "docs: publish pen and PNG refinement workflow"
```

### Task 9: Final regression gate

**Files:**
- Verify only; modify only the specific file responsible for a failing assertion.

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: a verified workbench and installed personal plugin.

- [ ] **Step 1: Run clean final verification**

Run: `npm test`

Run: `python3 -m unittest discover -s scripts -p 'test_*.py'`

Run: `npm run build`

Expected: every command exits with status 0.

- [ ] **Step 2: Inspect only task-related diffs**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors; unrelated pre-existing user changes remain unstaged and untouched.

- [ ] **Step 3: Report the exact verification counts and plugin version**

Capture the Node test count, Python test count, Vite build result, installed plugin version, and any remaining unrelated dirty files. Do not claim the feature complete unless every required automated command and the manual browser workflow pass.
