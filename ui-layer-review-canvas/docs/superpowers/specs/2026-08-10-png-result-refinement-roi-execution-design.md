# PNG 二次编辑局部 ROI 执行规范

## 1. 目标

本规范定义 Imvia Layer 工作台 `result_refinement` 路线的新执行合同。它解决以下问题：

- 固定 ImageGen 画布中发生整图重新构图、横向压缩或对象比例漂移。
- 用户提示词同时承担对象定位、路径语义和视觉要求，导致表达困难或执行歧义。
- `boundary` 路径与“路径外删除”被混为同一种操作。
- ImageGen 返回 RGB 或画进像素的棋盘格时，透明 PNG 二次编辑无法可靠完成。

核心原则：

> 当前成功 PNG 是唯一权威基准；结构化操作决定范围和 Alpha，ImageGen 只负责闭合修复路径内的局部 RGB 生成。

## 2. 非目标

- 不改变普通首次拆图、`direct_crop`、`alpha_extract`、`codex_rgba` 或 BRIA RMBG 路线。
- 不允许 PNG 二次编辑调用 RMBG。
- 不让 ImageGen 决定画布尺寸、路径范围、路径外删除或最终透明通道。
- 不以提示词代替结构化路径语义。
- 不自动把未闭合草稿修正或猜测为闭合路径。

## 3. 权威输入与尺寸合同

### 3.1 基准 PNG

- `baseResult` 的当前成功 PNG 是唯一权威图像输入。
- 原始设计图、旧成功版本、逻辑框选预览和无限画布截图不得作为视觉输入混入本次任务。
- 基准 PNG 解码后的实际像素宽高是输出尺寸的唯一权威值。
- 无限画布位置和显示宽高只能写入 `logical_placement`，不得参与图像缩放。

### 3.2 标准画布

- 基准 PNG 或局部 ROI 必须按 1:1 像素比例放入标准画布。
- 禁止非等比缩放，禁止先横向或纵向适配后再裁回。
- `content_region.width` 和 `content_region.height` 必须等于实际放入内容的像素宽高。
- 标准画布空白区域只用于满足 ImageGen 输入规格，不属于可编辑内容。
- 若完整基准 PNG 无法以 1:1 放入受支持的标准画布，必须改用局部 ROI 或确定性分块；不得缩小整张 PNG。
- 最终合成只使用 mapping 声明的 `content_region`，并按原像素坐标回写。

对于 1024×1243 的基准 PNG 和 1024×1536 的标准画布，必须保持内容为 1024×1243，允许仅在垂直方向增加透明留白；不得改变内容宽度、宽高比或对象位置。

## 4. 结构化编辑操作

二次编辑任务通过 `refinement_operation` 保存显式操作模式；可信预检再从路径类型和
`refinement_operation.subject_path_ids` 派生下列路径集合。自然语言不得覆盖这些字段。

### 4.1 `repair_path_ids`

- 使用 `boundary` 闭合路径定义允许生成式修改的区域。
- 路径外所有 RGBA 像素逐字节等于基准 PNG。
- 每条独立路径形成一个独立修复 ROI。
- 不得把多条相距较远的路径合并为覆盖整图的大 ROI。

### 4.2 `erase_path_ids`

- 使用 `exclude`、`erase`、`background` 或 `force_exclude` 路径。
- 路径内部 Alpha 确定性设置为零。
- 单纯擦除不调用 ImageGen。
- 若同时要求补背景，补背景范围必须另有 `boundary` 修复路径。

### 4.3 `protect_path_ids`

- 使用 `keep`、`foreground` 或 `force_keep` 路径。
- 路径内部最终 RGBA 直接采用基准 PNG，不允许生成结果覆盖；保护路径拥有最高合成优先级。
- 适用于人物脸部、Logo、文字和其他必须保持不变的内容。

### 4.4 `refinement_operation.mode: keep_inside_delete_outside`

- 这是显式画布级操作，不得由 `boundary` 或自然语言隐式推断。
- `refinement_operation.subject_path_ids` 指定的主体闭合路径内部保留，路径外 Alpha 确定性设置为零。
- 主体内部需要补全时，必须另外提交修复路径。
- 未选择该操作时，所有修复路径外像素保持基准 PNG，不得删除。

### 4.5 `refinement_operation.mode: full_canvas_explicit`

- 只有用户明确选择“整图编辑”时才能启用。
- 工作台必须展示比例漂移和重新构图风险，并要求二次确认。
- 普通文字输入不得自动升级为整图编辑。

## 5. 路径验证与 ROI 生成

### 5.1 路径验证

每条路径必须：

- 为闭合贝塞尔路径。
- 至少包含三个不同锚点。
- 坐标有限且位于基准 PNG 范围内。
- 采样后的多边形有效、面积大于零且不自相交。
- 保留原始锚点和扁平化多边形，供重现与最终合成使用。

### 5.2 ROI 规则

- 每条 `boundary` 路径分别计算最小包围盒。
- 按目标尺寸增加 3%–15% 的上下文留白，留白仍不得超出 PNG 边界。
- ROI mapping 记录 `base_x`、`base_y`、`width`、`height`、路径 ID 和标准画布内的 `content_region`。
- `roi_policy.scale_mode` 必须为 `native_1_to_1`；留白、覆盖阈值、分块重叠和其他 ROI 参数都以受信任的 `roi_policy` 为准。
- 多条重叠或相邻路径仅在合并后不会把无关对象纳入可编辑范围时才能合并。
- ImageGen 候选只能回写到对应路径遮罩内部，ROI 留白只提供上下文，不自动获得修改权限。

### 5.3 大范围保护

- 单条局部修复路径覆盖基准 PNG 超过 40% 时返回可见警告。
- 覆盖超过 70% 时预检失败，除非任务显式使用 `full_canvas_explicit`。
- 多条路径的并集达到相同阈值时采用相同规则。

## 6. 提示词编译合同

用户文字不是直接发送给 ImageGen 的完整提示词。工作台必须把结构化操作、路径和用户文字编译成规范化指令。

规范化指令包含：

1. 权威对象：当前路径 ID 与局部 ROI。
2. 允许动作：修复、补全、替换局部材质或其他已批准动作。
3. 用户目标：用户输入的简短自然语言要求。
4. 保持项：位置、尺寸、角度、透视、材质、光影和指定受保护对象。
5. 禁止项：移动、缩放、重新构图、新增无关对象、修改路径外内容、生成背景板或棋盘格。
6. 输出合同：保持标准画布与 `content_region` 不变。

规范化模板：

```text
只处理路径 {path_id} 对应的 content_region 内部，并仅在闭合路径遮罩内修改像素。
用户目标：{normalized_user_requirement}
保持目标原有位置、大小、角度、透视、材质与光影。
不得移动、缩放、重新构图或重绘其他对象；不得修改路径外内容。
保持整张标准画布和 content_region 的尺寸、位置及宽高比不变。
不要绘制棋盘格、白底、黑底或任何代表透明度的可见背景。
```

如果用户文字包含“框外删除”“透明”“保留框内”等范围或 Alpha 指令，编译器必须检查是否存在对应结构化操作：

- 有对应操作：从自然语言中剥离重复表达，使用结构化语义执行。
- 无对应操作：阻止发送并提示用户选择排除路径或“仅保留路径内”，不得让 ImageGen猜测。

## 7. 生成与合成流程

### 7.1 准备

1. 读取当前成功基准 PNG，保留原始 RGBA。
2. 校验实际尺寸、父版本和所有路径。
3. 先解析确定性的保留、排除和仅保留路径内操作。
4. 为每条修复路径建立独立 ROI mapping 和 1:1 标准参考画布。
5. 在调用 ImageGen 前完成所有可读检查和规范化提示词。

准备脚本输出 version 2 manifest，且 `generated_input_kind` 必须为
`result_refinement_roi_manifest`。执行器逐个读取 `roi_jobs[]`，每个 job 只使用自己的
`reference_path`、`content_region` 和原生 1:1 mapping。

### 7.2 ImageGen

- 每次生成只处理一个独立 ROI 或一组明确相邻的路径。
- 快速模式先接受第一个通过验收的候选；失败时最多一次定向重试。
- 候选标准画布尺寸或 `content_region` 发生变化时直接失败，禁止强制缩放。
- 候选出现明显重新构图、对象位移、横向压缩、纵向拉伸或新增无关对象时失败。

### 7.3 RGB 与 Alpha 权限

- ImageGen 只拥有修复路径内部的 RGB 修改权限。
- 候选为 RGB PNG 时，可以使用其路径内 RGB，不得因为缺少候选 Alpha 而把棋盘格当作透明度。
- 默认 Alpha 来自基准 PNG。
- Alpha 只能由 `erase_path_ids`、`protect_path_ids`、`refinement_operation.mode: keep_inside_delete_outside` 或其他明确结构化 Alpha 操作改变。
- 如果补全对象需要扩展到原透明区域，路径 ID 必须列入 `refinement_operation.alpha_include_path_ids`；提示词本身不能授予 Alpha 修改权限。
- PNG 二次编辑不得调用 RMBG。

### 7.4 最终合成

合成顺序必须确定：

1. 复制基准 PNG 作为输出底图。
2. 在每个修复闭合路径内部合成已通过验收的候选 RGB。
3. 应用排除和“仅保留路径内”等显式 Alpha 操作；同类重叠操作按任务中记录的顺序执行，后置操作覆盖前置操作。
4. 最后恢复所有保护路径内的基准 RGBA；保护路径始终拥有最高优先级。
5. 校验路径外像素与基准 PNG 逐字节一致。
6. 以基准 PNG 的实际像素宽高写入新的版本化 RGBA PNG。

## 8. 验收与失败条件

### 8.1 必须通过

- 最终格式为 PNG、模式为 RGBA。
- 最终尺寸与基准 PNG 完全一致。
- 宽高比不变。
- 未标注区域 RGBA 与基准 PNG 逐字节一致。
- 每条修复路径内的结果满足用户目标并保持对象结构完整。
- 排除路径、保护路径和仅保留路径内操作的 Alpha 与结构化语义一致。
- 没有可见棋盘格、背景板或透明占位图案。
- 没有整体位移、非等比缩放、重新构图或无关对象变化。

### 8.2 必须失败

- 标准画布尺寸或 `content_region` 变化。
- 任意非等比缩放。
- 局部任务返回了整图重新构图结果。
- 路径外像素发生变化。
- 用户要求范围或 Alpha 操作但没有对应结构化路径或开关。
- 候选把棋盘格画进 RGB。
- 输出尺寸、格式、Alpha 或父版本校验失败。
- 第二次定向候选仍未通过验收。

失败和取消不得替换当前 `baseResult`，不得删除父版本，也不得留下半完成的 final PNG。

## 9. 工作台交互调整

PNG 二次编辑区需要：

- 将文字输入命名为“修改目标”，并说明无需填写尺寸、坐标和透明技术要求。
- 保留三种钢笔的明确说明。
- 增加显式“仅保留路径内，路径外透明”操作。
- 增加显式“整图编辑”高风险开关，默认关闭。
- 路径超过 40% 显示范围警告，超过 70% 默认阻止提交。
- 提交前显示结构化摘要：修复路径数量、删除路径数量、保护路径数量、是否删除路径外内容、是否整图编辑。
- 自动展示系统规范化后的简短执行摘要，让用户确认系统理解，而不是要求用户编写技术提示词。

## 10. 任务字段

### Persisted plan fields

`result_refinement` 持久化计划使用现有字段：

- `version: 0.8`
- `task: refine_split_result`
- `parent_job_id`
- `parent_version_id`
- `source.local_path`
- `source.canvas`
- `layers[].placement`
- `layers[].refinement_operation`
- `layers[].refinement_operation.subject_path_ids`
- `layers[].refinement_operation.alpha_include_path_ids`
- `layers[].normalized_user_requirement`
- `layers[].mask_annotations`
- `layers[].roi_policy`
- `layers[].transparency_strategy: preserve_existing_alpha`
- `layers[].output_resolution_policy: existing_result_pixels`
- `layers[].rmbg_required: false`
- `layers[].maximum_imagegen_calls`

### Trusted preflight derived fields

`targeted-preflight` 只把持久化计划当作输入，并从结构化操作、路径标注和真实 PNG 像素尺寸
独立校验、派生 `preflight.json` 字段：

- `layers[].repair_path_ids`
- `layers[].erase_path_ids`
- `layers[].protect_path_ids`
- `layers[].subject_path_ids`
- `layers[].alpha_include_path_ids`
- `layers[].repair_coverage_ratio`
- `layers[].expected_roi_tile_count`
- `layers[].refinement_warnings`

这些字段是可信预检输出，不由 `buildResultRefinementPlan` 序列化为持久化计划权限；即使输入中
出现同名值，预检也必须从 `layers[].refinement_operation` 和 `layers[].mask_annotations` 重新派生。

准备阶段另行输出 `generated_input_kind: result_refinement_roi_manifest` 的 version 2 manifest，
其中 `roi_jobs[]` 是候选绑定的唯一清单。不得把提示词中的范围描述当成结构化操作。

### Final execution report fields

最终 `execution-report.json` 使用报告字段：

- `asset_dimensions`
- `logical_placement`

这两个字段只描述最终输出资产和逻辑定位，不是持久化计划字段。资产来源与基准版本分别由
`source.local_path` 和 `parent_version_id` 表达；画布与图层定位分别由 `source.canvas` 和
`layers[].placement` 表达。

## 11. 测试要求

### 11.1 单元测试

- 三种路径语义与“仅保留路径内”操作。
- 路径面积阈值与整图编辑确认。
- ROI 包围盒、留白、1:1 mapping 和边界裁切。
- 提示词编译与范围指令冲突检测。
- RGB 候选复用基准 Alpha。
- 显式 Alpha 操作顺序与保护路径最终恢复。

### 11.2 集成测试

- 1024×1243 基准 PNG 放入 1024×1536 标准画布时内容保持 1024×1243。
- 两个相距较远的金币生成两个独立 ROI，不形成整图 ROI。
- 路径外 RGBA 逐字节锁定。
- RGB 候选只能修改修复路径内 RGB，不能改变其他 Alpha。
- “框外删除”缺少显式操作时预检失败。
- ImageGen 返回可见棋盘格时失败。
- 失败任务继续展示原成功 PNG。

### 11.3 浏览器验收

- 用户只写“补全这两个金币”并分别画两条路径时，提交摘要能准确表达两个局部修复目标。
- 未开启“仅保留路径内”时，路径外内容保持不变。
- 开启后路径外透明，且最终尺寸与位置不变。
- 局部修复不引起轮盘、人物或整体构图的移动、拉伸与压缩。
- 排队、失败、重试和成功切换期间基准 PNG 始终可见。

## 12. 验收标准

- 用户不需要编写尺寸、坐标、Alpha、RGBA、RMBG 或标准画布相关提示词。
- 局部修复默认必须有闭合路径；仅文字不得隐式触发整图编辑。
- “边界钢笔”不再被解释为路径外删除。
- “仅保留路径内”由独立显式操作控制。
- 原 PNG 或 ROI 在标准画布中保持 1:1，不发生非等比缩放。
- ImageGen 不再拥有整张 PNG 的修改权限。
- 未标注像素与基准 PNG 逐字节一致。
- 最终 PNG 始终保持基准 PNG 的实际像素尺寸和版本链。
