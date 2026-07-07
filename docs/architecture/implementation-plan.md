# CC Bridge 架构落地方案

本文档用于把当前目录结构与代码结构的优化建议落地为可执行的迁移路线。原则是：不中断现有功能、不引入不必要框架、新代码先进新结构，旧代码按风险逐步迁移。

## 当前问题

- 根目录 Python 模块过多，业务边界不清晰。
- `server.py` 同时承载 HTTP、路由、SSE、配置、会话、远程、飞书、记忆、定时任务等职责。
- `static/app.js` 已成为前端单体脚本，状态、DOM、API、SSE、页面逻辑混在一起。
- 部分构建产物、运行产物容易误入仓库。
- CLI 进程模型文档与实际实现存在漂移，需要明确架构约束。

## 目标结构

```text
cc-bridge/
  backend/
    app.py
    http_server.py
    responses.py
    sse.py
    bridge/
    routes/
    services/
    stores/
    integrations/
    scheduler/
    memory/

  static/
    index.html
    css/
    js/
      api.js
      sse.js
      main.js
      chat.js
      sessions.js
      workspace.js
      settings.js
      memory.js

  docs/
    architecture/
    product/
    integrations/
    memory/
    operations/
```

该结构是中期目标，不要求一次迁移完成。

## 迁移原则

1. `server.py` 不继续承载大块新功能；新 API 优先进入 `backend/routes/`。
2. 核心聊天流、SSE 协议、session 持久化最后迁移。
3. 先迁移低耦合模块：memory、wiki、scheduled tasks、artifacts、feishu、remote。
4. 消息网关按可热插拔平台设计，飞书只是首个 provider，后续可接入微信等其他网关；内部新增抽象优先使用 gateway/platform/provider 语义。
5. 前端优先抽公共基础设施：API 请求、SSE 连接、i18n、workspace。
6. 保持无构建步骤，前端先采用普通脚本加载；需要时再引入 ES modules。
7. 迁移 Python 文件时可以保留根目录兼容 shim，避免一次性修改所有 import。

## 阶段计划

### 阶段 1：仓库边界和文档

- 确认 `.gitignore` 覆盖运行产物：`uploads/`、`.gui-uploads/`、`*.log`。
- 确认构建产物不再进入 Git：`release/`、`dist/`。
- 新增 `docs/architecture/`，沉淀架构概览、CLI 进程模型、前端模块化计划。

### 阶段 2：前端模块化起步

先新增 `static/js/`，从低风险公共封装开始：

- `static/js/api.js`：统一 `fetch`、JSON 请求、JSON 响应处理。
- `static/js/sse.js`：统一 client id、EventSource 创建、关闭。

短期为了避免破坏现有全局脚本，模块先挂载到 `window.CCBridge` 命名空间；后续再逐步替换 `app.js` 里的裸 `fetch` 和 `new EventSource`。

### 阶段 3：后端模块化起步

新增 `backend/` 包，但不急于移动核心文件。优先迁移：

1. artifacts routes / service
2. scheduled tasks routes / service
3. memory routes / service
4. wiki routes / service
5. feishu routes / service
6. remote routes / service

### 阶段 4：核心协议文档化

需要补充以下架构文档：

- `docs/architecture/cli-process-model.md`
- `docs/architecture/sse-events.md`
- `docs/architecture/session-persistence.md`
- `docs/architecture/bootstrap-boundary.md`

其中 CLI 进程模型必须明确：

- 哪些场景使用持久子进程。
- 哪些场景使用 one-shot 子进程。
- `--resume <session_id>` 的使用边界。
- session id 捕获与持久化流程。

## 已落地的起步动作

- 新增 `docs/architecture/implementation-plan.md` 作为迁移总纲。
- 新增 `docs/architecture/cli-process-model.md`，明确持久子进程与 one-shot 子进程的边界。
- 新增 `static/js/api.js`，提供前端 API 请求基础封装。
- 新增 `static/js/sse.js`，扩展 SSE 连接、session/run 事件归属判断和 `/api/action` 发送封装，`static/app.js` 保留业务事件处理回调。
- `static/index.html` 先加载上述基础脚本，后续逐步替换 `app.js` 中的重复逻辑。
- 新增 `backend/` 包骨架，开始承接服务层与路由层迁移。
- 新增 `backend/services/settings_service.py`，承接 GUI settings 读取/保存逻辑。
- 新增 `backend/services/context_service.py`，承接自动上下文设置与预览逻辑。
- 新增 `backend/services/scheduled_tasks_service.py`，承接定时任务列表、保存、删除、启停与手动触发逻辑。
- 新增 `backend/routes/scheduled_tasks_routes.py`，开始把定时任务 API 从 `server.py` 分支拆到路由层。
- 新增 `backend/routes/settings_routes.py` 与 `backend/routes/context_routes.py`，把 GUI 设置和自动上下文 API 接入路由层。
- 新增 `backend/responses.py`，开始承接 HTTP 响应写出基础设施。
- 新增 `backend/services/sessions_service.py`，开始承接会话列表运行态标记与分页逻辑。
- 新增 `docs/architecture/sse-events.md`、`docs/architecture/session-persistence.md` 与 `docs/architecture/bootstrap-boundary.md`，补齐核心协议、会话持久化和 bootstrap 边界文档。
- 新增 `backend/services/artifacts_service.py` 与 `backend/routes/artifacts_routes.py`，把资产索引 API 接入服务层和路由层。
- 新增 `backend/services/memory_service.py` 与 `backend/routes/memory_routes.py`，把记忆文件查询、索引、读写、导入和整理 API 接入服务层和路由层。
- 新增 `backend/services/wiki_service.py` 与 `backend/routes/wiki_routes.py`，把全局 Wiki 搜索、节点、图谱、热点、统计、索引和上下文 API 接入服务层和路由层。
- 新增 `backend/services/gateway_service.py` 与 `backend/routes/gateway_routes.py`，按消息网关可热插拔平台方向承接飞书网关配置、二维码、事件、scope 和 onboard API。
- 新增 `backend/services/remote_service.py` 与 `backend/routes/remote_routes.py`，把远程目标配置、连接测试、远程文件浏览和缓存 API 接入服务层和路由层。
- `static/app.js` 开始使用 `window.CCBridge.api` 收敛定时任务、飞书网关、远程目标和远程文件相关 API 调用。
- 新增 `static/js/remote.js`，把远程目标管理页面逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.remote`。
- 新增 `static/js/scheduled-tasks.js`，把定时任务页面逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.scheduledTasks`。
- 新增 `static/js/settings.js`，把主题、语言、字体、通知、局域网访问和上下文偏好相关前端逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.settings`。
- 新增 `static/js/config.js`，把环境变量配置页与 env profile 管理相关前端逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.config`。
- 新增 `static/js/gateway.js`，把消息网关配置、飞书 provider 状态、scope 管理和 onboard 相关前端逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.gateway`。
- 新增 `static/js/integrations.js`，把 MCP server 列表、表单和 integrations 页加载逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.integrations`。
- 新增 `static/js/agent-skills.js`，把 Agent 管理弹窗、Agent 列表渲染和 Skills 列表/详情弹窗逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.agentSkills`。
- 新增 `static/js/right-panel.js`，把右侧面板、文件树、review diff、文件预览和预览浮窗拖拽缩放逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.rightPanel`。
- 新增 `static/js/input.js`，把输入区、附件上传、slash commands、模型胶囊和 @mention 自动补全逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.input`。
- 新增 `static/js/sessions.js`，把会话列表、欢迎页会话、会话操作、cwd 右键菜单和会话迁移弹窗逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.sessions`。
- 新增 `static/js/chat-renderer.js`，把聊天流式渲染、Markdown block 渲染和工具卡片渲染基础逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.chatRenderer`。
- 新增 `static/js/workspace.js`，把 workspace 状态序列化、会话记录归一化、预览文本和面板宽度计算基础逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.workspace`。
- 新增 `static/js/navigation.js`，把页面导航、设置页标签切换和移动端侧栏布局逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.navigation`。
- 新增 `static/js/ui.js`，把可见性切换、display 判断和停止按钮状态更新等通用 UI helper 从 `static/app.js` 拆出并挂载到 `window.CCBridge.ui`。
- 收敛 `static/app.js` 中通用 UI helper wrapper，移除剩余本地可见性和停止按钮 fallback 实现，统一委托 `static/js/ui.js`。
- 新增 `static/js/formatters.js`，把提示摘要、时长、费用、token、模型名和安全 JSON 解析等格式化基础逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.formatters`。
- 新增 `static/js/shortcuts.js`，把快捷键帮助弹窗和全局快捷键分发逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.shortcuts`。
- 收敛 `static/app.js` 中快捷键 wrapper，移除剩余本地快捷键弹窗和全局快捷键分发 fallback 实现，统一委托 `static/js/shortcuts.js`。
- 新增 `static/js/statusbar.js`，把侧栏折叠状态和顶部状态摘要渲染逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.statusbar`。
- 新增 `static/js/desktop-window.js`，把桌面壳窗口关闭按钮初始化逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.desktopWindow`。
- 收敛 `static/app.js` 中桌面壳窗口 wrapper，移除剩余本地关闭按钮初始化 fallback 实现，统一委托 `static/js/desktop-window.js`。
- 新增 `static/js/toast.js`，把 toast 通知创建、关闭和数量限制逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.toast`。
- 收敛 `static/app.js` 中 toast wrapper，移除剩余本地 toast DOM 状态和 fallback 实现，统一委托 `static/js/toast.js`。
- 新增 `static/js/directory-picker.js`，把工作目录选择器的打开、浏览、选择和新建目录逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.directoryPicker`。
- 新增 `static/js/tool-cards.js`，把工具卡片折叠、展开和 Shift 批量切换事件委托从 `static/app.js` 拆出并挂载到 `window.CCBridge.toolCards`。
- 收敛 `static/app.js` 中工具卡片 wrapper，移除剩余本地折叠、展开和事件委托 fallback 实现，统一委托 `static/js/tool-cards.js`。
- 新增 `static/js/config-reload.js`，把窗口聚焦和页面可见时刷新 CLI、模型与配置的逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.configReload`。
- 收敛 `static/app.js` 中配置刷新 wrapper，移除剩余本地窗口聚焦、页面可见和外部配置刷新 fallback 实现，统一委托 `static/js/config-reload.js`。
- 新增 `static/js/file-picker.js`，把附件和记忆导入文件选择器的来源切换、浏览、搜索、多选和远程缓存逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.filePicker`。
- 收敛 `static/app.js` 中文件选择器 wrapper，移除剩余本地 picker 状态和 fallback 实现，统一委托 `static/js/file-picker.js`。
- 收敛 `static/app.js` 中目录选择器 wrapper，移除剩余本地目录 picker 状态和 fallback 实现，统一委托 `static/js/directory-picker.js`。
- 新增 `static/js/cli-update.js`，把 CLI 安装引导和应用自动更新弹窗逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.cliUpdate`。
- 收敛 `static/app.js` 中 CLI 安装引导与自动更新 wrapper，移除剩余本地弹窗、复制、安装、检查和重启轮询 fallback 实现，统一委托 `static/js/cli-update.js`。
- 新增 `static/js/runtime.js`，把 CLI/模型选择、顶部运行态、费用和 token 展示逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.runtime`。
- 收敛 `static/app.js` 中运行时 wrapper，移除剩余本地 CLI/模型加载、CLI 选择、顶部运行态、费用和 token 展示 fallback 实现，统一委托 `static/js/runtime.js`。
- 新增 `static/js/message-extras.js`，把聊天导出、消息引用和引用 payload 归一化逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.messageExtras`。
- 扩展 `static/js/sse.js`，继续承接连接状态展示与 `/api/action` 发送 wrapper，减少 `static/app.js` 的 SSE 基础设施逻辑。
- 扩展 `static/js/chat-renderer.js`，继续承接 Markdown、历史消息和历史工具卡片渲染逻辑，减少 `static/app.js` 的聊天渲染职责。
- 收敛 `static/app.js` 中聊天渲染 wrapper，移除剩余本地 Markdown、工具卡片、流式状态和历史消息渲染 fallback 实现，统一委托 `static/js/chat-renderer.js`。
- 扩展 `static/js/workspace.js`，继续承接后台 session 事件预览文本提取和 workspace 预览更新逻辑。
- 新增 `static/js/task-activity.js`，把 Task subagent 运行状态、状态栏和 subagent 气泡渲染逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.taskActivity`。
- 新增 `static/js/stream-events.js`，把 assistant stream event 对当前回复块、workspace 预览和 Task 注册的状态推进逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.streamEvents`。
- 新增 `static/js/message-ui.js`，把 assistant/user/system 消息 DOM 创建和上下文注入追踪渲染逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.messageUi`。
- 收敛 `static/app.js` 中消息 UI wrapper，移除剩余本地消息气泡、系统消息和上下文追踪 fallback 实现，统一委托 `static/js/message-ui.js`。
- 新增 `static/js/completion-sync.js`，把后台 session 完成后的历史延迟同步逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.completionSync`。
- 新增 `static/js/turn-timer.js`，把 assistant 回复耗时 meta 更新和 turn timer 管理逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.turnTimer`。
- 新增 `static/js/notifications.js`，把页面失焦判断和完成通知创建逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.notifications`。
- 新增 `static/js/stream-state.js`，把 workspace tab 流式状态保存、恢复和 assistant stream 状态重置逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.streamState`。
- 收敛 `static/app.js` 中 stream-state wrapper，移除剩余本地流式状态保存、恢复和重置 fallback 实现，统一委托 `static/js/stream-state.js`。
- 新增 `static/js/history-loader.js`，把会话历史加载、刷新和静态历史渲染状态保护逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.historyLoader`。
- 新增 `static/js/localization.js`，把语言切换、语言包加载和本地化文本渲染逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.localization`。
- 扩展 `static/js/formatters.js`，继续承接时间、HTML 转义、路径缩短和链接安全处理等文本工具逻辑，减少 `static/app.js` 的通用格式化职责。
- 扩展 `static/js/runtime.js`，继续承接运行态摘要和输入区 CLI/CWD 状态渲染逻辑，减少 `static/app.js` 的运行态展示职责。
- 新增 `static/js/session-agents.js`，把会话 Agent 成员加载、增删、成员面板渲染和添加弹窗逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.sessionAgents`。
- 收敛 `static/app.js` 中会话 Agent 面板 wrapper，移除剩余本地 Agent 状态和 fallback 实现，统一委托 `static/js/session-agents.js`。
- 新增 `static/js/message-scroll.js`，把消息区跟随输出、底部距离判断和滚动调度逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.messageScroll`。
- 收敛 `static/app.js` 中消息滚动 wrapper，移除剩余本地滚动状态和 fallback 实现，统一委托 `static/js/message-scroll.js`。
- 新增 `static/js/main-ui.js`，把主界面发送/停止按钮、会话激活态、输入框占位和基础控件禁用状态刷新逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.mainUi`。
- 收敛 `static/app.js` 中主界面 UI wrapper，移除剩余本地控件状态刷新 fallback 实现，统一委托 `static/js/main-ui.js`。
- 新增 `static/js/session-control.js`，把新会话启动、会话视图状态重置和从 cwd 创建会话逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.sessionControl`。
- 收敛 `static/app.js` 中会话控制 wrapper，移除剩余本地新会话启动和视图重置 fallback 实现，统一委托 `static/js/session-control.js`。
- 新增 `static/js/message-send.js`，把消息发送、发送失败回滚、slash command 识别和当前运行中断逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.messageSend`。
- 收敛 `static/app.js` 中消息发送 wrapper，移除剩余本地发送、回滚、slash command 和 interrupt fallback 实现，统一委托 `static/js/message-send.js`。
- 收敛 `static/app.js` 中结果处理 wrapper，移除剩余本地 assistant turn 收尾、费用/token 累计和 slash command 完成提示 fallback 实现，统一委托 `static/js/result-handler.js`。
- 新增 `static/js/result-handler.js`，把 assistant turn 完成后的结果收尾、费用/token 累计、完成通知和 slash command 完成提示逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.resultHandler`。
- 新增 `static/js/welcome-runtime.js`，把欢迎页运行时选择器渲染和选择同步逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.welcomeRuntime`。
- 收敛 `static/app.js` 中欢迎页运行时 wrapper，移除剩余本地选择器渲染和变更同步 fallback 实现，统一委托 `static/js/welcome-runtime.js`。
- 新增 `static/js/session-resume.js`，把会话恢复、历史预加载和 cwd 失效重试逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.sessionResume`。
- 收敛 `static/app.js` 中会话恢复 wrapper，移除剩余本地恢复状态重置、历史预加载和 cwd 失效重试 fallback 实现，统一委托 `static/js/session-resume.js`。
- 新增 `static/js/session-cwd.js`，把会话 cwd 错误识别、目录重选和 cwd 持久化更新逻辑从 `static/app.js` 拆出并挂载到 `window.CCBridge.sessionCwd`。
- 收敛 `static/app.js` 中会话 cwd wrapper，移除剩余本地 cwd 错误识别、目录重选和持久化更新 fallback 实现，统一委托 `static/js/session-cwd.js`。
- 扩展 `static/js/workspace.js`，继续承接 workspace pane resizer 创建、拖拽状态更新和宽度保存逻辑，减少 `static/app.js` 的 workspace 交互职责。
- 扩展 `static/js/workspace.js`，继续承接 workspace tabs 事件绑定和标签页渲染逻辑，减少 `static/app.js` 的 workspace 标签页职责。
- 扩展 `static/js/workspace.js`，继续承接 workspace 主面板和快照面板渲染逻辑，减少 `static/app.js` 的 workspace 面板 DOM 职责。
- 扩展 `static/js/sse.js`，继续承接 session started/stopped/taken 和 viewer 用户消息等 SSE 会话生命周期事件处理逻辑。
- 收敛 `static/app.js` 中 SSE 连接、会话事件过滤、连接状态、action 发送和基础会话生命周期 wrapper，移除剩余本地 fallback 实现，统一委托 `static/js/sse.js`。

## 后续验收标准

- 新增功能不再继续扩大 `server.py` 与 `static/app.js`。
- 任一模块迁移后，应保持原 API 路径、响应结构和前端行为不变。
- 迁移前后可通过 `python scripts/verify.py` 或启动 `python server.py` 做基础验证。
