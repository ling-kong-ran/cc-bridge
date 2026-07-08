"""Computer Use 平台驱动入口。"""
from __future__ import annotations

import os
import platform
from importlib import import_module
from typing import Any


def load_driver() -> Any:
    """按当前平台加载 Computer Use 驱动。"""
    forced = os.environ.get("CCB_COMPUTER_USE_DRIVER", "").strip().lower()
    system = forced or platform.system().lower()
    if system.startswith("win"):
        module = "custom_tools.computer_use.drivers.windows"
    elif system.startswith("darwin") or system.startswith("mac"):
        module = "custom_tools.computer_use.drivers.macos"
    elif system.startswith("linux"):
        module = "custom_tools.computer_use.drivers.linux"
    else:
        module = "custom_tools.computer_use.drivers.base"
    return import_module(module).Driver()
