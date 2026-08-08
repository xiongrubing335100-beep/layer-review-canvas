# GitHub 发布说明

## 发布前检查

```powershell
npm install
npm test
npm run build
```

确认以下内容不会提交：

- `output/` 中的原图、框选预览、任务计划和 PNG 结果；
- `.env`、日志、本地 RMBG 模型缓存；
- 任何用户路径、访问令牌或 Codex 对话内容。

## 创建 GitHub 仓库

1. 在 GitHub 创建空仓库，例如 `imvia-layer`。
2. 将本项目作为初始内容推送到该仓库。
3. 在仓库 About 中说明：这是需要 Codex Desktop、Node.js 和 Python 的本地 UI 拆图工作台。
4. 将 [README.md](../README.md) 中的 `<你的 GitHub 仓库地址>` 替换为实际仓库地址。

## 用户安装方式

用户克隆或下载 ZIP 后，在项目根目录运行：

```powershell
npm install
npm run setup
```

初始化会完成三件事：

1. 安装 `rembg[cpu]` 与 `isnet-general-use` 模型；
2. 在用户目录注册 Imvia Layer 本地插件；
3. 写入该用户下载目录对应的运行配置。

之后重启 Codex Desktop，并在新任务中发送：

```text
[@imvia-layer](plugin://imvia-layer@personal) 打开工作台
```

插件不会使用发布者机器上的固定目录；每个用户的安装脚本都会写入自己的下载位置。
