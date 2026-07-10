"""离线运行时压缩包的自动检测与解压。

在桌面端 bootstrap 阶段，若安装目录同级存在 `CC Bridge Runtime.zip`，
自动解压到 CCB_HOME，使离线机器无需联网即可复用预配置的 venv / npm-global。

设计要点：
- 按文件名触发，不做 hash 校验：检测到 `CC Bridge Runtime.zip` 即解压。
  zip 由用户单独制作并放到安装目录同级（与 `CC Bridge Runtime/` 同级）。
- zip 不存在：走正常在线/离线流程。
- 用 CCB_HOME/.unpacked_from 记录上次解压依据的 zip sha256（仅作 zip 是否变过的
  内部判重），命中则跳过，幂等。
- 任何异常只记日志、不抛出——自动解压是增强功能，不能在异常时阻断正常 bootstrap。
"""
from __future__ import annotations

import hashlib
import os
import zipfile
from pathlib import Path

from .state import CCB_HOME, log

# 触发自动解压的压缩包文件名（必须正好是这个名字）
RUNTIME_ZIP_NAME = "CC Bridge Runtime.zip"
# 解压幂等标记文件：内容 = 上次解压所依据的 zip sha256
_UNPACKED_MARKER = CCB_HOME / ".unpacked_from"


def _sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _locate_runtime_zip() -> Path | None:
    """定位 runtime zip。优先 CCB_HOME 的同级目录（安装目录同级），其次 CCB_HOME 自身。"""
    candidates = [
        CCB_HOME.parent / RUNTIME_ZIP_NAME,
        CCB_HOME / RUNTIME_ZIP_NAME,
    ]
    for c in candidates:
        if c.is_file():
            return c
    return None


def _extract_into(zip_path: Path, dest: Path) -> None:
    """解压 zip 到 dest，处理两种打包结构：

    A) zip 内直接是 venv/ npm-global/ ... → 直接解压到 dest
    B) zip 内有顶层目录（如 CC Bridge Runtime/）→ 把该目录内容解压到 dest
    """
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
    # 判断是否只有一个顶层目录（结构 B）
    tops = {n.split("/", 1)[0] for n in names if n}
    single_top = len(tops) == 1 and not next(iter(tops)).startswith(".")
    # 且该顶层目录下确实有内容（不是直接铺平的文件）
    top_name = next(iter(tops)) if single_top else None

    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        if top_name:
            # 结构 B：去掉顶层前缀后解压
            prefix = top_name + "/"
            for member in zf.infolist():
                if member.is_dir():
                    continue
                rel = member.filename
                if rel.startswith(prefix):
                    rel = rel[len(prefix):]
                elif rel == top_name:
                    continue
                if not rel:
                    continue
                target = dest / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as src, target.open("wb") as out:
                    out.write(src.read())
        else:
            # 结构 A：直接解压
            zf.extractall(dest)


def maybe_unpack_runtime() -> None:
    """检测同级 runtime zip，按文件名触发自动解压到 CCB_HOME。失败一律不抛异常。"""
    try:
        zip_path = _locate_runtime_zip()
        if not zip_path:
            # 用户没放包，走正常在线/离线流程
            return

        actual_sha = _sha256_of(zip_path)

        # 幂等：已依据同一 zip（sha256 未变）解压过则跳过
        try:
            if _UNPACKED_MARKER.exists() and _UNPACKED_MARKER.read_text(encoding="utf-8").strip() == actual_sha:
                log(f"运行时已从 {zip_path.name} 解压过且未变化，跳过")
                return
        except OSError:
            pass

        log(f"检测到运行时压缩包 {zip_path.name}，开始解压到 {CCB_HOME}")
        CCB_HOME.mkdir(parents=True, exist_ok=True)
        _extract_into(zip_path, CCB_HOME)
        _UNPACKED_MARKER.write_text(actual_sha, encoding="utf-8")
        log("运行时压缩包解压完成")
    except Exception as exc:
        # 自动解压是增强功能，任何异常都不能阻断 bootstrap
        log(f"运行时压缩包自动解压失败（已忽略）：{exc}")
