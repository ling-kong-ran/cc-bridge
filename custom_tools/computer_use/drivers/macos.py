"""macOS Computer Use 驱动。

使用系统 Accessibility / AppleScript 操作明确目标应用窗口；失败时返回提示，不做全局键鼠注入。
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from typing import Any

from .base import Driver as BaseDriver


class Driver(BaseDriver):
    name = "macos-accessibility"

    def __init__(self):
        super().__init__()
        self.allow_launch = os.environ.get("CCB_COMPUTER_USE_ALLOW_LAUNCH", "1").strip().lower() not in {"0", "false", "no", "off"}

    def _run_osascript(self, script: str) -> str:
        proc = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=20)
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "osascript 执行失败").strip())
        return proc.stdout.strip()

    def _note(self) -> str:
        return "macOS 需要在 系统设置 > 隐私与安全性 > 辅助功能 中允许当前终端/应用控制电脑。"

    def _app_from_window_id(self, window_id: str) -> str:
        return str(window_id or "").split(":", 1)[0]

    def launch_app(self, command: str, args: list[str] | None = None, cwd: str = "") -> dict[str, Any]:
        if not command:
            raise ValueError("command required")
        if not self.allow_launch:
            return {"performed": False, "note": "当前配置禁止启动真实应用。"}
        self._audit("launch_app", {"command": command, "args": args or [], "cwd": cwd})
        app_args = [str(arg) for arg in (args or [])]
        try:
            if not app_args and not cwd and "/" not in command:
                self._run_osascript(f'tell application {json.dumps(command)} to activate')
                return {"performed": True, "application": command, "note": "已通过 AppleScript 启动/激活应用。"}
            proc = subprocess.Popen([command] + app_args, cwd=cwd or None)
            return {"performed": True, "process_id": proc.pid}
        except Exception as exc:
            return {"performed": False, "note": f"启动应用失败：{exc}"}

    def list_windows(self) -> dict[str, Any]:
        self._audit("list_windows", {})
        script = r'''
        set outputLines to {}
        tell application "System Events"
          repeat with p in (application processes whose visible is true)
            set pName to name of p as text
            set pId to unix id of p
            set wIndex to 0
            repeat with w in windows of p
              set wIndex to wIndex + 1
              set wName to ""
              try
                set wName to name of w as text
              end try
              set end of outputLines to (pName & tab & pId & tab & wIndex & tab & wName)
            end repeat
          end repeat
        end tell
        set AppleScript's text item delimiters to linefeed
        return outputLines as text
        '''
        try:
            lines = self._run_osascript(script).splitlines()
            windows = []
            for line in lines:
                parts = line.split("\t", 3)
                if len(parts) < 4:
                    continue
                process, process_id, index, title = parts
                windows.append({
                    "id": f"{process}:{index}",
                    "title": title,
                    "process": process,
                    "process_id": int(process_id) if process_id.isdigit() else process_id,
                    "index": int(index) if index.isdigit() else index,
                })
            return {"windows": windows, "note": self._note()}
        except Exception as exc:
            return {"windows": [], "available": False, "note": f"读取 macOS 窗口失败：{exc}。{self._note()}"}

    def find_window(self, title: str = "", process: str = "") -> dict[str, Any]:
        self._audit("find_window", {"title": title, "process": process})
        title_l = (title or "").lower()
        process_l = (process or "").lower()
        matches = []
        for win in self.list_windows().get("windows", []):
            if title_l and title_l not in str(win.get("title", "")).lower():
                continue
            if process_l and process_l not in str(win.get("process", "")).lower() and process_l not in str(win.get("process_id", "")).lower():
                continue
            matches.append(win)
        return {"windows": matches}

    def list_controls(self, window_id: str = "", title: str = "", limit: int = 80) -> dict[str, Any]:
        app_name = self._app_from_window_id(window_id) or title
        if not app_name:
            return {"controls": [], "note": "macOS 读取控件需要 window_id 或应用名。"}
        max_items = max(1, min(int(limit or 80), 300))
        self._audit("list_controls", {"window_id": window_id, "title": title, "limit": max_items})
        script = f'''
        set outputLines to {{}}
        tell application "System Events"
          tell process {json.dumps(app_name)}
            set i to 0
            repeat with e in entire contents of front window
              set i to i + 1
              if i > {max_items} then exit repeat
              set eRole to ""
              set eName to ""
              try
                set eRole to role of e as text
              end try
              try
                set eName to name of e as text
              end try
              set end of outputLines to (i & tab & eRole & tab & eName)
            end repeat
          end tell
        end tell
        set AppleScript's text item delimiters to linefeed
        return outputLines as text
        '''
        try:
            controls = []
            for line in self._run_osascript(script).splitlines():
                parts = line.split("\t", 2)
                if len(parts) < 3:
                    continue
                index, role, name = parts
                controls.append({"id": index, "index": int(index) if index.isdigit() else index, "name": name, "control_type": role})
            return {"controls": controls, "note": self._note()}
        except Exception as exc:
            return {"controls": [], "available": False, "note": f"读取 macOS 控件失败：{exc}。{self._note()}"}

    def click_control(self, window_id: str = "", control_id: str = "", title: str = "", control_type: str = "") -> dict[str, Any]:
        app_name = self._app_from_window_id(window_id)
        if not app_name or not str(control_id).isdigit():
            return {"performed": False, "note": "macOS 语义点击需要 window_id 和数字 control_id。"}
        self._audit("click_control", {"window_id": window_id, "control_id": control_id, "title": title, "control_type": control_type})
        script = f'''
        tell application "System Events"
          tell process {json.dumps(app_name)}
            set targetElement to item {int(control_id)} of (entire contents of front window)
            click targetElement
          end tell
        end tell
        '''
        try:
            self._run_osascript(script)
            return {"performed": True}
        except Exception as exc:
            return {"performed": False, "note": f"macOS 语义点击失败：{exc}。{self._note()}"}

    def set_text(self, window_id: str = "", control_id: str = "", text: str = "", title: str = "") -> dict[str, Any]:
        app_name = self._app_from_window_id(window_id)
        if not app_name or not str(control_id).isdigit():
            return {"performed": False, "note": "macOS 写入文本需要 window_id 和数字 control_id。"}
        self._audit("set_text", {"window_id": window_id, "control_id": control_id, "text_length": len(text or ""), "title": title})
        script = f'''
        tell application "System Events"
          tell process {json.dumps(app_name)}
            set targetElement to item {int(control_id)} of (entire contents of front window)
            set value of targetElement to {json.dumps(text)}
          end tell
        end tell
        '''
        try:
            self._run_osascript(script)
            return {"performed": True}
        except Exception as exc:
            return {"performed": False, "note": f"macOS 写入文本失败：{exc}。{self._note()}"}

    def get_text(self, window_id: str = "", control_id: str = "", title: str = "") -> dict[str, Any]:
        app_name = self._app_from_window_id(window_id) or title
        if not app_name:
            return {"text": "", "note": "macOS 读取文本需要 window_id 或应用名。"}
        self._audit("get_text", {"window_id": window_id, "control_id": control_id, "title": title})
        if str(control_id).isdigit():
            script = f'''
            tell application "System Events"
              tell process {json.dumps(app_name)}
                set targetElement to item {int(control_id)} of (entire contents of front window)
                try
                  return value of targetElement as text
                on error
                  return name of targetElement as text
                end try
              end tell
            end tell
            '''
        else:
            script = f'tell application "System Events" to tell process {json.dumps(app_name)} to return name of front window as text'
        try:
            return {"text": self._run_osascript(script)}
        except Exception as exc:
            return {"text": "", "note": f"macOS 读取文本失败：{exc}。{self._note()}"}

    def wait_for(self, title: str = "", process: str = "", timeout: float = 10.0) -> dict[str, Any]:
        deadline = time.time() + max(0.1, float(timeout or 10.0))
        last = []
        while time.time() < deadline:
            last = self.find_window(title=title, process=process).get("windows", [])
            if last:
                return {"found": True, "windows": last}
            time.sleep(0.2)
        return {"found": False, "windows": last}
