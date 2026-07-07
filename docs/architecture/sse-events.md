# SSE 事件协议

CC Bridge 使用 Server-Sent Events 把 CLI 运行事件从后端推送到浏览器。SSE 是刻意选择的传输层：项目主要面向 Windows，SSE 比 WebSocket 更少依赖事件循环和第三方库，同时足够承载单向流式输出。

## 连接入口

```text
GET /sse?id=<client_id>
```

- `client_id` 由前端生成并保存在 `sessionStorage`。
- 后端用 `sse_clients[client_id] = asyncio.Queue()` 维护推送队列。
- 同一个 `client_id` 重连时会替换旧队列，并尽量恢复正在运行的会话状态。
- 心跳格式为 SSE 注释行：`: heartbeat`，默认约 15 秒一次。

## 事件格式

每条事件按标准 SSE 写出：

```text
event: <event_name>
data: <json>

```

`data` 始终是 JSON 对象，使用 UTF-8 编码。

## 基础连接事件

### connected

SSE 建立后立即发送。

```json
{"client_id":"c_xxxxxxxx"}
```

前端用它确认当前连接归属。

## 会话生命周期事件

### session_started

会话启动、恢复或 viewer 重连到 owner 会话时发送。

常见字段：

- `model`：当前模型。
- `resumed`：是否恢复已有 CLI session。
- `session_id`：CLI 原生 session id。
- `remote_target_id`：远程目标 id，空字符串表示本地。
- `cli`：当前 CLI 路径或名称。
- `cwd`：当前工作目录。
- `viewing`：当前客户端是否为 viewer。
- `run_id`：后端本轮运行 id。

### session_id_captured

`ccb_bridge.py` 从 CLI 输出中捕获真实 `session_id` 后合成该事件。后端收到后会同步持久化 session 元数据。

### session_stopped

会话被停止、LAN 访问被撤销或后端主动清理时发送。

### session_taken

viewer/owner 关系变化时发送，用于提示某个会话已被接管或切换查看状态。

### session_lock_changed

同一会话被某个客户端占用生成时广播。

常见字段：

- `session_id`
- `locked`
- `holder_id`
- `is_holder`

## 生成状态事件

### generation_started

用于刷新、重连或接管后恢复前端“正在生成”状态。

字段来自 `CCBSession.current_generation_state()`，通常包含：

- `running`
- `session_id`
- `run_id`
- `started_at`

### assistant

CLI 输出的助手消息事件。前端根据内容追加聊天气泡或流式文本。

### stream_event

CLI 原始流式事件中需要透传给前端的事件。用于保留更细粒度的运行状态。

### user_message

某个客户端在共享会话中发送或补充发送用户消息时，广播给同会话其他客户端。

### tool_result

从 CLI `user` 事件中提取工具调用结果后合成，用于前端展示工具返回。

### result

一轮 CLI 运行完成后的结果事件。后端会读取其中的费用和 token 用量，累加到 session 总成本后再推送。

常见增强字段：

- `session_total_cost_usd`
- `session_total_tokens`

### process_ended

one-shot 子进程结束时发送。持久进程模式下，一轮完成不一定有该事件，前端不应只依赖它判断回答结束，应同时处理 `result`。

### error

运行错误或访问状态变化。所有可见错误都应通过该事件显示到聊天界面。

## 配置与上下文事件

### model_changed

运行中切换模型时发送。

### cwd_changed

会话工作目录被更新后发送给 owner 和 viewer。

### context_injected

自动上下文召回完成后发送，包含 trace，便于前端展示注入来源、token 预算和跳过原因。

### memory_consolidation_started / memory_consolidation_completed / memory_consolidation_failed

自动记忆沉淀任务状态事件。

### scheduled_task_updated

定时任务增删改、启停后广播，用于刷新任务列表。

## 转发与过滤边界

- `ccb_bridge.py` 负责解析 CLI JSONL 并产生标准事件。
- `server.py` 负责把事件推送到 owner 和 viewer。
- 后端不会把所有 CLI 内部事件无条件透传给前端，只转发前端需要展示或维护状态的事件。
- viewer 事件通过 `forward_viewer_event()` 统一补齐 `session_id` 和 `run_id`。

## 迁移注意事项

- 新增前端可见事件时，应保持 `data` 为 JSON 对象。
- 修改 `result` 处理时，不能破坏费用累加和 `session_total_*` 字段。
- 不要让前端依赖 `process_ended` 作为唯一结束信号；持久进程模式通常以 `result` 表示一轮完成。
- SSE 断开不代表会话停止，后端应保留会话运行态以支持重连。
