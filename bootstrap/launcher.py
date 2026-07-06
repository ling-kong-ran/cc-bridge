"""启动 server.py。"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

from .claude_setup import server_env
from .probe import REPO_ROOT
from .state import log


def launch_server(python: Path, desktop: bool = False) -> int:
    env = server_env()
    cmd = [str(python), "-u", "server.py"]
    if desktop:
        env["CCB_DESKTOP"] = "1"
        env.setdefault("CCB_HOST", "127.0.0.1")
        cmd.append("--desktop")
    log("启动服务：" + " ".join(cmd))
    proc = subprocess.run(cmd, cwd=REPO_ROOT, env=env)
    return proc.returncode
