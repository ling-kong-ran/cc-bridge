"""环境探测。"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
NPM_PREFIX = Path.home() / ".ccb" / "npm-global"


def npm_bin_dirs() -> list[Path]:
    """返回受控 npm prefix 可能产生可执行文件的位置。"""
    if os.name == "nt":
        return [NPM_PREFIX, NPM_PREFIX / "node_modules" / ".bin"]
    return [NPM_PREFIX / "bin", NPM_PREFIX / "node_modules" / ".bin"]


def path_with_controlled_npm(env: dict[str, str] | None = None) -> dict[str, str]:
    """构造将内置运行时与受控 npm bin 放在最前的环境变量。"""
    merged = dict(env or os.environ)
    dirs = npm_bin_dirs()
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
    venv_dir = REPO_ROOT / ".venv"
    python = venv_python_path(venv_dir)
    return {
        "path": str(venv_dir),
        "python": str(python),
        "exists": python.exists(),
    }


def venv_python_path(venv_dir: Path | None = None) -> Path:
    root = venv_dir or (REPO_ROOT / ".venv")
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
    }
