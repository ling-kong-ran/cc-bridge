"""项目 Python 环境检测与准备。"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
from pathlib import Path

from .probe import CCB_HOME, REPO_ROOT, VENV_DIR, venv_python_path
from .state import log

_MIN_PYTHON = (3, 10)


def _is_windows_app_execution_alias(path: Path) -> bool:
    text = str(path).replace("\\", "/").lower()
    return "/microsoft/windowsapps/" in text


def _python_version(path: Path) -> tuple[int, int] | None:
    if os.name == "nt" and _is_windows_app_execution_alias(path):
        log(f"跳过 WindowsApps Python 占位入口：{path}")
        return None
    try:
        proc = subprocess.run(
            [str(path), "-c", "import sys; print(sys.version_info[:2])"],
            capture_output=True, text=True, timeout=8,
        )
        out = proc.stdout.strip()
        m = re.match(r"\((\d+),\s*(\d+)\)", out)
        if m:
            return int(m[1]), int(m[2])
    except Exception:
        pass
    return None


def _scan_common_python_dirs() -> list[Path]:
    """扫描常见 Python 安装目录，返回版本号从高到低的候选路径。"""
    candidates: list[tuple[tuple[int, int] | None, Path]] = []

    if os.name == "nt":
        # py launcher — 优先用最新 Python 3
        try:
            proc = subprocess.run(
                ["py", "-3", "-c", "import sys; print(sys.executable)"],
                capture_output=True, text=True, timeout=8,
            )
            exe = proc.stdout.strip()
            if exe:
                p = Path(exe)
                ver = _python_version(p)
                if ver and ver >= _MIN_PYTHON:
                    candidates.append((ver, p))
        except Exception:
            pass

        bases = [
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Python",
            Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Python",
            Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "Python",
        ]
        for base in bases:
            if not base.is_dir():
                continue
            for d in sorted(base.iterdir(), reverse=True):  # Python312 > Python311
                if not d.is_dir():
                    continue
                exe = d / "python.exe"
                if exe.is_file():
                    ver = _python_version(exe)
                    candidates.append((ver, exe))
    else:
        for pattern in ("python3.13", "python3.12", "python3.11", "python3.10"):
            found = shutil.which(pattern)
            if found:
                p = Path(found)
                ver = _python_version(p)
                candidates.append((ver, p))
        bases = [
            Path("/usr/local/bin"),
            Path("/opt/homebrew/bin"),
        ]
        for base in bases:
            if not base.is_dir():
                continue
            for entry in sorted(base.iterdir(), reverse=True):
                if not entry.is_file():
                    continue
                if re.match(r"python3\.\d+$", entry.name):
                    ver = _python_version(entry)
                    candidates.append((ver, entry))

    # 版本降序，None 放最后
    def _sort_key(item: tuple[tuple[int, int] | None, Path]) -> tuple[int, int]:
        v = item[0]
        return v if v else (-1, -1)

    candidates.sort(key=_sort_key, reverse=True)

    seen: set[str] = set()
    result: list[Path] = []
    for ver, path in candidates:
        if str(path) not in seen:
            seen.add(str(path))
            result.append(path)
    return result


def find_server_python(allow_install: bool = True) -> Path:
    """查找可用的 Python 解释器。

    allow_install=True：联网时可创建 .venv 并安装依赖。
    allow_install=False：只使用已存在的环境，不执行任何安装流程。
    """
    online = _check_internet() if allow_install else False
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
        log(f"创建虚拟环境：{VENV_DIR}")
        _create_venv()
        venv_python = venv_python_path()
        if venv_python.exists():
            _install_deps(venv_python, force=True)
            return venv_python

    # 3. 无网 / .venv 创建失败：扫描机器上的 Python，选版本最高的 ≥ 3.10
    for candidate in _scan_common_python_dirs():
        ver = _python_version(candidate)
        if ver and ver >= _MIN_PYTHON:
            log(f"使用扫描到的 Python（{ver[0]}.{ver[1]}）：{candidate}")
            return candidate

    # 4. PATH 中的 python3 / python
    for cmd in ("python3", "python"):
        found = shutil.which(cmd)
        if found:
            p = Path(found)
            if os.name == "nt" and _is_windows_app_execution_alias(p):
                log(f"跳过 WindowsApps Python 占位入口：{found}")
                continue
            ver = _python_version(p)
            if ver and ver < _MIN_PYTHON:
                log(f"PATH 中的 Python 版本过低（{ver[0]}.{ver[1]}），跳过：{found}")
                continue
            log(f"使用系统 Python：{found}")
            return p

    # 5. 当前进程 Python（最后兜底）
    log(f"使用当前 Python：{sys.executable}")
    return Path(sys.executable)


def _requirements_hash(req_file: Path) -> str:
    return hashlib.sha256(req_file.read_bytes()).hexdigest()


def _deps_state_path() -> Path:
    return CCB_HOME / "python_deps_state.json"


def _read_deps_state() -> dict:
    try:
        return json.loads(_deps_state_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_deps_state(req_hash: str) -> None:
    CCB_HOME.mkdir(parents=True, exist_ok=True)
    _deps_state_path().write_text(
        json.dumps({"requirements_hash": req_hash}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _install_deps(python: Path, force: bool = False) -> None:
    """将 requirements.txt 安装到 Python 环境中（失败不阻止启动）。"""
    req_file = REPO_ROOT / "requirements.txt"
    if not req_file.exists():
        return
    req_hash = _requirements_hash(req_file)
    state = _read_deps_state()
    if not force and state.get("requirements_hash") == req_hash:
        log("Python 依赖未变化，跳过安装")
        return
    log("安装项目依赖...")
    # 强制 UTF-8：Windows GBK(cp936) locale 下 pip 用 locale 编码读 requirements.txt，
    # 遇中文注释会抛 UnicodeDecodeError。PYTHONUTF8=1 让 pip 按 UTF-8 解码文件。
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        subprocess.run(
            [str(python), "-m", "pip", "install", "-r", str(req_file)],
            env=env,
            check=True,
        )
        _write_deps_state(req_hash)
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
    """在持久化运行时目录中创建虚拟环境。"""
    venv_dir = VENV_DIR
    try:
        venv_dir.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [sys.executable, "-m", "venv", str(venv_dir)],
            check=True,
        )
    except subprocess.CalledProcessError:
        log("创建 .venv 失败")
