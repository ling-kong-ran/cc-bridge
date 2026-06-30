"""Node/npm 检测与安装提示。"""
from __future__ import annotations

import os
import platform
import shutil

from .installer import confirm, run
from .state import log


def _install_command() -> list[str] | None:
    system = platform.system().lower()
    if system == "windows" and shutil.which("winget"):
        return ["winget", "install", "--id", "OpenJS.NodeJS.LTS", "-e"]
    if system == "darwin" and shutil.which("brew"):
        return ["brew", "install", "node"]
    if system == "linux":
        if shutil.which("apt"):
            return ["sudo", "apt", "install", "-y", "nodejs", "npm"]
        if shutil.which("dnf"):
            return ["sudo", "dnf", "install", "-y", "nodejs", "npm"]
        if shutil.which("pacman"):
            return ["sudo", "pacman", "-S", "--needed", "nodejs", "npm"]
    return None


def ensure_node(yes: bool = False) -> None:
    """确保 node 与 npm 可用。"""
    if shutil.which("node") and shutil.which("npm"):
        log("Node/npm 已可用")
        return

    cmd = _install_command()
    if not cmd:
        raise RuntimeError("未检测到 Node/npm，也找不到可用的系统安装器。请手动安装 Node.js LTS 后重试。")

    if not confirm("未检测到 Node/npm，是否使用系统包管理器安装 Node.js LTS？", yes):
        raise RuntimeError("用户取消安装 Node/npm。请手动安装 Node.js LTS 后重试。")

    run(cmd)
    if not shutil.which("node") or not shutil.which("npm"):
        raise RuntimeError("Node/npm 安装后仍不可用，请重新打开终端或手动检查 PATH。")
    log("Node/npm 安装完成")
