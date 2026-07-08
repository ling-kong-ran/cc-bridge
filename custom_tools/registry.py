"""自定义工具统一注册表。"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


CUSTOM_TOOLS_DIR = Path(__file__).parent


CUSTOM_TOOL_MANIFESTS: dict[str, dict[str, Any]] = {
    "computer_use": {
        "name": "computer_use",
        "label": "Computer Use",
        "description": "后台计算机控制工具：面向受控窗口、虚拟会话或无头上下文执行键盘鼠标类操作，不接管用户当前真实输入设备。",
        "source": "custom",
        "category": "automation",
        "risk": "high",
        "enabled": True,
        "custom": True,
        "driver": "isolated-background",
        "platforms": ["windows", "macos", "linux"],
        "mcp_server": "computer_use",
        "mcp_command": sys.executable,
        "mcp_args": [str(CUSTOM_TOOLS_DIR / "computer_use" / "mcp_server.py")],
        "mcp_tools": [
            "computer_list_targets",
            "computer_get_target",
            "computer_screenshot",
            "computer_click",
            "computer_type_text",
            "computer_key",
            "computer_launch_app",
            "computer_list_windows",
            "computer_find_window",
            "computer_list_controls",
            "computer_click_control",
            "computer_set_text",
            "computer_get_text",
            "computer_wait_for",
        ],
    }
}


def list_custom_tool_manifests() -> list[dict[str, Any]]:
    """列出内置自定义工具 manifest。"""
    return [dict(item) for item in CUSTOM_TOOL_MANIFESTS.values()]


def get_custom_tool_manifest(name: str) -> dict[str, Any] | None:
    """按名称读取自定义工具 manifest。"""
    item = CUSTOM_TOOL_MANIFESTS.get(str(name or "").strip())
    return dict(item) if item else None
