# Imvia Layer

Imvia Layer 是一个运行在 Codex Desktop 右侧浏览器面板中的 UI 拆图工作台。它把每次拆分请求作为可见消息提交到当前 Codex 对话，由 Codex 生成并返回 PNG 结果。

## 一次安装

前置条件：Codex Desktop、Node.js 20+、Python 3.10+。

```powershell
git clone <你的 GitHub 仓库地址>
cd ui-layer-review-canvas
npm install
npm run setup
```

`npm run setup` 会安装 RMBG 依赖和 `isnet-general-use` 模型，再复制并注册本地 Imvia Layer 插件。完成后重启 Codex Desktop（或新建任务），在对话中发送：

```text
[@imvia-layer](plugin://imvia-layer@personal) 打开工作台
```

工作台会在当前任务的右侧浏览器打开。上传图片、框选拆分项并点击“拆分”后，任务会以可见消息进入当前对话；结果 PNG 会回传到工作台。

## 仅更新插件

工作台源码更新后，在下载目录运行：

```powershell
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
