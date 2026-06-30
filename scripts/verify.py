#!/usr/bin/env python3
"""轻量回归检查：语法、i18n key、git whitespace。"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY_FILES = [
    "server.py",
    "ccb_bridge.py",
    "remote_bridge.py",
    "config_manager.py",
    "session_store.py",
    "remote_manager.py",
    "bootstrap.py",
    "bootstrap/probe.py",
    "bootstrap/installer.py",
    "bootstrap/python_setup.py",
    "bootstrap/venv_setup.py",
    "bootstrap/node_setup.py",
    "bootstrap/claude_setup.py",
    "bootstrap/launcher.py",
    "bootstrap/state.py",
]


def run(cmd: list[str]) -> bool:
    print("$", " ".join(cmd))
    proc = subprocess.run(cmd, cwd=ROOT)
    return proc.returncode == 0


def check_i18n() -> bool:
    zh_path = ROOT / "static" / "i18n" / "zh.json"
    en_path = ROOT / "static" / "i18n" / "en.json"
    zh = json.loads(zh_path.read_text(encoding="utf-8"))
    en = json.loads(en_path.read_text(encoding="utf-8"))
    zh_keys = set(zh)
    en_keys = set(en)
    missing_en = sorted(zh_keys - en_keys)
    missing_zh = sorted(en_keys - zh_keys)
    if missing_en or missing_zh:
        if missing_en:
            print("en.json missing keys:", ", ".join(missing_en))
        if missing_zh:
            print("zh.json missing keys:", ", ".join(missing_zh))
        return False
    print("i18n keys ok")
    return True


def main() -> int:
    ok = True
    ok = run([sys.executable, "-m", "py_compile", *PY_FILES]) and ok
    ok = run(["node", "--check", "static/app.js"]) and ok
    ok = check_i18n() and ok
    ok = run(["git", "diff", "--check"]) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
