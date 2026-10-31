# Imvia Layer V2 In-place Layer Workbench and PSD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已确认 Figma 流程实现同页多选区编辑、可见批次拆分、原位像素图层审核及真实分层 PSD 下载。

**Architecture:** 新增 V2 文档和页面，通过明确适配层复用现有钢笔、来源存储、RMBG 和任务身份能力；不把旧逐项页面继续扩展成新版。文档、投递、执行、候选与导出分别保存事实，结果使用区域 RGBA 加原图 placement。一个有依赖顺序的实施计划分阶段交付；PSD 编码与宿主确认先做能力验证，不到最后才发现不可用。

**Tech Stack:** 现有 React/JavaScript、Vite、Node `^20.19.0 || >=22.12.0`、`node:test`、Zod、proper-lockfile、托管 Python/Pillow/BRIA RMBG；计划新增精确锁定的 `ag-psd@31.0.2`，先过编码兼容性测试。

**Spec:** [2026-09-27-workbench-v2-in-place-psd-design.md](../specs/2026-09-27-workbench-v2-in-place-psd-design.md)

## Global Constraints

- 仅在 `layer-review-canvas` 仓库、`codex/workbench-v2-in-place-psd` 分支实施；旧版基线 `c6399da` 保留。不得写入 Lovart 仓库；不自动 push、发布、替换已安装插件或清空用户任务。
- 海报 `poster` 与 H5 `h5` 两入口，共用新版页面；保留旧画布总览能力。不实现原生 Photoshop 文字层或矢量层。
- V2 `schemaVersion: 2`，独立存储；旧任务、文件和本地状态不能被迁移过程覆盖。新图不复用旧来源任务。
- `W × H`、左上角 `(0, 0)` 是唯一像素基准；bounds 为整数半开区间，路径为原图像素浮点值。
- 规范候选为区域尺寸 RGBA + 原图 placement；禁止 alpha 外接框裁切后缩放居中，也禁止为了 6% 边距移动真实内容。参考画布 padding 必须可逆。
- 提取保留原图 RGB、只改 alpha；重建只在显式授权修复区修改。不得推断其他层或默认加入可见原图背景。
- “完成”只存草稿；“拆分”默认当前文档所有合格待拆分项。重试明确触发；同修订等待确认、排队、处理中、待审核项不重复提交。
- 一个有限批次请求一次宿主可见确认，每项仍独立授权、dispatch、归档；禁止伪造已送达、隐藏执行或自动重试。宿主限制导致无法一次发送时明确分批确认。
- 用户明确采用才变成当前已完成图层；列表上方为前景，下方为背景。所有当前项均有匹配修订的采用结果才允许导出；无背景时留透明。
- 新层仅 `Normal`；旧非 Normal 候选不静默降级。PSD 等于原图尺寸、保留真实像素层、名称、顺序和偏移；棋盘格只在 UI。
- 取消终结精确 attempt，迟到结果不复活；刷新不重发，重启仅取消本工作台会话旧任务并打开空态，保留历史文件。
- 本次仅形成计划；下面步骤待用户审阅和选择执行方式后实施。真实生成验收单独记录，不把 fixture 当作生产成功。

## Review Focus

1. 极窄侧栏、竖长图、透明小图与贴边选区：首次完整可见，反复缩放不漂移。归属 Task 2、5、6。
2. 宿主确认中取消、双击提交、刷新、旧回执迟到：不能误报执行、重复收费或复活旧任务。归属 Task 4、8。
3. 执行中编辑区域、换原图、改名称：结果只能回原快照；纯改名不使像素失效。归属 Task 1、7、9。
4. 全透明、全不透明、半透明边缘及错误映射：按策略检查，不把空图或重新居中的图层当成功。归属 Task 3、7、9。
5. 导出时编辑、文件损坏、中文重名、多层重叠及超大画布：导出冻结版本正确，失败不覆盖旧文件，不偷偷缩图。归属 Task 3、10、11。

---

## 事实、依赖与实施边界

2026-09-27 只读核验：旧 `public/layer-review-bridge-widget.js` 在 `sendMessage` 与 `markDelivered` 并发期间预写投递记录，默认仍需卡片点击；V2 不继承这种“先记 delivered 再等确认”的含义。旧 `scripts/prepare-poster-rmbg-candidate.py` 存在裁 alpha 外接框并缩放到安全区的分支，不能作为原位输出路径。旧 `/api/poster-layer/jobs/:jobId/export` 返回 ZIP，保留原语义。

PSD 技术依据：官方 [ag-psd 文档](https://github.com/Agamnentzar/ag-psd) 支持读写及原始 `imageData`，但不替应用生成合成预览；[数据结构说明](https://github.com/Agamnentzar/ag-psd/blob/master/README_PSD.md) 定义 children 从前到后、区域像素加 left/top；[写入源码](https://github.com/Agamnentzar/ag-psd/blob/master/src/psdWriter.ts) 限制普通 PSD 边长 30000、写入 8-bit。注册表只读查询返回 `31.0.2`；仍须 Task 3 实测，未安装、未宣称兼容已通过。

执行前读本规格、此计划及项目 AGENTS，检查工作树；只纳入本任务改动。当前 shell 未找到裸 `npm`，已知 Node 是 `/Users/a1234/.local/bin/node`，指向 Codex 托管运行时。先通过工作区依赖定位工具确认 npm CLI 的真实路径；下文 `node`/`npm` 表示已定位的运行时命令，脚本用 `process.execPath`，不能依赖不存在的 PATH 命令或为此全局安装。

首版 PSD 产品上限定为：单边 ≤30000、总画布 ≤40000000 像素、≤100 个图层；导出估算 `24*W*H + 12*Σ(regionWidth*regionHeight) + 64 MiB`，不得超过 `min(1 GiB, availableMemory/4)`。这是预检预算而非实测峰值保证；Task 3 记录 RSS 峰值，若低估先修正预算，不放宽限制来掩盖失败。超限返回具体数值，源文档不缩放、不会变成 PSB。编码放在一次性受管理子进程中，结束后释放内存，不是后台生成任务。

## 文件与接口地图

所有路径相对 `imvia-ui-layer-review-canvas/`。新模块采用现有 `.js/.jsx/.mjs` 风格和 JSDoc，不引入 TypeScript 迁移。

| 位置 | 职责 |
| --- | --- |
| `src/v2/document.js`、`document-store.js` | 数据验证/修订与服务端原子持久化，store 不进浏览器 bundle |
| `src/v2/coordinates.js`、`pen-adapter.js` | 查看变换、原图像素路径与旧钢笔格式边界 |
| `src/v2/WorkbenchV2.jsx`、`DocumentCanvas.jsx`、`LayerList.jsx`、`LayerEditor.jsx`、`PenEditor.jsx`、`CandidateReview.jsx`、`workbench-v2.css` | 新版视图，每个组件只处理自己的交互 |
| `src/v2/api-client.js`、`api.mjs` | 客户端接口与本地 HTTP 路由；Vite 中仅挂载 |
| `src/v2/batch.js`、`batch-store.js`、`batch-bridge.js` | 冻结资格与状态规则、持久化串行队列、可见宿主消息 |
| `src/v2/execution-adapter.js`、`candidate-store.js` | 来源/修订绑定、处理清单、候选归档与采用 |
| `scripts/finalize-v2-candidate.mjs`、`scripts/v2-region-pixels.py` | 执行结果机械验证、映射逆变换、区域 RGBA；不走旧居中后处理 |
| `src/v2/pixels.js`、`psd-codec.mjs`、`export-store.js`、`scripts/export-v2-psd.mjs` | Normal 合成、PSD 编码、冻结导出与原子发布 |
| `src/v2/legacy-import.js` | 显式复制旧文档，标记不可验证的原位关系 |
| `src/main.jsx`、`vite.config.js`、`layer-review-mcp-server.mjs`、`src/mcp-bridge-resource.js`、`public/layer-review-bridge-widget.js` | 限量接入点，不无关重构 |
| `plugin-template/imvia-layer/skills/imvia-layer-batch-v2/SKILL.md`、`references/item-contract.md` | 新的可见批次协调器与 V2 单项执行契约，不改变 V1 的完成即停约定 |

每个纯逻辑模块配同目录 `.test.mjs`；视图沿用 Vite SSR 检查可交互语义，并做真实浏览器交互验收，不写 CSS 字符串快照。共享测试输入在 `src/v2/test-fixtures.mjs`，只生成合成像素、不携带用户海报。

统一数据形状在 Task 1 定义，后续不得另起同义字段：

- `Source={path,width,height,fingerprint,revision}`；`Bounds={x,y,width,height}`；`PixelImage={width,height,data:Uint8ClampedArray}`（8-bit、非预乘 RGBA）。
- `Document={schemaVersion:2,documentId,workbenchSessionId,mode,source,revision,layers:Record<layerId,LayerDefinition>,layerOrder,activeLayerId}`。
- `LayerDefinition={layerId,layerRevision,name,displayCategory,processingCategory,bounds,paths,requirements,strategy,acceptedVersionId}`；`strategy={operation:'extract'|'reconstruct',removeBackground,repairPaths}`；paths 包含闭合状态、锚点及控制柄的原图坐标。
- `LayerSnapshot={snapshotId,source,layerId,layerRevision,bounds,paths,requirements,processingCategory,strategy}`，摘要覆盖所有像素相关字段，不含显示名称和列表次序。
- `Batch={batchId,documentId,workbenchSessionId,submissionKey,snapshots,attemptIds,status}`；快照顺序冻结，失败重试不能扩充原批次。
- `Attempt={attemptId,batchId,documentId,layerId,layerRevision,dispatchId,authorizationId,snapshotId,sourceFingerprint,delivery,execution,error,timestamps}`；delivery 为 `pending/claimed/delivered/sent/cancelled`，execution 为 `not_started/running/finalizing/completed/failed/cancelled`；完整旧信封作为 `legacyEnvelope` 原样留存（如适用）。
- `CandidateVersion={versionId,attemptId,snapshotId,sourceFingerprint,layerRevision,pngPath,sha256,width,height,alpha,placement,mapping,review,createdAt}`；`ExportSnapshot={exportId,documentId,documentRevision,width,height,layers,composition,output,checks}`，layers 从前到后包含名称、版本、摘要、placement。

## Task 1: V2 文档、稳定身份与持久化

**Files:** 新建 `src/v2/document.js`、`document-store.js`、`test-fixtures.mjs`、`document.test.mjs`、`document-store.test.mjs`。

**Interfaces:** 产出 `createDocument({documentId,workbenchSessionId,mode,source}):Document`、`addLayer(document,definition):Document`、`removeLayer(document,layerId):Document`、`reorderLayers(document,layerIds):Document`、`applyLayerEdit(document,layerId,patch):Document`、`freezeLayer(document,layerId):LayerSnapshot`；`createDocumentStore({root}):{create,read,update}`，create 接收 Document、read 接收 documentId、update 接收 `{documentId,expectedRevision,document}`，均异步返回 Document，冲突为 `REVISION_CONFLICT`。store 存在 `output/workbench-v2/documents/<documentId>/`，使用目录锁和原子替换；removeLayer 只移出当前列表，保留该层历史及活动任务绑定。

- [ ] 写测试：`assert.equal(renamed.layers.a.layerRevision, original.layers.a.layerRevision)`；`assert.equal(moved.layers.a.layerRevision, original.layers.a.layerRevision+1)`；冻结后编辑 `assert.deepEqual(frozen.bounds, before.bounds)`；并发保存只有一个成功、另一个 `REVISION_CONFLICT`。加入来源替换创建新身份、未知自定义处理类别拒绝的断言。
- [ ] 运行 `node --test src/v2/document.test.mjs src/v2/document-store.test.mjs`，先确认缺失接口/行为导致失败。
- [ ] 实现上述接口及 Zod 验证，类别映射按规格；空名称、无效区域不能提交，路径坐标有限且在授权边界。删除文档是关闭入口而非删除历史文件；纯显示变更只升 document revision。
- [ ] 同一命令通过，检查没有访问 V1 存储；只暂存本任务文件，提交 `feat: add versioned V2 workbench documents`。

## Task 2: 原图坐标与钢笔兼容边界

**Files:** 新建 `src/v2/coordinates.js`、`pen-adapter.js` 及对应 `.test.mjs`；复用 `src/pen-path.js`，不全局改变旧归一化语义。

**Interfaces:** 消费 Bounds；产出 `fitViewport(bounds,viewport,padding=16):{scale,offsetX,offsetY}`、`toScreen(point,transform)`、`toSource(point,transform)`、`quantizeBounds(bounds,sourceSize):Bounds`、`toLegacyPaths(paths,sourceSize)`、`fromLegacyPaths(paths,sourceSize)`。所有 point 为 `{x,y}`。

- [ ] 写测试：竖图 `1562×3396` 在 `640×480` 中四角均在 16px 内边距以内；`assert.ok(Math.abs(roundTrip.x-129.25)<1e-9)`；100 次视图往返路径原数据不变；反向拖拽、贴边 1px 框和 fractional bounds 保存按左上 floor、右下 ceil 后 clamp，零面积拒绝。
- [ ] 运行 `node --test src/v2/coordinates.test.mjs src/v2/pen-adapter.test.mjs`，确认失败。
- [ ] 实现共享变换和路径转换；放大视图改变 bounds 参数但不改 sourceSize 基准，不以图片 CSS 显示尺寸持久化路径。
- [ ] 同一命令通过；提交 `feat: add source-pixel viewport and pen transforms`，仅包含本任务文件。

## Task 3: PSD 编码可行性与像素合成关卡

**Files:** 新建 `src/v2/pixels.js`、`psd-codec.mjs`、`pixels.test.mjs`、`psd-codec.test.mjs`；修改 `package.json`、`package-lock.json`；新增 `docs/superpowers/evidence/v2-psd-compatibility.md`。

**Interfaces:** 消费 PixelImage；产出 `composeNormal({width,height,layers}):PixelImage`（layers 前到后、每项 `{image,placement}`）、`checkPsdBudget({width,height,layers,availableMemory}):{estimatedBytes,budgetBytes}`、`encodePsd({width,height,layers,composite}):Uint8Array`、`inspectPsd(bytes):{width,height,layers,composite}`；编码 layer 另含 name。

- [ ] 建确定性 16×12 fixture：底层半透明蓝 `(1,2,5,4)`、顶层红 `(3,3,3,2)`，中文重名；测试 `assert.equal(Buffer.from(bytes).subarray(0,4).toString(),'8BPS')`，断言 PSD version 为1、重读名称/顺序/偏移/RGBA 保持，合成相同；无背景像素 alpha=0、半透明重叠符合 source-over。另测边长30001、总像素40000001、101层及预算超限均拒绝。
- [ ] 运行 `node --test src/v2/pixels.test.mjs src/v2/psd-codec.test.mjs`，确认失败；使用定位后的 npm 精确安装 `ag-psd@31.0.2 --save-exact`，不安装全局工具。
- [ ] 实现上述接口；使用原始 imageData、`trimImageData:false`、`generateThumbnail:false`、`noBackground:true`，自行计算 composite。验证读取使用 raw/imageData 路径且不依赖浏览器 Canvas；若库要求 ImageData 工厂，仅注册 typed-array 工厂，不能悄悄加入 native canvas。没有可用纯像素路径则记录阻塞，不转为扁平图。
- [ ] 同一命令通过；一次代表性 `1562×3396`、10区域层样本记录时间/RSS、运行时及版本，销毁测试产物；文档明确尚未 Photoshop 验收。提交 `feat: verify raster PSD codec and composition`，只提交上述源码、测试、锁文件及报告。

## Task 4: 可见批次确认桥接关卡

**Files:** 新建 `src/v2/batch-bridge.js`、`bridge-request-store.js`、`batch-bridge.test.mjs`；修改 `public/layer-review-bridge-widget.js`、`src/mcp-bridge-resource.js`、`layer-review-mcp-server.mjs`；新增 `docs/superpowers/evidence/v2-bridge-confirmation.md`。

**Interfaces:** 产出 `requestBatchConfirmation({batchId,envelope,host,signal}):Promise<{requestId,status:'requested'}>` 与 `acknowledgeBatchMessage({batchId,requestId,receipt}):Promise<void>`；host 是实际消息 SDK 的薄适配器，receipt 必须来自当前可见消息的执行器确认并匹配批次摘要、会话及 requestId，不能由本地按钮生成。`createBridgeRequestStore({root}):{create,read,transition}` 持久化 `{requestId,batchId,workbenchSessionId,envelopeSha256,status}`，用于 Task 4 独立验证和 Task 8 批次绑定；create 接收记录、read 接收 requestId、transition 接收 `{requestId,expectedStatus,nextStatus,receipt}` 并返回更新记录，均异步。MCP 暴露 `confirm_workbench_v2_batch` 接收同一组绑定字段。

- [ ] 用注入 host 写测试：请求被宿主接收仍 `assert.equal(state.delivery,'claimed')`；未有可见回合确认 `assert.equal(started,0)`；同一 requestId 两次点击 `assert.equal(hostCalls,1)`；用户取消、旧会话 receipt、延迟 receipt 均不能 delivered/start。同样覆盖 SDK resolve 但用户尚未发送的情况。
- [ ] 运行 `node --test src/v2/batch-bridge.test.mjs src/mcp-bridge-widget.test.mjs src/mcp-bridge-resource.test.mjs`，先确认新断言失败。
- [ ] 实现“拆分按钮 → 宿主确认”的 V2 事件路径，复用 SDK 而非自动点确认；保留 V1 卡片路径。先创建 requestId，再请求宿主；可见回合证明批次接收后原子记 delivered/sent，消除预写 delivered 的竞态。批次 prompt 只含摘要、数量及本地清单路径，执行器读取后再次核对摘要，不塞全部图片数据。
- [ ] 运行测试通过。以测试模式向桥接注入有限的 no-generation 清单（无需提前实现 Task 8 队列），在 Codex 中请求确认并等待用户发送；验证无旧卡片第二次点击、消息真实可见、MCP 确认匹配。若宿主拒绝自动打开，记录准确返回值，停在这个关卡提出工作台内显式唤起方式，不用“已发送”冒充；不自动重发试探。Task 5/8 再接真实拆分按钮。
- [ ] 将实际证据和局限写入报告，提交 `feat: add verified visible V2 batch confirmation`。此关卡未通过不能标记整条提交流程完成。

## Task 5: 双上传入口、统一画布与图层列表

**Files:** 新建 `src/v2/WorkbenchV2.jsx`、`DocumentCanvas.jsx`、`LayerList.jsx`、`workbench-v2.css`、`api-client.js`、`api.mjs`、`workbench.test.mjs`；修改 `src/main.jsx`、`vite.config.js`。

**Interfaces:** 消费 Tasks 1–2；`WorkbenchV2({api,onOpenLegacy,onOpenOverview})`、`DocumentCanvas({document,transform,selection,onSelect,onBoundsChange})`、`LayerList({document,statusByLayer,onSelect,onEdit,onAdd,onReorder})`；客户端 `createDocument({mode,file,workbenchSessionId})`、`getDocument(id)`、`saveDocument(document,expectedRevision)` 对应 `/api/workbench-v2/documents` POST、`/:id` GET/PUT。HTTP 返回验证错误400、修订冲突409。V2 URL 使用 `workbench=v2`，V1入口仍可选。

- [ ] SSR/模型测试验证 `poster/h5` 两入口、新增自定义项必须选处理类别、框与列表共享 layerId、重排仅改 layerOrder、未上传时无生成计时；API 测试保存读取和冲突不会覆盖。运行 `node --test src/v2/workbench.test.mjs` 确认失败。
- [ ] 实施前按 Figma 的 `35:2/84:2` 可见子节点读取设计上下文及截图，保存节点/读取时间到验收报告；实现统一界面、上传规范化来源与指纹、全部框和名称。顶部画布总览调用旧入口，不创建新独立项目；列表内滚动，底部两按钮固定可见。Vite 只转发新路由模块。
- [ ] 同一测试通过。真实浏览器分别检查 1536×1024、900×700、420×800：横图、竖图、透明图与小图都完整适配，重叠框可通过列表选择，窄屏切面板保留坐标；不生成、不发送任务。
- [ ] 只提交本任务文件和已记录证据，提交 `feat: add unified V2 canvas and layer list`。

## Task 6: 单项草稿与放大钢笔精修

**Files:** 新建 `src/v2/LayerEditor.jsx`、`PenEditor.jsx`、`editor-state.js`、`editor-state.test.mjs`；修改 `src/v2/WorkbenchV2.jsx`、`workbench-v2.css`，复用 `src/PenPathOverlay.jsx` 和 `src/pen-editor-state.js`。

**Interfaces:** `createEditorDraft(document,layerId)`、`reduceEditorDraft(draft,event)`、`commitEditorDraft(document,draft):Document`；`LayerEditor({draft,onChange,onDone,onCancel,onOpenPen})`、`PenEditor({source,draft,onChange,onClose})`。草稿只在 Done 时调用 Task 1 的 applyLayerEdit。

- [ ] 测试完成/放弃/未保存切换：`assert.equal(sendCalls,0)`，放弃后原文档完全相等，Done 后仅对应项升修订；钢笔编辑撤销重做后路径可恢复，关闭放大视图回草稿不直接提交。运行 `node --test src/v2/editor-state.test.mjs src/pen-editor-state.test.mjs` 确认新增测试失败。
- [ ] 读取 Figma `85:3745/76:10130` 并实现名称类别、要求、快捷提示、去背景开关、修复区域与精细提示。放大初次 fit 当前选区，后续 zoom/pan 不改源数据；复用钢笔控制柄、删除及撤销。魔棒未有可用算法时置灰并说明，不伪实现。
- [ ] 同一测试通过；浏览器检查放大前后选区/路径重合、图像底部完整、两种模式保存/放弃符合文案。提交 `feat: add V2 layer drafts and focused pen editing`，仅暂存本任务范围。

## Task 7: 原位处理适配与区域候选归档

**Files:** 新建 `src/v2/execution-adapter.js`、`candidate-store.js`、`execution-adapter.test.mjs`、`candidate-store.test.mjs`、`scripts/finalize-v2-candidate.mjs`、`scripts/v2-region-pixels.py`、`scripts/test_v2_region_pixels.py`；旧 V1 finalizer 不改语义。

**Interfaces:** `prepareV2Item({document,snapshot,attempt,outputRoot}):Promise<ProcessingManifest>`；`ProcessingManifest={schemaVersion:2,mode,envelope,snapshot,selectedCropPath,route,maskProvider,maximumImagegenCalls,referencePath,mappingPath,outputPath}`，route 为 `extract_mask/reconstruct`，envelope 保留 Task 1 全部身份；`finalizeV2Candidate({manifestPath,rawPath,mattePath,reportPath}):Promise<CandidateVersion>`、`finalizeV2Failure({manifestPath,error,reportPath}):Promise<Attempt>`，失败也绑定原 dispatch/auth 且保留原始证据。纯图像 CLI `v2-region-pixels.py --manifest <path> --raw <path> --matte <path> --output <path>` 按 route 读取所需参数，输出机器可读检查报告。

- [ ] 写不调用模型的 fixture：选区 `(129,1522,1280,1451)` 必须输出 `1280×1451`、placement 不变，远离原点的彩色标记不移动；extract 输出 RGB 与冻结 crop 每像素相等。测试 standard-reference padding 逆映射、缺 mapping 拒绝、来源/dispatch 错配拒绝、修复区外 RGB 不变、全透明失败、允许保留背景时全不透明通过、去背景前景全不透明待检查而非误报完成。
- [ ] 运行 `node --test src/v2/execution-adapter.test.mjs src/v2/candidate-store.test.mjs` 与 `node scripts/run-managed-python-tests.mjs`，确认新增行为尚未通过；Python 仅使用已配置托管运行时。
- [ ] 实现显式 poster/H5 适配，不把 `h5` 直接塞给旧 `ui` enum；冻结 crop、路径 mask 和映射。提取且不去背景时 `maskProvider=selection`（无路径则全选区），ImageGen 预算0；去背景的 text/brand_ui 使用 `imagegen_matte`、预算1，其他类别使用 `bria`、预算0；所有 extract 保留原 RGB。reconstruct 预算1、生成区域图，勾选去背景再走 BRIA。路径最终限制有效输出/修复范围，不自动重试、扩框、裁边居中或修改旧 skill。保留原始结果与审核报告；无可用 PNG/报告则失败归档，不悬挂队列；候选只归原 attempt，即使文档后来变化。
- [ ] 同一测试通过，机械验收原位 fixture；用户内容的语义正确性仍待人工审核。提交 `feat: preserve source coordinates in V2 candidates`，不提交用户图片/生成输出。

## Task 8: 冻结批次、串行执行、取消与恢复

**Files:** 新建 `src/v2/batch.js`、`batch-store.js`、`batch.test.mjs`、`batch-store.test.mjs`；修改 `src/v2/api.mjs`、`api-client.js`、`WorkbenchV2.jsx`、`layer-review-mcp-server.mjs`；新建 `plugin-template/imvia-layer/skills/imvia-layer-batch-v2/SKILL.md`、`references/item-contract.md`。

**Interfaces:** `createBatch({document,attempts,submissionKey,mode:'pending'|'retry',layerIds}):Batch`、`applyAttemptEvent(attempt,event):Attempt`（event 含 eventId、attemptId、dispatchId、type、timestamp、payload）；store `submitBatch({documentId,expectedRevision,submissionKey,mode,layerIds})`、`claimNextBatchItem({batchId,receipt})`、`cancelAttempt({attemptId})`、`restartSession({workbenchSessionId})`；依次返回 Batch、唯一 ProcessingManifest 或 `{done:true}`、Attempt、`{cancelledAttemptIds,empty:true}`，均异步。MCP 将这些接口与 Task 4 confirm 绑定，不暴露任意文件执行。

- [ ] 写 fixture 测试：同提交键两次 `assert.equal(first.batchId,second.batchId)`；pending 排除同修订 active/review/adopted/failed/cancelled 项；retry 明确产生新 attempt；失败释放下一项且自身不重试；取消后 `assert.equal(lateEvent.execution,'cancelled')`；换图旧回执不更新新文档；刷新不新增请求，restart 只取消本 session 并保留历史/其他会话。
- [ ] 运行 `node --test src/v2/batch.test.mjs src/v2/batch-store.test.mjs src/v2/batch-bridge.test.mjs`，确认失败。
- [ ] 实现 `/documents/:id/batches` POST、`/attempts/:id/cancel` POST、`/sessions/:id/restart` POST，以及只读批次/attempt 查询；submit 前完整验证草稿已保存/区域有效。使用锁和事件幂等键；UI delivery 与 execution 独立渲染，取消/失败终态不能被后续事件回退。
- [ ] 编写 V2 批次 skill：只处理冻结清单，逐项确认有效身份、调用一次单项适配、归档后返回协调器；无隐藏任务、无自动重试、无采用/发布；取消项跳过。模型预算每 attempt 显式冻结，旧 V1“立即停止”契约不被复用为新批次循环。长消息或宿主限制显示可确认分批列表，不静默漏项。
- [ ] 上述测试通过；用 no-generation fixture 走 Task 4 真实确认到串行终态并测试取消。仅有明确生成请求时才跑收费内容。提交 `feat: coordinate visible V2 batches and cancellation`，仅暂存本任务变更。

## Task 9: 同页候选审核、采用与合成预览

**Files:** 新建 `src/v2/CandidateReview.jsx`、`candidate-review.js`、`candidate-review.test.mjs`；修改 `candidate-store.js`、`api.mjs`、`api-client.js`、`WorkbenchV2.jsx`、`workbench-v2.css`。

**Interfaces:** `candidateState(document,layerId,versions,attempts)` 返回状态与原因；`adoptCandidate({documentId,expectedRevision,layerId,versionId}):Promise<Document>`；`getCompositionLayers(document,versions)` 返回 Task 3 的前后顺序（只含明确采用版本）。API `/documents/:id/layers/:layerId/adopt` POST 和对应版本只读列表。

- [ ] 写测试：采用必须匹配来源/snapshot/layerRevision，旧修订拒绝为当前完成；重命名后已采用仍有效；新候选不改变 acceptedVersionId；失败不删旧文件；全透明不可悄悄采用；参考原图不自动加入 composition。运行 `node --test src/v2/candidate-review.test.mjs src/v2/candidate-store.test.mjs` 确认失败。
- [ ] 实现版本浏览、原位叠加、透明 PNG、显式“采用此版本”和重新生成；浏览器预览使用源尺寸与 placement，默认完整 fit，棋盘格作为 CSS 背景。过期采用结果可查看但不能当当前修订完成；导出阻碍列明具体层。
- [ ] 同一测试通过；在浏览器验证竖长候选普通/放大全图均完整、重排改变遮挡但不移位、半透明边缘无棋盘污染。提交 `feat: review and adopt V2 layer versions in place`。

## Task 10: 冻结导出与真实 PSD 下载

**Files:** 新建 `src/v2/export-store.js`、`export-store.test.mjs`、`scripts/export-v2-psd.mjs`；扩展 `scripts/v2-region-pixels.py` 提供已校验 PNG 到 RGBA 的解码入口；修改 `src/v2/api.mjs`、`api-client.js`、`WorkbenchV2.jsx`、`LayerList.jsx`。

**Interfaces:** `freezeExport({document,versions}):ExportSnapshot`、`exportDocumentPsd({documentId,expectedRevision,outputRoot}):Promise<ExportSnapshot>`；受管理子进程执行 `export-v2-psd.mjs --snapshot <path> --output <tempPath>`，调用 Task 3 encode；`POST /documents/:id/exports` 返回身份和状态，`GET /documents/:id/exports/:exportId/download` 只返回已验证的 `image/vnd.adobe.photoshop` 文件。

- [ ] 写测试：未采用/旧修订/未知非 Normal 层均阻止导出；缺背景透明；导出期间改文档 `assert.equal(exported.documentRevision,frozenRevision)`；PNG hash/尺寸变化拒绝；注入磁盘写入错误后旧导出 hash 不变、没有可下载半成品；re-read 名称/顺序/偏移完整且 composite 与 Task 3 相同。
- [ ] 运行 `node --test src/v2/export-store.test.mjs src/v2/psd-codec.test.mjs` 确认失败。
- [ ] 实现锁内冻结、每文件摘要/来源/策略验证、预算检查及逐项 PNG 解码，子进程使用 `process.execPath`；先写本次临时路径，完整重读验证后原子发布唯一 exportId 文件。退出/取消清理本次临时文件；旧成果不动。导出列表显示对应修订、过期状态和无背景说明，下载不得指向旧 ZIP 接口。
- [ ] 同一测试通过，用 Photoshop 打开代表性 PSD，检查中文图层、透明背景、逐层显示/隐藏、位置及合成；记录结果。无法使用 Photoshop 时明确标记该验收未完成，不以库回读替代。提交 `feat: export verified in-place raster PSD documents`。

## Task 11: 显式迁移、整链验收与回退交付

**Files:** 新建 `src/v2/legacy-import.js`、`legacy-import.test.mjs`、`workflow.test.mjs`、`docs/superpowers/evidence/v2-workflow-acceptance.md`；修改 `src/v2/WorkbenchV2.jsx`、`README.md`、`HANDOFF.md`。

**Interfaces:** `importLegacyDocument({legacyDocument,verifiedAssets,newDocumentId}):{document,history,warnings}`；只复制来源/定义，旧候选默认为待查历史，具备可验证原位映射与匹配身份才可参与新文档审核，不自动采用；旧 `ui` 显式映射 `h5`。

- [x] 写测试：不改变 legacy 输入及文件；曾经 recenter 的候选 `assert.equal(imported.document.layers.a.acceptedVersionId,null)`；完整 fixture 经 document→batch确认→两项回传→采用→PSD 成功，任一未审核项阻断导出；V1 ZIP API 与旧 dispatch 流程仍通过。运行 `node --test src/v2/legacy-import.test.mjs src/v2/workflow.test.mjs` 确认失败。
- [x] 实现显式迁入与旧版入口，文档写明新旧存储和本分支/基线；不迁移任意系统目录、不批量清理已有任务。更新集成测试，不以生成服务 mock 声称真实模型成功。
- [x] 跑上述测试及一次最终相关回归：`node --test src/v2/*.test.mjs src/mcp-bridge-widget.test.mjs src/mcp-bridge-resource.test.mjs src/foreground-dispatch.test.mjs src/poster-job-store.test.mjs src/pen-editor-state.test.mjs`、`node scripts/run-managed-python-tests.mjs`、Vite production build（`npm` 不在 PATH，通过 `node node_modules/vite/bin/vite.js build`）。记录的两项既有无关断言失败见验收记录。
- [ ] 在真实浏览器对照四个 Figma 节点完成上传、添加重叠选区、编辑/精修、确认取消与恢复、历史候选、原位预览、PSD 下载验收；海报/H5 各覆盖一次。真实生成使用用户明确授权的有限样本，记录实际预算和结果；PSD 完成 Photoshop 检查。列出每项 passed/blocked 与证据，不笼统写“全部完成”。
- [ ] 清理本次无用临时文件，保留必要验收报告与用户结果；核对 diff 范围与 git status。提交 `feat: complete V2 migration and workflow acceptance`；给用户本地分支、各阶段提交及回退入口，不自动合并或推送。

## 自审覆盖与交付节奏

规格 §1–4 → Tasks 5/6/9/11；§5 → Tasks 1/2/7；§6 → Tasks 1/7/8/9/10；§7 → Tasks 4/8；§8 → Tasks 3/9/10；§9 → Tasks 1/11；§10–11 → 全计划验证及人工审阅。五项 Review Focus 均有指定测试，不靠最终截图替代契约测试。

阶段 A（1–4）：文档/坐标基础、PSD 与桥接能力证据。阶段 B（5–6）：可实际操作的四个设计界面。阶段 C（7–9）：真实原位处理及同页审核。阶段 D（10–11）：PSD 和兼容性验收。任何阶段出现新授权或宿主能力阻碍，应给出具体结果和待决策点，不能宣称后续已实现。

计划审阅通过后选择执行方式：建议当前会话顺序实施（Native），因为任务共享文档、坐标和 dispatch 契约；完成后做独立整分支审查。也可逐任务采用独立实施/审查 Agent（Subagent-driven），上下文成本更高。当前没有执行产品代码步骤。
