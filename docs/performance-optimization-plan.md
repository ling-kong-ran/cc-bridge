# cc-bridge 性能优化方案

## 1. 背景与目标

cc-bridge 是一个面向 Windows 的轻量 Web GUI：后端以 Python 标准库手写 HTTP/SSE/REST 服务，前端为静态 HTML/CSS/vanilla JavaScript，无构建步骤。请求链路为：浏览器 → `server.py` → `ccb_bridge.py` → `ccb`/`claude` CLI，流式结果通过 SSE 返回前端。

本文基于当前代码梳理性能瓶颈和可落地优化点，目标是：

- 降低大目录、大会话、多客户端、长输出时的卡顿和内存占用。
- 减少事件循环线程上的同步 IO，避免单个慢请求阻塞所有用户操作。
- 控制 SSE 与 CLI partial 事件带来的渲染压力。
- 优化会话历史、文件搜索、日志与持久化读写的放大效应。
- 在不引入复杂构建体系的前提下，保持实现简单、可回滚、适合 Windows。

## 2. 总体瓶颈概览

| 优先级 | 模块 | 主要瓶颈 | 典型影响 |
|---|---|---|---|
| P0 | `server.py` HTTP/SSE | async handler 内同步文件扫描/JSON 读写；SSE 队列无上限 | 大目录搜索或慢客户端导致整体响应变慢、内存上涨 |
| P0 | `static/app.js` | 流式输出每帧重建整条消息 `innerHTML`；滚动和 Markdown 全量处理 | 长回复越输出越卡，CPU 占用升高 |
| P0 | `session_store.py` | 会话列表、历史、最后用户消息全量扫描 JSONL | 会话多或历史大时列表/恢复慢 |
| P1 | `ccb_bridge.py` | CLI 事件过细、partial 事件过频；stdout 逐行 JSON 解析并即时广播 | 后端/前端事件风暴，长输出压力大 |
| P1 | 文件/目录搜索 | `os.walk` 同步递归，缺少取消/限时/分页 | 搜索大仓库阻塞事件循环 |
| P1 | 持久化 | 多处读列表即写文件、重复读写完整 JSON | 后台轮询造成磁盘写放大 |
| P2 | 观测与后台任务 | 缺少慢请求、事件队列、渲染耗时指标 | 难以确认优化收益和定位回归 |

## 3. 分阶段路线

### 3.1 P0：低风险快速优化

1. 为 SSE 队列设置上限和丢弃/合并策略。
2. 将本地文件浏览、文件搜索、会话历史读取等阻塞 IO 移入 executor 或增加异步分片。
3. 前端流式渲染改为按文本增量追加，避免每帧重建整条 assistant 消息。
4. `session_store.py` 增加轻量缓存，避免会话列表请求反复扫描 JSONL。
5. `scheduled_task_store.list_tasks()` 改为只读不写，只有数据实际变更时落盘。

### 3.2 P1：中期结构优化

1. 为会话 JSONL 建立元数据索引或 sidecar 缓存。
2. 文件搜索增加分页、取消、超时和最大扫描节点数。
3. CLI 事件流做节流/合并，尤其是 partial assistant 文本事件。
4. 配置、skills、agents、MCP 等文件扫描按 mtime 缓存。
5. 日志改为轮转、分级和批量/复用 handler，避免每条日志 open/write/close。

### 3.3 P2：深度优化与观测体系

1. 增加慢请求日志、SSE 队列长度、事件吞吐、JSONL 读取耗时等指标。
2. 长历史加载支持按时间/消息 ID 游标分页、反向读取末尾消息。
3. 前端消息列表虚拟化，支持超长会话仍保持稳定帧率。
4. 后台任务、飞书网关、远程管理统一使用受控并发队列。

## 4. 后端 HTTP/SSE 优化

### 4.1 将阻塞 IO 从事件循环线程移出

- 问题表现：访问 `/api/search-files`、`/api/sessions/history`、`/api/sessions` 或浏览大目录时，其他 HTTP/SSE 请求可能同步变慢。
- 原因/涉及模块：`server.py` 的 async HTTP handler 内直接调用同步函数，例如 `browse_files()`、`search_files()`、`list_sessions()`、`load_session_history()`；这些函数内部使用 `os.listdir`、`os.walk`、JSON 文件读写、JSONL 逐行解析。
- 建议方案：
  - 短期：参照远程文件接口已有写法，对本地重 IO 路由使用 `asyncio.get_event_loop().run_in_executor(None, ...)` 或 `asyncio.to_thread(...)`。
  - 对可能耗时较长的任务增加超时，例如文件搜索 5-10 秒，历史加载 3-5 秒。
  - 返回 JSON 中包含 `truncated`、`timeout`、`scanned_count` 等字段，让前端提示“结果已截断”。
- 验证方式：
  - 准备一个包含数万文件的目录，触发搜索时同时发送 `/api/status` 或保持 SSE 输出，确认 UI 不冻结。
  - 记录接口耗时 P50/P95 和事件循环是否出现明显阻塞。
- 风险/注意事项：
  - executor 线程数需要受控，避免多个大搜索同时耗尽线程。
  - 放入线程后仍需保留路径穿越防护和目录排除规则。

### 4.2 限制请求体和上传内存峰值

- 问题表现：上传或大请求会一次性读取完整 body，可能造成内存峰值上升。
- 原因/涉及模块：`server.py` 的 `handle_http()` 根据 `content-length` 使用 `readexactly(content_length)` 一次性读入内存；`/api/upload` 手动解析 multipart。
- 建议方案：
  - 保持现有 `MAX_REQUEST_BODY_BYTES` 限制，并按路由设置更细粒度上限。
  - 中期可将上传改为分块写临时文件，再做 multipart 边界解析，避免完整文件留在内存。
- 验证方式：
  - 用接近上限和超过上限的文件测试上传，观察内存和 413 响应。
- 风险/注意事项：
  - 分块 multipart 解析容易引入边界处理 bug，建议先保留全量读取但收紧上限。

### 4.3 SSE 队列上限与慢客户端保护

- 问题表现：浏览器标签页休眠、网络慢或前端处理不过来时，后端队列可能持续增长，内存上涨。
- 原因/涉及模块：`handle_sse()` 为每个客户端创建 `asyncio.Queue()`，没有 `maxsize`；`_sse_write()` 每条事件单独 `json.dumps`、`writer.write`、`drain`。
- 建议方案：
  - 将队列改为有界，例如 `asyncio.Queue(maxsize=500)`。
  - 对可合并的 assistant partial 事件使用“保留最新”或按时间窗口合并；对非关键进度事件可丢弃旧事件。
  - 队列满时发送一次 `system`/`error` 提示或主动断开慢客户端。
  - 对同一 loop tick 内的多条事件批量写入，减少 `drain()` 次数。
- 验证方式：
  - 模拟前端断点暂停或限速网络，观察 `sse_clients` 队列长度和进程内存。
  - 长输出场景下比较事件数、写入次数和 UI 可用性。
- 风险/注意事项：
  - 不能丢弃 `session_id_captured`、`result`、`process_ended`、`error` 等关键事件。
  - 合并事件要保证最终文本完整且顺序正确。

## 5. CLI 子进程与事件流优化

### 5.1 控制 partial 事件风暴

- 问题表现：长回复时后端频繁解析 JSONL、转发 SSE，前端频繁渲染，CPU 占用升高。
- 原因/涉及模块：`ccb_bridge.py` 使用 `--include-partial-messages`，`_stream_output()` 逐行 `json.loads()` 后立即 `_emit_event()`；前端每个流事件都会进入调度。
- 建议方案：
  - 在 `ccb_bridge.py` 或 `server.py` 中对 assistant partial 文本按时间窗口合并，例如 50-100ms 或累计 2-4KB 再发。
  - 保留工具调用、错误、结果等结构化事件即时发送。
  - 增加配置开关：低延迟模式保持当前行为，默认模式启用节流。
- 验证方式：
  - 同一长 prompt 下统计 SSE event 数、前端 `renderCurrentState()` 调用次数、总耗时。
  - 用户体感上首字延迟不明显增加，长输出不卡顿。
- 风险/注意事项：
  - 节流会略微降低 token 级实时感。
  - 必须处理进程结束时 flush 剩余 partial 文本。

### 5.2 稳定持久 CLI 与一次性 CLI 的选择策略

- 问题表现：一次性 CLI 每条消息都启动子进程，启动成本高；持久 CLI fallback 失败会额外带来重试成本。
- 原因/涉及模块：`CCBSession.send_message()` 优先持久进程，异常后 `_persistent_failed=True` 并 fallback 到 `_send_one_shot_message()`；远程/MCP/动态配置场景使用一次性进程。
- 建议方案：
  - 记录持久进程启动、首 token、失败原因和 fallback 次数。
  - 对已知不适合持久模式的配置提前判定，避免先失败再 fallback。
  - 对一次性进程复用可复用参数构造、环境变量和 agent 配置缓存。
- 验证方式：
  - 比较普通本地会话连续 5 轮的平均首 token 延迟。
  - 统计 fallback 频率，确认失败场景不反复尝试。
- 风险/注意事项：
  - CLI 行为可能随版本变化，持久模式策略需保留开关和降级路径。

### 5.3 stderr 与 subprocess buffer 控制

- 问题表现：异常或 verbose 输出过多时，stderr 累积和大 buffer 会增加内存占用。
- 原因/涉及模块：`ccb_bridge.py` 中 subprocess stdout/stderr 使用较大 limit，stderr 收集到 list。
- 建议方案：
  - stderr 只保留末尾 N KB，用 ring buffer 替代无限 list。
  - 将 20MB buffer limit 调整为可配置或按场景降低。
- 验证方式：
  - 构造 CLI 错误输出较多的场景，观察内存和最终错误信息是否足够诊断。
- 风险/注意事项：
  - 截断 stderr 可能减少排障信息，应在错误中标注“已截断”。

## 6. 会话历史读取优化

### 6.1 会话列表避免全量 JSONL 扫描

- 问题表现：会话多时打开侧边栏或刷新会话列表变慢。
- 原因/涉及模块：`session_store.list_sessions()` 读取 GUI index 后，对每个 indexed session 调用 `get_last_user_message()`；该函数会扫描对应 JSONL。`discover_local_sessions()` 还会遍历 `~/.claude/projects` 下所有 `.jsonl`。
- 建议方案：
  - 在 `gui_sessions.json` 中缓存 `last_user_message`、`last_message_at`、`jsonl_mtime`、`jsonl_size`。
  - 只有当 JSONL 的 mtime/size 变化时才重新解析。
  - `/api/sessions` 真正按 offset/limit 在后端分页，避免先构造全部详细项。
- 验证方式：
  - 准备 500+ 会话，比较 `/api/sessions?limit=50` 耗时和 JSONL 打开次数。
- 风险/注意事项：
  - 缓存可能与 CLI 原生会话不同步，需要 mtime/size 校验和手动刷新入口。

### 6.2 历史加载改为末尾读取和分页

- 问题表现：恢复大历史时，后端全量扫描 JSONL 后仅返回最后 50 条，浪费 IO 和 CPU。
- 原因/涉及模块：`load_session_history(session_id, cwd, max_messages=50)` 逐行解析完整 JSONL，最后 `messages[-max_messages:]`。
- 建议方案：
  - 短期：只保留最近 N 条消息的 deque，避免构建完整 messages 列表。
  - 中期：从文件尾部反向按块读取，找到足够 JSONL 行后再解析。
  - 长期：维护 session sidecar 索引，记录消息 offset、timestamp、role，支持游标分页。
- 验证方式：
  - 使用 10MB/100MB JSONL 测试历史加载耗时、内存峰值和返回正确性。
- 风险/注意事项：
  - JSONL 行可能包含多字节字符，反向读取需按 bytes 分块并正确解码。
  - sidecar 索引需要处理文件截断、重写和损坏恢复。

### 6.3 `_find_jsonl_path()` 建立 session_id 到路径的映射

- 问题表现：cwd 缺失或路径变化时查找会话历史需要扫描所有项目目录。
- 原因/涉及模块：`_find_jsonl_path()` 找不到精确路径时 fallback 遍历 `PROJECTS_DIR` 下项目目录。
- 建议方案：
  - 在 session index 中保存 `jsonl_path` 或 `project_dir`。
  - discovery 时维护 `session_id -> path` 缓存，并按 mtime 定期刷新。
- 验证方式：
  - 删除 cwd 参数或改名工作目录后加载历史，统计目录遍历次数。
- 风险/注意事项：
  - 绝对路径跨机器不可移植，存储时可同时保存 cwd 和 project dir 名称。

## 7. 前端渲染与滚动优化

### 7.1 流式消息增量渲染

- 问题表现：长输出越到后面越卡，浏览器主线程占用升高。
- 原因/涉及模块：`static/app.js` 中 `renderCurrentState()` 虽使用 `requestAnimationFrame` 合并，但每帧仍对当前 assistant 消息执行 Markdown 渲染并 `el.innerHTML = html`，导致整段 DOM 重建。
- 建议方案：
  - 将 assistant 文本分为稳定块和当前增量块，只对新增片段追加 text node 或局部 HTML。
  - Markdown 渲染分两阶段：流式阶段使用轻量纯文本/基础转义，最终 `process_ended` 或 `result` 后再完整 Markdown 渲染一次。
  - 工具卡片和文本内容分离，避免文本更新时重建工具 DOM。
- 验证方式：
  - 生成 1万/5万/10万字符输出，记录 FPS、长任务数量、渲染函数耗时。
- 风险/注意事项：
  - 增量 Markdown 容易在代码块、列表、表格未闭合时显示不一致；最终重渲染可修正。

### 7.2 滚动跟随节流与用户意图保护

- 问题表现：长输出期间频繁读取 `scrollHeight` 和执行 `scrollTo`，可能触发布局计算；用户向上查看时可能被强制拉回底部。
- 原因/涉及模块：`scrollToBottom()` 在渲染后按 rAF 调度滚动，依赖 `followMessageOutput`。
- 建议方案：
  - 仅当用户距离底部小于阈值时自动跟随。
  - 将滚动频率限制到 100-200ms，或与渲染 batch 合并。
  - 使用 CSS `overflow-anchor` 或底部 sentinel 判断是否在底部。
- 验证方式：
  - 长输出时向上滚动查看历史，确认不会被拉回；同时底部跟随仍顺滑。
- 风险/注意事项：
  - 过度节流可能导致输出底部跟随不及时。

### 7.3 会话列表和历史列表减少全量重绘

- 问题表现：会话多时搜索、切换、更新标题会导致列表整体 `innerHTML` 重建并重新绑定监听器。
- 原因/涉及模块：`renderSessionList()` 使用 `filtered.map(...).join('')` 重建列表，然后 `querySelectorAll` 逐项绑定点击事件；历史渲染也一次性构造全部 DOM。
- 建议方案：
  - 会话列表改为事件委托，只在容器绑定一次 click。
  - 对列表项按 session_id 局部更新；会话很多时增加虚拟列表或分页加载更多。
  - 历史消息分批插入，例如每批 20 条，避免单次长任务。
- 验证方式：
  - 500+ 会话下输入搜索关键字，比较输入延迟和重绘耗时。
- 风险/注意事项：
  - 局部更新需避免 selected 状态、未读状态与缓存不一致。

## 8. 文件/目录搜索优化

### 8.1 搜索增加取消、分页、扫描预算

- 问题表现：在大仓库根目录搜索时可能长时间占用后端，用户无法取消。
- 原因/涉及模块：`server.py.search_files()` 使用同步 `os.walk`，只按结果数 `max_results=200` 截断，不限制扫描目录/文件数量和时间。
- 建议方案：
  - 为搜索请求分配 `search_id`，前端新搜索开始时取消旧搜索。
  - 增加扫描预算：最大文件数、最大目录数、最大耗时。
  - 返回分页/游标，优先返回当前层或较浅层命中。
  - 保留并扩展排除目录：`.git`、`node_modules`、`__pycache__`、`venv`、`.venv` 等。
- 验证方式：
  - 在包含 `node_modules` 和大量生成文件的目录搜索，确认能快速返回并标注截断。
- 风险/注意事项：
  - 取消 executor 中的同步 `os.walk` 不一定能立即停止，可通过共享取消标志在循环中检查。

### 8.2 文件预览和类型判断缓存

- 问题表现：反复预览同一文件或大文本文件时重复读取和解码。
- 原因/涉及模块：`server.py` 文件预览读取最多 512KB 并判断文本/二进制，未缓存。
- 建议方案：
  - 对文件预览按 path + mtime + size 做短 TTL LRU 缓存。
  - 对超过阈值的文件只返回首段和“文件过大”提示。
- 验证方式：
  - 多次点击同一文件，观察磁盘读取次数和响应时间。
- 风险/注意事项：
  - 缓存必须使用 mtime/size 校验，避免显示旧内容。

## 9. 日志与持久化优化

### 9.1 日志分级与轮转

- 问题表现：长期运行后 `~/.ccb/server.log` 或 `ws_debug.log` 增长，写入频繁；飞书 WebSocket debug 每条日志 open/write/close。
- 原因/涉及模块：`server.py` 使用 DEBUG FileHandler；`feishu_gateway.py.ws_log()` 每次打开仓库目录下 `ws_debug.log` 追加。
- 建议方案：
  - 使用 `logging.handlers.RotatingFileHandler`，限制单文件大小和备份数。
  - `ws_debug.log` 改为标准 logger，复用 handler；默认 INFO，debug 通过配置开启。
  - 避免在仓库目录写运行日志，统一写入 `~/.ccb/`。
- 验证方式：
  - 高频飞书事件下观察文件大小、句柄使用和写入耗时。
- 风险/注意事项：
  - 降低日志级别可能影响问题定位，需要保留临时开启 debug 的方式。

### 9.2 减少 JSON 持久化写放大

- 问题表现：后台空闲时也持续写磁盘，或单个事件造成多次完整 JSON 读写。
- 原因/涉及模块：`scheduled_task_store.list_tasks()` 每次读取后都会 `_write_raw(data)`；`ScheduledTaskRunner` 每 5 秒调用一次；`feishu_gateway_store.is_event_processed()` 和 `mark_event_processed()` 分别读/写完整配置。
- 建议方案：
  - `list_tasks()` 改为纯读，只有 normalize 后内容确实变化才写回，或迁移写回到显式保存路径。
  - 定时任务 runner 根据最近 `next_run_at` 动态 sleep，避免固定 5 秒全量扫描。
  - 飞书 processed events 放入内存 LRU + 周期 flush，或一次处理内完成读改写。
- 验证方式：
  - 空闲运行 10 分钟，统计 `cron_jobs.json` 写入次数应接近 0。
  - 高频飞书事件下统计配置文件读写次数和重复事件判定正确性。
- 风险/注意事项：
  - 内存缓存需要考虑进程崩溃时少量状态丢失；processed events 可接受短窗口重复处理风险时才适用。

### 9.3 配置与 agents/skills 扫描缓存

- 问题表现：频繁打开设置、发送消息或切换 cwd 时重复读取 `settings.json`、skills、agents、MCP 配置。
- 原因/涉及模块：`config_manager.py` 多处直接读 JSON 或扫描目录；`get_agents_for_cli(names, cwd)` 每次组装 CLI 参数时扫描 agent 文件并读取 body。
- 建议方案：
  - 按文件/目录 mtime 建立短 TTL 缓存。
  - 对 agent body 以 path + mtime 缓存解析结果，并保留 `MAX_AGENT_PROMPT_CHARS` 限制。
  - 写配置后主动 invalidate 对应缓存。
- 验证方式：
  - 连续调用 models/config/agents 接口，确认第二次起不再重复扫描文件。
- 风险/注意事项：
  - Windows 目录 mtime 精度和更新行为需实测；必要时结合 TTL。

## 10. 定时任务与飞书网关优化

### 10.1 定时任务调度减少轮询成本

- 问题表现：没有任务或任务很少时仍每 5 秒读取并写回任务文件。
- 原因/涉及模块：`scheduled_task_runner.py.start()` 固定 5 秒 tick；`tick()` 每次 `store.list_tasks()`。
- 建议方案：
  - 计算所有 enabled task 的最近 `next_run_at`，sleep 到最近触发时间，设置最大 sleep 上限例如 60 秒。
  - 手动创建/更新任务时唤醒 runner。
  - 避免同一任务重复并发执行，保留 `_running_tasks` 防护并增加日志。
- 验证方式：
  - 空闲状态下观察 CPU、文件 IO；任务到点仍能准时执行。
- 风险/注意事项：
  - 系统休眠/唤醒后需要立即重新计算到期任务。

### 10.2 飞书消息处理并发与去重优化

- 问题表现：高频飞书消息会同时启动多个 CLI 子进程，事件去重和日志写入造成额外 IO。
- 原因/涉及模块：`feishu_gateway.py.handle_event()` 对每条消息 `asyncio.create_task()`；`_run_agent_turn()` 每条消息使用一次性 CLI；`feishu_gateway_store.py` 每次判重读写完整 JSON。
- 建议方案：
  - 为飞书消息处理增加 per-chat 或全局并发限制，例如 semaphore。
  - 对同一 chat 的消息可按队列串行处理，避免上下文竞争。
  - processed events 用内存缓存减少重复 JSON 读写，周期性落盘。
- 验证方式：
  - 模拟同一群聊短时间 20 条消息，确认不会同时启动 20 个 CLI，且重复事件仍被忽略。
- 风险/注意事项：
  - 串行处理会增加排队延迟，需要在回复中提示“任务已排队”。

## 11. 验证指标与回归清单

### 11.1 建议新增观测指标

- HTTP：每个 `/api/*` 路由耗时、状态码、响应大小。
- SSE：每客户端队列长度、丢弃/合并事件数、写入失败数。
- CLI：启动耗时、首事件耗时、总事件数、partial 合并前后数量、fallback 次数。
- 会话：JSONL 文件大小、读取耗时、解析行数、缓存命中率。
- 前端：每轮渲染耗时、长任务数量、消息 DOM 节点数、自动滚动次数。
- 持久化：关键 JSON 文件读写次数、写入耗时、文件大小。

### 11.2 回归场景

1. 普通聊天：新会话、继续会话、捕获真实 session_id、成本累计正常。
2. 长输出：10 万字符流式输出期间 UI 可滚动、可停止、不卡死。
3. 大历史：100MB JSONL 只加载最近消息，接口不超时，内存稳定。
4. 大目录搜索：搜索可截断、可取消，不阻塞 SSE 心跳。
5. 慢客户端：浏览器休眠或网络限速后后端内存不持续增长。
6. 定时任务：空闲不频繁写文件，到点任务正常运行，一次性任务成功后禁用。
7. 飞书网关：重复事件去重、高频消息受控并发、日志可轮转。
8. Windows 路径：所有返回前端的路径仍保持 forward slash，路径穿越防护不回退。

## 12. 风险与回滚策略

- 优先做有开关、可回退的优化，例如 SSE partial 合并、前端流式轻量渲染、缓存 TTL。
- 涉及历史读取和索引的优化先以“缓存加速、失败回退全量扫描”方式落地。
- executor 化同步 IO 后需限制并发，避免从“阻塞事件循环”变为“线程池拥塞”。
- 前端增量渲染不要一次替换所有消息渲染路径，先只处理当前 streaming assistant 消息。
- 所有持久化优化必须保留临时文件 + replace 的安全写策略，避免断电或崩溃损坏 JSON。
