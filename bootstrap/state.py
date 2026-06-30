"""bootstrap 状态与日志。"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

CCB_HOME = Path.home() / ".ccb"
LOG_PATH = CCB_HOME / "bootstrap.log"
STATE_PATH = CCB_HOME / "bootstrap_state.json"


def _ensure_home() -> None:
    CCB_HOME.mkdir(parents=True, exist_ok=True)


def log(message: str) -> None:
    """写入 bootstrap 日志，同时打印到终端。"""
    _ensure_home()
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    print(line)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def write_state(data: dict[str, Any]) -> None:
    """持久化最近一次环境检测状态。"""
    _ensure_home()
    payload = dict(data)
    payload["updated_at"] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    STATE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
