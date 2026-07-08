#!/usr/bin/env python3
"""CC Bridge 跨平台 bootstrap 入口。"""
from __future__ import annotations

import argparse
import os
import sys

from bootstrap.claude_setup import ensure_claude_cli
from bootstrap.launcher import launch_server
from bootstrap.node_setup import ensure_node
from bootstrap.probe import get_environment_status
from bootstrap.python_setup import ensure_python_version
from bootstrap.runtime import bundled_python_paths, get_bundled_runtime, has_bundled_python_deps
from bootstrap.state import log, write_state
from bootstrap.venv_setup import find_server_python


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="准备 CC Bridge 运行环境并启动服务。")
    parser.add_argument("--yes", action="store_true", help="自动确认安装操作")
    parser.add_argument("--status", action="store_true", help="仅输出并记录环境状态，不启动服务")
    parser.add_argument("--desktop", action="store_true", help="桌面模式启动服务，不打开外部浏览器")
    return parser.parse_args()


def _ensure_claude_runtime(yes: bool = False) -> None:
    """确保 Claude CLI 可用；只有缺 CLI 且需要 npm 时才准备 Node/npm。"""
    try:
        ensure_claude_cli(yes)
    except RuntimeError as exc:
        if "需要 npm" not in str(exc):
            raise
        ensure_node(yes)
        ensure_claude_cli(yes)


def main() -> int:
    args = parse_args()
    try:
        runtime = get_bundled_runtime()
        ensure_python_version()
        status = get_environment_status()
        write_state(status)
        if args.status:
            log("环境状态已写入 ~/.ccb/bootstrap_state.json")
            return 0

        if args.desktop and has_bundled_python_deps(runtime):
            log("桌面包模式：使用随包 Python 依赖，跳过 pip 安装；Claude CLI 保持原有检测/安装流程")
            python = find_server_python(allow_install=False)
            python_paths = bundled_python_paths(runtime)
            extra_env = {}
            if python_paths:
                old_pythonpath = os.environ.get("PYTHONPATH", "")
                extra_env["PYTHONPATH"] = os.pathsep.join(str(p) for p in python_paths) + (os.pathsep + old_pythonpath if old_pythonpath else "")
            _ensure_claude_runtime(args.yes)
            write_state(get_environment_status())
            return launch_server(python, desktop=args.desktop, extra_env=extra_env)

        python = find_server_python()
        _ensure_claude_runtime(args.yes)
        write_state(get_environment_status())
        return launch_server(python, desktop=args.desktop)
    except KeyboardInterrupt:
        log("用户中断 bootstrap")
        return 130
    except Exception as exc:
        log(f"bootstrap 失败：{exc}")
        try:
            write_state(get_environment_status() | {"error": str(exc)})
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
