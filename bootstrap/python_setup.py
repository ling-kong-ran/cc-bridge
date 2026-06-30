"""Python 版本检查。"""
from __future__ import annotations

import sys


def ensure_python_version() -> None:
    if sys.version_info < (3, 10):
        raise RuntimeError(
            f"Python 版本过低：{sys.version.split()[0]}。请安装 Python 3.10 或更新版本。"
        )
