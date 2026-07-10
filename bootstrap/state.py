"""bootstrap 状态与日志。"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

CCB_HOME = Path(os.environ.get("CCB_HOME") or (Path.home() / ".ccb")).expanduser()
LOG_PATH = CCB_HOME / "bootstrap.log"
STATE_PATH = CCB_HOME / "bootstrap_state.json"


def _ensure_home() -> None:
    CCB_HOME.mkdir(parents=True, exist_ok=True)


def log(message: str) -> None:
    """写入 bootstrap 日志，同时打印到终端。"""
    _ensure_home()
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    print(line, flush=True)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def emit_progress(
    step: str,
    status: str,
    title: str,
    detail: str = "",
    error: str | None = None,
) -> None:
    """向桌面启动页输出结构化 bootstrap 进度事件。"""
    payload: dict[str, Any] = {
        "type": "bootstrap_progress",
        "step": step,
        "status": status,
        "title": title,
        "detail": detail,
        "updated_at": time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    }
    if error:
        payload["error"] = error
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def write_state(data: dict[str, Any]) -> None:
    """持久化最近一次环境检测状态。"""
    _ensure_home()
    payload = dict(data)
    payload["updated_at"] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    STATE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
