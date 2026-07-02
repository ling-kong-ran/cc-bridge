---
name: cc-bridge-api
description: |
  cc-bridge 项目 API 查询手册。当用户询问"查询会话"、"活跃会话"、"定时任务"、"配置"、"MCP服务器"、"模型列表"、"已安装skill"、"agent"、"远程目标"、"文件浏览"、"git review"、"记忆"等 cc-bridge 项目状态/数据查询类问题时，使用此 skill 快速定位对应的 API 端点。
  也用于理解"用什么 API 查询 X"类问题。
---

# cc-bridge API 查询参考

cc-bridge 后端运行在 `127.0.0.1:<port>`（默认 17878，端口被占时自增）。所有 API 响应为 `application/json`。以下按常见查询场景组织。

---

## 1. 会话 (Sessions)

### 查询所有会话列表（含活跃状态标记）
```
GET /api/sessions?offset=0&limit=200
→ { sessions: [...], total: N }
```
每个 session 对象包含: `session_id`, `title`, `model`, `cwd`, `total_cost_usd`, `total_tokens`, `created_at`, `updated_at`, `mtime`, `is_active`(bool), `active_owner_id`, `pinned`, `manual_title`, `cli`, `remote_target_id`, `scheduled_task_id`, `scheduled_task_name`, `source`

### 查询单个会话详情/历史消息
```
POST /api/sessions/history
body: { session_id, cwd, max_messages? (默认50) }
→ [ {role, text} | {role, blocks} ... ]
```

### 更新会话工作目录
```
POST /api/sessions/update-cwd
body: { session_id, new_cwd }
```

### 重命名会话
```
POST /api/sessions/rename
body: { session_id, title }
```

### 删除会话
```
POST /api/sessions/delete
body: { session_id, cwd? }
```

### 置顶/取消置顶
```
POST /api/sessions/toggle-pin
body: { session_id }
```

---

## 2. 定时任务 (Scheduled Tasks / Cron)

### 查询所有定时任务
```
GET /api/scheduled-tasks
→ { tasks: [...] }
```
每个 task 包含: `id`, `name`, `prompt`, `schedule`({type:"interval"/"daily"/"once", ...}), `enabled`, `model`, `cwd`, `cli`, `remote_target_id`, `last_session_id`, `last_run_at`, `next_run_at`, `last_status`, `last_error`, `run_count`

### 创建/更新定时任务
```
POST /api/scheduled-tasks
body: { id? (有则更新), name, prompt, schedule: {type, minutes?/time?/run_at?}, model, cwd, cli, ... }
```

### 删除定时任务
```
POST /api/scheduled-tasks/delete
body: { id }
```

### 启用/禁用
```
POST /api/scheduled-tasks/toggle
body: { id, enabled }
```

### 立即执行
```
POST /api/scheduled-tasks/run-now
body: { id }
```

持久化文件: `~/.ccb/cron_jobs.json`

---

## 3. 配置 (Settings / Env)

### 全局 CLI 设置 (~/.claude/settings.json)
```
GET  /api/settings   → { ... }
POST /api/settings   body: 整个 settings JSON
```

### GUI 偏好 (~/.ccb/gui_settings.json)
```
GET  /api/gui-settings   → { theme, language, font_size, ... }
POST /api/gui-settings   body: { key: value, ... }  (增量合并)
```

### 环境变量配置
```
GET  /api/env   → { ... }
POST /api/env   body: { KEY: value, ... }
```

### 环境变量配置方案 (Profiles)
```
GET  /api/env-profiles            → { profiles: {...} }
POST /api/env-profiles            body: { name, env: {...} }
POST /api/env-profiles/delete     body: { name }
```

---

## 4. CLI / 模型 / 更新

### 可用 CLI 列表
```
GET /api/clis   → [ {name, path, source}, ... ]
POST /api/clis  body: { path }  切换当前 CLI
```

### 可用模型列表
```
GET /api/models   → [ "claude-opus-4-6", ... ]
```

### Slash 命令 / Skills / Agents (来自 CLI init)
```
GET /api/slash-commands?model=claude-sonnet-4-6&cwd=/path
→ { slash_commands, skills, agents, model, cli, version, error }
```

### Git 更新检查
```
GET  /api/check-update  → { behind_by, local_hash, remote_hash, ... }
POST /api/update        执行 git pull --ff-only
POST /api/restart       重启服务 (仅 Windows)
```

---

## 5. MCP 服务器 / Skills / Agents

### MCP 服务器 (多源合并: settings.json + ~/.claude.json + .mcp.json)
```
GET  /api/mcp-servers?cwd=/path   → [ {name, scope, type, command, args, env, url, raw}, ... ]
POST /api/mcp-servers             body: { name, scope, type, command?/url?, args?, env?, cwd? }
```

### Skills
```
GET  /api/skills          → [ {name, dir, description}, ... ]
GET  /api/skills/detail?name=xxx   → 含 frontmatter + body
POST /api/skills/delete   body: { name }   卸载 skill
```

### Agents
```
GET  /api/agents           → [ {name, file, scope, description, tools, ...}, ... ]
POST /api/agents           body: { name, description?, tools?, body?, scope? }
POST /api/agents/update    body: { name, ... }
POST /api/agents/delete    body: { name }
```

### 会话的 Agent 管理
```
GET  /api/session/agents?session_id=xxx  → 当前活跃会话已拉入的 agent 列表
POST /api/session/agents                 body: { action: "add"/"remove"/"toggle"/"set", name, session_id? }
```

---

## 6. 文件系统浏览

### 浏览目录 (跳过 .git / node_modules / __pycache__ / .venv)
```
GET  /api/browse?path=/absolute/path     → { path, items: [{name, path, is_dir, size, mtime}, ...], total }
POST /api/browse       body: { path }
```

### 递归文件树 (前端 file-picker 用)
```
POST /api/browse-files  body: { path }    → { path, files, total }
```

### 搜索文件
```
POST /api/search-files  body: { path, query, max_results? (default 200) }
```

### 文本预览 (前 200 行)
```
GET /api/file-preview?path=/absolute/path&cwd=/working/dir
```

### 创建目录
```
POST /api/mkdir  body: { parent, name }
```

---

## 7. 飞书网关 (Feishu Gateway)

### 配置
```
GET  /api/feishu-gateway/config  → { ..., available, unavailable_reason, qrcode_available, lan_ips, ws_available }
POST /api/feishu-gateway/config  body: { app_id, app_secret, ... }
```

### Scope / 会话管理
```
GET  /api/feishu-gateway/scopes   → { scopes: [...] }
POST /api/feishu-gateway/reset-scope  body: { scope_id }
POST /api/feishu-gateway/stop-scope   body: { scope_id }
```

### 飞书事件接收
```
POST /api/feishu-gateway/events  飞书开放平台回调
```

### QR 码
```
GET /api/feishu-gateway/qr?url=https://...   → SVG 图片
```

### OAuth 扫码创建 Bot
```
POST /api/feishu-gateway/onboard/begin  body: {}  → 获取 QR + 设备码
POST /api/feishu-gateway/onboard/poll   body: { device_code }  → 轮询授权结果
```

---

## 8. 远程目标 (Remote Targets)

```
GET  /api/remote-targets          → { targets: [...], password_supported }
POST /api/remote-targets          body: { id?, name, host, port?, user, password?/key_file?, ... }
POST /api/remote-targets/delete   body: { id }
POST /api/remote-targets/test     body: { id }   测试 SSH 连接
```

### 远程文件浏览
```
POST /api/remote-files/list   body: { target_id, path }
POST /api/remote-files/cache  body: { target_id, path, cwd? }
```

---

## 9. 记忆 (Memory)

```
GET  /api/memory/files?cwd=/path       → { files: [...] }
GET  /api/memory/search?q=keyword&cwd=/path  → { results: [...] }
GET  /api/memory/index?cwd=/path       → { content, ... }
GET  /api/memory/tree?cwd=/path        → { tree: [...], ... }
GET  /api/memory/graph?cwd=/path       → { nodes: [...], edges: [...] }
POST /api/memory/file   body: { cwd, name, content? }  (无 content=读取)
POST /api/memory/delete body: { cwd, name }
POST /api/memory/update body: { cwd, name, new_name?, ... }
POST /api/memory/index  body: { cwd, content? }
```

---

## 10. Git Review / 上传

```
GET /api/review?cwd=/path
→ { branch, changes: {staged, unstaged}, untracked, recent_commits, commit_count }

GET /api/artifacts?limit_sessions=30
→ [ {type, value, href, ...}, ... ]
```

---

## 常用查询场景速查表

| 用户问什么 | 使用哪个 API |
|-----------|-------------|
| 查询所有会话 / 活跃会话 | `GET /api/sessions` (看 `is_active` 字段) |
| 查询所有定时任务 | `GET /api/scheduled-tasks` |
| 查询模型列表 | `GET /api/models` |
| 查询可用 CLI | `GET /api/clis` |
| 查询 MCP 服务器 | `GET /api/mcp-servers?cwd=...` |
| 查询已安装 skill | `GET /api/skills` |
| 查询已安装 agent | `GET /api/agents` |
| 查询环境变量 | `GET /api/env` |
| 查询 GUI 设置 | `GET /api/gui-settings` |
| 查询远程目标 | `GET /api/remote-targets` |
| 查询飞书网关配置 | `GET /api/feishu-gateway/config` |
| 查询 git 状态 | `GET /api/review?cwd=...` |
| 查询记忆文件 | `GET /api/memory/files?cwd=...` |
| 搜索文件 | `POST /api/search-files` |
| 浏览目录 | `GET /api/browse?path=...` |

---

## 注意事项

- **API 仅供 cc-bridge 项目后端调用，先启动 server.py**。
- **端口**: 默认 17878，`--port` 参数指定。
- **server.py 内存中的运行时状态**（`client_runs`, `session_owner` 等）无法通过 API 直接查询。
- 持久化数据: `~/.claude/gui_sessions.json`, `~/.ccb/cron_jobs.json`, `~/.ccb/gui_settings.json`, `~/.claude/settings.json`, `~/.ccb/env_profiles.json`, `~/.ccb/feishu_gateway.json`
