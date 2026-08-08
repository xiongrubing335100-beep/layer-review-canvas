# Workbench Targeted Split Latency Design

日期：2026-08-03  
状态：用户已确认，待实施  
范围：`ui-layer-review-canvas` 的已确认拆分任务，从当前 Codex 会话确认到 PNG 回流

## 1. 背景与问题

当前工作台已经实现前台会话确认、权威 `layers[]`、定向拆分、RMBG、终态报告和结果回流，但 `targeted_repair + RMBG` 的等待时间仍然过长，且不同任务之间波动很大。

2026-08-03 的实际任务 `layer-job-2026-08-03T06-36-57-480Z` 总耗时为 631.636 秒。其中：

- 提交到 Codex turn 启动约 22.8 秒，包含消息派发和用户确认停留。
- ImageGen 局部修复约 40 秒。
- RMBG 实际推理约 3.5 秒。
- 其余约 565 秒用于计划与 skill 读取、视觉检查、临时脚本编写、尺寸处理、源像素锁定、重复验收、报告写入和跨工作区权限往返。

历史已完成 `targeted_repair` 报告的耗时范围约为 196.5 至 2617.2 秒，说明当前主要问题不是固定模型推理时间，而是自然语言驱动的手工编排缺少稳定执行边界。

本设计不更换 ImageGen，不用本地算法替代视觉修复，也不降低透明 PNG、尺寸、位置、标注和像素保真合同。优化重点是把无语义、可确定执行的工作固化为项目内流水线。

## 2. 已确认产品决策

1. `targeted_repair` 的缺失内容、文字挖空和遮挡补全仍由 ImageGen 生成。
2. `remove_background: true` 仍必须在 Codex 最终拆分结果完成后运行 RMBG `isnet-general-use`。
3. 禁止以颜色阈值、轮廓、膨胀、模糊、克隆、OpenCV 补洞或助手自制 alpha 替代 ImageGen 或 RMBG。
4. 本地代码只允许执行无语义机械步骤：读取计划、精确裁切、尺寸归一、文件组织、保护未编辑原像素、RMBG 调用、验收、计时和报告。
5. “保护未编辑原像素”不得产生修复内容；修复区域内的新增像素必须来自 ImageGen。缺少可靠修复区域时不得猜测，快速任务必须失败；只有用户明确重新提交质量模式后才能进入质量复核。
6. 快速模式最多一次 ImageGen 调用，不自动升级质量模式。
7. 高质量模式维持现有最多一次局部重试合同，不改变图层数量、尺寸或输出位置。
8. 工作台计划中的 `layers[]` 仍是唯一图层清单；不进行整页诊断，不新增推测图层。

## 3. 目标与非目标

### 3.1 目标

- 快速 `targeted_repair` 在用户完成确认后，中位机器执行时间不超过 120 秒，P90 不超过 240 秒。
- ImageGen 返回后，机械后处理、RMBG、验收和终态写入合计不超过 30 秒。
- `direct_crop` 和 `alpha_extract` 不进入通用 Codex 图像修复编排。
- 计划持久化文件不再包含原图或裁切图的 Base64 数据。
- 所有阶段时间由程序自动记录，不由执行者估算。
- PNG 与 `execution-report.json` 以一致终态回流，避免 PNG 已存在但界面仍处理中。
- 输出质量、真实 alpha、原始框选尺寸和用户标注合同不降低。

### 3.2 非目标

- 不开发本地内容生成、图像修复或文字移除算法。
- 不接入新的外部模型 API。
- 不用 WebSocket 重写整个工作台通信架构。
- 不重新设计工作台 UI。
- 不改变当前前台 Codex 会话确认要求。
- 第一阶段不建设长期驻留的通用图像服务。

## 4. 方案选择

### 4.1 采用方案：固定前后处理执行器

保留 ImageGen 和 RMBG，把计划校验、文件准备、尺寸归一、RMBG、验收与报告固化为项目内执行器。Codex 只保留视觉语义决策和一次 ImageGen 调用。

选择原因：

- 不改变当前可接受的修复质量来源。
- 直接消除大量重复工具调用和临时脚本。
- 能用固定输入输出接口进行单元测试和性能基准。
- 失败边界清晰，可逐阶段启用和回滚。

### 4.2 未采用：仅精简提示词

只缩小 prompt 和附件可以降低少量上下文处理时间，但 Codex 仍需手工完成后处理和验收，无法解决 3 至 40 分钟的波动。

### 4.3 延后：常驻 RMBG 服务

单项 RMBG 约 3.5 秒，不是当前主瓶颈。只有批量测试证明模型重复加载占比显著时，才引入常驻 session，避免过早增加进程生命周期复杂度。

## 5. 总体架构

执行链路调整为：

1. 工作台生成结构化计划并立即建立本地 pending 状态。
2. Vite 接收上传数据，将原图和裁切图写为独立文件，持久化计划前删除 Base64。
3. 当前任务 MCP App 展示确认卡片，并通过前台消息发送到同一 Codex 任务。
4. Codex 调用确认工具。
5. Codex 运行预检执行器，获得简短、确定的单层执行规格。
6. Codex 依据规格调用一次 ImageGen。
7. Codex 将 ImageGen 输出路径交给后处理执行器。
8. 后处理执行器完成尺寸归一、合同允许的源像素保护、RMBG、验收和原子写入。
9. 工作台轮询读取同一份终态报告并展示最终 PNG。

本设计将职责分为五个边界明确的单元：

- Submission Normalizer：上传数据落盘并生成轻量计划。
- Dispatch Bridge：只负责前台确认和消息送达。
- Targeted Preflight：只负责权威计划校验与执行规格生成。
- Codex Visual Repair：只负责 ImageGen 视觉编辑。
- Targeted Finalizer：只负责机械后处理、RMBG、验收和终态报告。

## 6. 计划与文件合同

### 6.1 持久化计划瘦身

服务端成功写出 `source.png` 和每层裁切图后，必须删除：

- `source.embedded_data_url`
- `layers[].review_snapshot.embedded_crop_data_url`

计划保留：

- `source.local_path`
- `layers[].review_snapshot.local_crop_path`
- `source_region_pixels`
- `mask_annotations`
- `remove_background`
- `execution_mode`
- `execution_route_hint`
- `execution_policy`
- `output_directory`

持久化计划不得超过 100 KB；超过时提交失败并记录具体超限字段。

### 6.2 新增执行字段

每层增加：

- `repair_engine`: `imagegen` 或 `none`
- `requires_global_context`: 布尔值
- `maximum_imagegen_calls`: 快速模式首候选通过即结束，失败时最多再调用 1 次，因此上限为 2
- `rmbg_required`: 与 `remove_background` 一致
- `expected_output`: 宽、高和原始 x/y
- `repair_regions`: 可选的裁切坐标区域
- `repair_region_source`: `submitted_annotation` 或 `codex_declared`

`requires_global_context` 的确定规则：

- 单纯去文字、数字、水印或可替换内容：`false`
- 遮挡补全、背景底板修复或需要判断图层所有权：`true`
- `kvBackground`：`true`
- `quality`：默认 `true`

`repair_regions` 只允许来自两种来源：用户在工作台提交的明确标注，或 Codex 查看框选预览后在 ImageGen 调用前显式声明的裁切坐标区域。本地执行器不得通过颜色阈值、OCR、边缘检测或其他启发式方法自动猜测修复区域。没有明确修复区域时，后处理不得执行源像素锁定，只能对完整 ImageGen 候选做严格结构验收；无法通过时快速任务失败。

## 7. Targeted Preflight

新增预检命令，输入为 `jobId`，输出为机器可读执行规格。

职责：

1. 解析轻量计划。
2. 验证 jobId 与目录一致。
3. 验证输出目录位于当前 job 下。
4. 验证 `layers[]` 数量和顺序。
5. 验证源图、裁切图和尺寸存在且一致。
6. 验证 final 目录没有非本任务结果。
7. 规范化单层简短需求，但不改变显式用户指令。
8. 输出 ImageGen 目标、上下文附件、期望尺寸、输出路径和允许调用次数。
9. 自动记录预检开始与结束时间。

预检不修改像素，不调用 ImageGen，不调用 RMBG，不写 completed 状态。

预检失败必须写入单一 `failed` 终态，禁止继续生成。

## 8. Codex ImageGen 阶段

Codex 从预检输出构造固定提示词，字段仅包括：

- 编辑目标。
- 必须删除或补全的内容。
- 必须保持不变的结构。
- 禁止新增的内容。
- 画布、比例和定位合同。

附件策略：

- `direct_crop`：不调用 ImageGen。
- `alpha_extract`：不调用 ImageGen，仅使用精确裁切。
- 简单去字 `targeted_repair`：只附带裁切图。
- 需要全局上下文的 `targeted_repair`：附带原图和裁切图。

快速模式只允许一次 ImageGen 调用。生成结果写到 job 根目录下的 `generated/`，不得直接写入 `final/`。

## 9. Targeted Finalizer

后处理执行器输入：jobId、layerId 和 ImageGen 输出路径。

执行步骤：

1. 重新读取权威计划并确认执行层。
2. 验证 ImageGen 文件存在、可解码且未写入 final。
3. 将候选结果归一到计划要求的精确画布尺寸。
4. 检查主体相对位置、整体比例和结构完整性。
5. 仅当 `repair_regions` 和 `repair_region_source` 合法时，保护修复区域外的原始像素；不得推断区域或生成修复像素。
6. 生成唯一 RMBG 输入图。
7. 对 `remove_background: true` 调用现有 `finalize-rmbg.py`。
8. 对不去背景图层生成合同要求的 RGBA 或 RGB 输出。
9. 一次运行全部强制验收。
10. 使用临时文件和原子重命名写入 final PNG。
11. 最后原子写入唯一 terminal `execution-report.json`。

如果没有可靠修复区域，或候选发生明显结构漂移，快速模式必须失败；不得通过本地内容修复掩盖问题。

## 10. RMBG 合同

- 模型固定为 `isnet-general-use`。
- 输入必须已经是尺寸正确的 Codex 最终拆分结果。
- RMBG 输出必须为真实 RGBA。
- `alpha_min` 必须为 0，`alpha_max` 必须大于 0。
- 只有 RMBG 成功后才能把 PNG 原子写入 final。
- RMBG 失败不得回退到色差、轮廓或自制 alpha。

第一阶段继续使用现有脚本。预热或 session 复用只能作为独立后续优化，并必须保留相同输出验证。

## 11. 验收与终态

每层强制验证：

1. final 中恰好一个预期 PNG。
2. PNG 尺寸等于提交时框选尺寸。
3. PNG 路径位于权威输出目录。
4. 主体没有裁切坐标漂移。
5. keep、exclude 和 brush 标注符合优先级规则。
6. 邻近组件和明显排除内容不存在。
7. 去背景结果具有真实透明 alpha。
8. 没有棋盘格、白底、绿幕、黑底板或无关残留。
9. `targeted_repair` 的目标文字或内容已经移除。
10. 组件边框、圆角、渐变、阴影和光效仍完整。

终态规则：

- 全部通过：一次写入 `status: completed`。
- 任一失败：不得保留可误认为成功的 final PNG，写入 `status: failed` 和单一明确错误。
- 不允许只有 PNG 没有终态报告。
- 不允许报告 completed 但 PNG 缺失。

## 12. 计时设计

计时由程序自动记录：

- `submitted_at`
- `confirmation_presented_at`
- `confirmation_accepted_at`
- `codex_turn_started_at`
- `preflight_started_at`
- `preflight_completed_at`
- `imagegen_requested_at`
- `imagegen_completed_at`
- `postprocess_started_at`
- `rmbg_started_at`
- `rmbg_completed_at`
- `validation_started_at`
- `completed_at`

报告派生：

- `user_confirmation_dwell_ms`
- `dispatch_ms`
- `preflight_ms`
- `imagegen_ms`
- `postprocess_ms`
- `rmbg_ms`
- `validation_ms`
- `total_machine_ms`
- `total_user_visible_ms`

性能门禁使用 `confirmation_accepted_at` 到 `completed_at`，不把用户阅读确认卡的时间归因于执行器。

## 13. 状态回流

保持现有轮询架构，第一阶段不引入 WebSocket。

- 报告和 PNG 均完成后才返回 completed。
- 轮询看到 terminal 状态后立即停止。
- `completed_at` 使用执行报告时间，不继续累计。
- PNG 已生成但报告未完成时显示“正在验收”，不能显示完成。
- 报告失败时显示可重试错误，不停留在处理中。

将轮询间隔从 2 至 3 秒调整到 1 秒属于低风险尾延迟优化，但不得代替核心执行器改造。

## 14. 性能基准

固定五类场景：

1. 纯裁切组件。
2. 单一图标 RMBG。
3. 平滑渐变按钮去字。
4. 复杂纹理底板去字或遮挡补全。
5. 框内多个独立组件的歧义任务。

每类在同一设备、同一输入和同一模式下运行三次。基线和改造后均保存：

- 计划摘要。
- 完整计时。
- final PNG。
- 自动验收结果。
- 人工盲看结果。

性能通过标准：

- 快速 targeted repair 的机器时间 P50 不超过 120 秒。
- P90 不超过 240 秒。
- ImageGen 完成后的本地处理不超过 30 秒。
- 所有 completed 输出通过尺寸、alpha、标注和明显排除检查。
- 人工盲看结果不低于现有基线。
- 失败任务必须明确失败，不得通过本地修复算法制造伪成功。

## 15. 分阶段交付

### 阶段 0：可信基线

完善自动计时，运行 15 个固定样本。此阶段不得修改视觉算法。

### 阶段 1：计划瘦身与附件策略

删除持久化 Base64，增加 `requires_global_context`，只发送当前路线必需图片。

### 阶段 2：Targeted Preflight

固化计划加载、路径检查、尺寸检查、需求规范化和执行规格输出。

### 阶段 3：Targeted Finalizer

固化尺寸归一、合同允许的源像素保护、RMBG、验收和原子报告。

### 阶段 4：工作台终态与基准门禁

确保 PNG 与报告一致回流，执行改造后 15 个样本并检查 P50、P90 和质量。

### 阶段 5：可选 RMBG session 复用

只有基准证明多层任务的 RMBG 初始化占比显著时才实施。

## 16. 风险与缓解

### ImageGen 改变整个组件

缓解：固定编辑提示词、只提供必要裁切、验证主体几何和结构；快速模式失败时不使用本地算法补救。

### 尺寸归一造成拉伸

缓解：只允许保持比例的裁切或补边策略；禁止非等比缩放。若 ImageGen 结果比例无法安全归一，任务失败。

### 源像素保护掩盖错误

缓解：保护范围必须来自权威标注或可靠执行规格；不得由颜色阈值自动猜测修复范围。

### RMBG 保留邻近对象

缓解：验收可见 alpha 边界和明显排除区域；失败即失败，不修改 RMBG alpha。

### 报告先于文件落盘

缓解：先写临时 PNG，验证后原子重命名，最后原子写 terminal 报告。

### 性能数据被用户确认时间污染

缓解：分别记录确认停留和机器执行时间，性能门禁只使用机器时间。

## 17. 预期文件影响

- `src/split-execution.js`：扩展路线元数据与全局上下文判断。
- `src/main.jsx`：提交轻量计划、展示新阶段计时和终态。
- `vite.config.js`：落盘后删除 Base64、合并执行器计时、保持原子终态。
- `codex-thread-bridge.mjs`：按 `requires_global_context` 选择附件并缩短提示词。
- `scripts/prepare-targeted-job.mjs`：新增预检执行器。
- `scripts/finalize-targeted-job.py`：新增机械后处理、RMBG 编排、验收和报告执行器。
- `scripts/finalize-rmbg.py`：第一阶段保持算法不变，仅开放可测试调用边界。
- `scripts/report-split-performance.mjs`：增加阶段统计、P50、P90 和机器时间门禁。
- `split-ui-design-layers-workbench-targeted/SKILL.md`：从临时手工步骤改为调用固定执行器，同时保留全部质量合同。
- 对应 `src/*.test.mjs`：增加计划瘦身、附件策略、预检、后处理、终态和性能门禁测试。

## 18. 回滚策略

每个阶段使用独立功能开关：

- `compact_plan_v1`
- `route_aware_context_v1`
- `targeted_preflight_v1`
- `targeted_finalizer_v1`

发现质量回退时可关闭当前阶段，继续使用现有 skill 执行，不需要回退已完成的任务记录。旧计划继续可读，新执行器必须兼容缺失新增字段的计划，并使用保守默认值。

回滚不得恢复后台直达、跨会话发送、假完成状态或非 RMBG alpha。

## 19. 最终验收结论

只有同时满足以下条件，改造才可进入默认路径：

- 固定 15 个样本通过性能门禁。
- 所有 completed PNG 通过硬性输出合同。
- 人工盲看确认修复质量不下降。
- 失败任务不会产生伪成功结果。
- 当前会话确认、监听和回流链路没有回退。
- 不包含本地语义修复或 RMBG 替代实现。

在此之前，新执行器仅作为可关闭的试验路径存在。
