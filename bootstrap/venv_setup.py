"""项目 Python 环境检测与准备。"""
from __future__ import annotations

import shutil
import socket
import subprocess
import sys
from pathlib import Path

from .probe import REPO_ROOT, venv_python_path
from .state import log


def find_server_python() -> Path:
    """查找可用的 Python 解释器。

    有网：优先 .venv，没有则自动创建并安装依赖。
    无网：使用已有的 .venv 或系统 Python（必须有依赖）。
    都没有：提示用户安装 Python。
    """
    online = _check_internet()
    log(f"网络状态：{'在线' if online else '离线'}")

    # 1. 项目 .venv
    venv_python = venv_python_path()
    if venv_python.exists():
        log(f"使用虚拟环境：{venv_python}")
        if online:
            _install_deps(venv_python)
        return venv_python

    # 2. 有网：创建 .venv
    if online:
        log("创建虚拟环境...")
        _create_venv()
        venv_python = venv_python_path()
        if venv_python.exists():
            _install_deps(venv_python)
            return venv_python

    # 3. 无网 / .venv 创建失败：尝试系统 Python
    for cmd in ("python3", "python"):
        found = shutil.which(cmd)
        if found:
            log(f"使用系统 Python：{found}")
            if online:
                _install_deps(Path(found))
            return Path(found)

    # 4. 当前进程 Python（最后兜底）
    log(f"使用当前 Python：{sys.executable}")
    if online:
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


def _check_internet(timeout: float = 3.0) -> bool:
    """检查网络连通性。"""
    for host, port in (("pypi.org", 443), ("google.com", 80), ("baidu.com", 80)):
        try:
            s = socket.create_connection((host, port), timeout=timeout)
            s.close()
            return True
        except OSError:
            continue
    return False


def _create_venv() -> None:
    """在项目中创建 .venv 虚拟环境。"""
    venv_dir = REPO_ROOT / ".venv"
    try:
        subprocess.run(
            [sys.executable, "-m", "venv", str(venv_dir)],
            check=True,
        )
    except subprocess.CalledProcessError:
        log("创建 .venv 失败")
