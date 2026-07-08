#!/usr/bin/env python3
"""准备桌面包随包携带的 Python 依赖。"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIR = REPO_ROOT / "runtime"
PY_DEPS_DIR = RUNTIME_DIR / "python"
REQUIREMENTS = REPO_ROOT / "requirements.txt"


def _venv_python() -> Path | None:
    candidate = REPO_ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return candidate if candidate.exists() else None


def main() -> int:
    if not REQUIREMENTS.exists():
        raise SystemExit("requirements.txt not found")

    if PY_DEPS_DIR.exists():
        shutil.rmtree(PY_DEPS_DIR)
    PY_DEPS_DIR.mkdir(parents=True, exist_ok=True)

    python = _venv_python() or Path(sys.executable)
    print(f"[CC Bridge] Prepare bundled Python deps with {python}")
    subprocess.run(
        [str(python), "-m", "pip", "install", "-r", str(REQUIREMENTS), "--target", str(PY_DEPS_DIR), "--upgrade"],
        cwd=REPO_ROOT,
        check=True,
    )

    manifest = {
        "bundled_python_deps": True,
        "pythonpath_relpaths": ["python"],
        "skip_python_install": True,
    }
    (RUNTIME_DIR / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[CC Bridge] Bundled Python deps ready: {PY_DEPS_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
