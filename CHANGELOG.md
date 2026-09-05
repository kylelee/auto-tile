# 更新日志（Changelog）

本文件摘要记录 AutoTile 自首次提交以来的全部升级。

**AutoTile fork 自 [Tiling Shell](https://github.com/domferr/tilingshell) v17.3**（基线提交 `a66960f`，2026-09-03，UUID 原为 `tilingshell@ferrarodomenico.com`）。此后所有演进均在本库完成；下文各条目如无特别说明，均指**相对 fork 基线（上游 Tiling Shell 17.3）的差异**。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> AutoTile 使用独立 UUID `autotile@kylelee.github.io` 与独立设置 schema，可与 Tiling Shell 共存安装；从上游迁移需重新配置一次。

## [18.0] - 2026-09-05

首个 AutoTile 独立版本（数字版本 100，GNOME Shell 42–50）。

### 新增：自动平铺（Auto-tiling）核心增强

上游 17.3 已有基础自动平铺（新窗口落入最近空位）；AutoTile 在此之上新增：

- **焦点后续插入**：焦点窗口已平铺时，新窗口插入到焦点窗口之后的空位，其后的窗口沿全局自上而下、自左而右顺序链式前移，并跨显示器级联（`insertionPlanner` 纯逻辑模块，含单测）
- **工作区溢出平铺**：当前工作区所有显示器满员时，新窗口自动平铺到其他工作区的首个空位；动态工作区开启时可先创建新工作区并切换过去（新设置 `enable-autotiling-other-workspaces`，默认开启）
- **空位自动回填**：平铺窗口关闭或移走后，同工作区窗口链式前移补位，缺口再从右侧工作区逐个拉回窗口填补，使每个工作区始终自左上角连续填满（新设置 `enable-auto-fill-freed-tiles`，默认开启；`freeTileFillPlanner` / `freeTileFiller` / `autoFillSuppression` 纯逻辑模块，含单测）
- **拖拽布局锁定**：回填开启时，拖拽无法再让窗口脱离平铺——散乱落点自动吸回布局；窗口只能在 tile 间移动（平铺系统投放或键盘命令），关闭该设置可恢复自由拖拽浮动
- **幽灵窗免疫**：自动贴砖候选资格纯模块（`autoTileCandidate`，含单测）+ 首帧复查闸门，避免对合成器正在销毁的"幽灵窗口"贴砖
- **关窗聚焦**：平铺窗口关闭后自动聚焦最近的平铺窗口（`focusOnCloseManager`，激活前带目标存活探针）
- 除上述两个新设置项外，未引入其他设置键；上游全部既有设置行为不变

### 新增：键盘平铺操作增强

- **占位交换（Swap）**：键盘移动窗口到已占用 tile 时交换两个窗口的位置，支持跨显示器（交换目标解析器 + 跨屏安全交换执行器）
- **跨显示器智能移动**：优先落位空闲 tile；显示器按行序扫描、以 2D 中心最近距离搜索空位；`SUPER+UP` 在上方显示器有空位时优先进 tile 而非最大化；被 GNOME 内置快捷键跨屏移动的窗口自动重新平铺
- **跨工作区方向移动**：窗口移到最末显示器的屏幕边缘时进入相邻工作区（动态工作区开启时可自动创建）
- **方向焦点跨工作区穿透**：方向焦点切换在工作区边缘时落到相邻工作区的窗口

### 新增：布局导入校验与自愈

- 布局 JSON 导入崩溃级校验器（`layoutValidation` 纯逻辑模块，含单测）：拒绝非法 JSON、越界/空 tile、空布局等并给出明确原因
- 读取时自愈无效布局：过滤空布局、守护最后一个 tile 与布局，损坏的 `layouts-json` 不再导致运行时崩溃

### 新增：本地化

- **中文翻译体系重构**：翻译目录改为 `zh_Simplified` / `zh_Traditional`，新增 `moCatalog` 运行时解析——`zh_CN`/`zh_SG` 映射到简体、`zh_TW`/`zh_HK` 映射到繁体（绕开 GNOME Shell 扩展进程的系统 gettext 限制），并全面修订译文
- 新增设置项的中英文案与 .po 同步再生成

### 新增：工程化

- **更名 AutoTile**：独立 UUID、schema、资源路径与发布渠道
- **脚本链**：`scripts/build.sh`（依赖检查 + 双构建）、`install.sh`（安装后自动尝试启用扩展）、`test.sh`（lint + build + 全部单测一体化验证）、`check_extension.sh`（extensions.gnome.org 上传前 shexli 检测，含绕过 shexli 0.2.1 段错误的分块分析器）、`build.sh --package`（构建并打包发布 zip）
- **测试基线**：11 个自断言测试文件（纯 `node:assert`，无测试框架依赖），覆盖贴砖规划器、插入规划器、布局校验、信号处理、边框资格、clamp、moCatalog、建议关闭策略、窗口组等纯逻辑模块
- **文档**：中英双语 README、AGENTS.md 开发指南、代码评审报告、布局 JSON 内部格式文档

### 修复（相对基线）

- 新窗口与跨显示器移动窗口的贴砖几何漂移：等待 frame rect 稳定后复查审计，`findNearestTile` 中心坐标污染修正
- 首帧时序：工作区溢出投放与首帧复查避开窗口首个渲染帧，配合幽灵窗免疫闸门
- 信号泄漏：grab 结束释放 stage 输入处理器；每个退出点断开 per-grab 信号；`SignalHandling.disconnect(obj)` 现在断开该对象的全部信号
- 方向焦点按键越界索引防护
- 设置导入失败时从导入前备份恢复（而非二次重置导致数据丢失）；D-Bus 接口导出失败自动回滚
- 偏好设置空快捷键数组导致崩溃的防护
- 焦点窗口边框：空窗/隐藏窗/非普通窗口不绘制；尺寸门槛提升至 ≥2px；尺寸跟踪定时器的销毁与显示器切换守卫
- 窗口建议覆盖层被动关闭不再抢占焦点，交互前增加窗口存活检查
- 替换不存在的 `Math.clamp` 为 `src/utils/clamp.ts` 工具（含单测）

### 默认配置变更

- 焦点导航快捷键默认值：`focus-window-right/left/up/down` → `<Alt>+方向键`，`focus-window-next/prev` → `<Alt>Page_Down/Page_Up`
- 默认布局集内置 5 个布局（新增 50/50 双栏首选布局 `'27079420'` + 上游 Layout 1-4），`selected-layouts` 默认值同步；偏好设置"恢复默认布局"按钮产出一致
- 版本迁移链适配 18.0：全新安装不再重复执行 17.3 兼容迁移

### 其他

- 版权与作者信息更新为 Kyle Lee（2026）

## [17.3] - 2026-09-03（fork 基线）

上游 [Tiling Shell](https://github.com/domferr/tilingshell) v17.3 原样导入（提交 `a66960f`），包含其全部功能：平铺系统（FancyZones）、Windows 11 式 Snap Assistant、布局编辑器、边缘平铺、键盘平铺移动（`SUPER+方向键`）、方向/前后焦点快捷键、窗口边框（智能圆角）、Alt+Tab 平铺窗口分组、右键菜单集成、每工作区布局、内外间隙（gaps）、窗口建议（Windows Suggestions）、raise-together、Vagrant 多版本测试环境等。详见上游仓库。

感谢上游作者 [Domenico Ferraro](https://github.com/domferr) 与 [Tiling Shell](https://github.com/domferr/tilingshell) 项目、[Omarchy](https://omarchy.org) 与 [Hyprland](https://hyprland.co) 带来的灵感。
