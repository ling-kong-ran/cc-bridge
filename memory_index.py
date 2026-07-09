"""
Memory Index - 为 Claude Code auto memory 提供轻量 SQLite FTS5 全文检索

可选依赖 jieba 用于中文分词（未安装时退回 bigram）。
索引会随分词器变化；切换分词器后建议 force=True 全量重建一次索引。
"""
import json
import re
import shutil
import sqlite3
import time
from pathlib import Path
from typing import Any

try:
    import jieba
    _has_jieba = True
except ImportError:
    _has_jieba = False
    jieba = None  # type: ignore

# 索引存储目录
INDEX_DIR = Path.home() / ".ccb" / "memory_index"
INDEX_DIR.mkdir(parents=True, exist_ok=True)

# Claude Code auto memory 目录模板
MEMORY_DIR_TEMPLATE = ".claude/projects/{sanitized}"

# 轮询间隔（秒）—— 检查文件变化的最小间隔
SCAN_INTERVAL = 30


def _sanitize_path(path_str: str) -> str:
    """与 CLI 一致的路径 sanitize 逻辑。"""
    return re.sub(r"[^A-Za-z0-9]", "-", str(Path(path_str).resolve()).replace("\\", "/"))


def _get_index_db(cwd: str) -> Path:
    """获取指定项目的索引数据库路径。"""
    sanitized = _sanitize_path(cwd)
    db_name = f"{sanitized}.db" if sanitized and sanitized != "-" else "_default.db"
    return INDEX_DIR / db_name


def _get_memory_dir(cwd: str) -> Path:
    """获取 Claude Code auto memory 目录。"""
    # auto memory 存储在 ~/.claude/projects/<sanitized>/memory/
    sanitized = _sanitize_path(cwd)
    return Path.home() / MEMORY_DIR_TEMPLATE.format(sanitized=sanitized) / "memory"


def _parse_memory_file(file_path: Path) -> dict[str, Any] | None:
    """解析 memory markdown 文件，返回 frontmatter + content。"""
    try:
        content = file_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None

    title = file_path.stem
    body = content.strip()
    # 尝试提取 frontmatter
    if body.startswith("---"):
        parts = body.split("---", 2)
        if len(parts) >= 3:
            fm_text = parts[1].strip()
            body = parts[2].strip()
            for line in fm_text.split("\n"):
                if ":" in line:
                    key, _, val = line.partition(":")
                    key = key.strip()
                    if key == "name":
                        title = val.strip().strip('"\'')
            if not title:
                title = file_path.stem

    return {
        "file": file_path.relative_to(file_path.parent.parent).as_posix()
        if file_path.parent.parent else file_path.name,
        "name": file_path.name,
        "title": title,
        "size": file_path.stat().st_size if file_path.exists() else 0,
        "updated_at": file_path.stat().st_mtime if file_path.exists() else 0,
        "content": content,
        "body": body,
    }


def _init_db(db_path: Path) -> sqlite3.Connection:
    """初始化 SQLite 数据库和 FTS5 表。"""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    # FTS5 全文索引表
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            file_path, name, title, content,
            tokenize='unicode61 remove_diacritics 1'
        )
    """)
    # 文件时间戳表，用于增量更新
    conn.execute("""
        CREATE TABLE IF NOT EXISTS file_mtime (
            file_path TEXT PRIMARY KEY,
            mtime REAL NOT NULL
        )
    """)
    conn.commit()
    return conn


def _get_conn(db_path: Path) -> sqlite3.Connection:
    """获取或创建数据库连接。"""
    return _init_db(db_path)


def index_memory(cwd: str, force: bool = False) -> int:
    """索引指定项目的所有 memory 文件。返回索引的文件数量。"""
    memory_dir = _get_memory_dir(cwd)
    if not memory_dir.exists():
        return 0

    db_path = _get_index_db(cwd)
    # 如果不强制，检查是否需要更新
    if not force:
        last_index = _get_last_index_time(db_path)
        if last_index and time.time() - last_index < SCAN_INTERVAL:
            # 检查是否有文件变化
            if not _has_changes(memory_dir, db_path):
                return -1  # 无需更新

    conn = _get_conn(db_path)
    indexed = 0

    # 清除旧索引
    conn.execute("DELETE FROM memory_fts")
    conn.execute("DELETE FROM file_mtime")

    for md_file in sorted(memory_dir.rglob("*.md")):
        parsed = _parse_memory_file(md_file)
        if not parsed:
            continue
        conn.execute(
            "INSERT INTO memory_fts(file_path, name, title, content) VALUES (?, ?, ?, ?)",
            (parsed["name"], parsed["name"], parsed["title"], _indexable_content(parsed)),
        )
        conn.execute(
            "INSERT OR REPLACE INTO file_mtime(file_path, mtime) VALUES (?, ?)",
            (parsed["name"], parsed["updated_at"]),
        )
        indexed += 1

    conn.commit()
    conn.close()
    return indexed


def _get_last_index_time(db_path: Path) -> float:
    """获取最后一次索引的时间。"""
    if not db_path.exists():
        return 0
    try:
        conn = sqlite3.connect(str(db_path))
        row = conn.execute("SELECT MAX(mtime) FROM file_mtime").fetchone()
        conn.close()
        return row[0] if row and row[0] else 0
    except sqlite3.Error:
        return 0


def _has_changes(memory_dir: Path, db_path: Path) -> bool:
    """检查 memory 目录是否有文件变化。"""
    try:
        conn = sqlite3.connect(str(db_path))
        cursor = conn.execute("SELECT file_path, mtime FROM file_mtime")
        stored = {row[0]: row[1] for row in cursor.fetchall()}
        conn.close()

        current_files = set()
        for md_file in memory_dir.rglob("*.md"):
            mtime = md_file.stat().st_mtime
            name = md_file.name
            current_files.add(name)
            if name not in stored or stored[name] != mtime:
                return True

        if current_files != set(stored.keys()):
            return True

        return False
    except sqlite3.Error:
        return True


def _build_fts_query(query: str) -> str:
    """把用户查询转成对中文友好的 FTS5 MATCH 表达式。

    unicode61 不分中文，整句当一个 token 基本匹配不上。这里复用
    _extract_memory_terms 的中文 bigram 切法，把 query 拆成一组 token，
    用 OR 连接以提高中文召回；英文/数字词原样作为短语。
    """
    query = (query or "").strip()
    if not query:
        return ""

    # 用与索引整理一致的切分逻辑提取 token（中文 bigram + 英文词 + 分段）
    terms = _extract_memory_terms(query, "", Path(query).stem)
    # 去掉过短/无信息量的 token，转义双引号
    safe_terms: list[str] = []
    seen: set[str] = set()
    for t in terms:
        t = t.replace('"', '""')
        if len(t) < 2 or t in seen:
            continue
        seen.add(t)
        safe_terms.append(f'"{t}"')
    # 没切出可用 token 时退化为原始查询（按空格分），避免完全搜不到
    if not safe_terms:
        parts = [p.replace('"', '""') for p in query.split() if len(p.strip()) > 1]
        safe_terms = [f'"{p}"' for p in parts]
    return " OR ".join(safe_terms)


def _rerank_by_overlap(rows: list[tuple], query: str, limit: int) -> list[tuple]:
    """按 query 与命中文本的真实 bigram 覆盖度重排，压低只蹭到常见 bigram 的噪声。

    FTS5 的 bm25 rank 在中文 bigram 索引下区分度低：只要命中任一常见双字（已经/消息/重启）
    就能排进来，且排序几乎随机。这里在拿回候选后逐条统计它实际命中了 query 的多少个
    bigram，按命中覆盖度（去重后）重排；命中过少的丢弃。重叠度相同时保留 FTS rank 作 tiebreak。
    """
    if not rows:
        return rows

    # 复用与查询一致的 bigram 切分，得到 query 的 token 集合
    q_terms = _extract_memory_terms(query, "", Path(query).stem)
    q_bigrams = {t for t in q_terms if len(t) >= 2}
    if not q_bigrams:
        return rows[:limit]

    def _row_overlap(row: tuple) -> int:
        # row: (file_path, name, title, snippet, rank, content)；用 title+content 估计命中面。
        # content 是索引时 bigram 化后的全文，能反映该记忆真正覆盖了 query 的多少语义片段。
        title = str(row[2] or "")
        content = str(row[5] or "") if len(row) > 5 else ""
        text = f"{title} {content}"
        terms = _extract_memory_terms(text, "", Path(str(row[1] or "")).stem)
        return len(q_bigrams & {t for t in terms if len(t) >= 2})

    scored = [(_row_overlap(r), r) for r in rows]
    # 只保留至少命中 2 个 query bigram 的候选；query 本身 bigram 不足 2 个时不做过滤
    if len(q_bigrams) >= 2:
        scored = [s for s in scored if s[0] >= 2]
        # 全被过滤掉时退回原 FTS 排序（保底有召回），但只取覆盖度最高的若干条
        if not scored:
            scored = sorted(((_row_overlap(r), r) for r in rows), key=lambda s: -s[0])[:limit]
    # 覆盖度降序；同覆盖度按原 FTS rank 升序（rank 越小越相关）
    scored.sort(key=lambda s: (-s[0], s[1][4]))
    return [r for _, r in scored[:limit]]


def search_memory(query: str, cwd: str, limit: int = 20) -> list[dict[str, Any]]:
    """全文搜索指定项目的 memory。"""
    db_path = _get_index_db(cwd)
    if not db_path.exists():
        return []

    conn = _get_conn(db_path)
    try:
        fts_query = _build_fts_query(query)
        if not fts_query:
            conn.close()
            return []

        def _run(match_expr: str) -> list[tuple]:
            # 末列 content 用于按 query bigram 覆盖度重排；snippet 太短不足以估计命中面
            return conn.execute(
                "SELECT file_path, name, title, snippet(memory_fts, 1, '<mark>', '</mark>', '...', 64) AS snippet, rank, content "
                "FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?",
                (match_expr, limit),
            ).fetchall()

        # 优先 OR 语义（中文召回宽容）；命中为空或出错则回退到 AND（更精确）
        rows: list[tuple] = []
        try:
            rows = _run(fts_query)
        except sqlite3.OperationalError:
            rows = []
        if not rows:
            and_query = fts_query.replace(" OR ", " AND ")
            try:
                rows = _run(and_query)
            except sqlite3.OperationalError:
                rows = []

        rows = _rerank_by_overlap(rows, query, limit)

        results = [
            {
                "file": row[0],
                "name": row[1],
                "title": row[2],
                "snippet": row[3] if row[3] else "",
                "rank": row[4],
            }
            for row in rows
        ]
        conn.close()
        return results
    except sqlite3.OperationalError:
        conn.close()
        return []


def list_memory_files(cwd: str) -> list[dict[str, Any]]:
    """列出项目 memory 目录下的所有文件。"""
    memory_dir = _get_memory_dir(cwd)
    if not memory_dir.exists():
        return []

    files = []
    for md_file in sorted(memory_dir.rglob("*.md")):
        parsed = _parse_memory_file(md_file)
        if parsed:
            files.append({
                "name": parsed["name"],
                "title": parsed["title"],
                "size": parsed["size"],
                "updated_at": parsed["updated_at"],
            })
    return files


def get_memory_file(filename: str, cwd: str) -> dict[str, Any] | None:
    """读取单个 memory 文件内容。"""
    memory_dir = _get_memory_dir(cwd)
    if not memory_dir.exists():
        return None

    # 安全校验：文件名不能包含路径穿越
    safe_name = Path(filename).name
    file_path = memory_dir / safe_name
    if not file_path.exists():
        # 递归搜索
        for f in memory_dir.rglob("*.md"):
            if f.name == safe_name:
                file_path = f
                break
        else:
            return None

    return _parse_memory_file(file_path)


def _extract_wikilinks(body: str) -> list[str]:
    """Extract [[wikilink]] targets from markdown body.

    Supports [[target]] and [[target|alias]] syntax.
    Returns deduplicated list of link target names (not aliases).
    """
    if not body:
        return []
    # Match [[...]] with optional |alias
    pattern = re.compile(r"\[\[([^\[\]]+?)(?:\|([^\[\]]*?))?\]\]")
    matches = pattern.findall(body)
    seen = set()
    result = []
    for target, _ in matches:
        target = target.strip()
        if target and target not in seen:
            seen.add(target)
            result.append(target)
    return result


def get_memory_graph(cwd: str) -> dict:
    """Build a knowledge graph from memory .md files.

    Scans all .md files, parses frontmatter and body,
    extracts [[wikilinks]] from body, and builds a node/edge structure.

    Returns:
        {"nodes": [{id, name, title, size, file}], "edges": [{source, target}]}
    """
    memory_dir = _get_memory_dir(cwd)
    if not memory_dir.exists():
        return {"nodes": [], "edges": []}

    nodes = []
    stem_to_node = {}

    for md_file in sorted(memory_dir.rglob("*.md")):
        parsed = _parse_memory_file(md_file)
        if not parsed:
            continue
        node_id = parsed["name"]
        stem = Path(node_id).stem
        nodes.append({
            "id": node_id,
            "name": node_id,
            "title": parsed["title"],
            "size": parsed["size"],
            "file": parsed["file"],
            "path": parsed["file"],
            "updated_at": parsed["updated_at"],
        })
        stem_to_node[stem] = node_id

    edges = []
    seen_edges = set()

    for md_file in memory_dir.rglob("*.md"):
        parsed = _parse_memory_file(md_file)
        if not parsed:
            continue
        source_id = parsed["name"]
        source_stem = Path(source_id).stem
        wikilinks = _extract_wikilinks(parsed.get("body", ""))

        for target_link in wikilinks:
            target_stem = Path(target_link).stem
            target_id = stem_to_node.get(target_stem)
            if not target_id:
                target_candidate = target_link if target_link.endswith(".md") else f"{target_link}.md"
                if target_candidate in stem_to_node.values():
                    target_id = target_candidate

            if not target_id:
                for s, nid in stem_to_node.items():
                    if target_stem.lower() in s.lower() or s.lower() in target_stem.lower():
                        target_id = nid
                        break

            if not target_id or target_id == source_id:
                continue

            edge_key = f"{source_stem}->{Path(target_id).stem}"
            if edge_key not in seen_edges:
                seen_edges.add(edge_key)
                edges.append({
                    "source": source_id,
                    "target": target_id,
                })

    return {"nodes": nodes, "edges": edges}


def _segment_cjk(text: str) -> str:
    """把文本中的中文按词切分，空格拼接，供 FTS5 索引/检索。

    jieba 可用时按真实词切分（"飞书消息网关"→"飞书 消息 网关"），语义边界准确；
    jieba 不可用时退回 bigram 滑窗（"飞书消息网关"→"飞书 书消 消息 息网 网关"）。
    英文/数字原样保留，由 unicode61 正常分词。单字虚词（的/了/是）在 jieba 路径
    下被过滤掉以减少索引噪声、提高检索精度。
    """
    if not text:
        return ""
    if _has_jieba:
        return " ".join(w for w in jieba.cut(text) if len(w.strip()) > 1)
    return _bigram_cjk(text)


def _bigram_cjk(text: str) -> str:
    """把文本中的连续中文切成 bigram 空格串，供 FTS5 索引/检索可匹配。

    unicode61 不分中文，整段中文会粘成一个 token 导致搜不到。这里对 CJK
    做相邻二字滑窗（"飞书消息" → "飞书 书消 消息"），让任意双字子串都能命中。
    英文/数字原样保留，由 unicode61 正常分词。
    """
    if not text:
        return ""
    out: list[str] = []
    buf: list[str] = []
    for ch in text:
        if "一" <= ch <= "鿿":
            buf.append(ch)
        else:
            if len(buf) >= 2:
                out.extend(buf[k] + buf[k + 1] for k in range(len(buf) - 1))
            elif len(buf) == 1:
                out.append(buf[0])  # 单字也保留，便于单字查询
            buf = []
            out.append(ch)
    if len(buf) >= 2:
        out.extend(buf[k] + buf[k + 1] for k in range(len(buf) - 1))
    elif len(buf) == 1:
        out.append(buf[0])
    return " ".join(out)


def _indexable_content(parsed: dict[str, Any]) -> str:
    """构造用于 FTS5 content 列的可索引文本：中文分词后的标题+正文。

    原文不直接入 content（否则中文粘成一团搜不到），而是把 title 和 body
    的中文用 jieba/bigram 切分后拼接。snippet 仍从原文渲染（见 _parse_memory_file）。
    """
    title = parsed.get("title", "") or ""
    body = parsed.get("body", "") or ""
    return f"{_segment_cjk(title)} {_segment_cjk(body)}"


def _extract_memory_terms(title: str, body: str, stem: str) -> set[str]:
    """提取用于记忆整理的轻量关键词，兼顾中文文件名。"""
    text = f"{title} {body} {stem}".lower()
    terms = set()

    # 英文/数字词（2+ 字符）
    for word in re.findall(r"[a-zA-Z0-9_]{2,}", text):
        terms.add(word)

    # 中文字符切词：jieba 可用时按真实词切分（"飞书消息"→{"飞书","消息"}），
    # 不可用时退回 bigram 滑窗（"飞书消息"→{"飞书","书消","消息"}）。
    if _has_jieba:
        for word in jieba.cut(text):
            word = word.strip()
            if len(word) >= 2:
                terms.add(word)
    else:
        cjk_chars = re.findall(r"[一-鿿]", text)
        for k in range(len(cjk_chars) - 1):
            terms.add(cjk_chars[k] + cjk_chars[k + 1])
        for ch in cjk_chars:
            terms.add(ch)
    # 文件名分段：中文前缀/编号后缀常靠 - _ 空格分隔
    for part in re.split(r"[-_\s.]+", stem):
        part = part.strip().lower()
        if len(part) < 2:
            continue
        terms.add(part)
        # 同样的 CJK 分词策略（jieba 优先），避免 stem 路径的 bigram 污染顶掉上层 jieba 的效果
        if _has_jieba:
            for word in jieba.cut(part):
                word = word.strip()
                if len(word) >= 2:
                    terms.add(word)
        else:
            part_cjk = re.findall(r"[一-鿿]", part)
            for k in range(len(part_cjk) - 1):
                terms.add(part_cjk[k] + part_cjk[k + 1])

    return terms


def _memory_prefix_score(stem_a: str, stem_b: str) -> float:
    """计算文件名公共前缀强度；相同中文前缀应直接视为强关联。"""
    a = stem_a.lower()
    b = stem_b.lower()
    prefix_len = 0
    for ch_a, ch_b in zip(a, b):
        if ch_a != ch_b:
            break
        prefix_len += 1
    if prefix_len == 0:
        return 0.0

    prefix = a[:prefix_len].rstrip("-_ .0123456789")
    cjk_count = len(re.findall(r"[一-鿿]", prefix))
    ascii_count = len(re.findall(r"[a-z0-9]", prefix))
    if cjk_count < 2 and ascii_count < 4:
        return 0.0
    return len(prefix) / max(1, min(len(a), len(b)))


def _append_memory_link(file_data: dict[str, Any], target_stem: str) -> None:
    """在原文件末尾追加 wikilink，保留 frontmatter。"""
    content = (file_data.get("content") or file_data.get("body") or "").rstrip()
    new_content = content + f"\n\n[[{target_stem}]]\n"
    file_data["path"].write_text(new_content, encoding="utf-8")
    file_data["content"] = new_content
    file_data["body"] = new_content
    file_data["existing_links"].add(target_stem)


def organize_memory_links(cwd: str) -> dict:
    """分析 memory 文件内容相似度，自动为相关文件添加 [[wikilink]] 双向链接。

    返回 {linked: N, skipped: M, pairs: [[source, target], ...]}
    """
    memory_dir = _get_memory_dir(cwd)
    if not memory_dir.exists():
        return {"linked": 0, "skipped": 0, "pairs": []}

    # 读取所有文件，提取关键短语
    files_data = {}
    for md_file in sorted(memory_dir.rglob("*.md")):
        parsed = _parse_memory_file(md_file)
        if not parsed:
            continue
        title = parsed["title"]
        body = parsed.get("body", "")
        # 提取已有 wikilinks 的 target stems
        existing_links = set()
        for match in re.finditer(r"\[\[([^\[\]]+?)(?:\|[^\[\]]*?)?\]\]", body):
            existing_links.add(Path(match.group(1).strip()).stem)

        stem = Path(md_file.name).stem
        files_data[parsed["name"]] = {
            "path": md_file,
            "title": title,
            "content": parsed.get("content", ""),
            "body": body,
            "terms": _extract_memory_terms(title, body, stem),
            "existing_links": existing_links,
        }

    if len(files_data) < 2:
        return {"linked": 0, "skipped": 0, "pairs": []}

    # 计算文件对之间的相似度；中文文件名前缀相同也视为强关联
    file_names = list(files_data.keys())
    linked = 0
    skipped = 0
    pairs = []

    for i in range(len(file_names)):
        for j in range(i + 1, len(file_names)):
            name_a = file_names[i]
            name_b = file_names[j]
            data_a = files_data[name_a]
            data_b = files_data[name_b]

            stem_a = Path(name_a).stem
            stem_b = Path(name_b).stem

            # 已存在双向链接则跳过
            if stem_b in data_a["existing_links"] and stem_a in data_b["existing_links"]:
                skipped += 1
                continue

            terms_a = data_a["terms"]
            terms_b = data_b["terms"]
            if not terms_a or not terms_b:
                continue
            intersection = terms_a & terms_b
            union = terms_a | terms_b
            similarity = len(intersection) / len(union) if union else 0
            prefix_score = _memory_prefix_score(stem_a, stem_b)

            # 阈值：中文 bigram 粒度细，用较低阈值；同名前缀文件直接建立关联
            if similarity < 0.06 and prefix_score < 0.35:
                continue

            # 添加双向链接
            modified = False
            if stem_b not in data_a["existing_links"]:
                _append_memory_link(data_a, stem_b)
                modified = True

            if stem_a not in data_b["existing_links"]:
                _append_memory_link(data_b, stem_a)
                modified = True

            if modified:
                linked += 1
                pairs.append([name_a, name_b])

    if linked:
        index_memory(cwd, force=True)
    return {"linked": linked, "skipped": skipped, "pairs": pairs}

def delete_memory_file(filename: str, cwd: str) -> bool:
    """删除 memory 文件（重命名为 .bak）。"""
    memory_dir = _get_memory_dir(cwd)
    safe_name = Path(filename).name
    file_path = memory_dir / safe_name
    if not file_path.exists():
        for f in memory_dir.rglob("*.md"):
            if f.name == safe_name:
                file_path = f
                break
        else:
            return False

    bak = file_path.with_suffix(file_path.suffix + ".bak")
    file_path.rename(bak)
    # 清理索引中的该条目
    db_path = _get_index_db(cwd)
    if db_path.exists():
        try:
            conn = sqlite3.connect(str(db_path))
            conn.execute("DELETE FROM memory_fts WHERE file_path = ?", (safe_name,))
            conn.execute("DELETE FROM file_mtime WHERE file_path = ?", (safe_name,))
            conn.commit()
            conn.close()
        except sqlite3.Error:
            pass
    return True


def get_memory_tree(cwd):
    """Return memory directory tree structure for /api/memory/tree."""
    memory_dir = _get_memory_dir(cwd)
    if not memory_dir.exists():
        return []

    def _build_tree(path):
        items = []
        try:
            entries = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return []
        for entry in entries:
            if entry.name.startswith(".") or entry.suffix == ".bak":
                continue
            if entry.is_dir():
                children = _build_tree(entry)
                items.append({
                    "type": "dir",
                    "name": entry.name,
                    "title": entry.name,
                    "path": str(entry.relative_to(memory_dir).as_posix()),
                    "children": children,
                })
            elif entry.suffix == ".md":
                parsed = _parse_memory_file(entry)
                items.append({
                    "type": "file",
                    "name": entry.name,
                    "title": parsed.get("title", entry.stem) if parsed else entry.stem,
                    "path": str(entry.relative_to(memory_dir).as_posix()),
                    "updated_at": entry.stat().st_mtime if entry.exists() else 0,
                    "size": entry.stat().st_size if entry.exists() else 0,
                })
        return items

    return _build_tree(memory_dir)


def save_memory_file(filename: str, content: str, cwd: str) -> dict[str, Any] | None:
    """创建或更新 memory 文件，然后重新索引该文件。"""
    memory_dir = _get_memory_dir(cwd)
    memory_dir.mkdir(parents=True, exist_ok=True)

    # 安全校验
    safe_name = Path(filename).name
    if not safe_name.endswith(".md"):
        safe_name = safe_name + ".md"
    file_path = memory_dir / safe_name

    # 写入内容
    file_path.write_text(content, encoding="utf-8")

    # 重新索引该文件（列名须与 _init_db 的 memory_fts 表结构一致：file_path, name, title, content）
    db_path = _get_index_db(cwd)
    try:
        _init_db(db_path)
        parsed = _parse_memory_file(file_path)
        conn = sqlite3.connect(str(db_path))
        conn.execute("DELETE FROM memory_fts WHERE file_path = ?", (safe_name,))
        conn.execute(
            "INSERT INTO memory_fts (file_path, name, title, content) VALUES (?, ?, ?, ?)",
            (safe_name, safe_name, parsed.get("title", safe_name), _indexable_content(parsed))
        )
        conn.execute(
            "INSERT OR REPLACE INTO file_mtime (file_path, mtime) VALUES (?, ?)",
            (safe_name, file_path.stat().st_mtime)
        )
        conn.commit()
        conn.close()
    except sqlite3.Error as e:
        print(f"Memory index update failed: {e}")

    return _parse_memory_file(file_path)


def import_memory_files(paths: list[str], cwd: str) -> list[dict[str, Any]]:
    """导入服务端文件到 memory 目录，返回成功导入的文件列表。"""
    memory_dir = _get_memory_dir(cwd)
    memory_dir.mkdir(parents=True, exist_ok=True)
    imported = []
    for src_path in paths:
        src = Path(src_path)
        if not src.exists() or not src.is_file():
            continue
        try:
            content = src.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        safe_name = src.name
        if not safe_name.endswith(".md"):
            safe_name = safe_name + ".md"
        dest = memory_dir / safe_name
        suffix = 1
        while dest.exists():
            stem = src.stem
            dest = memory_dir / f"{stem}_{suffix}.md"
            suffix += 1
        dest.write_text(content, encoding="utf-8")
        imported.append({"name": dest.name, "size": len(content), "source": str(src)})
    return imported
