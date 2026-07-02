"""
Global Wiki Store — 跨项目的双向链接记忆知识库。

SQLite FTS5 全文搜索 + [[wikilink]] 图遍历 + 热点记忆缓存。
零外部依赖，仅使用 Python 标准库 sqlite3。
"""
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

# 全局 wiki 数据库
WIKI_DB = Path.home() / ".ccb" / "global_wiki.db"

# Claude Code auto memory 根目录
MEMORY_ROOT = Path.home() / ".claude" / "projects"

# 热点缓存大小
HOT_CACHE_SIZE = 50

# 索引锁
_index_lock = threading.Lock()


# ── 热点内存缓存 ─────────────────────────────────────────────────────────

class HotCache:
    """LRU 热点记忆缓存。"""

    def __init__(self, max_size: int = HOT_CACHE_SIZE):
        self._cache: OrderedDict[str, dict] = OrderedDict()
        self._max_size = max_size

    def get(self, node_id: str) -> dict | None:
        if node_id in self._cache:
            self._cache.move_to_end(node_id)
            return self._cache[node_id]
        return None

    def put(self, node_id: str, data: dict) -> None:
        if node_id in self._cache:
            self._cache.move_to_end(node_id)
            self._cache[node_id] = data
        else:
            if len(self._cache) >= self._max_size:
                self._cache.popitem(last=False)
            self._cache[node_id] = data

    def remove(self, node_id: str) -> None:
        self._cache.pop(node_id, None)

    def clear(self) -> None:
        self._cache.clear()

    def __len__(self) -> int:
        return len(self._cache)


_hot_cache = HotCache()


# ── 数据库初始化 ─────────────────────────────────────────────────────────

def _get_conn() -> sqlite3.Connection:
    """获取全局 wiki 数据库连接（线程安全）。"""
    WIKI_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(WIKI_DB), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_wiki_db() -> None:
    """初始化全局 wiki 数据库表结构。"""
    conn = _get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS wiki_nodes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            type TEXT NOT NULL DEFAULT 'reference',
            project TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '',
            access_count INTEGER NOT NULL DEFAULT 0,
            last_access REAL NOT NULL DEFAULT 0,
            updated_at REAL NOT NULL DEFAULT 0,
            created_at REAL NOT NULL DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS wiki_links (
            source_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            PRIMARY KEY (source_id, target_id)
        )
    """)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
            node_id, title, body, tags,
            tokenize='unicode61 remove_diacritics 1',
            content=''
        )
    """)
    # 索引用查询
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_wiki_links_target
        ON wiki_links(target_id)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_wiki_nodes_type
        ON wiki_nodes(type)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_wiki_nodes_access
        ON wiki_nodes(access_count DESC)
    """)
    conn.commit()
    conn.close()


# ── 文件扫描 ─────────────────────────────────────────────────────────────

def _sanitize_path(path_str: str) -> str:
    """与 CLI 一致的路径 sanitize。"""
    return re.sub(r"[^A-Za-z0-9]", "-", str(Path(path_str).resolve()).replace("\\", "/"))


def _memory_type(filename: str) -> str:
    """根据文件名推断记忆类型。"""
    stem = Path(filename).stem.lower()
    if stem.startswith("user"):
        return "user"
    if stem.startswith("feedback"):
        return "feedback"
    if stem.startswith("project"):
        return "project"
    if stem.startswith("reference"):
        return "reference"
    return "reference"


def _parse_memory_frontmatter(content: str) -> tuple[str, str, str]:
    """解析 memory markdown 文件：返回 (title, type, body)。"""
    body = content.strip()
    title = ""
    mem_type = "reference"
    if body.startswith("---"):
        parts = body.split("---", 2)
        if len(parts) >= 3:
            fm_text = parts[1].strip()
            body = parts[2].strip()
            for line in fm_text.split("\n"):
                if ":" in line:
                    key, _, val = line.partition(":")
                    key = key.strip()
                    val = val.strip().strip('"\'')
                    if key == "name":
                        title = val
                    elif key == "type":
                        mem_type = val
    return title, mem_type, body


def _extract_wikilinks(body: str) -> list[str]:
    """提取 [[wikilink]] 目标。"""
    if not body:
        return []
    pattern = re.compile(r"\[\[([^\[\]]+?)(?:\|[^\[\]]*?)?\]\]")
    matches = pattern.findall(body)
    seen = set()
    result = []
    for m in matches:
        m = m.strip()
        if m and m not in seen:
            seen.add(m)
            result.append(m)
    return result


def _extract_tags(body: str) -> str:
    """从正文提取 #tag 或 `tag` 关键词。"""
    tags = set()
    for m in re.finditer(r'#(\w[\w-]*)', body):
        tags.add(m.group(1).lower())
    return ",".join(sorted(tags))


def _scan_all_projects() -> list[dict]:
    """扫描所有项目的 memory 目录，返回所有节点数据。"""
    nodes = []
    if not MEMORY_ROOT.exists():
        return nodes

    for project_dir in sorted(MEMORY_ROOT.iterdir()):
        if not project_dir.is_dir() or project_dir.name.startswith("."):
            continue
        memory_dir = project_dir / "memory"
        if not memory_dir.exists():
            continue

        project_name = project_dir.name
        for md_file in sorted(memory_dir.rglob("*.md")):
            if md_file.suffix == ".bak":
                continue
            try:
                content = md_file.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue

            title, mem_type, body = _parse_memory_frontmatter(content)
            if not title:
                title = md_file.stem
            if not mem_type or mem_type == "reference":
                mem_type = _memory_type(md_file.name)

            node_id = f"{project_name}/{md_file.name}"
            tags = _extract_tags(body)
            mtime = md_file.stat().st_mtime if md_file.exists() else time.time()
            wikilinks = _extract_wikilinks(body)

            nodes.append({
                "id": node_id,
                "title": title,
                "body": body,
                "type": mem_type,
                "project": project_name,
                "tags": tags,
                "updated_at": mtime,
                "created_at": md_file.stat().st_ctime if md_file.exists() else time.time(),
                "_wikilinks": wikilinks,
                "_file_path": str(md_file),
            })

    return nodes


# ── 全量索引 ─────────────────────────────────────────────────────────────

def index_all(force: bool = False) -> int:
    """扫描所有项目并重建 wiki 索引。返回索引的节点数量。"""
    with _index_lock:
        init_wiki_db()
        conn = _get_conn()
        nodes = _scan_all_projects()

        # 如果不强制全量，做增量检查
        if not force:
            existing = set()
            for row in conn.execute("SELECT id, updated_at FROM wiki_nodes").fetchall():
                existing.add((row[0], row[1]))

            new_mtimes = {(n["id"], n["updated_at"]) for n in nodes}
            if new_mtimes == existing and existing:
                conn.close()
                return -1  # 无变化

        # 全量重建
        conn.execute("DELETE FROM wiki_nodes")
        conn.execute("DELETE FROM wiki_links")
        conn.execute("DROP TABLE IF EXISTS wiki_fts")
        conn.execute("""
            CREATE VIRTUAL TABLE wiki_fts USING fts5(
                node_id, title, body, tags,
                tokenize='unicode61 remove_diacritics 1',
                content=''
            )
        """)

        indexed = 0
        for node in nodes:
            wikilinks = node.pop("_wikilinks", [])
            node.pop("_file_path", None)

            conn.execute(
                """INSERT OR REPLACE INTO wiki_nodes
                   (id, title, body, type, project, tags, access_count, last_access, updated_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)""",
                (node["id"], node["title"], node["body"], node["type"],
                 node["project"], node["tags"], node["updated_at"], node["created_at"]),
            )
            conn.execute(
                "INSERT INTO wiki_fts(node_id, title, body, tags) VALUES (?, ?, ?, ?)",
                (node["id"], node["title"], node["body"], node["tags"]),
            )
            indexed += 1

            # 建立双向链接
            for target in wikilinks:
                target_id = _resolve_wikilink(target, nodes)
                if target_id and target_id != node["id"]:
                    conn.execute(
                        "INSERT OR IGNORE INTO wiki_links(source_id, target_id) VALUES (?, ?)",
                        (node["id"], target_id),
                    )

        conn.commit()
        conn.close()
        _hot_cache.clear()
        return indexed


def _resolve_wikilink(target: str, nodes: list[dict]) -> str | None:
    """将 [[wikilink]] 目标解析为 node_id。"""
    target_stem = Path(target).stem.lower()
    # 精确匹配
    for n in nodes:
        if Path(n["id"]).stem.lower() == target_stem:
            return n["id"]
    # 包含匹配
    for n in nodes:
        stem = Path(n["id"]).stem.lower()
        if target_stem in stem or stem in target_stem:
            return n["id"]
    return None


# ── 全文搜索 ─────────────────────────────────────────────────────────────

def search(query: str, limit: int = 20, offset: int = 0,
           mem_type: str = "", project: str = "") -> dict:
    """全文搜索 wiki 节点。返回 {results, total, query}。"""
    init_wiki_db()
    conn = _get_conn()

    safe_query = " ".join(
        f'"{token}"' if len(token) > 1 else token
        for token in query.replace('"', '""').split()
        if token.strip()
    )
    if not safe_query:
        conn.close()
        return {"results": [], "total": 0, "query": query}

    where_clauses = []
    params = []

    if mem_type:
        where_clauses.append("n.type = ?")
        params.append(mem_type)
    if project:
        where_clauses.append("n.project = ?")
        params.append(project)

    where_sql = (" AND " + " AND ".join(where_clauses)) if where_clauses else ""

    try:
        # 先获取匹配总数
        count_sql = f"""
            SELECT COUNT(*) FROM wiki_fts f
            JOIN wiki_nodes n ON f.node_id = n.id
            WHERE wiki_fts MATCH ?{where_sql}
        """
        total_row = conn.execute(count_sql, [safe_query] + params).fetchone()
        total = total_row[0] if total_row else 0

        # 获取结果页
        query_sql = f"""
            SELECT n.id, n.title, n.type, n.project, n.tags, n.access_count,
                   n.updated_at, n.created_at,
                   snippet(wiki_fts, 1, '<mark>', '</mark>', '...', 80) AS snippet,
                   rank
            FROM wiki_fts f
            JOIN wiki_nodes n ON f.node_id = n.id
            WHERE wiki_fts MATCH ?{where_sql}
            ORDER BY rank
            LIMIT ? OFFSET ?
        """
        rows = conn.execute(query_sql, [safe_query] + params + [limit, offset]).fetchall()

        results = []
        for row in rows:
            node_id = row[0]
            # 同时获取邻居链接
            backlinks = _get_backlink_count(conn, node_id)
            forward_links = _get_forward_count(conn, node_id)
            results.append({
                "id": node_id,
                "title": row[1],
                "type": row[2],
                "project": row[3],
                "tags": row[4],
                "access_count": row[5],
                "updated_at": row[6],
                "created_at": row[7],
                "snippet": row[8] if row[8] else "",
                "rank": row[9],
                "backlinks": backlinks,
                "links": forward_links,
            })

        conn.close()
        return {"results": results, "total": total, "query": query}

    except sqlite3.OperationalError:
        conn.close()
        return {"results": [], "total": 0, "query": query}


def _get_backlink_count(conn: sqlite3.Connection, node_id: str) -> int:
    row = conn.execute("SELECT COUNT(*) FROM wiki_links WHERE target_id = ?", [node_id]).fetchone()
    return row[0] if row else 0


def _get_forward_count(conn: sqlite3.Connection, node_id: str) -> int:
    row = conn.execute("SELECT COUNT(*) FROM wiki_links WHERE source_id = ?", [node_id]).fetchone()
    return row[0] if row else 0


# ── 节点查询 ─────────────────────────────────────────────────────────────

def get_node(node_id: str) -> dict | None:
    """获取单个 wiki 节点，同时返回邻居。"""
    init_wiki_db()
    conn = _get_conn()

    row = conn.execute(
        "SELECT id, title, body, type, project, tags, access_count, last_access, updated_at, created_at "
        "FROM wiki_nodes WHERE id = ?", [node_id]
    ).fetchone()

    if not row:
        conn.close()
        return None

    # 更新访问计数（热点追踪）
    conn.execute(
        "UPDATE wiki_nodes SET access_count = access_count + 1, last_access = ? WHERE id = ?",
        [time.time(), node_id],
    )
    conn.commit()

    node = {
        "id": row[0], "title": row[1], "body": row[2],
        "type": row[3], "project": row[4], "tags": row[5],
        "access_count": row[6] + 1, "last_access": row[7],
        "updated_at": row[8], "created_at": row[9],
    }

    # 获取出链
    out_rows = conn.execute(
        "SELECT n.id, n.title, n.type, n.project FROM wiki_links l "
        "JOIN wiki_nodes n ON l.target_id = n.id WHERE l.source_id = ?", [node_id]
    ).fetchall()
    node["links"] = [{"id": r[0], "title": r[1], "type": r[2], "project": r[3]} for r in out_rows]

    # 获取入链（backlinks）
    in_rows = conn.execute(
        "SELECT n.id, n.title, n.type, n.project FROM wiki_links l "
        "JOIN wiki_nodes n ON l.source_id = n.id WHERE l.target_id = ?", [node_id]
    ).fetchall()
    node["backlinks"] = [{"id": r[0], "title": r[1], "type": r[2], "project": r[3]} for r in in_rows]

    conn.close()

    # 放入热点缓存
    _hot_cache.put(node_id, node)
    return node


def get_neighbors(node_id: str, depth: int = 2) -> list[dict]:
    """获取节点的邻居图（双向链接，广度优先遍历）。"""
    init_wiki_db()
    conn = _get_conn()
    visited = {node_id}
    current = {node_id}
    all_nodes = []

    for _ in range(depth):
        next_level = set()
        if not current:
            break

        placeholders = ",".join("?" for _ in current)
        rows = conn.execute(
            f"SELECT DISTINCT n.id, n.title, n.type, n.project, n.access_count "
            f"FROM wiki_nodes n "
            f"JOIN wiki_links l ON (n.id = l.source_id AND l.target_id IN ({placeholders})) "
            f"   OR (n.id = l.target_id AND l.source_id IN ({placeholders})) "
            f"WHERE n.id NOT IN ({','.join('?' for _ in visited)})",
            list(current) + list(current) + list(visited),
        ).fetchall()

        for row in rows:
            if row[0] not in visited:
                visited.add(row[0])
                next_level.add(row[0])
                all_nodes.append({
                    "id": row[0], "title": row[1], "type": row[2],
                    "project": row[3], "access_count": row[4],
                })

        current = next_level

    conn.close()
    return all_nodes


# ── 热点记忆 ─────────────────────────────────────────────────────────────

def get_hot_nodes(limit: int = 20, mem_type: str = "") -> list[dict]:
    """获取访问最多的热点节点。"""
    init_wiki_db()
    conn = _get_conn()

    if mem_type:
        rows = conn.execute(
            "SELECT id, title, type, project, access_count, updated_at "
            "FROM wiki_nodes WHERE type = ? ORDER BY access_count DESC LIMIT ?",
            [mem_type, limit],
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, title, type, project, access_count, updated_at "
            "FROM wiki_nodes ORDER BY access_count DESC LIMIT ?",
            [limit],
        ).fetchall()

    conn.close()
    return [
        {"id": r[0], "title": r[1], "type": r[2], "project": r[3],
         "access_count": r[4], "updated_at": r[5]}
        for r in rows
    ]


def get_cached_hot_nodes(limit: int = 10) -> list[dict]:
    """从内存缓存中返回热点节点（零 I/O）。"""
    return list(_hot_cache._cache.values())[-limit:]


# ── 知识图谱 ─────────────────────────────────────────────────────────────

def get_graph(mem_type: str = "", project: str = "", limit: int = 200) -> dict:
    """返回全局知识图谱 {nodes, edges}。"""
    init_wiki_db()
    conn = _get_conn()

    where = []
    params = []
    if mem_type:
        where.append("type = ?")
        params.append(mem_type)
    if project:
        where.append("project = ?")
        params.append(project)
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    node_rows = conn.execute(
        f"SELECT id, title, type, project, access_count FROM wiki_nodes {where_sql} LIMIT ?",
        params + [limit],
    ).fetchall()

    nodes = [
        {"id": r[0], "title": r[1], "type": r[2], "project": r[3], "access_count": r[4]}
        for r in node_rows
    ]
    node_ids = {n["id"] for n in nodes}

    edge_rows = conn.execute("SELECT source_id, target_id FROM wiki_links").fetchall()
    edges = [
        {"source": r[0], "target": r[1]}
        for r in edge_rows
        if r[0] in node_ids and r[1] in node_ids
    ]

    conn.close()
    return {"nodes": nodes, "edges": edges}


# ── 统计信息 ─────────────────────────────────────────────────────────────

def get_stats() -> dict:
    """获取 wiki 索引统计信息。"""
    init_wiki_db()
    conn = _get_conn()

    total = conn.execute("SELECT COUNT(*) FROM wiki_nodes").fetchone()[0]
    links = conn.execute("SELECT COUNT(*) FROM wiki_links").fetchone()[0]
    projects = conn.execute("SELECT COUNT(DISTINCT project) FROM wiki_nodes").fetchone()[0]

    type_counts = {}
    for row in conn.execute("SELECT type, COUNT(*) FROM wiki_nodes GROUP BY type").fetchall():
        type_counts[row[0]] = row[1]

    last_index = conn.execute("SELECT MAX(updated_at) FROM wiki_nodes").fetchone()[0] or 0

    conn.close()
    return {
        "total_nodes": total,
        "total_links": links,
        "total_projects": projects,
        "type_counts": type_counts,
        "last_indexed": last_index,
        "cache_size": len(_hot_cache),
    }


# ── 上下文检索（供 Claude Code plugin 使用）────────────────────────────────

def retrieve_context(query: str, max_tokens: int = 4000, depth: int = 1) -> str:
    """检索与查询相关的 wiki 上下文，返回格式化文本。

    搜索命中节点后，沿双向链接遍历 depth 层邻居，收集关联记忆，
    按相关性排序，截断到 max_tokens 预算。

    Args:
        query: 搜索查询
        max_tokens: 最大返回 token 数（近似）
        depth: 图遍历深度（1 = 仅直接邻居）

    Returns:
        格式化的上下文字符串，可直接注入 Claude 上下文。
    """
    result = search(query, limit=10)
    if not result["results"]:
        return ""

    # 收集命中节点及其邻居
    collected = {}  # node_id -> node data
    for hit in result["results"]:
        node = get_node(hit["id"])
        if node:
            collected[node["id"]] = node
            # 获取邻居（depth=1）
            neighbors = get_neighbors(node["id"], depth=depth)
            for nb in neighbors:
                if nb["id"] not in collected:
                    nb_full = get_node(nb["id"])
                    if nb_full:
                        collected[nb["id"]] = nb_full

    # 按相关性排序（access_count 加权 + 是否直接命中）
    def _score(n: dict) -> float:
        is_hit = any(n["id"] == h["id"] for h in result["results"])
        return (10 if is_hit else 1) * (1 + n.get("access_count", 0))

    sorted_nodes = sorted(collected.values(), key=_score, reverse=True)

    # 格式化为上下文文本
    lines = []
    approx_tokens = 0
    for node in sorted_nodes:
        block = f"## {node['title']}\n" \
                f"type: {node['type']} | project: {node['project']}\n\n" \
                f"{node['body']}\n"
        block_tokens = len(block) // 3  # 粗略估计
        if approx_tokens + block_tokens > max_tokens:
            # 截断最后一个 block
            remaining = max_tokens - approx_tokens
            if remaining > 200:
                lines.append(block[:remaining * 3])
            break
        lines.append(block)
        approx_tokens += block_tokens

    return "\n---\n".join(lines)


# ── 手动管理 ─────────────────────────────────────────────────────────────

def add_node(title: str, body: str, mem_type: str = "reference",
             project: str = "_manual", tags: str = "") -> str:
    """手动添加一个 wiki 节点。返回 node_id。"""
    init_wiki_db()
    conn = _get_conn()

    slug = re.sub(r'[^a-z0-9]+', '-', title.lower().strip()).strip('-')
    node_id = f"{project}/{slug}.md"
    now = time.time()

    conn.execute(
        "INSERT OR REPLACE INTO wiki_nodes(id, title, body, type, project, tags, access_count, last_access, updated_at, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
        [node_id, title, body, mem_type, project, tags, now, now, now],
    )
    conn.execute(
        "INSERT OR REPLACE INTO wiki_fts(node_id, title, body, tags) VALUES (?, ?, ?, ?)",
        [node_id, title, body, tags],
    )

    # 提取并建立双向链接
    wikilinks = _extract_wikilinks(body)
    for target in wikilinks:
        target_id = _resolve_wikilink(target, _scan_all_projects())
        if target_id and target_id != node_id:
            conn.execute(
                "INSERT OR IGNORE INTO wiki_links(source_id, target_id) VALUES (?, ?)",
                [node_id, target_id],
            )

    conn.commit()
    conn.close()
    return node_id


def delete_node(node_id: str) -> bool:
    """删除一个 wiki 节点。"""
    init_wiki_db()
    conn = _get_conn()
    conn.execute("DELETE FROM wiki_nodes WHERE id = ?", [node_id])
    conn.execute("DELETE FROM wiki_fts WHERE node_id = ?", [node_id])
    conn.execute("DELETE FROM wiki_links WHERE source_id = ? OR target_id = ?", [node_id, node_id])
    conn.commit()
    conn.close()
    _hot_cache.remove(node_id)
    return True


def update_node(node_id: str, title: str = "", body: str = "",
                mem_type: str = "", tags: str = "") -> dict | None:
    """更新已有节点。"""
    existing = get_node(node_id)
    if not existing:
        return None

    new_title = title or existing["title"]
    new_body = body or existing["body"]
    new_type = mem_type or existing["type"]
    new_tags = tags or existing["tags"] or _extract_tags(new_body)

    init_wiki_db()
    conn = _get_conn()
    now = time.time()

    conn.execute(
        "UPDATE wiki_nodes SET title=?, body=?, type=?, tags=?, updated_at=? WHERE id=?",
        [new_title, new_body, new_type, new_tags, now, node_id],
    )
    conn.execute(
        "UPDATE wiki_fts SET title=?, body=?, tags=? WHERE node_id=?",
        [new_title, new_body, new_tags, node_id],
    )
    conn.commit()
    conn.close()

    _hot_cache.remove(node_id)
    return get_node(node_id)
