<img src="https://raw.githubusercontent.com/kylelee/AutoTile/main/logo.png" align="right" width="76"/>

[![release](https://img.shields.io/badge/Release_v18.0-blue?style=for-the-badge)](https://github.com/kylelee/AutoTile/releases)
![](https://img.shields.io/github/license/kylelee/AutoTile?style=for-the-badge)
![](https://img.shields.io/badge/GNOME-42--50-e04196?style=for-the-badge&logo=gnome&logoColor=white)

[English](README.md) | **简体中文**

# AutoTile

AutoTile 是一个为 GNOME Shell 提供**自动平铺窗口管理**的扩展。它深受 **[Omarchy](https://omarchy.org) 4.0** 以及 **[Hyprland](https://hyprland.org)** 窗口布局器的启发：正因如此，我们 fork 了优秀的 **[Tiling Shell](https://github.com/domferr/tilingshell)** 项目（在此特别感谢原作者 [Domenico Ferraro](https://github.com/domferr)），并在其基础上扩展了大量功能，让 GNOME 用户也能获得接近 **Omarchy Linux** 的自动平铺窗口管理体验（衷心感谢 DHH 与 Omarchy 的开发者们带来的审美、灵感、哲学以及卓越的代码贡献）。

欢迎提出各种改进意见和想法 —— 请直接提交 [issue](https://github.com/kylelee/AutoTile/issues)！🙌

AutoTile 兼容 GNOME Shell **42 至 50**，支持 X11 与 Wayland，即使多个显示器使用不同的缩放比例也能正常工作 —— 同时保留了 Tiling Shell 原有的全部能力：

- 🤩 Windows 11 的**贴靠助手**与 Windows PowerToys 的 **FancyZones**
- ⚙️ 通过**内置编辑器**管理、编辑、创建和删除布局
- 💡 布局并非死板固定 —— 需要时可以让窗口**横跨多个磁贴**
- 🚀 自动适配你的 GNOME 主题，实现**无缝融入**！

<div align="center">
  <a href="https://github.com/kylelee/AutoTile/releases" >
      <img src="https://img.shields.io/badge/Get%20it%20on-GitHub-4A86CF?style=for-the-badge&logo=Gnome&logoColor=white"/>
  </a>
</div>

<img src="https://github.com/kylelee/AutoTile/blob/main/doc/horiz_summary.jpg" align="center"/>

<details>
  <summary><span align="center">点击查看视频总览</span></summary>

https://github.com/user-attachments/assets/2905f0a1-ecd4-47b5-a6bc-59f91716e685
</details>

## ✨ 核心亮点

- 🪟 **新窗口自动平铺** —— 开启自动平铺后，每个新窗口都会被自动放入最合适的空闲磁贴。当当前聚焦的窗口已被平铺时，新窗口会紧邻它打开，其后的所有窗口会依次前移并自动重新平铺 —— 跨显示器、（可选）跨工作区级联进行。参见[自动平铺](#自动平铺)。
- 🖥️ **跨显示器、跨工作区移动窗口与焦点** —— 使用 <kbd>SUPER</kbd>+<kbd>←</kbd>/<kbd>↑</kbd>/<kbd>↓</kbd>/<kbd>→</kbd> 在磁贴间移动聚焦窗口，可以跨显示器，在屏幕边缘还会移动到相邻工作区。另有专用快捷键可在任意方向上移动窗口焦点。参见[键盘平铺](#键盘平铺)。
- 🔁 **交换相邻磁贴窗口** —— 将窗口移向已被占用的磁贴时会自动交换两个窗口的位置（跨显示器同样有效），空出的磁贴也会被自动回填。参见[键盘平铺](#键盘平铺)与[自动平铺](#自动平铺)。
- 🧲 **窗口不脱离布局** —— 开启自动平铺的布局约束后，拖拽窗口将无法使其脱离平铺：随手一放会被吸回布局中，整个网格始终保持从左上角开始的连续铺满状态。参见[自动平铺](#自动平铺)。

## 使用方法

| [平铺系统](#平铺系统)                 | [贴靠助手](#贴靠助手)         | [选择布局](#选择布局)         | [选择多个磁贴](#选择多个磁贴) |
| :------------------------------------ | :---------------------------- | :---------------------------- | :---------------------------- |
| [布局编辑器](#布局编辑器)             | [智能调整大小](#智能调整大小) | [键盘平铺](#键盘平铺)         | [边缘平铺](#边缘平铺)         |
| [每个工作区的布局](#每个工作区的布局) | [自动平铺](#自动平铺)         | [平铺右键菜单](#平铺右键菜单) | [导入导出布局](#导入导出布局) |
| [智能圆角](#智能圆角)                 | [窗口建议](#窗口建议)         | [间距](#间距)                 | [ALT+TAB 集成](#alttab-集成)  |
| [一起提升](#一起提升)                 |                               |                               |                               |

### 键盘平铺

使用键盘快捷键（<kbd>SUPER</kbd>+<kbd>←</kbd>/<kbd>↑</kbd>/<kbd>↓</kbd>/<kbd>→</kbd>）在磁贴间移动聚焦窗口。快捷键均可在首选项中自定义！

移向已被占用的磁贴时会交换两个窗口的位置（跨显示器同样有效），而移动方向上的空闲磁贴则会被直接占用。在最后一个显示器的边缘继续按 左/右 会将窗口移动到相邻的工作区 —— 启用动态工作区时会自动新建 —— 落点磁贴被占用时同样会执行交换。

还提供了专用的**窗口焦点**移动快捷键（<kbd>ALT</kbd>+<kbd>←</kbd>/<kbd>↑</kbd>/<kbd>↓</kbd>/<kbd>→</kbd>/<kbd>Page_Down</kbd>/<kbd>Page_Up</kbd>），无需碰鼠标即可遍历整个窗口网格。均可在首选项中自定义。

此外还有更多快捷键命令，均可在首选项中自定义：将聚焦窗口**伸展（span）**到上/下/左/右的磁贴、**取消平铺**聚焦窗口、**将窗口移到屏幕中心**、**高亮聚焦窗口**（最小化其余窗口），以及向前/向后**循环切换布局**。下一个/上一个焦点导航可以选择在边缘处回绕，方向性焦点也可以限定只遍历已平铺的窗口。

[Tile with Keyboard Video](https://github.com/user-attachments/assets/6f8dedbb-2733-41d8-8a94-0fa62dffb915)

> 可在首选项中启用/禁用

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 平铺系统

抓起并移动窗口时，按住 <kbd>CTRL</kbd> 键即可显示平铺布局（可在首选项中更换按键）。移动到某个磁贴上时它会高亮，松开窗口即可将其放置到高亮的磁贴中。

[tiling_system.webm](https://github.com/kylelee/AutoTile/assets/14203981/a45ec416-ad39-458d-9b9f-cddce8b25666)

> 本扩展的平铺系统同样实现了 Windows PowerToys 的 FancyZones！

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 贴靠助手

抓起并移动窗口时，屏幕顶部会出现贴靠助手。将窗口移近即可激活它；保持抓取状态，把鼠标移到心仪的磁贴上，松开窗口即可将其平铺到所选磁贴！

[snap_assistant.webm](https://github.com/kylelee/AutoTile/assets/14203981/33511582-fa92-445e-b1ba-8b08f9a8e43a)

> 贴靠助手的灵敏度可以在首选项中自定义。

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 选择布局

点击面板上的 AutoTile 指示器即可显示所有可用布局，点击即可选用。如果你有多个显示器，该布局会被应用到每一个显示器上。

[layout_selection.webm](https://github.com/kylelee/AutoTile/assets/14203981/f4956a34-64e3-4c24-b177-8f9b08fcc45c)

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 选择多个磁贴

布局并非死板固定，你也可以一次选择多个磁贴！只需在使用平铺系统时按住 <kbd>ALT</kbd>（可在首选项中更换按键）。

[multiple_selection.webm](https://github.com/kylelee/AutoTile/assets/14203981/92b29130-260c-479d-9237-bf5c87427e52)

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 布局编辑器

|      分割磁贴       |             垂直分割磁贴              |      删除磁贴       |                                                          保存、关闭编辑器或打开菜单                                                          |
| :-----------------: | :-----------------------------------: | :-----------------: | :------------------------------------------------------------------------------------------------------------------------------------------: |
| <kbd>左键单击</kbd> | <kbd>左键单击</kbd> + <kbd>CTRL</kbd> | <kbd>右键单击</kbd> | 点击面板上的 AutoTile 图标 <img src="https://github.com/kylelee/AutoTile/assets/14203981/13e27ec1-6a5d-420f-a87f-8f3df0b34c92" width=96 />。 |

[layout_editor.webm](https://github.com/kylelee/AutoTile/assets/14203981/c6e05589-69d9-4fa3-a4df-61ee875cf9e1)

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 智能调整大小

相邻的已平铺窗口可以一起调整大小！

[Resizing tiled windows](https://github.com/kylelee/AutoTile/assets/14203981/da4ef97e-cdbb-4981-a8ab-9ca8cd23d63d)

> 可在首选项中启用/禁用

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 边缘平铺

将窗口移到屏幕边缘即可平铺。

[Screencast from 2024-06-22 22-12-22.webm](https://github.com/kylelee/AutoTile/assets/14203981/6e5a2ba9-cd38-44bb-b791-51e41e07f7a0)

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 平铺右键菜单

右键单击窗口即可使用自动平铺按钮和贴靠助手！自动平铺按钮可以基于当前布局将窗口平铺到最左或最右的空闲磁贴；"移动到最佳磁贴"按钮则会建议平铺到离屏幕中心最近的空闲磁贴。

<p align="center"><img src="https://github.com/user-attachments/assets/d660779a-7549-4858-b149-59edad076483" width=520/></p>

<p align="center">观看演示视频了解实际效果！</p>

[Screencast from 2024-07-13 18-21-57.webm](https://github.com/kylelee/AutoTile/assets/14203981/8fd79faa-a476-4b55-b7c6-6329e4b59519)

> 最初的想法是在悬停最大化按钮时显示贴靠助手（就像 Windows 11 那样）。遗憾的是，GNOME 不允许我们处理最大化按钮的悬停事件，也不允许在其附近添加新按钮……

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 每个工作区的布局

可以为每个显示器的每个工作区单独选择喜欢的布局。

[per-workspace](https://github.com/user-attachments/assets/41226602-5950-47d1-bbf6-3d7ff3e265fb)

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 自动平铺

新建窗口时，会根据其他窗口的平铺情况和当前布局，自动将其移动到最合适的磁贴。该功能默认关闭，可在首选项中开启。

当当前工作区的所有显示器都已占满时，窗口还可以被自动平铺到后续工作区的第一个空闲磁贴（并切换视图过去），仅向前搜索、不回绕；启用动态工作区时会先自动创建新工作区 —— 这由"自动平铺时搜索其他工作区"首选项控制。

启用自动平铺后，若当前聚焦的窗口已被平铺，新窗口会被放置在紧跟聚焦窗口的磁贴上：其后的已平铺窗口沿全局"从上到下、从左到右"的顺序整体前移一格，跨显示器级联 —— 在启用"自动平铺时搜索其他工作区"首选项时还会跨工作区级联。若聚焦窗口未被平铺（或找不到合格的锚点窗），新窗口会按严格的"从上到下、从左到右"阅读顺序落在第一个空位上：从当前工作区开始，仅向前跨工作区搜索、不回绕；启用动态工作区且所有工作区都已占满时，会追加新工作区并让新窗口落在其 0 号磁贴。若放置无法完成（例如目标磁贴被不可移动的窗口占用），新窗口会保持浮动并记录日志，不会执行任何"最近空位"或环回搜索。

当已平铺的窗口被关闭或移走时，其工作区中空出的磁贴会被自动回填：同工作区的已平铺窗口沿全局"从上到下、从左到右"的顺序前移 —— 跨所有显示器级联 —— 剩余的空位会依次从右侧的工作区拉取窗口补齐，使每个工作区的每个显示器都始终保持从左上角开始的连续平铺。拉取候选还包括右侧的工作区中不在任何磁贴上的窗口：这些未平铺的窗口只会在其所在工作区的所有已平铺候选之后才被拉取，填补剩余的空位。这由"从下一个工作区回填空出的磁贴"首选项控制（默认启用），且键盘移动/交换命令绝不会触发该行为。关闭已平铺的窗口触发补位后，键盘焦点会自动落到补位窗口上，即占据被关闭窗口原来磁贴的那个窗口。

启用该首选项后，拖拽将无法使窗口脱离平铺：随手放置会被吸回平铺中；即使是不按平铺系统按键的普通拖拽落在了其他磁贴上，窗口也会回到原来的磁贴 —— 就像原生地把已平铺窗口移动到另一个显示器时，窗口会回到原来的显示器和磁贴一样。要在磁贴之间移动窗口，必须使用平铺系统放置（按住激活键）或键盘移动/交换命令：只有关闭窗口，或在磁贴间移动/交换窗口，才会改变布局排列。如果你想重新通过拖拽让窗口浮动，关闭该首选项即可。

[automatic_tiling](https://github.com/user-attachments/assets/76abc53f-2c6d-47ab-bee3-bbcdd946f2a1)

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 导入导出布局

_AutoTile_ 支持将布局导入/导出为 JSON 文件。你可以不使用内置图形编辑器、直接创建自己的自定义布局，或与他人分享你的布局！如果你想了解布局文件内容的更多细节，请查阅官方[文档](./doc/json-internal-documentation.md)。

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 智能圆角

在 GNOME 中，不同窗口可能拥有不同的圆角半径。由于无法得知窗口的圆角，围绕聚焦窗口绘制边框一直是个难题。现有扩展都只是用固定的静态值绘制边框，观感大打折扣。AutoTile 会在运行时**动态**计算聚焦窗口的圆角半径；而且如果你安装了自定义圆角的扩展或其他工具，聚焦窗口的边框圆角也会随之自适应！同样可在扩展首选项中启用/禁用。

<p align="center">
<img src="https://github.com/user-attachments/assets/cfaca5f9-d9b2-4739-9426-1aebb5f33c29" width=304 />
<img src="https://github.com/user-attachments/assets/e8e68abff-66e5-4b85-a6ce-0bd2da7be166" width=332 />
</p>

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 窗口建议

通过平铺系统、贴靠助手或屏幕边缘将窗口放入磁贴后，你会看到用于填充其余磁贴的其他窗口建议。打开的窗口太多？没问题！当建议无法全部放下时，会出现一个**可滚动列表**，方便快速导航。实际效果：

https://github.com/user-attachments/assets/fbf68458-199d-490b-90cf-3e976d5b511b

_可以自行选择开启或关闭吗？_

可以。在扩展首选项的"窗口建议"区域，你可以分别为平铺系统、贴靠助手和屏幕边缘启用/禁用窗口建议：三者可以任意组合，按你的需要和喜好个性化配置。

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 间距

为平铺布局留出呼吸空间：**内间距（inner gaps）**在已平铺窗口之间加入间隔，**外间距（outer gaps）**让窗口与显示器边缘保持距离。两者均可在首选项中调整，并在不同缩放比例的显示器之间正确换算。

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### ALT+TAB 集成

首选项提供一个选项，可以把所有已平铺的窗口作为一个整体条目加入 <kbd>ALT</kbd>+<kbd>TAB</kbd> 切换器：选中它即可一次性提升全部已平铺窗口，你的平铺布局不会再被一堆浮动窗口挡在后面。

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

### 一起提升

当某个已平铺窗口被提升时，其余已平铺窗口会随之一同进入前台，保持平铺布局在视觉上的完整。可在首选项中开关。

<p align="right"><b>回到功能目录</b> <a href="#使用方法">⬆️</a></p>

## 安装

本扩展发布在 [GitHub](https://github.com/kylelee/AutoTile) 上！你可以从那里安装，也可以手动安装。通过 [GitHub Releases](https://github.com/kylelee/AutoTile/releases) 安装可以始终获得最新更新。

<div align="center">
  <a href="https://github.com/kylelee/AutoTile/releases" >
      <img src="https://img.shields.io/badge/Get%20it%20on-GitHub-4A86CF?style=for-the-badge&logo=Gnome&logoColor=white"/>
  </a>
</div>

### 手动安装

下载最新的 [release](https://github.com/kylelee/AutoTile/releases)，解压下载的压缩包，将文件夹复制到 `~/.local/share/gnome-shell/extensions` 目录，然后重新加载 GNOME Shell（例如注销后重新登录）。之后即可启用扩展：

```bash
/usr/bin/gnome-extensions enable autotile@kylelee.github.io
```

### 通过源码安装

克隆仓库后，使用封装脚本完成构建与安装（脚本会自动检查所需的构建工具）：

```bash
./scripts/build.sh     # 按需安装依赖 + 构建 dist/（GNOME 45+）与 dist_legacy/（42-44）
./scripts/install.sh   # 安装到 ~/.local/share/gnome-shell/extensions
```

直接使用 `npm` 等价命令也可以：`npm i`、`npm run build`、`npm run install:extension`。开发工作流参见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

之后重启 GNOME Shell，例如注销再登录，或在 X11 下按 `alt-F2` 输入 `r` 原地重启，然后启用扩展即可。也可以通过命令行启用：

```bash
/usr/bin/gnome-extensions enable autotile@kylelee.github.io
```

查看扩展日志可以运行：

```bash
journalctl --follow /usr/bin/gnome-shell
```

查看首选项日志可以运行：

```bash
journalctl -f -o cat /usr/bin/gjs
```

### 卸载 AutoTile

卸载前请先禁用扩展，然后再删除。通过命令行禁用可以运行：

```bash
/usr/bin/gnome-extensions disable autotile@kylelee.github.io
```

## 参与贡献

欢迎提交 [issue](https://github.com/kylelee/AutoTile/issues/new/choose) 和 [Pull Request](https://github.com/kylelee/AutoTile/pulls)！

### 如何新增快捷键

1. 编辑文件 `resources/schemas/org.gnome.shell.extensions.autotile.gschema.xml`，新增一个带有名称、默认空值和摘要（summary）的 key。例如，名称为 `highlight-current-window`、摘要为 `Minimize all the other windows and show only the focused window` 时，添加如下内容：

```xml
<key type="as" name="highlight-current-window">
  <default><![CDATA[['']]]></default>
  <summary>Minimize all the other windows and show only the focused window</summary>
</key>
```

2. 编辑文件 `src/settings/settings.ts`，在静态常量列表的末尾添加一个新的静态常量（例如[这里](https://github.com/kylelee/AutoTile/blob/8a1f21620d5d8f1db7c5b6b45c0ef0c483801420/src/settings/settings.ts#L138)）。静态常量必须是一个与 key 名称相同的字符串；常量名必须以 `SETTING_` 开头，并使用 key 名称的大写下划线形式。例如 key 名称为 `highlight-current-window` 时，向文件中添加：

```js
static SETTING_HIGHLIGHT_CURRENT_WINDOW = 'highlight-current-window';
```

3. 编辑文件 `src/keybindings.ts`，添加一个与 key 同名的新信号（signal）。请务必先写 `Meta.Display.$gtype`，后跟你需要的所有参数类型（如果有的话）。例如，key 名称为 `highlight-current-window` 且不需要任何参数时，添加：

```js
'highlight-current-window': {
    param_types: [Meta.Display.$gtype], // Meta.Display,
},
```

4. 思路是：当用户按下快捷键时，Keybinding 单例类会发出该信号。为此，编辑文件 `src/keybindings.ts`，在快捷键被使用时发出信号（例如[这里](https://github.com/kylelee/AutoTile/blob/8a1f21620d5d8f1db7c5b6b45c0ef0c483801420/src/keybindings.ts#L223)）。例如 key 名称为 `highlight-current-window` 时，添加：

```js
Main.wm.addKeybinding(
    Settings.SETTING_HIGHLIGHT_CURRENT_WINDOW,
    extensionSettings,
    Meta.KeyBindingFlags.NONE,
    Shell.ActionMode.NORMAL,
    (display: Meta.Display) => {
        this.emit('highlight-current-window', display);
    },
);
```

如有需要，可以在 `display` 之后添加所有你需要的参数。

5. 请确保在扩展被禁用时移除快捷键。为此，编辑文件 `src/keybindings.ts` 来移除快捷键（例如[这里](https://github.com/kylelee/AutoTile/blob/8a1f21620d5d8f1db7c5b6b45c0ef0c483801420/src/keybindings.ts#L318)）。例如，key 名称为 `highlight-current-window` 时，添加：

```js
Main.wm.removeKeybinding(Settings.SETTING_HIGHLIGHT_CURRENT_WINDOW);
```

6. 现在，你可以在任何地方通过连接该信号来监听快捷键。推荐的位置是 `src/extension.ts` 文件（例如[这里](https://github.com/kylelee/AutoTile/blob/8a1f21620d5d8f1db7c5b6b45c0ef0c483801420/src/extension.ts#L264)）。例如，key 名称为 `highlight-current-window` 时，添加：

```js
this._signals.connect(
  this._keybindings,
  'highlight-current-window',
  (kb: KeyBindings, dp: Meta.Display) => {
      // handle the keybinding and perform the actions you want
      // to happen when the keybinding is used by the user
      ...
  },
);
```

7. 编辑文件 `src/prefs.ts`，允许用户选择自己偏好的快捷键。只需在 `keybindings` 数组中新增一项即可（例如在[这里](https://github.com/kylelee/AutoTile/blob/8a1f21620d5d8f1db7c5b6b45c0ef0c483801420/src/prefs.ts#L639)添加新条目）。例如，key 名称为 `highlight-current-window` 时，添加：

```js
[
    Settings.SETTING_HIGHLIGHT_CURRENT_WINDOW,
    _t('Highlight focused window'),
    _t('Minimize all the other windows and show only the focused window'),
    false,
    false,
],
```

第一个元素是设置项的 key，第二个元素是标题，第三个元素是描述。第四个是布尔值，供首选项记录该设置是否已被设置。最后一个是布尔值，表示该设置是否必须显示在主页面上；否则只能通过展开可用快捷键列表来访问。不过，用户已设置过的快捷键始终会显示在主页面。
_请使用与第 1 步 schema 中相同的描述。_

如果遇到任何问题、有疑问或卡住了，欢迎随时提交一个包含现有成果的 pull request，我很乐意帮忙！

## Vagrant

```
The private key to connect to the machine via SSH must be owned
by the user running Vagrant. This is a strict requirement from
SSH itself. Please fix the following key to be owned by the user
running Vagrant:
```

如果你使用的是 NTFS 文件系统，则需要把密钥移出去：

```
mv /path/to/box/virtualbox/private_key $HOME/.ssh/vagrant_key
ln -sr $HOME/.ssh/vagrant_key /path/to/box/virtualbox/private_key
```

## 🙏 致谢

- **[Tiling Shell](https://github.com/domferr/tilingshell)**（作者 [Domenico Ferraro](https://github.com/domferr)）—— AutoTile fork 自这个出色的扩展，非常感谢原作者的杰出工作！如果你喜欢 AutoTile，请考虑通过 [Ko-fi](https://ko-fi.com/domferr) 或 [Patreon](https://patreon.com/domferr) 支持原作者。
- **[Omarchy](https://omarchy.org)**（DHH 与 Omarchy 的贡献者们）—— 衷心感谢你们带来的审美、灵感、哲学与卓越的代码。AutoTile 的目标就是让 GNOME 用户获得接近 Omarchy 的自动平铺体验。
- **[Hyprland](https://hyprland.org)** 及其窗口布局器 —— 平铺行为的持续灵感来源。
