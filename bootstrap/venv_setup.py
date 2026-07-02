"""项目虚拟环境准备。"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from .probe import REPO_ROOT, venv_python_path
from .state import log


def ensure_venv() -> Path:
    """确保项目 .venv 存在并安装依赖，返回 venv Python 路径。"""
    venv_dir = REPO_ROOT / ".venv"
    python = venv_python_path(venv_dir)
    if python.exists():
        log(f"已找到虚拟环境：{python}")
    else:
        log(f"创建虚拟环境：{venv_dir}")
        subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], check=True)
        if not python.exists():
            raise RuntimeError(f"虚拟环境创建失败，未找到 Python：{python}")

    _install_deps(python)
    return python


def _install_deps(python: Path) -> None:
    """将 requirements.txt 安装到 venv 中。"""
    req_file = REPO_ROOT / "requirements.txt"
    if not req_file.exists():
        log("未找到 requirements.txt，跳过依赖安装")
        return
    log("安装项目依赖...")
    subprocess.run(
        [str(python), "-m", "pip", "install", "-r", str(req_file)],
        check=True,
    )
