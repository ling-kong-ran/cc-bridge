"""资产索引相关服务。"""
from typing import Any, Callable

from artifact_store import list_artifacts

ArtifactHrefBuilder = Callable[[str], str]


def list_recent_artifacts(limit_sessions: int, href_for_value: ArtifactHrefBuilder) -> dict[str, Any]:
    """读取最近会话中的资产记录。"""
    return list_artifacts(limit_sessions, href_for_value=href_for_value)
