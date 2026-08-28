# 快速定向类别块

这些是对不可变 v3.1 `prompt-templates.md` 基础块的补充。每次只选择下列**恰好一个类别**；不得复制、改写或替代 v3.1 规则。

## subject

保留：目标人物、角色、商品或主体及其已见边缘。移除：其他对象与背景。仅可在 v3.1 evidence-limited repair envelope 内补全被遮挡的连续主体边界；强调 locked visible anchors 不得移动或重绘。期望键色 `#00FF00`。硬失败：主体身份/姿态漂移、主体外重绘、锚点变异、边缘泄漏或缺少边界连通键区。

## text

保留：目标文字、数字、字形轮廓和原有排版。移除：非目标文字、图标及背景。只可在 repair envelope 内修复遮挡造成的笔画连续性；locked visible anchors（字符、基线、字距、位置）优先锁定。期望键色 `#00FF00`。硬失败：`TEXT_OR_LOGO_MUTATED`、错字、字体/字距/坐标变化、文本外重绘、无键区。

## brand_ui

保留：品牌标志、CTA、价格牌、徽章、图标组及其独立 UI 边界。移除：无关装饰和背景。只允许补齐 evidence 支持的 UI 遮挡缝隙；locked visible anchors（logo、按钮文案、圆角、对齐）绝不改变。期望键色 `#00FF00`。硬失败：`TEXT_OR_LOGO_MUTATED`、`UI_BUNDLING_ERROR`、品牌色或布局漂移、锚点变异、无键区。

## decoration_prop

保留：被选中的装饰物、道具与其可见形状。移除：其他装饰、主体、文字及背景。只允许在 repair envelope 内延续已证实的轮廓或材质；locked visible anchors（可见端点、轮廓转折、相对位置）必须保持。期望键色 `#00FF00`。硬失败：发明装饰、整资产重绘、越出 envelope、遮挡关系错误、无键区。

## effect

保留：选中光效、辉光、粒子或烟雾的可见效果。移除：非目标效果和全部实物资产。只可在 evidence 支持的 envelope 中衔接连续效果；locked visible anchors（亮点、光向、交叠边缘）必须锁定。期望键色 `#000000`，合成仅 Screen/Add。硬失败：发明效果、错误混合模式、效果泄漏、锚点漂移、无边界连通黑色键区。

## background

保留：目标背景区域及必要的被遮挡连续背景。移除：前景主体、文本、品牌 UI、装饰和效果。只可在 evidence-limited repair envelope 内进行背景补全；locked visible anchors（地平线、纹理接缝、固定结构）优先且不可移动。期望键色 `#00FF00`。硬失败：`BACKGROUND_LAYOUT_DRIFT`、前景残留、未证实补画、结构/注册错误、无键区。
