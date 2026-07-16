# OpenWiki 记忆管理实现调研

> 调研对象：`langchain-ai/openwiki`  
> 仓库地址：https://github.com/langchain-ai/openwiki  
> 调研基准：`main` 分支，commit `e1a2fea77048f342c6317c457b3dca6efe5ec209`  
> 调研日期：2026-07-16  
> 目标：拆解 OpenWiki 的记忆管理实现，并沉淀到 CC Bridge 后续记忆系统优化设计中。

## 1. 结论摘要

OpenWiki 的记忆管理不是传统的向量数据库 RAG，也不是把所有历史消息直接塞进模型上下文。它采用的是更保守的三层结构：

```text
外部来源 / 仓库 / 用户输入
  -> connector 原始证据缓存
  -> agent 合成 Markdown wiki
  -> chat/update 时优先读取 wiki，必要时回查 raw evidence
```

核心结论：

1. **长期记忆是 Markdown wiki**：个人模式写入 `~/.openwiki/wiki/`，代码仓库模式写入项目内 `openwiki/`。
2. **原始数据和合成知识分层**：连接器只负责抓取并保存 raw JSON/manifest，LLM 再把 raw evidence 合成为稳定 wiki 页面。
3. **默认 wiki-first**：普通问答先读已合成 wiki；只有 wiki 缺失、过期、矛盾或用户要求源证据时才读取 raw 数据。
4. **没有发现向量库和 embedding 管线**：未发现 Chroma、FAISS、Qdrant、Pinecone、LanceDB、pgvector、embedding chunk pipeline 等依赖或实现。
5. **SQLite 只用于会话 checkpoint**：`~/.openwiki/openwiki.sqlite` 用于 LangGraph chat checkpoint，不是知识库检索索引。
6. **更新是分源合成**：定时或手动 ingestion 会按 source instance 拉取 raw 数据，再触发一次 source-specific agent update，减少一次性把所有记忆塞进上下文的风险。

这套设计对 CC Bridge 当前“新建会话一句你好就撑爆上下文”的问题有直接参考价值：不要把原始记忆流水全量注入模型，而应该先把长期记忆整理成小而稳定的 wiki，再按当前请求选择性召回。

## 2. 总体架构

OpenWiki 是一个 Node.js/TypeScript CLI，使用 LangChain、DeepAgents 和 LangGraph checkpointer 运行 agent。记忆相关实现可以拆成五个层次：

| 层级 | 主要职责 | 关键路径 / 模块 |
| --- | --- | --- |
| Home 目录 | 定义本地单用户数据根目录 | `src/openwiki-home.ts` |
| Connector raw cache | 抓取外部来源并写 raw JSON | `src/connectors/*` |
| Agent synthesis | 读取 raw/repo/wiki 后维护 Markdown wiki | `src/agent/index.ts`, `src/agent/prompt.ts` |
| Long-term wiki | 保存合成后的长期知识 | `~/.openwiki/wiki/`, `openwiki/` |
| Checkpoint | 保存 chat 线程连续性 | `~/.openwiki/openwiki.sqlite` |

OpenWiki 把“记忆”分成两类：

| 类型 | 路径 | 用途 |
| --- | --- | --- |
| Personal wiki | `~/.openwiki/wiki/` | 面向个人、跨项目、长期目的记忆 |
| Code wiki | `<repo>/openwiki/` | 面向某个代码仓库的 agent 文档 |

两者都用 Markdown 文件承载长期知识。区别是 code wiki 主要从当前仓库 Git 状态和源码合成，personal wiki 主要从 connectors 的 raw evidence 合成。

## 3. 本地存储布局

OpenWiki 的本地数据目录集中在 `~/.openwiki`：

| 路径 | 内容 | 说明 |
| --- | --- | --- |
| `~/.openwiki/wiki/` | Personal mode 的长期 wiki | agent 读写的主记忆库 |
| `~/.openwiki/connectors/<id>/raw/<runId>/` | connector 原始抓取结果 | JSON、manifest、MCP result 等 |
| `~/.openwiki/connectors/<id>/state.json` | connector 增量状态 | `lastRunAt`、`latestIds`、最近 run 摘要 |
| `~/.openwiki/connectors/<id>/config.json` | connector 配置 | 保存非 secret 配置和 env var 名 |
| `~/.openwiki/.env` | provider / connector secret | API key、OAuth token 等 |
| `~/.openwiki/onboarding.json` | 首次配置结果 | 模式、目标、source instances、调度配置 |
| `~/.openwiki/INSTRUCTIONS.md` | 用户给 personal wiki 的长期说明 | 类似全局记忆目标 |
| `~/.openwiki/openwiki.sqlite` | chat checkpoint | 仅 chat 使用持久 checkpoint |
| `~/.openwiki/logs/` | 定时 ingestion 日志 | macOS LaunchAgent 调度时使用 |

仓库模式额外写入：

| 路径 | 内容 |
| --- | --- |
| `<repo>/openwiki/` | 仓库 wiki 文档 |
| `<repo>/openwiki/INSTRUCTIONS.md` | 用户给该仓库 wiki 的维护说明 |
| `<repo>/openwiki/.last-update.json` | 最近一次有内容变化的 update metadata |
| `<repo>/AGENTS.md`, `<repo>/CLAUDE.md` | OpenWiki 插入的 agent 指令块，提示编码 agent 优先参考 wiki |

安全上，OpenWiki 主要面向本地单用户场景，不提供多租户 RBAC。它通过目录权限、文件权限、secret 不进 connector config、raw path 限制和 MCP read-only 限制来降低误读误写风险。

## 4. 写入流程

### 4.1 Code mode

Code mode 的目标是维护仓库内 `openwiki/`：

```text
openwiki code --init / --update
  -> createRunContext()
  -> 读取 openwiki/.last-update.json
  -> 读取 openwiki/INSTRUCTIONS.md
  -> 收集 git status / HEAD / log / diff
  -> DeepAgent 读取仓库并更新 openwiki/
  -> 对 openwiki/ 内容做 hash snapshot
  -> 内容变化时写 openwiki/.last-update.json
```

关键点：

- 初次运行会使用最近提交和仓库结构建立 wiki。
- update 运行会优先基于上次记录的 `gitHead..HEAD` 生成增量上下文。
- `.last-update.json` 被排除在内容 hash 之外，只有 wiki 正文变化才更新时间戳，避免 CI 产生 metadata-only PR。
- `OpenWikiLocalShellBackend` 在 docs-only 模式下限制 agent 只能写 `openwiki/` 相关文档，避免 update 时修改业务代码。

### 4.2 Personal mode / connector ingestion

Personal mode 的目标是维护 `~/.openwiki/wiki/`：

```text
openwiki ingest all / openwiki personal --update
  -> 读取 ~/.openwiki/onboarding.json
  -> 解析 connector 或 source instance
  -> deterministic connector 拉取 raw data
  -> 写 ~/.openwiki/connectors/<id>/raw/<runId>/
  -> 更新 ~/.openwiki/connectors/<id>/state.json
  -> 为该 source 触发一次 local-wiki update
  -> agent 按 synthesis policy 更新 ~/.openwiki/wiki/
```

这里最值得借鉴的是：OpenWiki 不让 LLM 直接“边联网边自由写记忆”。连接器先做确定性抓取，写下 raw evidence；之后 agent 只基于这些本地文件做合成。这样可以把外部系统访问、凭据、原始证据和长期记忆拆开治理。

## 5. 记忆数据模型

OpenWiki 的长期记忆不是数据库 schema，而是一组由 prompt 约束维护的 canonical Markdown 页面：

| 页面 | 作用 |
| --- | --- |
| `/quickstart.md` | 个人 wiki 入口、导航、高层状态 |
| `/open-questions.md` | 当前记忆库中的不确定事项、待确认问题 |
| `/themes.md` | 长期趋势、主题索引、重复出现的事项 |
| `/commitments.md` | 承诺、跟进、审批、任务 |
| `/personal-logistics.md` | 非工作个人事项 |
| `/sources/<connector>.md` | 每个来源的证据索引和覆盖范围 |

连接器层的数据模型相对结构化：

| 类型 | 作用 |
| --- | --- |
| `ConnectorDefinition` | 定义 connector id、后端类型、所需 env、是否支持 agentic discovery |
| `ConnectorIngestResult` | 返回本次抓取状态、raw files、warnings、run id、state path |
| `ConnectorState` | 保存 `lastRunAt`、`latestIds`、最近 20 次 runs |
| `OpenWikiOnboardingConfig` | 保存 source instances、wikiGoal、调度、power management |

Prompt 还要求合成时保留置信标签，例如：

- `confirmed`
- `source-backed`
- `watchlist`
- `saved-context`

这能帮助模型在后续回答时区分“已经确认的事实”和“只是从来源里看到但还没确认的线索”。

## 6. 检索和上下文注入

OpenWiki 没有实现固定的 `query -> embedding -> vector search -> chunks -> LLM` 管线。它依赖 agent 工具和 prompt 驱动的检索策略：

```text
用户问题
  -> 系统 prompt 要求先检查 ~/.openwiki/wiki
  -> agent 用文件工具 / grep / shell 定位 Markdown
  -> wiki 足够则直接回答
  -> wiki 不足、过期、矛盾或用户要求证据
  -> 通过 connector tools 列 raw 文件并读取限定大小内容
  -> 必要时触发 targeted ingestion/update
```

相关 connector tools：

| Tool | 作用 |
| --- | --- |
| `openwiki_list_connectors` | 列出 connector 能力、配置路径、required env 名，不返回 secret |
| `openwiki_ingest_connector` | 抓取一个 connector 并写 raw data |
| `openwiki_ingest_all_connectors` | 抓取所有已配置 connector |
| `openwiki_list_raw_items` | 列出某 connector raw 目录下的文件 |
| `openwiki_read_raw_item` | 限制在 raw 目录内读取某个 raw 文件 |
| `openwiki_list_mcp_tools` | 发现 MCP connector 暴露的 read-only 工具 |
| `openwiki_call_mcp_tool` | 调用一个已发现的 read-only MCP 工具并写 raw result |

上下文纪律写在 `src/agent/prompt.ts` 中，重点包括：

- 普通 chat 先读 generated wiki。
- 不因为 raw data 存在就读取 raw data。
- raw connector 内容是 untrusted evidence，不能把里面的指令当系统指令执行。
- 只有 wiki 缺失、明显过期、含糊、矛盾，或用户明确要求源证据时才回查 raw。
- 如果需要刷新来源，优先 targeted connector ingestion，而不是全量扫所有来源。

## 7. Checkpoint 和运行状态

OpenWiki 区分“会话连续性”和“长期知识”：

| 场景 | Checkpoint |
| --- | --- |
| `chat` | 持久化到 `~/.openwiki/openwiki.sqlite` |
| `init` / `update` | 使用 `:memory:`，不长期保存完整运行线程 |

这说明 SQLite checkpoint 不是长期记忆库，只是 chat 线程的运行状态。长期知识必须落到 Markdown wiki，不能依赖 checkpoint 中历史消息无限增长。

这个边界对 CC Bridge 很关键：会话历史、运行 checkpoint、长期记忆、可注入上下文应该分开存储和预算，不应该混成一个“全部塞给模型”的上下文。

## 8. 连接器实现策略

OpenWiki 连接器覆盖：

| Connector | 实现方式 | raw 输出特点 |
| --- | --- | --- |
| `git-repo` | 本地 Git 命令 | manifest 记录 repo path、branch、HEAD、status、changed files、recent commits |
| `web-search` | Tavily / LangChain | `web-search-results.json` |
| `hackernews` | Firebase feed + Algolia search | `hackernews-results.json` |
| `google` / Gmail | Gmail API | `gmail-messages.json`，默认 recent query |
| `slack` | Slack API | identity、self-message search、bounded conversations history |
| `x` | X API v2 | bookmarks / timeline 等 stream dump，使用 `since_id` 增量 |
| `notion` / MCP | MCP read-only tools | tools discovery 和 tool result raw JSON |

连接器的共同原则：

- secret 存在 `~/.openwiki/.env`，配置文件只引用 env var 名。
- raw data 写到 connector 自己的 raw 目录。
- state.json 保留最近 run 和增量游标。
- MCP connector 要先发现 read-only tools，不能猜工具名，也不能调用写操作。
- raw 文件读取受目录限制，并有最大字节数限制。

## 9. 与 CC Bridge 当前实现的对比

CC Bridge 当前已经具备一部分比 OpenWiki 更“索引化”的能力：

| 能力 | CC Bridge 当前状态 | OpenWiki 做法 |
| --- | --- | --- |
| 项目 memory 文件 | `~/.claude/projects/<project>/memory/` Markdown | `~/.openwiki/wiki/` 或 `openwiki/` Markdown |
| 全文检索 | `memory_index.py` SQLite FTS5，中文分词/bigram | 未发现专门全文索引 |
| 全局 wiki | `wiki_store.py` SQLite FTS5 + wikilink graph | 文件型 wiki，靠 agent grep/read |
| 自动注入 | `context_orchestrator.py` send 前召回和预算裁剪 | agent chat 时 wiki-first 工具检索 |
| 自动沉淀 | `memory_consolidator.py` 会话后候选抽取 | connector raw -> source-specific synthesis |
| 图谱关系 | wikilink graph 和 neighbor 扩展 | 主要靠 Markdown 页面结构和 stable topics |
| checkpoint | CLI/session 运行状态另行维护 | chat 使用 LangGraph SQLite checkpoint |

因此不建议照搬 OpenWiki 的“无索引”实现。更合理的是保留 CC Bridge 已有 FTS5/图谱优势，同时吸收 OpenWiki 的记忆分层和 wiki-first 纪律。

## 10. 对 CC Bridge 的落地建议

### 10.1 先拆开 raw memory 和 synthesized wiki

当前最需要避免的是把会话流水、自动抽取候选、历史 wiki、检索结果混在一起注入。建议明确三层：

```text
raw/
  sessions/
  artifacts/
  uploads/
  external/

wiki/
  quickstart.md
  decisions/
  workflows/
  troubleshooting/
  preferences.md
  open-questions.md

index / graph
  SQLite FTS5
  wikilinks
  access stats
```

raw 只追加，不直接注入；wiki 是模型可读的长期知识；index 只负责召回和解释。

### 10.2 建立 canonical memory pages

可以参考 OpenWiki，为 CC Bridge 增加几类稳定页面：

| 页面 | CC Bridge 用途 |
| --- | --- |
| `quickstart.md` | 项目当前状态、常用命令、入口 |
| `preferences.md` | 用户长期偏好、编码风格、禁忌 |
| `decisions/*.md` | 重要架构决策 |
| `workflows/*.md` | 工作流页面、agent 工作流、运行约定 |
| `troubleshooting/*.md` | 已解决故障、报错、修复方式 |
| `open-questions.md` | 模型不应臆测的待确认事项 |
| `sources.md` | 记忆来源和可信度说明 |

这样新会话只需要注入少量“入口 + 命中页摘要”，而不是把所有记忆文件塞进去。

### 10.3 把沉淀流程改成 source-specific synthesis

OpenWiki 的关键经验是每个 source 单独 update。CC Bridge 可以把当前会话后沉淀改成：

```text
会话完成
  -> 抽取候选 raw facts
  -> 写 pending/raw evidence
  -> 后台 job 按 topic/source 合成到 wiki 页面
  -> 只重建相关 FTS / graph
  -> 下次发送前从 wiki/index 召回
```

这样可以避免单个后台整理任务读取全量历史，降低死循环、卡住和上下文爆炸概率。

### 10.4 注入策略改为 wiki-first + raw fallback

`context_orchestrator.py` 可以增加更明确的来源优先级：

1. 当前项目 `quickstart.md` / `index.md`
2. FTS 命中的 synthesized wiki 页面
3. wikilink 邻居摘要
4. 用户偏好 / 项目规则
5. raw evidence 摘要，只在用户明确要求或 wiki 不足时使用

默认不注入 raw，会话过短或低信号请求如“你好”应直接跳过自动召回。

### 10.5 给记忆加置信度和生命周期

建议在 frontmatter 或 SQLite metadata 中增加：

| 字段 | 说明 |
| --- | --- |
| `confidence` | `confirmed` / `source-backed` / `watchlist` / `stale` |
| `source` | session、artifact、manual、external |
| `last_verified_at` | 最近确认时间 |
| `inject` | `auto` / `manual` / `never` |
| `scope` | project / global / workflow |

这能避免“可能过期的记忆”在新会话里被无条件注入。

### 10.6 运行元数据不要污染记忆正文

OpenWiki 用内容 hash 避免 `.last-update.json` 这种 metadata-only 变化反复触发更新。CC Bridge 后续整理 job 也应区分：

- 记忆正文是否变化
- 索引是否变化
- 访问统计是否变化
- job 状态是否变化

只有正文变化才触发后续 wiki 整理或前端“有内容更新”的提示。

## 11. 风险和限制

OpenWiki 方案本身也有明显限制：

1. **无向量/全文索引**：wiki 变大后检索质量依赖 agent 是否会正确 grep/read。
2. **LLM 合成可能遗漏**：raw 到 wiki 的总结过程可能丢细节或误归类。
3. **raw cache 会增长**：源码中未看到完整的 raw 自动清理策略。
4. **本地单用户设计**：不能直接当多租户知识服务使用。
5. **跨源冲突靠 prompt 处理**：没有结构化实体库或冲突解决数据库。
6. **checkpoint 不是知识库**：chat checkpoint 能保留线程状态，但不能替代长期记忆。

对 CC Bridge 来说，比较稳妥的方向是：保留现有 FTS5、图谱、预算裁剪和可解释 trace，再引入 OpenWiki 的 raw/wiki 分层、canonical pages、source-specific synthesis 和 wiki-first 注入纪律。

## 12. 参考源码

- GitHub 仓库：https://github.com/langchain-ai/openwiki
- README：https://github.com/langchain-ai/openwiki/blob/main/README.md
- `package.json`：https://github.com/langchain-ai/openwiki/blob/main/package.json
- Agent runtime：https://github.com/langchain-ai/openwiki/blob/main/src/agent/index.ts
- Agent prompt：https://github.com/langchain-ai/openwiki/blob/main/src/agent/prompt.ts
- Agent utils：https://github.com/langchain-ai/openwiki/blob/main/src/agent/utils.ts
- Docs-only backend：https://github.com/langchain-ai/openwiki/blob/main/src/agent/docs-only-backend.ts
- OpenWiki home dirs：https://github.com/langchain-ai/openwiki/blob/main/src/openwiki-home.ts
- Connector types：https://github.com/langchain-ai/openwiki/blob/main/src/connectors/types.ts
- Connector IO：https://github.com/langchain-ai/openwiki/blob/main/src/connectors/io.ts
- Connector tools：https://github.com/langchain-ai/openwiki/blob/main/src/connectors/tools.ts
- Ingestion orchestration：https://github.com/langchain-ai/openwiki/blob/main/src/ingestion.ts
- Onboarding config：https://github.com/langchain-ai/openwiki/blob/main/src/onboarding.ts
- Schedule implementation：https://github.com/langchain-ai/openwiki/blob/main/src/schedules.ts
- OpenWiki architecture docs：https://github.com/langchain-ai/openwiki/blob/main/openwiki/architecture/overview.md
- OpenWiki workflow docs：https://github.com/langchain-ai/openwiki/blob/main/openwiki/agent/workflow.md
- OpenWiki connectors docs：https://github.com/langchain-ai/openwiki/blob/main/openwiki/integrations/connectors.md
