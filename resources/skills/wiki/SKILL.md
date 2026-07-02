---
name: wiki
description: |
  全局跨项目记忆检索。通过双向链接 wiki 图搜索所有项目的 Claude Code auto memory，
  比直接遍历 .md 文件更快更准。当用户询问"之前怎么解决的"、"其他项目有没有类似问题"、
  "回忆一下"、"有没有参考"、"跨项目搜索记忆"、需要查找历史上下文时，使用此 skill。
  也用于启动新任务前自动检索相关背景知识。
---

# 全局 Wiki 记忆检索

cc-bridge server 维护了一个全局 wiki 索引，覆盖本机所有项目的 Claude Code auto memory。
索引存储在 `~/.ccb/global_wiki.db`，使用 SQLite FTS5 全文搜索 + [[wikilink]] 双向链接图。

## 使用时机

**自动触发**：每个新任务开始时，检索相关上下文。
**手动触发**：用户明确要求查找记忆、历史、跨项目参考时。

## 检索方式

### 1. 获取上下文（推荐：返回格式化文本，可直接注入）
```
GET http://127.0.0.1:<port>/api/wiki/context?q=<关键词>&max_tokens=3000&depth=1
→ { context: "## 标题\n...\n---\n## 标题2\n..." }
```

`depth` 参数控制沿 [[wikilink]] 双向链接遍历的层数（1 = 直接邻居，2 = 二级邻居）。
搜索命中节点后，自动收集其双向链接邻居，按热度排序后截断到 `max_tokens`。

### 2. 全文搜索
```
GET /api/wiki/search?q=<关键词>&limit=20&offset=0&type=feedback&project=<项目名>
→ { results: [{id, title, type, project, snippet, rank, backlinks, links}], total }
```

类型筛选：`user`, `feedback`, `project`, `reference`
项目筛选：sanitized 项目名（如 `E--code-cc-bridge`）

### 3. 查看节点详情及双向链接
```
GET /api/wiki/node?id=<node_id>
→ { id, title, body, type, links: [...], backlinks: [...] }
```

### 4. 获取热点记忆
```
GET /api/wiki/hot?limit=20&type=user
→ { hot: [{id, title, type, project, access_count}] }
```

### 5. 知识图谱
```
GET /api/wiki/graph?type=&project=&limit=200
→ { nodes: [...], edges: [{source, target}] }
```

## 典型用法

开始任何任务时，先检索上下文：
```bash
curl -s "http://127.0.0.1:17878/api/wiki/context?q=<任务关键词>&max_tokens=2000"
```

如果结果不足，用 `/api/wiki/search` 手动浏览，或用 `/api/wiki/node?id=...` 查看具体节点及双向链接。

## 注意

- cc-bridge server 必须正在运行（默认 17878 端口）
- server 启动时自动从 `~/.claude/projects/*/memory/*.md` 重建索引
- 热点记忆缓存在内存中（LRU, top 50），访问延迟极低
