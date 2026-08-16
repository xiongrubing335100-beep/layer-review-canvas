# GitHub 发布说明

## 发布前检查

```sh
npm install
npm test
npm run build
```

确认以下内容不会提交：

- `output/` 中的原图、框选预览、任务计划和 PNG 结果；
- `.env`、日志、本地 RMBG 模型缓存；
- 任何用户路径、访问令牌或 Codex 对话内容。

## 创建 GitHub 仓库

1. 在 GitHub 创建或重命名为空仓库 `imvia-layer-review-canvas`，地址为 `https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas`。
2. 将本项目作为初始内容推送到该仓库。
3. 在仓库 About 中说明：这是需要 Codex Desktop、Node.js 和 Python 的本地 UI 拆图工作台。
4. 保持根目录 [README.md](../../README.md) 的克隆地址和应用目录 `imvia-ui-layer-review-canvas` 与发布仓库一致。
5. 以根目录 [LICENSE](../../LICENSE) 的 Imvia Layer Personal & Commercial License 发布；本项目为 source-available，个人非商业使用免费，商业使用必须事先取得付费书面授权。不得以发布操作覆盖第三方组件或 BRIA RMBG 2.0 的各自许可证。

## 用户安装方式

用户克隆或下载 ZIP 后，进入应用目录运行：

```sh
git clone https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas.git
cd imvia-layer-review-canvas/imvia-ui-layer-review-canvas
npm run setup
```

ZIP 用户解压后进入其中的 `imvia-ui-layer-review-canvas`，运行同一条 `npm run setup`。该命令同时适用于 macOS Terminal 与 Windows PowerShell。

初始化会完成三件事：

1. 探测 Python 3.10+，安装 `rembg[cpu]` 并下载、校验 BRIA RMBG 2.0（`bria-rmbg`）模型；
2. 在用户目录注册 Imvia Layer 本地插件；
3. 写入该用户下载目录、插件启动 Node.js 命令和 Python 调用方式对应的运行配置。

之后重启 Codex Desktop，并在新任务中发送：

```text
[@imvia-layer](plugin://imvia-layer@personal) 打开工作台
```

插件不会使用发布者机器上的固定目录；每个用户的安装脚本都会写入自己的下载位置。Windows 与 macOS 都使用同一条 `npm run setup` 命令；发布前请至少在两种系统各完成一次“克隆、安装、打开插件、RMBG 拆分”的干净环境验证。

合并发布 PR 后，再在 GitHub 将仓库名称切换为 `imvia-layer-review-canvas`；随后更新本地 `origin` 并确认 README、克隆地址和链接都指向最终 URL。
