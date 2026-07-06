"""自动上下文 REST 路由处理。"""
from typing import Any

from backend.services.context_service import load_context_settings, save_context_settings, preview_context


def handle_context_get(path: str) -> tuple[int, dict[str, Any] | None]:
    """处理自动上下文 GET API。"""
    if path == "/api/context/settings":
        return 200, load_context_settings()
    return 0, None


def handle_context_post(path: str, data: dict[str, Any], default_cwd: str) -> tuple[int, dict[str, Any] | None]:
    """处理自动上下文 POST API。"""
    if path == "/api/context/settings":
        return 200, save_context_settings(data)
    if path == "/api/context/preview":
        return 200, preview_context(data, default_cwd)
    return 0, None
