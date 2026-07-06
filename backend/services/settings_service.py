"""GUI 设置相关服务。"""
from typing import Any, Callable

from config_manager import get_gui_settings, update_gui_settings


def load_gui_settings(access_context: dict[str, Any], default_cwd: str) -> dict[str, Any]:
    """读取 GUI 设置并附加当前访问上下文。"""
    data = get_gui_settings()
    data.update(access_context)
    data["default_cwd"] = default_cwd
    return data


async def save_gui_settings(
    data: dict[str, Any],
    *,
    client_ip: str,
    is_localhost_ip: Callable[[str], bool],
    revoke_lan_clients: Callable[[], Any],
) -> dict[str, Any]:
    """保存 GUI 设置；LAN 访问开关只能从 localhost 修改。"""
    if "lan_access_enabled" in data and not is_localhost_ip(client_ip):
        raise PermissionError("localhost only")
    result = update_gui_settings(data)
    if data.get("lan_access_enabled") is False:
        await revoke_lan_clients()
    return result
