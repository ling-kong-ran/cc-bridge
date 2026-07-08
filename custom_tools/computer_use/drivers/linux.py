"""Linux Computer Use 驱动。

优先使用 AT-SPI Accessibility 树操作明确目标应用/控件；不可用时返回提示，不做全局键鼠注入。
"""
from __future__ import annotations

import os
import subprocess
import time
from typing import Any

from .base import Driver as BaseDriver

try:
    import pyatspi  # type: ignore
except Exception:  # pragma: no cover - 依赖可选，通常来自系统包 python3-pyatspi
    pyatspi = None


class Driver(BaseDriver):
    name = "linux-atspi"

    def __init__(self):
        super().__init__()
        self.available = pyatspi is not None
        self.allow_launch = os.environ.get("CCB_COMPUTER_USE_ALLOW_LAUNCH", "1").strip().lower() not in {"0", "false", "no", "off"}

    def _missing(self) -> dict[str, Any]:
        return {
            "performed": False,
            "available": False,
            "note": "Linux 桌面自动化需要 AT-SPI 和 python3-pyatspi，并需运行在图形桌面会话中。当前已回退为安全占位驱动。",
        }

    def _desktop(self) -> Any:
        if not self.available:
            raise RuntimeError(self._missing()["note"])
        return pyatspi.Registry.getDesktop(0)

    def _safe(self, fn: Any, default: Any = "") -> Any:
        try:
            return fn()
        except Exception:
            return default

    def _node_id(self, node: Any, path: list[int]) -> str:
        app = self._safe(lambda: node.getApplication(), None)
        app_name = self._safe(lambda: app.name, "") if app else ""
        return f"{app_name}:{'.'.join(str(i) for i in path)}"

    def _node_info(self, node: Any, path: list[int]) -> dict[str, Any]:
        rect = {"left": 0, "top": 0, "right": 0, "bottom": 0}
        try:
            component = node.queryComponent()
            x, y, width, height = component.getExtents(pyatspi.DESKTOP_COORDS)
            rect = {"left": x, "top": y, "right": x + width, "bottom": y + height}
        except Exception:
            pass
        role = self._safe(lambda: node.getRoleName(), "")
        app = self._safe(lambda: node.getApplication(), None)
        return {
            "id": self._node_id(node, path),
            "path": ".".join(str(i) for i in path),
            "name": self._safe(lambda: node.name, ""),
            "description": self._safe(lambda: node.description, ""),
            "control_type": role,
            "process": self._safe(lambda: app.name, "") if app else "",
            "rect": rect,
        }

    def _iter_apps(self) -> list[Any]:
        desktop = self._desktop()
        return [desktop.getChildAtIndex(i) for i in range(desktop.childCount)]

    def _walk(self, node: Any, path: list[int], limit: int, out: list[tuple[Any, list[int]]]):
        if len(out) >= limit:
            return
        out.append((node, path))
        child_count = self._safe(lambda: node.childCount, 0)
        for idx in range(child_count):
            if len(out) >= limit:
                return
            child = self._safe(lambda idx=idx: node.getChildAtIndex(idx), None)
            if child is not None:
                self._walk(child, path + [idx], limit, out)

    def _find_node_by_id(self, node_id: str = "", title: str = "") -> tuple[Any, list[int]]:
        title_l = (title or "").lower()
        for app_idx, app in enumerate(self._iter_apps()):
            nodes: list[tuple[Any, list[int]]] = []
            self._walk(app, [app_idx], 2000, nodes)
            for node, path in nodes:
                info = self._node_info(node, path)
                if node_id and str(info.get("id")) != str(node_id) and str(info.get("path")) != str(node_id):
                    continue
                if title_l and title_l not in str(info.get("name", "")).lower():
                    continue
                return node, path
        raise RuntimeError("未找到匹配控件")

    def launch_app(self, command: str, args: list[str] | None = None, cwd: str = "") -> dict[str, Any]:
        if not command:
            raise ValueError("command required")
        if not self.allow_launch:
            return {"performed": False, "note": "当前配置禁止启动真实应用。"}
        cmd = [command] + [str(arg) for arg in (args or [])]
        self._audit("launch_app", {"command": command, "args": args or [], "cwd": cwd})
        try:
            proc = subprocess.Popen(cmd, cwd=cwd or None)
            time.sleep(0.5)
            return {"performed": True, "process_id": proc.pid, "windows": self.find_window(process=command).get("windows", [])}
        except Exception as exc:
            return {"performed": False, "note": f"启动应用失败：{exc}"}

    def list_windows(self) -> dict[str, Any]:
        if not self.available:
            return {"windows": [], **self._missing()}
        self._audit("list_windows", {})
        windows = []
        for app_idx, app in enumerate(self._iter_apps()):
            app_name = self._safe(lambda app=app: app.name, "")
            child_count = self._safe(lambda app=app: app.childCount, 0)
            for idx in range(child_count):
                child = self._safe(lambda idx=idx, app=app: app.getChildAtIndex(idx), None)
                if child is None:
                    continue
                role = self._safe(lambda child=child: child.getRoleName(), "")
                if role.lower() not in {"frame", "dialog", "window", "application"}:
                    continue
                info = self._node_info(child, [app_idx, idx])
                info.update({"title": info.get("name", ""), "process": app_name})
                windows.append(info)
        return {"windows": windows}

    def find_window(self, title: str = "", process: str = "") -> dict[str, Any]:
        if not self.available:
            return {"windows": [], **self._missing()}
        self._audit("find_window", {"title": title, "process": process})
        title_l = (title or "").lower()
        process_l = (process or "").lower()
        matches = []
        for win in self.list_windows().get("windows", []):
            if title_l and title_l not in str(win.get("title", "")).lower():
                continue
            if process_l and process_l not in str(win.get("process", "")).lower():
                continue
            matches.append(win)
        return {"windows": matches}

    def list_controls(self, window_id: str = "", title: str = "", limit: int = 80) -> dict[str, Any]:
        if not self.available:
            return {"controls": [], **self._missing()}
        max_items = max(1, min(int(limit or 80), 300))
        window, path = self._find_node_by_id(node_id=window_id, title=title)
        nodes: list[tuple[Any, list[int]]] = []
        self._walk(window, path, max_items, nodes)
        controls = [self._node_info(node, node_path) for node, node_path in nodes]
        self._audit("list_controls", {"window_id": window_id, "title": title, "count": len(controls)})
        return {"window": self._node_info(window, path), "controls": controls}

    def click_control(self, window_id: str = "", control_id: str = "", title: str = "", control_type: str = "") -> dict[str, Any]:
        if not self.available:
            return self._missing()
        node, path = self._find_node_by_id(node_id=control_id or window_id, title=title)
        info = self._node_info(node, path)
        self._audit("click_control", {"window_id": window_id, "control_id": control_id, "title": title, "control": info})
        try:
            action = node.queryAction()
            for idx in range(action.nActions):
                name = action.getName(idx).lower()
                if name in {"click", "press", "activate", "toggle"}:
                    action.doAction(idx)
                    return {"performed": True, "control": info, "action": name}
            return {"performed": False, "control": info, "note": "控件没有可用的 AT-SPI click/press/activate 动作。"}
        except Exception as exc:
            return {"performed": False, "control": info, "note": f"Linux AT-SPI 语义点击失败：{exc}"}

    def set_text(self, window_id: str = "", control_id: str = "", text: str = "", title: str = "") -> dict[str, Any]:
        if not self.available:
            return self._missing()
        node, path = self._find_node_by_id(node_id=control_id or window_id, title=title)
        info = self._node_info(node, path)
        self._audit("set_text", {"window_id": window_id, "control_id": control_id, "text_length": len(text or ""), "title": title})
        try:
            editable = node.queryEditableText()
            current_len = self._safe(lambda: node.queryText().characterCount, 0)
            editable.deleteText(0, current_len)
            editable.insertText(0, text, len(text))
            return {"performed": True, "control": info}
        except Exception as exc:
            return {"performed": False, "control": info, "note": f"Linux AT-SPI 写入文本失败：{exc}"}

    def get_text(self, window_id: str = "", control_id: str = "", title: str = "") -> dict[str, Any]:
        if not self.available:
            return {"text": "", **self._missing()}
        node, path = self._find_node_by_id(node_id=control_id or window_id, title=title)
        info = self._node_info(node, path)
        self._audit("get_text", {"window_id": window_id, "control_id": control_id, "title": title})
        try:
            text_obj = node.queryText()
            text = text_obj.getText(0, text_obj.characterCount)
        except Exception:
            text = str(info.get("name") or info.get("description") or "")
        return {"text": text, "target": info}

    def wait_for(self, title: str = "", process: str = "", timeout: float = 10.0) -> dict[str, Any]:
        deadline = time.time() + max(0.1, float(timeout or 10.0))
        last = []
        while time.time() < deadline:
            last = self.find_window(title=title, process=process).get("windows", [])
            if last:
                return {"found": True, "windows": last}
            time.sleep(0.2)
        return {"found": False, "windows": last}
