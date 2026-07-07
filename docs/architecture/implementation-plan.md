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
4. 前端优先抽公共基础设施：API 请求、SSE 连接、i18n、workspace。
5. 保持无构建步骤，前端先采用普通脚本加载；需要时再引入 ES modules。
6. 迁移 Python 文件时可以保留根目录兼容 shim，避免一次性修改所有 import。

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
- 新增 `static/js/sse.js`，提供 SSE 创建和 client id 管理基础封装。
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

## 后续验收标准

- 新增功能不再继续扩大 `server.py` 与 `static/app.js`。
- 任一模块迁移后，应保持原 API 路径、响应结构和前端行为不变。
- 迁移前后可通过 `python scripts/verify.py` 或启动 `python server.py` 做基础验证。
