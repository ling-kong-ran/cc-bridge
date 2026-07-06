"""自动上下文注入相关服务。"""
from typing import Any

import context_orchestrator
from config_manager import get_gui_settings, update_gui_settings


def load_context_settings() -> dict[str, Any]:
    """读取并规整自动上下文设置。"""
    return context_orchestrator.normalize_context_settings(get_gui_settings())


def save_context_settings(data: dict[str, Any]) -> dict[str, Any]:
    """只保存自动上下文设置白名单字段。"""
    allowed = {key: data[key] for key in context_orchestrator.DEFAULT_CONTEXT_SETTINGS if key in data}
    return context_orchestrator.normalize_context_settings(update_gui_settings(allowed))


def preview_context(data: dict[str, Any], default_cwd: str) -> dict[str, Any]:
    """生成一次自动上下文召回预览。"""
    cwd = str(data.get("cwd") or default_cwd)
    query_text = str(data.get("query") or data.get("content") or "")
    settings = load_context_settings()
    if "max_tokens" in data:
        settings["memoryInjectMaxTokens"] = data.get("max_tokens")
    trace = context_orchestrator.retrieve_context_trace(
        query=query_text,
        cwd=cwd,
        client_id=str(data.get("client_id") or ""),
        session_id=str(data.get("session_id") or ""),
        settings=settings,
    )
    return {"ok": True, "trace": trace}
