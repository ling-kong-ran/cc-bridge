"""启动 server.py。"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

from .claude_setup import server_env
from .probe import REPO_ROOT
from .runtime import bundled_python_paths
from .state import log


def launch_server(python: Path, desktop: bool = False, extra_env: dict[str, str] | None = None) -> int:
    env = server_env()
    python_paths = [str(p) for p in bundled_python_paths()]
    if python_paths:
        old_pythonpath = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = os.pathsep.join(python_paths + ([old_pythonpath] if old_pythonpath else []))
    if extra_env:
        env.update(extra_env)
    cmd = [str(python), "-u", "server.py"]
    if desktop:
        env["CCB_DESKTOP"] = "1"
        env.setdefault("CCB_HOST", "127.0.0.1")
        cmd.append("--desktop")
    log("启动服务：" + " ".join(cmd))
    proc = subprocess.run(cmd, cwd=REPO_ROOT, env=env)
    return proc.returncode
