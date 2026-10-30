# Imvia Layer

> 当前 V2 预览版的截图、安装入口与逐步操作请以[仓库首页](../README.md)为准。下方 v0.1.0 和旧海报流程保留为历史实现说明，不代表 V2 需要逐项人工采用。

Imvia Layer 是一个运行在 Codex Desktop 右侧浏览器面板中的 UI 拆图与海报分层工作台。它把每次拆分请求作为可见消息提交到当前 Codex 对话，由 Codex 生成并返回 PNG 结果。

仓库首页提供 macOS 与 Windows 的完整安装、启动、重连、更新、卸载和故障排除说明：[imvia-layer-review-canvas](../README.md)。本目录是应用目录 `imvia-ui-layer-review-canvas`。

## 当前版本：v0.1.0

这是首个可安装版本，提供以下能力：

- **插件唤起工作台**：安装后通过 `@imvia-layer` 在当前 Codex 任务的右侧浏览器打开工作台，无需解释本地服务、MCP 或会话桥接的工作方式。
- **可见会话拆分**：每个拆分任务会作为可见消息进入当前 Codex 对话；不会静默转为后台拆分。
- **框选与画布总览**：支持框选单张原图的拆分区域，也支持在无限画布中查看多张原图及各自的拆分节点与结果。
- **多图独立处理**：不同原图拥有独立的图层、任务和结果，互不覆盖；画布中按原图组织其子节点。
- **任务队列与回传**：当前会话繁忙时，新的拆分任务会排队；完成的透明 PNG 自动回传工作台并可下载、放大预览。
- **定向拆分与验收**：框选尺寸作为无限画布的逻辑尺寸与定位；ImageGen 定向修复使用标准参考画布与显式坐标映射。ImageGen 返回同比例的原生尺寸时按比例换算 `content_region`，修复类 UI 组件以该原生分辨率直接调用 BRIA RMBG 2.0（`bria-rmbg`）并回传高分辨率透明 PNG，不再因 `1024×1024 → 1254×1254` 这类同比例变化失败，也不会在去背景前缩小；文字与标志仍使用原像素锁定的透明 RGBA 流程。
- **完整贝塞尔钢笔路径**：保留、排除与边界标注支持直线锚点、拖拽创建曲线控制柄、`Option` 拆分单侧控制柄、闭合路径、锚点编辑及撤销。新标注统一写入贝塞尔路径；已有 legacy 画笔数据仍可只读显示和选中，不会被自动改写。
- **PNG 二次编辑与版本保留**：当前成功 PNG 是每次调整的唯一权威 base，工作台在新任务排队或失败时继续显示它；只有新版 PNG 成功完成后才切换。历史成功文件与任务记录继续保留，但画布只显示当前 base 结果节点。二次编辑使用 base PNG 的实际像素尺寸和 alpha，不使用逻辑框选尺寸；结构化操作与闭合钢笔路径限定可变范围，用户文字只描述视觉目标，路径外未标注 RGBA 像素保持锁定。
- **一键本地安装**：`npm run setup` 会探测 Python 3.10+、安装 RMBG 依赖、预热 BRIA RMBG 2.0（`bria-rmbg`）模型，并注册本地 Imvia Layer 插件。
- **海报分层工作流**：上传海报后先确认图层所有权计划，再按授权、快照和 dispatch journal 逐层生成候选；候选经用户审核后才进入正式图层与重组流程。快速定向模式支持区域级 ImageGen、BRIA RMBG 2.0 与语义 alpha matte 路由。

## 使用与执行规范

- [Imvia Layer 工作台完整使用指南](docs/guides/imvia-layer-workbench-user-guide.md)：面向使用者，覆盖工作台、框选、钢笔、提示词、队列、验收和 PNG 二次编辑。
- [海报分层工作流](docs/guides/imvia-layer-workbench-user-guide.md#海报分层工作流)：覆盖模式选择、所有权计划、逐层候选、透明结果、审核和重组。
- [海报分层工作台设计](docs/superpowers/specs/2026-08-20-poster-layering-workbench-mode-design.md)：定义海报计划、候选授权、正式图层与重组审计。
- [快速定向海报工作台设计](docs/superpowers/specs/2026-08-21-poster-targeted-workbench-fast-mode-design.md)：定义 confirmed snapshot、区域输出与定向候选执行边界。
- [PNG 二次编辑局部 ROI 执行规范](docs/superpowers/specs/2026-08-10-png-result-refinement-roi-execution-design.md)：面向系统实现，定义结构化操作、原生 1:1 ROI、RGB/Alpha 权限、像素锁定、版本与终态验收。

## V2 同页原位分层（开发分支）

V2 将拆分定义、结果和导出放在同一张原图画布中。海报/H5 原图只上传一次；拆分项按原图像素坐标框选。通过当前修订的机器检查后，结果自动就绪并进入透明 PSD，无须逐个勾选“已检查”或“采用”；失败的中间文件只进入诊断记录，不伪称成品。当前交付的是栅格图层，不会把文字或图形重建为 Photoshop 原生文字层/矢量图层。开发入口位于 `src/v2/WorkbenchV2.jsx`，打开工具使用 V2 工作台和同文档会话桥。

空状态右上角“更多”中的“导入旧版项目”是显式操作：它只读取 V1 明确使用的 `imvia-layer-project` 项目记录；用户还须选中项目并重新选择原始文件。旧 `ui` 模式映射为 H5，旧百分比框选转换为原图像素坐标。旧结果不会自动采用；缺少可验证的原位映射、来源和结果绑定时，只保留待复核元数据，不会进入当前候选或 PSD。旧 V1 项目记录不包含候选 PNG 时，只记录“旧版已确认”标记，不伪称候选图像已迁入。旧版路径标注不自动搬入，需在 V2 重新检查。

“替换原图”保留现有类别、名称、处理要求与排序，按新图尺寸映射选区及钢笔路径；旧图结果保留为历史，不混入新图导出。编辑草稿和待同步修改按工作区、文档保存在本机；暂时保存失败会自动重试，重新打开原文档可以恢复。只有服务端确认保存完成，界面才显示“已保存”。

会话桥在线状态以同文档心跳为准。短时断联自动恢复，不重新提交已发送任务。Codex 关闭或卸载会话桥卡片时，网页不能代替宿主重新挂载卡片；此时如实显示未连接，可在当前对话继续同一文档。结果下载不依赖会话桥在线。

这项工作在隔离分支 `codex/workbench-v2-in-place-psd` 开发，不会自动推送或合并。基线为 `a873ee1`，Task 10 提交为 `7a23f70`，Task 11 提交为 `6f7491e`；可用 `git log --oneline codex/workbench-v2-in-place-psd` 查看阶段点。若要回到 Task 10 的本地快照，可在确认没有未保存改动后执行 `git switch --detach 7a23f70`；切回开发分支使用 `git switch codex/workbench-v2-in-place-psd`。这只切换本地代码，不会改远端仓库。

Task 11 的逐项验收状态见 [V2 工作流验收记录](docs/superpowers/evidence/v2-workflow-acceptance.md)。

## 版本历史与更新规则

后续发布会继续在本 README 维护版本记录。每个版本会说明新增功能、重要修复、兼容性要求及必要的升级步骤。

### v0.1.0 — 首个可安装版本

- 发布 Codex Desktop 本地插件与右侧工作台的一体化安装流程。
- 提供可见会话拆分、任务队列、透明 PNG 回传、RMBG 最终处理和多图画布总览。
- 提供插件模板、安装脚本、source-available 许可证与 GitHub 发布说明。
- 安装器支持 Windows 与 macOS：自动记录本机可用的 Python 命令，后续拆分任务会复用该命令执行 RMBG 处理。
- ImageGen 定向修复使用 mapping 提取原生 `content_region`；同比例原生画布会自动换算 mapping 坐标，宽高比变化、拉伸压缩或构图偏移才会被拒绝。BRIA 预处理保持原始宽高比并输出高分辨率透明 PNG；框选尺寸只负责无限画布中的显示与定位。

## 一次安装

前置条件：Codex Desktop、包含 `npm` 的完整 Node.js `^20.19.0 || >=22.12.0` 安装（推荐 Node.js 22 LTS）、Python 3.10+。只有 `node` 可执行文件的宿主内置环境不足以运行安装命令；可先用 `node --version` 和 `npm --version` 确认两者都可用。Windows 与 macOS 均支持；macOS 请先通过 [python.org](https://www.python.org/downloads/macos/) 或 Homebrew 安装 Python 3.10+。`npm run setup` 会自动下载 RMBG 的 Python 依赖和 BRIA RMBG 2.0 模型，首次运行需要联网。RMBG 2.0 权重按 BRIA 的 CC BY-NC 4.0 许可提供，仅限非商业使用；商业部署需取得授权。

```sh
git clone https://github.com/xiongrubing335100-beep/layer-review-canvas.git
cd layer-review-canvas/imvia-ui-layer-review-canvas
npm run setup
```

如使用 ZIP，请解压仓库后进入其中的 `imvia-ui-layer-review-canvas` 目录，再运行同一条 `npm run setup` 命令。

`npm run setup` 是唯一的安装命令：它会先检查 Node 版本，以 `npm ci` 同步锁定的 JavaScript 依赖并生成全新的 production `dist/`，再创建可持久复用的托管 Python 环境（macOS：`~/plugins/imvia-layer/.python-runtime/bin/python`；Windows：`%USERPROFILE%\\plugins\\imvia-layer\\.python-runtime\\Scripts\\python.exe`）和插件自有 Node launcher `.node-runtime`，安装 RMBG 依赖和 BRIA RMBG 2.0 模型，最后注册本地插件。依赖来自提交的 universal `requirements-rmbg.lock`，并由 pip `--only-binary=:all:` 与 `--require-hashes` 校验所有 wheel；lock、Python ABI、系统与架构变化会触发安全重建。Python runtime 的 staging、venv、pip、probe 或 publish 失败会保留上一个有效 runtime；模型预热发生在 runtime 发布之后，因此预热失败会停止注册但不会回滚已验证 runtime。完成后重启 Codex Desktop（或新建任务），在对话中发送：

```text
[@imvia-layer](plugin://imvia-layer@personal) 打开工作台
```

工作台会在当前任务的右侧浏览器打开。上传图片、框选拆分项并点击“拆分”后，任务会以可见消息进入当前对话；结果 PNG 会回传到工作台。用户无需手动运行开发服务、打开 `127.0.0.1` 地址、安装额外插件或了解 MCP/会话桥接机制。

安装器会将完整工作台放入插件目录下的 `runtime/`：包含构建后的 `dist/`、源码与运行脚本、锁定依赖、V2 像素处理脚本和 PSD 编解码依赖。插件启动器使用这个已安装目录，支持从其他当前目录启动；新的安装不依赖下载目录继续存在。缺少关键适配器、像素脚本或 PSD 依赖时，安装会在注册之前失败。升级会替换运行代码并保留 `runtime/output/` 中的用户数据。

从旧版“直接运行下载目录”升级时，只有现有插件配置明确指向本次安装的源码目录，且尚无已安装 `runtime/`，安装器才把该源码目录的 `output/` 复制到新位置，原文件仍保留。历史项目、候选清单和冻结快照中的绝对路径不会被自动重写，因此这一步只完成数据保留，不表示旧项目已全部迁移为可移动数据。**有旧项目时不要删除原源码目录及其 `output/`。** V1 项目进入 V2 仍按上文“导入旧版项目”流程处理。

## 仅更新插件

工作台源码更新后，确保当前工作目录是 `imvia-ui-layer-review-canvas` 应用目录，再运行会重新同步依赖、production build 并注册插件的完整更新命令：

```sh
npm run update
```

然后重启 Codex Desktop 以重新加载插件清单。

如需卸载插件及其托管 `.python-runtime`、`.node-runtime`，在应用目录运行：

```sh
npm run uninstall:codex-plugin
```

重新运行 `npm run setup` 可完整重建插件与 runtime；模型缓存不属于插件目录，不会由此命令删除。

## 项目内容

- `src/`：React 工作台界面与状态逻辑。
- `layer-review-mcp-server.mjs`：MCP 服务，负责从 Codex 打开右侧工作台。
- `plugin-template/`：可移植插件模板；安装时会自动写入本机路径，不含作者个人目录。
- `scripts/`：工作台启动、PNG 最终处理、插件安装和初始化脚本。
- `requirements-rmbg.txt`：UI 组件去背景使用的 RMBG 顶层 Python 依赖。
- `requirements-rmbg.lock`：跨 macOS/Windows 的完整 hashed 依赖锁，安装时配合 `--require-hashes` 验证供应链。

安装后的运行时输出默认写入插件目录的 `runtime/output/`；直接运行开发工作台时写入应用目录的 `output/`。这些用户数据不会包含在新的源码发布候选中。

## 当前源码发布候选的安装验收

在应用目录运行以下命令，可复现安装与发布链路的验收。首次 `npm ci` 需要可用的包源；归档验收会复用并复制本机 npm 缓存，在独立临时目录中运行真实的 `npm ci`、`npm run setup` 和 `npm run update`。

```sh
npm ci
npm run build
node --test scripts/install-codex-plugin.test.mjs src/fresh-release-archive.test.mjs src/node-runtime-install.test.mjs src/python-runtime-install.test.mjs src/setup-imvia-layer.test.mjs src/plugin-runtime-repair.test.mjs
```

`fresh-release-archive.test.mjs` 验收的是 **current working tree release candidate**：包含 Git 已跟踪文件的当前内容和未被忽略的新源码，排除 `node_modules/`、`dist/`、`output/` 与临时报告。它不等于某个已提交、已打标签或已发布的 Git archive；正式发布前必须把候选需要的新文件纳入提交。

这些测试在临时插件目录和临时 HOME 中执行，不注册到日常使用的插件目录。测试替换了 Python 依赖安装、模型下载和 Node LICENSE 网络响应等外部依赖；实际依赖解包、前端构建、插件文件复制、更新与 MCP 启动都保留。验收还会移走源码目录，从另一个当前目录启动安装后的 MCP 并完成 `initialize`，以及从安装包完成 PSD 编解码回读。因此通过这组测试证明当前候选的交付链路成立，不代表已验证实时网络下载或已完成正式发布。

## 许可证与发布

本项目为 source-available 软件，采用根目录 [Imvia Layer Personal & Commercial License](../LICENSE)；本目录的 [LICENSE](LICENSE) 是其字节一致的发布副本。个人非商业使用免费；商业使用必须事先取得付费书面授权（prior written paid authorization）。第三方组件、模型和素材仍受其各自许可证约束；特别是 BRIA RMBG 2.0 的 third-party license 不会被本项目的商业授权覆盖或自动授予。

商业授权请通过 [青木](https://www.xiaohongshu.com/user/profile/5cdb80ac000000001601466b) 联系。发布操作见 [GitHub 发布说明](docs/GITHUB_RELEASE.md)，作者与第三方归属见根目录 [NOTICE.md](../NOTICE.md)。
