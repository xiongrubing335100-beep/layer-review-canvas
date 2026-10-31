<p align="center">
  <img src="imvia-ui-layer-review-canvas/public/imvia-logo.png" alt="Imvia Layer Logo" width="128" height="128">
</p>

# Imvia Layer

Imvia Layer 是运行在 Codex Desktop 右侧浏览器面板中的本地 UI 拆图与海报分层工作台。它将拆分请求作为当前 Codex 对话中的可见消息提交，并把透明 PNG 结果回传到画布；不会为此添加水印、遥测、设备指纹、隐藏许可检查或联网停用机制。

当前 V2 提供框选拆分、贝塞尔钢笔选区、画布总览、同文档会话桥、透明 PNG 预览与原位栅格 PSD 导出。它已经是 **Codex Desktop 本地插件**（插件标识 `imvia-layer`），不是独立云端网站，也不代表已上架官方插件商店。

## V2 界面与使用步骤

以下为 2026-10-30 从本地 V2 实际页面拍摄的截图，示例使用已保存的拆分任务；截图不是所有图片均能成功拆分的承诺。

### 1. 打开工作台并上传

![V2 上传入口](docs/screenshots/v2-start.jpg)

安装后，在 Codex 对话中选择 Imvia Layer 插件并发送“打开工作台”。选择“上传海报原图拆分”或“上传 H5 原图拆分”，上传需要处理的图片。

### 2. 添加类别并框选

![V2 原图、选区和图层列表](docs/screenshots/v2-workbench.jpg)

点击图层列表的加号添加拆分项，选择类别，在原图上框选完整主体。需要精细控制时打开编辑器，使用钢笔路径并填写处理要求。替换原图会保留类别与要求，旧图结果不会混入新图导出。

### 3. 提交并查看结果

确认会话桥显示“已连接”，点击单项“拆分”或“全部拆分”。如 Codex 宿主出现发送确认弹窗，确认一次即可；消息到达当前对话后执行，无需再输入“执行”。不要在生成过程中重复提交。

![V2 拆分结果预览](docs/screenshots/v2-result.jpg)

完成后打开结果查看透明背景、细边和镂空，下载 PNG。全部当前拆分项完成后可下载 PSD。PSD 为按原图位置放置的栅格图层，不是可编辑文字或矢量图层。已有结果下载不要求会话桥在线，截图中的“未连接”表示当前没有在线桥。

### 当前发布范围

这是 V2 预览版源码更新。复杂主体可能出现形状变化或原图对齐失败，未通过当前校验的结果不会作为原位 PSD 图层交付；尚不保证所有拆分任务成功。原始生成素材独立返回的统一机制仍待完善。会话桥被宿主关闭后，可能需要在原对话中重新打开；短暂断线与卡片关闭不是同一种情况。

## 前置条件

- Codex Desktop（用于安装和打开本地插件）。
- Node.js `^20.19.0 || >=22.12.0` 与 npm（推荐 Node.js 22 LTS；可在 macOS Terminal 或 Windows PowerShell 中使用）。
- Python 3.10+（安装器会按当前平台探测可用的 Python）。
- 首次安装时的网络连接，用于下载 npm 依赖、Python 依赖和 BRIA RMBG 2.0 模型。

## 安装

### 使用 Git 克隆（macOS / Windows）

在 macOS Terminal 或 Windows PowerShell 中运行：

```sh
git clone https://github.com/xiongrubing335100-beep/layer-review-canvas.git
cd layer-review-canvas/imvia-ui-layer-review-canvas
npm run setup
```

`npm run setup` 是唯一安装命令：它先检查 Node 版本，以 `npm ci` 同步锁定的 JavaScript 依赖并生成全新的 production `dist/`，然后在插件目录创建可持久复用的 `.python-runtime` 与 `.node-runtime`，准备 RMBG 模型并注册本地 Imvia Layer 插件。任一阶段失败都不会继续注册。Python 依赖来自提交的 universal `requirements-rmbg.lock`，pip 以 `--only-binary=:all:` 和 `--require-hashes` 校验完整 wheel 依赖树。只有 Python runtime 的 staging、venv、pip、probe 或 publish 失败会保留并继续使用上一个有效 runtime；模型预热发生在 runtime 发布之后，预热失败会停止插件注册，但不会回滚已经验证的 runtime。修复报错后重新运行该命令即可。

### 使用 ZIP（macOS / Windows）

在仓库首页点击 **Code → Download ZIP**，下载并解压默认分支的 ZIP，进入解压目录中的 `imvia-ui-layer-review-canvas`，然后运行：

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
npm run update
```

随后重启 Codex Desktop 或新建任务以加载更新后的插件。

## 卸载

退出 Codex Desktop 后，在应用目录运行：

```sh
npm run uninstall:codex-plugin
```

该命令会删除本机插件目录及其托管 `.python-runtime`、`.node-runtime`（macOS：`~/plugins/imvia-layer`；Windows：`%USERPROFILE%\plugins\imvia-layer`），并只移除 marketplace 中的 `imvia-layer` 条目；不会删除 RMBG 模型缓存或其他插件。重新运行 `npm run setup` 可完整重建。

## 常见问题

- **找不到 Python 或版本过低：** 安装 Python 3.10+，确认 `python3 --version`（macOS）或 `python --version`（Windows）可用后重新运行 `npm run setup`。
- **首次安装下载失败：** 检查网络连接和磁盘空间；依赖或模型下载成功前安装不会完整完成，网络恢复后重试即可。
- **找不到 `npm` 或 Node 版本不支持：** 安装符合 `^20.19.0 || >=22.12.0` 的 Node.js（推荐 Node.js 22 LTS），关闭并重新打开 Terminal 或 PowerShell，再运行安装命令。
- **插件命令无响应：** 确认在 `imvia-ui-layer-review-canvas` 中完成了 `npm run setup`，然后重启 Codex Desktop 或新建任务。

## 许可证与商业授权

本项目为 source-available 软件，适用 [Imvia Layer Personal & Commercial License](LICENSE)。个人非商业使用免费；商业使用需事先取得付费授权。第三方组件、模型和素材仍分别受其各自许可证约束；特别是 BRIA RMBG 2.0 的许可不会因本项目的商业授权而被覆盖或自动授予。

商业授权请通过 [青木](https://www.xiaohongshu.com/user/profile/5cdb80ac000000001601466b) 的主页联系。更多归属与第三方说明见 [NOTICE.md](NOTICE.md)。

© 2026 [青木](https://www.xiaohongshu.com/user/profile/5cdb80ac000000001601466b)。个人非商业使用免费；商业使用需事先取得付费授权。
