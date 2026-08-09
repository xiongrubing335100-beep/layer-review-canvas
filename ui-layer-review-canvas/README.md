# Imvia Layer

Imvia Layer 是一个运行在 Codex Desktop 右侧浏览器面板中的 UI 拆图工作台。它把每次拆分请求作为可见消息提交到当前 Codex 对话，由 Codex 生成并返回 PNG 结果。

## 当前版本：v0.1.0

这是首个可安装版本，提供以下能力：

- **插件唤起工作台**：安装后通过 `@imvia-layer` 在当前 Codex 任务的右侧浏览器打开工作台，无需解释本地服务、MCP 或会话桥接的工作方式。
- **可见会话拆分**：每个拆分任务会作为可见消息进入当前 Codex 对话；不会静默转为后台拆分。
- **框选与画布总览**：支持框选单张原图的拆分区域，也支持在无限画布中查看多张原图及各自的拆分节点与结果。
- **多图独立处理**：不同原图拥有独立的图层、任务和结果，互不覆盖；画布中按原图组织其子节点。
- **任务队列与回传**：当前会话繁忙时，新的拆分任务会排队；完成的透明 PNG 自动回传工作台并可下载、放大预览。
- **定向拆分与验收**：框选尺寸作为无限画布的逻辑尺寸与定位；ImageGen 定向修复使用固定标准画布与显式坐标映射，修复类 UI 组件会以原生 `content_region` 分辨率直接调用 BRIA RMBG 2.0（`bria-rmbg`）并回传高分辨率透明 PNG，不再在去背景前缩小；文字与标志仍使用原像素锁定的透明 RGBA 流程。
- **完整贝塞尔钢笔路径**：保留、排除与边界标注支持直线锚点、拖拽创建曲线控制柄、`Option` 拆分单侧控制柄、闭合路径、锚点编辑及撤销。新标注统一写入贝塞尔路径；已有 legacy 画笔数据仍可只读显示和选中，不会被自动改写。
- **PNG 二次编辑与版本保留**：当前成功 PNG 是每次调整的唯一权威 base，工作台在新任务排队或失败时继续显示它；只有新版 PNG 成功完成后才切换。历史成功文件与任务记录继续保留，但画布只显示当前 base 结果节点。二次编辑使用 base PNG 的实际像素尺寸和 alpha，不使用逻辑框选尺寸；文字要求与闭合钢笔路径限定可变范围，路径外未标注 RGBA 像素保持锁定。
- **一键本地安装**：`npm run setup` 会探测 Python 3.10+、安装 RMBG 依赖、预热 BRIA RMBG 2.0（`bria-rmbg`）模型，并注册本地 Imvia Layer 插件。

## 版本历史与更新规则

后续发布会继续在本 README 维护版本记录。每个版本会说明新增功能、重要修复、兼容性要求及必要的升级步骤。

### v0.1.0 — 首个可安装版本

- 发布 Codex Desktop 本地插件与右侧工作台的一体化安装流程。
- 提供可见会话拆分、任务队列、透明 PNG 回传、RMBG 最终处理和多图画布总览。
- 提供插件模板、安装脚本、开源许可证与 GitHub 发布说明。
- 安装器支持 Windows 与 macOS：自动记录本机可用的 Python 命令，后续拆分任务会复用该命令执行 RMBG 处理。
- ImageGen 定向修复固定原生画布并使用 mapping 提取原生 `content_region`；BRIA 预处理保持原始宽高比并输出高分辨率透明 PNG；框选尺寸只负责无限画布中的显示与定位。

## 一次安装

前置条件：Codex Desktop、Node.js 20+、Python 3.10+。Windows 与 macOS 均支持；macOS 请先通过 [python.org](https://www.python.org/downloads/macos/) 或 Homebrew 安装 Python 3.10+。`npm run setup` 会自动下载 RMBG 的 Python 依赖和 BRIA RMBG 2.0 模型，首次运行需要联网。RMBG 2.0 权重按 BRIA 的 CC BY-NC 4.0 许可提供，仅限非商业使用；商业部署需取得授权。

```sh
git clone <你的 GitHub 仓库地址>
cd <克隆或解压后的项目目录>
npm run setup
```

`npm run setup` 是唯一的安装命令：它会先安装前端依赖，再安装 RMBG 依赖和 BRIA RMBG 2.0 模型，最后注册本地插件。该命令必须完整成功才会注册插件：若 Python、RMBG 依赖或模型下载失败，安装会停止并给出原因，不会留下半安装插件。完成后重启 Codex Desktop（或新建任务），在对话中发送：

```text
[@imvia-layer](plugin://imvia-layer@personal) 打开工作台
```

工作台会在当前任务的右侧浏览器打开。上传图片、框选拆分项并点击“拆分”后，任务会以可见消息进入当前对话；结果 PNG 会回传到工作台。用户无需手动运行开发服务、打开 `127.0.0.1` 地址、安装额外插件或了解 MCP/会话桥接机制。

## 仅更新插件

工作台源码更新后，在下载目录运行：

```sh
npm run install:codex-plugin
```

然后重启 Codex Desktop 以重新加载插件清单。

## 项目内容

- `src/`：React 工作台界面与状态逻辑。
- `layer-review-mcp-server.mjs`：MCP 服务，负责从 Codex 打开右侧工作台。
- `plugin-template/`：可移植插件模板；安装时会自动写入本机路径，不含作者个人目录。
- `scripts/`：工作台启动、PNG 最终处理、插件安装和初始化脚本。
- `requirements-rmbg.txt`：UI 组件去背景使用的 RMBG Python 依赖。

运行时输出会写入 `output/`，该目录被 Git 忽略，不会随仓库发布。

## 许可证与发布

本项目采用 [MIT License](LICENSE)。发布 GitHub 前，请把 `<你的 GitHub 仓库地址>` 替换为实际地址，并按 [GitHub 发布说明](docs/GITHUB_RELEASE.md) 完成检查。
