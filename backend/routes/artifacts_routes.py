"""资产索引 REST 路由处理。"""
from typing import Any, Callable

from backend.services.artifacts_service import list_recent_artifacts

ArtifactHrefBuilder = Callable[[str], str]


def handle_artifacts_get(
    path: str,
    query: dict[str, list[str]] | None,
    *,
    href_for_value: ArtifactHrefBuilder,
) -> tuple[int, dict[str, Any] | None]:
    """处理资产索引 GET API。"""
    if path != "/api/artifacts":
        return 0, None
    try:
        limit_sessions = int((query or {}).get("limit_sessions", ["30"])[0])
    except (ValueError, IndexError):
        limit_sessions = 30
    return 200, list_recent_artifacts(limit_sessions, href_for_value)
