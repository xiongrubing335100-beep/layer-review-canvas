# Workbench Split Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce targeted UI split latency without adding an extra Codex turn, while keeping exact crop, alpha, annotation, and output guarantees.

**Architecture:** Classify each submitted layer into a deterministic execution route before dispatch, send Codex only the visual context required by that route, and keep intent normalization inside the existing split turn. Record timestamps across the browser, Vite bridge, Codex turn, executor, and PNG validation so the fixed benchmark set can verify the improvement.

**Tech Stack:** React 19, Vite 8, Node.js ESM, Node test runner, Codex app-server bridge, local Codex Skill Markdown.

## Global Constraints

- Do not connect an external model API or require another API key.
- Prompt normalization and image splitting must use one Codex turn.
- The UI must enter a visible processing state within 150ms of clicking “拆分”.
- Fast mode must not perform full-page analysis, candidate generation, or automatic retry.
- Fast mode may use generative repair only for explicit text removal, hole filling, or occlusion completion.
- Simple source-pixel extraction median latency must improve by at least 40% against the captured baseline.
- Users must be able to switch, select, and edit other nodes while a split task runs.
- Output dimensions, crop-relative position, annotations, and real RGBA transparency remain hard requirements.

## File Structure

- Create `src/split-execution.js`: pure requirement composition and execution-route classification.
- Create `src/split-execution.test.mjs`: route and normalization unit tests.
- Create `src/execution-timing.js`: timing schema, merge, duration, and summary helpers.
- Create `src/execution-timing.test.mjs`: timing helper unit tests.
- Create `src/performance-metrics.js`: median and route-summary calculations.
- Create `src/performance-metrics.test.mjs`: performance calculation unit tests.
- Create `scripts/report-split-performance.mjs`: scan job records and report route latency.
- Modify `src/main.jsx`: add route hints, yield before expensive crop preparation, and consume timing/status fields.
- Modify `src/job-state.js`: support `needs_confirmation` and timing-aware terminal state.
- Modify `src/job-state.test.mjs`: cover confirmation and finalization behavior.
- Modify `codex-thread-bridge.mjs`: build a compact prompt and route-aware local-image input.
- Create `src/codex-thread-bridge.test.mjs`: verify prompt and attachment selection.
- Modify `vite.config.js`: persist timing events and merge executor reports into the status response.
- Modify `package.json`: add the split performance reporting command.
- Modify `C:/Users/Amoiz/.codex/skills/split-ui-design-layers-workbench-targeted/SKILL.md`: add single-turn normalization, route contracts, ambiguity handling, and timing report requirements.

## Pre-Implementation Baseline Gate

Before Task 1 changes runtime behavior, submit the five approved benchmark scenarios through the current unmodified workbench and record their generated `layer-job-*` directory names. Do not delete `output/jobs`; Task 6 will use those exact job directories as the baseline set. Record for each job: scenario name, job id, mode, submitted timestamp, completed timestamp, and whether a PNG passed the current dimension/alpha checks.

After every submission, identify the newest job with:

```powershell
$benchmarkDirectory = New-Item -ItemType Directory -Force output/benchmarks
$newestJob = Get-ChildItem output/jobs -Directory -Filter 'layer-job-*' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$newestJob.Name | Add-Content -LiteralPath (Join-Path $benchmarkDirectory 'baseline-job-ids.txt')
$newestJob | Select-Object Name, LastWriteTime
```

---

### Task 1: Deterministic Requirement And Route Classification

**Files:**
- Create: `src/split-execution.js`
- Create: `src/split-execution.test.mjs`
- Modify: `src/main.jsx:97-102`
- Modify: `src/main.jsx:1744-1785`

**Interfaces:**
- Consumes: `{ category, categoryDefault, requirement, refinementPrompt, executionMode, removeBackground }`.
- Produces: `combinedRequirement(input): string` and `classifyExecutionRoute(input): 'direct_crop' | 'alpha_extract' | 'targeted_repair'`.

- [ ] **Step 1: Write failing tests for composition and all three routes**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyExecutionRoute, combinedRequirement } from './split-execution.js';

test('keeps explicit user intent and appends refinement once', () => {
  assert.equal(combinedRequirement({
    categoryDefault: '保留组件。',
    requirement: '只要卡片底板',
    refinementPrompt: '删除右下角数字',
  }), '只要卡片底板\n\n精修补充：删除右下角数字');
});

test('uses the category default only when requirement is empty', () => {
  assert.equal(combinedRequirement({
    categoryDefault: '保留标题并输出透明 PNG。',
    requirement: '   ',
    refinementPrompt: '',
  }), '保留标题并输出透明 PNG。');
});

test('chooses direct crop when no alpha or repair is requested', () => {
  assert.equal(classifyExecutionRoute({
    category: 'kvElement',
    requirement: '保持框内原始像素',
    refinementPrompt: '',
    removeBackground: false,
  }), 'direct_crop');
});

test('chooses alpha extraction for a clean subject cutout', () => {
  assert.equal(classifyExecutionRoute({
    category: 'kvElement',
    requirement: '保留图标和附着阴影',
    refinementPrompt: '',
    removeBackground: true,
  }), 'alpha_extract');
});

test('chooses targeted repair only for explicit repair work', () => {
  assert.equal(classifyExecutionRoute({
    category: 'uiComponent',
    requirement: '移除文字并补全底板',
    refinementPrompt: '',
    removeBackground: true,
  }), 'targeted_repair');
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `node --test --test-name-pattern="route|requirement|crop|alpha|repair" src/split-execution.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `split-execution.js`.

- [ ] **Step 3: Implement the minimal pure helpers**

```js
const repairIntent = /(移除|删除|去掉|去除).{0,8}(文字|数字|水印|内容)|补全.{0,12}(底板|空洞|遮挡|缺口)|修复.{0,8}(空洞|遮挡|缺口)/;

export function combinedRequirement({
  categoryDefault = '',
  requirement = '',
  refinementPrompt = '',
}) {
  const base = String(requirement).trim() || String(categoryDefault).trim();
  const refinement = String(refinementPrompt).trim();
  return [base, refinement ? `精修补充：${refinement}` : ''].filter(Boolean).join('\n\n');
}

export function classifyExecutionRoute({
  requirement = '',
  refinementPrompt = '',
  removeBackground = false,
}) {
  const intent = `${requirement}\n${refinementPrompt}`;
  if (repairIntent.test(intent)) return 'targeted_repair';
  return removeBackground ? 'alpha_extract' : 'direct_crop';
}
```

- [ ] **Step 4: Integrate the helpers into `buildPlan`**

```js
import { classifyExecutionRoute, combinedRequirement } from './split-execution.js';

const normalizedRequirement = combinedRequirement({
  categoryDefault: categoryMeta[node.category].defaultRequirement,
  requirement: node.requirement,
  refinementPrompt: node.refinementPrompt,
});

// Insert these fields directly after `name: node.name`
// in the existing object returned by planLayers.map().
requirement: normalizedRequirement,
refinement_requirement: String(node.refinementPrompt || '').trim() || null,
execution_route_hint: classifyExecutionRoute({
  category: node.category,
  requirement: node.requirement,
  refinementPrompt: node.refinementPrompt,
  removeBackground: Boolean(node.removeBackground),
}),
```

Remove the old local `combinedRequirement(requirement, refinementPrompt)` function after all callers use the imported helper.

- [ ] **Step 5: Run all tests and build**

Run: `npm test && npm run build`

Expected: all tests PASS and Vite build exits 0.

- [ ] **Step 6: Commit**

```powershell
git add -- ui-layer-review-canvas/src/split-execution.js ui-layer-review-canvas/src/split-execution.test.mjs ui-layer-review-canvas/src/main.jsx
git -c user.name=Codex -c user.email=codex@local commit -m "feat: classify targeted split execution routes"
```

### Task 2: Compact Codex Prompt And Route-Aware Attachments

**Files:**
- Modify: `codex-thread-bridge.mjs:280-344`
- Create: `src/codex-thread-bridge.test.mjs`

**Interfaces:**
- Consumes: parsed workbench plan, job paths, source path, and crop paths.
- Produces: `buildWorkbenchPrompt(context): string` and `buildWorkbenchTurnInput(context): Array<{type: string}>`.

- [ ] **Step 1: Write failing tests for prompt size and attachment policy**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkbenchPrompt,
  buildWorkbenchTurnInput,
} from '../codex-thread-bridge.mjs';

const base = {
  jobId: 'job-1',
  jobPath: 'C:/jobs/job-1/layer-review-plan.json',
  sourcePath: 'C:/images/source.png',
  outputDirectory: 'C:/jobs/job-1/final',
  reviewCropPaths: ['C:/jobs/job-1/01-selection.png'],
};

test('compact prompt points to the authoritative plan without duplicating requirements', () => {
  const prompt = buildWorkbenchPrompt({
    ...base,
    plan: { layers: [{ name: '卡片', requirement: 'UNIQUE_LONG_REQUIREMENT' }] },
  });
  assert.equal(prompt.includes('UNIQUE_LONG_REQUIREMENT'), false);
  assert.ok(prompt.includes(base.jobPath));
  assert.ok(prompt.length < 1400);
});

test('fast alpha extraction attaches only the crop image', () => {
  const input = buildWorkbenchTurnInput({
    ...base,
    prompt: 'run',
    plan: { layers: [{ execution_mode: 'fast', execution_route_hint: 'alpha_extract' }] },
  });
  assert.deepEqual(input.filter((item) => item.type === 'localImage').map((item) => item.path), base.reviewCropPaths);
});

test('targeted repair attaches source context and crop image', () => {
  const input = buildWorkbenchTurnInput({
    ...base,
    prompt: 'run',
    plan: { layers: [{ execution_mode: 'fast', execution_route_hint: 'targeted_repair' }] },
  });
  assert.deepEqual(input.filter((item) => item.type === 'localImage').map((item) => item.path), [
    base.sourcePath,
    ...base.reviewCropPaths,
  ]);
});
```

- [ ] **Step 2: Run the bridge tests and verify missing exports**

Run: `node --test src/codex-thread-bridge.test.mjs`

Expected: FAIL because `buildWorkbenchPrompt` and `buildWorkbenchTurnInput` are not exported.

- [ ] **Step 3: Extract compact prompt and input builders**

```js
export function buildWorkbenchPrompt({
  jobId,
  jobPath,
  sourcePath,
  outputDirectory,
}) {
  return [
    '执行本地 UI 拆图工作台的已确认任务。',
    `任务编号：${jobId}`,
    `权威计划：${jobPath}`,
    `原图路径：${sourcePath}`,
    `唯一输出目录：${outputDirectory}`,
    `严格调用：[$${splitSkillName}](${splitSkillPath})`,
    '只处理计划 layers[]；在同一 turn 内规范化简短需求并执行。',
    '遵守 execution_mode 与 execution_route_hint；不要全页诊断、增加图层或生成候选。',
    '开始时发送一条简短进度，完成时交付 PNG；处理中不要重复发送耗时消息。',
  ].join('\n');
}

export function buildWorkbenchTurnInput({
  prompt,
  plan,
  sourcePath,
  reviewCropPaths,
}) {
  const needsSource = plan.layers.some((layer) => (
    layer.execution_mode === 'quality'
    || layer.execution_route_hint === 'targeted_repair'
    || layer.category === 'kvBackground'
  ));
  return [
    { type: 'text', text: prompt, text_elements: [] },
    ...(needsSource ? [{ type: 'localImage', path: sourcePath, detail: 'high' }] : []),
    ...reviewCropPaths.map((path) => ({ type: 'localImage', path, detail: 'high' })),
  ];
}
```

- [ ] **Step 4: Use the builders in `sendPlanToCurrentThread`**

Replace `layerSummary`, the duplicated multi-paragraph prompt, and the unconditional source attachment with the two pure builders. Keep `thread/resume`, `turn/start`, `turn/started`, and completion monitoring unchanged.

```js
const prompt = buildWorkbenchPrompt({
  jobId,
  jobPath,
  sourcePath,
  outputDirectory,
});
const input = buildWorkbenchTurnInput({
  prompt,
  plan,
  sourcePath,
  reviewCropPaths,
});
const turn = await client.request('turn/start', {
  threadId,
  clientUserMessageId: randomUUID(),
  input,
  responsesapiClientMetadata: { source: 'ui-layer-review-canvas', job_id: jobId },
});
```

- [ ] **Step 5: Run bridge tests, all tests, and build**

Run: `node --test src/codex-thread-bridge.test.mjs && npm test && npm run build`

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```powershell
git add -- ui-layer-review-canvas/codex-thread-bridge.mjs ui-layer-review-canvas/src/codex-thread-bridge.test.mjs
git -c user.name=Codex -c user.email=codex@local commit -m "perf: reduce targeted split turn payload"
```

### Task 3: Job Timing Lifecycle And Stable Terminal States

**Files:**
- Create: `src/execution-timing.js`
- Create: `src/execution-timing.test.mjs`
- Modify: `vite.config.js:32-116`
- Modify: `vite.config.js:121-232`
- Modify: `src/job-state.js`
- Modify: `src/job-state.test.mjs`

**Interfaces:**
- Consumes: job timing object, executor report timing object, and ISO timestamps.
- Produces: `markTiming(timing, stage, value)`, `mergeTiming(jobTiming, reportTiming)`, and status API fields `timing`, `execution_route`.

- [ ] **Step 1: Write failing timing and confirmation tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { markTiming, mergeTiming } from './execution-timing.js';

test('markTiming preserves existing stages', () => {
  const timing = markTiming({ submitted_at: '2026-07-27T00:00:00.000Z' }, 'codex_turn_started_at', '2026-07-27T00:00:01.000Z');
  assert.equal(timing.submitted_at, '2026-07-27T00:00:00.000Z');
  assert.equal(timing.codex_turn_started_at, '2026-07-27T00:00:01.000Z');
});

test('executor timing wins only for fields it reports', () => {
  assert.deepEqual(mergeTiming(
    { submitted_at: 'a', codex_turn_started_at: 'b' },
    { intent_normalized_at: 'c' },
  ), {
    submitted_at: 'a',
    codex_turn_started_at: 'b',
    intent_normalized_at: 'c',
  });
});
```

Add to `src/job-state.test.mjs`:

```js
test('a confirmation request is not shown as processing', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'needs_confirmation',
    turnStatus: 'completed',
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'needs_confirmation',
    detail: 'Codex 需要确认拆分目标后才能继续',
  });
});
```

- [ ] **Step 2: Run tests and verify failures**

Run: `npm test`

Expected: FAIL for missing timing module and unhandled `needs_confirmation`.

- [ ] **Step 3: Implement timing helpers**

```js
export function markTiming(timing = {}, stage, value = new Date().toISOString()) {
  return { ...timing, [stage]: value };
}

export function mergeTiming(jobTiming = {}, reportTiming = {}) {
  return Object.fromEntries(
    Object.entries({ ...jobTiming, ...reportTiming }).filter(([, value]) => Boolean(value)),
  );
}
```

- [ ] **Step 4: Persist bridge lifecycle timing**

In `vite.config.js`:

- Set `execution_timing.submitted_at` when creating the job.
- Set `codex_turn_started_at` immediately after `sendPlanToCurrentThread` returns.
- Set `completed_at` in the completion handler.
- Read `execution-report.json` when present and merge its `timing` and `execution_route` into the job status response.
- Treat a report with `status: 'needs_confirmation'` as `needs_confirmation`, not `processing`.

Use the same immutable timing merge on each write:

```js
const job = {
  ...normalizedPayload,
  job_id: jobId,
  status: 'sending_to_codex',
  submitted_at: submittedAt,
  output_directory: outputDirectory,
  execution_timing: markTiming({}, 'submitted_at', submittedAt),
  execution: {
    skill_path: splitSkillPath,
    plan_is_authoritative: true,
    deliver_selected_layers_only: true,
    auto_add_layers: false,
    mode_contract: 'per_layer',
  },
};

const dispatchedAt = new Date().toISOString();
await writeFile(jobPath, JSON.stringify({
  ...job,
  status: 'sent_to_codex',
  codex_thread_id: dispatch.threadId,
  codex_turn_id: dispatch.turnId,
  execution_timing: markTiming(job.execution_timing, 'codex_turn_started_at', dispatchedAt),
}, null, 2));
```

Read the report without failing older jobs that do not have it:

```js
async function readExecutionReport(jobDirectory) {
  try {
    return JSON.parse(await readFile(path.join(jobDirectory, 'execution-report.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
```

The status response must include:

```js
{
  timing: mergeTiming(plan.execution_timing, executionReport?.timing),
  execution_route: executionReport?.execution_route
    || plan.layers?.[0]?.execution_route_hint
    || null,
}
```

- [ ] **Step 5: Update status reconciliation**

Handle `planStatus === 'needs_confirmation'` before completed-turn/no-PNG failure logic so confirmation does not become a false failure.

```js
if (planStatus === 'needs_confirmation') {
  return {
    status: 'needs_confirmation',
    detail: 'Codex 需要确认拆分目标后才能继续',
  };
}
```

- [ ] **Step 6: Run all tests and build**

Run: `npm test && npm run build`

Expected: all tests PASS and Vite build exits 0.

- [ ] **Step 7: Commit**

```powershell
git add -- ui-layer-review-canvas/src/execution-timing.js ui-layer-review-canvas/src/execution-timing.test.mjs ui-layer-review-canvas/src/job-state.js ui-layer-review-canvas/src/job-state.test.mjs ui-layer-review-canvas/vite.config.js
git -c user.name=Codex -c user.email=codex@local commit -m "feat: track targeted split lifecycle timing"
```

### Task 4: Single-Turn Fast-Path Executor Contract

**Files:**
- Modify: `C:/Users/Amoiz/.codex/skills/split-ui-design-layers-workbench-targeted/SKILL.md`

**Interfaces:**
- Consumes: `execution_route_hint`, `execution_mode`, selected crop, annotations, remove-background setting, and user requirement.
- Produces: one PNG per successful record and `execution-report.json` with `status`, `execution_route`, `timing`, and validation results.

- [ ] **Step 1: Add the route and report contract to the Skill**

Add exact instructions:

```markdown
## Single-Turn Intent Normalization

Normalize short, colloquial, or empty requirements inside this same execution turn.
Do not create another Codex turn and do not pause for ordinary normalization.
Preserve explicit user instructions. Use the category route only to fill missing constraints.
Pause only when ownership of multiple independent components is unresolved, keep/remove
instructions conflict on the same structure, or the request both preserves and removes the same target.

## Execution Route Hint

- `direct_crop`: crop exact source pixels, skip segmentation and generation.
- `alpha_extract`: create one subject mask, composite real RGBA, skip generation.
- `targeted_repair`: repair only approved holes, then composite the exact crop.

For `fast`, do not create candidates, perform full-page analysis, retry, or call ImageGen
outside `targeted_repair`. For `quality`, keep the same route but add the existing validation
depth and at most one local retry.

## Performance Report

Write `execution-report.json` outside `final/` with:
`status`, `execution_route`, `timing.submitted_at`, `timing.codex_turn_started_at`,
`timing.intent_normalized_at`, `timing.extraction_started_at`, optional
`timing.repair_started_at`, `timing.validation_started_at`, and `timing.completed_at`.
```

- [ ] **Step 2: Remove latency-producing executor ambiguity**

Delete or replace instructions that could trigger:

- Whole-page rediscovery.
- Multiple candidates in fast mode.
- Unconditional generation.
- More than one progress message before final delivery.
- Retry or quality upgrade after a fast-mode failure.

Do not weaken dimension, alpha, coordinate, mask-priority, or output-directory checks.

- [ ] **Step 3: Validate the Skill contract text**

Run:

```powershell
$skill = Get-Content -Raw '<repo-root>\plugin-template\imvia-layer\skills\split-ui-design-layers-workbench-targeted\SKILL.md'
@('direct_crop','alpha_extract','targeted_repair','Single-Turn Intent Normalization','execution-report.json') |
  ForEach-Object { if (-not $skill.Contains($_)) { throw "Missing contract: $_" } }
```

Expected: command exits 0 without output.

- [ ] **Step 4: Commit the project-side contract reference**

The Skill is outside the project repository, so do not stage it. Record its absolute path and expected contract in the implementation handoff. The project commits from Tasks 1–3 are the reproducible integration boundary.

### Task 5: Immediate UI Feedback And Non-Blocking Node Editing

**Files:**
- Modify: `src/main.jsx:604-606`
- Modify: `src/main.jsx:1858-1941`
- Modify: `src/main.jsx:2430-2455`

**Interfaces:**
- Consumes: local submission state and status API fields `timing`, `execution_route`.
- Produces: per-node pending state that paints before crop encoding and survives node switching.

- [ ] **Step 1: Add a failing helper test for yielding to paint**

Add to `src/split-execution.test.mjs`:

```js
import { nextPaint } from './split-execution.js';

test('nextPaint resolves on the next animation frame', async () => {
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => callback(12);
  try {
    assert.equal(await nextPaint(), 12);
  } finally {
    globalThis.requestAnimationFrame = original;
  }
});
```

- [ ] **Step 2: Run the test and verify the missing export**

Run: `node --test --test-name-pattern="next animation frame" src/split-execution.test.mjs`

Expected: FAIL because `nextPaint` is not exported.

- [ ] **Step 3: Implement `nextPaint`**

```js
export function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}
```

- [ ] **Step 4: Yield after local pending state is created**

In `submitLayers`, immediately after `setLocalSubmissions(...)`:

```js
await nextPaint();
```

Keep expensive crop encoding after this yield. Continue using `submittingNodeId` for the submitted node only; do not disable selection, frame editing, navigation, or other node fields.

- [ ] **Step 5: Store timing and route fields from API updates**

When polling and inserting jobs, retain:

```js
timing: update.timing || job.timing || {},
executionRoute: update.execution_route || job.executionRoute || null,
```

For `needs_confirmation`, display “需要确认” and stop the elapsed processing animation. Do not add a modal; the existing right inspector remains editable.

- [ ] **Step 6: Run tests, build, and browser interaction checks**

Run: `npm test && npm run build`

Browser checks:

1. Click “拆分” and confirm the current node shows processing before the submit request finishes.
2. Switch to another node and edit its frame while the first node remains processing.
3. Return to the submitted node and confirm its elapsed time continues.
4. Confirm a completed, failed, or confirmation task does not remain animated.

- [ ] **Step 7: Commit**

```powershell
git add -- ui-layer-review-canvas/src/main.jsx ui-layer-review-canvas/src/split-execution.js ui-layer-review-canvas/src/split-execution.test.mjs
git -c user.name=Codex -c user.email=codex@local commit -m "perf: keep split submission feedback responsive"
```

### Task 6: Performance Report And Fixed Benchmark Gate

**Files:**
- Create: `src/performance-metrics.js`
- Create: `src/performance-metrics.test.mjs`
- Create: `scripts/report-split-performance.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: job plans and `execution-report.json` files under `output/jobs`.
- Produces: per-route counts, median seconds, failure counts, and baseline reduction percentage.

- [ ] **Step 1: Write failing median and reduction tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { median, reductionPercent, summarizeDurations } from './performance-metrics.js';

test('median handles odd and even samples', () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
});

test('reductionPercent compares current against baseline', () => {
  assert.equal(reductionPercent(100, 55), 45);
});

test('summarizeDurations groups successful samples by route', () => {
  assert.deepEqual(summarizeDurations([
    { route: 'direct_crop', seconds: 12, status: 'completed' },
    { route: 'direct_crop', seconds: 8, status: 'completed' },
    { route: 'alpha_extract', seconds: 40, status: 'failed' },
  ]), {
    direct_crop: { completed: 2, failed: 0, medianSeconds: 10 },
    alpha_extract: { completed: 0, failed: 1, medianSeconds: null },
  });
});
```

- [ ] **Step 2: Run tests and verify the missing-module failure**

Run: `node --test --test-name-pattern="median|reduction|groups successful" src/performance-metrics.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `performance-metrics.js`.

- [ ] **Step 3: Implement metrics helpers**

```js
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function reductionPercent(baseline, current) {
  return Math.round(((baseline - current) / baseline) * 1000) / 10;
}

export function summarizeDurations(samples) {
  return Object.fromEntries([...new Set(samples.map((item) => item.route))].map((route) => {
    const routeSamples = samples.filter((item) => item.route === route);
    const completed = routeSamples.filter((item) => item.status === 'completed');
    return [route, {
      completed: completed.length,
      failed: routeSamples.length - completed.length,
      medianSeconds: median(completed.map((item) => item.seconds)),
    }];
  }));
}
```

- [ ] **Step 4: Implement the report script**

The script must:

- Scan `output/jobs/layer-job-*`.
- Read `layer-review-plan.json` and optional `execution-report.json`.
- Compute duration from `submitted_at` to `completed_at`.
- Group by `execution_route`.
- Accept optional `--baseline <json>` and print reduction percentages.
- Exit non-zero with `--require-fast-improvement 40` when simple-route median improvement is below 40%.

Implement argument parsing and job scanning with Node built-ins:

```js
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { summarizeDurations, reductionPercent } from '../src/performance-metrics.js';

const jobsRoot = path.resolve('output', 'jobs');
const entries = await readdir(jobsRoot, { withFileTypes: true });
const samples = [];
const idsFlag = process.argv.indexOf('--job-ids');
const allowedJobIds = idsFlag >= 0
  ? new Set(process.argv[idsFlag + 1].split(',').map((value) => value.trim()).filter(Boolean))
  : null;

for (const entry of entries) {
  if (!entry.isDirectory() || !entry.name.startsWith('layer-job-')) continue;
  if (allowedJobIds && !allowedJobIds.has(entry.name)) continue;
  const jobDirectory = path.join(jobsRoot, entry.name);
  const plan = JSON.parse(await readFile(path.join(jobDirectory, 'layer-review-plan.json'), 'utf8'));
  let report = null;
  try {
    report = JSON.parse(await readFile(path.join(jobDirectory, 'execution-report.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const submitted = Date.parse(report?.timing?.submitted_at || plan.submitted_at || '');
  const completed = Date.parse(report?.timing?.completed_at || plan.codex_completed_at || '');
  if (!Number.isFinite(submitted) || !Number.isFinite(completed)) continue;
  samples.push({
    jobId: entry.name,
    route: report?.execution_route || plan.layers?.[0]?.execution_route_hint || 'legacy',
    seconds: (completed - submitted) / 1000,
    status: report?.status || plan.status,
  });
}

const summary = summarizeDurations(samples);
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), samples, summary }, null, 2));

const baselineFlag = process.argv.indexOf('--baseline');
const requiredFlag = process.argv.indexOf('--require-fast-improvement');
if (baselineFlag >= 0 && requiredFlag >= 0) {
  const baseline = JSON.parse(await readFile(path.resolve(process.argv[baselineFlag + 1]), 'utf8'));
  const required = Number(process.argv[requiredFlag + 1]);
  const routes = ['direct_crop', 'alpha_extract'];
  const improvements = routes.flatMap((route) => {
    const before = baseline.summary?.[route]?.medianSeconds;
    const after = summary[route]?.medianSeconds;
    return Number.isFinite(before) && Number.isFinite(after)
      ? [reductionPercent(before, after)]
      : [];
  });
  if (!improvements.length || Math.min(...improvements) < required) process.exitCode = 1;
}
```

Add:

```json
"benchmark:splits": "node scripts/report-split-performance.mjs"
```

to `package.json` scripts.

- [ ] **Step 5: Run unit tests and inspect current job history**

Run:

```powershell
npm test
$baselineJobIds = ((Get-Content output/benchmarks/baseline-job-ids.txt) -join ',')
node scripts/report-split-performance.mjs --job-ids $baselineJobIds > output/benchmarks/baseline.json
npm run benchmark:splits
```

Expected: tests PASS; `baseline.json` contains only the five pre-change jobs; the full benchmark prints route counts and available medians without crashing when older jobs lack detailed timing.

- [ ] **Step 6: Run the fixed five-scenario acceptance set**

Submit one job for each approved benchmark scenario:

1. Pure crop.
2. Single icon with transparency.
3. Text removal and base repair.
4. Local occlusion completion.
5. Ambiguous multi-component selection.

Save the pre-change baseline JSON, run the same inputs after changes, then run:

```powershell
npm run benchmark:splits -- --baseline output/benchmarks/baseline.json --require-fast-improvement 40
```

Expected:

- Command exits 0.
- Simple routes show at least 40% median improvement.
- All completed PNGs pass exact dimensions and real-alpha checks.
- Ambiguous task ends as `needs_confirmation`, not perpetual processing.

- [ ] **Step 7: Run final verification**

Run:

```powershell
npm test
npm run build
git status --short
```

Expected: tests and build PASS; only intended files are modified.

- [ ] **Step 8: Commit**

```powershell
git add -- ui-layer-review-canvas/src/performance-metrics.js ui-layer-review-canvas/src/performance-metrics.test.mjs ui-layer-review-canvas/scripts/report-split-performance.mjs ui-layer-review-canvas/package.json
git -c user.name=Codex -c user.email=codex@local commit -m "test: add targeted split performance gate"
```
