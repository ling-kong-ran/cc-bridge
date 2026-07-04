# HTML / JS 优化方案

## 1. 背景与目标

cc-bridge 前端采用无构建静态架构，核心页面由 `static/index.html` 提供完整 DOM 骨架，`static/app.js` 负责状态、事件、SSE、REST API、渲染和交互逻辑。当前实现的优势是启动简单、依赖少、便于 Windows 环境直接运行；但随着会话、工作区、文件预览、Artifacts、Skills、Agents、MCP、消息网关、记忆、定时任务和配置等模块持续增加，HTML 与 JS 的耦合逐渐变重。

本方案目标是在不引入构建流程、不迁移框架、不改变后端接口的前提下，逐步提升 `index.html` 与 `app.js` 的可维护性、可访问性和运行稳定性。

重点不是重写前端，而是建立更清晰的结构边界：

- HTML 负责稳定、语义化、可访问的页面骨架。
- CSS 负责视觉和响应式，不再依赖大量内联样式。
- JS 负责状态、事件、API、渲染和交互，并逐步按功能域收敛。
- DOM id/class 作为兼容契约管理，避免无意破坏 `app.js` 依赖。

## 2. 现状梳理

### 2.1 HTML 结构现状

`static/index.html` 当前承担了整个应用的页面骨架，包括：

- 全局 `titlebar`、侧边栏导航、移动端菜单和状态摘要。
- `page-home`、`page-chat`、`page-sessions`、`page-artifacts`、`page-skills`、`page-integrations`、`page-feishu-gateway`、`page-memory`、`page-scheduled`、`page-config` 等页面容器。
- 对话页中的 workspace tabs、消息区域、文件预览、diff 预览、runtime settings、composer、右侧文件/review/members 面板。
- 多个模态框和浮层：Memory 查看/编辑、Agent 编辑、Skill 详情、目录选择器、文件选择器、帮助、CLI 安装引导等。
- i18n 通过 `data-i18n`、`data-i18n-title`、`data-i18n-placeholder` 等属性维护。

当前 HTML 的主要问题：

- 单文件承载所有页面和模态框，结构很长，阅读和定位成本高。
- 部分按钮仍使用 `PIN`、`DIR`、`EDIT` 等文字符号，和图标按钮风格混杂。
- 存在较多 `style="display:none"`、`style="width:auto; padding:..."`、内联布局样式，后续主题与响应式难统一。
- 页面骨架虽已趋于统一，但不同模块的 header、toolbar、card、form 仍有历史 class 并存。
- 一些元素是 JS 兼容契约，例如隐藏的 `#model-select` 仍被 `app.js` 引用，需要明确标注和保护。
- 部分交互控件可以补充更完整的 `aria-*`、`role`、`aria-live`、`aria-label` 和键盘语义。

### 2.2 JavaScript 结构现状

`static/app.js` 当前是前端主逻辑文件，职责覆盖：

- 全局状态：client/session/run、流式内容、workspace、sessions cache、skills cache、gateway config、scheduled tasks 等。
- DOM 缓存：大量 `document.getElementById()` 顶层常量。
- 初始化流程：`DOMContentLoaded` 中串联主题、导航、SSE、输入框、模型胶囊、远程、MCP、Agent、右侧面板、文件预览、Memory、Artifacts、Scheduled、Feishu Gateway、Workspace 等模块。
- Workspace：多会话标签页、focus/grid 模式、状态保存、宽度调整、后台预览。
- SSE：连接、事件过滤、后台 session preview、stream event、assistant final、session id 捕获、错误和结果处理。
- 输入区：发送、停止、附件上传、引用消息、slash command、model pill、拖拽上传。
- 管理页：sessions、skills、agents、MCP、remote targets、message gateway、memory graph、scheduled tasks、config 等。
- 渲染逻辑：大量通过模板字符串生成 `innerHTML`，再绑定事件。

当前 JS 的主要问题：

- 单文件职责过多，不同功能域之间边界不明显。
- 全局变量数量较多，状态修改路径分散，排查会话/流式/workspace 问题时成本高。
- DOM 查询与事件绑定分布广，部分渲染函数每次 `innerHTML` 后重新绑定事件。
- 渲染、事件、API 请求和状态更新经常混在同一函数中。
- 部分 UI 显隐依赖直接写 `element.style.display`，和 CSS 状态类体系不完全统一。
- 异步请求的错误处理形式不完全一致，有些仅忽略异常，有些展示 toast 或 system message。

### 2.3 HTML 与 JS 的耦合点

需要重点保护的耦合点包括：

- 页面容器：`#page-*`、`.page`、`.nav-btn[data-page]`。
- 对话核心：`#messages`、`#message-input`、`#btn-send`、`#btn-stop`、`#cwd-input`、`#model-select`。
- Workspace：`#session-workspace`、`#workspace-tabs`、`#workspace-panes`、`#workspace-live-pane`。
- 文件与 diff：`#file-preview-panel`、`#file-preview-content`、`#diff-preview-panel`、`#diff-preview-content`。
- 右侧面板：`#chat-sidebar`、`#file-tree-panel`、`#review-panel`、`#group-member-panel`。
- 管理页列表与表单：sessions、artifacts、skills、agents、MCP、remote、gateway、memory、scheduled、config 相关 id。
- i18n 属性：`data-i18n*` 是 HTML 与翻译 JSON 的契约。

任何 HTML 调整都应先确认这些 id/class 是否被 `app.js` 引用。

## 3. 优化原则

1. **不引入构建流程**：继续保持静态 HTML/CSS/vanilla JS。
2. **不迁移框架**：不引入 React、Vue、Tailwind、打包器或大型 UI 库。
3. **小步改造**：先文档、再结构清理、再局部 JS 收敛，避免一次性大重写。
4. **保护 DOM 契约**：被 JS 引用的 id/class 不随意删除或改名。
5. **CSS 接管样式**：逐步移除内联布局样式和 `style="display:none"`，改用语义 class。
6. **事件委托优先**：列表、卡片、动态渲染区域优先使用容器级事件委托。
7. **状态集中**：同一功能域的状态、API、渲染和事件绑定尽量放在相邻区域。
8. **i18n 同步**：新增用户可见文案必须同步 `static/i18n/zh.json` 与 `static/i18n/en.json`。
9. **可访问性优先**：按钮、tab、dialog、popover、状态提示应保持键盘可用和语义清晰。
10. **不改变业务逻辑**：HTML/JS 整理阶段不修改 SSE、session、upload、remote、gateway 等核心行为。

## 4. 分阶段优化计划

### 阶段一：HTML 结构与语义整理

目标：在不改变交互逻辑的前提下，让 `index.html` 更稳定、更语义化、更易维护。

建议动作：

- 为主要区域补齐语义标签：`header`、`nav`、`main`、`section`、`aside`、`dialog` 风格结构。
- 梳理页面骨架，保持各管理页统一结构：
  - `page-shell`
  - `page-header`
  - `page-toolbar`
  - `page-content`
- 将内联样式替换为 class：
  - `style="display:none"` → `.is-hidden` / `[hidden]` / 模块状态 class。
  - `style="width:auto; padding:..."` → 按钮尺寸 class。
  - modal 内联尺寸 → `.modal-sm` / `.modal-md` / `.modal-lg`。
- 对保留给 JS 的隐藏控件加注释说明，例如 `#model-select` 是 model pill 的底层 select contract。
- 统一 titlebar 和 workspace 中的文字符号按钮：逐步替换 `PIN`、`DIR`、`EDIT` 为 i18n 文案、统一 icon 或更清晰的 aria label。
- 给动态区域补充语义：
  - workspace tabs 使用完整 tablist/tab 语义。
  - slash command 和 model popover 使用 listbox/option 或 menu/menuitem 语义。
  - toast、streaming、gateway status 使用合适 `aria-live`。

验收重点：HTML 结构更清晰，但现有功能、id/class、页面切换和事件绑定不被破坏。

### 阶段二：JS 状态与模块边界收敛

目标：不拆构建、不改接口，先在单文件内部建立功能域边界，降低全局状态混杂。

建议动作：

- 在 `app.js` 内按功能域整理代码块：
  - core state / DOM refs
  - i18n / theme / settings
  - navigation / layout
  - SSE / session lifecycle
  - workspace
  - composer / attachments / quotes / slash commands
  - file tree / preview / diff
  - sessions page
  - artifacts
  - skills / agents / MCP
  - message gateway
  - memory
  - scheduled tasks
  - config / remote targets
- 将相关状态合并成对象，减少散落全局变量，例如：
  - `streamState`
  - `workspaceState`
  - `uiState`
  - `gatewayState`
- 建立轻量 DOM helper：
  - `$(id)` 或 `byId(id)` 用于集中查询。
  - `show(el)` / `hide(el)` / `setVisible(el, visible)` 统一显隐。
  - `setBusy(el, busy)` 统一按钮 loading/disabled。
- 保持函数命名按动作和领域区分：
  - `load*` 只负责请求数据。
  - `render*` 只负责 DOM 输出。
  - `bind*` / `init*` 负责事件绑定。
  - `read*Form` / `fill*Form` 负责表单数据转换。
- 将 `DOMContentLoaded` 初始化拆成更清晰的阶段：
  - 基础 UI 初始化。
  - 数据源初始化。
  - SSE 初始化。
  - 页面模块初始化。
  - 首屏数据加载。

验收重点：代码行为不变，但阅读 `app.js` 时能快速定位某个模块的状态、事件和渲染逻辑。

### 阶段三：渲染函数与 DOM 更新优化

目标：降低动态区域重复绑定事件和大范围重绘，提升长会话、长列表和后台 workspace 的稳定性。

建议动作：

- 对列表型区域优先使用事件委托：
  - sessions list
  - attachments bar
  - quote preview
  - slash command panel
  - workspace tabs
  - artifacts list
  - scheduled task list
  - gateway scopes
- 对高频更新区域避免整块 `innerHTML` 重绘：
  - streaming message
  - token/cost/status meta
  - workspace preview
  - file tree filter result
- 对必须使用模板字符串的地方保留 `esc()`，避免 XSS 回归。
- 对渲染函数拆分为小函数：
  - `renderCard(data)` 返回单项 HTML。
  - `renderList(items)` 负责容器。
  - `bindListEvents()` 只绑定一次。
- 对异步数据加载建立一致状态：
  - loading
  - empty
  - error
  - ready
- 避免在频繁事件中直接写 DOM：
  - 使用 `requestAnimationFrame` 合并 workspace preview、resize、scroll 相关更新。
  - 输入框、搜索框、文件过滤可使用轻量 debounce。

验收重点：长会话流式输出、后台会话预览、列表搜索和文件树过滤更稳定，控制台无新增错误。

### 阶段四：可访问性、i18n 与交互一致性

目标：让无构建前端在键盘、屏幕阅读器、中英文、窄屏和亮/暗主题下保持一致体验。

建议动作：

- 所有 icon-only 按钮补齐 `aria-label` 或 `data-i18n-title`。
- 所有 dialog/modal 明确：
  - 标题关联。
  - 关闭按钮。
  - Escape 关闭。
  - 点击遮罩关闭规则。
  - 焦点回收。
- tab 类控件补齐键盘行为：左右方向键切换、Enter/Space 激活。
- popover/listbox 类控件补齐 Escape 关闭、上下键选择。
- 表单错误和保存状态使用统一 status 容器，并尽量使用 `aria-live="polite"`。
- 新增文案同步维护中英文 JSON，避免中文硬编码混入英文界面。
- 检查中英文切换后长文本、长路径、长 session title、长 model 名是否溢出。

验收重点：纯键盘可完成核心路径：新建会话、发送消息、停止、切换页面、打开文件预览、保存配置。

## 5. 重点重构建议

### 5.1 建立 DOM 契约清单

建议在文档或代码注释中标记“不能轻易改名”的 DOM。第一轮 HTML 整理时，以下元素视为稳定契约，只能补充 class/aria/comment，不直接改 id、删除节点或改变层级语义：

**页面与导航**

- 各 `#page-*` 容器
- `.page`
- `.nav-btn[data-page]`
- `#btn-titlebar-back`
- `#titlebar-meta`
- `#topbar-status-summary`
- `#btn-toggle-right-panel`

**对话与运行时**

- `#messages`
- `#message-input`
- `#btn-send`
- `#btn-stop`
- `#cwd-input`
- `#model-select`
- `#remote-target-select`
- `#remote-mutate-row`
- `#notify-feishu`
- `#agent-status-bar`

**Workspace 与会话操作**

- `#session-workspace`
- `#workspace-tabs`
- `#workspace-panes`
- `#workspace-live-pane`
- `#workspace-focus-mode`
- `#workspace-grid-mode`
- `#btn-session-pin`
- `#btn-session-cwd`
- `#btn-session-rename`
- `#btn-session-delete`

**输入增强能力**

- `#attachments-bar`
- `#quote-preview-bar`
- `#slash-command-panel`
- `#model-pill-popover`
- `#model-pill`
- `#file-input`
- `#btn-attach`

**文件、diff 与右侧面板**

- `#chat-sidebar`
- `#chat-sidebar-resizer`
- `#file-tree-panel`
- `#file-tree-content`
- `#file-preview-panel`
- `#file-preview-content`
- `#diff-preview-panel`
- `#diff-preview-content`
- `#review-panel`
- `#group-member-panel`
- `#agent-add-popover`

**管理页列表与表单**

- Sessions：`#session-list`、`#session-search`、`#sessions-count`
- Artifacts：`#artifacts-content`、`#artifacts-search`、`#artifacts-summary`
- Skills/Agents/MCP：`#skills-list`、`#agents-list`、`#mcp-list`、`#mcp-form-section`
- Gateway：`#gateway-platform-detail-feishu`、`#feishu-gateway-form-status`、`#feishu-gateway-scope-list`
- Memory：`#memory-graph-panel`、`#wiki-graph-canvas`、`#memory-modal-overlay`、`#memory-edit-overlay`
- Scheduled：`#scheduled-task-list`、`#scheduled-daily-field`、`#scheduled-once-field`
- Config/Remote：`#config-tabs`、`#remote-form-section`、`#remote-form-status`

**模态框、浮层与选择器**

- `#agent-modal-overlay`
- `#skill-modal-overlay`
- `#dir-picker-overlay`
- `#file-picker-overlay`
- `#shortcuts-overlay`
- `#cli-install-overlay`
- `#update-overlay`
- `#cwd-context-menu`
- `#session-migrate-overlay`

后续 HTML 美化前先查引用，避免因为改 class/id 导致 JS 静默失效。

### 5.2 显隐状态从 inline style 转为 class

建议统一：

```css
.is-hidden { display: none !important; }
.is-visible { display: block; }
```

JS 中逐步替换：

```js
el.style.display = 'none';
el.style.display = '';
```

为：

```js
setVisible(el, false);
setVisible(el, true);
```

注意：不同元素需要 `flex/grid/block` 时，不应简单使用 `.is-visible`，应由组件原本 CSS 决定显示方式。

### 5.3 动态列表统一事件委托

当前部分渲染函数在 `innerHTML` 后立即 `querySelectorAll(...).forEach(addEventListener)`。这在列表频繁刷新时可读性和性能都不理想。

建议逐步改为：

- 容器初始化时绑定一次 click/keydown。
- 子元素通过 `data-action`、`data-id` 表达操作。
- render 函数只负责输出 HTML。

示例方向：

```html
<button data-action="delete-session" data-session-id="...">...</button>
```

```js
sessionListEl.addEventListener('click', (event) => {
  const actionEl = event.target.closest('[data-action]');
  if (!actionEl) return;
  // 根据 data-action 分发
});
```

### 5.4 API 调用结果统一处理

建议为 POST/GET 建立轻量封装：

- 自动 JSON parse。
- 非 2xx 抛出包含 `error` 的异常。
- 统一 toast/system message 策略。
- 保留局部自定义错误展示能力。

这样可以减少每个模块重复写：

```js
const resp = await fetch(...);
const data = await resp.json();
if (!resp.ok) throw new Error(data.error || resp.statusText);
```

### 5.5 表单读写函数成对出现

对复杂配置表单建议统一形成：

- `readXxxForm()`
- `fillXxxForm(data)`
- `resetXxxForm()`
- `validateXxxForm(data)`（仅用户输入边界需要）

适用模块：

- Feishu Gateway
- MCP Server
- Agent
- Remote Target
- Scheduled Task
- Env Profiles

## 6. 风险与约束

- `app.js` 与 `index.html` 通过大量 id/class 耦合，HTML 改名风险高。
- 当前没有前端自动化测试，任何结构调整都需要手工验证核心流程。
- SSE 流式渲染、workspace 多会话、后台会话预览和 session resume 是高风险区域，不宜在第一轮重构中大改。
- 文件上传、文件预览、引用行号、diff preview 与后端路径安全相关，改动时必须保持 `esc()` 和 URL encode。
- Gateway、Remote、Scheduled 涉及外部系统或定时执行，UI 调整不能改变保存/启用语义。
- i18n key 必须中英文同步，否则切换语言会出现空文案或回退不一致。
- 无构建约束下，不应使用需要打包的模块化语法，除非后续明确改为浏览器原生 ES module 并验证加载顺序。

## 7. 验证清单

启动 `python server.py` 后建议验证：

- 页面加载无控制台错误。
- 暗色/亮色主题切换正常，无首屏闪烁加重。
- 中文/英文切换后 titlebar、sidebar、composer、管理页不溢出。
- 新建会话、恢复会话、发送消息、停止生成正常。
- SSE 流式输出、工具调用折叠、result meta、错误消息展示正常。
- Workspace focus/grid 切换、标签关闭/重命名、后台预览正常。
- 附件上传、拖拽上传、引用消息、slash command、model pill 正常。
- 文件树刷新、搜索、文件预览、行选择引用正常。
- Diff/review 面板可打开、滚动、关闭。
- Sessions 搜索、置顶、改 cwd、重命名、删除正常。
- Artifacts 列表、筛选、搜索、预览正常。
- Skills/Agents/MCP 可浏览、新建、保存、关闭弹窗正常。
- Message Gateway 保存、开关、二维码、scope 列表正常。
- Memory 图谱、导入、整理、新建、查看/编辑弹窗正常。
- Scheduled Tasks 创建、保存、启用/禁用、立即执行、删除正常。
- Config 中 UI 设置、env、remote targets 保存正常。
- 窄屏下 sidebar、chat sidebar、composer、modal 不遮挡主内容。
- 键盘可完成主要操作，Escape 能关闭常见浮层。

## 8. 建议落地顺序

1. 先建立 DOM 契约清单，标记不能改名的 id/class。
2. 清理 HTML 内联样式，迁移到 CSS class，不改 JS 行为。
3. 补齐 button、tab、dialog、popover 的 aria 与键盘语义。
4. 在 `app.js` 内重排功能域代码块，不拆文件、不改逻辑。
5. 引入轻量 DOM/API helper，逐步替换重复模式。
6. 优先改动态列表为事件委托，减少重复绑定。
7. 最后处理高频渲染区域，例如 streaming、workspace preview、file tree filter。

按这个顺序可以先降低结构债务，再逐步优化 JS 复杂度，避免一次性重构影响核心会话体验。
