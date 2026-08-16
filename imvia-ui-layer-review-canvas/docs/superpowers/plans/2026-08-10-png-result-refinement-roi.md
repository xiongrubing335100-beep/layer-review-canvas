# PNG Result Refinement Local ROI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace full-canvas PNG result refinement with explicit path semantics, 1:1 local ROI generation, deterministic RGBA composition, and user-facing prompt guidance that prevents geometric distortion and ambiguous edits.

**Architecture:** The browser converts the user's short requirement and closed pen paths into a versioned `result_refinement` policy. Node preflight independently validates paths, operation mode, coverage, call budget, and base dimensions. Python preparation emits a version-2 manifest containing native-pixel ROI tiles; the finalizer accepts per-ROI RGB or RGBA candidates, composites RGB only through approved repair masks, applies deterministic Alpha operations, restores protected pixels, and verifies every unapproved byte against the base PNG.

**Tech Stack:** React, JavaScript ES modules, Node.js test runner, Vite, Python 3.10+, Pillow, local Codex plugin skills and MCP conversation bridge.

## Global Constraints

- Work directly in `/Users/a1234/Documents/海报和ui运营设计图分层无限画布/layer-review-canvas`; do not create a worktree or branch fork.
- Preserve and separately checkpoint the five existing uncommitted UI files before changing PNG refinement behavior.
- The current successful PNG is the only authoritative base for `result_refinement`.
- The decoded base PNG pixel dimensions are the only authoritative output dimensions; logical placement never participates in image scaling.
- Base PNG data or each local ROI enters the prepared standard canvas at 1:1 pixel scale. Non-uniform scaling and forced candidate resizing are forbidden.
- Normal local refinement requires at least one valid closed path. Text alone never grants full-canvas edit authority.
- Full-canvas editing requires explicit `full_canvas_explicit` mode and a visible second confirmation.
- `boundary` repair paths modify only approved RGB pixels. Erase, protect, outside-delete, and Alpha inclusion are explicit structured operations.
- PNG result refinement never invokes RMBG.
- Pixels outside an approved mutable mask remain byte-for-byte equal to the base PNG.
- Candidate RGB may be accepted for local repair; candidate Alpha is not authoritative unless a structured Alpha operation explicitly grants it.
- A repair path union above 40% canvas coverage warns; above 70% blocks unless `full_canvas_explicit` is true.
- Each ROI gets one initial ImageGen attempt and at most one targeted retry. A failed second candidate stops that ROI and the job.
- Failure, cancellation, or an invalid candidate never replaces the visible successful PNG or overwrites its version file.
- All frontend behavior remains keyboard-accessible and preserves existing pen undo/redo/delete semantics.
- Preserve existing macOS and Windows path containment guarantees.

---

### Task 1: Checkpoint the Existing Workbench UI Adjustments

**Files:**
- Commit existing changes only: `src/PenPathOverlay.jsx`
- Commit existing changes only: `src/main.jsx`
- Commit existing changes only: `src/styles.css`
- Commit existing changes only: `src/visible-conversation-route.test.mjs`
- Commit existing changes only: `src/workbench-toolbar.test.mjs`

**Interfaces:**
- Consumes: Current dirty worktree containing the previously requested toolbar, preview, pen cursor, anchor appearance, status label, hidden coordinate readout, and category-order changes.
- Produces: A clean baseline commit so later PNG-refinement commits cannot mix or lose those changes.

- [ ] **Step 1: Review the exact dirty diff and confirm its scope**

Run:

```bash
git diff -- src/PenPathOverlay.jsx src/main.jsx src/styles.css src/visible-conversation-route.test.mjs src/workbench-toolbar.test.mjs
```

Expected: Only the already requested visual changes are present: KV background ordering, hidden project/source labels and selection readout, proportional expanded preview, hints below the preview, pen cursor, green round anchors, animated dashed paths, smaller secondary-edit text, centered brand/status, and their tests.

- [ ] **Step 2: Run the focused UI tests**

Run:

```bash
node --test src/workbench-toolbar.test.mjs src/visible-conversation-route.test.mjs src/pen-path.test.mjs src/pen-editor-state.test.mjs
```

Expected: All focused tests pass.

- [ ] **Step 3: Run the production build**

Run:

```bash
npm run build
```

Expected: Vite exits with code 0 and no build warnings.

- [ ] **Step 4: Commit only the existing UI baseline**

```bash
git add src/PenPathOverlay.jsx src/main.jsx src/styles.css src/visible-conversation-route.test.mjs src/workbench-toolbar.test.mjs
git commit -m "feat: refine workbench review presentation"
```

Expected: `git status --short` is clean before Task 2 begins.

---

### Task 2: Add a Pure Result-Refinement Policy Layer

**Files:**
- Create: `src/result-refinement-policy.js`
- Create: `src/result-refinement-policy.test.mjs`
- Modify: `src/result-refinement.js`
- Modify: `src/result-refinement.test.mjs`
- Modify: `src/annotation-plan.js`
- Modify: `src/annotation-plan.test.mjs`

**Interfaces:**
- Consumes: Closed pen paths with `kind: "boundary" | "background" | "foreground"`, base PNG dimensions, user text, and explicit operation controls.
- Produces: `deriveRefinementPolicy(input)`, `refinementSubmissionState(input)`, `refinementSummary(policy)`, and plan version `0.8` fields consumed by preflight, UI, bridge, and Python scripts.

Canonical operation value:

```js
{
  mode: 'path_scoped' | 'keep_inside_delete_outside' | 'full_canvas_explicit',
  subject_path_ids: ['pen-1'],
  alpha_include_path_ids: [],
}
```

Derived policy value:

```js
{
  operation,
  repair_path_ids: [],
  erase_path_ids: [],
  protect_path_ids: [],
  subject_path_ids: [],
  alpha_include_path_ids: [],
  repair_coverage_ratio: 0,
  expected_roi_tile_count: 0,
  maximum_imagegen_calls: 0,
  normalized_user_requirement: '',
  warnings: [],
}
```

- [ ] **Step 1: Write failing policy tests**

Add tests equivalent to:

```js
test('text-only refinement is blocked unless full canvas mode is explicit', () => {
  assert.deepEqual(refinementSubmissionState({
    prompt: '增强整体高光', paths: [], draft: null,
    operation: { mode: 'path_scoped', subject_path_ids: [], alpha_include_path_ids: [] },
    canvas: { width: 1024, height: 1243 },
  }), {
    ok: false,
    reason: '局部二次编辑必须添加至少一条有效闭合路径',
    warnings: [],
  });
});

test('each boundary repair path receives two calls and non-repair paths receive none', () => {
  const policy = deriveRefinementPolicy({
    prompt: '补全两个金币',
    annotations: [boundary('coin-left'), boundary('coin-right'), erase('copy')],
    operation: { mode: 'path_scoped', subject_path_ids: [], alpha_include_path_ids: [] },
    canvas: { width: 1024, height: 1243 },
  });
  assert.deepEqual(policy.repair_path_ids, ['coin-left', 'coin-right']);
  assert.deepEqual(policy.erase_path_ids, ['copy']);
  assert.equal(policy.maximum_imagegen_calls, 4);
});

test('a subject boundary is not also a repair ROI', () => {
  const policy = deriveRefinementPolicy({
    prompt: '补全内部金币',
    annotations: [boundary('subject'), boundary('coin')],
    operation: {
      mode: 'keep_inside_delete_outside',
      subject_path_ids: ['subject'],
      alpha_include_path_ids: [],
    },
    canvas: { width: 1024, height: 1243 },
  });
  assert.deepEqual(policy.subject_path_ids, ['subject']);
  assert.deepEqual(policy.repair_path_ids, ['coin']);
});
```

Also cover open draft rejection, boundary without prompt rejection, erase-only submission without prompt, protect-only no-op rejection, 40% warning, 70% blocking, explicit full-canvas allowance, invalid subject IDs, normalized whitespace, and rejection of natural-language scope instructions such as “框外删除” when the corresponding structured operation is absent.

- [ ] **Step 2: Run the policy tests to verify RED**

Run:

```bash
node --test src/result-refinement-policy.test.mjs src/result-refinement.test.mjs src/annotation-plan.test.mjs
```

Expected: Tests fail because the policy module, version-0.8 fields, and path roles do not exist.

- [ ] **Step 3: Implement the minimal policy functions**

Create `src/result-refinement-policy.js` with these exports:

```js
export const RESULT_REFINEMENT_MODES = new Set([
  'path_scoped',
  'keep_inside_delete_outside',
  'full_canvas_explicit',
]);

export const RESULT_REFINEMENT_ROI_POLICY = Object.freeze({
  strategy: 'per_repair_path_native_tiles',
  scale_mode: 'native_1_to_1',
  context_padding_ratio: 0.08,
  minimum_padding_ratio: 0.03,
  maximum_padding_ratio: 0.15,
  warn_coverage_ratio: 0.4,
  block_coverage_ratio: 0.7,
  tile_overlap_pixels: 32,
});

const OUTSIDE_DELETE_INTENT = /(?:框外|路径外|选区外).{0,8}(?:删除|去掉|透明|清空)/;
const FULL_CANVAS_INTENT = /(?:整图|全图|整个画面).{0,8}(?:修改|重绘|调整)/;

export function polygonAreaRatio(points, canvas) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  const twiceArea = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  return Math.abs(twiceArea) / 2 / (canvas.width * canvas.height);
}

export function deriveRefinementPolicy({ prompt, annotations, operation, canvas }) {
  const normalized = String(prompt || '').trim().replace(/\s+/g, ' ');
  const subjectIds = new Set(operation.subject_path_ids || []);
  const repair = annotations.filter((item) => item.kind === 'boundary' && !subjectIds.has(item.id));
  const erase = annotations.filter((item) => ['background', 'exclude', 'erase'].includes(item.kind));
  const protect = annotations.filter((item) => ['foreground', 'keep'].includes(item.kind));
  const repairCoverage = Math.min(1, repair.reduce(
    (sum, item) => sum + polygonAreaRatio(item.source_polygon_pixels, canvas), 0,
  ));
  const expectedTiles = expectedNativeTileCount(repair, canvas, RESULT_REFINEMENT_ROI_POLICY);
  return {
    operation,
    repair_path_ids: repair.map((item) => item.id),
    erase_path_ids: erase.map((item) => item.id),
    protect_path_ids: protect.map((item) => item.id),
    subject_path_ids: [...subjectIds],
    alpha_include_path_ids: [...(operation.alpha_include_path_ids || [])],
    repair_coverage_ratio: repairCoverage,
    expected_roi_tile_count: operation.mode === 'full_canvas_explicit'
      ? expectedFullCanvasTileCount(canvas, RESULT_REFINEMENT_ROI_POLICY)
      : expectedTiles,
    maximum_imagegen_calls: operation.mode === 'full_canvas_explicit'
      ? expectedFullCanvasTileCount(canvas, RESULT_REFINEMENT_ROI_POLICY) * 2
      : expectedTiles * 2,
    normalized_user_requirement: normalized,
    warnings: repairCoverage > 0.4 ? ['局部修复路径范围较大，可能产生重新构图'] : [],
  };
}
```

`expectedNativeTileCount` applies the same padded bounding-box, supported-canvas, and 32-pixel-overlap math specified in Task 5; it does not read any client-supplied tile count. `refinementSubmissionState` applies every blocking rule rather than trusting UI state. `refinementSummary` returns human-readable counts and outside-delete/full-canvas state.

If `OUTSIDE_DELETE_INTENT` matches while `operation.mode !== 'keep_inside_delete_outside'`, return `请开启“仅保留路径内，路径外透明”，不要只在提示词中描述范围`. If `FULL_CANVAS_INTENT` matches while `operation.mode !== 'full_canvas_explicit'`, return `请明确开启“整图编辑（高风险）”`.

- [ ] **Step 4: Serialize explicit path roles and operation fields**

Extend `annotationForPlan` to accept an optional fifth argument:

```js
annotationForPlan(mark, bounds, sourceSize, orderIndex, { operationRole = null } = {})
```

When present, serialize `operation_role`. Update `buildResultRefinementPlan` to convert paths to annotations first, derive policy, set `version: "0.8"`, and serialize `refinement_operation`, `normalized_user_requirement`, `roi_policy`, and the derived `maximum_imagegen_calls`.

The `roi_policy` value is:

```js
{
  strategy: 'per_repair_path_native_tiles',
  scale_mode: 'native_1_to_1',
  context_padding_ratio: 0.08,
  minimum_padding_ratio: 0.03,
  maximum_padding_ratio: 0.15,
  warn_coverage_ratio: 0.4,
  block_coverage_ratio: 0.7,
  tile_overlap_pixels: 32,
}
```

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
node --test src/result-refinement-policy.test.mjs src/result-refinement.test.mjs src/annotation-plan.test.mjs
```

Expected: All focused tests pass.

Commit:

```bash
git add src/result-refinement-policy.js src/result-refinement-policy.test.mjs src/result-refinement.js src/result-refinement.test.mjs src/annotation-plan.js src/annotation-plan.test.mjs
git commit -m "feat: define explicit PNG refinement policy"
```

---

### Task 3: Add Explicit PNG-Refinement Controls and Submission Summary

**Files:**
- Modify: `src/main.jsx:568-780`
- Modify: `src/main.jsx:2625-2785`
- Modify: `src/main.jsx:3864-4000`
- Modify: `src/styles.css`
- Modify: `src/workbench-toolbar.test.mjs`
- Modify: `src/result-refinement.test.mjs`

**Interfaces:**
- Consumes: `refinementSubmissionState`, `refinementSummary`, and plan builder fields from Task 2.
- Produces: Explicit UI state for subject boundaries, outside deletion, full-canvas mode, Alpha inclusion, and a read-only execution summary included in `refinementSnapshot`.

- [ ] **Step 1: Write failing toolbar and submission tests**

Add static and pure-state tests:

```js
assert.match(source, /仅保留路径内，路径外透明/);
assert.match(source, /设为主体范围/);
assert.match(source, /整图编辑（高风险）/);
assert.match(source, /系统理解/);
assert.match(source, /修改目标/);
assert.doesNotMatch(source, /非空要求或至少一条闭合路径即可发送/);
```

Also prove that a selected closed boundary can become a subject path, outside deletion is disabled without one, full-canvas mode asks for a second confirmation, changing tools cancels only the draft, submitted snapshots include operation and summary, and pending revisions keep the base PNG visible.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
node --test src/workbench-toolbar.test.mjs src/result-refinement.test.mjs src/result-version-state.test.mjs
```

Expected: New controls and snapshot fields are missing.

- [ ] **Step 3: Add state and reset rules**

Add state beside the existing result editor state:

```js
const [resultEditOperation, setResultEditOperation] = useState({
  mode: 'path_scoped',
  subject_path_ids: [],
  alpha_include_path_ids: [],
});
```

When layer, result version, or active image changes, reset to `path_scoped`. Deleting a path removes its ID from both arrays. Clearing paths resets the operation. Exiting result editing cancels only the draft.

- [ ] **Step 4: Add operation controls**

Under the pen toolbar, render “设为主体范围” for the selected closed boundary, “允许补入透明缺口” for a selected repair boundary, “仅保留路径内，路径外透明”, and “整图编辑（高风险）”. Outside deletion requires a subject path. Full canvas is mutually exclusive with path-scoped outside deletion.

The full-canvas submit handler calls:

```js
const confirmed = window.confirm('整图编辑可能改变构图、位置和比例。确认允许整张 PNG 参与生成式修改吗？');
if (!confirmed) return;
```

- [ ] **Step 5: Replace technical prompt copy with guided copy**

Rename the label to “修改目标” and use:

```text
例如：补全已标注的两个金币，保持原位置、大小、材质和光影
```

Render a “系统理解” block showing repair, erase, protect, subject counts, outside-delete/full-canvas state, and coverage warnings.

- [ ] **Step 6: Submit the explicit operation and snapshot**

Pass `operation: resultEditOperation` to validation and plan building. Store:

```js
const refinementSnapshot = {
  prompt: resultEditPrompt.trim(),
  paths: resultEditPaths.map((path) => ({ ...path })),
  operation: structuredClone(resultEditOperation),
  summary: refinementSummary(resultEditPolicy),
};
```

- [ ] **Step 7: Run focused tests, build, and commit**

Run:

```bash
node --test src/workbench-toolbar.test.mjs src/result-refinement.test.mjs src/result-version-state.test.mjs
npm run build
```

Expected: Tests and build pass.

Commit:

```bash
git add src/main.jsx src/styles.css src/workbench-toolbar.test.mjs src/result-refinement.test.mjs
git commit -m "feat: guide PNG refinement operations"
```

---

### Task 4: Enforce the New Policy in Node Preflight

**Files:**
- Modify: `src/targeted-preflight.js:190-360`
- Modify: `src/targeted-preflight.test.mjs`
- Modify: `src/split-execution.js`
- Modify: `src/split-execution.test.mjs`

**Interfaces:**
- Consumes: Plan `0.8` fields `refinement_operation`, `roi_policy`, `normalized_user_requirement`, annotations, and base PNG dimensions.
- Produces: Trusted preflight fields passed to Python without relying on browser-derived coverage or call counts.

- [ ] **Step 1: Write failing preflight tests**

Add cases for text-only `path_scoped` rejection, text-only `full_canvas_explicit` acceptance, invalid subject IDs, subject IDs referencing non-boundary paths, self-intersecting or zero-area polygons, boundary repair without a normalized requirement, erase-only tasks with zero ImageGen calls, independently recomputed 40% warning and 70% blocking, tampered call budget, non-1:1 ROI policy, forbidden RMBG, and unsafe cross-platform IDs.

Use an actual polygon covering 80% of a 100×100 canvas so the threshold test cannot depend on a client-supplied ratio.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node --test src/targeted-preflight.test.mjs src/split-execution.test.mjs
```

Expected: Existing preflight still accepts implicit text-only editing and does not validate the operation or ROI policy.

- [ ] **Step 3: Add trusted validation helpers**

Implement these private helpers in `targeted-preflight.js`:

```js
function polygonRatio(points, pngSize) {
  const twiceArea = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  return Math.abs(twiceArea) / 2 / (pngSize.width * pngSize.height);
}

function repairCoverageRatio(annotations, repairPathIds, pngSize) {
  const allowed = new Set(repairPathIds);
  return Math.min(1, annotations
    .filter((annotation) => allowed.has(annotation.id))
    .reduce((sum, annotation) => sum + polygonRatio(annotation.source_polygon_pixels, pngSize), 0));
}

function validateRefinementOperation(layer, annotations, pngSize) {
  const operation = layer.refinement_operation;
  const modes = new Set(['path_scoped', 'keep_inside_delete_outside', 'full_canvas_explicit']);
  if (!operation || !modes.has(operation.mode)) throw fail('result_refinement operation mode 无效');
  const byId = new Map(annotations.map((annotation) => [annotation.id, annotation]));
  const subjectPathIds = operation.subject_path_ids || [];
  if (!subjectPathIds.every((id) => byId.get(id)?.kind === 'boundary')) {
    throw fail('subject_path_ids 必须引用闭合 boundary 路径');
  }
  const subjectSet = new Set(subjectPathIds);
  const repairPathIds = annotations
    .filter((annotation) => annotation.kind === 'boundary' && !subjectSet.has(annotation.id))
    .map((annotation) => annotation.id);
  const coverage = repairCoverageRatio(annotations, repairPathIds, pngSize);
  if (coverage > 0.7 && operation.mode !== 'full_canvas_explicit') {
    throw fail('局部修复路径覆盖超过 70%，必须缩小路径或明确启用整图编辑');
  }
  return { operation, repair_path_ids: repairPathIds, repair_coverage_ratio: coverage };
}

function expectedRefinementImagegenCalls(policy) {
  return policy.expected_roi_tile_count * 2;
}
```

The trusted preflight layer includes:

```js
{
  refinement_operation: trustedPolicy.operation,
  normalized_user_requirement: trustedPolicy.normalized_user_requirement,
  roi_policy: trustedPolicy.roi_policy,
  repair_path_ids: trustedPolicy.repair_path_ids,
  erase_path_ids: trustedPolicy.erase_path_ids,
  protect_path_ids: trustedPolicy.protect_path_ids,
  subject_path_ids: trustedPolicy.subject_path_ids,
  alpha_include_path_ids: trustedPolicy.alpha_include_path_ids,
  repair_coverage_ratio: trustedPolicy.repair_coverage_ratio,
}
```

Recompute every derived array, ratio, padded native tile count, and call budget; do not copy them from the browser. Use the same supported canvas sizes and 32-pixel overlap as the Python preparation module, then assert that Python's emitted manifest contains exactly `expected_roi_tile_count` jobs.

- [ ] **Step 4: Update generic route metadata**

Change `buildRouteMetadata` so it no longer assumes two calls for every `result_refinement`. The result plan supplies the exact budget, and preflight verifies it from repair path count or explicit full-canvas mode.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
node --test src/targeted-preflight.test.mjs src/split-execution.test.mjs
```

Expected: All focused tests pass.

Commit:

```bash
git add src/targeted-preflight.js src/targeted-preflight.test.mjs src/split-execution.js src/split-execution.test.mjs
git commit -m "feat: preflight local PNG refinement policy"
```

---

### Task 5: Prepare Native 1:1 ROI Manifests

**Files:**
- Create: `scripts/result_refinement_roi.py`
- Create: `scripts/test_result_refinement_roi.py`
- Modify: `scripts/prepare-targeted-imagegen-canvas.py`
- Modify: `scripts/test_prepare_targeted_imagegen_canvas.py`

**Interfaces:**
- Consumes: Trusted preflight layer, base PNG, approved repair/subject/Alpha paths, and `roi_policy`.
- Produces: A version-2 manifest plus one 1:1 standard reference canvas and mapping per repair ROI tile.

Manifest shape:

```json
{
  "version": 2,
  "generated_input_kind": "result_refinement_roi_manifest",
  "execution_route": "result_refinement",
  "base_png_dimensions": {"width": 1024, "height": 1243},
  "operation": {"mode": "path_scoped", "subject_path_ids": [], "alpha_include_path_ids": []},
  "roi_jobs": [
    {
      "roi_id": "coin-left-tile-001",
      "path_id": "coin-left",
      "base_region": {"x": 20, "y": 700, "width": 132, "height": 146},
      "canvas": {"width": 1024, "height": 1024},
      "content_region": {"x": 446, "y": 439, "width": 132, "height": 146},
      "reference_path": "/absolute/job/generated/layer-coin-left-tile-001-reference.png"
    }
  ]
}
```

- [ ] **Step 1: Write failing ROI geometry tests**

Test these exact behaviors:

```python
def test_small_roi_is_centered_at_native_size_without_resampling():
    region = place_native_region((132, 146), (1024, 1024))
    assert region == {"x": 446, "y": 439, "width": 132, "height": 146}

def test_large_roi_splits_into_native_tiles_with_32_pixel_overlap():
    tiles = tile_region({"x": 0, "y": 0, "width": 1800, "height": 900}, (1536, 1024), 32)
    assert tiles[0]["width"] == 1536
    assert tiles[1]["x"] == 1504
    assert max(tile["width"] for tile in tiles) <= 1536
```

Also test 8% padding clamped to 3%–15%, base-bound clipping, two distant paths producing separate jobs, subject paths producing no repair job, erase-only tasks producing empty `roi_jobs`, unsafe IDs rejected before writing, and reference pixels equal to the base ROI.

- [ ] **Step 2: Run Python tests to verify RED**

Run:

```bash
python3 -m unittest scripts.test_result_refinement_roi scripts.test_prepare_targeted_imagegen_canvas -v
```

Expected: ROI helpers and manifest version 2 are missing; the existing preparation test still expects a scaled 1536×768 content region for a 4×2 PNG.

- [ ] **Step 3: Implement native ROI helpers**

Create these pure helpers:

```python
def polygon_bounds(points, image_size):
    width, height = image_size
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    left = max(0, int(math.floor(min(xs))))
    top = max(0, int(math.floor(min(ys))))
    right = min(width, int(math.ceil(max(xs))))
    bottom = min(height, int(math.ceil(max(ys))))
    if right <= left or bottom <= top:
        raise ValueError("repair polygon has zero-sized bounds")
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}

def padded_region(bounds, image_size, ratio=0.08, minimum=0.03, maximum=0.15):
    ratio = min(max(ratio, minimum), maximum)
    padding = max(1, round(max(bounds["width"], bounds["height"]) * ratio))
    width, height = image_size
    left = max(0, bounds["x"] - padding)
    top = max(0, bounds["y"] - padding)
    right = min(width, bounds["x"] + bounds["width"] + padding)
    bottom = min(height, bounds["y"] + bounds["height"] + padding)
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}

def choose_native_canvas(width, height):
    ratio = width / height
    return LANDSCAPE_CANVAS if ratio > 1.2 else PORTRAIT_CANVAS if ratio < 1 / 1.2 else SQUARE_CANVAS

def place_native_region(content_size, canvas_size):
    width, height = content_size
    canvas_width, canvas_height = canvas_size
    if width > canvas_width or height > canvas_height:
        raise ValueError("native ROI does not fit the selected standard canvas")
    return {
        "x": (canvas_width - width) // 2,
        "y": (canvas_height - height) // 2,
        "width": width,
        "height": height,
    }

def tile_region(region, canvas_size, overlap_pixels=32):
    canvas_width, canvas_height = canvas_size
    step_x = max(1, canvas_width - overlap_pixels)
    step_y = max(1, canvas_height - overlap_pixels)
    tiles = []
    y = region["y"]
    while y < region["y"] + region["height"]:
        x = region["x"]
        tile_height = min(canvas_height, region["y"] + region["height"] - y)
        while x < region["x"] + region["width"]:
            tile_width = min(canvas_width, region["x"] + region["width"] - x)
            tiles.append({"x": x, "y": y, "width": tile_width, "height": tile_height})
            if x + tile_width >= region["x"] + region["width"]:
                break
            x += step_x
        if y + tile_height >= region["y"] + region["height"]:
            break
        y += step_y
    return tiles
```

`build_result_refinement_manifest` composes these helpers, writes one reference per tile, and emits the exact version-2 schema shown above. `place_native_region` only centers; it never resizes.

- [ ] **Step 4: Route result refinement through the manifest builder**

Keep version-1 mapping unchanged for `codex_rgba` and `targeted_repair`. For `result_refinement`, `prepare_canvas` returns the manifest path and manifest rather than resizing the full PNG.

For a 1024×1243 full-base explicit job, map exactly 1024×1243 into 1024×1536 with vertical padding. For a 132×146 coin ROI, map exactly 132×146 into a square standard canvas. If an explicit full-canvas job or padded repair ROI exceeds every supported standard canvas, split it with `tile_region`; never downscale it to fit.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
python3 -m unittest scripts.test_result_refinement_roi scripts.test_prepare_targeted_imagegen_canvas -v
python3 -m py_compile scripts/result_refinement_roi.py scripts/prepare-targeted-imagegen-canvas.py
```

Expected: All tests pass and compilation succeeds.

Commit:

```bash
git add scripts/result_refinement_roi.py scripts/test_result_refinement_roi.py scripts/prepare-targeted-imagegen-canvas.py scripts/test_prepare_targeted_imagegen_canvas.py
git commit -m "feat: prepare native PNG refinement ROIs"
```

---

### Task 6: Composite RGB Candidates with Deterministic Alpha

**Files:**
- Modify: `scripts/result_refinement_roi.py`
- Modify: `scripts/test_result_refinement_roi.py`
- Modify: `scripts/finalize-targeted-job.py`
- Modify: `scripts/test_finalize_targeted_job.py`

**Interfaces:**
- Consumes: Version-2 ROI manifest and repeatable candidate bindings in the form `roi-id=/absolute/path.png`.
- Produces: A versioned RGBA PNG at exact base dimensions, a completed or failed report, and no RMBG invocation.

- [ ] **Step 1: Write failing composition tests**

Prove that an RGB ROI candidate is accepted; candidate RGB changes only repair-mask pixels; base Alpha remains unchanged by default; `alpha_include_path_ids` grants antialiased ownership for repaired transparent gaps; erase changes only Alpha; outside-delete clears only outside Alpha; protect restores base RGBA last; overlapping native tiles blend without seams; every unapproved byte equals base; missing, duplicate, unknown, wrong-sized, or resized candidates fail; an 8×8 baked checkerboard fails; deterministic-only tasks need no candidate; failure leaves `final/` unchanged; and RMBG is never called.

Representative assertion:

```python
base = Image.new("RGBA", (6, 4), (10, 20, 30, 128))
candidate = Image.new("RGB", (1024, 1024), (200, 100, 50))
result = compose_result_refinement(base, annotations, manifest, {"coin-tile-001": candidate})
assert result.getpixel((0, 0)) == base.getpixel((0, 0))
assert result.getpixel((3, 2)) == (200, 100, 50, 128)
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
python3 -m unittest scripts.test_result_refinement_roi scripts.test_finalize_targeted_job -v
```

Expected: The current finalizer rejects RGB, accepts only one full-canvas candidate, and has no ROI-manifest support.

- [ ] **Step 3: Implement mask rasterization and composition**

Add:

```python
def antialiased_polygon_mask(size, points, scale=4):
    large = Image.new("L", (size[0] * scale, size[1] * scale), 0)
    draw = ImageDraw.Draw(large)
    draw.polygon([(round(x * scale), round(y * scale)) for x, y in points], fill=255)
    return large.resize(size, Image.Resampling.LANCZOS)

def crop_native_candidate(candidate, roi_job):
    canvas = roi_job["canvas"]
    if candidate.size != (canvas["width"], canvas["height"]):
        raise ValueError("candidate must preserve the prepared standard canvas")
    region = roi_job["content_region"]
    return candidate.crop((
        region["x"],
        region["y"],
        region["x"] + region["width"],
        region["y"] + region["height"],
    ))

def validate_candidate_bindings(manifest, bindings):
    expected = {job["roi_id"] for job in manifest["roi_jobs"]}
    supplied = set(bindings)
    if supplied != expected:
        missing = sorted(expected - supplied)
        unknown = sorted(supplied - expected)
        raise ValueError(f"candidate bindings mismatch: missing={missing}, unknown={unknown}")

def assert_unapproved_pixels_locked(base, result, approved_mask):
    base_bytes = base.convert("RGBA").tobytes()
    result_bytes = result.convert("RGBA").tobytes()
    mask_bytes = approved_mask.tobytes()
    for index, approved in enumerate(mask_bytes):
        if approved == 0:
            offset = index * 4
            if base_bytes[offset:offset + 4] != result_bytes[offset:offset + 4]:
                raise ValueError("unapproved RGBA pixels changed")
```

Implement `checkerboard_score` by comparing each RGB image with x/y shifts for periods 8, 12, 16, 24, and 32 and rejecting a candidate when both alternating-cell similarity and adjacent-cell contrast exceed the tested fixture threshold. Implement `compose_result_refinement` with the fixed order: copy base; composite candidate RGB through repair masks; apply explicit Alpha inclusion and erase/outside-delete; restore protect RGBA; compare all unapproved bytes to base. Candidate Alpha never silently replaces base Alpha.

- [ ] **Step 4: Extend finalizer CLI without breaking other routes**

Keep the existing single `--generated-input /path.png` behavior for non-refinement routes. For version-2 refinement, accept repeatable bindings:

```bash
--generated-input coin-left-tile-001=/absolute/generated/coin-left.png
--generated-input coin-right-tile-001=/absolute/generated/coin-right.png
```

Permit zero bindings only when the manifest contains zero ROI jobs. The finalizer remains the terminal tool call and atomically writes output/report only after validation.

The completed execution report adds:

```json
{
  "roi_count": 2,
  "candidate_count": 2,
  "imagegen_call_budget": 4,
  "asset_dimensions": {"width": 1024, "height": 1243},
  "validation_results": {
    "dimensions": true,
    "alpha": true,
    "annotation_conformance": true,
    "outside_pixel_lock": true,
    "no_baked_checkerboard": true,
    "structure_integrity": true
  }
}
```

Any failed validation writes the same field as `false` in a failed report and never publishes the reserved version file.

- [ ] **Step 5: Run focused and full Python tests**

Run:

```bash
python3 -m unittest scripts.test_result_refinement_roi scripts.test_finalize_targeted_job -v
python3 -m unittest discover -s scripts -p 'test_*.py' -v
python3 -m py_compile scripts/result_refinement_roi.py scripts/finalize-targeted-job.py
```

Expected: All Python tests pass and compilation succeeds.

- [ ] **Step 6: Commit**

```bash
git add scripts/result_refinement_roi.py scripts/test_result_refinement_roi.py scripts/finalize-targeted-job.py scripts/test_finalize_targeted_job.py
git commit -m "feat: finalize local PNG refinement candidates"
```

---

### Task 7: Update Codex Message, Skill, and Documentation Contracts

**Files:**
- Modify: `codex-thread-bridge.mjs:320-390`
- Modify: `src/codex-thread-bridge.test.mjs`
- Modify: `plugin-template/imvia-layer/skills/split-ui-design-layers-workbench-targeted/SKILL.md`
- Modify: `README.md`
- Modify: `docs/guides/imvia-layer-workbench-user-guide.md`
- Modify: `docs/superpowers/specs/2026-08-10-png-result-refinement-roi-execution-design.md` only to synchronize exact implemented field names; do not change confirmed behavior.

**Interfaces:**
- Consumes: Version-2 operation, ROI manifest, installation-selected Python invocation, and finalizer candidate-binding syntax.
- Produces: A self-contained visible Codex task message and installed skill contract that execute the new flow without technical prompting from the user.

- [ ] **Step 1: Write failing bridge and skill-contract tests**

Require the generated message and skill to contain all of the following:

- current successful PNG is the only authoritative base;
- local repair follows the ROI manifest one job at a time;
- native 1:1 mapping and no resizing;
- normalized user requirement and structured summary;
- exact repair ROI count and call budget;
- no ImageGen for deterministic-only erase/outside-delete;
- RGB candidates are allowed but candidate Alpha is not authoritative;
- repeatable `--generated-input roi-id=/absolute/path.png` finalizer syntax;
- no RMBG;
- finalizer as last tool call;
- the installation-selected Python command, including Windows `py -3`.

Remove tests and copy that describe text-only refinement as implicitly full-canvas or demand one full-canvas RGBA candidate.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node --test src/codex-thread-bridge.test.mjs src/split-execution.test.mjs
```

Expected: Current copy still attaches one full reference canvas and permits implicit text-only editing.

- [ ] **Step 3: Compile the execution message from structured policy**

For each result-refinement layer, emit this structure with actual job values:

```text
PNG 结果局部精修层：按钮。
当前成功 PNG 是唯一权威 base；最终尺寸锁定为 1024×1243，禁止缩放或改变画布。
系统理解：2 个修复路径、1 个删除路径、0 个保护路径；路径外保持；非整图编辑。
用户目标：补全两个金币，保持原位置、大小、材质和光影。
先运行选定 Python 与 prepare-targeted-imagegen-canvas.py。
读取返回的 ROI manifest；每个 roi_job 只使用自己的 reference_path，原生 1:1 生成候选。
候选可为 RGB 或 RGBA；不得绘制棋盘格，候选 Alpha 不具有最终决定权。
最后运行选定 Python 与 finalize-targeted-job.py，并绑定每个 roi-id 和候选绝对路径。
```

If `roi_jobs` is empty, state that ImageGen must not be called and the finalizer performs deterministic Alpha operations only.

- [ ] **Step 4: Update the plugin skill**

Replace the old `result_refinement` section with the exact version-2 workflow. Preserve terminal finalizer semantics and one retry per ROI. Explicitly forbid original-source fallback, earlier PNG versions, RMBG, whole-page analysis, forced resize, chroma masks, and prompt-inferred deletion.

- [ ] **Step 5: Synchronize documentation**

Add README links to both confirmed documents. Ensure the guide and system spec use the implemented names `refinement_operation`, `roi_policy`, `subject_path_ids`, `alpha_include_path_ids`, and `result_refinement_roi_manifest` without changing approved behavior.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
node --test src/codex-thread-bridge.test.mjs src/split-execution.test.mjs
npm test
git diff --check
```

Expected: All Node tests pass and the diff check is clean.

Commit:

```bash
git add codex-thread-bridge.mjs src/codex-thread-bridge.test.mjs plugin-template/imvia-layer/skills/split-ui-design-layers-workbench-targeted/SKILL.md README.md docs/guides/imvia-layer-workbench-user-guide.md docs/superpowers/specs/2026-08-10-png-result-refinement-roi-execution-design.md
git commit -m "docs: publish local PNG refinement contract"
```

---

### Task 8: Full Regression, Real Workbench Verification, and Local Plugin Refresh

**Files:**
- Modify only after a verified failure: files from Tasks 2–7
- Update: `HANDOFF.md`
- Install from: `plugin-template/imvia-layer/`

**Interfaces:**
- Consumes: All implementation commits from Tasks 1–7.
- Produces: Tested source, refreshed personal plugin, and verified end-to-end behavior in the real workbench.

- [ ] **Step 1: Run every automated test and build**

Run:

```bash
npm test
npm run build
python3 -m unittest discover -s scripts -p 'test_*.py' -v
git diff --check
```

Expected: All Node and Python tests pass, Vite builds without warnings, and the diff check is clean.

- [ ] **Step 2: Verify deterministic-only PNG editing in the browser**

Open the workbench through the local plugin, load a successful transparent PNG, draw one erase path, and submit without a repair prompt.

Expected:

- summary reports zero repair ROIs and one erase path;
- visible Codex copy says ImageGen must not be called;
- final PNG preserves dimensions;
- only erase-path Alpha changes;
- original successful PNG remains visible until completion.

- [ ] **Step 3: Verify two independent repair ROIs**

On a PNG containing two separate damaged objects:

1. Draw one boundary path around each object.
2. Enter `补全两个已标注对象，保持原位置、大小、材质和光影；其他内容不得变化`.
3. Confirm the summary reports two repair paths.
4. Submit.

Expected:

- preparation returns two ROI jobs at native 1:1 scale;
- ImageGen never receives the whole base as one mutable region;
- each ROI receives at most two calls;
- final dimensions equal the base;
- pixels outside both repair masks are byte-for-byte unchanged;
- no horizontal compression, vertical stretch, or overall recomposition occurs.

- [ ] **Step 4: Verify outside deletion and full-canvas protection**

Verify that outside deletion cannot be enabled without a subject boundary; a selected boundary can become the subject; outside deletion clears only outside Alpha; a protect path restores base RGBA over erase; and full-canvas mode requires a second confirmation.

- [ ] **Step 5: Verify failure and version behavior**

Use a deliberately wrong-sized candidate and a baked-checkerboard candidate.

Expected:

- finalizer writes a failed report and no new final PNG;
- current base remains visible and downloadable;
- retry applies only to the failed ROI and only once;
- later success writes a new version rather than overwriting its parent.

- [ ] **Step 6: Refresh the personal plugin**

Run from `ui-layer-review-canvas`:

```bash
npm run install:codex-plugin
```

Expected: Installation creates a new `imvia-layer@personal` version. Installed skill, logo, and start-script hashes match the source template. Restart Codex Desktop or open a new task only if the new plugin version is not reloaded automatically.

- [ ] **Step 7: Update handoff and commit verification evidence**

Record final Node/Python/build counts, installed plugin version, tested base/output dimensions, ROI and call counts, outside-mask byte-lock evidence, deterministic erase result, two-ROI result, and any remaining model-quality limitation that is not a contract failure.

Commit:

```bash
git add HANDOFF.md
git commit -m "docs: record PNG refinement verification"
```

- [ ] **Step 8: Confirm final repository state**

Run:

```bash
git status --short
git log -10 --oneline
```

Expected: Worktree is clean and Task 1–8 commits appear in order.
