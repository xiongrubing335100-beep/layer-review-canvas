---
name: imvia-poster-layering-workbench-targeted-v1
description: 依据已确认的 targeted_fast 快照，为一个海报图层类别生成一次待审核候选。
---

# Imvia 海报快速定向分层适配器 v1

这是不可变 `lovart-poster-layering-v3-1` 的同级适配器；它不复制、修改或替代基础技能。

## 必须读取的权威

开始任何视觉操作前，完整读取：

1. `../lovart-poster-layering-v3-1/SKILL.md`
2. `../lovart-poster-layering-v3-1/references/layer-rules.md`
3. `../lovart-poster-layering-v3-1/references/prompt-templates.md`
4. `references/category-blocks.md`

将 `RUNTIME_DIR` 解析为本技能目录同级相对的 `../../runtime`。先调用工作台工具 `confirm_poster_foreground_dispatch`，参数只取可见 dispatch envelope 中的 `jobId`、`dispatchId` 和 `rootKind: poster`。工作台在派发前已经完成 generation authorization；不得再次运行 `prepare-poster-job.mjs` 或任何会改变授权、候选序号与 manifest revision 的预检。只读核验权威计划和可见 dispatch envelope 的每一个字段，不能猜测路径、版本、候选序号或授权。

## 定向候选任务

本适配器只接受 `task_kind: poster_candidate`、`planning_mode: targeted_fast` 的任务。预检后，拒绝缺失、过期或外来快照：`snapshot_id`、`job_id`、`plan_version`、`layer_index`、确认标记、来源指纹和 envelope 必须与权威计划中的 `confirmed_snapshot` 一致。缺任一项，以机器失败码 `TARGETED_SNAPSHOT_INVALID` 终止并按 envelope 失败 finalization。

完整来源画布是唯一视觉权威，必须以原始完整画布和原坐标工作。只处理 envelope 指定的 `layer_index`，并仅选择与该层 `processing_category` 匹配的**恰好一个类别**块。严禁整张海报全局分析、建立新所有权图、分析其他图层，或使用多个类别块。

使用 v3.1 基础块加该单一类别块，只调用一次 ImageGen。提示词负责约束目标内容、原坐标、类别键色和安全边距；快速路径不增加第二次生成。

### 勾选“去背景”时的 RMBG 2.0 路径

当已确认快照中的 `layer.remove_background` 为 `true` 时，ImageGen 返回第一张可用 PNG 后必须立即进入 BRIA RMBG 2.0，不得停下来做 Codex 审图。不得要求 ImageGen 自身提供精确绿底，也不得仅因 ImageGen 的原生尺寸小于来源画布、按相同比例整体放大，或原始绿色不精确而硬拒绝。

任何类别都必须让目标内容完整落在已确认框选内，并在生成画布四边保留至少 6% 安全边距。文字、引号、描边、阴影与装饰不得触碰或越过画布边缘；不得用裁切隐藏不完整内容。若目标在来源框选内靠近边缘，应缩小生成主体而不是截断主体。

按以下固定链路处理，且这不增加 ImageGen 调用次数：

1. 取得 ImageGen 返回的第一张可用 PNG 路径；不要缩放、目检或生成第二个候选。
2. 立即运行一站式入口：

   ```text
   node ${RUNTIME_DIR}/scripts/finalize-poster-fast-rmbg-candidate.mjs
     --job-directory <output_directory>
     --job-id <job_id>
     --layer-index <layer_index>
     --raw-input <ImageGen 第一张 PNG>
     --dispatch-id <dispatch_id>
   ```

3. 该入口自动把原始 PNG 保存在 `evidence/`，读取原生尺寸，调用 `${RUNTIME_DIR}/scripts/finalize-rmbg.py` 的 BRIA RMBG 2.0，再调用 `${RUNTIME_DIR}/scripts/prepare-poster-rmbg-candidate.py` 等比映射回完整来源画布；它同时生成全画布透明 PNG 与类别键色候选，并以 `--transparent-preview` 交给原子 finalization。普通层使用 `#00FF00`，Screen/Add 光效使用 `#000000`。
4. 入口只做文件可用性、PNG、alpha、完整画布、键色以及 dispatch/授权一致性等机械检查，自动写入最小机器报告。不得执行任何来源图视觉比对、字形对比、锚点对比、框选相似度判断、放大判断或艺术质量判断。
5. 成功结果固定进入 NEEDS_USER_REVIEW，并把透明 PNG 立即回传工作台；由用户在工作台比较、接受或重试。Codex 不得在回传前追加 release gate 审图。

当 `layer.remove_background` 不为 `true` 时，不调用 RMBG，继续直接生成 v3.1 键色候选并 finalization。

若 ImageGen 没有返回可用 PNG，立刻以原 `dispatch_id` 调用 `${RUNTIME_DIR}/scripts/finalize-poster-generation-failure.mjs`，使用生命周期失败码 `IMAGEGEN_NO_PNG`。若一站式入口因 RMBG、透明 alpha、PNG、完整画布、键色、快照、授权或 finalization 失败而退出，则以同一 `dispatch_id` 使用生命周期失败码 `GENERATION_FAILED` 完成失败 finalization。两种失败都必须结束当前 dispatch，禁止重试；不得用视觉或艺术判断补充失败码。

完成 finalization 后立即停止。禁止接受候选、写入 `layers/`、自动重试、重新分析、规范化、发布、重组或导出。
