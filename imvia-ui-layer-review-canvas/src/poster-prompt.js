function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

const TARGETED_PROCESSING_CATEGORIES = new Set([
  'subject', 'text', 'brand_ui', 'decoration_prop', 'effect', 'background',
]);

function processingCategory(value) {
  if (!TARGETED_PROCESSING_CATEGORIES.has(value)) throw new TypeError('processingCategory is invalid');
  return value;
}

export function buildPosterAnalysisPrompt({ jobId, planPath, sourcePath } = {}) {
  return [
    `海报工作台分析任务：${requiredString(jobId, 'jobId')}。`,
    `只信任完整来源图：${requiredString(sourcePath, 'sourcePath')}。`,
    `只可写入待校验分析计划：${requiredString(planPath, 'planPath')}；不得覆盖根目录权威 poster-layer-plan.json。`,
    '先读取工作台适配技能和 lovart-poster-layering-v3-1 的 layer-rules.md、prompt-templates.md。',
    '先检查完整画布、建立证据图与前景到背景的所有权图；每层必须保留 v3.1 所有证据、遮挡、repair envelope 与 locked anchors 字段。',
    '本阶段只写 evidence/ 中的待校验计划与证据；由 finalize-poster-analysis 原子更新权威计划和终端 PLAN_REVIEW。禁止调用 ImageGen；不得创建 candidates/ 或 layers/。',
  ].join('\n');
}

export function buildPosterCandidatePrompt({ jobId, planPath, layerIndex, candidateNumber } = {}) {
  const index = positiveInteger(layerIndex, 'layerIndex');
  const number = positiveInteger(candidateNumber, 'candidateNumber');
  return [
    `海报工作台候选任务：${requiredString(jobId, 'jobId')}。`,
    `先读取并验证 ${requiredString(planPath, 'planPath')} 的 PLAN_CONFIRMED 状态和当前 plan_version。`,
    `只处理 layer_index=${index} 的第 ${number} 个候选；不得读取或处理其他图层。`,
    '严格遵循 lovart-poster-layering-v3-1：原图是唯一视觉权威，输出保持完整原画布和原坐标；普通层 #00FF00，Screen/Add 光效 #000000。',
    '只允许一次 ImageGen 调用，使用 v3.1 基础块加恰好一个类型提示块。保存原始候选并与来源图视觉比较，记录标准 failure codes 或 NEEDS_USER_REVIEW。若 ImageGen 没有返回可用 PNG 或审核报告，必须以当前 dispatch_id 调用 finalize-poster-generation-failure，禁止留下已发送任务。',
    '不得接受候选，不得写入 layers/，不得自动重试；候选只可由本地审核接口随后接受。',
  ].join('\n');
}

export function buildPosterTargetedCandidatePrompt({
  jobId, planPath, snapshotPath, sourcePath, layerIndex, candidateNumber, processingCategory: category,
} = {}) {
  const index = positiveInteger(layerIndex, 'layerIndex');
  const number = positiveInteger(candidateNumber, 'candidateNumber');
  const selectedCategory = processingCategory(category);
  return [
    `海报工作台快速定向候选任务：${requiredString(jobId, 'jobId')}。`,
    '必须先读取并执行 imvia-poster-layering-workbench-targeted-v1 适配器；不得改用通用候选适配器。',
    `只处理 layer_index=${index} 的第 ${number} 个候选，类别为 ${selectedCategory}；不得读取、推断或处理其他图层。`,
    `只信任已确认快照：${requiredString(snapshotPath, 'snapshotPath')}；核验其 job_id、plan_version、layer_index、snapshot_id、source 指纹与调度信封一致。`,
    `完整来源画布 ${requiredString(sourcePath, 'sourcePath')} 是唯一视觉权威；读取 ${requiredString(planPath, 'planPath')} 仅用于核验当前计划。`,
    '不得对整张海报进行全局分析，不得重建所有权图或改变未选中区域；只能使用 v3.1 基础块加恰好一个对应类别块。',
    '生成内容必须完整落在目标框选内并保留至少 6% 安全边距；任何文字、引号、描边、阴影和装饰都不得触碰或越过画布边缘，禁止用裁切隐藏不完整内容。',
    '只允许一次 ImageGen 调用。保留原始候选和审核报告；当前层勾选去背景时，必须在 ImageGen 后调用 BRIA RMBG 2.0，再生成完整画布的透明预览与类别键色候选。原始输出尺寸放大或键色不精确不再单独构成硬拒绝；无可用 PNG 或报告时必须以原 dispatch_id 调用 finalize-poster-generation-failure。',
    '不得接受候选、写入 layers/、自动重试、发布、重组或导出；完成 finalization 后立即停止。',
  ].join('\n');
}
