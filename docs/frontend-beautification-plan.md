# 前端美化方案

## 1. 背景与现状

cc-bridge 前端是无构建的静态应用，主要由 `static/index.html`、`static/style.css`、`static/app.js` 以及少量专题 CSS/JS 文件组成。项目整体定位是 Claude Code CLI 的轻量 Web GUI，功能覆盖会话、工作区、文件、review、Artifacts、Skills、Agents、MCP、远程目标、消息网关、记忆、定时任务和配置等模块。

当前视觉基调偏“终端 / Phosphor / 开发工具”：深色主题为主，绿色、青色、琥珀色作为强调色；使用 CSS 变量维护颜色、圆角、间距和字体；已有亮色主题与中英文 i18n。整体功能完整，但页面和组件随功能增长逐步叠加，出现了以下问题：

- 视觉层级不够统一：不同页面的 header、card、toolbar、按钮、表单密度存在差异。
- 高频路径不够突出：新建会话、恢复会话、发送消息、切换 cwd/model、查看文件和处理 diff 的主次关系还可以更清晰。
- 功能页面信息密度较高：配置、集成、消息网关、记忆、定时任务等页面容易显得表单堆叠。
- 组件风格存在混杂：文字按钮、图标按钮、状态标签、空状态、错误态、加载态的样式规则尚未完全收敛。
- 长路径、长会话名、中英文切换、窄屏和 Windows 字体 fallback 需要进一步打磨。

本方案目标是在不引入构建流程、不重写技术栈的前提下，基于现有 HTML/CSS/vanilla JS 渐进美化。

## 2. 美化目标

### 2.1 产品气质

保留现有开发者工具和终端气质，但从“复古终端界面”升级为“清晰、稳定、专业的开发者控制台”。重点不是换皮，而是降低视觉噪声、提升层级和可读性。

### 2.2 设计目标

1. **统一设计令牌**：收敛颜色、阴影、圆角、间距、字体层级、焦点态、危险态等 CSS 变量。
2. **统一组件规则**：按钮、输入框、select、toggle、modal、toast、badge、card、toolbar、empty-state 使用一致的 class 约定。
3. **突出核心路径**：对话页、输入区、会话列表、文件预览、diff/review 面板的视觉优先级高于低频配置项。
4. **降低页面负担**：管理类页面统一为“页面 header + toolbar + card/grid/list”结构。
5. **保持轻量实现**：不引入 React、Tailwind、打包器或复杂依赖；优先通过 CSS 变量和现有 DOM 结构改造。
6. **提升可访问性**：保证暗色/亮色对比度、键盘焦点可见、滚动和窄屏布局稳定。

## 3. 分阶段改造计划

### 阶段一：设计令牌与基础组件统一

优先整理 `static/style.css` 中的基础变量和通用类，降低后续页面改造成本。

建议动作：

- 建立语义化 token：
  - `--surface-page`
  - `--surface-panel`
  - `--surface-card`
  - `--surface-raised`
  - `--text-primary`
  - `--text-secondary`
  - `--text-muted`
  - `--action-primary`
  - `--action-danger`
  - `--focus-ring`
- 检查并收敛重复或语义重叠变量，例如 accent、border、float surface 等。
- 统一按钮体系：
  - 主按钮：高频确认动作，如发送、新建、保存。
  - 次按钮：普通工具操作，如刷新、浏览、展开。
  - 危险按钮：删除、停止、重置。
  - 小按钮：列表项内联操作。
- 统一表单控件的高度、圆角、边框、placeholder、focus、disabled 状态。
- 统一 card、panel、toolbar、badge、status-dot、empty-state、toast、modal 的视觉规则。

验收重点：不改业务逻辑，仅通过 CSS 和少量 class 调整，让现有页面视觉更一致。

### 阶段二：核心对话体验美化

对话页是项目最重要的使用场景，应优先打磨。

建议动作：

- 将消息类型视觉分层：
  - user：明确输入来源，可偏右或使用更强边框。
  - assistant：作为主要阅读内容，突出正文排版。
  - tool：可折叠的工具调用块，弱化默认展示。
  - error：明确错误色和修复提示。
  - system/result：以状态条或小型信息块展示。
- 优化 composer：
  - 输入框、附件、引用、slash 命令、模型、cwd、发送/停止按钮分区清晰。
  - 发送按钮作为唯一主 CTA，停止按钮使用危险/警告态。
- 优化流式状态：
  - 在当前 assistant 消息附近展示生成中状态。
  - 结果、费用、token、耗时等元信息统一弱化为 meta 区。
- 统一右侧面板：文件树、review、成员/agent 面板使用一致 tab、toolbar、列表项 hover 和选中态。
- 优化文件和 diff 预览：弱化厚重边框，强化标题、路径、操作区和内容滚动区域。

验收重点：发送消息、停止生成、恢复会话、查看文件、打开 diff、切换右侧面板时，视觉反馈稳定清晰。

### 阶段三：管理类页面体系化

会话、Artifacts、Skills、Agents、MCP、远程目标、消息网关、记忆、定时任务、配置页都应采用统一页面骨架。

建议页面结构：

```text
page
├─ page-header
│  ├─ kicker / breadcrumb
│  ├─ title
│  ├─ description
│  └─ actions
├─ page-toolbar
│  ├─ search/filter/tabs
│  └─ secondary actions
└─ page-content
   ├─ cards / table / split-view
   └─ empty/loading/error states
```

重点建议：

- 会话页：突出 pinned、active、cwd、model、更新时间；长标题和长路径做优雅截断。
- Artifacts：强化预览卡片、类型标签、来源会话和打开动作。
- Skills/Agents：使用 marketplace/list 风格卡片，明确 scope、description、tools。
- 集成/MCP/远程目标：采用状态卡片，清晰区分已配置、未配置、异常、测试中。
- 消息网关：塑造成“平台接入仪表盘”，飞书接入分为快捷连接、必填参数、高级设置。
- 记忆页：图谱区域作为沉浸式 panel，搜索、筛选、节点详情侧栏减少对主画布干扰。
- 定时任务：建议左侧任务列表、右侧详情/表单；状态、下次执行时间、上次结果使用 badge 表达。
- 配置页：表单分组更清晰，危险操作独立区域，说明文字弱化处理。

### 阶段四：细节、主题与响应式

建议最后统一处理体验细节：

- 暗色和亮色主题均检查对比度。
- 支持 `prefers-reduced-motion`，动画保持轻量。
- 窄屏下左侧导航、右侧面板和 workspace tabs 可收起或纵向排列。
- Windows 下滚动条、字体 fallback、长路径换行和高 DPI 显示做专项检查。
- 统一图标风格，减少 `PIN`、`DIR`、`EDIT` 等文字按钮与符号按钮混杂。
- 所有新增文案同步维护 `static/i18n/zh.json` 和 `static/i18n/en.json`。

## 4. 重点组件规范建议

### 4.1 Button

建议形成以下 class 约定：

- `.btn`：默认按钮。
- `.btn-primary`：主操作。
- `.btn-secondary`：次操作。
- `.btn-danger`：危险操作。
- `.btn-ghost`：低强调工具按钮。
- `.btn-icon`：纯图标按钮。
- `.btn-sm`：列表内小尺寸按钮。

所有按钮应统一 hover、active、focus、disabled 和 loading 状态。

### 4.2 Card / Panel

- card 用于独立信息块。
- panel 用于页面主容器或可滚动区域。
- raised surface 仅用于 modal、popover、floating preview。
- 避免同一区域嵌套过多强边框，可用背景层级和标题区分。

### 4.3 Status

建议统一状态表达：

- success：已连接、已完成、可用。
- warning：待配置、部分可用、需要确认。
- danger：失败、断开、删除。
- info：运行中、同步中、生成中。
- muted：未知、空、禁用。

可组合 `badge + status-dot + short text`，避免每个页面自定义状态颜色。

### 4.4 Empty / Loading / Error

每个列表或面板至少应有：

- 空状态标题。
- 一句说明。
- 可选主操作。
- 错误状态的重试或定位动作。

这对会话、Artifacts、Skills、MCP、远程目标、记忆搜索、定时任务尤其重要。

## 5. 风险与约束

- `app.js` 可能依赖大量 DOM id、class 和节点层级，HTML 结构调整要谨慎。
- 项目无构建、无前端测试，重构范围应小步提交、手工验证。
- 不建议引入大型 UI 框架，否则会破坏轻量、易启动、无构建的项目定位。
- 亮色主题、中英文 i18n、Windows 字体和滚动条容易被忽略，应纳入验收清单。
- 前端美化不应影响 SSE 流式渲染、上传、文件预览、配置保存等核心功能。

## 6. 验证清单

启动 `python server.py` 后，建议按以下清单验证：

- 暗色/亮色主题切换正常。
- 中文/英文切换后布局不溢出。
- 首页新建会话、恢复最近会话正常。
- 对话页发送消息、停止生成、流式消息显示正常。
- 长消息、代码块、工具调用、错误消息可读。
- 上传附件、文件引用、文件树选择正常。
- diff/review 预览可打开、滚动、关闭。
- 会话搜索、置顶、重命名、删除操作正常。
- Artifacts 列表和预览正常。
- Skills/Agents/MCP/远程目标页面可浏览和保存。
- 消息网关配置、状态显示、二维码区域正常。
- 记忆图谱、搜索、详情区域正常。
- 定时任务创建、启用、禁用、立即执行按钮可用。
- 配置页保存 GUI 设置、env、model、CLI 不报错。
- 浏览器控制台无新增错误。
- 窄屏下侧栏、右侧面板、输入区不遮挡主内容。

## 7. 建议落地顺序

1. 先做 CSS token 和按钮/表单/card 统一。
2. 再做对话页和 composer 美化。
3. 然后统一管理类页面骨架。
4. 最后处理主题、响应式、空状态和动效细节。

这样可以在保持功能稳定的前提下，逐步提升整体质感。