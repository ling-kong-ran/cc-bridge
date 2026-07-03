"""
Memory Index - 为 Claude Code auto memory 提供轻量 SQLite FTS5 全文检索

零外部依赖，仅使用 Python 标准库 sqlite3。每个项目一个索引数据库。
"""
import json
import re
import shutil
import sqlite3
import time
from pathlib import Path
from typing import Any

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
            (parsed["name"], parsed["name"], parsed["title"], parsed["body"]),
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


def search_memory(query: str, cwd: str, limit: int = 20) -> list[dict[str, Any]]:
    """全文搜索指定项目的 memory。"""
    db_path = _get_index_db(cwd)
    if not db_path.exists():
        return []

    conn = _get_conn(db_path)
    try:
        # 尝试 FTS5 搜索
        # 转义特殊字符
        safe_query = " ".join(
            f'"{token}"' if len(token) > 1 else token
            for token in query.replace('"', '""').split()
            if token.strip()
        )
        rows = conn.execute(
            "SELECT file_path, name, title, snippet(memory_fts, 1, '<mark>', '</mark>', '...', 64) AS snippet, rank "
            "FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?",
            (safe_query, limit),
        ).fetchall()
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


def _extract_memory_terms(title: str, body: str, stem: str) -> set[str]:
    """提取用于记忆整理的轻量关键词，兼顾中文文件名。"""
    text = f"{title} {body} {stem}".lower()
    terms = set()

    # 英文/数字词（2+ 字符）
    for word in re.findall(r"[a-zA-Z0-9_]{2,}", text):
        terms.add(word)

    # 中文字符 bigram（"飞书消息" → ["飞书", "书消", "消息"]）
    cjk_chars = re.findall(r"[一-鿿]", text)
    for k in range(len(cjk_chars) - 1):
        terms.add(cjk_chars[k] + cjk_chars[k + 1])

    # 文件名分段：中文前缀/编号后缀常靠 - _ 空格分隔
    for part in re.split(r"[-_\s.]+", stem):
        part = part.strip().lower()
        if len(part) < 2:
            continue
        terms.add(part)
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

    # 重新索引该文件
    db_path = _get_index_db(cwd)
    try:
        _init_db(db_path)
        parsed = _parse_memory_file(file_path)
        conn = sqlite3.connect(str(db_path))
        conn.execute("DELETE FROM memory_fts WHERE file_path = ?", (safe_name,))
        conn.execute(
            "INSERT INTO memory_fts (file_path, title, body) VALUES (?, ?, ?)",
            (safe_name, parsed.get("title", safe_name), parsed.get("body", content))
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
