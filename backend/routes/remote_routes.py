"""远程目标与远程文件 REST 路由处理。"""
import asyncio
from typing import Any

from backend.services.remote_service import (
    cache_remote_file,
    delete_remote_target,
    list_remote_files,
    list_remote_targets,
    save_remote_target,
    test_remote_target,
)


def handle_remote_get(path: str) -> tuple[int, dict[str, Any] | None]:
    """处理远程目标 GET API。"""
    if path == "/api/remote-targets":
        return 200, list_remote_targets()
    return 0, None


async def handle_remote_post(path: str, data: dict[str, Any]) -> tuple[int, dict[str, Any] | None]:
    """处理远程目标与文件 POST API。"""
    loop = asyncio.get_event_loop()
    if path == "/api/remote-files/list":
        result = await loop.run_in_executor(
            None,
            list_remote_files,
            data.get("target_id", ""),
            data.get("path", ""),
        )
        return 200, result
    if path == "/api/remote-files/cache":
        result = await loop.run_in_executor(
            None,
            cache_remote_file,
            data.get("target_id", ""),
            data.get("path", ""),
            data.get("cwd", ""),
        )
        return 200, result
    if path == "/api/remote-targets":
        try:
            return 200, save_remote_target(data)
        except ValueError as exc:
            return 400, {"error": str(exc)}
    if path == "/api/remote-targets/delete":
        return 200, delete_remote_target(data.get("id", ""))
    if path == "/api/remote-targets/test":
        result = await loop.run_in_executor(None, test_remote_target, data)
        return 200, result
    return 0, None
