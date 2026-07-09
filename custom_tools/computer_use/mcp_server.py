#!/usr/bin/env python3
"""Computer Use MCP server。

通过 stdio 暴露受控后台计算机操作工具。stdout 只输出 MCP JSON-RPC，日志写 stderr。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Callable

# 中文：Windows 控制台默认可能是 GBK，窗口标题里的零宽字符等会导致 stdout 编码失败。
# MCP 走 stdio，优先切到 UTF-8；同时 JSON 输出使用 ASCII 转义作为兜底。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from custom_tools.computer_use.driver import load_driver

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "ccb-computer-use"
SERVER_VERSION = "0.1.0"

DRIVER = load_driver()


def _write(payload: dict[str, Any]):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _result(req_id: Any, result: dict[str, Any]):
    _write({"jsonrpc": "2.0", "id": req_id, "result": result})


def _error(req_id: Any, code: int, message: str):
    _write({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def _json_text(data: Any) -> dict[str, str]:
    return {"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=2)}


def tool_list_targets(_args: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "content": [_json_text(DRIVER.list_targets())]}


def tool_get_target(args: dict[str, Any]) -> dict[str, Any]:
    target_id = str(args.get("target_id") or "")
    return {"ok": True, "content": [_json_text(DRIVER.get_target(target_id))]}


def tool_screenshot(args: dict[str, Any]) -> dict[str, Any]:
    target_id = str(args.get("target_id") or "")
    shot = DRIVER.screenshot(target_id)
    image_base64 = shot.pop("image_base64", "")
    mime_type = shot.pop("mime_type", "image/png")
    content = [_json_text(shot)]
    if image_base64:
        content.append({"type": "image", "data": image_base64, "mimeType": mime_type})
    return {"ok": True, "content": content}


def tool_click(args: dict[str, Any]) -> dict[str, Any]:
    target_id = str(args.get("target_id") or "")
    x = int(args.get("x") or 0)
    y = int(args.get("y") or 0)
    button = str(args.get("button") or "left")
    return {"ok": True, "content": [_json_text(DRIVER.click(target_id, x, y, button))]}


def tool_type_text(args: dict[str, Any]) -> dict[str, Any]:
    target_id = str(args.get("target_id") or "")
    text = str(args.get("text") or "")
    return {"ok": True, "content": [_json_text(DRIVER.type_text(target_id, text))]}


def tool_key(args: dict[str, Any]) -> dict[str, Any]:
    target_id = str(args.get("target_id") or "")
    key = str(args.get("key") or "")
    if not key:
        raise ValueError("key required")
    return {"ok": True, "content": [_json_text(DRIVER.key(target_id, key))]}


def tool_launch_app(args: dict[str, Any]) -> dict[str, Any]:
    command = str(args.get("command") or "")
    if not command:
        raise ValueError("command required")
    raw_args = args.get("args") or []
    app_args = [str(arg) for arg in raw_args] if isinstance(raw_args, list) else []
    cwd = str(args.get("cwd") or "")
    return {"ok": True, "content": [_json_text(DRIVER.launch_app(command, app_args, cwd))]}


def tool_list_windows(_args: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "content": [_json_text(DRIVER.list_windows())]}


def tool_find_window(args: dict[str, Any]) -> dict[str, Any]:
    title = str(args.get("title") or "")
    process = str(args.get("process") or "")
    return {"ok": True, "content": [_json_text(DRIVER.find_window(title=title, process=process))]}


def tool_list_controls(args: dict[str, Any]) -> dict[str, Any]:
    window_id = str(args.get("window_id") or "")
    title = str(args.get("title") or "")
    limit = int(args.get("limit") or 80)
    return {"ok": True, "content": [_json_text(DRIVER.list_controls(window_id=window_id, title=title, limit=limit))]}


def tool_click_control(args: dict[str, Any]) -> dict[str, Any]:
    window_id = str(args.get("window_id") or "")
    control_id = str(args.get("control_id") or "")
    title = str(args.get("title") or "")
    control_type = str(args.get("control_type") or "")
    return {"ok": True, "content": [_json_text(DRIVER.click_control(window_id=window_id, control_id=control_id, title=title, control_type=control_type))]}


def tool_set_text(args: dict[str, Any]) -> dict[str, Any]:
    window_id = str(args.get("window_id") or "")
    control_id = str(args.get("control_id") or "")
    text = str(args.get("text") or "")
    title = str(args.get("title") or "")
    return {"ok": True, "content": [_json_text(DRIVER.set_text(window_id=window_id, control_id=control_id, text=text, title=title))]}


def tool_get_text(args: dict[str, Any]) -> dict[str, Any]:
    window_id = str(args.get("window_id") or "")
    control_id = str(args.get("control_id") or "")
    title = str(args.get("title") or "")
    return {"ok": True, "content": [_json_text(DRIVER.get_text(window_id=window_id, control_id=control_id, title=title))]}


def tool_wait_for(args: dict[str, Any]) -> dict[str, Any]:
    title = str(args.get("title") or "")
    process = str(args.get("process") or "")
    timeout = float(args.get("timeout") or 10.0)
    return {"ok": True, "content": [_json_text(DRIVER.wait_for(title=title, process=process, timeout=timeout))]}


TOOLS: list[tuple[str, str, dict[str, Any], Callable[[dict[str, Any]], dict[str, Any]]]] = [
    # 中文：列出 Computer Use 可操作的受控后台目标；不会读取或控制用户当前真实键盘鼠标。
    (
        "computer_list_targets",
        "List available computer targets.",
        {"type": "object", "properties": {}},
        tool_list_targets,
    ),
    # 中文：获取指定受控后台目标的信息。
    (
        "computer_get_target",
        "Get target information.",
        {"type": "object", "properties": {"target_id": {"type": "string", "description": "Target ID."}}},
        tool_get_target,
    ),
    # 中文：获取受控后台目标截图；安全默认驱动不会读取用户当前屏幕。
    (
        "computer_screenshot",
        "Take a screenshot of a target.",
        {"type": "object", "properties": {"target_id": {"type": "string", "description": "Target ID."}}},
        tool_screenshot,
    ),
    # 中文：在受控后台目标内点击坐标；不会注入到用户当前真实鼠标。
    (
        "computer_click",
        "Click a target coordinate.",
        {
            "type": "object",
            "properties": {
                "target_id": {"type": "string", "description": "Target ID."},
                "x": {"type": "integer", "description": "X coordinate inside the target."},
                "y": {"type": "integer", "description": "Y coordinate inside the target."},
                "button": {"type": "string", "enum": ["left", "right", "middle"], "description": "Mouse button to click."},
            },
            "required": ["x", "y"],
        },
        tool_click,
    ),
    # 中文：向受控后台目标输入文本；不会注入到用户当前真实键盘。
    (
        "computer_type_text",
        "Type text into a target.",
        {
            "type": "object",
            "properties": {
                "target_id": {"type": "string", "description": "Target ID."},
                "text": {"type": "string", "description": "Text to type."},
            },
            "required": ["text"],
        },
        tool_type_text,
    ),
    # 中文：向受控后台目标发送单个按键或组合键描述；不会注入到用户当前真实键盘。
    (
        "computer_key",
        "Send a key or key combination to a target.",
        {
            "type": "object",
            "properties": {
                "target_id": {"type": "string", "description": "Target ID."},
                "key": {"type": "string", "description": "Key, e.g. Enter or Ctrl+S."},
            },
            "required": ["key"],
        },
        tool_key,
    ),
    # 中文：启动桌面应用并返回进程与窗口信息；仅用于用户明确要求操作的目标应用。
    (
        "computer_launch_app",
        "Launch an app.",
        {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Executable path or command."},
                "args": {"type": "array", "items": {"type": "string"}, "description": "Launch arguments."},
                "cwd": {"type": "string", "description": "Working directory."},
            },
            "required": ["command"],
        },
        tool_launch_app,
    ),
    # 中文：列出当前可见桌面窗口摘要，用于选择明确目标窗口。
    (
        "computer_list_windows",
        "List visible windows.",
        {"type": "object", "properties": {}},
        tool_list_windows,
    ),
    # 中文：按窗口标题或进程信息查找目标窗口。
    (
        "computer_find_window",
        "Find windows by title or process.",
        {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Window title keyword."},
                "process": {"type": "string", "description": "Process name, class, or PID."},
            },
        },
        tool_find_window,
    ),
    # 中文：列出目标窗口内控件树摘要，便于按控件 ID、标题或类型执行语义操作。
    (
        "computer_list_controls",
        "List controls in a window.",
        {
            "type": "object",
            "properties": {
                "window_id": {"type": "string", "description": "Target window ID."},
                "title": {"type": "string", "description": "Window title keyword."},
                "limit": {"type": "integer", "description": "Control limit."},
            },
        },
        tool_list_controls,
    ),
    # 中文：对目标窗口内控件执行 UIA 语义点击；默认不会回退到前台真实鼠标点击。
    (
        "computer_click_control",
        "Click a control in a window.",
        {
            "type": "object",
            "properties": {
                "window_id": {"type": "string", "description": "Target window ID."},
                "control_id": {"type": "string", "description": "Control ID, automation_id, or index."},
                "title": {"type": "string", "description": "Control title keyword."},
                "control_type": {"type": "string", "description": "Control type, such as Button or Edit."},
            },
            "required": ["window_id"],
        },
        tool_click_control,
    ),
    # 中文：对目标窗口内文本控件执行 UIA 语义写入；默认不会回退到前台真实键盘输入。
    (
        "computer_set_text",
        "Set text in a control.",
        {
            "type": "object",
            "properties": {
                "window_id": {"type": "string", "description": "Target window ID."},
                "control_id": {"type": "string", "description": "Control ID, automation_id, or index."},
                "title": {"type": "string", "description": "Control title keyword."},
                "text": {"type": "string", "description": "Text to write."},
            },
            "required": ["window_id", "text"],
        },
        tool_set_text,
    ),
    # 中文：读取目标窗口或控件文本。
    (
        "computer_get_text",
        "Read text from a window or control.",
        {
            "type": "object",
            "properties": {
                "window_id": {"type": "string", "description": "Target window ID."},
                "control_id": {"type": "string", "description": "Control ID, automation_id, or index."},
                "title": {"type": "string", "description": "Window title keyword."},
            },
        },
        tool_get_text,
    ),
    # 中文：等待匹配标题或进程信息的窗口出现。
    (
        "computer_wait_for",
        "Wait for a window.",
        {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Window title keyword."},
                "process": {"type": "string", "description": "Process name, class, or PID."},
                "timeout": {"type": "number", "description": "Seconds to wait. Defaults to 10."},
            },
        },
        tool_wait_for,
    ),
]

TOOL_HANDLERS = {name: handler for name, _desc, _schema, handler in TOOLS}


def _handle(msg: dict[str, Any]):
    method = msg.get("method")
    req_id = msg.get("id")
    is_request = req_id is not None

    if method == "initialize":
        client_proto = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL_VERSION
        _result(req_id, {
            "protocolVersion": client_proto,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })
    elif method == "tools/list":
        _result(req_id, {"tools": [
            {"name": name, "description": desc, "inputSchema": schema}
            for name, desc, schema, _handler in TOOLS
        ]})
    elif method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name", "")
        arguments = params.get("arguments") or {}
        handler = TOOL_HANDLERS.get(name)
        if not handler:
            _error(req_id, -32602, f"Unknown tool: {name}")
            return
        try:
            outcome = handler(arguments if isinstance(arguments, dict) else {})
        except Exception as exc:
            _result(req_id, {"content": [{"type": "text", "text": f"Tool execution error: {exc}"}], "isError": True})
            return
        _result(req_id, {"content": outcome.get("content") or [{"type": "text", "text": ""}], "isError": not outcome.get("ok", False)})
    elif method == "ping":
        _result(req_id, {})
    elif is_request:
        _error(req_id, -32601, f"Method not implemented: {method}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            _handle(msg)
        except Exception as exc:
            req_id = msg.get("id") if isinstance(msg, dict) else None
            if req_id is not None:
                _error(req_id, -32603, str(exc))


if __name__ == "__main__":
    main()
