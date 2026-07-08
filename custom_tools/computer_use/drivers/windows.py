"""Windows Computer Use 驱动。

优先使用 pywinauto + UI Automation 操作明确目标窗口/控件；不可用时回退到安全占位驱动。
"""
from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Any

from .base import Driver as BaseDriver

try:
    from pywinauto import Application, Desktop
    from pywinauto.findwindows import ElementNotFoundError
except Exception:  # pragma: no cover - 依赖可选
    Application = None
    Desktop = None
    ElementNotFoundError = Exception


class Driver(BaseDriver):
    name = "windows-pywinauto-uia"

    def __init__(self):
        super().__init__()
        self.available = Application is not None and Desktop is not None
        self.backend = os.environ.get("CCB_COMPUTER_USE_WINDOWS_BACKEND", "uia") or "uia"
        self.allow_input_fallback = os.environ.get("CCB_COMPUTER_USE_ALLOW_INPUT_FALLBACK", "").strip().lower() in {"1", "true", "yes", "on"}
        self.desktop = Desktop(backend=self.backend) if self.available else None

    def _missing(self) -> dict[str, Any]:
        return {
            "performed": False,
            "available": False,
            "note": "Windows 桌面自动化需要安装 pywinauto：pip install pywinauto。当前已回退为安全占位驱动。",
        }

    def _window_id(self, wrapper: Any) -> str:
        try:
            return str(wrapper.handle)
        except Exception:
            return ""

    def _control_id(self, wrapper: Any) -> str:
        try:
            info = wrapper.element_info
            auto_id = getattr(info, "automation_id", "") or ""
            handle = getattr(info, "handle", None) or getattr(wrapper, "handle", None) or ""
            runtime_id = getattr(info, "runtime_id", "") or ""
            return str(auto_id or handle or runtime_id or id(wrapper))
        except Exception:
            return str(id(wrapper))

    def _window_info(self, wrapper: Any) -> dict[str, Any]:
        info = wrapper.element_info
        rect = wrapper.rectangle()
        return {
            "id": self._window_id(wrapper),
            "title": wrapper.window_text(),
            "process_id": getattr(info, "process_id", None),
            "class_name": getattr(info, "class_name", "") or "",
            "control_type": getattr(info, "control_type", "") or "",
            "visible": wrapper.is_visible(),
            "enabled": wrapper.is_enabled(),
            "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
        }

    def _control_info(self, wrapper: Any, index: int) -> dict[str, Any]:
        info = wrapper.element_info
        rect = wrapper.rectangle()
        return {
            "id": self._control_id(wrapper),
            "index": index,
            "name": wrapper.window_text(),
            "automation_id": getattr(info, "automation_id", "") or "",
            "class_name": getattr(info, "class_name", "") or "",
            "control_type": getattr(info, "control_type", "") or "",
            "enabled": wrapper.is_enabled(),
            "visible": wrapper.is_visible(),
            "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
        }

    def _windows(self) -> list[Any]:
        if not self.available or not self.desktop:
            return []
        return [w for w in self.desktop.windows() if w.is_visible()]

    def _find_window_wrapper(self, window_id: str = "", title: str = "", process: str = "") -> Any:
        if not self.available:
            raise RuntimeError(self._missing()["note"])
        title_l = (title or "").lower()
        process_l = (process or "").lower()
        for win in self._windows():
            info = self._window_info(win)
            if window_id and str(info.get("id")) != str(window_id):
                continue
            if title_l and title_l not in str(info.get("title", "")).lower():
                continue
            if process_l and process_l not in str(info.get("class_name", "")).lower() and process_l not in str(info.get("process_id", "")).lower():
                continue
            return win
        raise RuntimeError("未找到匹配窗口")

    def _find_control_wrapper(self, window: Any, control_id: str = "", title: str = "", control_type: str = "") -> Any:
        title_l = (title or "").lower()
        type_l = (control_type or "").lower()
        for idx, ctrl in enumerate(window.descendants()):
            info = self._control_info(ctrl, idx)
            identifiers = {str(info.get("id", "")), str(info.get("automation_id", "")), str(info.get("index", ""))}
            if control_id and str(control_id) not in identifiers:
                continue
            if title_l and title_l not in str(info.get("name", "")).lower():
                continue
            if type_l and type_l != str(info.get("control_type", "")).lower():
                continue
            return ctrl
        raise RuntimeError("未找到匹配控件")

    def launch_app(self, command: str, args: list[str] | None = None, cwd: str = "") -> dict[str, Any]:
        if not self.available:
            return self._missing()
        if not command:
            raise ValueError("command required")
        cmd = [command] + [str(arg) for arg in (args or [])]
        self._audit("launch_app", {"command": command, "args": args or [], "cwd": cwd})
        try:
            app = Application(backend=self.backend).start(cmd, work_dir=cwd or None)
            pid = app.process
        except Exception:
            proc = subprocess.Popen(cmd, cwd=cwd or None)
            pid = proc.pid
        time.sleep(0.5)
        windows = []
        for win in self._windows():
            info = self._window_info(win)
            if str(info.get("process_id")) == str(pid):
                windows.append(info)
        return {"performed": True, "process_id": pid, "windows": windows}

    def list_windows(self) -> dict[str, Any]:
        if not self.available:
            return {"windows": [], **self._missing()}
        self._audit("list_windows", {})
        return {"windows": [self._window_info(win) for win in self._windows()]}

    def find_window(self, title: str = "", process: str = "") -> dict[str, Any]:
        if not self.available:
            return {"windows": [], **self._missing()}
        self._audit("find_window", {"title": title, "process": process})
        matches = []
        title_l = (title or "").lower()
        process_l = (process or "").lower()
        for win in self._windows():
            info = self._window_info(win)
            if title_l and title_l not in str(info.get("title", "")).lower():
                continue
            if process_l and process_l not in str(info.get("class_name", "")).lower() and process_l not in str(info.get("process_id", "")).lower():
                continue
            matches.append(info)
        return {"windows": matches}

    def list_controls(self, window_id: str = "", title: str = "", limit: int = 80) -> dict[str, Any]:
        if not self.available:
            return {"controls": [], **self._missing()}
        window = self._find_window_wrapper(window_id=window_id, title=title)
        controls = []
        for idx, ctrl in enumerate(window.descendants()[:max(1, min(int(limit or 80), 300))]):
            controls.append(self._control_info(ctrl, idx))
        self._audit("list_controls", {"window_id": window_id, "title": title, "count": len(controls)})
        return {"window": self._window_info(window), "controls": controls}

    def click_control(self, window_id: str = "", control_id: str = "", title: str = "", control_type: str = "") -> dict[str, Any]:
        if not self.available:
            return self._missing()
        window = self._find_window_wrapper(window_id=window_id)
        control = self._find_control_wrapper(window, control_id=control_id, title=title, control_type=control_type)
        info = self._control_info(control, 0)
        self._audit("click_control", {"window_id": window_id, "control": info})
        try:
            control.invoke()
        except Exception as exc:
            if not self.allow_input_fallback:
                return {
                    "performed": False,
                    "control": info,
                    "note": f"控件不支持后台 invoke，已阻止前台鼠标点击回退：{exc}",
                }
            control.click_input()
        return {"performed": True, "control": info}

    def set_text(self, window_id: str = "", control_id: str = "", text: str = "", title: str = "") -> dict[str, Any]:
        if not self.available:
            return self._missing()
        window = self._find_window_wrapper(window_id=window_id)
        control = self._find_control_wrapper(window, control_id=control_id, title=title)
        info = self._control_info(control, 0)
        self._audit("set_text", {"window_id": window_id, "control": info, "text_length": len(text or "")})
        try:
            control.set_edit_text(text)
        except Exception as exc:
            if not self.allow_input_fallback:
                return {
                    "performed": False,
                    "control": info,
                    "note": f"控件不支持后台 set_edit_text，已阻止前台键盘输入回退：{exc}",
                }
            control.type_keys("^a{BACKSPACE}", set_foreground=False)
            control.type_keys(text, with_spaces=True, set_foreground=False)
        return {"performed": True, "control": info}

    def get_text(self, window_id: str = "", control_id: str = "", title: str = "") -> dict[str, Any]:
        if not self.available:
            return {"text": "", **self._missing()}
        window = self._find_window_wrapper(window_id=window_id, title=title if not control_id else "")
        if control_id:
            control = self._find_control_wrapper(window, control_id=control_id)
            text = control.window_text()
            info = self._control_info(control, 0)
        else:
            text = window.window_text()
            info = self._window_info(window)
        self._audit("get_text", {"window_id": window_id, "control_id": control_id, "title": title})
        return {"text": text, "target": info}

    def wait_for(self, title: str = "", process: str = "", timeout: float = 10.0) -> dict[str, Any]:
        if not self.available:
            return {"found": False, **self._missing()}
        deadline = time.time() + max(0.1, float(timeout or 10.0))
        last = []
        while time.time() < deadline:
            last = self.find_window(title=title, process=process).get("windows", [])
            if last:
                return {"found": True, "windows": last}
            time.sleep(0.2)
        return {"found": False, "windows": last}
