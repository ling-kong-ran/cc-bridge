"""记忆文件相关服务。"""
from typing import Any

from memory_index import (
    delete_memory_file,
    get_memory_file,
    get_memory_graph,
    get_memory_tree,
    import_memory_files,
    index_memory,
    list_memory_files,
    organize_memory_links,
    save_memory_file,
    search_memory,
)


def list_project_memory_files(cwd: str) -> list[dict[str, Any]]:
    """列出项目记忆文件。"""
    return list_memory_files(cwd)


def search_project_memory(query: str, cwd: str) -> list[dict[str, Any]]:
    """搜索项目记忆。"""
    return search_memory(query, cwd) if query else []


def rebuild_memory_index(cwd: str) -> dict[str, Any]:
    """重建项目记忆索引。"""
    count = index_memory(cwd, force=True)
    return {"count": count, "ok": count >= 0}


def load_memory_tree(cwd: str) -> dict[str, Any]:
    """读取项目记忆树。"""
    return {"tree": get_memory_tree(cwd)}


def load_memory_graph(cwd: str) -> dict[str, Any]:
    """读取项目记忆图谱。"""
    return get_memory_graph(cwd)


def load_memory_file(filename: str, cwd: str) -> tuple[int, dict[str, Any]]:
    """读取单个记忆文件。"""
    result = get_memory_file(filename, cwd)
    if not result:
        return 404, {"error": "not found"}
    return 200, result


def remove_memory_file(filename: str, cwd: str) -> tuple[int, dict[str, Any]]:
    """删除单个记忆文件。"""
    ok = delete_memory_file(filename, cwd)
    if ok:
        return 200, {"ok": True}
    return 404, {"error": "not found"}


def update_memory_file(filename: str, content: str, cwd: str) -> tuple[int, dict[str, Any]]:
    """创建或更新单个记忆文件。"""
    if not filename or not content:
        return 400, {"error": "filename and content required"}
    result = save_memory_file(filename, content, cwd)
    if result:
        return 200, result
    return 500, {"error": "save failed"}


def import_project_memory_files(paths: Any, cwd: str) -> tuple[int, dict[str, Any]]:
    """导入服务端文件到项目记忆目录。"""
    if not isinstance(paths, list):
        return 400, {"error": "paths required"}
    imported = import_memory_files(paths, cwd)
    if imported:
        index_memory(cwd, force=True)
    return 200, {"ok": True, "imported": imported}


def organize_project_memory(cwd: str) -> dict[str, Any]:
    """整理项目记忆文件之间的链接。"""
    return organize_memory_links(cwd)
