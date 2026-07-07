"""记忆文件 REST 路由处理。"""
from typing import Any

from backend.services.memory_service import (
    import_project_memory_files,
    list_project_memory_files,
    load_memory_file,
    load_memory_graph,
    load_memory_tree,
    organize_project_memory,
    rebuild_memory_index,
    remove_memory_file,
    search_project_memory,
    update_memory_file,
)


def _query_value(query: dict[str, list[str]] | None, name: str, default: str) -> str:
    return ((query or {}).get(name, [default])[0] or default)


def handle_memory_get(
    path: str,
    query: dict[str, list[str]] | None,
    default_cwd: str,
) -> tuple[int, dict[str, Any] | list[dict[str, Any]] | None]:
    """处理记忆 GET API。"""
    if not path.startswith("/api/memory/"):
        return 0, None

    cwd = _query_value(query, "cwd", default_cwd)
    if path == "/api/memory/files":
        return 200, list_project_memory_files(cwd)
    if path == "/api/memory/search":
        return 200, search_project_memory(_query_value(query, "q", ""), cwd)
    if path == "/api/memory/index":
        return 200, rebuild_memory_index(cwd)
    if path == "/api/memory/tree":
        return 200, load_memory_tree(cwd)
    if path == "/api/memory/graph":
        return 200, load_memory_graph(cwd)
    return 0, None


def handle_memory_post(
    path: str,
    data: dict[str, Any],
    default_cwd: str,
) -> tuple[int, dict[str, Any] | None]:
    """处理记忆 POST API。"""
    if not path.startswith("/api/memory/"):
        return 0, None

    cwd = data.get("cwd", default_cwd)
    if path == "/api/memory/file":
        return load_memory_file(data.get("filename", ""), cwd)
    if path == "/api/memory/delete":
        return remove_memory_file(data.get("filename", ""), cwd)
    if path == "/api/memory/update":
        return update_memory_file(data.get("filename", ""), data.get("content", ""), cwd)
    if path == "/api/memory/import":
        return import_project_memory_files(data.get("paths") or [], cwd)
    if path == "/api/memory/organize":
        return 200, organize_project_memory(cwd)
    if path == "/api/memory/index":
        return 200, rebuild_memory_index(cwd)
    return 0, None
