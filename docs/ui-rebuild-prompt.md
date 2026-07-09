# CC Bridge 桌面端 UI 重构实现提示词

你是一名前端高级工程师和设计工程师。请基于当前仓库实现一次桌面端 UI 重构。

这不是探索任务，而是落地任务。`desktop-ui-preview.html` 的方向已经确认，不要重新设计另一套风格，不要提出替代方案，不要保留旧版视觉语言。你的任务是把真实应用改成这个设计稿的样子，并保证现有功能继续可用。

可以大胆重构前端技术栈，只要最终桌面端安装包是自包含的，用户双击运行时不需要额外安装 Node/npm/前端依赖。

## 设计稿路径

```text
E:/code/cc-bridge/desktop-ui-preview.html
```

## 真实前端文件

重点关注：

- `static/index.html`
- `static/style.css`
- `static/js/*.js`

如果引入前端构建链，也可以新增或调整：

- `package.json`
- `vite.config.*` / `rollup.config.*` / 其它构建配置
- 前端源码目录，例如 `src/`
- 构建产物输出目录
- Electron / desktop 打包配置
- 必要的静态资源服务适配

但必须保证最终桌面端用户不需要额外安装前端依赖。

## 项目背景

这是 CC Bridge，一个 Claude Code / `ccb` 的桌面端 GUI。

当前后端是 Python `server.py`，前端是静态 HTML/CSS/vanilla JS。项目主要目标平台是 Windows 桌面端。

当前 UI 偏旧版“霓虹终端风”，目标是重构成 `desktop-ui-preview.html` 展示的 Calm Developer Console 风格：安静、克制、桌面生产力工具感、适合长时间使用。

## 硬性目标

1. 实际应用界面必须尽量贴近 `desktop-ui-preview.html`。
2. 以 `desktop-ui-preview.html` 为唯一视觉基准。
3. 不允许继续沿用旧版“霓虹终端风”。
4. 不允许重新发散设计另一套 UI。
5. 允许引入前端框架和构建链，但最终桌面程序必须自包含，用户运行时不能额外安装前端依赖。
6. 不允许依赖外部 CDN。
7. 不允许运行时从公网加载 JS、CSS、字体或图标。
8. 不允许破坏现有功能。
9. 不允许为了省事删除功能入口。
10. 不允许只改局部，必须覆盖 titlebar、sidebar、home、chat、right panel、composer、modal/preview 的主要视觉语言。

## 必须先做

1. 读取 `E:/code/cc-bridge/desktop-ui-preview.html`。
2. 读取现有前端结构：
   - `static/index.html`
   - `static/style.css`
   - 与 DOM 选择器、导航、右侧面板、输入框、会话操作相关的 `static/js/*.js`
3. 搜索 JS 中对 DOM id/class 的引用。
4. 在修改前确认哪些 id 被 JS 依赖。
5. 修改 DOM 时必须保留关键 id，或同步修复对应 JS 选择器。

## 必须保留的重要 id / 功能锚点

包括但不限于：

- `model-select`
- `btn-toggle-right-panel`
- `btn-session-pin`
- `btn-session-cwd`
- `btn-session-rename`
- `btn-session-delete`
- `btn-export-chat`
- `btn-shortcuts`
- `btn-theme-toggle`
- `btn-nav-settings`
- `btn-desktop-close`
- `connection-status`
- `cost-display`
- `token-display`
- `page-home`
- `page-chat`
- `session-workspace`
- `workspace-tabs`
- `workspace-panes`
- `messages`
- `input-area`
- `agent-status-bar`
- `file-preview-panel`
- `diff-preview-panel`
- `mobile-sidebar-backdrop`
- `nav-version-badge`

如果发现其它 JS 依赖的 id/class，也必须纳入保留或适配范围。

## 视觉实现要求

### 1. 整体风格

- 使用 `desktop-ui-preview.html` 的 Calm Developer Console 风格。
- 深色主界面，安静、克制、桌面生产力工具感。
- 去掉旧版 cyber / terminal / neon aesthetic。
- 去掉过强 glow、霓虹绿主色、假外框。
- 绿色只用于 connected / success 状态。
- 主强调色使用设计稿中的蓝紫色系。
- 全局 UI 字体使用系统 UI 字体。
- mono 字体只用于代码、路径、命令、日志、token、session id 等技术内容。

### 2. 窗口和标题栏

- 去掉旧版 `body` 透明 10px padding。
- 去掉旧版 `body::before` 假窗口边框。
- 应用窗口应满铺 Electron/浏览器内容区。
- titlebar 高度和样式参考设计稿。
- titlebar 左侧为品牌区域。
- titlebar 中间为连接状态、模型、工作目录/会话摘要。
- titlebar 右侧为统一 SVG icon button。
- 禁止继续使用 `PIN / DIR / EDIT / MD / ? / ⚙` 这种混杂文字/emoji 按钮表现。
- 保留 `title`、`aria-label`、`data-i18n-title` 等能力。

### 3. 侧边栏

- 桌面端默认展开，宽度约 240–264px。
- 不允许默认保持 64px 纯图标 rail。
- 导航必须按组展示：
  - Workspace: Home / Chat / Sessions / Artifacts
  - Extensions: Skills / Tools / Memory / Scheduled
  - System: Integrations / Gateway / Settings 或当前项目对应系统入口
- 每个导航项有统一 SVG icon + 文本。
- active / hover / focus 状态参考设计稿。
- 新建会话按钮放在侧栏顶部，样式参考设计稿。
- Runtime / connection / model 信息可以放在侧栏底部卡片，必须比旧版更清晰。

### 4. Home 页

- Home 页不能继续沿用旧版终端欢迎页。
- 用设计稿同一套视觉语言重做。
- 需要包含：
  - 新建会话主入口
  - 最近会话
  - Runtime 信息
  - 当前 cwd / CLI / model 状态
- 不要使用巨型霓虹标题或终端风装饰。

### 5. Chat 页

- Chat 页必须贴近设计稿结构：
  - 顶部 session header
  - Focus / Grid segmented control
  - messages 区域有更克制的气泡和间距
  - tool card / code block 统一成设计稿风格
  - 底部 composer card 输入框
- composer 必须视觉上独立成卡片。
- 发送按钮、附件/上下文按钮等要有 hover/focus/active 状态。
- messages 区域不要过度边框化，不要霓虹线条。

### 6. 右侧面板

- 右侧 panel 改成设计稿里的 Session Context 风格。
- 但必须适配现有右侧面板功能，不允许删除现有入口。
- 文件预览、diff 预览、artifact、session context 相关面板应使用同一视觉语言。

### 7. Modal / Preview / Toast / Dropdown

- 这些组件也要跟随新 token。
- 不允许主界面换新，弹窗还保持旧终端风。
- 保持可访问性和 `focus-visible`。

### 8. 主题

- 保留现有 light/dark theme 逻辑。
- 暗色是主设计。
- 亮色可以简化，但必须可用、文字对比足够。
- 不要只实现 dark 然后让 light 崩掉。

### 9. 响应式

- 桌面端默认展开侧栏。
- 窄窗口时可收敛成窄侧栏或抽屉。
- 不允许出现横向滚动。
- 小屏交互按钮必须可点。

### 10. i18n

- 保留现有 i18n 机制。
- 新增或变更用户可见文案时，同步更新：
  - `static/i18n/zh.json`
  - `static/i18n/en.json`
- 不要硬编码只支持中文或英文。

### 11. 可访问性

- 所有 icon-only button 必须有 `aria-label`。
- `focus-visible` 必须清晰。
- 不要移除键盘可达性。
- 支持 `prefers-reduced-motion`。
- 主要可点击区域高度至少 32px。
- 核心按钮高度 40–44px。

## 前端技术栈约束

允许引入现代前端框架、构建工具和图标库，但前提是最终桌面程序必须完整打包，用户运行桌面端时不需要额外安装 Node、npm、pnpm、前端依赖或执行构建命令。

### 允许的方向

- React / Vue / Svelte / Solid 等前端框架
- Vite / Rollup / esbuild 等构建工具
- TypeScript
- CSS Modules / PostCSS / Tailwind / UnoCSS 等样式方案
- Lucide / Phosphor / Heroicons 等 SVG 图标库
- 必要的状态管理或 UI 辅助库

### 硬性要求

1. 所有前端依赖必须进入项目构建流程。
2. 最终 Electron / 桌面端打包产物必须自包含。
3. 用户不能为了运行桌面程序额外安装前端依赖。
4. 不允许依赖外部 CDN。
5. 不允许运行时从公网加载 JS、CSS、字体或图标。
6. 如果引入构建流程，必须保证 `start.bat` / `start.ps1` / `bootstrap.py` / 桌面打包流程能够正确处理。
7. 如果当前项目还没有前端构建链，需要同时补齐：
   - `package.json`
   - 构建脚本
   - 静态资源输出目录
   - `server.py` 对构建产物的静态资源服务适配
   - Electron 打包配置对构建产物的包含
8. 开发期可以需要 Node/npm，但发布后的桌面程序不能要求用户安装 Node/npm。
9. 引入框架必须是为了提升可维护性和 UI 落地质量，不要为了重构而重构。
10. 如果只用原生 HTML/CSS/JS 能更快且更稳地完成，也可以继续使用原生方案。

### 优先级

1. 第一优先级：真实应用效果贴近 `desktop-ui-preview.html`
2. 第二优先级：原有功能不丢失
3. 第三优先级：桌面端打包后用户免安装前端依赖
4. 第四优先级：代码结构可维护

不要因为“当前是静态前端”就默认不能引入框架。只要能被打包并随桌面端一起分发，就可以使用。

## 后端和打包约束

- 不要改 `server.py`，除非前端资源引用或构建产物服务确实需要。
- 不要改变后端 API 行为，除非前端重构确实需要且必须保持兼容。
- 不要新增外部运行时依赖给最终用户。
- 不要新增运行时公网资源。
- 不要创建多余文档文件。
- 可以保留 `desktop-ui-preview.html` 作为参考文件，但不要把它接入生产路由。
- 修改应尽量集中在前端 UI、样式、必要的 JS selector 适配和必要构建链。

## 推荐实施顺序

### 第一步：审查

- 读取设计稿。
- 读取现有前端结构。
- 搜索 JS 中对 DOM id/class 的引用。
- 列出必须保留的选择器和会受影响的区域。
- 判断是否需要引入框架；如果引入，说明为什么比原生方案更适合。

### 第二步：重构 CSS token / 设计系统

在 `static/style.css` 或新的前端样式系统中建立新设计 token：

- background / window / sidebar / panel
- border
- text
- primary
- success
- warning
- danger
- radius
- spacing
- shadow
- font

用设计稿 token 替换旧 token。

删除或覆盖旧版 neon / terminal / fake shell 相关样式。

### 第三步：重构 HTML / 组件结构

- 按设计稿改 titlebar。
- 按设计稿改 sidebar。
- 按设计稿改 Home。
- 按设计稿改 Chat header / messages / composer。
- 按设计稿改 right panel。
- 保留 JS 依赖 id，必要时只包一层新结构，不删除锚点。

如果引入框架：

- 组件结构必须清楚。
- 原有 API 调用和 SSE 行为必须迁移完整。
- 构建产物必须能被当前 server / desktop app 加载。

### 第四步：修复 JS 适配

- 修复导航 active 状态。
- 修复 right panel toggle。
- 修复 session 操作按钮。
- 修复 theme toggle。
- 修复 input/composer 高度、发送按钮、附件按钮。
- 修复 mobile sidebar 行为。
- 修复文件预览、diff 预览、artifact、settings、session resume 等入口。

### 第五步：验证

- 启动或静态打开页面检查。
- 浏览器控制台不能有明显 JS 报错。
- dark/light theme 可切换。
- Home / Chat / Sessions / Settings 等主要页面可打开。
- 新建会话、发送消息、右侧面板、文件预览、diff 预览不能被破坏。
- 桌面宽度下视觉应接近 `desktop-ui-preview.html`。
- 如果引入构建链，验证构建命令可运行。
- 验证桌面打包或至少确认构建产物会被打包包含。

## 验收标准

1. 真实应用打开后第一眼应明显接近 `desktop-ui-preview.html`。
2. 旧版霓虹终端风基本消失。
3. 桌面端侧边栏默认展开。
4. 标题栏按钮统一成 SVG icon 风格。
5. Chat 页面、composer、right panel 与设计稿高度一致。
6. Home 页也完成同风格改造。
7. Modal / Preview / Toast / Dropdown 不再保持旧终端风。
8. 原有功能入口保留。
9. 无明显 JS 报错。
10. 不依赖外部 CDN。
11. 最终桌面端用户不需要安装 Node/npm/前端依赖。
12. 代码保持简洁，不做无关重构。

## 最终要求

请直接开始实现，不要再询问是否采用这个方向。

如果你发现 `desktop-ui-preview.html` 和现有功能之间存在冲突，以“视觉尽量贴近设计稿 + 功能不丢失”为准。

如果你必须在视觉还原和功能稳定之间取舍，优先保证功能稳定，但要用最小偏差继续贴近设计稿。
