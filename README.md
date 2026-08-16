# Imvia Layer

Imvia Layer 是运行在 Codex Desktop 右侧浏览器面板中的本地 UI 拆图工作台。它将拆分请求作为当前 Codex 对话中的可见消息提交，并把透明 PNG 结果回传到画布；不会为此添加水印、遥测、设备指纹、隐藏许可检查或联网停用机制。

主要能力包括：多图无限画布、框选与贝塞尔钢笔标注、可见任务队列、透明 PNG 回传与预览，以及基于 BRIA RMBG 2.0 的高分辨率去背景和 PNG 二次编辑。

## 前置条件

- Codex Desktop（用于安装和打开本地插件）。
- Node.js 20+ 与 npm（可在 macOS Terminal 或 Windows PowerShell 中使用）。
- Python 3.10+（安装器会按当前平台探测可用的 Python）。
- 首次安装时的网络连接，用于下载 npm 依赖、Python 依赖和 BRIA RMBG 2.0 模型。

## 安装

### 使用 Git 克隆（macOS / Windows）

在 macOS Terminal 或 Windows PowerShell 中运行：

```sh
git clone https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas.git
cd imvia-layer-review-canvas/imvia-ui-layer-review-canvas
npm run setup
```

`npm run setup` 是唯一安装命令：它安装前端依赖，在插件目录创建可持久复用的 `.python-runtime`，再准备 RMBG 模型并注册本地 Imvia Layer 插件。Python 依赖来自提交的 universal `requirements-rmbg.lock`，pip 以 `--require-hashes` 校验完整依赖树；若 Python、依赖或模型下载失败，上一个有效 runtime 不会被覆盖，修复报错后重新运行该命令即可。

### 使用 ZIP（macOS / Windows）

下载并解压仓库 ZIP，进入解压目录中的 `imvia-ui-layer-review-canvas`，然后运行：

```sh
npm run setup
```

## 启动、重连与更新

安装完成后重启 Codex Desktop，或新建一个 Codex 任务，然后发送：

```text
[@imvia-layer](plugin://imvia-layer@personal) 打开工作台
```

如果 Codex 已在运行但工作台没有出现，先新建任务或重启 Codex Desktop，再次发送上述命令。更新此仓库的代码后，在应用目录运行：

```sh
npm run install:codex-plugin
```

随后重启 Codex Desktop 或新建任务以加载更新后的插件。

## 卸载

退出 Codex Desktop 后，在应用目录运行：

```sh
npm run uninstall:codex-plugin
```

该命令会删除本机插件目录及其托管 `.python-runtime`（macOS：`~/plugins/imvia-layer`；Windows：`%USERPROFILE%\plugins\imvia-layer`），并只移除 marketplace 中的 `imvia-layer` 条目；不会删除 RMBG 模型缓存或其他插件。重新运行 `npm run setup` 可完整重建。

## 常见问题

- **找不到 Python 或版本过低：** 安装 Python 3.10+，确认 `python3 --version`（macOS）或 `python --version`（Windows）可用后重新运行 `npm run setup`。
- **首次安装下载失败：** 检查网络连接和磁盘空间；依赖或模型下载成功前安装不会完整完成，网络恢复后重试即可。
- **找不到 `npm`：** 安装 Node.js 20+，关闭并重新打开 Terminal 或 PowerShell，再运行安装命令。
- **插件命令无响应：** 确认在 `imvia-ui-layer-review-canvas` 中完成了 `npm run setup`，然后重启 Codex Desktop 或新建任务。

## 许可证与商业授权

本项目为 source-available 软件，适用 [Imvia Layer Personal & Commercial License](LICENSE)。个人非商业使用免费；商业使用需事先取得付费授权。第三方组件、模型和素材仍分别受其各自许可证约束；特别是 BRIA RMBG 2.0 的许可不会因本项目的商业授权而被覆盖或自动授予。

商业授权请通过 [青木](https://www.xiaohongshu.com/user/profile/5cdb80ac000000001601466b) 的主页联系。更多归属与第三方说明见 [NOTICE.md](NOTICE.md)。

© 2026 [青木](https://www.xiaohongshu.com/user/profile/5cdb80ac000000001601466b)。个人非商业使用免费；商业使用需事先取得付费授权。
