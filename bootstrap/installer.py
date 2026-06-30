"""安装命令调度工具。"""
from __future__ import annotations

import os
import subprocess
from collections.abc import Sequence

from .state import log


def assume_yes(explicit_yes: bool = False) -> bool:
    return explicit_yes or os.environ.get("CCB_BOOTSTRAP_ASSUME_YES") == "1"


def confirm(prompt: str, yes: bool = False) -> bool:
    if assume_yes(yes):
        return True
    answer = input(f"{prompt} [y/N] ").strip().lower()
    return answer in {"y", "yes"}


def run(cmd: Sequence[str], env: dict[str, str] | None = None) -> None:
    log("执行：" + " ".join(cmd))
    subprocess.run(list(cmd), env=env, check=True)
