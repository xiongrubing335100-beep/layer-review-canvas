# V2 PSD 编码兼容性记录

日期：2026-09-27。阶段：Task 3 编码验证，不代表最终 PSD 导出功能已上线。

- Node：v24.19.0；ag-psd 精确版本 31.0.2。
- 使用 typed-array imageData 工厂，无 node-canvas、无 Photoshop 原生文字或矢量。
- 4 项测试通过：Normal 合成与透明留白、越界拒绝、PSD 中文重名/图层顺序/偏移/原始 RGBA 往返、大图/层数/内存预算拒绝。
- `16×12` fixture 写出实际 `8BPS` version 1，原位层像素与 composite 读回一致。
- 代表性样本 `1562×3396`、10 个 `400×300` 半透明区域层：编码并完整解码 123ms，529558 bytes，进程峰值 RSS 114128KiB；预算估算208818112 bytes。该单次样本不是最坏情况性能保证。
- 样本仅在内存生成，没有持久化临时图片或用户内容。
- 编码关闭 trimImageData，保留选区尺寸及 left/top，不裁 alpha 包围盒。

安装方式：当前 shell 无 npm，使用已提供的 pnpm 临时执行 npm@11.6.0，安装 `ag-psd@31.0.2 --save-exact --ignore-scripts`；未全局安装。锁文件原有平台 libc 元数据已保留。

尚未完成：导出快照/HTTP 下载、真实候选整链、Photoshop 实际打开、生产尺寸峰值覆盖。后续由 Task 10/11 验证，不能以本报告替代。
