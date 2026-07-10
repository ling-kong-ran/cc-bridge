#!/usr/bin/env python3
"""CC Bridge 跨平台 bootstrap 入口。"""
from __future__ import annotations

import argparse
import sys

from bootstrap.claude_setup import ensure_claude_cli
from bootstrap.launcher import launch_server
from bootstrap.node_setup import ensure_node
from bootstrap.probe import get_environment_status
from bootstrap.python_setup import ensure_python_version
from bootstrap.runtime_unpack import maybe_unpack_runtime
from bootstrap.state import emit_progress, log, write_state
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


def _run_step(step: str, title: str, func):
    """执行 bootstrap 步骤并输出桌面启动页可消费的状态。"""
    emit_progress(step, "running", title)
    try:
        result = func()
    except Exception as exc:
        emit_progress(step, "error", title, f"{title}失败", str(exc))
        raise
    emit_progress(step, "done", title)
    return result


def main() -> int:
    args = parse_args()
    try:
        emit_progress("start", "running", "启动 Bootstrap", "正在准备 CC Bridge 运行环境")
        _run_step("python", "检查 Python 版本", ensure_python_version)
        status = _run_step("environment", "检测本机环境", get_environment_status)
        write_state(status)
        if args.status:
            log("环境状态已写入 ~/.ccb/bootstrap_state.json")
            emit_progress("status", "done", "环境状态已写入", "仅检查模式完成")
            return 0

        # 离线分发：若安装目录同级有 `CC Bridge Runtime.zip`，先解压成 venv/npm-global，
        # 这样后续 venv/claude 检测能在离线机器直接命中。放在所有检测之前。
        _run_step("runtime", "准备运行时", maybe_unpack_runtime)
        python = _run_step("venv", "准备项目 Python 环境", find_server_python)
        _run_step("claude", "检查 Claude Code CLI", lambda: _ensure_claude_runtime(args.yes))
        write_state(get_environment_status())
        emit_progress("server", "running", "启动本地服务", "正在启动 server.py 并等待就绪")
        return launch_server(python, desktop=args.desktop)
    except KeyboardInterrupt:
        log("用户中断 bootstrap")
        emit_progress("cancelled", "error", "启动已中断", "用户中断 bootstrap")
        return 130
    except Exception as exc:
        log(f"bootstrap 失败：{exc}")
        emit_progress("failed", "error", "Bootstrap 失败", str(exc), str(exc))
        try:
            write_state(get_environment_status() | {"error": str(exc)})
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
