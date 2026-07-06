# CLI 进程模型

CC Bridge 通过 `ccb_bridge.py` 管理 `ccb` / `claude` CLI 子进程。当前实现采用混合进程模型：普通本地会话优先使用持久子进程，复杂动态配置场景回退到 one-shot 子进程。

## 目标

- 普通本地聊天尽量减少 CLI 冷启动成本。
- 远程、MCP、动态运行配置保持隔离，避免持久进程复用错误上下文。
- 保持 CLI 原生 session id 作为真实会话 id。
- 出错时优先向前端推送可见错误，而不是让请求静默失败。

## 进程模式

### 持久子进程模式

普通本地会话优先启动一个长寿命 CLI 进程：

```text
ccb -p --output-format stream-json --verbose --include-partial-messages
```

后续消息通过 stdin 写入同一进程。stdout 仍按 JSONL stream-json 解析。

适用条件由 `CCBSession._can_use_persistent_cli()` 控制，核心约束是：

- 用户侧允许 `prefer_persistent`。
- 当前没有标记为 persistent failed。
- 没有远程目标。
- 没有动态 MCP 配置需求。

### one-shot 子进程模式

以下场景使用每条消息一个 CLI 子进程：

- 远程目标会话。
- 需要动态 MCP 配置的会话。
- 持久进程启动或运行失败后的回退。
- 调用方显式关闭 `prefer_persistent`。

one-shot 模式每次发送都会启动新进程；如果已有 CLI session id，则通过 `--resume <session_id>` 保持多轮上下文。

## 会话连续性

会话连续性不依赖浏览器连接，也不依赖 `client_id`。真实连续性由 CLI 生成的 `session_id` 决定。

流程：

1. CLI 输出事件中包含 `session_id`。
2. `ccb_bridge.py` 捕获到新 `session_id`。
3. bridge 发出合成事件 `session_id_captured`。
4. `server.py` 的事件回调持久化该 session。
5. 后续 one-shot 请求用 `--resume <session_id>` 恢复上下文。

## 持久进程失败回退

持久进程不可用时，`CCBSession` 会：

1. 标记 `_persistent_failed = True`。
2. 推送 `persistent_cli_fallback` system 事件。
3. 对尚未真正开始输出的消息，自动改用 one-shot 重放。

如果消息已经开始输出，则不做自动重放，避免重复执行工具调用或产生重复回答。

## slash command 探测

`discover_slash_commands()` 使用短生命周期 CLI 探测进程：

```text
ccb -p --output-format stream-json --verbose --model <model>
```

该流程只读取 `system/init` 事件，用于获得 slash commands、skills、agents 等动态能力，并带 TTL 缓存。探测完成后会终止进程，并清理探测产生的残留 session jsonl。

## 前端与后端边界

- 前端只关心 SSE 事件，不需要知道当前是 persistent 还是 one-shot。
- `server.py` 负责把 API action 转成 `SessionManager` 调用。
- `ccb_bridge.py` 负责选择进程模式、解析 CLI JSONL、捕获 session id、推送标准事件。

## 迁移注意事项

- 修改 CLI 参数时，要同时检查 persistent 和 one-shot 两条路径。
- 修改 session id 处理时，要保持 `session_id_captured` 事件兼容。
- 新增远程或 MCP 能力时，默认走 one-shot，除非能证明持久复用不会污染配置。
- 前端不要根据 `persistent_cli_fallback` 做核心状态判断，该事件只用于提示和诊断。
