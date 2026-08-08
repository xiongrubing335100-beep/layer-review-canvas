# Workbench Targeted Split Latency Implementation Plan

日期：2026-08-03  
依据：`docs/superpowers/specs/2026-08-03-workbench-targeted-split-latency-design.md`  
状态：实施中（阶段 0-4 已完成，阶段 5 验证中）  
实现边界：只优化现有 ImageGen + RMBG 链路，不实现或引入任何本地语义修复

## 1. 成功标准

实施完成必须同时满足：

- 快速 `targeted_repair` 从 `confirmation_accepted_at` 到 `completed_at` 的 P50 不超过 120 秒、P90 不超过 240 秒。
- ImageGen 返回后的尺寸归一、RMBG、验收和终态写入合计不超过 30 秒。
- 快速模式最多调用一次 ImageGen，不自动升级质量模式，不自动重复生成。
- `remove_background: true` 必须运行现有 RMBG `isnet-general-use`，输出真实透明 RGBA PNG。
- 不使用 OpenCV 补洞、克隆、颜色阈值、轮廓、膨胀、模糊、自制 alpha 或其他本地语义修复替代 ImageGen/RMBG。
- `layers[]` 仍是唯一输出清单；每个确认层只产生一个最终 PNG。
- 最终 PNG 尺寸等于提交时框选尺寸，且 `execution-report.json` 与 PNG 原子一致。
- 三个开发门禁样本的人工盲看质量不低于当前基线；后续真实任务滚动累计，不把 15 个样本作为前置条件。

## 2. 实施原则

1. 每个阶段先写失败测试，再做最小实现，再运行阶段测试与全量测试。
2. 每个阶段由独立功能开关控制，可单独关闭。
3. 先固化观测和合同，再改执行路径；没有可信基线时不声称性能提升。
4. 本地执行器只能做可验证的机械工作。修复像素只能来自 ImageGen，透明 alpha 只能来自 RMBG。
5. 快速路径出现结构漂移、缺少可靠修复区域或验收失败时，明确失败，不伪造成功结果。

## 3. 阶段 0：冻结基线与补齐计时

### 任务 0.1：定义完整阶段计时和派生耗时

修改：

- `src/execution-timing.js`
- `src/execution-timing.test.mjs`

步骤：

1. 增加计时字段白名单：`submitted_at`、`confirmation_presented_at`、`confirmation_accepted_at`、`codex_turn_started_at`、`preflight_started_at`、`preflight_completed_at`、`imagegen_requested_at`、`imagegen_completed_at`、`postprocess_started_at`、`rmbg_started_at`、`rmbg_completed_at`、`validation_started_at`、`completed_at`。
2. 增加纯函数 `deriveDurations(timing)`，输出确认停留、派发、预检、ImageGen、后处理、RMBG、验收、机器总时间和用户可见总时间。
3. 对缺失、逆序和非法时间戳返回明确的不可用字段，不能生成负耗时。
4. 保留现有 `markTiming`、`mergeTiming` 和终态时间优先级行为。

测试：

- 完整时间链正确派生所有耗时。
- 用户确认停留不计入 `total_machine_ms`。
- 缺失阶段不会污染其他可计算阶段。
- 逆序时间戳被拒绝或标记无效。

验证命令：

```powershell
node --test src/execution-timing.test.mjs
```

### 任务 0.2：基准统计支持 P50、P90 和阶段耗时

修改：

- `src/performance-metrics.js`
- `src/performance-metrics.test.mjs`
- `scripts/report-split-performance.mjs`
- `src/report-split-performance.test.mjs`

步骤：

1. 增加确定性的 percentile 计算，明确 P90 的取样规则。
2. 按 execution route 汇总成功数、失败数、P50、P90、阶段中位数和最大后处理时间。
3. 性能门禁改用 `confirmation_accepted_at` 到 `completed_at`，不再用 `submitted_at`。
4. 增加 `--require-targeted-p50-seconds 120`、`--require-targeted-p90-seconds 240`、`--require-postprocess-seconds 30`。
5. 门禁仅接受含完整执行报告、单层计划、路线匹配和强制验收全部通过的样本。

测试：

- 奇偶样本和边界样本的 P50/P90 结果稳定。
- 缺少确认时间、报告或验收项时门禁失败。
- 用户确认停留很长但机器执行达标时门禁通过。
- 后处理超过 30 秒时单独失败。

验证命令：

```powershell
node --test src/performance-metrics.test.mjs src/report-split-performance.test.mjs
```

### 任务 0.3：建立 3 个开发门禁样本与滚动基线

新增/生成：

- `benchmarks/targeted-split/manifest.json`
- `benchmarks/targeted-split/baseline-2026-08-03.json`

步骤：

1. 固定三个代表性样本各一次：单图标 RMBG、平滑 UI 底板去字、复杂纹理或遮挡修复。
2. manifest 只引用现有 job 与输入，不复制 Base64。
3. 保存阶段计时、验收结果和人工盲看记录位置；确认时间戳缺失的旧任务只能作为历史参考。
4. 后续真实任务自动进入滚动样本池，累计到 10 个后再评估 P50/P90 稳定性，15 个只作为长期统计目标。
5. 此任务只记录基线，不修改 ImageGen 提示词、RMBG 或视觉算法。

验收：

- 3 个开发门禁样本均可追溯到原计划、输入和最终 PNG。
- 基线报告能够被性能脚本重新计算；缺少新计时字段的样本明确标记为历史参考。

## 4. 阶段 1：计划瘦身与路线感知附件

### 任务 1.1：提取服务端提交规范化器

新增：

- `src/submission-normalizer.js`
- `src/submission-normalizer.test.mjs`

修改：

- `vite.config.js`

步骤：

1. 将当前 `vite.config.js` 中 Base64 解码、源图落盘、裁切图落盘和字段删除逻辑提取为可测试纯边界模块。
2. 落盘成功后删除 `source.embedded_data_url` 与 `layers[].review_snapshot.embedded_crop_data_url`。
3. 计划中保留本地路径、原始框选、标注、路线、模式、策略和唯一输出目录。
4. 序列化后检查计划不超过 100 KB；超限时指出字段和大小并终止提交。
5. 用 `compact_plan_v1` 控制新路径；关闭时保持当前兼容行为。

测试：

- 落盘后的计划不含任何 `data:` URL。
- 源图和每层裁切图都存在且尺寸匹配。
- 超过 100 KB 的非图片字段被明确拒绝。
- 写文件失败时不产生半成品计划。
- 旧计划缺少新字段仍可读取。

验证命令：

```powershell
node --test src/submission-normalizer.test.mjs src/submission-delivery.test.mjs
```

### 任务 1.2：补齐执行路线元数据

修改：

- `src/split-execution.js`
- `src/split-execution.test.mjs`
- `src/main.jsx`

步骤：

1. 新增 `buildRouteMetadata` 纯函数，统一生成 `repair_engine`、`requires_global_context`、`maximum_imagegen_calls`、`rmbg_required` 和 `expected_output`。
2. `direct_crop` 与 `alpha_extract` 的 `repair_engine` 为 `none`，ImageGen 调用数为 0。
3. 快速 `targeted_repair` 的 `repair_engine` 为 `imagegen`，调用数固定为 1。
4. 简单去字默认不需要全图上下文；遮挡补全、背景修复、`kvBackground` 和 `quality` 默认需要。
5. `repair_regions` 只接受提交标注或之后 Codex 显式声明，不在前端猜测。

测试：

- 三条路线产生正确元数据。
- 简单去字只需要裁切图。
- 遮挡补全、背景层和质量模式需要原图上下文。
- 否定式需求不会误触发 ImageGen。

### 任务 1.3：按路线选择附件并缩短前台消息

修改：

- `codex-thread-bridge.mjs`
- `src/codex-thread-bridge.test.mjs`
- `layer-review-mcp-server.mjs`
- `src/mcp-bridge-server.test.mjs`

步骤：

1. 提取 `selectExecutionAttachments(layer, plan)` 纯函数。
2. `direct_crop` 不附加 ImageGen 输入说明；`alpha_extract` 只传裁切路径；简单 `targeted_repair` 只传裁切图；全局上下文任务传原图与裁切图。
3. 前台消息仅保留 jobId、权威计划、原图路径、唯一输出目录、skill、确认顺序和强制合同，删除重复解释。
4. 不改变当前会话确认、前台消息和监听器工作方式。
5. 用 `route_aware_context_v1` 控制新附件策略。

测试：

- 每种路线的附件集合精确匹配合同。
- 多层计划仍只描述 `layers[]`，不增加全页诊断。
- `confirm_layer_review_foreground_dispatch` 仍必须先成功。
- 缺少本地路径时明确失败，不回退 Base64。

## 5. 阶段 2：Targeted Preflight 执行器

### 任务 2.1：建立可测试的预检核心

新增：

- `src/targeted-preflight.js`
- `src/targeted-preflight.test.mjs`
- `scripts/prepare-targeted-job.mjs`

步骤：

1. 核心模块接收 job 根目录和 jobId，读取权威计划并返回 JSON 执行规格。
2. 验证 jobId、计划路径、输出目录、层数量与顺序、源图、裁切图和尺寸。
3. 验证输出目录解析后仍位于当前 job 的 `final/` 下，防止跨 job 写入。
4. 规范化简短需求时只折叠空白和重复合同，不改写用户显式语义。
5. 输出当前层、路线、上下文附件、期望尺寸、ImageGen 调用上限、RMBG 要求、生成中间目录和最终路径。
6. 写入 `preflight_started_at` / `preflight_completed_at`，但不触碰像素和 `final/`。
7. 预检失败原子写入唯一 failed 报告，随后退出非零码。
8. 用 `targeted_preflight_v1` 控制是否启用。

测试：

- 合法单层快速修复生成稳定执行规格。
- jobId 不一致、路径逃逸、尺寸不符、缺图、层数变化均失败。
- 预检不会创建最终 PNG。
- 失败报告只有一个明确错误并含完整预检计时。
- Windows 路径、空格和中文目录可正常处理。

验证命令：

```powershell
node --test src/targeted-preflight.test.mjs
node scripts/prepare-targeted-job.mjs --job-id <fixture-job-id>
```

### 任务 2.2：让 targeted skill 只承担视觉阶段

修改：

- `<repo-root>\plugin-template\imvia-layer\skills\split-ui-design-layers-workbench-targeted\SKILL.md`

步骤：

1. 确认成功后先运行 `prepare-targeted-job.mjs`。
2. 直接使用预检 JSON 构造一次 ImageGen 请求。
3. ImageGen 结果只能写入 job 的 `generated/`，禁止直写 `final/`。
4. ImageGen 成功后调用 finalizer；不再临时编写裁切、尺寸、蒙版、RMBG 或报告脚本。
5. 快速模式首次候选通过结构验收即进入 RMBG，不构造修复掩码或源像素重合成。
6. 首次候选失败时快速任务明确失败；不自动转本地修复，也不自动升级质量模式。

验收：

- skill 不包含任何本地补洞或 alpha 替代步骤。
- 一次快速任务的 ImageGen 调用数能够从报告中证明不超过 1。

## 6. 阶段 3：Targeted Finalizer 执行器

### 任务 3.1：定义原子终态和验收核心

新增：

- `scripts/finalize-targeted-job.py`
- `scripts/test_finalize_targeted_job.py`

修改：

- `requirements-rmbg.txt`（仅在现有依赖缺失时补测试依赖，不升级模型）

步骤：

1. 参数固定为 `--job-id`、`--layer-id` 和 `--generated-input`。
2. 重新读取权威计划，拒绝调用者覆盖输出目录、尺寸、RMBG 模型或层清单。
3. 验证输入可解码、位于 job 的 `generated/` 且未写入 `final/`。
4. 尺寸归一只允许不改变比例的居中裁切或透明补边；无法安全归一时失败，禁止非等比拉伸。
5. 默认不执行源像素保护。只有 `repair_regions` 与合法来源同时存在时，才允许把修复区域外的原始像素原样覆盖回来；本步骤不能生成新像素。
6. `remove_background: true` 必须调用 `finalize-rmbg.py`，模型固定 `isnet-general-use`。
7. 验证数量、尺寸、路径、alpha、标注、明显排除、结构完整性和修复目标。
8. 先写临时 PNG，验证通过后原子重命名到 `final/`，最后原子写 completed 报告。
9. 任一失败时删除本次临时 final，不删除历史无关文件，原子写 failed 报告。
10. 用 `targeted_finalizer_v1` 控制新执行器。

测试：

- 正确尺寸的 RGB/RGBA 候选可进入验收。
- 错误宽高比不会被拉伸通过。
- 没有合法修复区域时不会执行源像素覆盖。
- 合法修复区域之外像素逐像素保持不变。
- RMBG 失败、无透明像素或尺寸变化均不能写 completed。
- PNG 成功但报告写入失败时不能暴露 completed 状态。
- 报告 completed 时 final 中恰好存在预期 PNG。
- 失败不留下可被工作台误识别的 final PNG。

验证命令：

```powershell
python -m unittest scripts/test_finalize_targeted_job.py
```

### 任务 3.2：保持 RMBG 算法不变，开放测试边界

修改：

- `scripts/finalize-rmbg.py`
- `scripts/test_finalize_rmbg.py`

步骤：

1. 仅把参数解析、尺寸验证、session 创建、remove 调用和输出验证拆成小函数，算法参数保持 `alpha_matting=False`、模型保持 `isnet-general-use`。
2. 单元测试通过依赖注入模拟 session 和 remove，不下载模型。
3. 集成测试继续用真实环境运行一次 RMBG，验证 alpha 和尺寸。
4. 不实现色差、轮廓、自制 mask 或任何回退。

## 7. 阶段 4：终态回流与界面状态

### 任务 4.1：服务端只从一致终态报告宣布完成

修改：

- `vite.config.js`
- `src/job-state.js`
- `src/job-state.test.mjs`
- `src/workbench-lifecycle-store.js`
- `src/workbench-lifecycle-store.test.mjs`

步骤：

1. `completed` 必须同时满足报告为 completed、报告列出的 PNG 存在且强制验收通过。
2. PNG 存在但报告非 terminal 时统一映射为 `finalizing`，展示“正在验收”。
3. failed 报告立即终止轮询并返回单一可重试错误。
4. `completed_at` 只取执行报告，旧 job 才使用现有兼容回退。
5. 读取报告与文件列表时避免先后读造成瞬时假完成。

测试：

- PNG 先落盘不会提前 completed。
- 报告先落盘但 PNG 缺失不会 completed。
- completed 后计时停止，页面刷新后不继续累加。
- failed 不停留在 processing。

### 任务 4.2：前端展示阶段计时并降低轮询尾延迟

修改：

- `src/main.jsx`
- `src/workbench-lifecycle-ui.test.mjs`

步骤：

1. 将处理状态区分为确认、预检、生成、RMBG、验收和完成，不重新设计布局。
2. 只展示对用户有意义的当前阶段和总耗时，不堆叠调试字段。
3. terminal 前轮询间隔统一为 1 秒，terminal 后立即停止。
4. 保持结果只出现在结果区域和结果节点，框选预览继续使用原图裁切。

测试：

- `finalizing` 显示“正在验收”。
- terminal 后不再发状态请求。
- 旧 job 缺少新计时字段时仍能展示。

## 8. 阶段 5：集成验证与默认启用

当前记录（2026-08-03）：阶段 0-4 的实现、定向测试和构建已完成；终结器现在会写入 RMBG 与验收阶段时间戳。全量测试仅剩一项既有 `public/layer-review-bridge-widget.js` 品牌断言失败，该文件不属于本次性能改动；targeted 性能门禁已按新合同拒绝缺少 `confirmation_accepted_at` / 完整 executor timing 的历史任务。阶段 5 的真实 3 样本门禁仍待新计时链路产出样本后执行，不以历史数据替代。

### 任务 5.1：自动化回归

执行：

```powershell
npm test
npm run build
```

必须通过的既有合同：

- 当前会话确认和 listener-only 投递不回退。
- 单项提交只含一个层，批量提交只含确认层。
- 左侧缩略图和框选预览仍使用原图裁切。
- 最终结果只出现在结果区域和结果节点。
- 最终 PNG 尺寸锁定提交时框选尺寸。

### 任务 5.2：开发门禁与滚动性能质量验证

执行：

```powershell
npm run benchmark:splits -- --job-ids <3个开发门禁jobId> --require-targeted-p50-seconds 120 --require-targeted-p90-seconds 240 --require-postprocess-seconds 30
```

检查：

1. 三个开发门禁样本通过自动门禁。
2. 每个 completed 输出通过尺寸、真实 alpha、标注、明显排除和结构完整性验收。
3. 人工盲看不低于基线。
4. 快速模式每任务 ImageGen 调用数不超过 1。
5. 失败样本具有明确失败原因且无伪成功 PNG。

### 任务 5.3：分步启用功能开关

启用顺序：

1. `compact_plan_v1`
2. `route_aware_context_v1`
3. `targeted_preflight_v1`
4. `targeted_finalizer_v1`

每启用一项都运行全量测试和至少一个真实小任务。任何质量回退只关闭当前开关，不回退会话确认、RMBG 和原子终态合同。

## 9. 延后项：RMBG session 复用

只有阶段 5 数据证明多层任务中 RMBG 初始化时间占本地后处理的主要比例，才设计常驻 session。启动前必须先记录：

- 单次 session 创建时间。
- 单次 remove 推理时间。
- 多层任务的重复初始化占比。
- 进程空闲资源占用和异常恢复成本。

如果 RMBG 后处理已经稳定小于 30 秒，本项不实施。

## 10. 建议提交拆分

以下只是实施批次，不代表已获 Git 授权：

1. 计时与性能门禁。
2. 计划瘦身与路线元数据。
3. Targeted Preflight。
4. Targeted Finalizer 与 RMBG 测试边界。
5. 终态回流与 UI 阶段状态。
6. 三个开发门禁样本、滚动证据与功能开关默认值。

每一批在提交前都需要用户单独批准 Git 操作。

## 11. 实施停止条件

遇到以下任一情况立即停止当前阶段，不自行扩大范围：

- 需要增加新的外部图像模型或服务。
- 需要用本地算法生成修复内容或替代 RMBG alpha。
- 需要改变用户已确认的图层清单、尺寸或输出目录。
- 快速模式需要第二次 ImageGen 才能伪装成成功。
- 性能提升依赖降低输出质量或跳过强制验收。
- 发现现有未提交修改与本阶段目标重叠且无法安全隔离。
