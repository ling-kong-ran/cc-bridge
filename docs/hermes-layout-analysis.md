# Hermes Agent Desktop App — 排版 & 设计系统分析

> 来源：`https://github.com/NousResearch/hermes-agent` `apps/desktop`
> 日期：2026-06-27

---

## 1. 全局布局结构

```
┌──────────────────────────────────────────────────────────┐
│  Titlebar (34px, fixed, z-4)                             │
│  ┌─ left: macOS traffic lights (72px offset)             │
│  ├─ titlebar-tools-left: 可扩展的工具按钮                   │
│  ├─ center: drag region (可拖拽窗口)                       │
│  ├─ titlebar-tools-right: [profiles|haptics|settings|×]   │
│  └─ native overlay: Windows WCO 右侧 reserve              │
├──────────────────────────────────────────────────────────┤
│  overlay layer (z-3+)         │                          │
│  ┌─ NotificationStack         │                          │
│  ├─ KeybindPanel              │                          │
│  └─ FloatingPet               │                          │
├────────┬───────────┬──────────┤                          │
│ Pane   │ PaneMain  │ Pane     │  ← PaneShell (CSS Grid)  │
│ left   │ (1fr)      │ right    │                          │
│sidebar │  Thread    │ preview  │                          │
│        │  + Composer│ + files  │                          │
├────────┴───────────┴──────────┤                          │
│  Statusbar (32px, fixed, z-3) │                          │
│  ┌─ left items                │                          │
│  └─ right items (model/cwd)   │                          │
└──────────────────────────────────────────────────────────┘
```

### 核心组件

| 组件 | 路径 | 职责 |
|------|------|------|
| `AppShell` | `shell/app-shell.tsx` | 全局壳：titlebar + main + statusbar + overlays |
| `PaneShell` | `components/pane-shell/pane-shell.tsx` | CSS Grid 多栏弹性布局，可 resize 的 pane 系统 |
| `ChatView` | `chat/index.tsx` | 对话主区域：header + Thread + Composer |
| `ChatSidebar` | `chat/sidebar/index.tsx` | 左侧会话列表（按 workspace 分组） |
| `ChatBar` | `chat/composer/index.tsx` | 底部输入栏（model pill / voice / attachments / submit） |

### cc-bridge 对比

```
hermes-agent                      cc-bridge
───────────                       ─────────
AppShell                        → index.html (.app)
  ├─ TitlebarControls            → .chat-topbar (简化版)
  ├─ PaneShell                   → .app (flex, 无多栏)
  │   ├─ Pane (sidebar)          → .sidebar
  │   │   └─ ChatSidebar         → 会话列表 + 运行设置
  │   ├─ PaneMain                → .main
  │   │   ├─ ChatHeader          → .chat-topbar
  │   │   ├─ Thread              → #messages
  │   │   └─ ChatBar (Composer)  → .input-wrapper
  │   └─ Pane (right sidebar)     → (cc-bridge 目前无右侧面板)
  └─ StatusbarControls           → (cc-bridge 无独立 statusbar)
```

**关键差异：**
- hermes 是 Electron 原生窗口，titlebar 由 Electron 绘制，有 macOS traffic lights / Windows WCO 适配
- cc-bridge 是 Web 页面，没有原生 titlebar，用 `.chat-topbar` 做最小化顶部信息条
- hermes 有 **PaneShell** 多栏系统（左侧会话列表、右侧文件/终端预览），cc-bridge 目前只有 sidebar + main 两栏

---

## 2. 布局常量 & 响应式

### Hermes 的断点

```ts
// layout-constants.ts
SIDEBAR_COLLAPSE_BREAKPOINT_PX = 768   // 低于此宽度 sidebar 自动折叠为 hover-reveal overlay
PAGE_INSET_X = 'px-[clamp(1.25rem,4vw,4rem)]'  // 内容区域水平内边距，响应式 clamp
```

```css
/* styles.css */
@custom-variant compact (@media (max-height: 768px));  /* 短视口：sidebar 各区域合并滚轮 */
```

### Hermes 的 Pane 系统

```tsx
// 每个 Pane 支持：
<Pane id="chat-sidebar" side="left"    // left | right
      width="16rem"                     // 默认宽度
      minWidth={180} maxWidth={480}     // resize 范围
      resizable                          // 可拖拽 resize
      divider                            // 边界 hairline
      hoverReveal                        // 窄屏时悬浮滑出
      bottomRow                          // 作为底部行（terminal）
      defaultOpen
/>
<PaneMain> {/* 主内容区，占 1fr */}
<Pane id="preview-pane" side="right" ... />
```

**这不是 cc-bridge 能直接复用的**（cc-bridge 不用 React / CSS Grid），但有两个思路值得借鉴：
1. **sidebar collapse 断点**：`max-width: 768px` 时改为 overlay 模式（cc-bridge 已在 `@media (max-width: 760px)` 实现）
2. **短视口变体**：`max-height: 768px` 时压缩 sidebar 为共享滚轮（cc-bridge 刚实现 `@media (max-height: 768px)`）

---

## 3. 设计 Token 系统

### 阴影 (已经部分引入)

| Token | Hermes | cc-bridge 状态 |
|-------|--------|---------------|
| `shadow-nous` | 4层 `color-mix(in srgb, #000 X%, transparent)` | ✅ `--shadow-overlay` (4层 rgba) |
| `stroke-nous` | `color-mix(in srgb, currentColor 3%, transparent)` | ✅ `--hairline` (相同逻辑) |
| light 主题变体 | 同样4层，但透明度更浅 | ✅ 已添加 light-theme 覆盖 |

### 颜色体系

Hermes 使用 **双色系混合模型**，核心思路是把一个品牌色（`theme-primary`）和一个中性灰底（`theme-neutral-chrome`）按百分比混合，产生所有 UI 色：

```css
/* Hermes 的核心思路 */
--ui-bg-secondary: color-mix(in srgb, --ui-accent 11%, color-mix(in srgb, --ui-base 7%, transparent));

/* cc-bridge 的等价方案（更简单） */
--bg-deep:     #1a1f2b;   /* 侧边栏 */
--bg-surface:  #1e2432;   /* 卡片 */
--bg-raised:   #252d3d;   /* 悬浮 */
```

**cc-bridge 不需要改用 color-mix 混合模型**，因为：
- cc-bridge 主题数量有限（dark / light），硬编码色值足够精确
- `color-mix` 需要较新的浏览器支持
- Hermes 的混合模型是为多主题（用户可自定义品牌色）设计的

### 笔触层级

```
Hermes 的笔触 (stroke) 层级：
  --ui-stroke-primary     (最强)     →  cc-bridge: --border
  --ui-stroke-secondary             →  cc-bridge: (无对应)
  --ui-stroke-tertiary   (常规分割线) →  cc-bridge: --border-dim
  --ui-stroke-quaternary  (最弱)     →  cc-bridge: --hairline
  --stroke-nous (浮层专用)           →  cc-bridge: --hairline
```

**cc-bridge 目前只有 2 级笔触**（`--border` / `--border-dim` + `--hairline`），对当前规模够用。

---

## 4. Sidebar 会话列表设计

### Hermes 的结构

```
ChatSidebar
├── ProfileSwitcher          ← 多 Profile（cc-bridge 不需要）
├── SearchField              ← 搜索框（borderless, underline-on-focus）
├── SidebarContent
│   ├── SidebarGroup "Pins"       (固定会话)
│   ├── SidebarGroup "Recent"     (按 workspace 分组)
│   │   ├── workspace-group       ← 可折叠的 workspace group
│   │   │   ├── session-row       ← 单行：title + source badge + 右键菜单
│   │   │   └── ...
│   │   └── LoadMoreRow           ← 分页加载更多
│   └── SidebarGroup "Cron"       (定时任务)
└── ProjectDialog            ← 新建/管理 Project
```

### cc-bridge 的当前结构

```
.sidebar
├── sidebar-header          ← logo + actions
├── sidebar-section         ← 运行设置 (compact runtime panel)
├── nav                     ← 导航按钮 (chat / settings)
├── session-section         ← 会话列表
│   ├── session-search      ← 搜索框
│   ├── session-group       ← 按 CWD 分组
│   │   ├── session-item    ← 单行：title + 右键菜单
│   │   └── ...
│   └── ...
└── status-bar              ← 连接状态 + 费用
```

### 值得借鉴的点

1. **Pins 区**：hermes 支持"钉选"会话到顶部（Pin/Unpin），cc-bridge 可考虑
2. **分页加载**：hermes 的 `LoadMoreRow` 按页加载历史会话（`SIDEBAR_SESSIONS_PAGE_SIZE`），cc-bridge 目前一次加载全部
3. **搜索框样式**：hermes 的 SearchField 是 borderless + underline-on-focus（极简），cc-bridge 当前是有边框的 input

---

## 5. Composer（输入区域）

### Hermes 的 ChatBar 结构

```
ChatBar (composer/index.tsx)
├── Attachments bar           ← 已选附件列表（可拖拽排序）
├── StatusStack               ← coding-row / preview-row / status-row
│   ├── CodingRow              ← 当前操作状态（Running / Done）
│   ├── PreviewRow             ← 预览状态
│   └── StatusRow              ← 通用 status
├── textarea                  ← 富文本输入区
│   ├── inline refs (@file, @session)
│   ├── slash commands (/dream, /clear...)
│   └── @mention autocomplete
├── Controls                  ← 底部控制栏
│   ├── ModelPill              ← 模型切换（下拉）
│   ├── Attachment buttons     ← 文件/图片/文件夹
│   ├── Voice button           ← 语音输入
│   └── Send/Stop button       ← 发送/停止
└── ContextMenu               ← 右键菜单
```

### cc-bridge 对比

| 功能 | hermes | cc-bridge |
|------|--------|-----------|
| 附件预览 | attachments bar + 排序 | 发送前无预览，消息内 attachmentIntro |
| 状态行 | status-stack (coding/preview/status) | 无 |
| 模型切换 | ModelPill (下拉，composer 内) | model select (sidebar 运行设置里) |
| 语音输入 | 有 (use-voice-recorder) | 无 |
| 斜杠命令 | slash completions | slash-command-panel ✅ |
| @提及 | @mention (agents) | mention-popup ✅ |
| 快捷键提示 | help-hint | 无 |
| 富文本 inline refs | @file, @session 内联引用 | 无（附件独立发送） |

**可借鉴：**
- **Attachment bar**：发送前显示已选附件 + 可移除（当前 cc-bridge 选择文件后只在消息区显示 "Selected N files"）
- **Model pill in composer**：把模型切换从 sidebar 移到输入栏内，减少来回切换
- **Help hint**：输入框旁显示 Enter 发送 / Shift+Enter 换行的提示

---

## 6. 右侧面板 (Right Sidebar / Preview Pane)

hermes 的右侧栏是一个可 resize 的 Pane，包含：

```
RightSidebar
├── Tab bar: [Files] [Terminal] [Review]
├── Files tab
│   └── Project tree (可拖拽文件到 chat)
├── Terminal tab
│   └── Persistent terminal session
└── Review tab
    └── 代码审查 (churn-bar + file-tree)
```

**cc-bridge 目前没有右侧面板。** 不过有 chat-sidebar（会话成员面板），功能完全不同。如果后续需要：
- 项目文件树 → 可以复用 cc-bridge 已有的目录浏览/搜索功能
- Terminal → 需要额外实现
- Review → 暂时不需要

---

## 7. 反馈系统

### Hermes 的通知

```
NotificationStack (components/notifications.tsx)
├── 应用内 toast（portaled to body, z=[200]）
├── 四种类型：error / warning / info / success
│   ├── error:    AlertCircle icon, destructive variant
│   ├── warning:  AlertTriangle icon, primary variant
│   ├── info:     Info icon, muted variant
│   └── success:  CheckCircle2 icon, success variant
├── 堆叠 + 展开/折叠
└── 触觉反馈 (triggerHaptic)
```

还有原生通知：`store/native-notifications.ts`（独立于应用内 toast）

**cc-bridge 对比：**
- cc-bridge 的应用内提示是 `addSystemMsg()`（在聊天流中插入系统消息），没有独立的 toast 组件
- cc-bridge 的浏览器原生通知（`Notification API`）已实现
- 可考虑后续添加 toast 通知提升体验

---

## 8. 动画 & 动效

### Hermes 的动效

```
- 控制组件：~100ms transition
- overlay 弹出：shadow-nous + slide
- hover-reveal sidebar：220ms slide with 130ms hover-intent delay
- 尊重 prefers-reduced-motion
- 编排退出动画（如 onboarding matrix fade）
```

### cc-bridge 对比

```
- transition: var(--t-fast) 0.12s / var(--t-base) 0.22s
- runtime-panel: max-height 动画 (已实现)
- 无 hover-reveal sidebar（移动端有 slide-in overlay）
- 无 prefers-reduced-motion 处理
```

---

## 9. 可操作的建议（按优先级）

### 高优先级

**1. Model pill 移入输入栏**
将模型选择从 sidebar 运行设置移到输入框旁边，类似 hermes 的 `ModelPill`。减少用户来回切换。

**2. Attachment bar**
在输入框上方显示已选附件，支持单个移除。当前 cc-bridge 只在发送后显示 "Selected N files" 不够直观。

**3. 搜索框改为 borderless underline 风格**
Hermes 的搜索框设计极简，cc-bridge 的 session-search 可以参考。

### 中优先级

**4. Toast 通知系统**
独立的应用内 toast（非 `addSystemMsg`），在操作成功/失败时弹出。hermes 的 `NotificationStack` 可以参考。

**5. Pin 会话**
支持将会话固定在列表顶部（hermes 的 Pins section）。

**6. `prefers-reduced-motion` 支持**
在 `@media (prefers-reduced-motion: reduce)` 中禁用所有动画。

### 低优先级

**7. 右侧文件面板**
项目文件树作为右侧可开关面板（类似 hermes 的 RightSidebar Files tab）。

**8. 快捷键提示**
输入框旁的小提示（"Enter to send, Shift+Enter for newline"）。

**9. 分页加载会话**
当前一次加载全部会话，会话很多时可以分页。

---

## 10. 设计原则总结（来自 DESIGN.md）

Hermes 的设计原则与 cc-bridge 当前方向的对应：

| 原则 | cc-bridge 现状 |
|------|---------------|
| Flat, not boxed — 无 card-in-card | ✅ 已通过 hairline + whitespace 改进 |
| Borderless + shadow for elevation | ✅ 已引入 shadow-overlay + hairline |
| One primitive per concern | ⚠️ 有重复的按钮/输入框样式 |
| Tokens, not literals | ✅ 使用 CSS 变量体系 |
| Style lives in primitive | ⚠️ 部分内联 style / className 覆盖 |

cc-bridge 作为纯 vanilla JS 项目，不可能做到 hermes 那种组件级一致性的严格程度，但 CSS 变量体系已经建立得很好，继续维持 "token > literal" 的原则即可。
