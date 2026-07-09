# 记忆整理接入 LLM（去重 + 纠错）—— 设计文档

> 版本：v1.0 — 2026-07-09
> 相关文件：memory_llm.py , backend/services/memory_service.py , server.py , static/memory.js , static/index.html , static/i18n/{en,zh}.json

---

## 1. 背景与目标

### 1.1 问题

记忆页「整理 / Organize」按钮现在只做一件事：`organize_memory_links()`（`memory_index.py:573`）按词重叠相似度给文件加 `[[wikilink]]` 双链。**不删、不合并、不修正内容**。

但用户实际遇到两类 LLM 才解决得了的问题：

1. **跨文件重复**：同一条事实 / 偏好被写进多个记忆文件（措辞不同、语义相同），库里冗余，注入时占 token 预算。
2. **内容不准确**：某条记忆记错了 / 过时 / 自相矛盾，应该修正或删除。

这两类问题的共同特点：需要**语义理解**才能判断（"用 TypeScript 写后端" 和 "后端代码用 TS" 是同一事实），纯规则匹配搞不定。

### 1.2 目标

给 Organize 接入 LLM，生成「整理方案」（merge / delete / rewrite / keep + 理由），前端用复核模态列出、用户勾选确认后才写盘。

---

## 2. 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│                        浏览器                                 │
│  ┌─ Organize 按钮 ───────────────────────────────────────┐  │
│  │  1. POST /api/memory/organize/preview {cwd}            │  │
│  │     → 先跑 fast wikilink 步，再跑 LLM 分析 → 返回方案  │  │
│  │  2. 渲染复核模态（每动作一行 + 勾选 + 理由）            │  │
│  │  3. 用户确认 → POST /api/memory/organize/apply         │  │
│  │     → 执行 merge/delete/rewrite → 重建索引 → 刷新 UI    │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────┬───────────────────────────────────────┘
                       │ fetch
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                        server.py                              │
│  handle_api_post 内前置两个异步路由：                          │
│  /api/memory/organize/preview  → await preview_memory_organize│
│  /api/memory/organize/apply    → asyncio.to_thread(apply)     │
│  （在通用 dispatch 前特殊处理，因原有 dispatch 是 sync）        │
└───────────┬───────────────────────────────────────┬──────────┘
            │                                       │
            ▼                                       ▼
┌───────────────────┐  ┌──────────────────────────────────────┐
│ memory_llm.py      │  │ backend/services/memory_service.py   │
│ - _run_llm_oneshot │  │ - preview_memory_organize(cwd)       │
│   通用异步子进程内核 │  │   1. wikilink 步（快速确定性）       │
│ - llm_json(prompt) │  │   2. 列出全部记忆 → 截断拼 prompt     │
│   通用 JSON 调用器  │  │   3. await llm_json → 拿到 action 列表│
│ - _ORGANIZE_PROMPT │  │   4. 归一化（剔幻觉文件名）+ 返回     │
│   整理专用 prompt   │  │ - apply_memory_organize(cwd, actions)│
│                    │  │   逐条执行 + 全量重建索引              │
└───────────────────┘  └──────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────┐
│ memory_index.py（只读复用，不改）                              │
│ save_memory_file / delete_memory_file(.bak 安全删除)          │
│ list_memory_files / get_memory_file / index_memory(force=True)│
│ organize_memory_links（wikilink，preview 第 1 步）             │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 核心设计原则

| 原则 | 说明 |
|------|------|
| **review-then-apply** | LLM 先出方案，用户勾选确认后才写盘。记忆是持久上下文，LLM 可能误判。 |
| **只删不毁** | 删除走 `delete_memory_file`（改名 `.bak`），绝不 `os.remove`。 |
| **LLM 不可用时降级** | 如果 `memory_llm` 不可用或 LLM 调用失败，只跑 wikilink 步 + 返回空方案 + 提示，不阻塞页面。 |
| **复用现有工具** | 写/删/索引全走 `memory_index` 已有函数，不改存储格式。 |
| **手动触发** | 仅点「整理」按钮触发，不在归纳后自动跑（避免每轮额外 LLM 开销）。 |

---

## 3. 后端设计

### 3.1 `memory_llm.py` — 通用 LLM 调用器

新增两个函数，复用现有的 `extract_memories_via_llm` 的子进程内核（spawn CLI + stream-json 累积 + `_extract_text` + probe 会话清理）：

```python
async def _run_llm_oneshot(
    prompt: str,
    model: str,
    cwd: str,
    cli: str | None = None,
    skip_permissions: bool = True,
    timeout: float = 120.0,
) -> str:
    """运行一次 ccb one-shot stream-json 子进程，返回累积的助手文本；任何失败返回 ''。"""
```

```python
async def llm_json(
    prompt: str,
    model: str,
    cwd: str,
    cli: str | None = None,
    skip_permissions: bool = True,
    timeout: float = 120.0,
) -> list | dict | None:
    """通用 LLM 一次性调用，返回解析后的 JSON；任何失败返回 None，绝不抛出。"""
```

新增 `_parse_json_lenient(text)`：剥 markdown 围栏 → 优先截取 `[...]` 或 `{...}` 片段 → `json.loads`，失败返回 `None`。与 `_parse_memory_json` 共用剥离逻辑但通用化。

### 3.2 `backend/services/memory_service.py` — preview + apply

#### `async def preview_memory_organize(cwd: str) -> dict`

流程：

1. **先跑 wikilink 步**：`organize_memory_links(cwd)` → `{linked, skipped, pairs}`。快速确定性，总是先做。
2. **构建记忆清单**：`list_memory_files(cwd)` + `get_memory_file(name, cwd)` 逐个取全文。每文件内容截 ~1500 字；若 >40 文件，溢出文件只保留 title。
3. **模型解析**：从 `get_gui_settings()` 取 `memory_assistant_model`，空则 `get_default_model()`。
4. **调 LLM**：`actions = await memory_llm.llm_json(prompt, model, cwd, timeout=120.0)`。`None` 或非 list → `actions = []`，带 message。
5. **归一化**：
   - 只留 action ∈ {keep, merge, delete, rewrite}
   - targets 与 `list_memory_files` 返回的真实文件名集合取交（剔除 LLM 幻觉文件名）
   - merge：≥2 targets + new_content 必填
   - rewrite：1 target + new_content 必填
   - 每条加 `id`（index）
6. **返回** `{actions, linked, skipped, pairs, message, model}`。

`memory_llm` 不可用时 catch `ImportError`，只返回 wikilink 结果 + `message: "LLM 模块不可用，仅完成 wikilink 链接"`。

#### `def apply_memory_organize(cwd: str, actions: list[dict]) -> dict`

同步函数，经 `asyncio.to_thread` 运行，不阻塞事件循环。逐条执行：

| action | 操作 |
|--------|------|
| **keep** | no-op |
| **rewrite** | `save_memory_file(targets[0], new_content, cwd)` |
| **merge** | 先 `save_memory_file(new_filename, new_content, cwd)`，再对每个 source `delete_memory_file(source, cwd)`（跳过与 new_filename 同名的 source） |
| **delete** | `delete_memory_file(targets[0], cwd)` |

每条 `try/except`，失败入 `errors` 继续。末尾 `index_memory(cwd, force=True)` 全量重建索引。

返回 `{merged, deleted, rewritten, errors}`。

### 3.3 `server.py` — 路由特殊处理

`handle_api_post`（`server.py:2972`）里，在通用 `elif path.startswith("/api/memory/")`（`:3240`）**之前**插入两个 `elif`：

```python
elif path == "/api/memory/organize/preview":
    result = await preview_memory_organize(data.get("cwd", DEFAULT_CWD))
    resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
    await send_response(writer, 200, "application/json; charset=utf-8", resp)
    return

elif path == "/api/memory/organize/apply":
    result = await asyncio.to_thread(
        apply_memory_organize, data.get("cwd", DEFAULT_CWD), data.get("actions") or []
    )
    ...
```

**为什么特殊处理**：`handle_memory_post` 是 sync 函数，不能 `await` 异步的 `preview_memory_organize`。这两个新路由直接在 async 的 `handle_api_post` 里处理，绕开 sync dispatch。

原有 `/api/memory/organize`(wikilink-only) 保留不动——preview 内部已调它。

---

## 4. LLM Prompt 设计

```text
你是一个记忆库整理助手。下面是一个项目的全部记忆文件清单。你的任务是找出两类问题并给出修正建议：
1. 跨文件重复：同一条事实/规则/偏好出现在多个文件里（措辞不同但语义相同）。
2. 内容不准确：某条记忆明显错误、过时或自相矛盾，应当修正或删除。

【严格要求】
- 只标记真正的重复和真正的不准确。绝大多数文件应保持为 "keep"。
- 不要因为主题相近就合并 — 只有"同一事实被重复记录"才算重复。
- 不要重写正确的内容。只有"确有错误"才给 rewrite。
- delete 仅用于"完全无价值或已被其他文件完全覆盖"的情况，谨慎使用。
- 合并后的 new_content 必须保留所有被合并文件中的有效信息，不要丢内容。
- 严格只输出一个 JSON 数组，不要任何解释文字、markdown 或代码围栏。

【输出格式】每个元素：
{"action": "keep | merge | delete | rewrite",
 "targets": ["文件名.md", ...],
 "new_filename": "可选，merge 时建议的新文件名",
 "new_content": "可选，merge/rewrite 时的完整新内容",
 "reason": "简短中文说明"}

- keep: targets 是单个文件，其余字段留空。
- merge: targets 是 2 个及以上被合并文件，new_filename 给合并后文件名，new_content 给合并后完整正文（含 frontmatter）。
- delete: targets 是单个要删除的文件。删除前确认其信息已被其他文件覆盖或确无价值。
- rewrite: targets 是单个文件，new_content 是修正后的完整正文（保留 frontmatter）。

【记忆文件清单】
{memories}
```

`{memories}` 占位符用 `.replace()` 替换（不用 `.format()` —— JSON 示例里的花括号会触发 `KeyError`）。

---

## 5. 前端设计

### 5.1 流程

用户点「整理」按钮 → `POST /api/memory/organize/preview` → 拿到方案 → 渲染复核模态：

```
┌─────────────────────────────────────────────────┐
│  记忆整理复核                         [×]       │
│                                                  │
│  LLM 建议 4 项动作                               │
│                                                  │
│  ☑ [合并] pref-dup-a.md + pref-dup-b.md          │
│      原因：两条记录的是同一偏好"用 TS 写后端"     │
│      合并为 pref-typescript-backend.md            │
│      ▸ 预览新内容                                 │
│                                                  │
│  ☑ [改写] wrong-fact.md                          │
│      原因：项目用 Python 3.12，不是 3.8           │
│      ▸ 预览改写后内容                             │
│                                                  │
│  ☐ [保留] correct-fact.md                        │
│      原因：内容准确，无需改动                     │
│                                                  │
│  ☑ [删除] obsolete-note.md                       │
│      原因：信息已过时，被其他文件覆盖              │
│                                                  │
│              [应用选中]    [取消]                 │
└─────────────────────────────────────────────────┘
```

### 5.2 交互规则

- 非 keep 动作默认勾选；keep 默认不勾。
- merge / rewrite 可展开预览 `new_content` 前 ~200 字。
- 「应用选中」→ `POST /api/memory/organize/apply {cwd, actions}` → toast 结果 → 关模态 + `indexMemoryFiles()` + `initWikiGraph()`。
- 有 `errors` 时在模态底部显示。
- Escape / 点遮罩 / Cancel 关闭模态（复用 `openMemoryEditor` 的关闭模式）。

### 5.3 DOM 结构

在 `#memory-edit-overlay` 后新增 `#memory-organize-overlay`，结构类似编辑模态（header + 滚动 body + actions-row），复用 `.memory-edit-modal` / `.modal-actions-row` 样式。

---

## 6. API 规范

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/memory/organize/preview` | `{cwd: string}` | `{actions: [...], linked: N, skipped: N, pairs: [...], message: "...", model: "..."}` |
| POST | `/api/memory/organize/apply` | `{cwd: string, actions: [...]}` | `{merged: N, deleted: N, rewritten: N, errors: [...]}` |

### 6.1 preview 响应中的 action 对象

```json
{
  "id": 0,
  "action": "merge | delete | rewrite | keep",
  "targets": ["file-a.md", "file-b.md"],
  "new_filename": "suggested-name.md",
  "new_content": "完整 markdown 正文（含 frontmatter）",
  "reason": "简短中文说明"
}
```

---

## 7. 错误处理与安全

| 场景 | 处理 |
|------|------|
| LLM 返回非 JSON / 格式错误 | `_parse_json_lenient` 返回 `None` → preview 返回空方案 + message |
| LLM 调用超时（120s） | `_run_llm_oneshot` 内部 deadline + finally 杀子进程 → 返回 `''` → `llm_json` 返回 `None` |
| `memory_llm` 模块不可用 | preview catch `ImportError` → 只跑 wikilink 步，返回空方案 |
| 模型不可用 / CLI 报错 | `validate_cli` / `validate_cwd` 失败 → 返回 `''` → `None` → 空方案 |
| LLM 幻觉（编造不存在的文件名） | `targets` 与 `list_memory_files` 结果取交，幻觉名剔除 |
| 删除操作 | **只用** `delete_memory_file`（改名 `.bak`，`memory_index.py:660`），绝不 `os.remove` |
| 路径穿越 | `save_memory_file` / `delete_memory_file` 内部已 `Path(filename).name` 防护 |
| 大量文件 | 每文件内容截 ~1500 字，>40 文件时溢出的只给 title，在 prompt 未尾附说明 |
| apply 部分失败 | 每条 `try/except`，失败入 `errors` 续跑，最后全量重建索引 |

---

## 8. 安全与回滚

- **删除即改名**：`delete_memory_file` 把 `xxx.md` 改名为 `xxx.md.bak`，数据不丢失。
- **先写后删**：merge 时先 `save` 合并文件，再 `delete` 源文件。即使 delete 失败，合并内容已保存。
- **索引保证**：apply 末尾 `index_memory(cwd, force=True)`，确保 FTS 反映最新状态。
- **回滚**：若用户发现误删，可手动把 `.bak` 文件重命名回来并重建索引。

---

## 9. 验证计划

使用非默认端口避免影响运行实例。

### 9.1 准备

1. 在测试 cwd 的 memory 目录创建 3 个文件：
   - `pref-dup-a.md`：`用户偏好用 TypeScript 写后端。`
   - `pref-dup-b.md`：`后端代码用 TypeScript 编写（用户偏好）。`
   - `wrong-fact.md`：`项目用 Python 3.8，需兼容 3.6。`
2. 确保 `memory_assistant_model` 已配或留空（跟随会话模型）。

### 9.2 验证项

| # | 操作 | 期望 |
|---|---|---|
| 1 | 点「整理」 | spinner → 复核模态打开，wikilink toast（如有） |
| 2 | 检查动作列表 | merge(a+b)、rewrite/delete(wrong) 可见，理由合理 |
| 3 | 取消勾选不想动的 → 点「应用选中」 | toast `organizeApplied {merged,deleted,rewritten}` |
| 4 | 检查文件 | a 或 b 变 `.bak`，合并文件存在且信息完整；wrong 被改写或变 `.bak` |
| 5 | FTS 搜索 | 搜 "TypeScript" 命中合并文件；搜 "Python" 命中改写后内容（或删后无结果，`.bak` 不在 FTS） |
| 6 | 图谱 | `initWikiGraph` 被调用，节点更新 |
| 7 | 0 文件的 memory 目录 | toast `noMemoryResults`，模态不打开 |
| 8 | 假模型 ID | wikilink 步跑，LLM 失败，方案空 + `organizeNoActions`，页面仍可用 |

---

## 10. 改动的文件

| 文件 | 改动 |
|---|---|
| `memory_llm.py` | 抽 `_run_llm_oneshot`；新增 `llm_json` + `_parse_json_lenient` + `_ORGANIZE_PROMPT` |
| `backend/services/memory_service.py` | `preview_memory_organize`(async) + `apply_memory_organize`(sync) |
| `server.py` | import + `handle_api_post` 前置两异步路由 |
| `static/memory.js` | `organizeMemoryLinks` 改调 preview + 开模态；新增复核 / apply 函数 |
| `static/index.html` | `#memory-organize-overlay` 复核模态 |
| `static/i18n/{en,zh}.json` | 加 ~11 个新 key（review 标题 / 动作名 / 结果 toast 等） |

**不改**：`memory_index.py`（只读复用）、`backend/routes/memory_routes.py`（新路由不进 sync dispatch）。
