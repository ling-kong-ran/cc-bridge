# 会话持久化模型

CC Bridge 的会话连续性以 Claude Code CLI 生成的原生 `session_id` 为准。浏览器 `client_id` 只表示当前页面连接，不是长期会话标识。

## 持久化位置

| 数据 | 位置 | 说明 |
|------|------|------|
| GUI 会话索引 | `~/.claude/gui_sessions.json` | GUI 维护的标题、cwd、模型、费用、pin 等元数据 |
| 隐藏会话列表 | `~/.claude/gui_hidden_sessions.json` | GUI 删除会话时记录隐藏 id，避免本地 jsonl 重新冒出 |
| CLI 原生 transcript | `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl` | Claude Code CLI 写出的原始会话记录 |
| GUI 设置 | `~/.ccb/gui_settings.json` | 语言、主题、访问设置等 |

## session id 捕获流程

1. 前端通过 `/api/action` 创建或恢复会话。
2. `server.py` 创建 `CCBSession` 并绑定本轮 `run_id`。
3. CLI 输出 JSONL 事件。
4. `ccb_bridge.py` 从任意事件中识别新 `session_id`。
5. bridge 发出合成事件 `session_id_captured`。
6. `server.py` 在事件回调中调用 `save_session()` 写入 GUI 会话索引。
7. 后续恢复会话时通过 `--resume <session_id>` 交给 CLI 维护上下文连续性。

## GUI 会话索引

`session_store.py` 负责 `~/.claude/gui_sessions.json` 的读写。

核心字段：

- `session_id`：CLI 原生 session id。
- `title`：GUI 展示标题，默认来自最近用户消息。
- `manual_title`：手动重命名后阻止自动标题覆盖。
- `model`：最近使用的模型。
- `cwd`：会话工作目录。
- `cli`：使用的 CLI 路径或名称。
- `remote_target_id`：远程目标 id。
- `total_cost_usd`：GUI 累加费用。
- `total_tokens`：GUI 累加 token 用量。
- `pinned`：侧边栏置顶状态。
- `scheduled_task_id` / `scheduled_task_name`：定时任务生成的会话来源。

## 本地 CLI transcript 发现

`list_sessions()` 不只读取 GUI 索引，还会扫描 `~/.claude/projects` 下的 CLI 原生 jsonl：

1. 读取 GUI 索引。
2. 补齐历史记录缺失的费用和 token 字段。
3. 扫描 CLI transcript。
4. 过滤没有真实用户消息的探测会话。
5. 按 `session_id` 合并 GUI 元数据与 CLI 元数据。
6. 按 pinned 和 mtime 排序。

这使得即使某些会话不是由 GUI 创建，只要 CLI transcript 存在，也可以出现在 GUI 会话列表中。

## cwd 与项目目录映射

CLI transcript 位于 `~/.claude/projects/<sanitized-cwd>/`。`<sanitized-cwd>` 使用与 Claude Code CLI 一致的路径清洗规则：把非字母数字字符替换为 `-`。

维护要求：如果 CLI 的 sanitizePath 规则变化，`session_store.py` 中的 `_sanitize_cwd` 也必须同步。

## 运行态与持久态边界

持久态只记录可跨进程恢复的信息；以下运行态只存在于 `server.py` 内存中：

- `client_session_ids`：client 当前关联的 session id。
- `client_meta`：client 当前 model/cwd/cli/remote 参数。
- `session_owner`：session 当前 owner client。
- `client_viewing`：viewer 到 owner 的映射。
- `session_locks`：当前生成占用状态。
- `session_run_ids`：session 当前运行中的 run id。

这些运行态用于 SSE 重连、viewer 转发和占用锁，不应写入 `gui_sessions.json`。

## 费用与 token 累加

`result` 事件中包含本轮费用和 token 用量。后端收到后：

1. 调用 session store 累加到 GUI 会话索引。
2. 把累计后的 `session_total_cost_usd` 和 token 汇总附加回 SSE `result` 事件。
3. 前端展示本轮结果和会话累计值。

## 删除、隐藏与重激活

GUI 删除会话时不会删除 CLI 原生 transcript，而是把 `session_id` 写入隐藏列表。这样可以避免误删用户的 Claude Code 原始记录。

当同一个 `session_id` 再次被保存时，会从隐藏列表移除，相当于重激活。

## 迁移注意事项

- 不要用浏览器 `client_id` 替代 CLI `session_id` 做长期持久化。
- 修改会话列表时要同时考虑 GUI 索引和 CLI transcript 发现结果。
- 删除 GUI 会话默认应隐藏而不是删除原始 jsonl。
- 修改 cwd 更新流程时，要同步 owner 和 viewer 的运行态 `client_meta`。
- 修改费用字段时，要兼容旧索引中不存在 `total_cost_usd` / `total_tokens` 的记录。
