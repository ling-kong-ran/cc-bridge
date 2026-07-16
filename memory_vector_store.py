"""
Memory Vector Store - 轻量 SQLite 向量检索后端。

当前 memory 规模通常较小，不引入 ChromaDB 等重依赖。这里用本地哈希词袋
向量近似语义召回：SQLite 持久化稀疏向量，查询时全量扫描计算 cosine。
失败时返回空结果，由 FTS5 检索兜底。
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
from pathlib import Path
from typing import Any

import memory_index

VECTOR_DIR = Path.home() / ".ccb" / "memory_vectors"
VECTOR_DIM = 512

SEMANTIC_ALIASES = getattr(memory_index, "SEMANTIC_ALIASES", {})


def is_available() -> bool:
    """内置 SQLite 向量缓存总是可用；具体检索失败会在调用处降级。"""
    return True


def _db_path(cwd: str) -> Path:
    digest = hashlib.sha1(str(Path(cwd).resolve()).replace("\\", "/").encode("utf-8", "ignore")).hexdigest()[:24]
    return VECTOR_DIR / f"{digest}.db"


def _connect(cwd: str) -> sqlite3.Connection:
    VECTOR_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(_db_path(cwd)))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS memory_vectors (
            file_path TEXT PRIMARY KEY,
            body_hash TEXT NOT NULL,
            title TEXT NOT NULL,
            snippet TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            vector_json TEXT NOT NULL,
            updated_at REAL NOT NULL
        )
    """)
    conn.commit()
    return conn


def _tokens(text: str) -> list[str]:
    text = str(text or "").lower()
    tokens: list[str] = []
    for word in re.findall(r"[a-zA-Z0-9_]{3,}", text):
        tokens.append(word)
    for chunk in re.findall(r"[\u4e00-\u9fff]{2,}", text):
        if len(chunk) <= 6:
            tokens.append(chunk)
        for idx in range(len(chunk) - 1):
            tokens.append(chunk[idx:idx + 2])
    expanded = list(tokens)
    token_set = set(tokens)
    for key, aliases in SEMANTIC_ALIASES.items():
        related = {key.lower(), *(alias.lower() for alias in aliases)}
        if token_set & related:
            expanded.extend(related)
    return [token for token in expanded if len(token.strip()) >= 2]


def _vectorize(text: str) -> dict[int, float]:
    vector: dict[int, float] = {}
    for token in _tokens(text):
        digest = hashlib.blake2b(token.encode("utf-8", "ignore"), digest_size=4).digest()
        bucket = int.from_bytes(digest, "big") % VECTOR_DIM
        vector[bucket] = vector.get(bucket, 0.0) + 1.0
    norm = math.sqrt(sum(value * value for value in vector.values()))
    if norm <= 0:
        return {}
    return {bucket: value / norm for bucket, value in vector.items()}


def _cosine(left: dict[int, float], right: dict[int, float]) -> float:
    if not left or not right:
        return 0.0
    if len(left) > len(right):
        left, right = right, left
    return sum(value * right.get(bucket, 0.0) for bucket, value in left.items())


def _loads_vector(raw: str) -> dict[int, float]:
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            return {}
        return {int(k): float(v) for k, v in data.items()}
    except Exception:
        return {}


def index_memory(cwd: str) -> dict[str, Any]:
    """把当前项目 memory 同步到 SQLite 向量缓存。失败时不影响主链路。"""
    try:
        files = memory_index.list_memory_files(cwd)
        conn = _connect(cwd)
        existing = {row[0]: row[1] for row in conn.execute("SELECT file_path, body_hash FROM memory_vectors").fetchall()}
        current: set[str] = set()
        indexed = 0
        skipped = 0
        for item in files:
            path = item.get("path") or item.get("file") or ""
            body_hash = item.get("body_hash") or ""
            if not path:
                continue
            current.add(path)
            if existing.get(path) == body_hash:
                skipped += 1
                continue
            file_data = memory_index.get_memory_file(path, cwd)
            if not file_data:
                continue
            body = (file_data.get("body") or "").strip()
            title = file_data.get("title") or item.get("title") or path
            vector = _vectorize(f"{title}\n{body}")
            if not vector:
                continue
            metadata = {
                "path": path,
                "title": title,
                "type": item.get("type") or "",
                "source": item.get("source") or "",
                "inject": item.get("inject") or "",
                "scope": item.get("scope") or "",
                "last_verified_at": item.get("last_verified_at") or "",
            }
            conn.execute(
                "INSERT OR REPLACE INTO memory_vectors "
                "(file_path, body_hash, title, snippet, metadata_json, vector_json, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    path,
                    body_hash,
                    title,
                    body[:240],
                    json.dumps(metadata, ensure_ascii=False),
                    json.dumps(vector, ensure_ascii=False, separators=(",", ":")),
                    float(item.get("updated_at") or 0),
                ),
            )
            indexed += 1
        stale = list(set(existing) - current)
        for path in stale:
            conn.execute("DELETE FROM memory_vectors WHERE file_path = ?", (path,))
        conn.commit()
        conn.close()
        return {"available": True, "indexed": indexed, "skipped": skipped, "deleted": len(stale), "error": ""}
    except Exception as exc:
        return {"available": False, "indexed": 0, "skipped": 0, "deleted": 0, "error": str(exc)}


def search_memory(query: str, cwd: str, limit: int = 8) -> list[dict[str, Any]]:
    """用内置稀疏向量检索 memory；调用方负责与 FTS 结果合并和过滤。"""
    query_vector = _vectorize(query)
    if not query_vector:
        return []
    try:
        sync = index_memory(cwd)
        if not sync.get("available"):
            return []
        conn = _connect(cwd)
        rows = conn.execute("SELECT file_path, title, snippet, metadata_json, vector_json FROM memory_vectors").fetchall()
        conn.close()
        scored: list[tuple[float, str, str, str, dict[str, Any]]] = []
        for path, title, snippet, meta_raw, vector_raw in rows:
            score = _cosine(query_vector, _loads_vector(vector_raw))
            if score <= 0.08:
                continue
            try:
                meta = json.loads(meta_raw) if meta_raw else {}
            except Exception:
                meta = {}
            scored.append((score, path, title, snippet, meta if isinstance(meta, dict) else {}))
        scored.sort(key=lambda item: item[0], reverse=True)
        results: list[dict[str, Any]] = []
        for score, path, title, snippet, meta in scored[:max(1, limit)]:
            results.append({
                "file": path,
                "name": path,
                "title": meta.get("title") or title or path,
                "snippet": snippet or "",
                "rank": -score,
                "vector_score": round(score, 4),
                "retrieval": "sqlite-vector",
            })
        return results
    except Exception:
        return []
