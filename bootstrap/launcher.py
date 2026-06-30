"""启动 server.py。"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

from .claude_setup import server_env
from .probe import REPO_ROOT
from .state import log


def launch_server(python: Path) -> int:
    env = server_env()
    env.setdefault("CCB_GUI_OPEN_BROWSER", "1")
    cmd = [str(python), "-u", "server.py"]
    log("启动服务：" + " ".join(cmd))
    proc = subprocess.run(cmd, cwd=REPO_ROOT, env=env)
    return proc.returncode
