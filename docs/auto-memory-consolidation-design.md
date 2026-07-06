# 自动记忆沉淀设计

> 版本：v0.1 — 2026-07-06  
> 状态：设计稿，尚未实现  
> 参考：`C:\Users\lkr\.claude\skills\karpathy-llm-wiki`、MemGPT/Letta、Zep、LangMem/LangGraph Memory、Graphiti、OpenAI ChatGPT Memory 的成熟思路  
> 相关现有文件：`server.py`, `ccb_bridge.py`, `session_store.py`, `memory_index.py`, `wiki_store.py`, `context_orchestrator.py`, `static/app.js`, `static/memory.js`

## 1. 背景

当前 CC Bridge 已经实现了“发送前自动检索并注入 Memory/Wiki”的链路：

```text
用户消息
  → context_orchestrator 检索项目 memory / 全局 wiki
  → 预算控制与摘要压缩
  → 注入 <cc_bridge_context>
  → 前端展示 context trace
  → 后端记录命中日志
```

但目前缺失的是反向链路：**对话结束后，系统不会自动把有长期价值的信息沉淀为 memory/wiki**。

因此现在的能力是：

```text
已有记忆 → 自动召回 → 注入给模型
```

还不是完整闭环：

```text
对话产生新知识 → 自动识别 → 候选沉淀 → 去重/合并 → 写入 Memory/Wiki → 后续自动召回
```

本设计目标是补齐“自动沉淀”这一半，同时避免记忆污染、重复写入、隐私泄露和无意义日志堆积。

## 2. 设计目标

1. **低打扰**：默认不强迫用户每轮确认，但重要写入要可见、可撤销。
2. **高质量**：只沉淀长期有用的信息，不保存普通聊天流水。
3. **可追溯**：每条记忆能追溯到 session、turn、artifact、upload 或手动来源。
4. **可控**：支持自动、半自动、关闭三种模式。
5. **可去重**：写入前必须和已有 memory/wiki 做相似检索，优先合并而不是新增。
6. **可编译**：参考 Karpathy LLM Wiki，把原始资料 raw 与长期知识 wiki 分层。
7. **可审计**：前端展示“本轮产生了哪些候选记忆、哪些已写入、哪些被跳过”。
8. **不阻塞聊天**：沉淀流程必须异步后台执行，失败不能影响正常对话。

## 3. 参考成熟方案

### 3.1 Karpathy LLM Wiki

核心思想：

```text
raw/  保存不可变原始资料
wiki/ 保存 LLM 编译后的长期知识文章
index.md 维护全局索引
log.md 记录 ingest / query / lint 操作
```

适合本项目的部分：

- 原始会话片段先进入 `raw/sessions/`，不直接改写。
- LLM 只维护 `wiki/` 编译层。
- `index.md` 和 `log.md` 让长期知识可读、可审计。
- Lint 分为“确定性自动修复”和“启发式只报告”。

### 3.2 MemGPT / Letta

核心思想：把记忆分成不同层级：

- 短期上下文：当前会话窗口。
- 工作记忆：当前任务相关信息。
- 长期记忆：用户、项目、事实、偏好。

适合本项目的部分：

- 不把所有对话都写入长期记忆。
- 先进入候选区，再根据类型写入长期 memory/wiki。
- 记忆要支持更新、替换、删除，而不是只追加。

### 3.3 Zep

核心思想：对话记忆需要异步提取、摘要、实体/事实抽取，并保留时间线。

适合本项目的部分：

- assistant 完成后异步运行记忆提取，不阻塞用户。
- 每条记忆保留 `created_at`、`updated_at`、`source_session_id`。
- 支持“事实变化”：新事实覆盖旧事实，而不是并存冲突。

### 3.4 LangMem / LangGraph Memory

核心思想：记忆写入是一个可配置策略，常见模式包括：

- profile memory：用户画像，持续更新单个 profile。
- collection memory：多条独立事实，按语义检索。
- procedural memory：长期行为偏好或工作流程。

适合本项目的部分：

- 用户偏好写入 `user` / `feedback` 类 memory。
- 项目决策写入 `project` / `decision` 类 memory。
- 操作流程写入 `wiki/workflows/`。
- 不同类型采用不同合并策略。

### 3.5 Graphiti

核心思想：长期记忆可以建成时间感知知识图谱，实体关系随时间更新。

适合本项目的部分：

- 当前可以先用 wikilink 和 FTS5，不急于引入复杂图数据库。
- 后续可把 memory/wiki 中的实体、项目、模块、决策形成边。
- 冲突事实应保留时间和来源，而不是简单覆盖。

## 4. 总体架构

```text
┌────────────────────────────────────────────────────────────┐
│                       对话主链路                             │
│  user → server.py → ccb_bridge.py → Claude Code CLI          │
└───────────────────────┬────────────────────────────────────┘
                        │ assistant/result 事件结束后
                        ▼
┌────────────────────────────────────────────────────────────┐
│             memory_consolidator.py（新增）                   │
│  1. 收集本轮 turn  2. 判断是否值得沉淀  3. 生成候选记忆        │
│  4. 去重/合并判断    5. 写入 raw/wiki 或 pending              │
└─────────────┬───────────────────────┬──────────────────────┘
              ▼                       ▼
┌──────────────────────────┐  ┌───────────────────────────────┐
│ session_store.py          │  │ memory_index.py / wiki_store.py │
│ 读取 JSONL / 会话元数据     │  │ 检索已有记忆、写入、重建索引       │
└─────────────┬────────────┘  └──────────────┬────────────────┘
              ▼                              ▼
┌────────────────────────────────────────────────────────────┐
│                    Memory 文件系统 / SQLite                  │
│  memory/raw/sessions/       原始会话片段                     │
│  memory/wiki/<topic>/       编译知识文章                     │
│  memory/pending/            待确认候选记忆                   │
│  memory/index.md / log.md   索引与操作日志                   │
│  .ccb/memory_jobs.db        后台任务、状态、错误              │
└────────────────────────────────────────────────────────────┘
```

## 5. 知识分层

沿用 Karpathy LLM Wiki 思路，但放在现有 Claude Code project memory 根目录下：

```text
~/.claude/projects/<sanitized-cwd>/memory/
├── raw/
│   ├── sessions/
│   ├── artifacts/
│   ├── uploads/
│   └── external/
├── wiki/
│   ├── architecture/
│   ├── decisions/
│   ├── workflows/
│   ├── troubleshooting/
│   └── references/
├── pending/
│   └── 2026-07-06-session-title.md
├── index.md
└── log.md
```

### 5.1 raw

`raw/` 是不可变来源材料，主要用于追溯。

特点：

- 只追加，不自动改写。
- 保存必要片段，不保存完整无关对话。
- 包含来源 metadata。
- 默认不直接参与自动注入，除非用户开启 `memoryInjectIncludeRaw`。

### 5.2 wiki

`wiki/` 是长期可用知识。

特点：

- 由 LLM 编译、合并、更新。
- 文章按主题组织。
- 面向人和模型阅读。
- 默认允许自动检索和注入。

### 5.3 pending

`pending/` 是候选记忆区。

用途：

- 自动提取但不确定是否应写入的内容。
- 需要用户确认的敏感内容。
- 低置信度或可能重复的内容。

### 5.4 index/log

- `index.md`：项目知识索引，便于人工浏览和 Query。
- `log.md`：追加记录 ingest、compile、merge、reject、lint。

## 6. 记忆类型

建议统一为以下类型：

| 类型 | 用途 | 写入位置 | 示例 |
| --- | --- | --- | --- |
| `user` | 用户长期偏好、角色、背景 | `wiki/references/` 或平铺 memory | 用户偏好中文回复 |
| `feedback` | 用户对协作方式的明确反馈 | `wiki/references/` | 不要自动 commit |
| `project` | 项目背景、目标、约束 | `wiki/decisions/` | 当前项目主平台是 Windows |
| `decision` | 已做出的技术/产品决策 | `wiki/decisions/` | 采用 SSE 而不是 WebSocket |
| `workflow` | 可复用操作流程 | `wiki/workflows/` | 发布流程、测试流程 |
| `troubleshooting` | 问题、根因、解决方式 | `wiki/troubleshooting/` | 历史会话发送卡住的根因 |
| `reference` | 外部资源位置 | `wiki/references/` | 某个 dashboard 或文档位置 |
| `raw` | 原始资料 | `raw/` | 会话片段、artifact 原文 |

## 7. Frontmatter 规范

### 7.1 raw 文件

```markdown
---
title: 历史会话发送卡住问题讨论
kind: raw
type: session
source: claude-code-session
project: E:/code/cc-bridge
session_id: <session-id>
turn_ids: [<turn-id>]
created: 2026-07-06
collected: 2026-07-06
sensitivity: normal
---

# 原始片段

...
```

### 7.2 wiki 文章

```markdown
---
title: 自动上下文注入阻塞问题
type: troubleshooting
source: session
project: E:/code/cc-bridge
tags: [memory, context-injection, performance]
created: 2026-07-06
updated: 2026-07-06
confidence: high
inject: auto
sources:
  - ../../raw/sessions/2026-07-06-context-injection-blocking.md
---

# 自动上下文注入阻塞问题

## 结论

## 背景

## 根因

## 修复

## 注意事项

## See Also
```

### 7.3 pending 候选

```markdown
---
title: 候选记忆：用户希望命中记忆时展示日志
kind: pending
type: feedback
source: session
project: E:/code/cc-bridge
session_id: <session-id>
created: 2026-07-06
confidence: medium
action: create | merge | ignore
candidate_target: wiki/references/user-collaboration-preferences.md
---

## 候选内容

用户希望命中记忆时应该有日志记录或者前端展示。

## 建议动作

merge 到现有 UI 可观测性或用户偏好文章。

## 原因

这是对产品行为的明确偏好，未来实现 memory 功能时应遵守。
```

## 8. 自动沉淀触发点

### 8.1 assistant result 后触发

最自然的触发点是 CLI 输出 `result` / `process_ended` 后。

```text
assistant 完成本轮响应
  → server.py 收到 result/process_ended
  → enqueue memory consolidation job
  → 立即返回，不阻塞 SSE
```

适合沉淀：

- 用户明确表达的偏好。
- 用户纠正 assistant 的方式。
- 项目长期决策。
- 问题根因与修复方案。
- 重要外部资源。

不适合沉淀：

- 普通闲聊。
- 临时代码 diff 细节。
- 可以从代码或 git 历史直接推导的信息。
- 未验证的猜测。
- 短期任务状态。

### 8.2 会话空闲后批处理

为了减少噪声，也可以在会话空闲一段时间后批处理最近 N 轮。

```text
session idle 60s
  → 聚合最近 N 轮
  → 生成更稳定的候选记忆
```

优点：

- 能看到完整问题-修复-验证链路。
- 减少每轮都提取造成的碎片化。

缺点：

- 实现稍复杂。
- 需要任务队列和状态持久化。

建议第一版采用：**result 后轻量判断 + 后台队列串行执行**。

## 9. 记忆提取策略

### 9.1 候选分类器

输入：

```json
{
  "session_id": "...",
  "cwd": "E:/code/cc-bridge",
  "user_message": "...",
  "assistant_summary": "...",
  "tool_changes": ["server.py", "static/app.js"],
  "result_status": "success|error|stopped"
}
```

输出：

```json
{
  "should_remember": true,
  "confidence": "high",
  "items": [
    {
      "type": "troubleshooting",
      "title": "自动上下文检索阻塞发送",
      "content": "打开自动上下文后历史会话发送慢，根因是发送前同步检索阻塞；修复为 to_thread + 3 秒超时降级。",
      "why": "这是项目长期排障知识，未来相关问题可复用。",
      "target": "wiki/troubleshooting/context-injection-blocking.md",
      "action": "create"
    }
  ]
}
```

第一版可以不调用额外模型，先做规则提取：

| 信号 | 倾向 |
| --- | --- |
| 用户说“记住”、“以后”、“每次”、“不要再” | `user` / `feedback` 高置信 |
| 用户解释“原因是”、“背景是”、“约束是” | `project` / `decision` |
| assistant 修复了 bug 且检查通过 | `troubleshooting` 候选 |
| 涉及外部位置、dashboard、文档 | `reference` |
| 只是一次性实现细节 | 不沉淀 |

后续再接 LLM 提取器。

### 9.2 LLM 提取 Prompt 要求

如果使用 LLM 提取，必须强约束：

```text
只提取长期有用、未来跨会话仍成立的信息。
不要保存可从代码、git diff、README、CLAUDE.md 直接推导的信息。
不要保存临时任务状态。
不要保存敏感凭据、token、完整路径中的隐私片段，除非用户明确要求。
输出 JSON，不要解释。
```

### 9.3 质量门槛

每条候选记忆必须回答：

1. 未来是否仍有用？
2. 是否不是代码本身已经表达的信息？
3. 是否来源明确？
4. 是否有可能过期？
5. 是否和已有记忆重复或冲突？

不满足则进入 `pending/` 或直接跳过。

## 10. 去重与合并

写入前必须先检索已有记忆：

```text
candidate title/content/tags
  → memory_index.search_memory()
  → wiki_store.search()
  → 找相似 memory/wiki
  → 判断 create / merge / supersede / reject
```

### 10.1 动作类型

| 动作 | 说明 |
| --- | --- |
| `create` | 没有相似记忆，创建新 wiki 文章 |
| `merge` | 与已有文章同主题，更新已有文章 |
| `supersede` | 新事实替代旧事实，旧文保留过期说明 |
| `append_source` | 内容已存在，只追加来源或更新时间 |
| `reject_duplicate` | 完全重复，跳过 |
| `pending_review` | 不确定，写入 pending 等用户确认 |

### 10.2 合并规则

- `user` / `feedback`：优先合并到少量稳定 profile 文章，避免碎片化。
- `project` / `decision`：同一主题合并到决策文章，保留日期和原因。
- `troubleshooting`：同一错误/症状合并，新增“另一次出现”。
- `workflow`：更新步骤，并记录适用条件。
- `reference`：资源位置变化时标记旧位置过期。

## 11. 写入策略

### 11.1 三种模式

配置项：

```json
{
  "memoryAutoConsolidate": "off | suggest | auto",
  "memoryConsolidateMinConfidence": "medium",
  "memoryConsolidateWriteRaw": true,
  "memoryConsolidateWriteWiki": "suggest",
  "memoryConsolidateAfterResult": true,
  "memoryConsolidateIdleSeconds": 60
}
```

| 模式 | 行为 |
| --- | --- |
| `off` | 不自动提取，不写入 |
| `suggest` | 自动生成候选，写入 `pending/`，前端提示用户确认 |
| `auto` | 高置信直接写入 wiki，低/中置信写入 pending |

建议默认：`suggest`。

### 11.2 第一版推荐

第一版不要直接全自动改 wiki：

```text
高置信 user/feedback/project → 可直接写入或 pending
troubleshooting/decision/workflow → 默认 pending
raw session excerpt → 可自动写入 raw
wiki compile/merge → 需要用户确认或显式按钮
```

原因：项目知识一旦被错误沉淀，会污染后续自动注入。

## 12. 后端模块设计

### 12.1 新增 `memory_consolidator.py`

职责：

```python
def enqueue_consolidation(session_id: str, cwd: str, run_id: str, client_id: str) -> str:
    """创建后台沉淀任务，返回 job_id。"""

async def run_consolidation_job(job_id: str) -> dict:
    """读取本轮会话内容，生成候选，执行写入或 pending。"""

def extract_candidates(turn: dict, settings: dict) -> list[dict]:
    """从本轮对话提取候选记忆。"""

def resolve_candidate(candidate: dict, cwd: str) -> dict:
    """检索已有记忆，决定 create/merge/reject/pending。"""

def write_pending(candidate: dict, cwd: str) -> dict:
    """写入 memory/pending。"""

def write_raw_excerpt(excerpt: dict, cwd: str) -> dict:
    """写入 memory/raw/sessions。"""

def apply_memory_action(candidate: dict, cwd: str) -> dict:
    """真正 create/merge/supersede wiki。"""
```

### 12.2 新增 job store

可以先用 JSON 文件，后续再 SQLite。

建议路径：

```text
~/.ccb/memory_consolidation_jobs.json
```

记录：

```json
{
  "job_id": "memjob_...",
  "session_id": "...",
  "run_id": "...",
  "cwd": "E:/code/cc-bridge",
  "status": "queued|running|completed|failed|skipped",
  "created_at": 1783330000.0,
  "updated_at": 1783330030.0,
  "candidates": 2,
  "written": 1,
  "pending": 1,
  "error": ""
}
```

### 12.3 `server.py` 接入点

在 assistant 完成或 process ended 后：

```python
if settings.get("memoryAutoConsolidate") != "off":
    job_id = memory_consolidator.enqueue_consolidation(
        session_id=session_id,
        cwd=cwd,
        run_id=run_id,
        client_id=client_id,
    )
    asyncio.create_task(memory_consolidator.run_consolidation_job(job_id))
    await push_event(client_id, "memory_consolidation_started", {"job_id": job_id})
```

注意：

- 不能阻塞 SSE。
- 同一个 `session_id/run_id` 要去重，避免重复写入。
- 用户停止生成时默认不沉淀，除非已有明确用户偏好。

## 13. API 设计

### 13.1 配置

```text
GET  /api/memory/consolidation/settings
POST /api/memory/consolidation/settings
```

返回：

```json
{
  "mode": "suggest",
  "min_confidence": "medium",
  "write_raw": true,
  "write_wiki": "suggest",
  "after_result": true,
  "idle_seconds": 60
}
```

### 13.2 任务查询

```text
GET /api/memory/consolidation/jobs?session_id=...
GET /api/memory/consolidation/jobs/<job_id>
```

### 13.3 候选记忆

```text
GET  /api/memory/candidates?cwd=...
POST /api/memory/candidates/<id>/approve
POST /api/memory/candidates/<id>/reject
POST /api/memory/candidates/<id>/edit
```

### 13.4 手动触发

```text
POST /api/memory/consolidation/run
```

请求：

```json
{
  "session_id": "...",
  "cwd": "E:/code/cc-bridge",
  "mode": "suggest"
}
```

用途：

- 用户在历史会话上点击“总结到记忆”。
- 对已有会话补跑沉淀。

## 14. 前端设计

### 14.1 对话页提示

本轮结束后出现轻量提示：

```text
Memory 候选：发现 2 条可沉淀内容 · 查看
```

展开：

```text
1. [troubleshooting] 自动上下文检索阻塞发送
   建议：写入 wiki/troubleshooting/context-injection-blocking.md
   原因：已修复并通过检查，未来排障有复用价值
   [批准] [编辑] [忽略]

2. [feedback] 用户希望命中记忆时前端展示
   建议：合并到 wiki/references/user-collaboration-preferences.md
   [批准] [编辑] [忽略]
```

### 14.2 Memory 页面

新增 tab：

- `已沉淀`
- `候选`
- `Raw`
- `Wiki`
- `日志`

候选列表字段：

- 类型
- 标题
- 置信度
- 建议动作
- 来源 session
- 创建时间
- 操作按钮

### 14.3 设置页

新增：

```text
自动记忆沉淀：关闭 / 仅建议 / 高置信自动
自动保存 raw 会话片段：开关
低置信候选保留天数：默认 30 天
沉淀完成后提示：开关
```

## 15. 安全与隐私

1. **默认本地**：所有 raw/wiki/pending/job 都在本机。
2. **敏感信息过滤**：疑似 token、密钥、cookie、私有 URL 默认不写入 wiki。
3. **路径保护**：写入必须限制在当前项目 memory 根目录内。
4. **用户可撤销**：前端能删除候选和已写入记忆。
5. **不保存工具完整输出**：只保存必要摘要和引用。
6. **不保存可重建信息**：代码细节以 git/code 为准，不复制到 memory。
7. **prompt injection 隔离**：raw 资料只作为资料，不作为指令。

敏感检测第一版可以做规则：

```text
AKIA...
sk-...
xoxb-...
-----BEGIN PRIVATE KEY-----
password=
token=
Authorization:
```

命中后：

- 不自动写入 wiki。
- raw 中可做脱敏或进入 pending。
- 前端提示用户确认。

## 16. 质量控制

### 16.1 应该沉淀

- 用户明确要求“记住”。
- 用户给出长期偏好或协作规则。
- 用户解释项目背景、业务约束、截止日期。
- 经过验证的 bug 根因和修复思路。
- 重要技术决策及原因。
- 外部系统位置和用途。

### 16.2 不应该沉淀

- 当前任务 TODO。
- 临时 debug 输出。
- 大段代码 diff。
- 可通过读取文件得到的架构事实。
- git history 已经准确记录的内容。
- assistant 的未验证推测。
- 用户的一次性口语表达。

### 16.3 冲突处理

如果新候选和旧记忆冲突：

```text
高置信 + 用户明确纠正
  → supersede 旧记忆，旧文加“已过期”说明

来源不明确或置信度低
  → pending_review

两个事实可能都成立但条件不同
  → 合并，增加“适用条件”
```

## 17. 日志与可观测性

### 17.1 后端日志

写入 `~/.ccb/server.log`：

```text
memory consolidation started job=... sid=... run=...
memory candidate extracted job=... count=2
memory candidate pending job=... path=memory/pending/...
memory candidate written job=... path=memory/wiki/...
memory consolidation skipped job=... reason=no durable information
```

### 17.2 SSE 事件

新增事件：

```text
memory_consolidation_started
memory_consolidation_completed
memory_consolidation_failed
memory_candidate_created
```

事件数据：

```json
{
  "job_id": "memjob_...",
  "session_id": "...",
  "run_id": "...",
  "candidates": 2,
  "written": 1,
  "pending": 1,
  "skipped_reason": ""
}
```

### 17.3 操作日志

写入 `memory/log.md`：

```markdown
## [2026-07-06] consolidate | 自动上下文注入阻塞问题
- Source: session <session-id>
- Action: created wiki/troubleshooting/context-injection-blocking.md
- Raw: raw/sessions/2026-07-06-context-injection-blocking.md
```

## 18. 与现有自动注入的关系

自动沉淀是写入侧，自动注入是读取侧：

```text
写入侧：memory_consolidator.py
  对话 → raw/pending/wiki

读取侧：context_orchestrator.py
  memory/wiki → 检索 → 注入 prompt
```

两者必须解耦：

- 注入失败不能影响沉淀。
- 沉淀失败不能影响发送。
- pending 候选默认不参与自动注入。
- raw 默认不参与自动注入。
- 只有 `inject: auto` 且质量足够的 wiki/memory 参与注入。

## 19. 实施计划

### Phase 1：文档与配置

- 新增本设计文档。
- 在 GUI settings 中增加自动沉淀配置字段。
- 前端设置页增加开关，默认 `suggest` 或 `off`。

### Phase 2：后台任务框架

- 新增 `memory_consolidator.py`。
- 新增 job store。
- 在 `server.py` result/process_ended 后 enqueue job。
- 加 SSE 事件和日志。

### Phase 3：候选提取 MVP

- 先实现规则提取：用户明确“记住/以后/不要/每次”等。
- 写入 `pending/`。
- Memory 页面展示候选，支持批准/拒绝。

### Phase 4：raw 会话片段

- 保存关键会话片段到 `raw/sessions/`。
- 建立 raw 与 pending/wiki 的 source 引用。
- 更新 `log.md`。

### Phase 5：LLM 编译 wiki

- 对批准的候选执行 compile：create/merge/supersede。
- 更新 `index.md`。
- 写入 `wiki/<topic>/...`。

### Phase 6：自动高置信写入

- 对高置信 `user` / `feedback` / `reference` 支持自动写入。
- 其他类型继续 pending。
- 增加冲突检测和去重。

### Phase 7：Lint 与定期整理

- 实现 index consistency。
- 检查断链、重复、孤立、过期。
- 定期清理 pending。

## 20. 第一版 MVP 范围

建议第一版只做下面这些：

1. 新增 `memoryAutoConsolidate: off|suggest|auto`，默认 `suggest`。
2. assistant 完成后后台分析最近一轮。
3. 只识别明确用户偏好/反馈类候选。
4. 候选写入 `memory/pending/`，不直接改 wiki。
5. 前端显示“发现候选记忆”。
6. 用户批准后调用现有 `save_memory_file()` 写入 memory。
7. 写入后调用 `index_memory(cwd)` 重建索引。
8. 所有失败只记录日志，不影响聊天。

这样能先验证：

```text
自动发现 → 用户确认 → 写入 memory → 后续自动检索注入
```

完整 wiki compile、raw/session excerpt、LLM 合并可以后续再做。

## 21. 验收标准

### 21.1 功能验收

1. 用户明确说“记住 X”后，会生成候选记忆。
2. 候选记忆能在前端看到。
3. 用户批准后，记忆写入当前项目 memory 目录。
4. 写入后可被 `memory_index.search_memory()` 检索到。
5. 后续发送相关消息时，`context_orchestrator` 能自动注入该记忆。
6. 用户拒绝候选后，不再重复提示同一候选。

### 21.2 可靠性验收

1. 沉淀失败不影响 assistant 输出。
2. memory 目录不存在时能安全初始化。
3. 同一 run 不会重复写入。
4. JSONL 缺失或解析失败时任务标记 failed，不崩 server。
5. 写入路径不能逃出 memory 根目录。

### 21.3 质量验收

1. 普通聊天不会生成候选。
2. 临时 TODO 不会生成候选。
3. 代码细节不会被大段复制到 memory。
4. 重复候选会被识别并跳过或合并。
5. 敏感内容不会自动写入 wiki。

## 22. 与 `docs/memory-wiki-auto-context-design.md` 的关系

`docs/memory-wiki-auto-context-design.md` 主要描述读取侧：Memory/Wiki 如何被检索、裁剪、注入给模型。

本文描述写入侧：对话和资料如何自动沉淀为 Memory/Wiki。

两者组合后形成完整闭环：

```text
自动沉淀
  → raw / pending / wiki
  → FTS5 / graph index
  → 自动检索
  → prompt 注入
  → 新对话产生新知识
  → 再次自动沉淀
```
