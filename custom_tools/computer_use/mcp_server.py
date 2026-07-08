#!/usr/bin/env python3
"""Computer Use MCP server。

通过 stdio 暴露受控后台计算机操作工具。stdout 只输出 MCP JSON-RPC，日志写 stderr。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from custom_tools.computer_use.driver import load_driver

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "ccb-computer-use"
SERVER_VERSION = "0.1.0"

DRIVER = load_driver()


def _write(payload: dict[str, Any]):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
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
    (
        "computer_list_targets",
        "列出 Computer Use 可操作的受控后台目标。不会读取或控制用户当前真实键盘鼠标。",
        {"type": "object", "properties": {}},
        tool_list_targets,
    ),
    (
        "computer_get_target",
        "获取指定受控后台目标的信息。",
        {"type": "object", "properties": {"target_id": {"type": "string", "description": "目标 ID，留空使用默认后台目标"}}},
        tool_get_target,
    ),
    (
        "computer_screenshot",
        "获取受控后台目标截图。安全默认驱动不会读取用户当前屏幕。",
        {"type": "object", "properties": {"target_id": {"type": "string", "description": "目标 ID，留空使用默认后台目标"}}},
        tool_screenshot,
    ),
    (
        "computer_click",
        "在受控后台目标内点击坐标。不会注入到用户当前真实鼠标。",
        {
            "type": "object",
            "properties": {
                "target_id": {"type": "string", "description": "目标 ID，留空使用默认后台目标"},
                "x": {"type": "integer", "description": "目标内 X 坐标"},
                "y": {"type": "integer", "description": "目标内 Y 坐标"},
                "button": {"type": "string", "enum": ["left", "right", "middle"], "description": "鼠标按钮"},
            },
            "required": ["x", "y"],
        },
        tool_click,
    ),
    (
        "computer_type_text",
        "向受控后台目标输入文本。不会注入到用户当前真实键盘。",
        {
            "type": "object",
            "properties": {
                "target_id": {"type": "string", "description": "目标 ID，留空使用默认后台目标"},
                "text": {"type": "string", "description": "要输入的文本"},
            },
            "required": ["text"],
        },
        tool_type_text,
    ),
    (
        "computer_key",
        "向受控后台目标发送单个按键或组合键描述。不会注入到用户当前真实键盘。",
        {
            "type": "object",
            "properties": {
                "target_id": {"type": "string", "description": "目标 ID，留空使用默认后台目标"},
                "key": {"type": "string", "description": "按键名或组合键，例如 Enter、Escape、Ctrl+S"},
            },
            "required": ["key"],
        },
        tool_key,
    ),
    (
        "computer_launch_app",
        "启动桌面应用并返回进程与窗口信息。仅用于用户明确要求操作的目标应用。",
        {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "可执行文件路径或命令"},
                "args": {"type": "array", "items": {"type": "string"}, "description": "启动参数"},
                "cwd": {"type": "string", "description": "工作目录，可留空"},
            },
            "required": ["command"],
        },
        tool_launch_app,
    ),
    (
        "computer_list_windows",
        "列出当前可见桌面窗口摘要，用于选择明确目标窗口。",
        {"type": "object", "properties": {}},
        tool_list_windows,
    ),
    (
        "computer_find_window",
        "按窗口标题或进程信息查找目标窗口。",
        {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "窗口标题关键字"},
                "process": {"type": "string", "description": "进程名、类名或进程 ID 关键字"},
            },
        },
        tool_find_window,
    ),
    (
        "computer_list_controls",
        "列出目标窗口内控件树摘要，便于按控件 ID、标题或类型执行语义操作。",
        {
            "type": "object",
            "properties": {
                "window_id": {"type": "string", "description": "目标窗口 ID"},
                "title": {"type": "string", "description": "窗口标题关键字，window_id 为空时使用"},
                "limit": {"type": "integer", "description": "最多返回控件数，默认 80，最大 300"},
            },
        },
        tool_list_controls,
    ),
    (
        "computer_click_control",
        "对目标窗口内控件执行 UIA 语义点击。默认不会回退到前台真实鼠标点击。",
        {
            "type": "object",
            "properties": {
                "window_id": {"type": "string", "description": "目标窗口 ID"},
                "control_id": {"type": "string", "description": "控件 ID、automation_id 或 index"},
                "title": {"type": "string", "description": "控件标题关键字"},
                "control_type": {"type": "string", "description": "控件类型，例如 Button、Edit"},
            },
            "required": ["window_id"],
        },
        tool_click_control,
    ),
    (
        "computer_set_text",
        "对目标窗口内文本控件执行 UIA 语义写入。默认不会回退到前台真实键盘输入。",
        {
            "type": "object",
            "properties": {
                "window_id": {"type": "string", "description": "目标窗口 ID"},
                "control_id": {"type": "string", "description": "控件 ID、automation_id 或 index"},
                "title": {"type": "string", "description": "控件标题关键字"},
                "text": {"type": "string", "description": "要写入的文本"},
            },
            "required": ["window_id", "text"],
        },
        tool_set_text,
    ),
    (
        "computer_get_text",
        "读取目标窗口或控件文本。",
        {
            "type": "object",
            "properties": {
                "window_id": {"type": "string", "description": "目标窗口 ID"},
                "control_id": {"type": "string", "description": "控件 ID、automation_id 或 index"},
                "title": {"type": "string", "description": "窗口标题关键字，window_id 为空时使用"},
            },
        },
        tool_get_text,
    ),
    (
        "computer_wait_for",
        "等待匹配标题或进程信息的窗口出现。",
        {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "窗口标题关键字"},
                "process": {"type": "string", "description": "进程名、类名或进程 ID 关键字"},
                "timeout": {"type": "number", "description": "等待秒数，默认 10"},
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
            _error(req_id, -32602, f"未知工具: {name}")
            return
        try:
            outcome = handler(arguments if isinstance(arguments, dict) else {})
        except Exception as exc:
            _result(req_id, {"content": [{"type": "text", "text": f"工具执行异常: {exc}"}], "isError": True})
            return
        _result(req_id, {"content": outcome.get("content") or [{"type": "text", "text": ""}], "isError": not outcome.get("ok", False)})
    elif method == "ping":
        _result(req_id, {})
    elif is_request:
        _error(req_id, -32601, f"未实现的方法: {method}")


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
