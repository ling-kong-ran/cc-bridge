"""全局 Wiki REST 路由处理。"""
from typing import Any

from backend.services.wiki_service import (
    load_hot_wiki_nodes,
    load_wiki_graph,
    load_wiki_neighbors,
    load_wiki_node,
    load_wiki_stats,
    rebuild_wiki_index,
    retrieve_wiki_context,
    search_wiki,
)


def _query_value(query: dict[str, list[str]] | None, name: str, default: str) -> str:
    return ((query or {}).get(name, [default])[0] or default)


def _query_int(query: dict[str, list[str]] | None, name: str, default: int) -> int:
    return int(_query_value(query, name, str(default)))


def handle_wiki_get(
    path: str,
    query: dict[str, list[str]] | None,
) -> tuple[int, dict[str, Any] | None]:
    """处理全局 Wiki GET API。"""
    if not path.startswith("/api/wiki/"):
        return 0, None

    if path == "/api/wiki/search":
        return 200, search_wiki(
            _query_value(query, "q", ""),
            limit=_query_int(query, "limit", 20),
            offset=_query_int(query, "offset", 0),
            mem_type=_query_value(query, "type", ""),
            project=_query_value(query, "project", ""),
        )
    if path == "/api/wiki/node":
        return 200, load_wiki_node(_query_value(query, "id", ""))
    if path == "/api/wiki/neighbors":
        return 200, load_wiki_neighbors(
            _query_value(query, "id", ""),
            depth=_query_int(query, "depth", 2),
        )
    if path == "/api/wiki/graph":
        return 200, load_wiki_graph(
            mem_type=_query_value(query, "type", ""),
            project=_query_value(query, "project", ""),
            limit=_query_int(query, "limit", 200),
        )
    if path == "/api/wiki/hot":
        return 200, load_hot_wiki_nodes(
            limit=_query_int(query, "limit", 20),
            mem_type=_query_value(query, "type", ""),
        )
    if path == "/api/wiki/stats":
        return 200, load_wiki_stats()
    if path == "/api/wiki/index":
        return 200, rebuild_wiki_index()
    if path == "/api/wiki/context":
        return 200, retrieve_wiki_context(
            _query_value(query, "q", ""),
            max_tokens=_query_int(query, "max_tokens", 4000),
            depth=_query_int(query, "depth", 1),
        )
    return 0, None
