"""内置 Python 依赖探测。"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]


def _runtime_root() -> Path:
    configured = os.environ.get("CCB_BUNDLED_RUNTIME_ROOT", "").strip()
    return Path(configured).expanduser() if configured else REPO_ROOT / "runtime"


def _manifest_path(runtime_root: Path) -> Path:
    configured = os.environ.get("CCB_BUNDLED_MANIFEST", "").strip()
    return Path(configured).expanduser() if configured else runtime_root / "manifest.json"


def _resolve(runtime_root: Path, value: str | None) -> Path | None:
    if not value:
        return None
    path = Path(value)
    if not path.is_absolute():
        path = runtime_root / path
    return path


def get_bundled_runtime() -> dict[str, Any]:
    """读取随包携带的 Python 依赖 manifest；不存在时返回未启用状态。"""
    runtime_root = _runtime_root()
    manifest_path = _manifest_path(runtime_root)
    manifest: dict[str, Any] = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            manifest = {}

    pythonpath_relpaths = manifest.get("pythonpath_relpaths") or []
    if isinstance(pythonpath_relpaths, str):
        pythonpath_relpaths = [pythonpath_relpaths]
    pythonpath = [p for p in (_resolve(runtime_root, item) for item in pythonpath_relpaths) if p]
    skip_python_install = bool(manifest.get("skip_python_install", manifest.get("skip_install_flow")))

    return {
        "root": runtime_root,
        "manifest_path": manifest_path,
        "manifest": manifest,
        "skip_python_install": skip_python_install,
        "pythonpath": pythonpath,
        "available": manifest_path.exists(),
    }


def has_bundled_python_deps(runtime: dict[str, Any] | None = None) -> bool:
    """判断当前包是否携带 Python 依赖。"""
    info = runtime or get_bundled_runtime()
    return bool(info.get("available") and info.get("skip_python_install"))


def bundled_python_paths(runtime: dict[str, Any] | None = None) -> list[Path]:
    """返回随包携带的 Python 依赖目录。"""
    info = runtime or get_bundled_runtime()
    return [p for p in info.get("pythonpath", []) if isinstance(p, Path) and p.exists()]
