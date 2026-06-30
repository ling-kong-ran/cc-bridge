"""项目虚拟环境准备。"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from .probe import REPO_ROOT, venv_python_path
from .state import log


def ensure_venv() -> Path:
    """确保项目 .venv 存在，返回 venv Python 路径。"""
    venv_dir = REPO_ROOT / ".venv"
    python = venv_python_path(venv_dir)
    if python.exists():
        log(f"已找到虚拟环境：{python}")
        return python

    log(f"创建虚拟环境：{venv_dir}")
    subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], check=True)
    if not python.exists():
        raise RuntimeError(f"虚拟环境创建失败，未找到 Python：{python}")
    return python
