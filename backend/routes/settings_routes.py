"""GUI 设置 REST 路由处理。"""
from typing import Any, Awaitable, Callable

from backend.services.settings_service import load_gui_settings, save_gui_settings

LanRevoker = Callable[[], Awaitable[Any]]
LocalhostChecker = Callable[[str], bool]


def handle_settings_get(path: str, access_context: dict[str, Any], default_cwd: str) -> tuple[int, dict[str, Any] | None]:
    """处理 GUI 设置 GET API。"""
    if path == "/api/gui-settings":
        return 200, load_gui_settings(access_context, default_cwd)
    return 0, None


async def handle_settings_post(
    path: str,
    data: dict[str, Any],
    *,
    client_ip: str,
    is_localhost_ip: LocalhostChecker,
    revoke_lan_clients: LanRevoker,
) -> tuple[int, dict[str, Any] | None]:
    """处理 GUI 设置 POST API。"""
    if path != "/api/gui-settings":
        return 0, None
    try:
        result = await save_gui_settings(
            data,
            client_ip=client_ip,
            is_localhost_ip=is_localhost_ip,
            revoke_lan_clients=revoke_lan_clients,
        )
    except PermissionError:
        return 403, {"error": "localhost only"}
    return 200, result
