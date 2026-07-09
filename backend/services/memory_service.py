"""记忆文件相关服务。"""
from pathlib import Path
from typing import Any

from config_manager import get_available_models, get_gui_settings
from memory_index import (
    apply_memory_link_pair,
    delete_memory_file,
    get_memory_file,
    get_memory_graph,
    get_memory_tree,
    import_memory_files,
    index_memory,
    list_memory_files,
    organize_memory_links,
    preview_memory_links,
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


def _default_memory_model() -> str:
    models = get_available_models()
    return models[0] if models else "claude-sonnet-4-6"


def _build_organize_memories(files: list[dict[str, Any]], cwd: str) -> str:
    """构建给 LLM 的记忆清单，控制单文件和总文件数量。"""
    parts: list[str] = []
    for index, item in enumerate(files):
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        title = str(item.get("title") or name).strip()
        if index >= 40:
            parts.append(f"\n### {name}\nTitle: {title}\nContent: （文件较多，仅提供标题）")
            continue
        loaded = get_memory_file(name, cwd) or {}
        content = str(loaded.get("content") or loaded.get("body") or "").strip()
        if len(content) > 1500:
            content = content[:1500] + "\n...（已截断）"
        parts.append(f"\n### {name}\nTitle: {title}\nContent:\n{content}")
    if len(files) > 40:
        parts.append(f"\n（共 {len(files)} 个文件，40 个之后只提供标题，请只在证据充分时建议动作。）")
    return "\n".join(parts).strip()


def _normalize_memory_organize_actions(raw_actions: Any, existing_names: set[str]) -> list[dict[str, Any]]:
    """归一化 LLM 整理方案，剔除幻觉文件名和无效动作。"""
    if not isinstance(raw_actions, list):
        return []

    normalized: list[dict[str, Any]] = []
    valid_actions = {"keep", "merge", "delete", "rewrite", "refine", "link"}
    for item in raw_actions:
        if not isinstance(item, dict):
            continue
        action = str(item.get("action") or "").strip().lower()
        if action not in valid_actions:
            continue
        targets = item.get("targets") or []
        if not isinstance(targets, list):
            continue
        clean_targets: list[str] = []
        for target in targets:
            safe_name = Path(str(target or "").strip()).name
            if safe_name in existing_names and safe_name not in clean_targets:
                clean_targets.append(safe_name)

        new_content = str(item.get("new_content") or "").strip()
        new_filename = Path(str(item.get("new_filename") or "").strip()).name
        reason = str(item.get("reason") or "").strip()

        if action == "keep":
            if len(clean_targets) != 1:
                continue
            new_filename = ""
            new_content = ""
        elif action == "delete":
            if len(clean_targets) != 1:
                continue
            new_filename = ""
            new_content = ""
        elif action == "link":
            if len(clean_targets) != 2:
                continue
            new_filename = ""
            new_content = ""
        elif action == "rewrite":
            if len(clean_targets) != 1 or not new_content:
                continue
            new_filename = ""
        elif action == "refine":
            if len(clean_targets) < 1 or not new_content:
                continue
            if len(clean_targets) == 1:
                if not new_filename:
                    new_filename = clean_targets[0]
            elif not new_filename:
                continue
            if not new_filename.endswith(".md"):
                new_filename += ".md"
        elif action == "merge":
            if len(clean_targets) < 2 or not new_content:
                continue
            if not new_filename:
                new_filename = clean_targets[0]
            if not new_filename.endswith(".md"):
                new_filename += ".md"

        normalized.append({
            "id": len(normalized),
            "action": action,
            "targets": clean_targets,
            "new_filename": new_filename,
            "new_content": new_content,
            "reason": reason,
        })
    return normalized


async def preview_memory_organize(cwd: str) -> dict[str, Any]:
    """生成待用户复核的记忆整理方案；双链只作为建议，不在预览阶段写文件。"""
    link_result = preview_memory_links(cwd)
    files = list_memory_files(cwd)
    if not files:
        return {
            "actions": [],
            "linked": 0,
            "link_candidates": 0,
            "skipped": link_result.get("skipped", 0),
            "pairs": link_result.get("pairs", []),
            "message": "没有可整理的记忆文件",
            "model": "",
        }

    settings = get_gui_settings()
    model = str(settings.get("memory_assistant_model") or "").strip() or _default_memory_model()
    memories = _build_organize_memories(files, cwd)
    existing_names = {str(item.get("name") or "") for item in files if item.get("name")}

    link_actions: list[dict[str, Any]] = []
    for pair in link_result.get("pairs", [])[:20]:
        source = str(pair.get("source") or "")
        target = str(pair.get("target") or "")
        if source not in existing_names or target not in existing_names:
            continue
        shared = "、".join(str(term) for term in pair.get("shared_terms", [])[:5])
        reason = f"建议建立双链：相似度 {pair.get('similarity', 0)}"
        if shared:
            reason += f"，共同关键词：{shared}"
        link_actions.append({
            "id": len(link_actions),
            "action": "link",
            "targets": [source, target],
            "new_filename": "",
            "new_content": "",
            "reason": reason,
        })

    try:
        import memory_llm
    except ImportError:
        return {
            "actions": link_actions,
            "linked": 0,
            "link_candidates": len(link_actions),
            "skipped": link_result.get("skipped", 0),
            "pairs": link_result.get("pairs", []),
            "message": "LLM 模块不可用，仅生成双链候选",
            "model": model,
        }

    prompt = memory_llm._ORGANIZE_PROMPT.replace("{memories}", memories)
    raw_actions = await memory_llm.llm_json(prompt, model, cwd, timeout=120.0)
    organize_actions = _normalize_memory_organize_actions(raw_actions, existing_names)
    actions = organize_actions + link_actions
    for index, action in enumerate(actions):
        action["id"] = index
    message = "" if isinstance(raw_actions, list) else "LLM 未返回有效整理方案，仅生成双链候选"
    return {
        "actions": actions,
        "linked": 0,
        "link_candidates": len(link_actions),
        "skipped": link_result.get("skipped", 0),
        "pairs": link_result.get("pairs", []),
        "message": message,
        "model": model,
    }


def apply_memory_organize(cwd: str, actions: list[dict[str, Any]]) -> dict[str, Any]:
    """应用用户确认的记忆整理动作。"""
    merged = 0
    deleted = 0
    rewritten = 0
    refined = 0
    linked = 0
    errors: list[dict[str, Any]] = []

    if not isinstance(actions, list):
        actions = []

    for item in actions:
        if not isinstance(item, dict):
            continue
        action = str(item.get("action") or "").strip().lower()
        targets = [Path(str(name or "")).name for name in (item.get("targets") or [])]
        targets = [name for name in targets if name]
        try:
            if action == "keep":
                continue
            if action == "rewrite":
                if len(targets) != 1:
                    raise ValueError("rewrite requires one target")
                content = str(item.get("new_content") or "")
                if not content.strip():
                    raise ValueError("rewrite requires new_content")
                if not save_memory_file(targets[0], content, cwd):
                    raise RuntimeError("save failed")
                rewritten += 1
            elif action == "merge":
                if len(targets) < 2:
                    raise ValueError("merge requires at least two targets")
                content = str(item.get("new_content") or "")
                if not content.strip():
                    raise ValueError("merge requires new_content")
                new_filename = Path(str(item.get("new_filename") or targets[0])).name
                if not new_filename.endswith(".md"):
                    new_filename += ".md"
                if not save_memory_file(new_filename, content, cwd):
                    raise RuntimeError("save failed")
                for source in targets:
                    if source != new_filename:
                        delete_memory_file(source, cwd)
                merged += 1
            elif action == "refine":
                if len(targets) < 1:
                    raise ValueError("refine requires at least one target")
                content = str(item.get("new_content") or "")
                if not content.strip():
                    raise ValueError("refine requires new_content")
                new_filename = Path(str(item.get("new_filename") or targets[0])).name
                if not new_filename.endswith(".md"):
                    new_filename += ".md"
                if not save_memory_file(new_filename, content, cwd):
                    raise RuntimeError("save failed")
                for source in targets:
                    if source != new_filename:
                        delete_memory_file(source, cwd)
                refined += 1
            elif action == "link":
                if len(targets) != 2:
                    raise ValueError("link requires two targets")
                if apply_memory_link_pair(cwd, targets[0], targets[1]):
                    linked += 1
            elif action == "delete":
                if len(targets) != 1:
                    raise ValueError("delete requires one target")
                if not delete_memory_file(targets[0], cwd):
                    raise RuntimeError("delete failed")
                deleted += 1
        except Exception as exc:
            errors.append({
                "action": action,
                "targets": targets,
                "error": str(exc),
            })

    index_memory(cwd, force=True)
    return {"merged": merged, "deleted": deleted, "rewritten": rewritten, "refined": refined, "linked": linked, "errors": errors}
