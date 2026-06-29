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

### 6. Workspace tab 内部标题与描述

问题：右侧 Workspace 虽然已有 Files / Review / Members tab，但 tab 内容区缺少各自的小标题和说明，切换后信息层级不够明确。

已调整：

- Files tab 增加 `文件` 标题和“浏览工作目录文件，并可作为附件加入输入框”说明。
- Review tab 增加 `变动` 标题和 Git 分支/文件变更说明。
- Members tab 统一使用 Workspace 面板标题样式，并保留内容区顶部的“拉入成员”按钮。
- 新增统一的 `workspace-panel-head / label / hint` 样式，避免每个 tab 自行维护标题样式。

目标效果：每个 Workspace tab 的用途在内容区内更清晰，右侧面板的信息层级更稳定。

### 7. Review tab staged / unstaged 视觉分组

问题：Review tab 原本把变更文件放在一个列表里，只在下方显示 staged / unstaged stat 文本，暂存区和工作区变更的边界不够清楚。

已调整：

- `/api/review` 在原有 `files` 之外返回 `stagedFiles` 和 `unstagedFiles`。
- Review tab 按 `已暂存` / `未暂存` 分组展示文件列表。
- staged 分组使用绿色弱强调，unstaged 分组使用琥珀色弱强调。
- 没有对应分组内容时显示紧凑 empty state。

目标效果：审查变更时可以更快判断哪些文件已经暂存、哪些仍停留在工作区。

### 8. 右侧 Workspace 面板宽度拖拽

问题：右侧 Workspace 面板固定为 320px，文件名较长或 Review 内容较多时阅读空间不足；但直接放宽固定宽度又会挤压聊天主区域。

已调整：

- Workspace 面板左边缘增加桌面端拖拽热区。
- 面板宽度支持在 280px 到 520px 之间调整，并受视口宽度限制。
- 拖拽过程中禁用过渡和文本选择，避免界面抖动。
- 调整后的宽度保存到 GUI 设置，下次打开后恢复。
- 移动端保持原有抽屉行为，不启用宽度拖拽。

目标效果：右侧面板能按当前工作内容临时扩宽或收窄，同时不破坏三栏布局稳定性。

### 9. 左侧 Sidebar 信息密度优化

问题：左侧 Runtime Settings 收起后路径信息偏长，历史会话分组只靠默认展开表达当前项目，识别不够直接；新建会话前运行设置也不够突出。

已调整：

- Runtime Settings 摘要改为路径缩写，例如 `.../E:/code/cc-bridge`，完整路径保留在 tooltip。
- 当前工作目录对应的历史会话分组增加弱绿色背景、边框和 `当前项目` 标记。
- 历史会话分组中的 cwd 也使用相同路径缩写，减少长路径挤占空间。
- 未启动会话时 Runtime Settings 使用弱绿色引导态，提示用户先确认运行上下文。
- 侧栏折叠时继续只保留导航 rail，连接状态、Cost、Tokens 由顶部状态摘要承接。

目标效果：左侧栏在较窄宽度下仍能快速识别当前运行上下文和当前项目，同时减少长路径造成的视觉拥挤。

### 10. 欢迎页工作流启动面板

问题：欢迎页原本以 ASCII 品牌和 Getting Started 引导为主，视觉统一但信息密度偏低，不能直接表达“从哪里开始”。

已调整：

- 欢迎页改为 `Start / Recent / Runtime` 三块启动面板。
- Start 区保留新建会话主操作，减少空白页到开始操作的距离。
- Recent 区优先展示当前项目最近会话，再展示其他最近会话。
- Runtime 区显示当前 cwd、CLI、model 和 remote 摘要，帮助用户启动前确认运行上下文。
- 移除旧 ASCII art 和 Getting Started 步骤说明，改为更稳定的卡片式结构。
- 移动端下启动面板自动改为单列，避免三列卡片挤压。

目标效果：欢迎页不只是品牌空状态，而是能直接承接“确认上下文、恢复会话、新建会话”的工作流入口。

## 后续可继续优化的方向

### 1. 右侧 Workspace 面板继续完善

当前右侧面板已经比之前清晰，主要优化项已完成。

### 2. 左侧 Sidebar 信息密度优化

当前左侧信息密度的主要优化项已完成。

### 3. 欢迎页更偏工作流

当前欢迎页工作流启动面板已完成。欢迎页现在按 `Start / Recent / Runtime` 组织，优先展示当前项目最近会话，并把 cwd、CLI、model、remote 摘要前置到空状态中。

目标是让空白状态不仅好看，也能直接引导下一步操作。

### 4. 输入区进一步减重

当前输入区轻量化已完成。model pill 已下移到输入框下方状态行，并与 CLI、cwd 摘要统一展示；主输入行聚焦附件、textarea 和 Send/Stop 操作。

### 11. 输入区轻量化

问题：输入区原本把 model pill、附件、textarea、Send/Stop 放在同一行，model 信息挤占输入宽度，按钮纵向堆叠也让底部区域显得偏重。

已调整：

- 输入区增加 `input-shell`，主输入行只保留附件、textarea 和 Send/Stop。
- model pill 下移到输入框下方状态行，与 CLI、cwd 摘要放在同一层级。
- CLI 和 cwd 使用短状态文本展示，完整值保留在 tooltip。
- Send/Stop 改为同一行、相同高度的操作按钮，减少右侧纵向占用。
- 附件按钮改为和 textarea 同高的轻边框按钮，弱化单独图标的悬浮感。
- 移动端保留单行主输入，状态行缩小并自动截断，避免挤压输入框。

目标效果：输入区的主视觉焦点回到文本输入本身，运行上下文退到辅助状态行，同时 Send / Stop / Attach 的尺寸更统一。

### 5. Settings 页面布局细节统一

Settings 页面短期布局统一已完成，顶部 tabs 继续保留为当前的信息架构，不切换到双栏。

已调整：

- Settings 内容区增加统一最大宽度，避免宽屏下卡片横向拉得过散。
- 顶部 tabs 改为轻量 pill 导航，active 状态更接近当前 Workspace / Sidebar 的弱绿色强调。
- Settings card 圆角、边距和表单行间距统一，表单 label 列宽改为更稳定的响应式范围。
- 普通保存按钮、Remote / MCP / Agent 表单按钮的顶部间距和右对齐方式统一。
- Skills / MCP / Agents 列表项从纯分割线改为弱卡片项，列表密度与 Remote targets 更一致。

长期仍可考虑把 Settings 改成左侧 settings nav + 右侧 content 的双栏结构，但当前 tabs 结构已经可继续承载现有内容。

### 6. Artifacts / Scheduled 与整体布局统一

Artifacts 和 Scheduled 已经有独立 shell，但可以继续统一：

- header 高度；
- toolbar 高度；
- card 圆角和边框；
- empty state 样式；
- kicker / title / description 的间距。

## 文件预览浮窗设计

右侧 Workspace 的 Files tab 继续负责文件浏览和定位；当用户鼠标左键点击文本类文件时，不在右侧栏内展开大预览，而是在中央 Chat 主区域上方打开一个可关闭的文件预览浮窗。这样能利用中间区域更宽的阅读空间，同时保留右侧文件列表和底部输入框。

### 目标交互

- 左键点击右侧文件列表中的文本类文件，中央区域弹出文件预览浮窗。
- 如果浮窗已打开，再点击另一个文本文件时复用同一个浮窗并替换内容。
- 非文本文件不进入预览，可保留现有行为或提示“不支持预览”。
- 浮窗可通过右上角 `×` 关闭，也可支持 `Esc` 关闭。
- 底部输入框始终保持可见，引用文件内容后用户可以继续输入问题。

建议形态：

```text
┌──────────────┬──────────────────────────────────────┬──────────────┐
│ 左侧会话列表  │ 聊天内容区域                           │ 右侧文件列表  │
│              │                                      │              │
│              │   ┌──────────────────────────────┐   │              │
│              │   │ filename.py              ×   │   │              │
│              │   │ E:/code/cc-bridge/file.py    │   │              │
│              │   ├──────────────────────────────┤   │              │
│              │   │ 搜索...     1 / 8     ↑ ↓     │   │              │
│              │   ├──────────────────────────────┤   │              │
│              │   │  1  import os                │   │              │
│              │   │  2  def main():              │   │              │
│              │   │  3      pass                 │   │              │
│              │   └──────────────────────────────┘   │              │
│              │                                      │              │
│              │ 输入框保持可见                         │              │
└──────────────┴──────────────────────────────────────┴──────────────┘
```

### 浮窗布局

浮窗固定在中间主区域内部，不做全屏 modal：

- 宽度：中间区域的 88% - 94%。
- 高度：聊天内容区域的 70% - 80%。
- 最大宽度：约 1200px。
- 最小宽度：约 520px。
- 小屏时使用 `calc(100% - 24px)`，高度约 `70vh`。

结构：

```text
文件预览浮窗
├── Header
│   ├── 文件名
│   ├── 文件路径
│   ├── 复制路径
│   ├── 刷新
│   └── 关闭
├── Search bar
│   ├── 搜索输入框
│   ├── 当前匹配 / 总匹配
│   ├── 上一个
│   └── 下一个
└── Content
    ├── 行号
    └── 文件内容
```

第一版不做多文件 tab、拖拽缩放、自动换行开关和大文件分块加载，避免范围过大。

### 文件类型与读取限制

文本文件判断建议后端兜底：

- 按扩展名优先支持 `.txt`、`.md`、`.py`、`.js`、`.ts`、`.tsx`、`.jsx`、`.json`、`.css`、`.html`、`.xml`、`.yaml`、`.yml`、`.toml`、`.ini`、`.env`、`.sh`、`.bat`、`.ps1`、`.sql`、`.csv`、`.log` 等。
- 读取前若发现大量 `\x00`，判定为二进制。
- 优先 UTF-8 解码，失败时可尝试系统编码或直接报错。
- 限制最大预览大小，例如 1MB；超出时提示“文件过大，无法预览”。
- 文件路径必须继续复用现有 workspace/path traversal 防护。

### API 设计

新增接口：

```http
GET /api/file-preview?path=...
```

成功返回：

```json
{
  "ok": true,
  "path": "E:/code/cc-bridge/server.py",
  "name": "server.py",
  "size": 26321,
  "encoding": "utf-8",
  "truncated": false,
  "lines": [
    "import asyncio",
    "import json",
    "",
    "async def handle_client(...):"
  ]
}
```

错误返回：

```json
{
  "ok": false,
  "error": "该文件不是可预览的文本文件"
}
```

### 搜索设计

搜索在前端完成即可，因为文件内容已经加载到浮窗：

- 输入实时搜索。
- 高亮全部匹配。
- 当前匹配使用更强高亮，并滚动到可视区。
- `Enter` 跳到下一个，`Shift + Enter` 跳到上一个。
- `↑` / `↓` 按钮切换匹配项。
- `Esc` 在搜索框中优先清空搜索词；无搜索词时关闭浮窗。

搜索高亮必须基于已 escape 的文本生成，不能直接拼接文件原始内容为 HTML。

### 引用设计

#### 引用单行

每一行 hover 时显示一个轻量按钮：

```text
42  def handle_request(...):        引用
```

点击后插入到底部输入框当前光标位置：

```text
@E:/code/cc-bridge/server.py#L42
```

随后聚焦输入框，并可显示 toast：`已引用第 42 行`。

#### 引用任意选中文本

用户在浮窗内容区拖选一段文本后，选区附近显示浮动按钮：

```text
引用选中内容
```

点击后插入：

````text
引用 E:/code/cc-bridge/server.py#L42-L45:

```text
用户选中的文本
```
````

如果无法可靠推断起止行，则退化为：

````text
引用 E:/code/cc-bridge/server.py:

```text
用户选中的文本
```
````

第一版可以先做“单行引用 + 选中文本引用”。行范围 Shift 选择、列范围精确引用后续再补。

### 前端状态与函数拆分

建议新增状态：

```js
let filePreview = {
  path: '',
  name: '',
  lines: [],
  searchQuery: '',
  searchMatches: [],
  currentMatchIndex: 0,
};
```

建议拆分函数：

```js
openFilePreview(path)
closeFilePreview()
renderFilePreview()
renderFilePreviewHeader()
renderFileSearch()
renderFileLines()
quoteFileLine(lineNumber)
quoteSelectedText()
```

### 安全与边界

必须保留这些约束：

1. 只能预览当前 workspace 允许访问范围内的文件。
2. 不允许 `../` 路径逃逸。
3. 不预览二进制文件。
4. 限制最大文件大小。
5. 前端必须 escape 文件内容、路径和文件名。
6. 搜索高亮不能直接拼未转义内容。
7. 插入输入框的引用文本需要保持路径原样，但展示层仍要 escape。

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
