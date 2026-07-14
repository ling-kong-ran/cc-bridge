# Memory 后端系统优化设计

> 版本：v1.0  
> 日期：2026-07-14  
> 范围：`memory_index.py`、`memory_consolidator.py`、`memory_llm.py`、`context_orchestrator.py`、`backend/services/memory_service.py`、`backend/routes/memory_routes.py`、`server.py`  
> 目标：提升记忆系统的数据正确性、检索质量、写入安全、可追溯性、并发可靠性与可测试性。

---

## 1. 结论摘要

当前项目已经形成初步闭环：

```text
会话完成
  → memory_llm 抽取候选
  → memory_consolidator 去重并写入 Markdown
  → memory_index 建立 FTS5 索引
  → context_orchestrator 发送前召回并裁剪
  → <cc_bridge_context> 注入 CLI
  → SSE 向前端展示 trace
```

基础方向正确，尤其是：

- 沉淀和召回均有失败降级，不主动阻断聊天主链路。
- 自动注入支持预算、条数、`inject: never`、raw 排除和可解释 trace。
- 写入集中复用 `save_memory_file()`，删除采用 `.bak` 软删除。
- LLM 整理采用 preview → 用户复核 → apply，而不是直接写盘。
- 中文检索已从原生 FTS5 不分词问题升级为 jieba/bigram 索引和二次重排。

但当前存在几个会直接影响正确性的结构问题：

1. **系统按 basename 建索引和寻址，无法可靠支持设计中的 `raw/wiki/pending` 多级目录，同名文件会碰撞。**
2. **LLM 抽取失败时通常返回 `[]`，导致服务端无法区分“成功但无候选”和“调用失败”，正则兜底实际上不会按注释预期触发。**
3. **默认自动写入、无候选审核和低质量去重，会把错误记忆直接放入后续自动注入链路。**
4. **JSON job store 无锁并发读改写，可能丢任务状态；任务、trace、版本均不可稳定审计。**
5. **FTS 数据模型混合了检索文本与展示文本，snippet 列选择错误，路径、frontmatter 和来源元数据无法参与可靠过滤。**
6. **整理 apply 没有事务、版本前置条件和完整回滚机制，部分失败后只能依赖 `.bak` 人工恢复。**

推荐先做“路径与存储模型迁移 + 写入审核/版本化 + 作业存储可靠化”，再提升检索与智能化能力。

---

## 2. 当前架构

### 2.1 存储层

项目 Memory 文件位于：

```text
~/.claude/projects/<sanitized-cwd>/memory/
```

索引 DB 位于：

```text
~/.ccb/memory_index/<sanitized-cwd>.db
```

实现证据：

- Memory 根目录计算：`memory_index.py:44-49`
- 索引目录及 DB 命名：`memory_index.py:21-41`
- FTS5 与 mtime 表：`memory_index.py:87-108`

### 2.2 写入链路

- 会话完成后调度沉淀：`server.py:1502-1564`
- LLM 抽取用户偏好/事实：`memory_llm.py:267-302`
- 敏感过滤、去重、写文件：`memory_consolidator.py:54-117`
- 文件保存并更新索引：`memory_index.py:786-820`

### 2.3 读取与注入链路

- 发送前在线程中召回，15 秒总超时：`server.py:1567-1643`
- 项目 Memory + 全局 Wiki 多源召回：`context_orchestrator.py:73-165`
- `inject: never` 和 raw 排除：`context_orchestrator.py:168-198`
- 相关性重排：`context_orchestrator.py:304-345`
- 长文 LLM/规则摘要：`context_orchestrator.py:413-492`
- 注入块的资料/指令隔离：`context_orchestrator.py:247-271`

### 2.4 人工治理链路

- 文件 CRUD 路由：`backend/routes/memory_routes.py:21-66`
- LLM 整理预览与动作归一化：`backend/services/memory_service.py:188-255`
- 用户确认后应用动作：`backend/services/memory_service.py:258-337`
- 异步特殊路由：`server.py:3432-3445`

---

## 3. 已有优点

### 3.1 主链路降级设计合理

- 召回超时或异常时发送原始内容，并生成错误 trace：`server.py:1584-1613`。
- 沉淀任务通过 `asyncio.create_task()` 后台运行：`server.py:1525-1562`。
- LLM 一次性子进程有超时、terminate/kill 和临时 session 清理：`memory_llm.py:143-198`。

### 3.2 中文检索已经做针对性修复

- 支持可选 jieba，否则 bigram：`memory_index.py:14-19`、`memory_index.py:446-486`。
- 查询与索引使用相近分词策略：`memory_index.py:194-220`。
- FTS 后按 query 覆盖度重排：`memory_index.py:223-257`。

### 3.3 具备基础安全边界

- 文件名通过 `Path(filename).name` 限制为 basename：`memory_index.py:338-350`、`memory_index.py:791-795`。
- 删除改名为 `.bak`：`memory_index.py:718-744`。
- 自动沉淀有敏感信息正则：`memory_consolidator.py:19-23`、`memory_consolidator.py:120-128`。
- 注入块明确记忆内容不是指令：`context_orchestrator.py:247-253`。

### 3.4 LLM 整理保留人工复核

- 动作类型和目标文件会归一化，剔除不存在目标：`backend/services/memory_service.py:114-185`。
- preview 阶段的 link 只生成候选，不写文件：`backend/services/memory_service.py:188-225`。
- apply 每项捕获错误并返回错误列表：`backend/services/memory_service.py:270-337`。

---

## 4. 关键问题与优先级

## P0：路径模型不正确，层级目录和同名文件会碰撞

### 证据

1. `_parse_memory_file()` 返回的 `name` 永远是 basename：`memory_index.py:75-84`。
2. 全量索引把 `parsed["name"]` 同时写入 `file_path` 和 `name`：`memory_index.py:138-149`。
3. 变更检测也只记录 basename：`memory_index.py:178-187`。
4. `get_memory_file()` 按 basename 递归找到第一个同名文件：`memory_index.py:332-350`。
5. `save_memory_file()` 使用 `Path(filename).name`，不能创建或更新 `wiki/decisions/a.md`：`memory_index.py:786-798`。
6. 图谱节点 ID 是 basename：`memory_index.py:390-405`。

### 影响

设计文档中的以下目录无法成为可靠的数据模型：

```text
raw/sessions/note.md
wiki/decisions/note.md
pending/note.md
```

它们会在索引、图谱、读取、删除和保存时互相覆盖或随机命中。当前 `parsed["file"]` 的相对路径算法也依赖 `file_path.parent.parent`，不同目录深度会返回不一致路径：`memory_index.py:75-78`。

### 优化

所有对象以 **memory 根目录相对 POSIX 路径** 作为稳定主键：

```python
relative_path = file_path.relative_to(memory_dir).as_posix()
```

数据字段：

```text
path       wiki/decisions/sse.md   # 唯一 ID
name       sse.md                  # 展示 basename
parent     wiki/decisions
stem       sse
```

API 的读取、更新、删除必须接收 `path`，不再以 basename 寻址。路径校验使用 resolve 后的父目录约束，而不是简单剥离目录：

```python
target = (memory_dir / relative_path).resolve()
if memory_dir.resolve() not in target.parents:
    raise ValueError("invalid memory path")
```

提供一次迁移：重建索引即可，无需移动现有文件；前端旧请求可在短期内兼容 basename，但重名时返回 409 并要求使用 path。

---

## P0：LLM 失败与“无候选”语义混淆，正则兜底失效

### 证据

- `run_consolidation_job()` 约定：`None` 表示调用失败并使用正则，`[]` 表示成功但无内容：`memory_consolidator.py:59-65`。
- 但 `extract_memories_via_llm()` 的文档和实现规定“任何失败返回 []”：`memory_llm.py:275-286`、`memory_llm.py:294-302`。
- `_run_llm_oneshot()` 也吞掉所有异常并返回空字符串：`memory_llm.py:172-173`。
- 服务端只有函数抛异常时才将 candidates 设为 `None`：`server.py:1526-1543`。

因此 CLI 未登录、模型不可用、超时、JSON 解析失败通常都会变成 `[]`，不会进入 regex fallback。

### 优化

返回显式结果对象，不再用 `None/[]` 隐式编码状态：

```python
@dataclass
class ExtractionResult:
    status: Literal["ok", "failed"]
    candidates: list[MemoryCandidate]
    error_code: str = ""
    error: str = ""
    model: str = ""
    duration_ms: int = 0
```

处理规则：

- `ok + []`：确认无候选，不运行规则。
- `failed`：运行 regex fallback，并记录 `extraction_source=regex_fallback`。
- 解析出部分合法候选：`ok`，同时记录 rejected 数量。

同时在 `_parse_memory_json()` 后给候选补齐当前 job 的 `session_id/run_id/source`；当前解析结果把它们设为空：`memory_llm.py:378-385`。

---

## P0：自动写入策略过于激进，缺少候选审核

### 证据

- `run_consolidation_job()` 默认模式为 `auto`：`memory_consolidator.py:78-84`。
- `schedule_memory_consolidation()` 同样默认 `auto`：`server.py:1505-1507`。
- 所有通过敏感过滤的候选直接 `resolve_and_write()`：`memory_consolidator.py:93-105`。
- 写入内容带 `inject: auto`，会进入后续召回：`memory_consolidator.py:215-234`。

### 影响

LLM 误提取、过时事实或一次性偏好会直接污染长期记忆，并可能在未来会话被自动注入。虽然系统已有 `suggest` 设计，但现实现没有 pending candidate 生命周期。

### 优化

默认模式调整为 `suggest`：

```text
off      不提取
suggest  生成候选，等待批准
safe     仅明确“记住/以后/每次/不要再”的高置信 feedback 自动写入
auto     所有达到阈值的候选自动写入
```

候选实体至少包含：

```json
{
  "id": "memcand_...",
  "status": "pending|approved|rejected|applied|failed",
  "type": "feedback",
  "title": "...",
  "content": "...",
  "confidence": 0.92,
  "suggested_action": "create|merge|supersede|ignore",
  "suggested_target": "...",
  "source_session_id": "...",
  "source_run_id": "...",
  "created_at": 0,
  "decision_at": null,
  "decision_reason": ""
}
```

只有 `approved/applied` 记忆进入索引和自动注入；pending 默认不参与召回。

---

## P0：job JSON 并发写入不可靠

### 证据

- 所有任务共享 `~/.ccb/memory_consolidation_jobs.json`：`memory_consolidator.py:16-17`。
- 每个后台任务执行 load → 修改 → tmp replace：`memory_consolidator.py:67-76`、`memory_consolidator.py:245-258`。
- 多个 `asyncio.to_thread()` 任务可能并发运行：`server.py:1544`。

两个任务同时读取旧快照后分别写回，后写任务可能覆盖前一个任务的状态。文件也会无限增长，缺少查询索引、清理和恢复 running job 的机制。

### 优化

迁移到 SQLite：

```sql
CREATE TABLE memory_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT,
  run_id TEXT,
  status TEXT NOT NULL,
  extraction_source TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  written_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error TEXT,
  created_at REAL NOT NULL,
  started_at REAL,
  completed_at REAL,
  UNIQUE(session_id, run_id)
);
```

- 使用短事务和 WAL。
- `UNIQUE(session_id, run_id)` 实现幂等。
- 启动时把超时 `running` 标记为 `interrupted` 或重试。
- 设定保留策略，例如 30 天或最近 1000 个任务。

---

## P1：FTS 表无法同时满足检索和展示

### 证据

FTS 表字段为：`file_path, name, title, content`：`memory_index.py:94-99`。

但：

- `content` 存储的是分词后的标题+正文，不是原文：`memory_index.py:489-497`。
- 搜索 `snippet(memory_fts, 1, ...)` 选择的是第 2 列 `name`，不是 `content`：`memory_index.py:273-279`。
- 因此 API 返回的 snippet 很可能只是文件名，无法展示正文命中片段。
- frontmatter 的 type/source/inject/confidence/tags 没有独立列，无法高效过滤。

### 优化

采用普通元数据表 + FTS external-content 或独立 FTS 表：

```sql
CREATE TABLE memories (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  indexed_text TEXT NOT NULL,
  type TEXT,
  source TEXT,
  inject TEXT,
  confidence REAL,
  tags_json TEXT,
  content_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  created_at REAL,
  updated_at REAL
);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  path UNINDEXED,
  title,
  indexed_text,
  tokenize='unicode61 remove_diacritics 1'
);
```

搜索后从 `memories.body` 生成原文命中片段，或保存字符映射。至少应把 `snippet()` 改到正确列，并明确 API 的 snippet 是“原文片段”还是“索引片段”。

---

## P1：索引更新方式成本高且增量语义不完整

### 证据

- `index_memory()` 每次检测到变化后清空两张表并全量扫描：`memory_index.py:131-153`。
- 自动召回每次都会先调用 `index_memory(cwd)`：`context_orchestrator.py:106-109`。
- 变更检测遍历全部 Markdown：`memory_index.py:170-191`。
- 整理 apply 后再次强制全量重建：`backend/services/memory_service.py:336-337`。

### 优化

1. 索引记录 `path + mtime_ns + size + sha256`。
2. 比较目录快照，仅 upsert 变化文件、删除缺失文件。
3. 写入 API 直接调用单文件 upsert，不做全量重建。
4. 外部文件变化继续用节流扫描兜底。
5. 索引 schema 增加 `schema_version` 与 tokenizer 标识；jieba 安装状态变化时自动全量迁移。
6. 索引损坏时移动坏库并原子重建，不只返回空结果。

---

## P1：去重和冲突处理不足

### 证据

自动沉淀去重逻辑：

- 用候选前 200 字执行 FTS：`memory_consolidator.py:158-163`。
- 仅当标题字符集合重叠度 > 0.85 时判重复：`memory_consolidator.py:237-242`。
- 重复时直接跳过，不支持 merge/supersede/append_source：`memory_consolidator.py:163-165`。

### 优化

分为确定性和语义两层：

#### 确定性

- `normalized_content_sha256` 完全重复。
- 同一 `source_session_id + source_run_id + candidate_index` 幂等。
- 同类型 profile key 唯一，例如 `feedback:commit-language`。

#### 语义

- 先用 FTS top-k 召回。
- 对候选与 top-k 做结构化判定：`create/merge/supersede/duplicate/conflict`。
- 保存决策理由和来源，不直接丢弃冲突。

针对类型采用不同策略：

- user/feedback/preference：尽量维护少量 profile 文件。
- project/decision：按主题合并并保留决策日期。
- troubleshooting：按症状/根因合并。
- reference：新位置 supersede 旧位置。

---

## P1：frontmatter 解析和 schema 不统一

### 证据

- `memory_index._parse_memory_file()` 只读取 `name` 作为 title：`memory_index.py:58-73`。
- `context_orchestrator._parse_frontmatter()` 是另一套简单逐行解析：`context_orchestrator.py:274-287`。
- 自动沉淀写入 `name/description/type/source/...`：`memory_consolidator.py:222-234`。
- 设计文档和 UI 又使用 title/tags/confidence/inject 等字段。

列表 API 因此只返回 name/title/size/updated_at：`memory_index.py:313-329`。

### 优化

新增统一模块 `memory_schema.py`：

```python
@dataclass
class MemoryMetadata:
    title: str
    type: str
    source: str
    tags: list[str]
    confidence: float | None
    inject: str
    created_at: str | None
    updated_at: str | None
    session_id: str | None
    run_id: str | None
    sources: list[str]
```

职责：

- 统一 frontmatter parse/render/normalize。
- 兼容历史 `name`，规范输出 `title`。
- 未知字段原样保留，避免编辑后丢 metadata。
- 对 type/inject/confidence 做枚举校验。
- 敏感字段不进入前端列表响应。

如果不新增 YAML 依赖，可实现满足当前 schema 的受限解析器，但不能在多个模块复制解析逻辑。

---

## P1：整理 apply 缺少事务、并发前置条件和版本历史

### 证据

- apply 逐项直接写/删，最后重建索引：`backend/services/memory_service.py:270-337`。
- merge/refine 先写目标再逐个删除源文件：`backend/services/memory_service.py:288-317`。
- 没有校验 preview 之后文件是否已被用户或另一个任务修改。
- 删除使用固定 `<name>.md.bak`，已有同名 `.bak` 时 rename 可能失败：`memory_index.py:731-732`。

### 优化

preview action 增加：

```json
{
  "target_versions": {
    "a.md": "sha256:...",
    "b.md": "sha256:..."
  }
}
```

apply 前校验 hash；不一致返回 409，要求重新预览。

单批次 apply：

1. 创建 transaction_id。
2. 将所有将被改动文件复制到 `.history/<transaction_id>/`。
3. 在临时目录写全部新文件。
4. 校验 frontmatter、文件名和引用。
5. 原子 replace 到目标。
6. 源文件移动到带时间戳的 trash 路径。
7. 更新索引。
8. 写 change log。

提供 rollback API，使用户可按 transaction_id 恢复。

---

## P1：上下文召回耗时与取消语义不清晰

### 证据

- 整个召回通过 `asyncio.to_thread()` 包装，外层 15 秒超时：`server.py:1572-1583`。
- 长文候选可能逐个调用 LLM 提炼，单次内部超时 10 秒：`context_orchestrator.py:468-490`。
- Python 取消 `to_thread` 的 await 不会终止已经运行的线程；超时后工作线程仍可能继续，内部 LLM 子进程也会占用资源直到自己的 timeout。
- 多个候选顺序提炼，延迟会累加。

### 优化

1. 在线发送路径不执行临时 LLM 摘要，优先使用离线 summary cache。
2. 文件写入/索引时生成或异步刷新摘要。
3. 召回主链路只做 FTS、过滤、排序、截断，目标 P95 < 500ms。
4. 若确需在线提炼，设置整轮 deadline，并把 remaining timeout 传入每个调用。
5. 限制并发和每项目同时运行的 LLM 辅助任务数量。
6. trace 记录各阶段耗时：index/search/rank/summarize/format。

---

## P2：trace 只通过 SSE 短暂存在，无法复盘

当前 `context_injected` 会推送前端：`server.py:1638-1642`，但没有稳定 trace store。用户恢复历史会话后无法查看当时注入了什么，也无法评估错误命中。

### 优化

SQLite 表：

```sql
CREATE TABLE context_traces (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  run_id TEXT,
  project_id TEXT,
  query_hash TEXT,
  budget_tokens INTEGER,
  used_tokens INTEGER,
  candidate_count INTEGER,
  injected_json TEXT,
  skipped_json TEXT,
  errors_json TEXT,
  duration_ms INTEGER,
  created_at REAL NOT NULL
);
```

隐私建议：默认只保存 query hash 或有限摘要，完整用户输入由配置决定。

---

## P2：API 语义、项目边界与响应结构不统一

### 问题

- `GET /api/memory/index` 会触发重建，GET 产生副作用：`backend/routes/memory_routes.py:35-36`。
- `/api/memory/files` 返回裸数组，其余接口多返回对象。
- 错误文案为英文字符串，缺少稳定错误码：`backend/services/memory_service.py:47-70`。
- 列表和搜索没有 pagination/cursor/filter。
- 文件 API 以 POST 读取，且使用 basename。
- 多数 Memory API 直接接受客户端传入的 `cwd`：`backend/routes/memory_routes.py:30-63`。虽然服务默认绑定本机，但仍应统一 canonicalize，并限制为已知项目或用户明确选择的项目。
- 服务端路径导入会直接读取客户端提交的任意现存文件路径：`memory_index.py:823-847`。应限制允许目录、要求显式确认，并返回逐文件拒绝原因。

### 推荐 API

```text
GET    /api/memory/summary
GET    /api/memory/files?path_prefix=&type=&source=&inject=&cursor=&limit=
GET    /api/memory/files/<encoded-relative-path>
PUT    /api/memory/files/<encoded-relative-path>
DELETE /api/memory/files/<encoded-relative-path>
POST   /api/memory/index/rebuild
GET    /api/memory/search?q=&filters=&cursor=&limit=
GET    /api/memory/graph?path_prefix=&depth=&limit=

GET    /api/memory/candidates
POST   /api/memory/candidates/<id>/approve
POST   /api/memory/candidates/<id>/reject
PATCH  /api/memory/candidates/<id>

GET    /api/memory/jobs
POST   /api/memory/jobs/<id>/retry
GET    /api/memory/changes
POST   /api/memory/changes/<id>/rollback
```

统一响应：

```json
{
  "ok": false,
  "error": {
    "code": "MEMORY_VERSION_CONFLICT",
    "message": "记忆文件已被修改，请重新加载后再保存",
    "details": {}
  }
}
```

---

## 5. 目标数据模型

建议继续以 Markdown 为事实源，SQLite 作为索引、作业、审计和候选状态库。

```text
Markdown files             SQLite
────────────────────       ─────────────────────────
正文与可读 frontmatter      memories 元数据与检索索引
raw/wiki/profile 内容       memory_jobs 后台任务
可被 Claude Code 读取       memory_candidates 待审核候选
                            memory_changes 版本与回滚
                            context_traces 注入审计
```

### 5.1 稳定 ID

- project_id：规范化 cwd 的 SHA-256，不直接把完整私有路径作为对外 ID。
- memory_id：`sha256(project_id + "\0" + relative_path)`。
- path：项目 memory 根目录相对路径，是当前版本的唯一定位键。
- content_sha256：乐观并发与变更检测。

### 5.2 状态机

候选：

```text
pending → approved → applying → applied
       ↘ rejected
       ↘ expired
applying → failed → pending/retry
```

任务：

```text
queued → running → completed
               ↘ failed → queued(retry)
               ↘ interrupted
queued → cancelled
```

---

## 6. 检索优化方案

### 6.1 两阶段召回

第一阶段：高召回 FTS top 30。

- title 权重高于正文。
- 当前项目 profile/feedback/project 加权。
- `inject: never` 预过滤。
- pending/raw 按设置过滤。

第二阶段：本地确定性重排到 top 6。

```text
score = bm25_normalized
      + title_overlap
      + exact_phrase
      + type_boost
      + recency_boost
      + source_quality
      - stale_penalty
      - length_penalty
```

当前 `_rank_relevant_candidates()` 已有雏形：`context_orchestrator.py:304-345`，应把分数信号结构化输出，避免 reason 只是一段拼接文字。

### 6.2 中文策略

- jieba 可用时记录词典版本/自定义词典 hash。
- 为项目术语、文件名、API key 名称建立 user dictionary。
- bigram 仅作为无依赖 fallback。
- 搜索评测同时覆盖 jieba 和 fallback 两种环境。

### 6.3 摘要缓存

```sql
CREATE TABLE memory_summaries (
  memory_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  summary_kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  model TEXT,
  created_at REAL NOT NULL,
  PRIMARY KEY(memory_id, content_sha256, summary_kind)
);
```

至少提供两类：

- `generic`：稳定短摘要，在线召回优先使用。
- `sections`：保留标题和关键段落，查询时本地选择。

避免每次发送临时启动 CLI 进行摘要。

---

## 7. 安全与隐私

### 7.1 敏感检测

当前单一正则应升级为分层检测：

- 确定性 secret pattern。
- 高熵字符串。
- `.env`、Authorization、private key 上下文。
- 路径和身份信息按配置脱敏。

处理不是简单丢弃：

```text
safe       正常候选
redacted   脱敏后进入 pending
blocked    不持久化，只记录 blocked reason
```

不得在 job error、trace 或日志中回显 secret 原文。

### 7.2 Prompt injection

现有注入声明应保留。进一步建议：

- raw 默认永不自动注入。
- 外部来源记忆默认 `inject: manual`。
- 对含“忽略之前指令/执行命令”等模式的资料降低权重并标记。
- 注入内容使用明确边界和转义，不允许记忆闭合 `<memory>` 标签；当前正文直接拼接，建议至少转义或采用长度前缀的安全格式：`context_orchestrator.py:255-268`。

### 7.3 路径安全

改用相对路径后，必须以 resolve containment 校验替代 basename 剥离。支持子目录不等于允许任意路径。

---

## 8. 可观测性

每个沉淀 job 记录：

- queue_wait_ms、extract_ms、dedupe_ms、write_ms、index_ms。
- extraction_source/model/status。
- candidate/applied/rejected/duplicate 数量。
- 错误码，不保存敏感原文。

每次召回记录：

- index_refresh_ms、fts_ms、rerank_ms、summary_ms、total_ms。
- candidate_count、filtered_count、injected_count。
- token budget、估算误差抽样。
- 命中来源与跳过原因。

推荐结构化日志：

```text
memory.job.completed job=... project=... candidates=2 applied=1 duration_ms=830
memory.retrieve.completed trace=... fts_ms=14 rank_ms=3 injected=3 total_ms=24
```

---

## 9. 测试策略

当前项目没有统一测试框架，但记忆系统应新增标准库 `unittest` 测试，不要求引入大型依赖。

### 9.1 单元测试

#### 路径

- 根目录文件与多级目录文件。
- 不同目录同名文件。
- `../`、绝对路径、Windows 盘符、反斜杠穿越。
- 软删除和恢复。

#### 索引

- 新建、修改、删除的增量索引。
- jieba 与 bigram fallback。
- 中文短查询、英文符号、API 名称。
- 正文 snippet 正确。
- tokenizer/schema 版本迁移。

#### 沉淀

- LLM 成功空结果与失败可区分。
- regex fallback 真正触发。
- 敏感候选 blocked/redacted。
- 同 run 幂等。
- 并发 job 不丢状态。

#### 整理

- preview 后文件变化导致 409。
- merge 部分失败不破坏源文件。
- rollback 恢复全部文件与索引。

### 9.2 集成测试

使用临时 HOME 和临时 cwd：

```text
写 Markdown
→ 建索引
→ 搜索命中
→ 生成候选
→ 批准写入
→ 后续 context retrieve 命中
→ 验证 inject: never/raw 不进入注入
```

### 9.3 检索评测集

维护 30～100 条固定 query → expected memory：

- 中文同义表达。
- 中英文混合技术词。
- 常见词噪声。
- 负样本：不应召回。
- 冲突记忆与过期记忆。

指标：Recall@5、MRR、误注入率、平均注入 token。

---

## 10. 分阶段实施

### Phase 0：修复正确性缺陷（2～4 天）

- 抽取结果改为显式 status，恢复 regex fallback。
- LLM 候选补齐 session_id/run_id。
- 修复 FTS snippet 列。
- 默认沉淀模式改为 suggest 或 safe。
- 为 job JSON 临时增加进程内锁，作为 SQLite 迁移前止血。
- 统一 canonical cwd，并限制服务端路径导入范围。
- 更新现有记忆设计文档的实施状态；例如 `docs/auto-memory-consolidation-design.md:2-5` 仍标记“尚未实现”，但核心 MVP 已落地，应建立“设计/已实现/待实现”状态清单，避免文档与代码继续漂移。

### Phase 1：相对路径与 schema 统一（4～7 天）

- `path` 成为主键，支持多级目录和同名文件。
- 新增统一 frontmatter parser/renderer。
- API 和图谱使用 path。
- 索引 schema_version 与重建迁移。

### Phase 2：SQLite job/candidate/trace（4～7 天）

- 迁移 job store。
- 新增 candidates 状态机和审核 API。
- 持久化 context trace。
- 加保留与清理策略。

### Phase 3：安全写入与版本历史（4～7 天）

- content hash 前置条件。
- apply transaction、history/trash、rollback。
- 删除 `.bak` 改为唯一回收站路径。
- 写入 change log。

### Phase 4：增量索引与摘要缓存（4～7 天）

- 文件级 upsert/delete。
- 离线 summary cache。
- 发送前召回目标 P95 < 500ms。
- 索引损坏自动恢复。

### Phase 5：质量治理（持续）

- 类型化 merge/supersede/conflict。
- 检索评测集与回归指标。
- 断链、孤立、过长、过期 lint。
- 候选自动过期与误写反馈闭环。

---

## 11. 验收标准

### 数据正确性

- [ ] 不同目录同名文件可独立读取、搜索、编辑、删除和展示。
- [ ] 所有 API 使用稳定相对路径，不发生 basename 随机命中。
- [ ] preview 后文件变化会阻止 apply。
- [ ] 每次写入均可通过 change_id 回滚。

### 沉淀可靠性

- [ ] LLM 调用失败会明确记录并触发规则兜底。
- [ ] LLM 成功返回空数组不会误触发规则。
- [ ] 同一 session/run 至多生成一个有效 job。
- [ ] 并发 20 个 job 不丢失状态。
- [ ] 默认不会未经审核自动注入低置信候选。

### 检索质量

- [ ] 中文 Recall@5 达到既定评测基线。
- [ ] 搜索结果返回正文命中片段。
- [ ] `inject: never`、pending、默认 raw 永不进入自动注入。
- [ ] 发送前召回 P95 < 500ms，不临时调用 LLM 时 P99 < 1s。
- [ ] 超预算时稳定裁剪且 trace 可解释。

### 安全与隐私

- [ ] 路径穿越测试全部拒绝。
- [ ] secret 不进入 Markdown、job、trace、日志。
- [ ] 记忆正文不能逃逸注入边界形成伪指令。
- [ ] 回收站与历史版本有明确保留和清理策略。

### 可运维性

- [ ] 索引损坏可自动重建。
- [ ] tokenizer 或 schema 变化可迁移。
- [ ] job、candidate、trace 可分页查询。
- [ ] 关键阶段有结构化耗时和错误码。
