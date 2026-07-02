"""项目 Python 环境检测与准备。"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from .probe import REPO_ROOT, venv_python_path
from .state import log


def find_server_python() -> Path:
    """查找可用的 Python 解释器，优先 .venv 其次系统 Python。

    优先级：.venv Python > 系统 python3/python > 当前进程 Python
    如果使用 .venv，自动安装依赖；如果用系统 Python，尝试安装。
    """
    # 1. 项目 .venv
    venv_python = venv_python_path()
    if venv_python.exists():
        log(f"使用虚拟环境：{venv_python}")
        _install_deps(venv_python)
        return venv_python

    # 2. 系统 python3 / python
    for cmd in ("python3", "python"):
        found = shutil.which(cmd)
        if found:
            log(f"使用系统 Python：{found}")
            _install_deps(Path(found))
            return Path(found)

    # 3. 当前进程 Python
    log(f"使用当前 Python：{sys.executable}")
    _install_deps(Path(sys.executable))
    return Path(sys.executable)


def _install_deps(python: Path) -> None:
    """将 requirements.txt 安装到 Python 环境中（失败不阻止启动）。"""
    req_file = REPO_ROOT / "requirements.txt"
    if not req_file.exists():
        return
    log("安装项目依赖...")
    try:
        subprocess.run(
            [str(python), "-m", "pip", "install", "-r", str(req_file)],
            check=True,
        )
    except subprocess.CalledProcessError:
        log("依赖安装失败，可能是离线环境，继续启动服务")
