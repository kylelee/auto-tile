# AutoTile 代码库全面评审与重构意见

STATUS: final
评审日期: 2026-09-04 · 基线: HEAD 204cb0d(GNOME 42-50,TS→GJS,~20.4K LOC)
评审方式: 9 轨并行静态评审 + 可执行验证(lint/build/tests/tsc/node 探针/上游比对),49 项主张全带 file:line 或执行工件证据,另 2 起针对未入账主张的驳斥事件见 §5
会话日志: `.omo/ulw-research/20260904-211703/`(claim-graph、9 份 wave 摘要、验证账本)

---

## 1. 执行摘要

AutoTile 是 **Tiling Shell(domferr/tilingshell)一日龄的直接 fork**(上游仍活跃,已支持 GNOME 50),本地增量集中在自动平铺引擎:`insertionPlanner` / `freeTileFillPlanner` / `freeTileFiller` / `focusOnClose` 等,`tilingManager.ts` 从上游 1355 行膨胀到 2814 行。

代码质量呈**双峰分布**。好的一面达到同类扩展上游水准:纯逻辑 planner 的抽取模式(GI-free + 47 条断言真测试)是本 fork 最好的本地创新;三条全局互斥对自触发回路的重入防御完备;工作空间按对象而非索引追踪;schema 63 键零漂移;GI 进程边界零违规;双构建管线经实验裁决语义安全。坏的一面有一个 P0 级功能性缺陷、一个可致扩展永久无法启用的缺陷链、一个造成四类泄漏的系统性设计缺陷(SignalHandling 按信号名做 key),以及最高频变更文件(26/53 commits)0% 可测试、49 个类型错误被构建静默吞掉、无 CI 的工程基建缺口。

最优先的三件事:① 修 `Math.clamp`(不存在的 API,两条常用路径触发即 TypeError);② 修"删除最后一个 tile → 扩展永久无法启用"链;③ 重构 `SignalHandling` 键控语义(一个根因解掉四类泄漏)。随后按 §6 路线图推进。

---

## 2. 架构评审

### 2.1 成立的部分(证据)

| 结论 | 证据 |
|---|---|
| GI 进程边界纪律 100% 成立:gi:// 导入全部经 src/gi/{ext,prefs,shared}.ts;defaultMenu.ts:295-297 的 Gdk 仅存在于注释(子进程方案刻意规避) | grep 全 src 零违规 [C2] |
| schema↔settings↔keybindings↔prefs 四文件配方零漂移(63 键 = 43+20,全消费) | prefs-build 漂移表 [C30] |
| 双构建管线实验裁决安全:Babel export-strip 对本代码库 25 文件 chunk 语义验证等价;`@esbuild-drop-next-line` 5 站点(layoutSwitcher.ts:23,25,86,88,90)双侧正确且必要(ES2022 useDefineForClassFields 语义) | 实验工件 /tmp/opencode/autotile-legacy/ [C33] |
| planner 抽取模式正确:insertionPlanner(15 场景)/freeTileFillPlanner(12)/autoFillSuppression/signalHandling 等 8 模块纯 node 可测,47/47 断言通过 | lead 实跑 + scripts/test.sh E2E [C11-C14] |
| 重入防御完备:autoFillSuppression/_insertionShiftInProgress/_fillInProgress 三个互斥 + _windowsUnderPlacement 守卫集在所有自触发回路上均有 gate | A2 worker 事件表 [C49 旁证] |
| 工作空间按 Meta.Workspace 对象追踪(__ts_cached.workspace、_isWorkspaceLive),系统性规避动态工作空间重编号 | A2 worker |
| 单例/管理器装配无循环构造;disable 顺序(manager→signals→单例)当前正确 | A2 耦合图 |

### 2.2 问题(按影响排序)

**ARCH-1 tilingManager.ts 是 god-object:2814 行、13 项职责**(信号接线/预览 UI/放置几何/工作空间簿记/键盘移动/插入计划执行/auto-fill 编排/拖拽管线全在一个类),上游同文件仅 1355 行。职责清单与行号见 wave-1-tiling-core.md。后果:0% 可测试(见 §2.3)、+1459 行 fork 增量无法对照上游审计、修改任何一处都在最大文件里做手术。[C48]

**ARCH-2 SignalHandling 按信号名做 key 是四类泄漏的公共根因**(`signalHandling.ts:21` `this._signalsIds[key] = {id, obj}`):同名重连覆盖旧 id(永不断开);且 `tests/signalHandling.test.ts` 场景 4 把覆盖语义固化为"已知契约"— 工具设计假设与使用方式(瞬态重复连接)根本错配。四类现场:①每拖拽泄漏 stage 处理器(tilingManager.ts:778-811 连,grab-end :1076 只断 window);②ATWM 每窗口处理器覆盖(autoTileWindowManager.ts:131-148,destroy 只断最后两条);③RaiseTogether 'raised' 覆盖 + 双断 critical;④多显示器放大:每显示器 manager 各连一份。修复方向:键改为 `(obj, signal)` 二元组或直接以递增 id 记账(pop-shell `Ext.connect` 的 Map<GObject, id[]> 模式)。[C15/C29/C44;4 组独立收敛]

**ARCH-3 污染枢纽阻断测试性**:`settings/settings.ts:1` 的运行时 gi 导入使 15+ 下游模块不可纯 node 测试(AGENTS 四文件配方强制所有消费者经过它);`utils/ui.ts` 把纯几何困在 GI 模块;`tilingLayout.ts` 困住 5 个纯几何函数导致 freeTileFillPlanner 应用端被迫双实现(漂移风险)。[C11/C20]

**ARCH-4 工程门槛缺口**:无 typecheck 步骤(esbuild 不查类型;`npx tsc --noEmit` = 331 个错误:src/ 内 49 个真实类型错误 + @girs 嵌套冲突 282 个;package-lock 不提交使其加剧);tests/ 同时逃出 tsconfig(include 仅 src/**)与 lint(仅 eslint src);runner 未接 npm scripts;无 CI。[C1/C4/C12]

**ARCH-5 其他**:两个 import 环(editor slider↔editableTilePreview;indicator↔defaultMenu↔editingMenu)— 实验未见 legacy 构建破坏,记观察项 [C3];`prefs.ts` 1741 行 9 职责单文件 [C31];四个模块级全局协调量(3 互斥 + 1 放置守卫集)是无文档的隐式协议 [C49 旁证];`Main.wm._prepareAnimationInfo` 私有 API 依赖(tilingManager.ts:1309-1315)横跨 9 个 GNOME 版本仅靠 @ts-expect-error。

### 2.3 外部基准定位(librarian,21 项分级来源)

同类四项目:Tiling Shell(上游,双构建 42-50)、pop-os/shell(ECS + 生成代实体 ID + GLibExecutor 事件批处理)、Forge(i3 式节点树 + queueEvent 220ms 防抖 + freezeRender)、material-shell(已亡于"巨型猴补丁(monkey-patch)+ 单人 + 多版本",告别信自述)。AutoTile 现行"单源双构建"是四家中唯一覆盖 42-50 的活跃路线,方向正确;应采纳的对照模式详见 §4/§6。

---

## 3. 可重用性评审

**核心事实:所有重复均为上游继承,本地增量零复制**[C7/C8;git 溯源 + 上游逐字节比对,lead 3 项抽查坐实]。这改变了重构建议的性质:**重构 = 主动偏离上游**,而上游仍在活跃发版(2026-04 GNOME 50)— 必须先做 fork 战略决策(跟踪 cherry-pick / 定期 rebase / 断开独立演进),否则上游修复无法回流。

### 重复矩阵(摘要;完整 13+7+2 项带 file:line 见 wave-1-reuse-reusability.md)

| 族 | 规模 | 最大项 |
|---|---|---|
| preview 族(~2,981L) | 重复 ~15-20% | blur 生命周期 3×12L 逐字;_recolor 16L 100% 逐字(selectionTilePreview.ts:78-93 ≡ suggestionsTilePreview.ts:137-152,lead diff 坐实);open/close ease 块 ~14 处 ~70% 结构重复 |
| chrome 族(~2,087L) | ~15% | 猴补丁单例骨架 ~35L 85%(windowMenu vs altTab);空位 tile 菜单块 ×3 ~70%;16:9 尺寸常量+注释 ×5 |
| windowBorder(553L) | ~10-12% | position vs size-changed 处理器 ~80% 相同(set_position/set_size 一线之差) |
| tiling 内部 | — | masonry vfunc_allocate 60% 是 computePlacements 复制(含死存储 :171-172 + 遗留 console.log :141,lead 坐实);edgeTiling 四角 snap 三分支为三份近乎逐字重复(:392-459 vs :536-603) |

**重构候选**(scout 排序,收益/风险已评估):P0 级三件 — ① `BlurredTilePreview` 基类(或 utils/theme.ts 助手)合并 blur/recolor/theme-restyle 三组重复(省 ~80-100L,消三向漂移);② masonry `vfunc_allocate` 复用 `computePlacements`(省 ~100L,顺带消灭死存储与调试残留);③ windowBorder 合并双 geometry 处理器为 `_onFrameRectChanged`(省 ~25L)。P1/P2 十二件见 wave 文件。表驱动化 edgeTiling 24× isPointInsideRect(:245-582)为可读性候选(性能无虞,~ms 级/拖拽)。[C8/C10]

---

## 4. 性能评审

GJS 环境(GC 为 Boehm 保守分代;gjs MR !236 实测动画期 60% CPU 花在强制 GC,批量化后 78%→47%)意味着:**高频路径分配与泄漏直接转化为用户可感卡顿**。

| 级 | 发现 | 证据 |
|---|---|---|
| **P0** | 每拖拽泄漏 stage 输入处理器(×每显示器);泄漏的 captured-event 使**非拖拽期平板每次移动也 warp 指针**且随拖拽次数线性放大 | C15;signalHandling.ts:7-9,21 + tilingManager.ts:778-811,1076;4 组独立确认 |
| P1 | 15ms 拖拽 tick 无缓存:workspaceIndex setter(tilingManager.ts:875)→ get_selected_layouts 全量 GVariant 解包(settings.ts:575-601)≈ 66 次 gsettings FFI 读/秒 ×显示器数,拖拽全程持续 | C26 |
| P1 | freeTileFiller 级联每 tile 重算 work-area 几何(freeTileFiller.ts:220-266),典型 5-10 倍冗余 | C17(2 组独立) |
| P1 | 全仓 0 处 `Meta.LaterType`/`get_laters()`、零散 idle_add — **无任何事件合批**;对照 pop-shell GLibExecutor(信号→队列→单 idle 批消费)与 Forge queueEvent(220ms 防抖) | C45 |
| P1 | logger 无门控(logger.ts:10-13 无条件 console.log),freeTileFiller 高频路径直写 journal | C27 |
| P2 | Settings.bind 无 unbind 对等(全仓 7+ 处:selectionTilePreview/snapAssist ×3/edgeTilingManager ×2/indicator/globalState),对象销毁后绑定残留并阻止 GC;monitor 热插拔整体重建时按 M×6 累积 | C28 |
| P2 | O(W×T) 空位搜索嵌套扫描(tilingManager.ts:1574-1696);级联 O(N²) FFI(freeTileFiller.ts:116-238);altTab 弹出双全扫;extension.ts:139 每次启用 new Gio.Settings | C22 |
| 正面 | preview 复用(单实例 show/hide)而非逐次销毁重建;拖拽期 timeout 轮询规避 Wayland grab 信号抑制(forge b504512 实证该抑制存在,轮询是同因同解);"windowBorder 每帧重建 widget"经复核**不成立**(处理器仅 set_position/set_size + 延迟圆角,REFUTED-1) | C45 / REFUTED-1 |

---

## 5. 缺陷清单(P0/P1/P2;全部 file:line;标注验证组数)

### P0 — 用户可见功能损坏

| # | 缺陷 | 位置/证据 | 验证 |
|---|---|---|---|
| 1 | **`Math.clamp` 不存在**(非 ECMAScript API,node/GJS typeof=undefined),4 站点触发即 TypeError:① 单/最右显示器边缘键盘移动(tilingManager.ts:606-613 clamp=true → tilingLayout.ts:403-411)→ 移动静默失效;② suggestions masonry 每 child 分配(masonryLayoutManager.ts:66,204 无条件路径)。**上游同款继承**(上游 clone 4 站点逐字一致,两仓均无 polyfill);fork 未发布故尚无用户踩雷 | C36 | 3 组(bug-hunter 静态 + lead node 执行/调用点 + 上游 grep) |
| 2 | **删除布局最后一个 tile → 扩展永久无法启用**:layoutEditor/slider 允许删最后 tile(layoutEditor.ts:323-343 + slider.ts:255-302)→ 零 tile 布局入库(get_layouts_json 空检查先于 filter,settings.ts:560-572)→ 下次 enable `this._layouts[0].id` TypeError(globalState.ts:210;同族 :93,140,269;defaultMenu.ts:221,238,434)→ 需手动 dconf 重置。settingsExport 导入畸形 JSON 同链可达 | C39←C23+C25 | 3 组 |

### P1 — 边界条件用户可见损坏 / 资源泄漏

| # | 缺陷 | 位置 | 验证 |
|---|---|---|---|
| 3 | stage 处理器每拖拽泄漏(= 性能 P0,根因 ARCH-2) | tilingManager.ts:778-811,1076 | 4 组 |
| 4 | focus-previous 崩溃:`windowList[focusedIdx-1].activate` 在 focusedIdx=-1(焦点窗被过滤)/0+关 wraparound 时 undefined.activate | extension.ts:916-927 | 2 组 |
| 5 | 运行时切 fractional scaling 后 WindowBorderManager 缩放反转:extension.ts:173-175 传 `!fractional` vs :321-323 传 `fractional` | extension.ts | 2 组 |
| 6 | 布局 JSON 导入零验证(13 不变式仅查 2)→ NaN tile 持久化 → 放置静默 abort、窗口滞留(tilingManager.ts:1536);freeTileFiller pull 先 change_workspace 后放置,abort 即滞留错误 ws | prefs.ts:585-612;freeTileFiller.ts:276-283 | 2 组 |
| 7 | settingsExport 导入 = 双重数据丢失(先 reset 后 dconf load,失败再 reset,无备份) | settingsExport.ts:23-40 | 2 组 |
| 8 | ATWM 禁用泄漏每窗口处理器;禁用后旧实例半活态;重新启用后出现双份 | autoTileWindowManager.ts:131-148,70-76 | 3 组 |
| 9 | 3 处 GLib source 未跟踪未取消(idle :1945/:2223、timeout :2456),禁用后仍可触发窗口迁移、复活 GlobalState 而抛错(对照:FreeTileFiller/FocusOnClose 正确) | tilingManager.ts:722-739 | 1 组(机制直接可读) |
| 10 | 原格内普通拖放丢 assignedTile(每 tick 清 :896 + grab-end 早退 :1100 + enforce 不恢复 :1679)→ 逻辑漂浮 → 下次级联视觉重叠;与 README "dragging can no longer un-tile" 承诺矛盾(越格会 revert,同格微移反而不恢复) | tilingManager.ts | 1 组(静态;运行时表感待验) |
| 11 | 智能补位 resize 永不更新邻居 assignedTile → 用户 resize 过的窗口日后被误 revert + 级联 movable 永久退化(只阻挡不参与) | resizeManager.ts:283-364 | 1 组(静态) |
| 12 | 已平铺窗口 F11 全屏 → 占用过滤器不排 is_fullscreen(tilingManager.ts:2484-2493,freeTileFiller.ts:350-357)→ 该 ws 该显示器全部 tile 判满,空位搜索/级联/插入全冻结;freeTileFiller.ts:300-302 注释意图"保一格",几何实现"封整屏" | tilingManager.ts | 1 组(静态) |
| 13 | prefs `get_strv(...)[0].length` 在 dconf 存空数组时 TypeError(对话框开即崩) | prefs.ts:813-816 | 2 组 |

### P2 — 潜在/低频(摘要;完整 25+ 项见 wave 文件)

dbus 半初始化静默(dbus.ts:16-24)· 再启用守卫缺 3 处(extension.ts:169,178,185:resizing/raiseTogether/indicator)· 濒死窗口 ws0 误填充(extension.ts:294-297 `?? 0`)· resize 负坐标钳 0 破坏左/上屏(resizeManager.ts:355-361)· best-tile 距离公式缺括号(overriddenWindowMenu.ts:141-145)· accent-color 裸连接泄漏(windowBorderManager.ts:51;tilingManager.ts:2705)· NODIRECTION 死比较(tilingManager.ts:620,tsc TS2367 三源)· 智能圆角异步竞态(windowBorder.ts:222-227)· indicator stage key-press 泄漏(indicator.ts:241-250)· 快捷键拼接非法 accel(extension.ts:105-107)· defaultMenu JSON.parse 无保护(:312-318)· TileUtils 1px 缝/重叠(:6-13)· max/unmax 循环污染 originalSize · untile 不触发 fill(不对称)· entered-monitor 缺濒死窗口守卫(与 left-monitor 分支不对称)· append-ws 索引竞态 · 双计时器瞬时竞态 · _windowsUnderPlacement 无 finally · edgeTiling 构造 NaN 瞬态 + gnomesupport 版本 shim 类型噪音(建议改构建期分叉)· SettingsOverride 失败路径 · legacy zip 含 gschemas.compiled · mo 表 offset/length 未做边界验证 · 死代码 ~150L(resizeManager.ts:367-450 注释块、tilingLayout openBelow、freeTileOnly 参数、NODIRECTION 分支、planCompaction 仅测试引用等)

### 驳斥记录(证据卫生)

- "windowBorder 每帧销毁重建 4 角 widget" — **不成立**(中继有损;真实成本仅 set + open(),REFUTED-1)
- "insertionPlanner 无测试文件" — **不成立**(tests/insertionPlanner.test.ts 存在,15/15 PASS,REFUTED-2)
- "Settings.connect 返回 -1 致 handler 永不断开" — worker 自查**撤回**(REFUTED-3)

### 强项清单(评审确认的正结论)

destroyed-window 防护总体良好(19 处 _isWindowAlive/get_compositor_private,建议收敛为单 helper)· 重入互斥完备 · 工作空间对象追踪 · 零 schema 漂移 · GI 边界零违规 · 双构建实验安全 · i18n 中文目录解析正确且优雅降级 · update-translations 管线验证可用

---

## 6. 重构路线图(优先级 × 风险 × 工作量;依赖已排序)

### 阶段 0 — 立即修复(1-2 天,全部低风险小改)

| # | 动作 | 依据 | 风险 |
|---|---|---|---|
| 0.1 | 修 Math.clamp:utils 加三参 clamp 助手(或复用 ui.ts:23 模式)替换 4 站点 | P0-1 | 极低(纯替换) |
| 0.2 | get_layouts_json 先 filter 再查空 + layoutEditor/deleteLayout 加"最后 tile"守卫 + 导入层字段级校验 | P0-2 | 低 |
| 0.3 | focus PREV 加边界守卫(focusedIdx<0 / 空表 / index 0 无环绕) | P1-4 | 极低 |
| 0.4 | WBM 构造参数统一 `!fractional`(:321 侧改) | P1-5 | 极低 |
| 0.5 | stage touch/captured 改为 enable 时常驻连接一次(grab 状态守卫),或每 grab 专用 SignalHandling 实例 | P0-3/P1 | 低 |
| 0.6 | settingsExport:导入前先 dump 备份,失败恢复备份而非二次 reset | P1-7 | 低 |
| 0.7 | prefs.ts:813 空数组守卫 + dbus export try/catch | P1-13/P2 | 极低 |

### 阶段 1 — 基建补门(1 周内,先于大规模重构)

| # | 动作 | 依据 |
|---|---|---|
| 1.1 | tests/ 纳入 tsconfig + eslint;`npm test` 接 scripts/test.sh | C12 |
| 1.2 | 加 typecheck 门:tsconfig `skipLibCheck` + `types` 收敛(解 @girs 282 冲突)→ tsc --noEmit 进 scripts 与 CI;分批修 49 个 src 类型错误(真实 API 误用优先:windowBorder.ts:263、keybindings.ts:286) | C1/C4 |
| 1.3 | 最小 CI(node + gettext:lint + typecheck + 测试 bundle;Vagrant 矩阵留手动) | C12 |
| 1.4 | SignalHandling 重构:键改 `(obj, signal)` 复合或 id 记账 + `disconnectAll(obj)` 语义;同步修 4 类使用现场;tests/signalHandling.test.ts 场景 4 契约随之改写 | C15/C29/C44(单点解四类) |
| 1.5 | GLib source 记账(_movingWindowTimerId 模式推广到 :1945/:2223/:2456) | C40 |

### 阶段 2 — 结构性重构(2-4 周,按依赖排序)

| # | 动作 | 依据 | 收益 |
|---|---|---|---|
| 2.1 | **统一存活守卫**:isWindowAlive/safeRaise/safeFocus 单 helper(forge mutter-safe.js 模式),收敛 19 处散落检查 + 补 entered-monitor/建议弹窗缺口 | C45/T-A #329 | 消一类崩溃 |
| 2.2 | **事件合批**:get_laters() 单飞模式(`_pending` 标志)应用于 relayout/占用扫描路径;selected-layouts 加缓存(settings 写时失效);15ms tick 改增量 | C26/C45 | 拖拽期 FFI 降一个量级 |
| 2.3 | **tilingManager 拆分**(god-object):按 13 职责清单切 — 拖拽管线 / 插入执行器 / fill 编排 / 键盘移动 / 预览绘制各自成模块,manager 只做装配;拆分顺序=先抽纯几何(bb291d0 方向移动、edgeTiling 分区表)进 GI-free 模块并补测试(参照 insertionPlanner 先例:planner 抽取→当日内 770L 测试跟上是本仓已验证的节奏) | C48/C13/C11 | 最高 churn 文件进入可测区 |
| 2.4 | **状态一致性修复**(设计层,需配测试):resize 后同步 assignedTile;原格内 drop 恢复 assignedTile 或显式 untile;全屏时清 assignedTile/占用排除 is_fullscreen | C41/C42/C43 | 消级联状态漂移 |
| 2.5 | prefs.ts 按页拆分(Forge 模式),版本门控收进 widget 套件一处 | C31/C45 | 消单文件耦合 |
| 2.6 | 重复矩阵 P0 三件(BlurredTilePreview 基类 / masonry 复用 computePlacements / windowBorder 合并处理器)+ Settings.bind→unbind 对等 | C8/C28 | 消漂移,省 ~200L |

### 阶段 3 — 战略与前瞻(持续)

- **Fork 战略决策**(先于阶段 2 的大规模偏离):建立"上游修复未跟"跟踪(上游 2023-2026 bug 修复 × 本地 +1459 行 diff 的交集审计);明确 cherry-pick/rebase/断开三选一
- GNOME 51 前瞻:tilingManager 平板路径 `Clutter.get_default_backend()`(51 移除)→ `global.stage.context.get_backend()`;disable() async 化;事件控制器迁移
- 性能量化:Sysprof GC/signal-handler 计数器在 dev:wayland 上建立基线(验证路线图 0.5/2.2 两项的收益)
- 死代码清扫(~150L)与文档:四个模块级协调量(3 互斥 + 1 放置守卫集)的协议注释

---

## 7. 证据附录

### 7.1 可执行验证(本会话实际运行)

| 验证 | 结果 |
|---|---|
| `npm run lint` | PASS(0 错误) |
| 6 测试文件 esbuild+node 逐个 + `scripts/test.sh` 全套 | **47/47 断言 PASS;E2E: lint+build+6/6,exit 0** |
| `npm run build` | EXIT=0,dist/ + dist_legacy/ 产出 |
| `npx tsc --noEmit` | **EXIT=2:331 个错误(src/ 49 + @girs 282)**;src 错误清单入观察账本 |
| `node -e typeof Math.clamp` | **undefined**(P0-1 定案) |
| 依赖环检测(Tarjan,70 文件 336 边) | 2 环:editor slider↔editableTilePreview;indicator↔defaultMenu↔editingMenu |
| GI 边界 grep | gi:// 于 src/gi/ 外零命中;Gtk 族于 prefs 外仅注释 |
| git 溯源 | a66960f "first commit" 根提交存在(fork squash 导入) |
| 上游比对(/tmp/opencode/bench/tilingshell) | Math.clamp 4 站点同款;signalHandling.ts 与 gi/prefs.ts 逐字节相同(gjs.ts 仅差 4 行) |
| lead 抽查(10 项:重复块 diff、masonry 死存储、focus PREV、WBM 反转、best-tile 公式、resize 负坐标、deleteLayout 守卫、settingsExport、JSON 链 4 站点、drop-next-line grep) | 全部坐实 |

### 7.2 主张账本摘要

49 项主张(C1-C49):supported 43 · partial 5(C3 环×legacy、C24 append-ws 条件性、C41/C42/C43 静态坐实待运行时表感)· refuted 1(C16,即 REFUTED-1);另有 2 起驳斥事件(REFUTED-2/3)针对未入账主张。每项的观察组数、反证搜索、来源、综合落点见 `.omo/ulw-research/20260904-211703/claim-graph.md`;9 轨原始报告(wave-1-*.md)保留全部 file:line 明细。

### 7.3 缺口(本次静态评审无法定论,需真机)

Math.clamp 两路径的**可见症状**量化(GJS 捕获异常后的表感:静默失效 vs 布局降级)· C41/C42/C43 的运行时表现(各需 dev:wayland ~5 分钟场景)· window-left-monitor 在 unmanage 期的发射时序(mutter 版本依赖)· legacy 构建真机矩阵(gnome44 Vagrant)· `Meta.later_add` 移除版本定谳(get_laters 42-50 可用已确认)· 上游修复未跟清单(fork 战略审计,工作量独立)

### 7.4 方法与来源

9 轨:lead(架构/验证)+ reuse-scout + geometry-auditor + tiling-core(deep 补位)+ perf-attacker(deep)+ bug-hunter(deep)+ prefs-build-surveyor + test-infra-auditor + librarian(外部基准,21 项分级来源:官方 gjs.guide ×5、上游/对照仓库源码 ×4(SHA 钉住)、GNOME GitLab MR ×2、T-A/forge issue 链 ×6、社区 ×4)。外部基准主张(C45)以官方文档与钉住 commit 源码为一手来源;代码类主张以仓库 file:line 为一手来源;两者均可由读者直接复核。

*评审过程完整性记录:2 起 worker 主张经 lead 复核驳斥并留痕(REFUTED-1/2);1 起 worker 自查撤回(REFUTED-3);1 起 lead 早期转写失真已按报告原文重写并在日志中声明。*
