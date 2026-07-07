"""远程目标与远程文件相关服务。"""
import base64
import os
import shlex
import uuid
from pathlib import Path
from typing import Any

import remote_manager


def list_remote_targets() -> dict[str, Any]:
    """列出远程目标配置。"""
    return {
        "targets": remote_manager.list_targets(),
        "password_supported": remote_manager.password_supported(),
    }


def save_remote_target(data: dict[str, Any]) -> dict[str, Any]:
    """保存远程目标配置。"""
    return remote_manager.save_target(data)


def delete_remote_target(target_id: str) -> dict[str, bool]:
    """删除远程目标配置。"""
    remote_manager.delete_target(target_id)
    return {"ok": True}


def test_remote_target(data: dict[str, Any]) -> dict[str, Any]:
    """测试远程目标连接。"""
    target = data if data.get("host") else data.get("id", "")
    return remote_manager.test_target(target)


def remote_upload_dir(cwd: str = "") -> Path:
    """返回远程文件缓存目录。"""
    base = Path(cwd) if cwd and os.path.isdir(cwd) else Path(__file__).resolve().parents[2]
    upload_dir = base / ".gui-uploads" / "remote"
    upload_dir.mkdir(parents=True, exist_ok=True)
    return upload_dir


def shell_quote(value: str) -> str:
    """转义远程 shell 参数。"""
    return shlex.quote(str(value or ""))


def list_remote_files(target_id: str, path: str) -> dict[str, Any]:
    """列出远程目录文件。"""
    target = remote_manager.get_target(target_id or "")
    if not target:
        return {"ok": False, "error": "target_not_found"}
    remote_path = path or "."
    # 纯 shell 实现，不依赖远程 Python
    # 用 stat 逐个输出 type|size|name，兼容性好于 find -printf
    qpath = shell_quote(remote_path)
    command = (
        f"_D=$(cd {qpath} 2>/dev/null && pwd) || exit 1; "
        f"echo \"DIR:$_D\"; "
        f"for f in \"$_D\"/*; do "
        f"[ -e \"$f\" ] || continue; "
        f"_N=$(basename \"$f\"); "
        f"if [ -d \"$f\" ]; then _T=d; else _T=f; fi; "
        f"_S=$(stat -c%s \"$f\" 2>/dev/null || echo 0); "
        f"echo \"$_T|$_S|$_N\"; "
        f"done"
    )
    res = remote_manager.run_remote_command(target, command, timeout=30)
    if not res.get("ok"):
        return {"ok": False, "error": res.get("error") or res.get("stderr") or "remote_failed"}
    stdout = (res.get("stdout") or "").strip()
    lines = stdout.splitlines()
    if not lines:
        return {"ok": False, "error": "empty_response"}
    # 解析当前目录
    current = remote_path
    if lines[0].startswith("DIR:"):
        current = lines[0][4:]
        lines = lines[1:]
    parent = os.path.dirname(current) or "/"
    items = []
    for line in lines:
        parts = line.split("|", 2)
        if len(parts) < 3:
            continue
        ftype, size_str, name = parts
        if not name or name.startswith("."):
            continue
        typ = "dir" if ftype == "d" else "file"
        try:
            size = int(size_str)
        except ValueError:
            size = 0
        full = current.rstrip("/") + "/" + name
        items.append({"name": name, "path": full, "type": typ, "size": size})
    items.sort(key=lambda x: x["name"])
    return {"ok": True, "current": current, "parent": parent, "items": items}


def cache_remote_file(target_id: str, path: str, cwd: str = "") -> dict[str, Any]:
    """缓存远程文件到本地上传目录。"""
    target = remote_manager.get_target(target_id or "")
    if not target:
        return {"ok": False, "error": "target_not_found"}
    remote_path = path or ""
    if not remote_path:
        return {"ok": False, "error": "missing_path"}
    name = Path(remote_path).name or "remote-file"
    local_name = f"{uuid.uuid4().hex[:8]}_{name}"
    local_path = remote_upload_dir(cwd) / local_name
    command = "base64 " + shell_quote(remote_path)
    res = remote_manager.run_remote_command(target, command, timeout=120)
    if not res.get("ok"):
        return {"ok": False, "error": res.get("error") or res.get("stderr") or "remote_failed"}
    try:
        data = base64.b64decode((res.get("stdout") or "").encode("ascii"), validate=False)
    except (ValueError, UnicodeEncodeError) as exc:
        return {"ok": False, "error": f"decode_failed: {exc}"}
    local_path.write_bytes(data)
    return {
        "ok": True,
        "name": name,
        "path": str(local_path.resolve()).replace("\\", "/"),
        "source": "remote",
        "original_path": remote_path,
        "remote_target_name": target.get("name") or target.get("host") or target_id,
        "size": len(data),
    }
