"""全局 Wiki 相关服务。"""
from typing import Any

import wiki_store


def search_wiki(
    query: str,
    *,
    limit: int,
    offset: int,
    mem_type: str,
    project: str,
) -> dict[str, Any]:
    """搜索全局 Wiki 节点。"""
    return wiki_store.search(query, limit=limit, offset=offset, mem_type=mem_type, project=project)


def load_wiki_node(node_id: str) -> dict[str, Any]:
    """读取单个 Wiki 节点。"""
    if not node_id:
        return {"error": "id 参数必填"}
    node = wiki_store.get_node(node_id)
    return node if node else {"error": "节点不存在"}


def load_wiki_neighbors(node_id: str, *, depth: int) -> dict[str, Any]:
    """读取 Wiki 节点邻居。"""
    return {"neighbors": wiki_store.get_neighbors(node_id, depth=depth)}


def load_wiki_graph(*, mem_type: str, project: str, limit: int) -> dict[str, Any]:
    """读取 Wiki 图谱。"""
    return wiki_store.get_graph(mem_type=mem_type, project=project, limit=limit)


def load_hot_wiki_nodes(*, limit: int, mem_type: str) -> dict[str, Any]:
    """读取热点 Wiki 节点。"""
    return {"hot": wiki_store.get_hot_nodes(limit=limit, mem_type=mem_type)}


def load_wiki_stats() -> dict[str, Any]:
    """读取 Wiki 统计信息。"""
    return wiki_store.get_stats()


def rebuild_wiki_index() -> dict[str, Any]:
    """重建 Wiki 索引。"""
    count = wiki_store.index_all(force=True)
    return {"count": count, "ok": count >= 0}


def retrieve_wiki_context(query: str, *, max_tokens: int, depth: int) -> dict[str, Any]:
    """检索 Wiki 上下文。"""
    return {"context": wiki_store.retrieve_context(query, max_tokens=max_tokens, depth=depth)}
