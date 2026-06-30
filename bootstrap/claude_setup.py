"""Claude Code CLI 检测与安装。"""
from __future__ import annotations

import shutil

from .installer import confirm, run
from .probe import NPM_PREFIX, detect_cli, path_with_controlled_npm
from .state import log

PACKAGE_NAME = "@anthropic-ai/claude-code"


def ensure_claude_cli(yes: bool = False) -> None:
    """确保 ccb 或 claude CLI 可用；缺失时安装 Claude Code CLI 到受控 npm prefix。"""
    cli_status = detect_cli()
    if cli_status.get("selected"):
        selected = cli_status["selected"]
        log(f"已找到 CLI：{selected['name']} -> {selected['path']}")
        return

    if not shutil.which("npm"):
        raise RuntimeError("安装 Claude Code CLI 需要 npm，请先安装 Node/npm。")

    if not confirm(f"未检测到 ccb/claude CLI，是否安装 {PACKAGE_NAME} 到 {NPM_PREFIX}？", yes):
        raise RuntimeError("用户取消安装 Claude Code CLI。")

    NPM_PREFIX.mkdir(parents=True, exist_ok=True)
    run(["npm", "install", "--prefix", str(NPM_PREFIX), PACKAGE_NAME])

    refreshed = detect_cli()
    if not refreshed.get("selected"):
        raise RuntimeError("Claude Code CLI 安装后仍未检测到 claude 可执行文件，请检查 npm 输出。")
    selected = refreshed["selected"]
    log(f"Claude Code CLI 已可用：{selected['path']}")


def server_env() -> dict[str, str]:
    """返回启动 server.py 使用的环境变量。"""
    return path_with_controlled_npm()
