#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

find_python() {
    if command -v python3 >/dev/null 2>&1; then
        printf '%s\n' python3
        return 0
    fi
    if command -v python >/dev/null 2>&1; then
        printf '%s\n' python
        return 0
    fi
    return 1
}

PYTHON="$(find_python || true)"
if [ -z "$PYTHON" ]; then
    echo "[CC Bridge] 未检测到 Python 3.10+。"
    ASSUME_YES="${CCB_BOOTSTRAP_ASSUME_YES:-0}"
    if command -v brew >/dev/null 2>&1; then
        if [ "$ASSUME_YES" = "1" ]; then
            brew install python
        else
            printf '是否使用 brew 安装 Python？[y/N] '
            read ans
            case "$ans" in y|Y|yes|YES) brew install python ;; esac
        fi
    elif command -v apt >/dev/null 2>&1; then
        if [ "$ASSUME_YES" = "1" ]; then
            sudo apt update && sudo apt install -y python3 python3-venv
        else
            printf '是否使用 apt 安装 Python？[y/N] '
            read ans
            case "$ans" in y|Y|yes|YES) sudo apt update && sudo apt install -y python3 python3-venv ;; esac
        fi
    elif command -v dnf >/dev/null 2>&1; then
        if [ "$ASSUME_YES" = "1" ]; then
            sudo dnf install -y python3
        else
            printf '是否使用 dnf 安装 Python？[y/N] '
            read ans
            case "$ans" in y|Y|yes|YES) sudo dnf install -y python3 ;; esac
        fi
    elif command -v pacman >/dev/null 2>&1; then
        if [ "$ASSUME_YES" = "1" ]; then
            sudo pacman -S --needed python
        else
            printf '是否使用 pacman 安装 Python？[y/N] '
            read ans
            case "$ans" in y|Y|yes|YES) sudo pacman -S --needed python ;; esac
        fi
    fi
    PYTHON="$(find_python || true)"
    if [ -z "$PYTHON" ]; then
        echo "[ERROR] 请安装 Python 3.10 或更新版本后重试。"
        exit 1
    fi
fi

echo "[CC Bridge] 启动 bootstrap..."
exec "$PYTHON" -u bootstrap.py "$@"
