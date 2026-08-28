# Imvia Layer 海报分层模式设计

## 背景

当前 Imvia Layer 工作台以 UI 和运营图的定向框选拆分为核心。用户先创建 `kvTitle`、`kvElement`、`ordinaryText`、`uiComponent` 或 `kvBackground` 记录，再把每条记录作为裁剪区域提交给 Codex。执行器通常直接交付透明裁剪 PNG，并允许部分路线在首个候选失败后自动重试。

海报分层需要不同的所有权模型。标题、品牌标志、日期、角标、人物、道具、装饰效果和背景往往在同一画布上互相遮挡，但必须保持独立移动、原始坐标和完整的隐藏结构。一次错误的语义 Alpha 或 ImageGen 重绘会改变字体、泄漏背景或破坏重组，而现有 UI 验收只检查尺寸、透明度和基本排除关系，无法可靠阻止这类结果进入最终输出。

`lovart-poster-layering-v3-1` 已定义适合海报的证据优先执行契约：先建立所有权图，再逐层生成一个候选；锁定可见锚点；仅在声明的修复 envelope 内补全；候选必须经过来源比较和用户接受；禁止自动重试。该版本用于验收测试且不可修改。

本设计在同一工作台中新增独立的“海报分层”管线，通过新的工作台适配技能调用 v3.1。UI 管线保持兼容，海报管线拥有独立计划、状态、候选审核和全画布输出契约。

## 目标

- 上传前显式选择“UI/运营图”或“海报分层”，并按图片文档保存模式。
- 海报先分析证据和层级计划，用户确认计划后才允许生成候选。
- 按独立移动和来源证据分离标题、品牌、日期/CTA、图标、人物、道具、效果与背景。
- 每个图层声明遮挡关系、来源证据、支持组件、修复 envelope、锁定可见锚点和风险。
- 每次只生成一个图层的一张候选，未经用户指令禁止自动重试。
- 候选保持原图尺寸与坐标；普通图层使用统一 `#00FF00`，Screen/Add 光效使用 `#000000`。
- 硬失败写入 v3.1 标准失败码，不进入正式 `layers/`。
- 用户明确接受后，才执行非生成式归一化并写入正式图层。
- 所有图层接受且重组审计通过后，才允许导出完整海报分层包。
- 复用现有上传、画布、可见 Codex 消息桥、任务取消、队列和页面生命周期能力。

## 非目标

- 不修改 `lovart-poster-layering-v3-1` 或其参考文件。
- 不把 UI 的裁剪透明 PNG 作为海报正式图层格式。
- 不在本次改动中实现 PSD、PSB、Figma 或 Lovart 私有工程文件导出。
- 不承诺自动完成所有高风险遮挡修复；硬失败必须停在审核阶段。
- 不用 ImageGen 模拟 Lovart HD。无可用 HD 控件时记录 `HD_UNAVAILABLE`。
- 不自动接受候选，不根据尺寸或提示文本代替视觉来源比较。
- 不把海报分类和状态塞进现有 UI `layer-review-plan.json`。

## 方案选择

### 采用：同一工作台中的独立海报管线

上传、项目文档、无限画布、Codex 会话桥和生命周期服务继续共用。海报使用独立模块、计划文件、服务端接口、执行提示和审核状态。模式在上传前显式选择，图片导入后不通过自动识别切换。

这能复用成熟基础设施，同时让全画布绿幕、用户接受和禁止自动重试等规则不影响 UI 拆图。

### 未采用：扩展 UI 定向计划

在 `layer-review-plan.json` 中增加海报字段看似改动较少，但两种模式在输出尺寸、背景格式、自动重试、验收阶段和用户确认上互相冲突。条件分支会进入预检、结果状态、最终处理器和前端展示的每一层，长期风险最高。

### 未采用：单独海报应用

完全独立的应用隔离最彻底，但会复制上传、项目存储、画布、会话桥、队列和任务恢复逻辑。当前需求不需要第二套壳层。

## 模式与图片文档

新增文档级 `documentMode`：

```js
"ui" | "poster"
```

上传区在没有活动图片时显示两个显式入口：“UI/运营图拆分”和“海报分层”。新图片继承用户当次选择，并将模式保存到 `imageDocument`。多图片项目允许不同图片使用不同模式，但图片导入后不能静默改模式；切换必须先确认清除该图片未完成的模式专属计划。

现有顶部“框选拆分 / 画布总览”是视图模式，与 `documentMode` 正交。海报仍可在框选视图中复核证据区域，也可在画布总览中查看完整层级堆栈。

## 海报任务包

工作台为每次海报分析创建独立任务目录，并把该目录作为 v3.1 的用户指定目标，因此不使用其默认 `outputs/poster_layers/<source-stem>/`：

```text
output/poster-jobs/<job-id>/
  source.png
  poster-layer-plan.json
  layer_manifest.json
  evidence/
  candidates/
  layers/
  poster-execution-report.json
```

- `source.png` 是解码并规范化后的原始完整画布，不改变尺寸或比例。
- `poster-layer-plan.json` 是工作台权威计划，保存用户可编辑的所有权图。
- `layer_manifest.json` 从 v3.1 模板初始化，记录每个状态变化、提示、候选、失败码和接受结果。
- `evidence/` 保存供复核的来源框和关系图，不作为生成输入之外的视觉权威。
- `candidates/` 保存每次原生 ImageGen 候选，永不覆盖。
- `layers/` 只保存用户明确接受后的规范化正式图层。
- `poster-execution-report.json` 保存分析、生成、审核和重组审计的机器状态。

v3.1 模板中的 `candidate_visibility: "hidden"` 表示候选不能被当作正式交付层或进入重组导出，并不禁止工作台在本地审核器中显示候选。适配层保留该字段和值；审核器只通过受控的任务文件接口读取候选，不把候选暴露为 `layers/` 资源。

路径必须经过与 UI 任务相同级别的 job ID、目录逃逸、文件类型和画布尺寸校验。所有 manifest 更新使用目录锁与临时文件替换，避免刷新、取消或并发点击造成部分写入。

## 权威海报计划

`poster-layer-plan.json` 顶层字段：

```js
{
  version: "1.0",
  task: "poster_layering",
  job_id,
  project_id,
  image_id,
  source: { path, width, height, aspect_ratio, target_2x },
  document_mode: "poster",
  status,
  skill_contract: {
    base: "lovart-poster-layering-v3-1",
    adapter: "imvia-poster-layering-workbench-v1",
    auto_retry: false,
    full_canvas: true
  },
  layers: [],
  output_directory
}
```

每层必须包含 v3.1 layer rules 的全部字段：

- `layer_name`, `asset_role`, `layer_type`, `z_order`, `position`
- `visible_content`, `included_content`, `excluded_content`
- `occludes`, `occluded_by`
- `source_evidence`, `support_components`, `ui_independence`
- `repair_envelope`, `locked_visible_anchors`
- `completion_required`, `completion_regions`, `risk_level`
- `processing_mode`, `fill_color`, `compositing_mode`, `separation_reason`

`layer_index: 1` 是最前景；重组从最大索引向 1 合成。一个可见像素只能有一个所有者；生成的补全像素归属于被恢复资产。

## 两阶段流程

### 阶段一：分析与计划复核

1. 用户选择海报模式并上传图片。
2. 工作台创建分析任务，通过当前 Codex 可见消息桥发送；浏览器页面不得启动隐藏后台分析。
3. Codex 使用新的工作台适配技能读取完整海报，只返回证据图、所有权图和 `poster-layer-plan.json`，不得调用 ImageGen。
4. 工作台显示前景到背景的图层列表以及每层证据、遮挡关系、支持组件、独立 UI、修复 envelope、锁定锚点和风险。
5. 用户可调整顺序、删除图层、修改字段，或在明确所有权后合并图层。
6. 合并操作必须保留所有来源证据并重新校验独立 UI；日期、CTA、Logo、价格、角标和图标组默认禁止与标题合并。
7. 用户点击“确认海报计划”后锁定当前计划版本。后续结构修改会产生新版本并使未接受候选失效。

计划状态：

```text
ANALYZING → PLAN_REVIEW → PLAN_CONFIRMED
              └────────→ ANALYSIS_FAILED
```

### 阶段二：逐层候选与接受

1. 只有已确认计划中的 `PENDING` 层可生成。
2. 每次点击“生成候选”只提交一层，并通过可见 Codex 消息执行。
3. 适配技能使用 v3.1 基础块和恰好一个类型提示块，只把原始完整海报作为视觉权威。
4. ImageGen 每次只生成一张原图尺寸、原始坐标的全画布候选。
5. 原生结果写入 `candidates/layer_<index>_<slug>_candidate-<nn>.png`，同时记录提示、生成次数、证据、envelope、锚点和尺寸。
6. 工作台展示原图、候选、透明模拟预览和叠加对齐视图。
7. 自动 release gate 先检查硬失败；硬失败只能拒绝，不能进入 `NEEDS_USER_REVIEW`。
8. 无硬失败时进入用户审核。用户可“接受候选”或“重试此层”。重试是新的显式生成授权，候选编号递增，旧候选保留。
9. 接受只执行统一缩放和固定画布 padding；禁止再次调用 ImageGen。

图层状态：

```text
PENDING → GENERATING → CANDIDATE_CREATED
                         ├→ HARD_REJECTED
                         └→ NEEDS_USER_REVIEW
                               ├→ ACCEPTED
                               └→ RETRY_AUTHORIZED → GENERATING
```

取消只终止工作台侧任务与队列占用；若 Codex 已开始生成，界面沿用现有明确提示，说明旧 Codex turn 可能继续，但迟到候选不得改变 manifest。

## 候选审核界面

结果区域在海报模式下改为候选审核器：

- 原图与候选并排，使用同一缩放和中心点。
- 叠加模式提供可调透明度，用于发现坐标、轮廓和背景几何漂移。
- 透明模拟只用于工作台预览；正式文件仍为全画布绿幕或黑底。
- 显示来源证据、锁定锚点、repair envelope 和被移除的遮挡者。
- 显示自动失败码、逐项检查和人工备注。
- 只有 `NEEDS_USER_REVIEW` 显示“接受候选”。
- `HARD_REJECTED` 显示“重新生成此层”，点击后先明确授权一次重试。
- 计划变更、来源图版本变化或候选画布不匹配时，候选标记为失效，不能接受。

画布总览以全尺寸逻辑坐标显示各层缩略图和 z-order 连接。正式层与候选层使用不同外观，避免把未接受候选误认为交付结果。

## Release gate

适配执行器必须实现 v3.1 的标准失败码，并为每项保存证据说明。自动拒绝至少覆盖：

- 未见于来源的图形效果：`UNSUPPORTED_GRAPHIC_EFFECT`
- 独立 UI 被合并：`UI_BUNDLING_ERROR`
- 锁定可见锚点改变：`VISIBLE_ANCHOR_MUTATION`
- 整体资产被重绘：`WHOLE_ASSET_REGENERATION`
- 修复超出 envelope：`REPAIR_ENVELOPE_EXCEEDED`
- 声明的补全仍缺失：`COMPLETION_MISSING`
- 人体或结构破坏：`ANATOMY_OR_STRUCTURE_BROKEN`
- 文字、字形或 Logo 改变：`TEXT_OR_LOGO_MUTATED`
- 背景结构漂移：`BACKGROUND_LAYOUT_DRIFT`
- 所有权、效果连续性、外来内容、配准、绿幕或画布失败：对应 v3.1 其他标准码。

尺寸正确、提示正确或 Alpha 存在不能替代视觉来源比较。标题候选必须检查字形结构、基线、间距、颜色和位置；此前出现的错位语义 matte 应命中 `TEXT_OR_LOGO_MUTATED`、`REGISTRATION_UNCERTAIN`、`FOREIGN_CONTENT_LEAK` 或 `KEY_UNUSABLE`，不得显示完成。

第一版自动 gate 可以把确定性检查与 Codex 视觉审查结果共同写入 manifest，但用户接受仍是正式发布的必要条件。自动 gate 不能把硬失败降级为主观审核。

## 输出与绿幕规则

- 普通 opaque 图层在资产外使用统一 `#00FF00`，不混入透明通道。
- Screen/Add 光效层使用统一 `#000000`，并记录对应合成模式。
- 正式图层始终是原图尺寸和坐标，不裁剪、不居中、不旋转、不拉伸。
- ImageGen 返回同比例不同尺寸时，候选可供审核，但正式接受阶段只能使用非生成式统一缩放和固定画布 padding 还原原图尺寸；任何配准不确定性都必须拒绝。
- 透明模拟预览可以从绿幕候选派生，但只存在于缓存或预览目录，不能写入 `layers/`。
- 正式文件命名为 `layers/layer_<index>_<slug>_source.png`。
- `HD_UNAVAILABLE` 不阻塞源尺寸图层接受和导出。

## 重组审计与导出

所有计划层进入 `ACCEPTED` 后启用“运行重组审计”。审计按最大索引到 1 合成，并检查：

- 独立 UI 仍可独立移动。
- 所有支持组件都有来源证据且归属正确。
- 补全结构连续，锁定锚点未改变。
- 背景修复穿过已移除资产且可见几何稳定。
- 重组图没有重复对象、UI 泄漏、外来内容或发明效果。

审计失败不删除已接受层，而是记录冲突图层、失败码和说明，并禁止整包导出。用户可返回相关层重新授权生成。审计通过后，工作台允许下载包含 `source.png`、两个计划/manifest 文件、`layers/` 和报告的归档包。

## 服务端与会话接口

海报管线使用独立端点和工具名称，避免 UI 客户端误调用：

- `submit_poster_layer_analysis`
- `get_poster_layer_job`
- `submit_poster_layer_candidate`
- `accept_poster_layer_candidate`
- `authorize_poster_layer_retry`
- `run_poster_recomposition_audit`
- `cancel_poster_layer_job`

分析和候选生成属于 Codex 可见消息任务；读取状态、接受、授权重试、审计和取消是工作台本地操作。所有改变 manifest 的接口要求 job ID、计划版本和候选 ID，使用乐观版本校验防止旧页面覆盖新状态。

当前 foreground dispatch 可复用传输和队列所有权，但 payload 必须携带 `task_kind: "poster_analysis" | "poster_candidate"`。生命周期阻塞规则按海报分析或单层候选任务计算；候选进入用户审核后不占用 Codex 生成队列。

## 新适配技能

新增 `imvia-poster-layering-workbench-v1`，其职责仅是把已确认工作台任务转换为 v3.1 执行步骤：

- 分析阶段生成证据图与权威计划，禁止 ImageGen。
- 候选阶段校验计划版本，只处理指定 `layer_index`。
- 读取 v3.1 的 `layer-rules.md` 和 `prompt-templates.md`，不复制后产生漂移。
- 强制一层一候选、无自动重试、完整画布、来源锚点和 green/black key。
- 视觉比较后写入 failure codes 或 `NEEDS_USER_REVIEW`，不自行接受。
- 只有本地接受接口能把候选规范化到 `layers/`。

适配技能采用独立版本，未来行为变化创建新 sibling；不得覆盖 v3.1。

## 错误处理与恢复

- 分析失败：保留源图，显示错误，允许重新分析；不创建伪造计划。
- 计划不完整：阻止确认，并定位缺失的必填字段或冲突所有权。
- 候选生成失败：记录失败，不增加已成功生成次数之外的候选；不自动重试。
- Codex 迟到结果：若任务已取消、计划版本已变化或候选授权失效，则保存为诊断但不得改变活动状态。
- 刷新或重新打开：从计划和 manifest 恢复分析、审核、接受与重组审计状态。
- 并发接受/重试：版本不匹配返回冲突，客户端刷新后再操作。
- 画布或绿幕无效：写标准硬失败码，禁止接受。
- 用户放弃运行任务：释放工作台队列并忽略迟到结果，沿用当前无法强停 Codex 的准确提示。

## 兼容与迁移

- 现有项目记录缺少 `documentMode` 时默认 `"ui"`。
- 现有 UI 任务、结果历史、下载和二次编辑协议保持不变。
- 海报文件不出现在 UI `final/`，UI 结果也不进入海报 `layers/`。
- 模式选择、计划审核和候选状态以新增模块实现；不在 `main.jsx` 中继续堆积协议纯函数。
- 首次发布使用功能开关 `poster_layering_mode`，便于开发和回归期间关闭入口。

## 模块边界

前端新增聚焦模块：

- `poster-mode.js`：模式和入口纯函数。
- `poster-plan.js`：计划字段、编辑、确认和版本校验。
- `poster-candidate-state.js`：候选、接受、重试和失效状态机。
- `poster-workbench-host.js`：海报本地与 MCP App 接口。
- `PosterPlanReview.jsx`：证据和层级计划复核。
- `PosterCandidateReview.jsx`：并排、叠加、透明模拟和失败码审核。

服务端新增聚焦模块：

- `poster-job-store.js`：任务包、manifest 锁和原子写入。
- `poster-release-gate.js`：确定性 gate 结果和标准失败码校验。
- `poster-recomposition.js`：非生成式重组审计和报告。

`main.jsx` 只负责选择模式、组合页面和连接现有项目状态，不承载海报协议细节。

## 测试策略

采用测试先行实现：

1. 文档模式：显式入口、按图片保存、旧项目默认 UI、切换确认。
2. 计划模型：全部必填字段、前后层级、单像素所有权、独立 UI 合并限制、版本锁定。
3. 状态机：分析、计划确认、一层一候选、硬拒绝、用户接受、显式重试和候选失效。
4. 无自动重试：生成失败、硬失败和刷新均不能创建第二候选。
5. 任务包：安全路径、模板初始化、文件锁、原子 manifest、迟到结果隔离。
6. 服务接口：分析、候选、接受、重试授权、审计、取消与版本冲突。
7. 输出：全画布尺寸、原始坐标、统一绿幕/黑底、无混合透明、规范化不调用 ImageGen。
8. Release gate：每个 v3.1 标准失败码至少一个测试，尤其是标题变形、UI 合并、锚点变化、背景漂移和 key 污染。
9. 重组审计：正确 z-order 通过；重复内容、缺层和泄漏阻止导出。
10. UI 回归：现有 UI 分类、框选提交、透明 PNG、结果精修、队列取消与下载全部保持原行为。
11. 浏览器人工验证：真实文字海报、人物遮挡海报、促销 UI 海报、光效层和刷新恢复。

## 验收标准

- 上传前可明确选择 UI 或海报，旧项目仍进入 UI。
- 海报分析不调用 ImageGen，用户确认前不能生成候选。
- 每层计划包含 v3.1 要求的全部证据和所有权字段。
- 独立日期、CTA、Logo、价格、角标和图标默认不与标题合并。
- 一次授权只生成一层的一张候选，系统绝不自动重试。
- 候选以原尺寸全画布绿幕或黑底保存，并保留原始坐标。
- 字形变化、背景泄漏、配准不确定或 key 污染不能显示“完成”。
- 硬失败候选不能接受；无硬失败候选仍需用户明确接受。
- 只有接受后才产生 `layers/layer_<index>_<slug>_source.png`。
- 重组审计通过前不能导出完整分层包。
- 刷新、取消和重新打开后计划、候选与接受状态可恢复。
- UI 模式所有现有测试和交互保持通过。
