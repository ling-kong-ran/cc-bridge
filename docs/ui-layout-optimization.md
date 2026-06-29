# UI 布局优化记录

本文记录当前 ccb-gui UI 布局的观察、问题和后续优化方向，供后续迭代参考。

## 当前布局概览

当前界面是典型的三栏工具型布局：

```text
顶部 Titlebar
├─ 左侧 Sidebar
│  ├─ 竖向导航 rail
│  └─ 会话历史 / 运行设置 / 状态信息
├─ 中央 Chat 主区域
│  ├─ 消息流
│  └─ 输入区
└─ 右侧 Workspace 面板
   ├─ Files
   ├─ Changes / Review
   └─ Members
```

整体方向是对的：左侧负责会话与运行上下文，中间负责对话，右侧负责工作区辅助信息。但之前几个区域的信息层级略混乱，容易让界面显得“挤”和“别扭”。

## 已完成的优化

### 1. 顶部 Titlebar 简化

问题：顶部 `[CCB] Chat` 与左侧导航中的品牌和 Chat 入口重复；顶部 `Model` 与输入区的 model pill 重复。

已调整：

- 删除顶部 `[CCB] Chat`。
- 删除顶部 `Model`。
- 保留顶部更有用的上下文信息：`Session / CLI`。
- 左侧栏折叠时，顶部补充显示连接状态、Cost、Tokens。
- 顶部状态信息左对齐，右侧按钮组继续靠右。

目标效果：顶部更像状态栏，而不是装饰性标题栏。

### 2. 右侧 Workspace 面板初步整理

问题：原来的右侧面板顶部是 `Files Review Members + ×`，所有控制都挤在一行，`×` 也更像弹窗关闭而不是 pane 收起。

已调整：

- 右侧面板宽度从 `280px` 提升到 `320px`。
- 右侧面板背景改为渐变，与左侧栏区分。
- Header 改为两层：标题行 + tab 行。
- 面板标题显示为 `Workspace`。
- 关闭按钮从 `×` 改为 `›`，表达“收起面板”。
- `+` 按钮只在 Members tab 显示。
- Files tab 增加当前工作目录显示。
- Tab active 状态更明显，使用绿色弱强调。

目标效果：右侧面板更像稳定的 workspace 辅助区域，而不是临时挤出来的一列。

### 3. 左侧 History 重复标题移除

问题：左侧 sidebar 顶部有一个 `History`，历史列表上方又有一个 `History`，重复且占用空间。

已调整：

- 删除 sidebar 顶部多余的 History header。
- 保留历史列表区域的 `History + Search`。

目标效果：减少左侧视觉噪音，把空间还给会话列表。

### 4. Runtime Settings 摘要动态化

问题：运行设置折叠时只显示固定文案 `CWD / Remote`，信息价值不高。

已调整：

- 折叠状态下显示当前工作目录项目名，例如 `ccb-gui`。
- 如果选择了远程目标，则显示 `项目名 / 远程目标名`。
- cwd 变化、恢复会话、选择目录、远程目标变化时同步更新摘要。

目标效果：折叠面板本身就能表达当前运行上下文。

### 5. 最新流式回复结束后立即 Markdown 渲染

问题：最新会话文本有时在流式输出结束后仍是纯文本换行渲染，刷新页面后才变成正确 Markdown。

原因：流式过程中使用 `renderStreamingText()` 避免半截 Markdown 误渲染，但部分结束路径没有在清理 turn 状态前重新执行最终 `renderMd()`。

已调整：

- 增加 `finalizeCurrentAssistantMarkdown()`。
- 在 `process_ended / session_lock_changed` 和 `result` 路径清理前，把流式块合并为最终内容并调用 `renderCurrentState(true)`。

目标效果：最新回复完成后无需刷新页面即可显示 Markdown。

## 后续可继续优化的方向

### 1. 右侧 Workspace 面板继续完善

当前右侧面板已经比之前清晰，但仍有进一步优化空间：

- Files / Changes / Members 每个 tab 内部增加自己的小标题和描述。
- Files tab 增加文件搜索或过滤。
- 文件树支持展示当前选中文件数量。
- Review tab 可以增加 staged / unstaged 的视觉分组。
- Members tab 可以把“添加成员”按钮移动到内容区顶部，而不是 header。
- 右侧面板展开/折叠状态持久化到 GUI 设置。
- 支持拖拽调整右侧面板宽度。

### 2. 左侧 Sidebar 信息密度优化

可考虑：

- Runtime Settings 默认保持收起，但新建会话前更突出。
- 当前 cwd 摘要可以进一步使用路径缩写，例如 `.../D/ccb-gui`。
- 历史会话分组可以增强当前项目高亮。
- 左下角状态栏在侧栏折叠时完全迁移到顶部状态摘要。

### 3. 欢迎页更偏工作流

当前欢迎页有 ASCII 品牌和 Getting Started，风格统一但功能密度可以更高。

可考虑改成启动面板：

```text
Claude Code Bridge

Start
[New Session]

Recent
- 当前项目最近会话
- 其他最近会话

Runtime
CWD: D:/工作文档/ccb-gui
CLI: ccb
Model: Sonnet 4.6
```

目标是让空白状态不仅好看，也能直接引导下一步操作。

### 4. 输入区进一步减重

当前输入区包含：

```text
>>  model pill  attach  textarea  send/stop
```

后续可考虑：

- 弱化或移除 `>>`。
- 把 model / cli / cwd 变成输入框下方的小型状态行。
- 附件、引用、slash command 的预览区域保持统一高度和视觉样式。
- Stop / Send 按钮位置和尺寸进一步统一。

### 5. Settings 页面长期重构

Settings 内容越来越多，顶部 tabs 仍可用，但长期可以考虑改成双栏：

```text
左侧 settings nav       右侧 settings content
General                 Interface Settings
Environment             Agent Defaults
Remote
Integrations
Memory
```

短期可以先统一：

- card 最大宽度；
- 表单 label 对齐；
- 按钮组位置；
- Remote / MCP / Agents 列表密度。

### 6. Artifacts / Scheduled 与整体布局统一

Artifacts 和 Scheduled 已经有独立 shell，但可以继续统一：

- header 高度；
- toolbar 高度；
- card 圆角和边框；
- empty state 样式；
- kicker / title / description 的间距。

## 验证注意事项

验证 ccb-gui 时不要直接运行默认：

```bash
python server.py
```

默认启动会清理旧 server，可能影响用户正在运行的 GUI 实例。

验证时应使用隔离端口：

```bash
python -c "import asyncio, server; asyncio.run(server.run_server(18000, cleanup_old_servers=False))"
```

端口号每次递增即可，例如 `18000`、`18001`、`18002`。

## 提交 / 推送约定

- 每完成一个独立优化点，先验证，再本地 commit。
- 不要每次 commit 后立即 push。
- 等全部改完并由用户验收后，再统一 push 到 `master`。
