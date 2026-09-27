# V2 工作流验收记录

日期：2026-09-28
分支：`codex/workbench-v2-in-place-psd`
Task 10 快照：`7a23f70`
验收范围：Task 11 显式旧版迁入、批次/候选/采用/PSD 自动整链；不代表所有宿主或人工视觉门槛完成。

## 自动化

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 旧版选区按百分比转成源图像素坐标；`ui` 映射 H5；输入对象不被修改 | 通过 | `node --test src/v2/legacy-import.test.mjs`，4/4 |
| 来源身份或尺寸不匹配时中止；recenter 结果保持未采纳且不可审核 | 通过 | 同上，显式负例断言 |
| 两个旧版拆分定义→V2 批次回执→逐项建议→明确采用→PSD 导出与读取 | 通过 | `node --test src/v2/workflow.test.mjs`，实际 Node 导出器、托管 Python RGBA 解码器和 PSD 回读 |
| 任何未采用层阻止导出 | 通过 | 整链 fixture 在任何采用之前及只采用一项后分别断言拒绝 |
| V2 全部模块及相关 V1 dispatch/ZIP 存储回归 | 有一项既有失败 | 汇总运行 183 项，182 通过、1 失败；失败是 `src/mcp-bridge-widget.test.mjs:46` 对 `presentation.preview` 的旧期望，与当前既有 `title/scrollToBottom` 实现不一致。该文件未由本任务修改，此失败此前已记录 |
| 托管 Python 全集 | 有一项既有失败 | 共 95 项，94 通过；`test_prepare_targeted_imagegen_canvas.py:158` 的错误文案期望遗漏已实现的 `codex_rgba_repair`。与本任务无关，未改旧断言 |
| Vite production build | 通过 | `node node_modules/vite/bin/vite.js build`，1847 模块构建成功 |
| Diff 空白检查 | 通过 | `git diff --check` |

## 需要人工/宿主环境的门槛

| 验收项 | 状态 | 说明 |
| --- | --- | --- |
| 本次迁入界面的真实浏览器交互、桌面/移动截图和控制台检查 | 未完成 | 本会话未提供 Browser skill/plugin；项目依赖中没有 Playwright/Puppeteer。尝试调用桌面 CUA 检查时在 30 秒超时并重置运行环境。SSR 组件测试和生产构建不能替代真实交互验收 |
| 真实 Codex 宿主确认弹窗→消息送达→批次处理 | 未完成本轮复验 | 用户此前确认 V2 测试消息已收到；本次自动整链使用受控确认回执，没有调用真实生成模型或冒称真实宿主流程已验收 |
| 海报与 H5 各一次真实模型生成 | 未执行 | 本轮只运行 fixture，不生成图片；需要用户实际任务授权，不把 fixture 结果当成真实模型成功 |
| Photoshop 打开 PSD，逐层显示/隐藏并检查透明度、中文名、顺序、原位坐标 | 未完成 | 代码侧已验证 PSD 签名、图层 RGBA/坐标/名称及 composite；这不是 Photoshop 桌面验收 |

## 旧版迁入的边界

迁入按钮点击后才读取本机既有 `imvia-layer-project` 键；不自动扫描目录或其他存储键。用户需选项目并重新选择原始图。当前 V1 的来源标识是 `文件名:字节数:修改时间:Data URL 长度`，不是密码学内容摘要；迁入同时检查源图尺寸。V2 会对重新上传的 PNG 计算新的 SHA-256。V1 项目记录中的旧候选缺少 V2 attempt/dispatch 身份，故仅保留为未采纳历史计数，仍须重新拆分和人工审核；不把它们塞入 V2 当前候选列表。只含旧版“已确认”状态但没有对应 PNG 的，另记为无资产状态标记而非候选图像。钢笔标注也不自动转换。

## 本轮复现命令

```sh
node --test src/v2/*.test.mjs src/mcp-bridge-widget.test.mjs src/mcp-bridge-resource.test.mjs src/foreground-dispatch.test.mjs src/poster-job-store.test.mjs src/pen-editor-state.test.mjs
node scripts/run-managed-python-tests.mjs
node node_modules/vite/bin/vite.js build
git diff --check
```

开发隔离分支为 `codex/workbench-v2-in-place-psd`，Task 10 可回退快照为 `7a23f70`；本次不自动推送或合并。
