"""环境探测。"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

from .state import CCB_HOME

REPO_ROOT = Path(__file__).resolve().parents[1]
NPM_PREFIX = CCB_HOME / "npm-global"
VENV_DIR = CCB_HOME / "venv"


def npm_bin_dirs() -> list[Path]:
    """返回受控 npm prefix 可能产生可执行文件的位置。"""
    if os.name == "nt":
        return [NPM_PREFIX, NPM_PREFIX / "node_modules" / ".bin"]
    return [NPM_PREFIX / "bin", NPM_PREFIX / "node_modules" / ".bin"]


def bundled_node_dirs() -> list[Path]:
    """返回内置运行时（CCB_BUNDLED_RUNTIME_ROOT）中 node 可执行文件所在目录。

    离线机器没有系统 Node 时，npm-global 里的 claude.cmd 仍依赖 node 才能运行。
    把内置 runtime 里的 node 目录加进 PATH，让 claude 在零外部依赖下也能启动。
    目录不存在则返回空列表，无副作用。
    """
    root = os.environ.get("CCB_BUNDLED_RUNTIME_ROOT")
    if not root:
        return []
    base = Path(root) / "node"
    if os.name == "nt":
        # node.exe 直接放在 node/ 下
        return [base] if (base / "node.exe").exists() else []
    # macOS/Linux：node 二进制在 node/bin/ 下
    return [base / "bin"] if (base / "bin" / "node").exists() else []


def path_with_controlled_npm(env: dict[str, str] | None = None) -> dict[str, str]:
    """构造将内置 node、受控 npm bin 放在最前的环境变量。"""
    merged = dict(env or os.environ)
    # 顺序：内置 node 在最前（claude.cmd 要靠它执行），其次 npm-global bin
    dirs = bundled_node_dirs() + npm_bin_dirs()
    prefix = os.pathsep.join(str(p) for p in dirs)
    old_path = merged.get("PATH", "")
    merged["PATH"] = prefix + (os.pathsep + old_path if old_path else "") if prefix else old_path
    return merged


def command_version(command: str | Path, *args: str) -> str:
    try:
        proc = subprocess.run(
            [str(command), *args],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return proc.stdout.strip().splitlines()[0] if proc.stdout.strip() else ""


def detect_python() -> dict:
    return {
        "executable": sys.executable,
        "version": platform.python_version(),
        "ok": sys.version_info >= (3, 10),
    }


def detect_venv() -> dict:
    python = venv_python_path(VENV_DIR)
    return {
        "path": str(VENV_DIR),
        "python": str(python),
        "exists": python.exists(),
    }


def venv_python_path(venv_dir: Path | None = None) -> Path:
    root = venv_dir or VENV_DIR
    if os.name == "nt":
        return root / "Scripts" / "python.exe"
    return root / "bin" / "python"


def detect_node() -> dict:
    node = shutil.which("node")
    npm = shutil.which("npm")
    return {
        "node": node or "",
        "node_version": command_version(node, "--version") if node else "",
        "npm": npm or "",
        "npm_version": command_version(npm, "--version") if npm else "",
        "ok": bool(node and npm),
    }


def _controlled_claude_candidates() -> list[Path]:
    names = ["claude.cmd", "claude.exe", "claude"] if os.name == "nt" else ["claude"]
    return [folder / name for folder in npm_bin_dirs() for name in names]


def detect_available_clis() -> list[dict]:
    """按约定顺序检测所有可用的 ccb / claude CLI。"""
    candidates: list[tuple[str, str, str]] = []

    local_names = ["ccb.exe"] if os.name == "nt" else ["ccb", "ccb.exe"]
    for name in local_names:
        p = REPO_ROOT / name
        if p.exists():
            candidates.append(("ccb (本地)", str(p), "local"))
            break

    for name in local_names:
        p = REPO_ROOT.parent / name
        if p.exists():
            candidates.append(("ccb (上级目录)", str(p), "local"))
            break

    for p in _controlled_claude_candidates():
        if p.exists():
            candidates.append(("claude (~/.ccb/npm-global)", str(p), "controlled-npm"))
            break

    env = path_with_controlled_npm()
    for cmd, label in (("ccb", "ccb (PATH)"), ("claude", "claude (PATH)")):
        found = shutil.which(cmd, path=env.get("PATH"))
        if found:
            candidates.append((label, found, "path"))

    seen: set[str] = set()
    available = []
    for name, path, source in candidates:
        if path in seen:
            continue
        seen.add(path)
        available.append({"name": name, "path": path, "source": source, "version": command_version(path, "--version")})
    return available


def detect_cli() -> dict:
    """按约定顺序检测 ccb / claude CLI。"""
    available = detect_available_clis()
    return {"available": available, "selected": available[0] if available else None}


def get_environment_status() -> dict:
    return {
        "os": {"name": os.name, "platform": platform.system(), "release": platform.release()},
        "python": detect_python(),
        "venv": detect_venv(),
        "node": detect_node(),
        "cli": detect_cli(),
        "npm_prefix": str(NPM_PREFIX),
        "npm_bin_dirs": [str(p) for p in npm_bin_dirs()],
        "ccb_home": str(CCB_HOME),
    }
