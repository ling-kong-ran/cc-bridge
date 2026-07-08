#!/usr/bin/env bash
set -euo pipefail

TARGET="installer"
RELEASE="0"
VERSION=""
SKIP_INSTALL="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    pack|installer)
      TARGET="$1"
      shift
      ;;
    --release)
      RELEASE="1"
      shift
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --skip-install)
      SKIP_INSTALL="1"
      shift
      ;;
    *)
      echo "用法: $0 [pack|installer] [--skip-install] [--release] [--version x.y.z]" >&2
      exit 2
      ;;
  esac
done

if [[ "$TARGET" != "pack" && "$TARGET" != "installer" ]]; then
  echo "用法: $0 [pack|installer] [--skip-install] [--release] [--version x.y.z]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

step() {
  echo "[CC Bridge] $1"
}

step "检查 Node/npm 环境"
command -v node >/dev/null
command -v npm >/dev/null

if [[ "$RELEASE" == "1" ]]; then
  step "检查 GitHub CLI 环境"
  command -v gh >/dev/null
  gh auth status
fi

step "检查桌面端 Python 入口语法"
python -m py_compile server.py bootstrap.py ccb_bridge.py bootstrap/*.py

if [[ "$SKIP_INSTALL" != "1" ]]; then
  if [[ -f package-lock.json ]]; then
    step "安装 npm 依赖（npm ci）"
    npm ci
  else
    step "安装 npm 依赖（npm install）"
    npm install
  fi
fi

if [[ "$RELEASE" == "1" ]]; then
  if [[ "$TARGET" == "pack" ]]; then
    echo "Release requires installer target." >&2
    exit 2
  fi

  if [[ -z "$VERSION" ]]; then
    CURRENT_VERSION="$(node -p "require('./package.json').version")"
    IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
    VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
  fi

  step "设置 package version 为 $VERSION"
  npm version "$VERSION" --no-git-tag-version
fi

if [[ "$TARGET" == "pack" ]]; then
  step "打包免安装目录版本"
  npm run desktop:pack
else
  step "打包当前平台安装程序"
  npm run desktop:dist
fi

if [[ "$RELEASE" == "1" ]]; then
  TAG="v$VERSION"
  PLATFORM="$(node -p "process.platform === 'win32' ? 'win' : process.platform")"
  ARCH="$(node -p "process.arch === 'x64' ? 'x64' : process.arch")"
  INSTALLER="release/CC-Bridge-$VERSION-$PLATFORM-$ARCH.exe"
  LATEST_YML="release/latest.yml"
  BLOCKMAP="$INSTALLER.blockmap"

  if [[ ! -f "$INSTALLER" ]]; then
    echo "Installer not found: $INSTALLER" >&2
    exit 1
  fi
  if [[ ! -f "$LATEST_YML" ]]; then
    echo "Update metadata not found: $LATEST_YML" >&2
    exit 1
  fi

  ASSETS=("$INSTALLER" "$LATEST_YML")
  if [[ -f "$BLOCKMAP" ]]; then
    ASSETS+=("$BLOCKMAP")
  fi

  step "创建或更新 GitHub Release $TAG"
  if gh release view "$TAG" >/dev/null 2>&1; then
    gh release upload "$TAG" "${ASSETS[@]}" --clobber
  else
    gh release create "$TAG" "${ASSETS[@]}" --title "CC Bridge $VERSION" --notes "CC Bridge desktop release $VERSION"
  fi
fi

step "打包完成，输出目录：$REPO_ROOT/release"
