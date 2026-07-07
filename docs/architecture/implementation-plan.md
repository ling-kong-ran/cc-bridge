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

## 后续验收标准

- 新增功能不再继续扩大 `server.py` 与 `static/app.js`。
- 任一模块迁移后，应保持原 API 路径、响应结构和前端行为不变。
- 迁移前后可通过 `python scripts/verify.py` 或启动 `python server.py` 做基础验证。
