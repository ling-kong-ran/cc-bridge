"""Computer Use 基础驱动。

第一版只提供安全的后台目标抽象和可审计的占位执行，不做全局键鼠注入。
"""
from __future__ import annotations

import base64
import json
import os
import platform
import time
from pathlib import Path
from typing import Any


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


class Driver:
    """安全默认驱动：只暴露受控目标，不触碰用户当前真实输入设备。"""

    name = "safe-background"

    def __init__(self):
        self.audit_path = Path(os.environ.get("CCB_COMPUTER_USE_AUDIT") or Path.home() / ".ccb" / "computer_use_audit.log")
        self.target_id = os.environ.get("CCB_COMPUTER_USE_TARGET", "background").strip() or "background"
        self.target_label = os.environ.get("CCB_COMPUTER_USE_TARGET_LABEL", "受控后台目标").strip() or "受控后台目标"

    def _audit(self, action: str, data: dict[str, Any]):
        try:
            self.audit_path.parent.mkdir(parents=True, exist_ok=True)
            entry = {"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "action": action, "data": data}
            with self.audit_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def list_targets(self) -> dict[str, Any]:
        return {
            "targets": [
                {
                    "id": self.target_id,
                    "label": self.target_label,
                    "platform": platform.system() or "unknown",
                    "driver": self.name,
                    "isolated": True,
                    "active_user_input_safe": True,
                    "capabilities": ["screenshot", "click", "type_text", "key"],
                }
            ]
        }

    def get_target(self, target_id: str) -> dict[str, Any]:
        if target_id and target_id != self.target_id:
            raise ValueError(f"未知受控目标: {target_id}")
        return self.list_targets()["targets"][0]

    def screenshot(self, target_id: str = "") -> dict[str, Any]:
        target = self.get_target(target_id or self.target_id)
        self._audit("screenshot", {"target_id": target["id"]})
        return {
            "target": target,
            "mime_type": "image/png",
            "image_base64": base64.b64encode(PNG_1X1).decode("ascii"),
            "note": "当前安全驱动返回受控后台目标占位截图；未读取或控制用户当前屏幕。",
        }

    def click(self, target_id: str, x: int, y: int, button: str = "left") -> dict[str, Any]:
        target = self.get_target(target_id or self.target_id)
        self._audit("click", {"target_id": target["id"], "x": x, "y": y, "button": button})
        return {"target": target, "performed": True, "note": "已记录后台点击意图；安全驱动不会注入到用户当前真实鼠标。"}

    def type_text(self, target_id: str, text: str) -> dict[str, Any]:
        target = self.get_target(target_id or self.target_id)
        self._audit("type_text", {"target_id": target["id"], "text_length": len(text or "")})
        return {"target": target, "performed": True, "note": "已记录后台输入意图；安全驱动不会注入到用户当前真实键盘。"}

    def key(self, target_id: str, key: str) -> dict[str, Any]:
        target = self.get_target(target_id or self.target_id)
        self._audit("key", {"target_id": target["id"], "key": key})
        return {"target": target, "performed": True, "note": "已记录后台按键意图；安全驱动不会注入到用户当前真实键盘。"}

    def launch_app(self, command: str, args: list[str] | None = None, cwd: str = "") -> dict[str, Any]:
        self._audit("launch_app", {"command": command, "args": args or [], "cwd": cwd})
        return {"performed": False, "note": "当前安全驱动不启动真实应用。Windows 可安装 pywinauto 后使用真实桌面自动化驱动。"}

    def list_windows(self) -> dict[str, Any]:
        self._audit("list_windows", {})
        return {"windows": [], "note": "当前安全驱动不枚举真实窗口。"}

    def find_window(self, title: str = "", process: str = "") -> dict[str, Any]:
        self._audit("find_window", {"title": title, "process": process})
        return {"windows": [], "note": "当前安全驱动不查找真实窗口。"}

    def list_controls(self, window_id: str = "", title: str = "", limit: int = 80) -> dict[str, Any]:
        self._audit("list_controls", {"window_id": window_id, "title": title, "limit": limit})
        return {"controls": [], "note": "当前安全驱动不读取真实控件树。"}

    def click_control(self, window_id: str = "", control_id: str = "", title: str = "", control_type: str = "") -> dict[str, Any]:
        self._audit("click_control", {"window_id": window_id, "control_id": control_id, "title": title, "control_type": control_type})
        return {"performed": False, "note": "当前安全驱动不点击真实控件。"}

    def set_text(self, window_id: str = "", control_id: str = "", text: str = "", title: str = "") -> dict[str, Any]:
        self._audit("set_text", {"window_id": window_id, "control_id": control_id, "text_length": len(text or ""), "title": title})
        return {"performed": False, "note": "当前安全驱动不写入真实控件。"}

    def get_text(self, window_id: str = "", control_id: str = "", title: str = "") -> dict[str, Any]:
        self._audit("get_text", {"window_id": window_id, "control_id": control_id, "title": title})
        return {"text": "", "note": "当前安全驱动不读取真实控件文本。"}

    def wait_for(self, title: str = "", process: str = "", timeout: float = 10.0) -> dict[str, Any]:
        self._audit("wait_for", {"title": title, "process": process, "timeout": timeout})
        return {"found": False, "note": "当前安全驱动不等待真实窗口。"}
