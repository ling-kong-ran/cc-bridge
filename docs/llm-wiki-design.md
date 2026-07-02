# LLM Wiki 功能设计文档

> 版本：v1.0 — 2026-07-02
> 相关文件：`memory_index.py`, `memory_agent.py` (新增), `ccb_bridge.py`, `static/memory.js`, `server.py`, `static/style.css`, `static/index.html`, `static/i18n/{en,zh}.json`

---

## 1. 背景与目标

### 1.1 问题

- Claude Code 的 auto memory 功能通过 `~/.claude/projects/<sanitized>/memory/` 目录存储记忆文件，支持 LLM 自动读写，但对人类用户来说，记忆文件**不易浏览、无法分类、缺乏可视化结构**。
- 同时，用户在日常使用 ccb-gui 时产生的大量 **Artifact 内容**（代码片段、文档、分析报告）缺少一个"沉淀"入口，无法方便地整理到记忆库中。
- 项目定位为**离线优先工具**，不能依赖第三方 CDN。

### 1.2 目标

将**记忆页面**升级为 "LLM Wiki" —— 一个**兼顾 LLM 可读写和人类可浏览**的知识库系统：

| 目标 | 说明 |
|------|------|
| LLM 可读写 | 记忆文件格式（Markdown + frontmatter）不改动，Claude Code auto memory 仍可正常索引和搜索 |
| 人类可浏览 | 记忆页面新增**树状分类视图**，按目录结构展示，支持展开/折叠 |
| 知识沉淀 | 用户可从 Artifact、聊天记录中一键整理内容到 Wiki（本质是写入 memory 文件） |
| 离线可用 | 零外部 CDN 依赖，所有功能使用本地资源 |

---

## 2. 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │             记忆页 (page-memory)                      │   │
│  │  ┌──────────────┐   ┌──────────────────────────┐   │   │
│  │  │  视图切换栏     │   │                          │   │   │
│  │  │  [列表视图]    │   │  右侧内容区域              │   │   │
│  │  │  [Wiki树视图]  │   │  - 列表视图: 文件列表      │   │   │
│  │  │                │   │  - Wiki树:  文章标题列表   │   │   │
│  │  │  搜索栏        │   │  - 查看文章: Markdown渲染  │   │   │
│  │  │  [搜索...]     │   │                          │   │   │
│  │  │                │   │                          │   │   │
│  │  │  侧边栏         │   │                          │   │   │
│  │  │  (仅Wiki视图)   │   │                          │   │   │
│  │  │  分类树         │   │                          │   │   │
│  │  └──────────────┘   └──────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  (Artifact 存入记忆按钮 — artifacts.js)                     │
└──────────────────────┬──────────────────────────────────────┘
                       │ fetch /api/memory/*
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                        server.py                             │
│  GET  /api/memory/files    → 列出文件                        │
│  GET  /api/memory/search   → 全文搜索                        │
│  POST /api/memory/file     → 读取单个文件                    │
│  POST /api/memory/update   → 创建/更新文件                   │
│  POST /api/memory/delete   → 删除文件                        │
│  POST /api/memory/index    → 重建索引                        │
│  GET  /api/memory/tree     → 返回目录树 (新增)               │
│                                                              │
│  对话注入 (仅一行调用)：                                      │
│  send_message 中 → memory_agent.summarize_memories()         │
└───────────┬───────────────────────────────────────┬──────────┘
            │                                       │
            ▼                                       ▼
┌───────────────────┐  ┌─────────────────────────────────────┐
│  memory_agent.py   │  │  memory_index.py                    │
│  (新增)             │  │  - SQLite FTS5 全文索引              │
│  对话记忆注入编排     │  │  - 文件读写                          │
│                    │  │  - 目录树生成                         │
│  1. search_memory  │  │  - 摘要缓存 (memory_summary 表)      │
│  2. 判断大小        │  └─────────────────────────────────────┘
│  3. 按需调摘要       │
│  4. 组装 <memories> │              │
│                    │              ▼
│  _summarize_if_    │  ┌─────────────────────────────────────┐
│  large() → 查缓存  │  │  ccb_bridge.py                       │
│           → 未命中  │  │  - summarize_memory(content, title)  │
│             调 ccb  │  │    → 启动一轮轻量子进程做摘要          │
└───────────────────┘  └─────────────────────────────────────┘
```

### 2.1 核心设计原则

│ 记忆文件是唯一数据源。记忆文件格式（Markdown + frontmatter）不改动，Claude Code auto memory 仍可正常索引和搜索。

| 设计要点 | 说明 |
|---------|------|
| **零 CDN 依赖** | 项目定位为离线优先工具，Markdown 渲染、搜索、图标全部来自本地已有模块，不加载任何外部资源。 |
| **server.py 不做膨胀** | 对话中自动检索 + 摘要的编排逻辑从 `server.py` 抽出到独立模块 `memory_agent.py`，server.py 中只保留一行调用。 |
| **文件系统即数据库** | 记忆文件存储在 `~/.claude/projects/<sanitized>/memory/` 下，每个 `.md` 文件 = 一篇 Wiki 文章，目录结构 = 分类树。 |
| **LLM 自动感知而非手动推送** | 用户每次发消息时，后端自动检索相关记忆，按需摘要后直接注入到 prompt 前；用户无感知，无需手动操作。 |

---

## 3. 功能详解

### 3.1 视图切换

记忆页新增**视图切换栏**，位于页面顶部：

```
┌─────────────────────────────────────────────────────────┐
│  ○ 列表视图    ● Wiki树视图                              │
│  ┌─────────────────────────────────────────────────────┐│
│  │  (当前记忆页内容区域)                                 ││
└─────────────────────────────────────────────────────────┘
```

| 视图 | 说明 |
|------|------|
| **列表视图** | 即当前记忆页的样子：扁平文件列表，支持搜索，可查看到编辑。**完全不变。** |
| **Wiki 树视图** | 左侧展示目录树（从 memory 文件目录层级推断），右侧展示选中分类下的文章列表，点击文章在模态框查看 Markdown 渲染。 |

### 3.2 Wiki 树视图布局

```
┌───────────────────────────────────────────────────────────────┐
│ 记忆页  Persistent context                                     │
│ Browse, search, and edit the memory files available to Claude. │
│                                                               │
│ [○ 列表视图] [● Wiki树视图]   [🔍 搜索记忆...]    [+ 新建]     │
│                                                               │
│ ┌─────────────────────┬─────────────────────────────────────┐ │
│ │  📁 根目录           │  📝 文章标题列表                    │ │
│ │    📁 guides         │  ┌─────────────────────────────┐   │ │
│ │      📁 claude       │  │ 使用 Claude Code 最佳实践  │   │ │
│ │      📁 prompts      │  │ 2026-06-30                  │   │ │
│ │    📁 api            │  ├─────────────────────────────┤   │ │
│ │    📁 cost           │  │ API 流式响应参考            │   │ │
│ │    📄 memory-1.md    │  │ 2026-06-28                  │   │ │
│ │    📄 memory-2.md    │  ├─────────────────────────────┤   │ │
│ │                      │  │ Token 计价速查              │   │ │
│ │                      │  │ 2026-06-25                  │   │ │
│ │                      │  └─────────────────────────────┘   │ │
│ │                      │                                     │ │
│ │                      │  (点击文章 → 模态框 Markdown 渲染)   │ │
│ └─────────────────────┴─────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

### 3.3 目录树生成规则

`memory_index.py` 新增 `get_memory_tree(cwd)` 函数：

```
memory/                        → 渲染为树根节点
├── guides/                    → 一级分类 "guides"
│   ├── claude/                → "guides/claude" (可折叠)
│   │   └── best-practices.md  → 叶子节点，可点击查看
│   └── prompts/               → 二级分类
│       ├── system-prompt.md   → 文章
│       └── few-shot.md        → 文章
├── api/
│   └── streaming.md           → 文章
├── cost/
│   └── token-pricing.md       → 文章
└── memory-1.md                → 跟目录下的文章
```

- 目录 = **分类节点**，可展开/折叠
- `.md` 文件 = **文章节点**，使用 frontmatter 中的 `name` 或文件名作为标题
- 分类节点不包含自己的文章，仅作为容器
- 空分类仍然显示，可折叠

### 3.4 分类图标

| 节点类型 | 图标 |
|---------|------|
| 分类（展开） | `📂` |
| 分类（折叠） | `📁` |
| 文章 | `📄` |

使用 Unicode emoji，无需外部图标库。

### 3.5 Markdown 渲染

复用前端已有的 `renderMd()` 函数（源自 `app.js`）。在原有基础上增加：

- 默认文章正文区域的**代码块用 `<pre><code>` 包裹**，自带 monospace 样式
- 对 mermaid 代码块不做特殊处理（保持为纯文本——如需支持 mermaid 后续可加）

### 3.6 无外部 CDN 依赖

| 能力 | 实现方式 |
|------|----------|
| Markdown 渲染 | 已有的 `renderMd()`（前端手写，已在 app.js 中） |
| 代码高亮 | 无需额外库——使用 CSS 预设的 `--code-bg` 背景色 + monospace 字体，保持终端审美风格 |
| 模糊搜索 | 已有后端 SQLite FTS5 全文搜索（`memory_index.search_memory()`） |
| 语法高亮 | 不引入 highlight.js，依赖 `renderMd()` 的内置渲染 |
| 图标 | Unicode emoji（📂 📁 📄 🔍 ✏️ 🗑️），无需 Font Awesome 等图标库 |

---

## 4. API 改动

### 4.1 新增 API

| 方法 | 路径 | 参数 | 返回 | 说明 |
|------|------|------|------|------|
| `GET` | `/api/memory/tree` | `cwd` | `tree: TreeNode[]` | 返回 memory 目录的树状结构 |

**TreeNode 结构：**

```json
{
  "type": "dir" | "file",
  "name": "guides",
  "title": "guides",
  "path": "guides",
  "children": [
    {
      "type": "file",
      "name": "best-practices.md",
      "title": "最佳实践",
      "path": "guides/best-practices.md",
      "updated_at": 1717200000,
      "size": 2048
    },
    {
      "type": "dir",
      "name": "claude",
      "title": "claude",
      "path": "guides/claude",
      "children": []
    }
  ]
}
```

### 4.2 已有 API 保持不变

所有 `GET /api/memory/files`, `POST /api/memory/file`, `POST /api/memory/update`, `POST /api/memory/delete`, `POST /api/memory/index`, `POST /api/memory/search` 等现有接口完全不变。

---

## 5. 前端改动清单

### 5.0 记忆页 UI 重设计（Style Polish）

当前记忆页的排版问题：

| 问题 | 表现 |
|------|------|
| 主面板和侧边栏挤在一起 | 文件列表面板和操作面板使用 grid 并排，左侧列表占不满空间，右侧面板内容太少，整体显得松散 |
| 文件列表项缺乏视觉层次 | 文件名、元信息、操作按钮挤在一行，缺少内外边距和分隔 |
| 操作面板利用率低 | 仅两个按钮 + 一段文字，占据一整列空间，内容密度不足 |
| 搜索栏与页面风格不统一 | 搜索栏与文件列表之间缺少间距和视觉连接 |
| 缺少数据统计 | 看不到当前工作目录、文件数量、最后索引时间等上下文信息 |

#### 5.0.1 新的记忆页布局

```
┌─────────────────────────────────────────────────────────────┐
│ 记忆页  Persistent context                                  │
│ Browse, search, and edit the memory files available to Claude│
│                                                             │
│ ┌───────────────────────────────────────────────────────┐  │
│ │ ○ 列表视图  ● Wiki 树视图  [🔍 搜索记忆...] [Index]   │  │
│ │ [+ 新建] [/dream]    📁 24 files · 最后更新 12:30     │  │
│ └───────────────────────────────────────────────────────┘  │
│                                                             │
│ ┌──────────────────────────┬────────────────────────────┐  │
│ │  📁 guides/              │  📝 文章标题列表            │  │
│ │  📁 api/                 │  ┌────────────────────┐   │  │
│ │  📁 cost/                │  │ 最佳实践          │   │  │
│ │  📄 memory-file-01.md    │  │ 2026-07-01       │   │  │
│ │  📄 memory-file-02.md    │  ├────────────────────┤   │  │
│ │                          │  │ API 流式响应参考   │   │  │
│ │                          │  │ 2026-06-28       │   │  │
│ │                          │  └────────────────────┘   │  │
│ └──────────────────────────┴────────────────────────────┘  │
│                                                             │
│ (列表视图时，左侧树隐藏，文件列表占满整个空间)              │
└─────────────────────────────────────────────────────────────┘
```

#### 5.0.2 布局策略变化

| 改动前 | 改动后 |
|--------|--------|
| `grid-template-columns: 1fr 280px` | **列表视图** → 文件列表占满宽度，侧边操作面板**合并到顶部工具栏** |
| 侧边栏 sticky + 独立 | **Wiki 树视图** → 左侧树面板(260px) + 右侧内容区域(1fr)，操作按钮在顶部工具栏 |
| 文件列表面板 + 操作面板并排 | **不再有右侧独立操作面板**，所有操作按钮放入顶部工具栏 |

**工具栏合并后：**

```
┌──────────────────────────────────────────────────────────────┐
│ [○ List] [● Wiki]  [🔍 搜索...]  [Index] [+ New] [/dream]   │
│ 📁 cwd/project · 24 files · 最后索引: 12:30                 │
└──────────────────────────────────────────────────────────────┘
```

之前需要右侧一整个面板来放的操作按钮，现在变成工具栏中的按钮组，和信息统计行共占一行，节省大量垂直空间。

#### 5.0.3 文件列表项样式优化

```
┌────────────────────────────────────────────────────────────────┐
│ ┌────────────────────────────────────────────────────────────┐ │
│ │  memory-file-name.md                     [✏️] [👁] [×]   │ │
│ │  1.2KB · 2026-07-01 12:30  ·  guides/claude/              │ │
│ │  (摘要行，显示文件内容的前 80 字符，灰色)                  │ │
│ ├────────────────────────────────────────────────────────────┤ │
│ │  另一个记忆文件.md                              [✏️] [👁] [×]│ │
│ │  3.5KB · 2026-06-28 09:15  ·  api/                       │ │
│ │  (摘要行)                                                 │ │
│ └────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

| 改进点 | 说明 |
|--------|------|
| 文件名独占一行 | 文件名和操作按钮在同一行，不再被元信息挤占 |
| 元信息行独立 | 文件大小、时间、所属目录路径在一行，灰色小字，清晰可辨 |
| 新增路径显示 | 显示文件在 memory 目录下的相对路径，帮助用户定位 |
| 新增摘要行 | 文件内容前 80 字符作为摘要预览，灰色斜体，帮助用户不用点开就知道大概内容 |
| 操作按钮 hover 才显示 | 默认隐藏，鼠标悬停时显示，保持界面干净 |

#### 5.0.4 空状态增强

当记忆目录不存在或为空时：

```
┌──────────────────────────────────────────────────────────────┐
│  📂 尚无记忆文件                                             │
│                                                              │
│  记忆文件存储在 .claude/projects/<project>/memory/ 目录下。   │
│  Claude Code 会在对话中自动读写这些文件。                      │
│                                                              │
│  [+ 创建第一条记忆]   [/dream 让 AI 总结项目]                 │
│                                                              │
│  或者从 Artifact 页面将有用的内容存入记忆                       │
└──────────────────────────────────────────────────────────────┘
```

#### 5.0.5 欢迎页的 welcome-session-item 同步优化

记忆页的快捷操作入口，在欢迎页中也增加一个**快速打开记忆**的入口卡片，与"开始新对话"、"最近会话"并列。

### 5.1 `static/index.html` — 记忆页 HTML

改后的 HTML 骨架：

```html
<!-- 记忆页 -->
<div id="page-memory" class="page memory-page">
  <div class="memory-shell">
    <header class="memory-header">
      <div>
        <div class="memory-kicker" data-i18n="memoryKicker">Persistent context</div>
        <h2 data-i18n="memory">Memory</h2>
        <p data-i18n="memorySubtitle">Browse, search, and edit the memory files available to Claude Code.</p>
      </div>
    </header>

    <!-- 工具栏：视图切换 + 搜索 + 操作按钮 + 状态信息（合并后） -->
    <div class="memory-toolbar">
      <div class="memory-toolbar-row memory-toolbar-top">
        <div class="memory-view-toggle">
          <button class="view-toggle-btn active" data-view="list" data-i18n="memoryListView">List</button>
          <button class="view-toggle-btn" data-view="wiki" data-i18n="memoryWikiView">Wiki Tree</button>
        </div>
        <input id="memory-search-input" type="search" class="input"
               placeholder="Search memory..." data-i18n-placeholder="searchMemory">
        <button id="btn-memory-index" class="btn-mini" type="button" data-i18n="indexMemory">Index</button>
        <button id="btn-memory-new" class="btn-mini" type="button">+ <span data-i18n="newMemory">New</span></button>
        <button id="btn-dream" class="btn-save" type="button">
          <span class="btn-prefix">&#9733;</span> <span data-i18n="dream">/dream</span>
        </button>
      </div>
      <div class="memory-toolbar-row memory-toolbar-status">
        <span id="memory-status-info" class="memory-status-info"></span>
      </div>
    </div>

    <!-- 主内容区 -->
    <div class="memory-layout">
      <!-- 左侧：分类树 (仅 Wiki 视图) -->
      <aside id="memory-tree-panel" class="memory-tree-panel" style="display:none">
        <div id="memory-tree" class="memory-tree">
          <p class="empty-state" data-i18n="loading">Loading...</p>
        </div>
      </aside>
      <!-- 右侧：文件列表 / 文章列表 -->
      <section class="memory-list-panel">
        <div id="memory-list" class="memory-file-list"></div>
        <div id="memory-article-view" style="display:none"></div>
      </section>
    </div>
  </div>
</div>
```

### 5.0.6 资产页 UI 同步优化

资产页当前也存在类似问题：

| 问题 | 表现 |
|------|------|
| 内容密度低 | 每行条目 padding 偏大（12px），屏幕空间未充分利用 |
| 摘要行夹在中间 | `.artifacts-summary` 占据独立一行，与工具栏分离，视觉重量不均 |
| 缺少"存入记忆"入口 | 与 Wiki 功能衔接不畅，用户无法将资产沉淀到记忆库 |
| 空状态平淡 | 仅有简单文字提示，缺少引导 |

#### 5.0.6.1 布局优化

```
┌──────────────────────────────────────────────────────────────┐
│ 资产页  Session outputs                                       │
│                                                              │
│ ┌────────────────────────────────────────────────────────┐  │
│ │ [All] [Images] [Files] [Links]  [🔍 搜索...] [Refresh]│  │
│ │ 共 24 项 · 图片 8 · 文件 12 · 链接 4                    │  │
│ └────────────────────────────────────────────────────────┘  │
│                                                              │
│ ┌──────┐ ┌──────┐ ┌──────┐   ← 图片卡片网格                  │
│ │      │ │      │ │      │      aspect-ratio 16/10           │
│ └──────┘ └──────┘ └──────┘                                   │
│                                                              │
│ ┌────────────────────────────────────────────────────────┐  │
│ │ 📄 filename.py      /path  2026-07-01 [打开] [复制] [💾]│  │
│ ├────────────────────────────────────────────────────────┤  │
│ │ 📄 notes.md         /path  2026-06-28 [打开] [复制] [💾]│  │
│ └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

#### 5.0.6.2 具体改动

| 改动项 | 说明 |
|--------|------|
| **去掉 subtitle 行** | 删掉 `.artifacts-header p`，资产页 header 不再显示副标题，省出空间 |
| **统计信息缩进工具栏** | `.artifacts-summary` 的文字移入工具栏底部作为第二行（`.artifacts-toolbar-bottom`），不再占独立行 |
| **行紧凑化** | `.artifact-row` padding 从 12px 降至 10px 12px；`.artifact-value`（路径）和 `.artifact-meta`（时间）放在同一行 |
| **存入记忆按钮** | 每行/每卡操作按钮组新增 `💾` 按钮（详见第 6 节） |
| **悬停增强** | .artifact-row hover 时 background 微亮 |
| **空状态增强** | 无资产时显示「尚无资产数据，开始对话将自动收集资产」引导 |

#### 5.0.6.3 CSS 改动

```css
/* 工具栏双行 */
.artifacts-toolbar {
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
}
.artifacts-toolbar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.artifacts-toolbar-bottom {
  width: 100%;
  color: var(--text-ghost);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
}
/* 行紧凑化 */
.artifact-row {
  padding: 10px 12px;
  transition: background var(--t-fast);
}
.artifact-row:hover {
  background: var(--bg-hover);
}
.artifact-row-main {
  display: flex;
  align-items: center;
  gap: 12px;
}
.artifact-value {
  flex-shrink: 1;
  min-width: 0;
}
/* 空状态增强 */
.artifacts-empty-enhanced {
  padding: 48px 20px;
  text-align: center;
  border: 1px dashed var(--border-dim);
  border-radius: var(--radius-sm);
}
.artifacts-empty-enhanced .empty-icon { font-size: 28px; margin-bottom: 12px; }
.artifacts-empty-enhanced .empty-title { font-size: 14px; color: var(--text-dim); margin-bottom: 8px; }
.artifacts-empty-enhanced .empty-hint { font-size: 12px; color: var(--text-ghost); }
```

### 5.2 `static/memory.js`

新增函数：

| 函数 | 说明 |
|------|------|
| `switchMemoryView(view)` | 切换 list/wiki 视图，切换显示/隐藏树面板，重新渲染 |
| `loadMemoryTree()` | `fetch('/api/memory/tree?...')` → `renderMemoryTree(data)` |
| `renderMemoryTree(tree)` | 递归生成分类树 HTML，绑定折叠/点击事件 |
| `renderTreeArticleList(nodePath)` | 渲染选中分类下的文章标题列表 |
| `renderTreeArticleView(filePath)` | 读取并渲染单篇文章（复用已有的模态框） |
| `toggleTreeNode(el)` | 展开/折叠分类节点 |

已有函数无需改动：`loadMemoryFiles()`, `renderMemoryFiles()`, `searchMemory()`, `viewMemoryFile()`, `openMemoryEditor()`, `saveMemoryEdit()`, `deleteMemoryFilePrompt()`, `closeMemoryModal()`, `initMemoryUI()`

### 5.3 `static/style.css`

新增样式（约 150-200 行）：

| 样式 | 说明 |
|------|------|
| `.memory-view-toggle` | 视图切换栏容器 |
| `.view-toggle-btn` | 切换按钮样式 |
| `.view-toggle-btn.active` | 当前视图按钮高亮 |
| `.memory-tree-panel` | 左侧树面板（宽度约 260px，可滚动） |
| `.memory-tree` | 树容器 |
| `.memory-tree-node` | 树节点 |
| `.memory-tree-node.dir > .node-label` | 分类节点行（带展开箭头） |
| `.memory-tree-node.file > .node-label` | 文件节点行（可点击） |
| `.memory-tree-node .node-icon` | 节点前图标 |
| `.memory-tree-node .node-children` | 子节点容器（展开/折叠控制） |
| `.memory-tree-node.collapsed > .node-children` | 折叠时隐藏子节点 |
| `.memory-tree-node .node-arrow` | 展开箭头（▶ / ▼） |
| `.memory-article-list` | 分类文章列表 |
| `.memory-article-item` | 文章条目（带标题 + 时间） |
| `.memory-article-view` | 单篇文章阅读区 |
| `.memory-article-back` | 返回按钮 |
| `.memory-article-content` | Markdown 渲染内容（复用 `.msg-content` 样式） |

### 5.4 `static/i18n/en.json` / `zh.json`

新增键（4 个）：

```json
{
  "memoryListView": "List",
  "memoryWikiView": "Wiki Tree",
  "memoryViewMode": "View mode",
  "memoryNoArticles": "This category is empty."
}
```

中文对应：

```json
{
  "memoryListView": "列表",
  "memoryWikiView": "Wiki 树",
  "memoryViewMode": "视图模式",
  "memoryNoArticles": "此分类下没有文章。"
}
```

### 5.5 后端新增：`memory_index.py`

新增函数：

```python
def get_memory_tree(cwd: str) -> list[dict]:
    """返回 memory 目录的树状结构，供 /api/memory/tree 使用。"""
```

实现逻辑：

1. 读取 `_get_memory_dir(cwd)` 下所有文件和目录
2. 跳过 `.bak` 文件
3. 递归构建 `{ type, name, title, path, children, updated_at, size }` 树
4. 文件和目录分别排序（目录在前，按名称字母序）

### 5.6 后端新增：`server.py`

新增路由（在 `handle_api_get` 的 `elif path == '/api/memory'` 块或独立块）：

```python
if path == '/api/memory/tree':
    cwd = params.get('cwd', [''])[0]
    tree = memory_index.get_memory_tree(cwd)
    return {"tree": tree}
```

---

## 6. 知识沉淀：从 Artifact 整理到 Wiki

### 6.1 入口

在 Artifact 页面的每个卡片/行上，增加 **"存入记忆"** 按钮：

```
┌──────────────────────────────────────────────┐
│ FILE  artifact-title.py                       │
│      /path/to/file                            │
│      Chat session · 2026-07-02                │
│ [打开] [复制] [会话]  [💾 存入记忆]              │
└──────────────────────────────────────────────┘
```

| 入口 | 说明 |
|------|------|
| **Artifact 页面** | 每个 `renderArtifactButtons()` 生成的按钮组中，新增 `data-action="save-to-memory"` 按钮 |
| **聊天消息中的 Artifact 卡片** | 如果消息渲染了 `.artifact-card`，也在其操作按钮组中加入 |

### 6.2 前端流程

```javascript
// static/artifacts.js — renderArtifactButtons() 新增按钮
<button class="btn-mini" type="button" data-action="save-to-memory"
        data-value="${esc(item.value)}"
        data-label="${esc(item.label)}"
        data-kind="${esc(item.kind)}"
        data-session="${esc(item.session_id)}">
  💾 <span data-i18n="saveToMemory">Save</span>
</button>

// bindArtifactActions() 新增处理
root.querySelectorAll('[data-action="save-to-memory"]').forEach(btn => {
  btn.addEventListener('click', () => {
    // 获取当前 CWD（默认取项目根）
    const cwd = cwdInput?.value?.trim() || '';
    if (!cwd) { addSystemMsg(t('setCwdFirst'), true); return; }

    const value = btn.dataset.value || '';
    const label = btn.dataset.label || 'artifact';
    const kind = btn.dataset.kind || 'file';
    const sessionId = btn.dataset.session || '';

    // 打开记忆编辑器并预填充
    openMemoryEditor(null, {
      filename: label.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 60) + '.md',
      content: `---\nname: ${label}\ndescription: 从 Artifact 整理的笔记\n---\n\n` +
               `> 来源: CC Bridge Artifact, ${new Date().toISOString().slice(0,10)}\n` +
               `> 原始会话: ${sessionId}\n\n` +
               `## ${label}\n\n\`\`\`\n${value}\n\`\`\`\n\n## 要点\n\n`,
      cwd: cwd,
    });
  });
});
```

### 6.3 编辑器复用

记忆编辑器 `openMemoryEditor()` 已支持打开文件编辑。为支持"存入记忆"场景，需要支持**传入预填充内容直接打开编辑器，无需先保存到磁盘**：

```javascript
// static/memory.js — openMemoryEditor() 支持可选预设参数
function openMemoryEditor(filename, preset) {
  // 如果传了 preset，直接填入内容并打开编辑器
  // 如果没传，走原逻辑（从已有文件加载）
}
```

具体改动：
- 第二个参数 `preset` 是可选对象 `{ filename, content, cwd }`
- 存在 `preset` 时：将 `filename` 填入文件名输入框，`content` 填入内容文本框，直接显示编辑器
- 用户可编辑后再点保存，保存时写入 memory 目录

### 6.4 写入存储

假设 memory 目录已在 `_sanitize_cwd(cwd)/memory/`，保存时调用已有 API：

```
POST /api/memory/update
{
  "filename": "artifact-title.md",
  "content": "...",
  "cwd": "D:/project"
}
```

该 API 已存在（`memory_index.save_memory_file()`），不做改动。

### 6.5 预填充内容格式

```markdown
---
name: artifact-title
description: 从 Artifact 整理的笔记
---

> 来源: CC Bridge Artifact, 2026-07-04
> 原始会话: a8233ccd-761a-48ad-b74c-14bd7c9e04b0

## artifact-title

```
(Artifact 内容原文)
```

## 要点

（用户可自行补充要点）
```

- 文件名从 Artifact label 自动生成（去特殊字符 + `.md` 后缀）
- 内容部分包含原始 Artifact 的 value
- 底部留空"要点"区域，鼓励用户补充人工整理

---

## 7. 对话中自动感知与按需摘要（核心功能）

这是本设计的核心价值：**用户每次发消息时，后端自动检索相关记忆，按需摘要后注入到 prompt 前**。用户无任何手动操作。

### 7.1 设计原则

| 原则 | 说明 |
|------|------|
| **自动感知** | 每次 `send_message` 时触发，无用户操作 |
| **仅检索相关** | 用 FTS5 匹配用户输入，只取最多 5 条，不注入无关内容 |
| **长文不截断** | 超过阈值 > 2KB 的内容启动摘要，由模型自己总结后再注入 |
| **摘要缓存** | 同一文件内容不变时不重复调用 LLM |
| **server.py 不膨胀** | 编排逻辑在独立模块 `memory_agent.py` 中 |

### 7.2 调用链

```
用户输入 → server.py 收到 send_message
                │
                ▼
        memory_agent.summarize_memories(prompt, cwd)
                │
                ├─ 1. memory_index.search_memory(prompt, cwd, limit=5)
                │       → 返回 [{ name, title, snippet, rank }]
                │
                ├─ 2. 对每条候选记忆：
                │      memory_index.get_memory_file(name, cwd)
                │       → 获取完整内容 body
                │
                │      if len(body) ≤ 2KB → 直接使用 body
                │      if len(body) > 2KB → _summarize_if_large(body, title)
                │              │
                │              ├─ 查内存摘要缓存 (memory_summary 表)
                │              ├─ 命中 → 返回缓存摘要
                │              ├─ 未命中 → ccb_bridge.summarize_memory(body, title)
                │              │               → 跑一轮轻量子进程：2-3 句总结
                │              └─ 写入缓存 + 返回摘要
                │
                ├─ 3. 组装 <memories> 块
                │
                └─ 4. 返回注入文本给 server.py
                        │
                        ▼
        server.py 拼接到 prompt 前发送给 claude
```

### 7.3 摘要阈值逻辑

| 记忆文件大小 | 注入方式 | Token 成本 |
|-------------|---------|-----------|
| ≤ 2KB | 全文注入（原文可能本身已是摘要形态，如 /dream 输出） | 低 |
| > 2KB | 启动一轮摘要子进程，摘要结果通常 200-400tokens | 摘要调用 token + 注入 token |
| 但摘要结果可缓存 | 文件 mtime 没变 → 直接复用，不再调用 | 仅首次 |

> 2KB 阈值是建议值，实现时可以是可配置常量。

### 7.4 摘要缓存

在 `memory_index.py` 的 SQLite 中增加 `memory_summary` 表：

```sql
CREATE TABLE IF NOT EXISTS memory_summary (
    file_path TEXT PRIMARY KEY,   -- 记忆文件名
    summary TEXT NOT NULL,        -- 摘要内容
    generated_at REAL NOT NULL    -- 生成时间戳
);
```

- 文件 `mtime` 没变 → 直接用缓存，零 token 成本
- 文件被编辑/覆盖 → 重新摘要

### 7.5 CCBSession 新增方法

在 `ccb_bridge.py` 中新增：

```python
class CCBSession:
    def summarize_memory(self, content: str, title: str) -> str:
        """启动轻量 claude 子进程对记忆文件做摘要。"""
        prompt = (
            f"Below is a memory file titled \"{title}\". "
            f"Summarize its core points in 2-3 sentences. "
            f"Keep all key information, remove redundancy.\n\n"
            f"---\n{content[:8000]}---"
        )
        result = self._send_one_shot_message(prompt)
        return result.strip()
```

- 输入限制 8000 字符防爆
- 使用 `_send_one_shot_message`（已有方法），只跑一轮
- 整个摘要调用在后台阻塞，但摘要内容通常 200-400 tokens，耗时短

### 7.6 memory_agent.py（新增模块）

```python
"""记忆注入编排模块。server.py 只调这一个入口，逻辑不膨胀到 server.py。"""

import time
from memory_index import search_memory, get_memory_file
from memory_index import _get_index_db  # 共享 SQLite 连接


_SUMMARY_THRESHOLD = 2048  # 字节，超过此值才摘要


def summarize_memories(user_prompt: str, cwd: str,
                       session=None, limit: int = 5) -> str:
    """检索相关记忆，按需摘要，返回 <memories> 注入块。"""
    candidates = search_memory(user_prompt, cwd, limit=limit)
    if not candidates:
        return ""

    entries = []
    stats = {"direct": 0, "summarized": 0, "cached": 0}

    for cand in candidates:
        full = get_memory_file(cand["name"], cwd)
        if not full:
            continue

        body = full.get("body", "")
        title = full.get("title", cand["name"])

        if len(body) <= _SUMMARY_THRESHOLD:
            entries.append(f"<memory name=\"{title}\">\n{body}\n</memory>")
            stats["direct"] += 1
        else:
            summary = _summarize_if_large(body, title, cwd, session)
            if summary:
                entries.append(f"<memory name=\"{title}\">{summary}</memory>")
                stats["summarized" if session else "cached"] += 1

    if not entries:
        return ""

    return "<memories>\n" + "\n\n".join(entries) + "\n</memories>"


def _summarize_if_large(content: str, title: str,
                        cwd: str, session) -> str | None:
    """检查缓存 → 未命中则请求摘要 → 写缓存。"""
    # 查缓存
    db_path = _get_index_db(cwd)
    # ... (缓存查询/写入逻辑)
    pass
```

### 7.7 server.py 改动量

在 `handle_action` 的 `send_message` 分支中，**只加一行**：

```python
from memory_agent import summarize_memories

# 在组装最终 prompt 时：
injection = summarize_memories(prompt, cwd, session=ccb_session) if cwd else ""
final_prompt = injection + "\n\n" + prompt if injection else prompt
```

### 7.8 防抖策略

同一会话中连续发送同类消息时，避免反复检索/摘要：

| 策略 | 实现 |
|------|------|
| 检索缓存 | 同会话内，短时间（如 30s）内的请求命中缓存，不重复搜索 |
| 摘要缓存 | 文件 mtime 不变，摘要结果永不过期；只有文件被编辑后才重新摘要 |
| 首次摘要后可序列化 | 摘要结果持久化到 SQLite，跨会话可用 |

---

## 8. 增量发布计划

| 阶段 | 内容 | 工作量预估 |
|------|------|-----------|
| **Phase 1** | Wiki 树视图：API 新增 `/api/memory/tree` + 前端树渲染 | 1 天 |
| **Phase 2** | 视图切换：切换按钮 + 双面板布局 CSS + 状态管理 | 半天 |
| **Phase 3** | 文章查看：树节点点击→文章列表→Markdown 渲染 | 半天 |
| **Phase 4** | Artifact 存入记忆：按钮 + 预填充逻辑 | 半天 |
| **Phase 5** | 样式打磨 + 边界情况处理（空目录、长文件名、深嵌套） | 半天 |
| **Phase 6** | 测试 + 用户反馈迭代 | 按需 |

---

## 9. 开箱 Wiki 内容

首次使用时，memory 目录可能为空。可通过首次索引时自动生成几篇示例文章，帮助用户了解该功能：

| 文件路径 | 内容 |
|---------|------|
| `memory/guides/getting-started.md` | Wiki 功能简介 + 使用提示 |
| `memory/guides/manage-memory.md` | 如何管理记忆文件 |

这些示例文件放在项目仓库的 `wiki-samples/` 目录下，首次点击 Wiki 视图时自动初始化（仅当 memory 目录为空时）。

---

## 10. 与现有功能的关系

| 已有功能 | 关系 |
|---------|------|
| 列表视图（现有） | **完全保留，不做任何改动** |
| 搜索（现有） | 两视图共用搜索逻辑，搜索时自动切换到列表视图展示结果 |
| 编辑/新建（现有） | 两视图均可使用 |
| 删除（现有） | 两视图均可使用 |
| 索引重建（现有） | 两视图均可使用 |
| Artifact 页面（现有） | 新增"存入记忆"入口，单向写入 |
| `/dream` 命令（现有） | 不受影响，继续使用 |
| Claude Code auto memory | 完全兼容，文件格式不变 |
