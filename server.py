"""
CC Bridge Server - 纯 Python 标准库实现
HTTP 静态文件 + REST API + SSE (Server-Sent Events) 通信
使用 SSE 替代 WebSocket 避免 Windows asyncio 兼容性问题
"""
import asyncio
import json
import os
import sys
import socket
import uuid
import ipaddress
import re
import base64
import subprocess
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlparse, parse_qs, quote

sys.path.insert(0, str(Path(__file__).parent))

from ccb_bridge import SessionManager, discover_slash_commands, get_available_clis, get_current_cli, set_current_cli, refresh_clis
from config_manager import (
    get_settings,
    save_settings,
    get_env_config,
    update_env_config,
    get_gui_settings,
    update_gui_settings,
    get_env_profiles,
    save_env_profile,
    delete_env_profile,
    list_skills,
    get_skill,
    delete_skill,
    list_agents,
    get_available_models,
    list_mcp_servers,
    save_mcp_server,
    create_agent,
    update_agent,
    delete_agent,
    get_agent,
    get_agents_for_cli,
)
from session_store import list_sessions, save_session, add_session_usage, delete_session, load_session_history, rename_session, update_session_cwd, toggle_pin
from artifact_store import list_artifacts as list_artifact_records
from memory_index import list_memory_files, search_memory, get_memory_file, delete_memory_file, save_memory_file, index_memory, get_memory_tree, get_memory_graph
from feishu_gateway import FeishuGateway, FEISHU_GATEWAY_AVAILABLE, FEISHU_GATEWAY_UNAVAILABLE_REASON
from feishu_gateway_store import get_feishu_gateway_config, update_feishu_gateway_config, list_scopes as list_feishu_scopes
import remote_manager
import scheduled_task_store
from scheduled_task_runner import ScheduledTaskRunner

STATIC_DIR = Path(__file__).parent / "static"
DEFAULT_CWD = str(Path(__file__).parent.resolve())  # 项目根目录作为默认 CWD
HOST = "0.0.0.0"  # 监听所有网卡，允许局域网设备访问
BROWSER_HOST = "127.0.0.1"
DEFAULT_PORT = 17878
MAX_REQUEST_BODY_BYTES = 100 * 1024 * 1024
APP_ROOT = Path(__file__).parent.resolve()
SERVER_FILE = Path(__file__).resolve()
APP_PORT_SCAN_LIMIT = 50
APP_HTTP_MARKERS = ("CC Bridge", "Claude Code Bridge", "/static/style.css", "ccb-theme")


def _get_listening_pids(port: int) -> set[int]:
    """返回占用指定端口的监听进程 PID。"""
    try:
        output = subprocess.check_output(
            ["netstat", "-ano"],
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return set()

    pids = set()
    port_suffix = f":{port}"
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP":
            continue
        local_addr = parts[1]
        state = parts[3].upper()
        if state != "LISTENING":
            continue
        try:
            host, port_text = local_addr.rsplit(":", 1)
        except ValueError:
            continue
        if f":{port_text}" != port_suffix:
            continue
        # 只清理本机监听，避免极端情况下误读转发/远端地址。
        if host not in {"0.0.0.0", "127.0.0.1", "[::]", "::", "[::1]", "::1"}:
            continue
        try:
            pids.add(int(parts[-1]))
        except ValueError:
            pass
    return pids


def _process_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            return str(pid) in result.stdout
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _wait_process_exit(pid: int, timeout: float = 3.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _process_exists(pid):
            return True
        time.sleep(0.1)
    return not _process_exists(pid)


def _get_process_command_line(pid: int) -> str:
    if os.name == "nt":
        ps_script = (
            f"$p = Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\"; "
            "if ($p) { [Console]::Out.Write(($p.CommandLine + [char]31 + $p.ExecutablePath + [char]31 + $p.CurrentDirectory)) }"
        )
        try:
            output = subprocess.check_output(
                ["powershell", "-NoProfile", "-Command", ps_script],
                text=True,
                encoding="utf-8",
                errors="replace",
                stderr=subprocess.DEVNULL,
            )
            return output.strip()
        except (OSError, subprocess.SubprocessError):
            return ""
    try:
        cmdline = Path(f"/proc/{pid}/cmdline").read_text(encoding="utf-8", errors="replace").replace("\0", " ").strip()
        cwd = ""
        try:
            cwd = str(Path(f"/proc/{pid}/cwd").resolve())
        except OSError:
            pass
        return f"{cmdline}\x1f{cwd}"
    except OSError:
        return ""


def _is_current_app_http(port: int) -> bool:
    """当 Windows 拿不到 CurrentDirectory 时，用 HTTP 首页指纹兜底识别旧 GUI。"""
    try:
        req = Request(f"http://127.0.0.1:{port}/", headers={"User-Agent": "CCB-cleanup"})
        with urlopen(req, timeout=0.5) as resp:
            body = resp.read(4096).decode("utf-8", errors="replace")
    except Exception:
        return False
    return any(marker in body for marker in APP_HTTP_MARKERS)


def _is_current_app_process(pid: int, port: int | None = None) -> bool:
    """只识别当前项目启动的 server.py，避免误杀其他占用端口的服务。"""
    if pid == os.getpid():
        return False
    proc_info = _get_process_command_line(pid)
    normalized = proc_info.replace("\\", "/").lower()
    server_path = str(SERVER_FILE).replace("\\", "/").lower()
    app_root = str(APP_ROOT).replace("\\", "/").lower().rstrip("/")
    if normalized and (
        server_path in normalized
        or f"{app_root}/server.py" in normalized
        or ("server.py" in normalized and app_root in normalized)
    ):
        return True
    # start.bat 启动的 Python 进程在某些 Windows 环境里拿不到 CurrentDirectory，
    # 命令行只剩 python -u server.py；这种情况下只在默认端口扫描范围内用首页指纹兜底。
    if port is not None and DEFAULT_PORT <= port < DEFAULT_PORT + APP_PORT_SCAN_LIMIT:
        if "server.py" in normalized and _is_current_app_http(port):
            return True
    return False


def _kill_process_tree(pid: int) -> bool:
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            os.kill(pid, 15)
        return _wait_process_exit(pid)
    except OSError:
        return False


def cleanup_existing_app_servers(start_port: int = DEFAULT_PORT, max_ports: int = APP_PORT_SCAN_LIMIT):
    """启动前清理当前应用遗留的旧服务；非本应用占用端口时保留并继续自增。"""
    killed = set()
    for port in range(start_port, min(65536, start_port + max_ports)):
        for pid in _get_listening_pids(port):
            if pid in killed or not _is_current_app_process(pid, port):
                continue
            if _kill_process_tree(pid):
                killed.add(pid)
                print(f"[CC Bridge] Stopped old server process PID {pid} on port {port}")
            else:
                print(f"[CC Bridge] Failed to stop old server process PID {pid} on port {port}")
    return killed


def get_lan_ips() -> list[str]:
    """获取本机局域网 IPv4 地址，用于提示手机访问地址。"""
    ips = []
    try:
        hostname = socket.gethostname()
        for item in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = item[4][0]
            if ip.startswith("127.") or ip in ips:
                continue
            ips.append(ip)
    except OSError:
        pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
            if not ip.startswith("127.") and ip not in ips:
                ips.insert(0, ip)
    except OSError:
        pass

    return ips


def is_localhost_ip(ip: str) -> bool:
    """判断请求来源是否为本机地址。"""
    try:
        return ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return False


def lan_access_enabled() -> bool:
    """读取是否允许非 localhost 访问。"""
    return bool(get_gui_settings().get("lan_access_enabled", True))


def get_client_ip(writer: asyncio.StreamWriter) -> str:
    peer = writer.get_extra_info("peername")
    if isinstance(peer, tuple) and peer:
        return str(peer[0])
    return ""


def get_access_context(writer: asyncio.StreamWriter) -> dict:
    client_ip = get_client_ip(writer)
    return {
        "client_ip": client_ip,
        "is_localhost": is_localhost_ip(client_ip),
        "lan_access_enabled": lan_access_enabled(),
    }


def is_request_allowed(writer: asyncio.StreamWriter) -> bool:
    context = get_access_context(writer)
    return context["is_localhost"] or context["lan_access_enabled"]


def is_client_allowed(client_id: str) -> bool:
    ip = client_ips.get(client_id, "")
    return is_localhost_ip(ip) or lan_access_enabled()


def bind_client_ip(client_id: str, writer: asyncio.StreamWriter) -> bool:
    """把 client_id 绑定到首次连接来源，避免复用 client_id 绕过本地 CLI 权限。"""
    ip = get_client_ip(writer)
    if not client_id or not ip:
        return False
    bound_ip = client_ips.get(client_id)
    if bound_ip and bound_ip != ip:
        return False
    client_ips[client_id] = ip
    return True


def is_cli_access_allowed(client_id: str, writer: asyncio.StreamWriter) -> bool:
    if not bind_client_ip(client_id, writer):
        return False
    return is_client_allowed(client_id)


async def reject_client_access(client_id: str, writer: asyncio.StreamWriter):
    """拒绝已越权的客户端，并确保无法继续驱动本地 CLI。"""
    session = session_manager.get_session(client_id)
    if session:
        await session.stop()
        await session_manager.remove_session(client_id)
    client_meta.pop(client_id, None)
    client_last_msg.pop(client_id, None)
    client_session_ids.pop(client_id, None)
    client_session_agents.pop(client_id, None)
    client_ips.pop(client_id, None)
    # 清理会话共享状态
    owned_sid = {sid for sid, oid in session_owner.items() if oid == client_id}
    for sid in owned_sid:
        session_owner.pop(sid, None)
    client_viewing.pop(client_id, None)
    await send_response(writer, 403, "application/json", b'{"ok":false,"error":"LAN access disabled"}')


async def revoke_lan_clients():
    """关闭所有非 localhost 客户端的本地 CLI 会话。"""
    for client_id, ip in list(client_ips.items()):
        if is_localhost_ip(ip):
            continue
        session = get_current_session(client_id)
        if session:
            await session.stop()
            await session_manager.remove_session(client_id)
        client_meta.pop(client_id, None)
        client_last_msg.pop(client_id, None)
        client_session_ids.pop(client_id, None)
        client_session_agents.pop(client_id, None)
        owned_sid = {sid for sid, oid in session_owner.items() if oid == client_id}
        for sid in owned_sid:
            session_owner.pop(sid, None)
        client_viewing.pop(client_id, None)
        await push_event(client_id, "error", {"message": "LAN access disabled"})
        await push_event(client_id, "session_stopped", {})

session_manager = SessionManager()

# SSE 客户端连接池: client_id -> asyncio.Queue
sse_clients: dict[str, asyncio.Queue] = {}

# 每个 client 的最后一条用户消息（用于会话标题）
client_last_msg: dict[str, str] = {}

# 每个 client 关联的 ccb session id
client_session_ids: dict[str, str] = {}

# 每个 client 的会话参数（model, cwd）
client_meta: dict[str, dict] = {}

# 每个 client 的来源 IP，用于局域网访问开关生效后收紧已有连接
client_ips: dict[str, str] = {}

# 每个 client 的会话 agent 列表（右面板拉入的 agent）
client_session_agents: dict[str, list] = {}

# 定时任务后台 runner
scheduled_runner: ScheduledTaskRunner | None = None

# 飞书消息网关
feishu_gateway: FeishuGateway | None = None

# 会话共享：记录哪个 client_id 拥有哪个 session_id（owner），以及谁是 viewer
session_owner: dict[str, str] = {}  # session_id → owner_client_id
client_viewing: dict[str, str] = {}  # viewer_client_id → owner_client_id
session_locks: dict[str, dict] = {}  # session_id → {holder_id, locked, started_at}
session_run_ids: dict[str, str] = {}  # session_id → run_id


def get_session_subscribers(session_id: str) -> list[str]:
    """返回正在查看同一会话的所有 client。"""
    owner_id = session_owner.get(session_id, "")
    subscribers = []
    if owner_id:
        subscribers.append(owner_id)
    for viewer_id, viewing_owner in list(client_viewing.items()):
        if viewing_owner == owner_id and viewer_id not in subscribers:
            subscribers.append(viewer_id)
    return subscribers


async def broadcast_session_lock(session_id: str, locked: bool, holder_id: str = ""):
    """广播会话占用状态；锁释放后观察者即可接管发送。"""
    if not session_id:
        return
    if locked:
        session_locks[session_id] = {
            "holder_id": holder_id,
            "locked": True,
            "started_at": asyncio.get_event_loop().time(),
        }
    else:
        holder_id = session_locks.get(session_id, {}).get("holder_id", holder_id)
        session_locks.pop(session_id, None)

    for target_id in get_session_subscribers(session_id):
        await push_event(target_id, "session_lock_changed", {
            "session_id": session_id,
            "locked": locked,
            "holder_id": holder_id,
            "is_holder": target_id == holder_id,
        })


async def release_session_lock_for_session(session_id: str, holder_id: str = ""):
    if session_id and session_locks.get(session_id, {}).get("holder_id") == holder_id:
        await broadcast_session_lock(session_id, False, holder_id)


async def release_session_lock_for_client(client_id: str):
    sid = client_session_ids.get(client_id, "")
    await release_session_lock_for_session(sid, client_id)


async def push_current_session_lock(client_id: str, session_id: str):
    """把当前会话锁状态同步给刚连接/刚切换的客户端。"""
    lock = session_locks.get(session_id, {}) if session_id else {}
    if lock.get("locked"):
        holder_id = lock.get("holder_id", "")
        await push_event(client_id, "session_lock_changed", {
            "session_id": session_id,
            "locked": True,
            "holder_id": holder_id,
            "is_holder": client_id == holder_id,
        })


def is_session_locked_by_other(session_id: str, client_id: str) -> bool:
    lock = session_locks.get(session_id, {})
    return bool(lock.get("locked") and lock.get("holder_id") != client_id)


def build_generation_state(session) -> dict:
    """读取正在生成中的会话状态，供刷新/重连恢复真实耗时。"""
    if not session:
        return {}
    getter = getattr(session, "current_generation_state", None)
    if not getter:
        return {}
    try:
        state = getter()
    except Exception:
        return {}
    if state.get("running") and getattr(session, "session_id", None):
        state.setdefault("session_id", session.session_id)
        run_id = session_run_ids.get(session.session_id, "")
        if run_id:
            state.setdefault("run_id", run_id)
    return state if state.get("running") else {}


def get_current_session(client_id: str):
    sid = client_session_ids.get(client_id, "")
    if sid:
        run_session = session_manager.get_session_by_native_id(sid)
        if run_session:
            return run_session
    return session_manager.get_session(client_id)


def get_owned_session(owner_id: str, session_id: str = ""):
    if session_id:
        run_session = session_manager.get_session_by_native_id(session_id)
        if run_session:
            return run_session
    return session_manager.get_session(owner_id)


async def push_generation_started(client_id: str, session):
    state = build_generation_state(session)
    if state:
        await push_event(client_id, "generation_started", state)


async def broadcast_user_message(session_id: str, content: str, sender_id: str = ""):
    """把手动发送/补充发送的用户消息同步给同一会话的其他端。"""
    for target_id in get_session_subscribers(session_id):
        if target_id != sender_id:
            await push_event(target_id, "user_message", {"session_id": session_id, "content": content})


async def forward_viewer_event(viewer_id: str, event: dict, fallback_session_id: str = ""):
    """把 owner 会话事件转发给观察者，并保持与 owner 前端事件形态一致。"""
    evt_type = event.get("type", "unknown")
    sid = event.get("session_id") or fallback_session_id or client_session_ids.get(viewer_id, "")
    if sid and "session_id" not in event:
        event = dict(event)
        event["session_id"] = sid
    run_id = event.get("run_id") or (session_run_ids.get(sid, "") if sid else "")
    if run_id and "run_id" not in event:
        event = dict(event)
        event["run_id"] = run_id
    if evt_type == "session_id_captured":
        client_session_ids[viewer_id] = sid
        await push_event(viewer_id, "session_id_captured", event)
    elif evt_type == "user":
        results = extract_tool_results(event)
        if results:
            await push_event(viewer_id, "tool_result", {
                "session_id": sid,
                "run_id": run_id,
                "results": results,
                "parent_tool_use_id": event.get("parent_tool_use_id"),
            })
    elif evt_type == "result":
        await push_event(viewer_id, evt_type, attach_session_total_cost(sid, event))
    elif evt_type in ("assistant", "stream_event", "system", "error",
                      "process_ended", "model_changed", "tool_result",
                      "session_stopped"):
        await push_event(viewer_id, evt_type, event)


def attach_viewers_to_session(owner_id: str, session_id: str, session):
    """把当前订阅同一会话的观察者挂到本轮运行，确保流式事件继续广播。"""
    if not session_id or not session:
        return
    for viewer_id in get_session_subscribers(session_id):
        if viewer_id == owner_id:
            continue
        client_viewing[viewer_id] = owner_id
        client_session_ids[viewer_id] = session_id

        async def on_viewer_event(event: dict, target_id: str = viewer_id):
            await forward_viewer_event(target_id, event, session_id)

        session.add_viewer(viewer_id, on_viewer_event)


def extract_result_tokens(event: dict) -> dict:
    """从 result 事件中提取本轮 token 用量。"""
    usage = event.get("usage") if isinstance(event.get("usage"), dict) else {}

    def read_int(*keys: str) -> int:
        for key in keys:
            value = usage.get(key)
            if value is None:
                value = event.get(key)
            try:
                number = int(value or 0)
            except (TypeError, ValueError):
                number = 0
            if number > 0:
                return number
        return 0

    return {
        "input": read_int("input_tokens"),
        "output": read_int("output_tokens"),
        "cache_creation": read_int("cache_creation_input_tokens", "cache_creation_tokens"),
        "cache_read": read_int("cache_read_input_tokens", "cache_read_tokens"),
    }


def attach_session_total_cost(session_id: str, event: dict) -> dict:
    """给转发给观察者的 result 附加已有会话累计费用，避免重复累加。"""
    if not session_id:
        return event
    updated = dict(event)
    try:
        from session_store import get_session
        stored = get_session(session_id) or {}
    except Exception:
        stored = {}
    total_cost = float(stored.get("total_cost_usd") or 0)
    total_tokens = stored.get("total_tokens") or {}
    if total_cost > 0:
        updated["session_total_cost_usd"] = total_cost
    if isinstance(total_tokens, dict) and any(total_tokens.values()):
        updated["session_total_tokens"] = total_tokens
    return updated


def persist_result_usage(client_id: str, event: dict) -> dict:
    """把单轮 result 费用和 token 用量累加到当前会话，并把累计值附加给前端。"""
    try:
        turn_cost = float(event.get("total_cost_usd") or 0)
    except (TypeError, ValueError):
        turn_cost = 0
    turn_tokens = extract_result_tokens(event)

    sid = event.get("session_id") or client_session_ids.get(client_id)
    if not sid:
        return event

    updated = dict(event)
    if turn_cost > 0 or any(turn_tokens.values()):
        totals = add_session_usage(sid, turn_cost, turn_tokens)
        total_cost = float(totals.get("total_cost_usd") or 0)
        total_tokens = totals.get("total_tokens") or {}
        if total_cost > 0:
            updated["session_total_cost_usd"] = total_cost
        if any(total_tokens.values()):
            updated["session_total_tokens"] = total_tokens
        if any(turn_tokens.values()):
            updated["turn_tokens"] = turn_tokens

    return updated


def extract_tool_results(event: dict) -> list[dict]:
    """从 user 事件中提取 tool_result 块，返回 {tool_use_id, content, is_error} 列表。"""
    msg = event.get("message") or {}
    content = msg.get("content")
    results = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("tool_use_id"):
                result_content = block.get("content", "")
                # 截断过长内容
                if isinstance(result_content, str) and len(result_content) > 8000:
                    result_content = result_content[:8000] + "\n... (truncated)"
                elif isinstance(result_content, list) and len(result_content) > 0:
                    # content 可能是 [{type:"text", text:"..."}] 格式
                    texts = []
                    for item in result_content:
                        if isinstance(item, dict) and item.get("type") == "text":
                            texts.append(item.get("text", ""))
                    result_content = "\n".join(texts)
                    if len(result_content) > 8000:
                        result_content = result_content[:8000] + "\n... (truncated)"
                elif not isinstance(result_content, str):
                    result_content = json.dumps(result_content, ensure_ascii=False)[:8000]
                results.append({
                    "tool_use_id": block["tool_use_id"],
                    "content": result_content,
                    "is_error": bool(block.get("is_error")),
                })
    return results


def artifact_href(value: str) -> str:
    if re.match(r"^https?://", value, re.I):
        return value
    fp = is_allowed_upload_path(value)
    if fp and fp.exists():
        return "/api/file?path=" + quote(str(fp).replace("\\", "/"), safe="")
    return ""


def get_default_model() -> str:
    models = get_available_models()
    return models[0] if models else "claude-sonnet-4-6"


def get_feishu_gateway() -> FeishuGateway:
    global feishu_gateway
    if feishu_gateway is None:
        feishu_gateway = FeishuGateway(session_manager, DEFAULT_CWD, get_default_model)
    return feishu_gateway


def format_slash_commands(discovered: dict) -> dict:
    """Build frontend command items from CLI-discovered slash command names."""
    local_skills = {item.get("name"): item for item in list_skills() if item.get("name")}
    cli_skills = set(discovered.get("skills") or [])
    commands = []
    seen = set()

    for raw_name in discovered.get("slash_commands") or []:
        if not raw_name:
            continue
        name = str(raw_name).strip()
        if not name:
            continue
        display_name = name if name.startswith("/") else f"/{name}"
        if display_name in seen:
            continue
        seen.add(display_name)

        skill_name = name[1:] if name.startswith("/") else name
        skill = local_skills.get(skill_name)
        source = "skill" if skill_name in cli_skills or skill else "cli"
        description = ""
        if skill:
            description = skill.get("description") or "运行该技能"
        elif source == "skill":
            description = "运行该技能"
        else:
            description = "CLI 动态命令"

        commands.append({
            "name": display_name,
            "description": description,
            "source": source,
        })

    return {
        "commands": sorted(commands, key=lambda item: item["name"].lower()),
        "model": discovered.get("model") or "",
        "version": discovered.get("version") or "",
        "error": discovered.get("error"),
    }

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
}


# ─── 审查 (Git Review) ──────────────────────────────────────
def git_review(cwd: str) -> dict:
    """返回工作目录的 git 状态概览，用于右侧审查面板。"""
    if not cwd or not os.path.isdir(cwd):
        return {"error": "工作目录不存在"}

    # 检查是否 git 仓库
    if not os.path.isdir(os.path.join(cwd, ".git")):
        return {"git": False, "message": "当前目录不是 Git 仓库"}

    def _git(args):
        try:
            r = subprocess.run(
                ["git"] + args, cwd=cwd,
                capture_output=True, text=True, timeout=8,
                creationflags=0x08000000 if sys.platform == "win32" else 0
            )
            return r.stdout.strip() if r.returncode == 0 else ""
        except Exception:
            return ""

    def _status_label(code):
        return "modified" if code == "M" else \
               "added" if code == "A" else \
               "deleted" if code == "D" else \
               "renamed" if code == "R" else \
               "untracked" if code == "?" else "changed"

    # git status --porcelain
    raw = _git(["status", "--porcelain"])
    files = []
    staged_files = []
    unstaged_files = []
    if raw:
        for line in raw.split("\n"):
            if not line:
                continue
            index_status = line[0]
            worktree_status = line[1]
            fn = line[3:].strip()
            normalized = fn.replace("\\", "/")
            if index_status == "?" and worktree_status == "?":
                item = {"status": "untracked", "file": normalized, "raw": "??"}
                files.append(item)
                unstaged_files.append(item)
                continue
            status = _status_label(index_status if index_status != " " else worktree_status)
            item = {"status": status, "file": normalized, "raw": line[:2].strip()}
            files.append(item)
            if index_status != " ":
                staged_files.append({"status": _status_label(index_status), "file": normalized, "raw": index_status})
            if worktree_status != " ":
                unstaged_files.append({"status": _status_label(worktree_status), "file": normalized, "raw": worktree_status})

    # git diff --stat 获取变更统计
    stat_output = _git(["diff", "--stat", "HEAD"])
    # git branch
    branch = _git(["branch", "--show-current"]) or _git(["rev-parse", "--abbrev-ref", "HEAD"])

    # 暂存区统计
    staged = _git(["diff", "--cached", "--stat", "HEAD"])
    unstaged = _git(["diff", "--stat"])

    return {
        "git": True,
        "branch": branch or "unknown",
        "files": files,
        "stagedFiles": staged_files,
        "unstagedFiles": unstaged_files,
        "stat": stat_output,
        "stagedStat": staged,
        "unstagedStat": unstaged,
        "totalChanges": len(files),
    }


# ─── 文件+目录浏览 ──────────────────────────────────────────
def browse_files(path: str) -> dict:
    """列出指定目录下的子目录和文件（用于附件选择器）"""
    import string

    if not path or path == "/":
        if sys.platform == "win32":
            drives = []
            for letter in string.ascii_uppercase:
                drive = f"{letter}:/"
                if os.path.isdir(drive):
                    drives.append({"name": f"{letter}:/", "path": drive, "type": "drive"})
            return {"current": "/", "parent": None, "items": drives}
        else:
            path = "/"

    path = os.path.normpath(path)
    if not os.path.isdir(path):
        return {"current": path, "parent": None, "items": [], "error": "路径不存在"}

    parent = os.path.dirname(path)
    if parent == path:
        parent = "/"

    items = []
    try:
        for entry in sorted(os.listdir(path)):
            full = os.path.join(path, entry)
            if entry.startswith('.'):
                continue
            if os.path.isdir(full):
                if entry in ('node_modules', '__pycache__', '.git', 'venv', '.venv'):
                    continue
                items.append({"name": entry, "path": full.replace("\\", "/"), "type": "dir"})
            elif os.path.isfile(full):
                items.append({"name": entry, "path": full.replace("\\", "/"), "type": "file"})
    except PermissionError:
        return {"current": path, "parent": parent, "items": [], "error": "无权限访问"}

    return {
        "current": path.replace("\\", "/"),
        "parent": parent.replace("\\", "/") if parent != "/" else "/",
        "items": items,
    }


def search_files(path: str, query: str, max_results: int = 200) -> dict:
    """在指定目录及其子目录中搜索文件（用于附件选择器搜索）。"""
    query = (query or "").strip().lower()
    if not query:
        return browse_files(path)

    if not path or path == "/":
        if sys.platform == "win32":
            return {"current": "/", "parent": None, "items": [], "error": "请先选择一个具体目录后再搜索"}
        path = "/"

    path = os.path.normpath(path)
    if not os.path.isdir(path):
        return {"current": path, "parent": None, "items": [], "error": "路径不存在"}

    excluded_dirs = {'node_modules', '__pycache__', '.git', 'venv', '.venv'}
    items = []

    try:
        for root, dirs, files in os.walk(path):
            dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in excluded_dirs)

            for dirname in list(dirs):
                full = os.path.join(root, dirname)
                rel = os.path.relpath(full, path).replace("\\", "/")
                if query in dirname.lower() or query in rel.lower():
                    items.append({
                        "name": dirname,
                        "display": rel,
                        "path": full.replace("\\", "/"),
                        "type": "dir",
                    })
                    if len(items) >= max_results:
                        return {
                            "current": path.replace("\\", "/"),
                            "parent": os.path.dirname(path).replace("\\", "/"),
                            "items": items,
                            "truncated": True,
                        }

            for filename in sorted(files):
                if filename.startswith('.'):
                    continue
                full = os.path.join(root, filename)
                rel = os.path.relpath(full, path).replace("\\", "/")
                if query not in filename.lower() and query not in rel.lower():
                    continue
                items.append({
                    "name": filename,
                    "display": rel,
                    "path": full.replace("\\", "/"),
                    "type": "file",
                })
                if len(items) >= max_results:
                    return {
                        "current": path.replace("\\", "/"),
                        "parent": os.path.dirname(path).replace("\\", "/"),
                        "items": items,
                        "truncated": True,
                    }
    except PermissionError:
        return {"current": path.replace("\\", "/"), "parent": None, "items": [], "error": "无权限访问"}

    items.sort(key=lambda item: (item["type"] != "dir", item.get("display", item["name"]).lower()))
    return {
        "current": path.replace("\\", "/"),
        "parent": os.path.dirname(path).replace("\\", "/"),
        "items": items,
        "truncated": False,
    }


TEXT_PREVIEW_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".py", ".js", ".ts", ".tsx", ".jsx", ".json",
    ".css", ".html", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg",
    ".env", ".gitignore", ".dockerignore", ".sh", ".bat", ".ps1", ".sql", ".log",
}
TEXT_PREVIEW_MAX_BYTES = 512 * 1024


def preview_text_file(path: str, cwd: str = "") -> dict:
    """读取工作目录内的文本文件预览内容。"""
    if not path:
        return {"ok": False, "error": "missing_path"}

    root_value = cwd or DEFAULT_CWD
    if not root_value or not os.path.isdir(root_value):
        return {"ok": False, "error": "cwd_not_found"}

    try:
        root = Path(root_value).resolve()
        fp = Path(path).resolve()
    except OSError as exc:
        return {"ok": False, "error": str(exc)}

    if fp != root and root not in fp.parents:
        return {"ok": False, "error": "forbidden"}
    if not fp.exists() or not fp.is_file():
        return {"ok": False, "error": "not_found"}
    if any(part in (".git", "node_modules", "__pycache__", "venv", ".venv") for part in fp.parts):
        return {"ok": False, "error": "forbidden"}
    if any(part.startswith(".") and part not in (".env", ".gitignore", ".dockerignore") for part in fp.relative_to(root).parts):
        return {"ok": False, "error": "forbidden"}

    ext = fp.suffix.lower()
    if ext not in TEXT_PREVIEW_EXTENSIONS and fp.name not in ("Dockerfile", "Makefile", "LICENSE", "README"):
        return {"ok": False, "error": "unsupported_type"}

    try:
        size = fp.stat().st_size
        data = fp.read_bytes()[:TEXT_PREVIEW_MAX_BYTES + 1]
    except OSError as exc:
        return {"ok": False, "error": str(exc)}

    if b"\x00" in data:
        return {"ok": False, "error": "binary_file"}

    truncated = len(data) > TEXT_PREVIEW_MAX_BYTES
    if truncated:
        data = data[:TEXT_PREVIEW_MAX_BYTES]
    text = data.decode("utf-8-sig", errors="replace")
    return {
        "ok": True,
        "path": str(fp).replace("\\", "/"),
        "name": fp.name,
        "size": size,
        "truncated": truncated,
        "content": text,
    }


# ─── 目录浏览 ──────────────────────────────────────────────
def browse_directory(path: str) -> dict:
    import string

    if not path or path == "/":
        drives = []
        if sys.platform == "win32":
            for letter in string.ascii_uppercase:
                drive = f"{letter}:/"
                if os.path.isdir(drive):
                    drives.append({"name": f"{letter}:/", "path": drive, "type": "drive"})
            return {"current": "/", "parent": None, "items": drives}
        else:
            path = "/"

    path = os.path.normpath(path)
    if not os.path.isdir(path):
        return {"current": path, "parent": None, "items": [], "error": "路径不存在"}

    parent = os.path.dirname(path)
    if parent == path:
        parent = "/"

    items = []
    try:
        for entry in sorted(os.listdir(path)):
            full = os.path.join(path, entry)
            if os.path.isdir(full):
                if entry.startswith('.') and entry not in ('.claude',):
                    continue
                if entry in ('node_modules', '__pycache__', '.git', 'venv', '.venv'):
                    continue
                items.append({
                    "name": entry,
                    "path": full.replace("\\", "/"),
                    "type": "dir",
                })
    except PermissionError:
        return {"current": path, "parent": parent, "items": [], "error": "无权限访问"}

    return {
        "current": path.replace("\\", "/"),
        "parent": parent.replace("\\", "/") if parent != "/" else "/",
        "items": items,
    }


def create_directory(parent: str, name: str) -> dict:
    name = (name or "").strip()
    if not name:
        return {"ok": False, "error": "名称不能为空"}
    if any(c in name for c in '\\/:*?"<>|') or name in ('.', '..'):
        return {"ok": False, "error": "名称含非法字符"}
    if not parent or not os.path.isdir(parent):
        return {"ok": False, "error": "父目录不存在"}
    full = os.path.join(parent, name)
    if os.path.exists(full):
        return {"ok": False, "error": "同名目录已存在"}
    try:
        os.mkdir(full)
    except PermissionError:
        return {"ok": False, "error": "无权限创建"}
    except OSError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "path": full.replace("\\", "/")}


def remote_upload_dir(cwd: str = "") -> Path:
    base = Path(cwd) if cwd and os.path.isdir(cwd) else UPLOAD_DIR_FALLBACK.parent
    upload_dir = base / ".gui-uploads" / "remote"
    upload_dir.mkdir(parents=True, exist_ok=True)
    return upload_dir


def shell_quote(value: str) -> str:
    return shlex.quote(str(value or ""))


def remote_ls(target_id: str, path: str) -> dict:
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


def remote_cache_file(target_id: str, path: str, cwd: str = "") -> dict:
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


# ─── CLI 安装 ─────────────────────────────────────────────
INSTALL_CLI_COMMAND = "npm install -g @anthropic-ai/claude-code"
_install_lock = asyncio.Lock()


async def install_cli() -> dict:
    """通过 npm 全局安装 Claude Code CLI，返回安装结果。"""
    import shutil as _shutil

    npm = _shutil.which("npm")
    if not npm:
        return {"ok": False, "error": "npm_not_found"}

    if _install_lock.locked():
        return {"ok": False, "error": "install_in_progress"}

    async with _install_lock:
        try:
            proc = await asyncio.create_subprocess_exec(
                npm, "install", "-g", "@anthropic-ai/claude-code",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                limit=1024 * 1024 * 5,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=600)
            output = (stdout or b"").decode("utf-8", errors="replace").strip()
            if proc.returncode != 0:
                return {"ok": False, "error": "install_failed", "output": output[-4000:]}
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            return {"ok": False, "error": "install_timeout"}
        except Exception as exc:
            return {"ok": False, "error": "install_failed", "output": str(exc)}

    available = refresh_clis()
    return {
        "ok": bool(available),
        "available": available,
        "current": get_current_cli() if available else "",
        "output": output[-4000:],
        "error": None if available else "cli_not_detected_after_install",
    }


# ─── 自动更新 ─────────────────────────────────────────────
REPO_DIR = Path(__file__).resolve().parent
_update_lock = asyncio.Lock()


def _get_startup_commit() -> str:
    """记录服务进程启动时对应的 git commit，用于识别代码已更新但进程未重启的场景。"""
    import shutil as _shutil

    git = _shutil.which("git")
    if not git:
        return ""
    try:
        proc = subprocess.run(
            [git, "rev-parse", "HEAD"],
            cwd=str(REPO_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
            check=False,
        )
        return (proc.stdout or "").strip() if proc.returncode == 0 else ""
    except Exception:
        return ""


SERVER_START_COMMIT = _get_startup_commit()


async def _run_git(*args, timeout: int = 30) -> tuple[int, str]:
    """在仓库目录运行 git 子命令，返回 (returncode, 合并输出)。git 不存在时 returncode=-1。"""
    import shutil as _shutil

    git = _shutil.which("git")
    if not git:
        return -1, "git_not_found"
    try:
        proc = await asyncio.create_subprocess_exec(
            git, *args,
            cwd=str(REPO_DIR),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=1024 * 1024 * 5,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        output = (stdout or b"").decode("utf-8", errors="replace").strip()
        return proc.returncode, output
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except (ProcessLookupError, UnboundLocalError):
            pass
        return -2, "timeout"
    except Exception as exc:
        return -3, str(exc)


async def check_update() -> dict:
    """检查远端 origin/master 是否有更新，并识别当前进程是否仍运行旧提交。"""
    # 必须先确认是 git 仓库
    code, _ = await _run_git("rev-parse", "--is-inside-work-tree", timeout=10)
    if code != 0:
        return {"ok": False, "error": "git_unavailable"}

    code, _ = await _run_git("fetch", "--quiet", "origin", "master", timeout=30)
    if code != 0:
        return {"ok": False, "error": "fetch_failed"}

    code_l, local = await _run_git("rev-parse", "HEAD", timeout=10)
    code_r, remote = await _run_git("rev-parse", "origin/master", timeout=10)
    if code_l != 0 or code_r != 0:
        return {"ok": False, "error": "rev_parse_failed"}

    has_update = bool(local) and bool(remote) and local != remote
    server_stale = bool(SERVER_START_COMMIT) and bool(local) and SERVER_START_COMMIT != local
    commits = ""
    if has_update:
        _, commits = await _run_git("log", "--oneline", "-20", "HEAD..origin/master", timeout=10)
        # 只有远端有本地没有的提交才算有更新（本地领先远端不算）
        if not commits.strip():
            has_update = False
    elif server_stale:
        commits = f"{SERVER_START_COMMIT[:7]}..{local[:7]}"

    return {
        "ok": True,
        "has_update": has_update,
        "needs_restart": server_stale,
        "local": local,
        "remote": remote,
        "server_start": SERVER_START_COMMIT,
        "local_short": local[:7],
        "remote_short": remote[:7],
        "server_start_short": SERVER_START_COMMIT[:7],
        "commits": commits,
        "error": None,
    }


async def apply_update() -> dict:
    """git pull --ff-only origin master 拉取更新。"""
    if _update_lock.locked():
        return {"ok": False, "error": "update_in_progress"}
    async with _update_lock:
        code, output = await _run_git("pull", "--ff-only", "origin", "master", timeout=120)
    if code != 0:
        return {"ok": False, "error": "pull_failed", "output": output[-4000:]}
    return {"ok": True, "output": output[-4000:], "error": None}


def restart_server():
    """用 os.execv 原地重启服务进程（best-effort）。"""
    try:
        # 自动更新后的前端会等待服务恢复并刷新当前页，不需要再打开新浏览器页签。
        os.environ["CCB_GUI_NO_BROWSER"] = "1"
        os.execv(sys.executable, [sys.executable, str(REPO_DIR / "server.py")])
    except Exception:
        # 重启失败时不抛出，前端会提示手动重启
        pass


# ─── SSE 推送 ──────────────────────────────────────────────
async def push_event(client_id: str, event_type: str, data: dict):
    """向指定 SSE 客户端推送事件"""
    queue = sse_clients.get(client_id)
    if queue:
        await queue.put({"event": event_type, "data": data})


UPLOAD_DIR_FALLBACK = Path(__file__).parent / "uploads"
UPLOAD_DIR_FALLBACK.mkdir(exist_ok=True)


def is_allowed_upload_path(path: str) -> Path | None:
    """校验上传缓存路径，仅允许 fallback uploads 或任意 .gui-uploads 下的普通文件。"""
    try:
        fp = Path(path).resolve()
        fallback = UPLOAD_DIR_FALLBACK.resolve()
        is_fallback = fp == fallback or fallback in fp.parents
        is_gui_upload = any(part == ".gui-uploads" for part in fp.parts)
        if not (is_fallback or is_gui_upload):
            return None
        return fp
    except Exception:
        return None


def delete_uploaded_files(paths: list[str]) -> dict:
    """删除 GUI 上传缓存文件；只删除文件，不删除用户通过文件选择器引用的原始路径。"""
    deleted = []
    failed = []
    for path in paths or []:
        fp = is_allowed_upload_path(str(path or ""))
        if not fp:
            failed.append({"path": path, "error": "forbidden"})
            continue
        try:
            if fp.exists() and fp.is_file():
                fp.unlink()
                deleted.append(str(fp).replace("\\", "/"))
        except OSError as exc:
            failed.append({"path": path, "error": str(exc)})
    return {"ok": True, "deleted": deleted, "failed": failed}


# ─── 文件上传 ─────────────────────────────────────────────
async def handle_upload(headers: dict, body: bytes, writer: asyncio.StreamWriter):
    """处理 multipart 文件上传，保存到工作目录的 .gui-uploads/ 下"""
    content_type = headers.get("content-type", "")
    if "multipart/form-data" not in content_type:
        await send_response(writer, 400, "application/json", b'{"error":"need multipart"}')
        return

    # 提取 boundary
    boundary = None
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            boundary = part[9:].strip('"')
            break

    if not boundary:
        await send_response(writer, 400, "application/json", b'{"error":"no boundary"}')
        return

    # 解析 multipart body
    boundary_bytes = f"--{boundary}".encode()
    parts = body.split(boundary_bytes)
    saved_files = []
    upload_dir = UPLOAD_DIR_FALLBACK  # 默认
    cwd_value = None

    for part in parts:
        if not part or part == b"--\r\n" or part == b"--":
            continue

        # 分离 headers 和 content
        if b"\r\n\r\n" not in part:
            continue
        header_section, file_data = part.split(b"\r\n\r\n", 1)

        # 去掉尾部 \r\n
        if file_data.endswith(b"\r\n"):
            file_data = file_data[:-2]

        # 从 Content-Disposition 提取字段名和文件名
        header_str = header_section.decode("utf-8", errors="replace")
        filename = ""
        field_name = ""
        for line in header_str.split("\r\n"):
            if "Content-Disposition" in line:
                if 'name="' in line:
                    ni = line.index('name="') + 6
                    field_name = line[ni:line.index('"', ni)]
                if "filename=" in line:
                    idx = line.index("filename=")
                    fname = line[idx + 9:].split(";")[0].strip('" ')
                    if fname:
                        filename = fname
                break

        # 如果是 cwd 字段
        if field_name == "cwd" and not filename:
            cwd_value = file_data.decode("utf-8", errors="replace").strip()
            continue

        if not file_data or not filename:
            continue

        # 确定上传目录
        if cwd_value and os.path.isdir(cwd_value):
            upload_dir = Path(cwd_value) / ".gui-uploads"
            upload_dir.mkdir(exist_ok=True)

        # 保存文件（UUID 前缀避免冲突）
        safe_name = f"{uuid.uuid4().hex[:8]}_{filename}"
        file_path = upload_dir / safe_name
        file_path.write_bytes(file_data)
        saved_files.append(str(file_path.resolve()).replace("\\", "/"))

    # 如果 cwd 还没处理（cwd 字段在 file 后面），重新移动文件
    if cwd_value and os.path.isdir(cwd_value) and saved_files:
        target_dir = Path(cwd_value) / ".gui-uploads"
        target_dir.mkdir(exist_ok=True)
        new_files = []
        for fp in saved_files:
            src = Path(fp)
            if src.parent != target_dir:
                dst = target_dir / src.name
                dst.write_bytes(src.read_bytes())
                src.unlink()
                new_files.append(str(dst.resolve()).replace("\\", "/"))
            else:
                new_files.append(fp)
        saved_files = new_files

    resp = json.dumps({"files": saved_files}, ensure_ascii=False).encode("utf-8")
    await send_response(writer, 200, "application/json; charset=utf-8", resp)


# ─── HTTP 请求处理 ─────────────────────────────────────────
async def handle_http(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    """处理 HTTP 请求"""
    sock = writer.get_extra_info("socket")
    if sock:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    try:
        request_line = await asyncio.wait_for(reader.readline(), timeout=30)
        if not request_line:
            writer.close()
            return

        request_str = request_line.decode("utf-8", errors="replace").strip()
        parts = request_str.split(" ")
        if len(parts) < 3:
            writer.close()
            return

        method, path = parts[0], parts[1]

        # 读取 headers
        headers = {}
        while True:
            line = await reader.readline()
            line_str = line.decode("utf-8", errors="replace").strip()
            if not line_str:
                break
            if ":" in line_str:
                key, value = line_str.split(":", 1)
                headers[key.strip().lower()] = value.strip()

        # 读取 body
        body = b""
        content_length = int(headers.get("content-length", 0))
        if content_length > MAX_REQUEST_BODY_BYTES:
            await send_response(writer, 413, "application/json", b'{"error":"request too large"}')
            return
        if content_length > 0:
            body = await reader.readexactly(content_length)

        # 路由
        parsed = urlparse(path)
        route_path = parsed.path
        query = parse_qs(parsed.query)

        if not is_request_allowed(writer):
            await send_response(writer, 403, "text/plain", b"LAN access disabled")
            return

        if route_path == "/sse":
            await handle_sse(query, writer)
            return  # SSE 连接由 handle_sse 管理生命周期

        elif method == "POST" and route_path == "/api/upload":
            await handle_upload(headers, body, writer)

        elif method == "POST" and route_path == "/api/action":
            await handle_action(body, writer)

        elif method == "GET" and route_path.startswith("/api/"):
            await handle_api_get(route_path, writer, query)

        elif method == "POST" and route_path.startswith("/api/"):
            await handle_api_post(route_path, body, writer)

        else:
            await handle_static(route_path, writer)

    except (asyncio.TimeoutError, ConnectionResetError, BrokenPipeError):
        pass
    except Exception as e:
        try:
            if route_path.startswith("/api/"):
                err_body = json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8")
                await send_response(writer, 500, "application/json; charset=utf-8", err_body)
            else:
                await send_response(writer, 500, "text/plain", str(e).encode())
        except Exception:
            pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


# ─── SSE 长连接 ────────────────────────────────────────────
async def handle_sse(query: dict, writer: asyncio.StreamWriter):
    """处理 SSE 连接 - 保持长连接推送事件"""
    client_id = query.get("id", [str(uuid.uuid4())])[0]

    # 发送 SSE 头
    header = (
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/event-stream; charset=utf-8\r\n"
        "Cache-Control: no-cache\r\n"
        "Connection: keep-alive\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "\r\n"
    )
    writer.write(header.encode())
    await writer.drain()

    # 注册客户端
    queue: asyncio.Queue = asyncio.Queue()
    sse_clients[client_id] = queue
    client_ips[client_id] = get_client_ip(writer)

    # 发送初始 connected 事件
    await _sse_write(writer, "connected", {"client_id": client_id})

    # 重连：如果该 client_id 已有活跃会话，同步当前状态给前端
    existing_session = get_current_session(client_id)
    viewing_owner = client_viewing.get(client_id, "")
    if viewing_owner:
        # viewer 重连：重新订阅到 owner 的 session
        owner_sess = get_owned_session(viewing_owner, client_session_ids.get(client_id, ""))
        if owner_sess and owner_sess.is_running:
            meta = client_meta.setdefault(viewing_owner, {})
            client_meta[client_id] = dict(meta)

            async def on_viewer_reconnect(event: dict):
                await forward_viewer_event(client_id, event)

            owner_sess.add_viewer(client_id, on_viewer_reconnect)
            state = {
                "model": owner_sess.model,
                "resumed": bool(owner_sess.session_id),
                "session_id": owner_sess.session_id or client_session_ids.get(client_id, ""),
                "remote_target_id": meta.get("remote_target_id", ""),
                "cli": owner_sess.cli or get_current_cli(),
                "cwd": owner_sess.cwd or meta.get("cwd", ""),
                "viewing": True,
            }
            if owner_sess.session_id and session_run_ids.get(owner_sess.session_id):
                state["run_id"] = session_run_ids[owner_sess.session_id]
            await _sse_write(writer, "session_started", state)
            gen_state = build_generation_state(owner_sess)
            if gen_state:
                await _sse_write(writer, "generation_started", gen_state)
            await push_current_session_lock(client_id, state.get("session_id", ""))
            # 跳过后续 existing_session 检查，viewer 没有自己的 session
            existing_session = None

    if existing_session and existing_session.is_running:
        meta = client_meta.get(client_id, {})
        state = {
            "model": existing_session.model,
            "resumed": bool(existing_session.session_id),
            "session_id": existing_session.session_id or client_session_ids.get(client_id, ""),
            "remote_target_id": meta.get("remote_target_id", ""),
            "cli": existing_session.cli or get_current_cli(),
        }
        if existing_session.session_id and session_run_ids.get(existing_session.session_id):
            state["run_id"] = session_run_ids[existing_session.session_id]
        await _sse_write(writer, "session_started", state)
        # 如果正在回复中，前端也需进入响应状态
        gen_state = build_generation_state(existing_session)
        if gen_state:
            await _sse_write(writer, "generation_started", gen_state)
        await push_current_session_lock(client_id, state.get("session_id", ""))

    try:
        while True:
            # 等待事件（带心跳）
            try:
                event = await asyncio.wait_for(queue.get(), timeout=15)
                await _sse_write(writer, event["event"], event["data"])
            except asyncio.TimeoutError:
                # 发送心跳保活
                writer.write(b": heartbeat\n\n")
                await writer.drain()
    except (ConnectionResetError, BrokenPipeError, OSError):
        pass
    finally:
        if sse_clients.get(client_id) is queue:
            sse_clients.pop(client_id, None)
        # 清理 viewer 回调（旧闭包已失效），但保留 client_viewing 映射以支持重连
        viewer_owner = client_viewing.get(client_id, "")
        if viewer_owner:
            owner_sess = get_owned_session(viewer_owner, client_session_ids.get(client_id, ""))
            if owner_sess:
                owner_sess.remove_viewer(client_id)
        # SSE 断开不代表用户主动停止会话。移动端息屏、浏览器后台挂起会断开 EventSource，
        # 这里保留 client_viewing 映射，让同一 client_id 重连后自动恢复 viewer 订阅。
        try:
            writer.close()
        except Exception:
            pass


async def _sse_write(writer: asyncio.StreamWriter, event: str, data: dict):
    """写入一条 SSE 事件"""
    payload = json.dumps(data, ensure_ascii=False)
    msg = f"event: {event}\ndata: {payload}\n\n"
    writer.write(msg.encode("utf-8"))
    await writer.drain()


# ─── Action API (客户端发送消息/命令) ──────────────────────
def format_line_ranges(numbers: list[int]) -> str:
    """把行号列表压缩成 1-3,7 这样的短格式。"""
    ordered = sorted({n for n in numbers if n > 0})
    if not ordered:
        return ""
    ranges = []
    start = prev = ordered[0]
    for number in ordered[1:]:
        if number == prev + 1:
            prev = number
            continue
        ranges.append(f"{start}-{prev}" if start != prev else str(start))
        start = prev = number
    ranges.append(f"{start}-{prev}" if start != prev else str(start))
    return ",".join(ranges)


def build_quote_context(quotes: list, cwd: str = "") -> str:
    """把前端传来的轻量引用（文件路径 + 行号）整理为给 CLI 的短引用。"""
    if not isinstance(quotes, list):
        return ""
    chunks = []
    cwd_root = None
    try:
        cwd_root = Path(cwd).resolve() if cwd else None
    except Exception:
        cwd_root = None

    for quote in quotes:
        if not isinstance(quote, dict):
            text = str(quote or "").strip()
            if text:
                chunks.append(text)
            continue
        qtype = quote.get("type") or "text"
        if qtype != "file_lines":
            text = str(quote.get("text") or "").strip()
            if text:
                chunks.append(text)
            continue
        path_text = str(quote.get("path") or "").strip()
        line_numbers = []
        for value in quote.get("lines") or []:
            try:
                number = int(value)
            except (TypeError, ValueError):
                continue
            if number > 0 and number not in line_numbers:
                line_numbers.append(number)
        if not path_text or not line_numbers:
            continue
        line_ref = format_line_ranges(line_numbers)
        if line_ref:
            chunks.append(f"{path_text}:{line_ref}")
    return "\n\n".join(chunks)


async def handle_action(body: bytes, writer: asyncio.StreamWriter):
    """处理客户端 action (new_session, send_message, stop)"""
    try:
        data = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError:
        await send_response(writer, 400, "application/json", b'{"error":"invalid json"}')
        return

    client_id = data.get("client_id", "")
    action = data.get("action", "")

    if not is_cli_access_allowed(client_id, writer):
        await reject_client_access(client_id, writer)
        return

    if action == "new_session":
        model = data.get("model") or get_default_model()
        cwd = data.get("cwd")
        skip_perms = data.get("skip_permissions", True)
        remote_target = remote_manager.get_target(data.get("remote_target_id") or "")
        allow_mutate = bool(data.get("allow_remote_mutate", False))
        cli = data.get("cli") or get_current_cli()

        # 清理当前查看状态；正在运行的旧会话继续保留。
        client_viewing.pop(client_id, None)

        run_id, session = session_manager.create_session(client_id)

        # 记录元数据
        remote_target_id = (remote_target or {}).get("id", "")
        client_meta[client_id] = {"model": model, "cwd": cwd, "remote_target_id": remote_target_id, "cli": cli}
        client_last_msg.pop(client_id, None)
        client_session_ids.pop(client_id, None)
        client_session_agents.pop(client_id, None)
        client_viewing.pop(client_id, None)

        on_event = make_owner_event_handler(client_id, run_id, session, model, cwd or "", remote_target_id, cli, "新会话")

        try:
            await session.start(model=model, cwd=cwd, on_event=on_event, skip_permissions=skip_perms,
                                remote_target=remote_target, allow_mutate=allow_mutate, cli=cli)
        except Exception as exc:
            await push_event(client_id, "error", {"message": str(exc)})
            err = json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8")
            await send_response(writer, 400, "application/json; charset=utf-8", err)
            return
        await push_event(client_id, "session_started", {"model": model, "remote_target_id": remote_target_id, "cli": cli, "run_id": run_id})
        await send_response(writer, 200, "application/json", b'{"ok":true}')

    elif action == "resume_session":
        resume_id = data.get("session_id", "")
        model = data.get("model") or get_default_model()
        cwd = data.get("cwd")
        skip_perms = data.get("skip_permissions", True)
        remote_target = remote_manager.get_target(data.get("remote_target_id") or "")
        allow_mutate = bool(data.get("allow_remote_mutate", False))
        remote_target_id = (remote_target or {}).get("id", "")
        cli = data.get("cli") or get_current_cli()

        # 切换历史会话只切换当前视图；旧会话如仍在生成则继续运行。
        old_owner = client_viewing.pop(client_id, None)
        if old_owner:
            owner_sess = get_owned_session(old_owner, client_session_ids.get(client_id, ""))
            if owner_sess:
                owner_sess.remove_viewer(client_id)
        client_viewing.pop(client_id, None)

        # 检查该 session 是否已在另一个客户端活跃；即使当前空闲也要订阅后续事件
        owner_id = session_owner.get(resume_id)
        if owner_id and owner_id != client_id:
            owner_session = get_owned_session(owner_id, resume_id)
            if owner_session and owner_session.is_running:
                # 作为 viewer 订阅到活跃 session
                client_session_ids[client_id] = resume_id
                client_viewing[client_id] = owner_id
                meta = client_meta.setdefault(owner_id, {})
                client_meta[client_id] = dict(meta)

                async def on_viewer_event(event: dict):
                    await forward_viewer_event(client_id, event, resume_id)

                owner_session.add_viewer(client_id, on_viewer_event)
                # 发送当前会话状态给 viewer
                await push_event(client_id, "session_started", {
                    "model": owner_session.model, "resumed": True, "session_id": resume_id,
                    "remote_target_id": meta.get("remote_target_id", ""), "cli": owner_session.cli or "",
                    "cwd": owner_session.cwd or meta.get("cwd", ""),
                    "viewing": True,
                    "run_id": session_run_ids.get(resume_id, ""),
                })
                gen_state = build_generation_state(owner_session)
                if gen_state:
                    await push_event(client_id, "generation_started", gen_state)
                await push_current_session_lock(client_id, resume_id)
                await send_response(writer, 200, "application/json", b'{"ok":true}')
                return

        # 常规恢复：创建新 session
        run_id, session = session_manager.create_session(client_id)
        session.session_id = resume_id

        client_meta[client_id] = {"model": model, "cwd": cwd, "remote_target_id": remote_target_id, "cli": cli}
        client_session_ids[client_id] = resume_id
        session_owner[resume_id] = client_id  # 恢复会话时直接设置归属，因为 session_id_captured 不会对已 resume 的 session 重复触发
        session_run_ids[resume_id] = run_id
        session_manager.bind_native_session(resume_id, run_id)

        # 已有 owner 但未在生成时，新客户端可直接恢复并成为后续 owner；不停止旧 run。
        if owner_id and owner_id != client_id:
            old_meta = client_meta.get(owner_id, {})
            client_viewing[owner_id] = client_id
            client_session_ids[owner_id] = resume_id
            client_meta.setdefault(owner_id, {})
            client_meta[owner_id].update({
                "model": old_meta.get("model", model),
                "cwd": old_meta.get("cwd", cwd or ""),
                "cli": old_meta.get("cli", cli or ""),
                "remote_target_id": old_meta.get("remote_target_id", ""),
            })

            async def on_taken_viewer_event(event: dict):
                await forward_viewer_event(owner_id, event, resume_id)

            session.add_viewer(owner_id, on_taken_viewer_event)

            # 先推送 session_started(viewing=true) 让前端切换 UI 为 viewer 模式
            await push_event(owner_id, "session_started", {
                "model": old_meta.get("model", model),
                "resumed": True,
                "session_id": resume_id,
                "remote_target_id": old_meta.get("remote_target_id", ""),
                "cli": cli or old_meta.get("cli", ""),
                "cwd": old_meta.get("cwd", cwd or ""),
                "viewing": True,
                "run_id": run_id,
            })

            await push_event(owner_id, "session_taken", {
                "session_id": resume_id,
                "model": old_meta.get("model", model),
                "cwd": old_meta.get("cwd", ""),
                "cli": old_meta.get("cli", ""),
                "remote_target_id": old_meta.get("remote_target_id", ""),
            })

        async def on_event_resume(event: dict):
            evt_type = event.get("type", "unknown")
            sid = event.get("session_id") or resume_id
            if sid and "session_id" not in event:
                event = dict(event)
                event["session_id"] = sid
            if run_id and "run_id" not in event:
                event = dict(event)
                event["run_id"] = run_id
            if evt_type == "session_id_captured":
                sid = event.get("session_id", resume_id)
                client_session_ids[client_id] = sid
                session_owner[sid] = client_id
                session_run_ids[sid] = run_id
                session_manager.bind_native_session(sid, run_id)
                meta = client_meta.get(client_id, {})
                save_session(sid, "", meta.get("model", model), meta.get("cwd", cwd or ""),
                             remote_target_id=meta.get("remote_target_id", ""), cli=meta.get("cli", ""))
                await push_event(client_id, "session_id_captured", event)
            elif evt_type == "result":
                await push_event(client_id, evt_type, persist_result_usage(client_id, event))
                await release_session_lock_for_session(sid, client_id)
            elif evt_type == "user":
                results = extract_tool_results(event)
                if results:
                    await push_event(client_id, "tool_result", {
                        "session_id": sid,
                        "run_id": run_id,
                        "results": results,
                        "parent_tool_use_id": event.get("parent_tool_use_id"),
                    })
            elif evt_type == "process_ended":
                await push_event(client_id, evt_type, event)
                await release_session_lock_for_session(sid, client_id)
                session_manager.finish_run(run_id)
                if sid and session_run_ids.get(sid) == run_id:
                    session_run_ids.pop(sid, None)
            elif evt_type == "error":
                await push_event(client_id, evt_type, event)
                await release_session_lock_for_session(sid, client_id)
                session_manager.finish_run(run_id)
                if sid and session_run_ids.get(sid) == run_id:
                    session_run_ids.pop(sid, None)
            elif evt_type in ("assistant", "stream_event", "system", "model_changed"):
                await push_event(client_id, evt_type, event)
            # 其他事件忽略

        session_locks.pop(resume_id, None)
        await session.start(model=model, cwd=cwd, resume_id=resume_id, on_event=on_event_resume, skip_permissions=skip_perms,
                            remote_target=remote_target, allow_mutate=allow_mutate, cli=cli)
        await push_event(client_id, "session_started", {"model": model, "resumed": True, "session_id": resume_id, "remote_target_id": remote_target_id, "cli": cli, "run_id": run_id})
        await send_response(writer, 200, "application/json", b'{"ok":true}')

    elif action == "send_message":
        content = data.get("content", "")
        requested_model = data.get("model") or ""
        viewing_owner = client_viewing.get(client_id)
        quote_cwd = client_meta.get(client_id, {}).get("cwd", "")
        if viewing_owner and not quote_cwd:
            quote_cwd = client_meta.get(viewing_owner, {}).get("cwd", "")
        quote_context = build_quote_context(data.get("quotes") or [], quote_cwd)
        if quote_context:
            content = f"引用内容:\n{quote_context}\n\n{content}".strip()
        # viewer 在 owner 正在生成时优先走持久进程 stdin 补充发送；不接管、不改锁 holder。
        viewing_owner = client_viewing.get(client_id)
        if viewing_owner:
            owner_session = get_owned_session(viewing_owner, client_session_ids.get(client_id, ""))
            active_sid = client_session_ids.get(client_id) or client_session_ids.get(viewing_owner, "")
            if owner_session and owner_session._message_owner_id:
                if content and owner_session.can_accept_live_input():
                    try:
                        await owner_session.send_live_message(content)
                    except Exception as exc:
                        await push_event(client_id, "error", {"message": str(exc)})
                        err = json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8")
                        await send_response(writer, 500, "application/json; charset=utf-8", err)
                        return
                    await broadcast_user_message(active_sid, content, client_id)
                    await send_response(writer, 200, "application/json", b'{"ok":true,"live":true}')
                    return
                await push_event(client_id, "error", {"message": "当前会话暂不支持活跃中补充发送"})
                await send_response(writer, 200, "application/json", b'{"ok":false,"error":"live input unavailable"}')
                return

            resume_id = client_session_ids.get(client_id) or client_session_ids.get(viewing_owner, "")
            takeover_viewers = [viewing_owner]
            takeover_viewers.extend(
                vid for vid, oid in list(client_viewing.items())
                if oid == viewing_owner and vid != client_id and vid not in takeover_viewers
            )
            if owner_session:
                owner_session.remove_viewer(client_id)
                for vid in takeover_viewers:
                    owner_session.remove_viewer(vid)
            client_viewing.pop(client_id, None)
            if resume_id:
                session_owner[resume_id] = client_id
                client_session_ids[client_id] = resume_id

            run_id, takeover_session = session_manager.create_session(client_id)
            takeover_session.session_id = resume_id
            if resume_id:
                session_run_ids[resume_id] = run_id
                session_manager.bind_native_session(resume_id, run_id)
            meta = dict(client_meta.get(client_id) or client_meta.get(viewing_owner) or {})
            if requested_model:
                meta["model"] = requested_model
            if data.get("cli"):
                meta["cli"] = data.get("cli")
            if "remote_target_id" in data:
                meta["remote_target_id"] = data.get("remote_target_id") or ""
            client_meta[client_id] = meta

            async def on_takeover_event(event: dict):
                evt_type = event.get("type", "unknown")
                sid = event.get("session_id") or resume_id
                if sid and "session_id" not in event:
                    event = dict(event)
                    event["session_id"] = sid
                if run_id and "run_id" not in event:
                    event = dict(event)
                    event["run_id"] = run_id
                if evt_type == "session_id_captured":
                    sid = event.get("session_id", resume_id)
                    client_session_ids[client_id] = sid
                    session_owner[sid] = client_id
                    session_run_ids[sid] = run_id
                    session_manager.bind_native_session(sid, run_id)
                    meta_now = client_meta.get(client_id, {})
                    save_session(sid, "", meta_now.get("model", ""), meta_now.get("cwd", ""),
                                 remote_target_id=meta_now.get("remote_target_id", ""), cli=meta_now.get("cli", ""))
                    await push_event(client_id, "session_id_captured", event)
                elif evt_type == "result":
                    await push_event(client_id, evt_type, persist_result_usage(client_id, event))
                    await release_session_lock_for_session(sid, client_id)
                elif evt_type == "user":
                    results = extract_tool_results(event)
                    if results:
                        await push_event(client_id, "tool_result", {
                            "session_id": sid,
                            "run_id": run_id,
                            "results": results,
                            "parent_tool_use_id": event.get("parent_tool_use_id"),
                        })
                elif evt_type == "process_ended":
                    await push_event(client_id, evt_type, event)
                    await release_session_lock_for_session(sid, client_id)
                    session_manager.finish_run(run_id)
                    if sid and session_run_ids.get(sid) == run_id:
                        session_run_ids.pop(sid, None)
                elif evt_type == "error":
                    await push_event(client_id, evt_type, event)
                    await release_session_lock_for_session(sid, client_id)
                    session_manager.finish_run(run_id)
                    if sid and session_run_ids.get(sid) == run_id:
                        session_run_ids.pop(sid, None)
                elif evt_type in ("assistant", "stream_event", "system", "model_changed"):
                    await push_event(client_id, evt_type, event)

            remote_target = remote_manager.get_target(meta.get("remote_target_id") or "")
            try:
                await takeover_session.start(
                    model=meta.get("model") or requested_model or get_default_model(),
                    cwd=meta.get("cwd"),
                    resume_id=resume_id,
                    on_event=on_takeover_event,
                    skip_permissions=True,
                    remote_target=remote_target,
                    allow_mutate=bool(data.get("allow_remote_mutate", False)),
                    cli=meta.get("cli") or data.get("cli") or get_current_cli(),
                )
            except Exception as exc:
                await push_event(client_id, "error", {"message": str(exc)})
                err = json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8")
                await send_response(writer, 400, "application/json; charset=utf-8", err)
                return
            async def on_takeover_viewer_event(viewer_id: str, event: dict):
                await forward_viewer_event(viewer_id, event, resume_id)

            for vid in takeover_viewers:
                if vid == client_id:
                    continue
                client_viewing[vid] = client_id
                client_session_ids[vid] = resume_id
                client_meta[vid] = dict(client_meta.get(vid) or meta)
                takeover_session.add_viewer(vid, lambda event, viewer_id=vid: on_takeover_viewer_event(viewer_id, event))
                await push_event(vid, "session_started", {
                    "model": takeover_session.model,
                    "resumed": bool(resume_id),
                    "session_id": resume_id,
                    "remote_target_id": client_meta.get(vid, {}).get("remote_target_id", ""),
                    "cli": takeover_session.cli or client_meta.get(vid, {}).get("cli", ""),
                    "cwd": takeover_session.cwd or client_meta.get(vid, {}).get("cwd", ""),
                    "viewing": True,
                    "run_id": run_id,
                })
                await push_event(vid, "session_taken", {
                    "session_id": resume_id,
                    "model": takeover_session.model,
                    "cwd": takeover_session.cwd or "",
                    "cli": takeover_session.cli or "",
                    "remote_target_id": client_meta.get(vid, {}).get("remote_target_id", ""),
                })
                await push_current_session_lock(vid, resume_id)
        session = get_current_session(client_id)
        sid = client_session_ids.get(client_id, "")
        if (not session or not session.is_running) and sid and content:
            meta = client_meta.setdefault(client_id, {})
            if requested_model:
                meta["model"] = requested_model
            if data.get("cli"):
                meta["cli"] = data.get("cli")
            if "remote_target_id" in data:
                meta["remote_target_id"] = data.get("remote_target_id") or ""
            run_id, session = session_manager.create_session(client_id)
            session.session_id = sid
            session_owner[sid] = client_id
            session_run_ids[sid] = run_id
            session_manager.bind_native_session(sid, run_id)
            attach_viewers_to_session(client_id, sid, session)
            remote_target = remote_manager.get_target(meta.get("remote_target_id") or "")
            on_event = make_owner_event_handler(
                client_id,
                run_id,
                session,
                meta.get("model") or get_default_model(),
                meta.get("cwd", ""),
                meta.get("remote_target_id", ""),
                meta.get("cli", ""),
                content.strip()[:50] or "新会话",
            )
            try:
                await session.start(
                    model=meta.get("model") or get_default_model(),
                    cwd=meta.get("cwd"),
                    resume_id=sid,
                    on_event=on_event,
                    skip_permissions=True,
                    remote_target=remote_target,
                    allow_mutate=bool(data.get("allow_remote_mutate", False)),
                    cli=meta.get("cli") or get_current_cli(),
                )
            except Exception as exc:
                session_manager.finish_run(run_id)
                if session_run_ids.get(sid) == run_id:
                    session_run_ids.pop(sid, None)
                await push_event(client_id, "error", {"session_id": sid, "run_id": run_id, "message": str(exc)})
                err = json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8")
                await send_response(writer, 400, "application/json; charset=utf-8", err)
                return
        if session and session.is_running and content:
            if requested_model and requested_model != session.model:
                session.model = requested_model
                meta = client_meta.setdefault(client_id, {})
                meta["model"] = requested_model
                await push_event(client_id, "model_changed", {"model": requested_model})
            # 允许会话中手动切换远程目标和读写模式，下一条消息生效
            if "remote_target_id" in data:
                remote_target = remote_manager.get_target(data.get("remote_target_id") or "")
                session.remote_target = remote_target or None
                meta = client_meta.setdefault(client_id, {})
                meta["remote_target_id"] = (remote_target or {}).get("id", "")
            if "allow_remote_mutate" in data:
                session.allow_mutate = bool(data.get("allow_remote_mutate"))
            # 允许会话中切换 CLI，下一条消息生效
            if data.get("cli"):
                session.cli = data.get("cli")
                meta = client_meta.setdefault(client_id, {})
                meta["cli"] = data.get("cli")
            # 使用最新用户消息作为会话标题
            title = content.strip()[:50]
            client_last_msg[client_id] = title
            sid = client_session_ids.get(client_id)
            run_id = session_run_ids.get(sid, "") if sid else ""
            if sid:
                meta = client_meta.get(client_id, {})
                save_session(sid, title, meta.get("model", ""), meta.get("cwd", ""),
                             remote_target_id=meta.get("remote_target_id", ""), cli=meta.get("cli", ""))
            # 提取 @agentname 提及，将对应 agent 定义传给 CLI（--agents 参数）
            mentioned = re.findall(r"@([A-Za-z0-9_.-]+)", content)
            if mentioned:
                # @all 展开为当前会话已拉入的全部 agent
                if "all" in mentioned:
                    mentioned = [m for m in mentioned if m != "all"]
                    for name in client_session_agents.get(client_id, []):
                        if name not in mentioned:
                            mentioned.append(name)
                if mentioned:
                    new_configs = get_agents_for_cli(mentioned, cwd=session.cwd or "")
                    if new_configs:
                        merged = dict(session.agent_configs)
                        merged.update(new_configs)
                        session.agent_configs = merged
            sid = client_session_ids.get(client_id)
            is_live_followup = bool(sid and session_locks.get(sid, {}).get("locked"))
            if is_live_followup:
                if not content or not session.can_accept_live_input():
                    await push_event(client_id, "error", {"message": "当前会话暂不支持活跃中补充发送"})
                    await send_response(writer, 200, "application/json", b'{"ok":false,"error":"live input unavailable"}')
                    return
                try:
                    await session.send_live_message(content)
                except Exception as exc:
                    await push_event(client_id, "error", {"message": str(exc)})
                    err = json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8")
                    await send_response(writer, 500, "application/json; charset=utf-8", err)
                    return
                await broadcast_user_message(sid, content, client_id)
                await send_response(writer, 200, "application/json", b'{"ok":true,"live":true}')
                return
            if sid:
                await broadcast_session_lock(sid, True, client_id)

            # 推送用户消息给所有 viewer（CLI 不会回显用户输入，viewer 看不到"问"）
            if sid:
                await broadcast_user_message(sid, content, client_id)

            try:
                await session.send_message(content, owner_id=client_id)
            except Exception as exc:
                await release_session_lock_for_client(client_id)
                await push_event(client_id, "error", {"message": str(exc)})
                err = json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8")
                await send_response(writer, 500, "application/json; charset=utf-8", err)
                return
            for vid in [target_id for target_id in get_session_subscribers(sid) if target_id != client_id]:
                await push_generation_started(vid, session)
            await send_response(writer, 200, "application/json", json.dumps({"ok": True, "run_id": run_id}, ensure_ascii=False).encode("utf-8"))
        else:
            await push_event(client_id, "error", {"message": "Session not running"})
            await send_response(writer, 200, "application/json", b'{"ok":false,"error":"no session"}')

    elif action == "stop":
        sid = data.get("session_id") or client_session_ids.get(client_id, "")
        run_id = data.get("run_id") or (session_run_ids.get(sid, "") if sid else "")
        session = session_manager.get_session_by_run_id(run_id) if run_id else get_current_session(client_id)
        if session:
            # viewer 不能 stop session，只能 stop 自己 viewing 的 session
            viewer_owner = client_viewing.get(client_id)
            if viewer_owner:
                await push_event(client_id, "error", {"message": "Viewer cannot stop session"})
                await send_response(writer, 200, "application/json", b'{"ok":false,"error":"viewer cannot stop"}')
                return
            await session.stop(requester_id=client_id)
            await release_session_lock_for_client(client_id)
            if sid and session_run_ids.get(sid) == run_id:
                session_run_ids.pop(sid, None)
            if run_id:
                session_manager.finish_run(run_id)
        await push_event(client_id, "session_stopped", {"session_id": sid, "run_id": run_id})
        await send_response(writer, 200, "application/json", b'{"ok":true}')

    elif action == "release_session":
        sid = data.get("session_id") or client_session_ids.get(client_id, "")
        run_id = data.get("run_id") or (session_run_ids.get(sid, "") if sid else "")
        session = session_manager.get_session_by_run_id(run_id) if run_id else session_manager.get_session_by_native_id(sid)
        released = False
        if session and not session.current_generation_state().get("running"):
            released = await session.release_idle()
            await release_session_lock_for_session(sid, client_id)
            if sid and session_run_ids.get(sid) == run_id:
                session_run_ids.pop(sid, None)
            if run_id:
                session_manager.finish_run(run_id)
        await send_response(writer, 200, "application/json", json.dumps({"ok": True, "released": released}, ensure_ascii=False).encode("utf-8"))

    elif action == "interrupt":
        sid = data.get("session_id") or client_session_ids.get(client_id, "")
        run_id = data.get("run_id") or (session_run_ids.get(sid, "") if sid else "")
        session = session_manager.get_session_by_run_id(run_id) if run_id else get_current_session(client_id)
        # viewer 不能 interrupt
        if client_viewing.get(client_id):
            await push_event(client_id, "error", {"message": "Viewer cannot interrupt"})
            await send_response(writer, 200, "application/json", b'{"ok":false,"error":"viewer cannot interrupt"}')
            return
        interrupted = False
        if session and session.is_running:
            await session.interrupt(requester_id=client_id)
            await release_session_lock_for_client(client_id)
            if sid and session_run_ids.get(sid) == run_id:
                session_run_ids.pop(sid, None)
            if run_id:
                session_manager.finish_run(run_id)
            interrupted = True
        if interrupted:
            await push_event(client_id, "generation_interrupted", {"session_id": sid, "run_id": run_id})
        await send_response(writer, 200, "application/json", json.dumps({"ok": interrupted}, ensure_ascii=False).encode("utf-8"))

    else:
        await send_response(writer, 400, "application/json", b'{"error":"unknown action"}')


async def publish_scheduled_event(event_type: str, data: dict):
    """向所有已连接客户端广播定时任务事件。"""
    for client_id in list(sse_clients.keys()):
        await push_event(client_id, event_type, data)


def make_owner_event_handler(client_id: str, run_id: str, session, model: str, cwd: str, remote_target_id: str, cli: str, default_title: str = "新会话"):
    async def on_event(event: dict):
        evt_type = event.get("type", "unknown")
        sid = event.get("session_id") or getattr(session, "session_id", None) or client_session_ids.get(client_id, "")
        if sid and "session_id" not in event:
            event = dict(event)
            event["session_id"] = sid
        if run_id and "run_id" not in event:
            event = dict(event)
            event["run_id"] = run_id
        if evt_type == "session_id_captured":
            sid = event.get("session_id", "")
            client_session_ids[client_id] = sid
            session_owner[sid] = client_id
            session_run_ids[sid] = run_id
            session_manager.bind_native_session(sid, run_id)
            title = client_last_msg.get(client_id, default_title)
            meta = client_meta.get(client_id, {})
            save_session(sid, title, meta.get("model", model), meta.get("cwd", cwd or ""),
                         remote_target_id=meta.get("remote_target_id", remote_target_id), cli=meta.get("cli", cli))
            await push_event(client_id, "session_id_captured", event)
        elif evt_type == "result":
            await push_event(client_id, evt_type, persist_result_usage(client_id, event))
            await release_session_lock_for_session(sid, client_id)
        elif evt_type == "user":
            results = extract_tool_results(event)
            if results:
                await push_event(client_id, "tool_result", {
                    "session_id": sid,
                    "run_id": run_id,
                    "results": results,
                    "parent_tool_use_id": event.get("parent_tool_use_id"),
                })
        elif evt_type == "process_ended":
            await push_event(client_id, evt_type, event)
            await release_session_lock_for_session(sid, client_id)
            session_manager.finish_run(run_id)
            if sid and session_run_ids.get(sid) == run_id:
                session_run_ids.pop(sid, None)
        elif evt_type == "error":
            await push_event(client_id, evt_type, event)
            await release_session_lock_for_session(sid, client_id)
            session_manager.finish_run(run_id)
            if sid and session_run_ids.get(sid) == run_id:
                session_run_ids.pop(sid, None)
        elif evt_type in ("assistant", "stream_event", "system", "model_changed"):
            await push_event(client_id, evt_type, event)

    return on_event


# ─── REST API ──────────────────────────────────────────────
async def handle_api_get(path: str, writer: asyncio.StreamWriter, query: dict = None):
    if path == "/api/settings":
        data = get_settings()
    elif path == "/api/gui-settings":
        data = get_gui_settings()
        data.update(get_access_context(writer))
        data["default_cwd"] = DEFAULT_CWD
    elif path == "/api/env":
        data = get_env_config()
    elif path == "/api/check-update":
        result = await check_update()
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/env-profiles":
        data = get_env_profiles()
    elif path == "/api/skills":
        data = list_skills()
    elif path == "/api/skills/detail":
        query = query or {}
        skill = get_skill(query.get("dir", [""])[0])
        if not skill:
            await send_response(writer, 404, "application/json", b'{"error":"not found"}')
            return
        data = skill
    elif path == "/api/agents":
        data = list_agents()
    elif path == "/api/session/agents":
        cid = (query or {}).get("id", [""])[0]
        data = {"agents": client_session_agents.get(cid, [])}
    elif path == "/api/mcp-servers":
        query = query or {}
        cwd = query.get("cwd", [""])[0] or ""
        data = list_mcp_servers(cwd)
    elif path == "/api/models":
        data = get_available_models()
    elif path == "/api/slash-commands":
        if not is_request_allowed(writer):
            await send_response(writer, 403, "application/json", b'{"error":"LAN access disabled"}')
            return
        query = query or {}
        model = query.get("model", [get_default_model()])[0] or get_default_model()
        cwd = query.get("cwd", [DEFAULT_CWD])[0] or DEFAULT_CWD
        discovered = await discover_slash_commands(model=model, cwd=cwd)
        data = format_slash_commands(discovered)
    elif path == "/api/clis":
        available = refresh_clis()
        data = {
            "available": available,
            "current": get_current_cli() if available else "",
            "install_command": INSTALL_CLI_COMMAND,
        }
    elif path == "/api/review":
        cwd = (query or {}).get("cwd", [""])[0] or DEFAULT_CWD
        data = git_review(cwd)
    elif path == "/api/browse":
        p = (query or {}).get("path", [""])[0]
        data = browse_files(p)
    elif path == "/api/file-preview":
        query = query or {}
        p = query.get("path", [""])[0]
        cwd = query.get("cwd", [DEFAULT_CWD])[0] or DEFAULT_CWD
        data = preview_text_file(p, cwd)
    elif path == "/api/default-cwd":
        data = {"cwd": DEFAULT_CWD}
    elif path == "/api/memory/files":
        query = query or {}
        cwd = query.get("cwd", [DEFAULT_CWD])[0] or DEFAULT_CWD
        data = list_memory_files(cwd)
    elif path == "/api/memory/search":
        query = query or {}
        q = query.get("q", [""])[0] or ""
        cwd = query.get("cwd", [DEFAULT_CWD])[0] or DEFAULT_CWD
        data = search_memory(q, cwd) if q else []
    elif path == "/api/memory/index":
        query = query or {}
        cwd = query.get("cwd", [DEFAULT_CWD])[0] or DEFAULT_CWD
        count = index_memory(cwd, force=True)
        data = {"count": count, "ok": count >= 0}
    elif path == "/api/memory/tree":
        query = query or {}
        cwd = query.get("cwd", [DEFAULT_CWD])[0] or DEFAULT_CWD
        data = {"tree": get_memory_tree(cwd)}
    elif path == "/api/memory/graph":
        query = query or {}
        cwd = query.get("cwd", [DEFAULT_CWD])[0] or DEFAULT_CWD
        data = get_memory_graph(cwd)
    elif path == "/api/scheduled-tasks":
        data = {"tasks": scheduled_task_store.list_tasks()}
    elif path == "/api/feishu-gateway/config":
        data = get_feishu_gateway_config(redact=True)
        data["available"] = FEISHU_GATEWAY_AVAILABLE
        data["unavailable_reason"] = FEISHU_GATEWAY_UNAVAILABLE_REASON
    elif path == "/api/feishu-gateway/scopes":
        data = {"scopes": list_feishu_scopes()}
    elif path == "/api/feishu-gateway/qr":
        query = query or {}
        url = query.get("url", [""])[0]
        if not url:
            await send_response(writer, 400, "application/json; charset=utf-8", b'{"error":"url query parameter required"}')
            return
        from qrcode_gen import generate_qr_svg
        svg = generate_qr_svg(url)
        resp = svg.encode("utf-8")
        await send_response(writer, 200, "image/svg+xml; charset=utf-8", resp)
        return
    elif path == "/api/remote-targets":
        data = {"targets": remote_manager.list_targets(), "password_supported": remote_manager.password_supported()}
    elif path == "/api/sessions":
        sessions = list_sessions()
        # 标记活跃中的会话（当前正在生成回复）
        active_sids = set()
        for sid, owner_id in session_owner.items():
            owner_sess = get_owned_session(owner_id, sid)
            if owner_sess and owner_sess.is_running and owner_sess._message_owner_id:
                active_sids.add(sid)
        for s in sessions:
            sid = s.get("session_id")
            s["is_active"] = sid in active_sids
            owner_id = session_owner.get(sid) if sid else ""
            s["active_owner_id"] = owner_id if s["is_active"] else ""
        total = len(sessions)
        try:
            offset = max(0, int((query or {}).get("offset", ["0"])[0]))
            limit = max(1, min(200, int((query or {}).get("limit", ["200"])[0])))
        except (ValueError, IndexError):
            offset = 0
            limit = 200
        data = {"sessions": sessions[offset:offset + limit], "total": total}
    elif path == "/api/artifacts":
        try:
            limit_sessions = int((query or {}).get("limit_sessions", ["30"])[0])
        except (ValueError, IndexError):
            limit_sessions = 30
        data = list_artifact_records(limit_sessions, href_for_value=artifact_href)
    elif path == "/api/file":
        # 提供上传文件（图片预览）
        file_path = (query or {}).get("path", [""])[0]
        if not file_path:
            await send_response(writer, 400, "text/plain", b"missing path")
            return
        fp = is_allowed_upload_path(file_path)
        if not fp:
            await send_response(writer, 403, "text/plain", b"forbidden")
            return
        if not fp.exists():
            await send_response(writer, 404, "text/plain", b"not found")
            return
        ext = fp.suffix.lower()
        ct = MIME_TYPES.get(ext, "application/octet-stream")
        await send_response(writer, 200, ct, fp.read_bytes())
        return
    elif path == "/api/feishu-gateway/events":
        data = {
            "ok": True,
            "endpoint": "Feishu event subscription",
            "method": "POST",
            "description": "Configure this URL in your Feishu open platform app's event subscription settings.",
            "event_types": ["im.message.receive_v1"],
        }
    else:
        await send_response(writer, 404, "application/json", b'{"error":"not found"}')
        return

    resp_body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    await send_response(writer, 200, "application/json; charset=utf-8", resp_body)


async def handle_api_post(path: str, body: bytes, writer: asyncio.StreamWriter):
    try:
        data = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError:
        await send_response(writer, 400, "application/json", b'{"error":"invalid json"}')
        return

    if path == "/api/settings":
        save_settings(data)
    elif path == "/api/gui-settings":
        if "lan_access_enabled" in data and not is_localhost_ip(get_client_ip(writer)):
            await send_response(writer, 403, "application/json", b'{"error":"localhost only"}')
            return
        result = update_gui_settings(data)
        if data.get("lan_access_enabled") is False:
            await revoke_lan_clients()
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/env":
        update_env_config(data)
    elif path == "/api/feishu-gateway/config":
        result = update_feishu_gateway_config(data)
        result["available"] = FEISHU_GATEWAY_AVAILABLE
        result["unavailable_reason"] = FEISHU_GATEWAY_UNAVAILABLE_REASON
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/feishu-gateway/events":
        if not FEISHU_GATEWAY_AVAILABLE:
            resp = json.dumps({"ok": False, "error": FEISHU_GATEWAY_UNAVAILABLE_REASON}, ensure_ascii=False).encode("utf-8")
            await send_response(writer, 503, "application/json; charset=utf-8", resp)
            return
        result = await get_feishu_gateway().handle_event(data)
        status = 200 if result.get("ok", True) else 400
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, status, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/feishu-gateway/reset-scope":
        scope_key = str(data.get("scope_key") or "").strip()
        chat_id = str(data.get("chat_id") or "").strip()
        if not chat_id and scope_key.startswith("feishu:chat:"):
            chat_id = scope_key.removeprefix("feishu:chat:")
        if not chat_id:
            await send_response(writer, 400, "application/json", b'{"error":"chat_id required"}')
            return
        ok = await get_feishu_gateway().reset_scope(chat_id)
        resp = json.dumps({"ok": ok}, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/feishu-gateway/stop-scope":
        scope_key = str(data.get("scope_key") or "").strip()
        chat_id = str(data.get("chat_id") or "").strip()
        if not chat_id and scope_key.startswith("feishu:chat:"):
            chat_id = scope_key.removeprefix("feishu:chat:")
        if not chat_id:
            await send_response(writer, 400, "application/json", b'{"error":"chat_id required"}')
            return
        ok = await get_feishu_gateway().stop_scope(chat_id)
        resp = json.dumps({"ok": ok}, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/mcp-servers":
        try:
            saved = save_mcp_server(data)
        except ValueError as exc:
            resp = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            await send_response(writer, 400, "application/json; charset=utf-8", resp)
            return
        resp = json.dumps(saved, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/env-profiles":
        name = str(data.get("name", "")).strip()
        env = data.get("env")
        if not name or not isinstance(env, dict):
            await send_response(writer, 400, "application/json", b'{"error":"name and env required"}')
            return
        save_env_profile(name, env)
        await send_response(writer, 200, "application/json", b'{"ok":true}')
        return
    elif path == "/api/env-profiles/delete":
        name = str(data.get("name", "")).strip()
        if not name:
            await send_response(writer, 400, "application/json", b'{"error":"name required"}')
            return
        delete_env_profile(name)
        await send_response(writer, 200, "application/json", b'{"ok":true}')
        return
    elif path == "/api/browse":
        result = browse_directory(data.get("path", ""))
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/mkdir":
        result = create_directory(data.get("parent", ""), data.get("name", ""))
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/browse-files":
        result = browse_files(data.get("path", ""))
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/search-files":
        result = search_files(data.get("path", ""), data.get("query", ""))
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/remote-files/list":
        result = await asyncio.get_event_loop().run_in_executor(None, remote_ls, data.get("target_id", ""), data.get("path", ""))
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/remote-files/cache":
        result = await asyncio.get_event_loop().run_in_executor(None, remote_cache_file, data.get("target_id", ""), data.get("path", ""), data.get("cwd", ""))
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/sessions/toggle-pin":
        sid = data.get("session_id", "")
        pinned = toggle_pin(sid)
        resp = json.dumps({"ok": True, "pinned": pinned}, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/sessions/delete":
        sid = data.get("session_id", "")
        cwd = data.get("cwd", "")
        delete_session(sid, cwd)
        await send_response(writer, 200, "application/json", b'{"ok":true}')
        return
    elif path == "/api/sessions/rename":
        ok, error = rename_session(data.get("session_id", ""), data.get("title", ""))
        status = 200 if ok else 400
        resp = json.dumps({"ok": ok, "error": error}, ensure_ascii=False).encode("utf-8")
        await send_response(writer, status, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/sessions/update-cwd":
        session_id = data.get("session_id", "")
        new_cwd = data.get("cwd", "")
        ok, error = update_session_cwd(session_id, new_cwd)
        if ok:
            owner_id = session_owner.get(session_id)
            if owner_id:
                client_meta.setdefault(owner_id, {})["cwd"] = new_cwd
                cwd_event = {"session_id": session_id, "cwd": new_cwd}
                await push_event(owner_id, "cwd_changed", cwd_event)
                for viewer_id, view_owner in list(client_viewing.items()):
                    if view_owner == owner_id:
                        client_meta.setdefault(viewer_id, {})["cwd"] = new_cwd
                        await push_event(viewer_id, "cwd_changed", cwd_event)
        status = 200 if ok else 400
        resp = json.dumps({"ok": ok, "error": error}, ensure_ascii=False).encode("utf-8")
        await send_response(writer, status, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/sessions/history":
        sid = data.get("session_id", "")
        cwd = data.get("cwd", "")
        history = load_session_history(sid, cwd)
        resp = json.dumps(history, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/upload/delete":
        result = delete_uploaded_files(data.get("paths") or [])
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/scheduled-tasks":
        try:
            task = scheduled_task_store.save_task(data)
        except ValueError as exc:
            resp = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            await send_response(writer, 400, "application/json; charset=utf-8", resp)
            return
        resp = json.dumps(task, ensure_ascii=False).encode("utf-8")
        await publish_scheduled_event("scheduled_task_updated", {"task": task})
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/scheduled-tasks/delete":
        ok = scheduled_task_store.delete_task(str(data.get("id", "")))
        await publish_scheduled_event("scheduled_task_updated", {"tasks": scheduled_task_store.list_tasks()})
        resp = json.dumps({"ok": ok}, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/scheduled-tasks/toggle":
        task = scheduled_task_store.set_task_enabled(str(data.get("id", "")), bool(data.get("enabled", True)))
        if not task:
            await send_response(writer, 404, "application/json", b'{"error":"not found"}')
            return
        await publish_scheduled_event("scheduled_task_updated", {"task": task})
        resp = json.dumps(task, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/scheduled-tasks/run-now":
        task_id = str(data.get("id", ""))
        if not task_id or not scheduled_runner:
            await send_response(writer, 400, "application/json", b'{"error":"invalid task"}')
            return
        asyncio.create_task(scheduled_runner.run_task(task_id, manual=True))
        await send_response(writer, 200, "application/json", b'{"ok":true}')
        return
    elif path == "/api/remote-targets":
        try:
            saved = remote_manager.save_target(data)
        except ValueError as exc:
            resp = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            await send_response(writer, 400, "application/json; charset=utf-8", resp)
            return
        resp = json.dumps(saved, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/remote-targets/delete":
        remote_manager.delete_target(data.get("id", ""))
        await send_response(writer, 200, "application/json", b'{"ok":true}')
        return
    elif path == "/api/remote-targets/test":
        target = data if data.get("host") else data.get("id", "")
        result = await asyncio.get_event_loop().run_in_executor(None, remote_manager.test_target, target)
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/install-cli":
        result = await install_cli()
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/update":
        result = await apply_update()
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/restart":
        await send_response(writer, 200, "application/json", b'{"ok":true}')
        # 先把响应发出去，再延迟重启，确保前端能进入轮询
        asyncio.get_event_loop().call_later(0.5, restart_server)
        return
    elif path == "/api/clis":
        cli_path = data.get("path", "")
        if cli_path:
            set_current_cli(cli_path)
            update_gui_settings({"cli_path": cli_path})
            await send_response(writer, 200, "application/json", b'{"ok":true}')
        else:
            await send_response(writer, 400, "application/json", b'{"error":"missing path"}')
        return
    elif path == "/api/agents":
        try:
            saved = create_agent(data)
        except ValueError as exc:
            resp = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            await send_response(writer, 400, "application/json; charset=utf-8", resp)
            return
        resp = json.dumps(saved, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/agents/update":
        try:
            updated = update_agent(str(data.get("name", "")), data)
        except ValueError as exc:
            resp = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            await send_response(writer, 400, "application/json; charset=utf-8", resp)
            return
        resp = json.dumps(updated, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/skills/delete":
        try:
            delete_skill(str(data.get("dir", "")))
        except ValueError as exc:
            resp = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            await send_response(writer, 400, "application/json; charset=utf-8", resp)
            return
        await send_response(writer, 200, "application/json", b'{"ok":true}')
        return
    elif path == "/api/agents/delete":
        try:
            delete_agent(str(data.get("name", "")))
        except ValueError as exc:
            resp = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            await send_response(writer, 400, "application/json; charset=utf-8", resp)
            return
        await send_response(writer, 200, "application/json", b'{"ok":true}')
        return
    elif path == "/api/session/agents":
        cid = str(data.get("id", ""))
        action = str(data.get("action", ""))
        agent = str(data.get("agent", "")).strip()
        if not cid or not agent:
            await send_response(writer, 400, "application/json; charset=utf-8",
                                json.dumps({"error": "missing id or agent"}, ensure_ascii=False).encode())
            return
        agents = client_session_agents.setdefault(cid, [])
        if action == "add":
            if agent not in agents:
                agents.append(agent)
        elif action == "remove":
            if agent in agents:
                agents.remove(agent)
        resp = json.dumps({"agents": agents}, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/memory/file":
        filename = data.get("filename", "")
        cwd = data.get("cwd", DEFAULT_CWD)
        result = get_memory_file(filename, cwd)
        if not result:
            await send_response(writer, 404, "application/json", b'{"error":"not found"}')
        else:
            resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
            await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    elif path == "/api/memory/delete":
        filename = data.get("filename", "")
        cwd = data.get("cwd", DEFAULT_CWD)
        ok = delete_memory_file(filename, cwd)
        if ok:
            await send_response(writer, 200, "application/json", b'{"ok":true}')
        else:
            await send_response(writer, 404, "application/json", b'{"error":"not found"}')
        return
    elif path == "/api/memory/update":
        filename = data.get("filename", "")
        content = data.get("content", "")
        cwd = data.get("cwd", DEFAULT_CWD)
        if not filename or not content:
            await send_response(writer, 400, "application/json", b'{"error":"filename and content required"}')
            return
        result = save_memory_file(filename, content, cwd)
        if result:
            resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
            await send_response(writer, 200, "application/json; charset=utf-8", resp)
        else:
            await send_response(writer, 500, "application/json", b'{"error":"save failed"}')
        return
    elif path == "/api/memory/index":
        cwd = data.get("cwd", DEFAULT_CWD)
        count = index_memory(cwd, force=True)
        resp = json.dumps({"count": count, "ok": count >= 0}, ensure_ascii=False).encode("utf-8")
        await send_response(writer, 200, "application/json; charset=utf-8", resp)
        return
    else:
        await send_response(writer, 404, "application/json", b'{"error":"not found"}')
        return

    await send_response(writer, 200, "application/json", b'{"ok":true}')


# ─── 静态文件 ──────────────────────────────────────────────
async def handle_static(path: str, writer: asyncio.StreamWriter):
    if path == "/" or path == "":
        path = "/index.html"

    if path.startswith("/static/"):
        file_path = STATIC_DIR / path[8:]
    else:
        file_path = STATIC_DIR / path.lstrip("/")

    try:
        file_path = file_path.resolve()
        if not str(file_path).startswith(str(STATIC_DIR.resolve())):
            await send_response(writer, 403, "text/plain", b"Forbidden")
            return
    except Exception:
        await send_response(writer, 400, "text/plain", b"Bad request")
        return

    if not file_path.exists() or not file_path.is_file():
        await send_response(writer, 404, "text/plain", b"Not Found")
        return

    ext = file_path.suffix.lower()
    content_type = MIME_TYPES.get(ext, "application/octet-stream")
    content = file_path.read_bytes()

    # 给 HTML 中的 app.js / style.css 注入基于文件修改时间的版本号，
    # 避免浏览器使用缓存的旧脚本/样式。
    if ext in (".html", ".htm"):
        try:
            text = content.decode("utf-8")
            for asset in ("app.js", "style.css"):
                asset_path = STATIC_DIR / asset
                if asset_path.exists():
                    ver = int(asset_path.stat().st_mtime)
                    text = text.replace(f"/static/{asset}", f"/static/{asset}?v={ver}")
            content = text.encode("utf-8")
        except Exception:
            pass

    await send_response(writer, 200, content_type, content)


async def send_response(writer: asyncio.StreamWriter, status: int, content_type: str, body: bytes):
    status_text = {
        200: "OK",
        201: "Created",
        204: "No Content",
        400: "Bad Request",
        403: "Forbidden",
        404: "Not Found",
        413: "Payload Too Large",
        500: "Internal Server Error",
    }
    response = (
        f"HTTP/1.1 {status} {status_text.get(status, 'Unknown')}\r\n"
        f"Content-Type: {content_type}\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Cache-Control: no-cache, no-store\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Connection: close\r\n"
        "\r\n"
    )
    writer.write(response.encode() + body)
    await writer.drain()


async def run_server(port: int = DEFAULT_PORT, cleanup_old_servers: bool = True):
    if cleanup_old_servers:
        cleanup_existing_app_servers()

    # 恢复上次选中的 CLI（启动时 _current_cli 默认是第一个检测到的，这里覆盖为用户上次的选择）
    saved_cli = get_gui_settings().get("cli_path", "")
    if saved_cli and saved_cli in [c["path"] for c in get_available_clis()]:
        set_current_cli(saved_cli)

    server = await asyncio.start_server(handle_http, HOST, port)

    local_url = f"http://{BROWSER_HOST}:{port}"
    lan_urls = [f"http://{ip}:{port}" for ip in get_lan_ips()]

    print(f"[CC Bridge] Server running at {local_url}")
    for lan_url in lan_urls:
        print(f"[CC Bridge] LAN access: {lan_url}")
    if not lan_urls:
        print("[CC Bridge] LAN access: no LAN IPv4 address detected")
    print(f"[CC Bridge] Press Ctrl+C to stop")

    # 自动打开浏览器（仅当显式设置环境变量时启用）
    if os.environ.get("CCB_GUI_OPEN_BROWSER") == "1":
        import webbrowser
        webbrowser.open(local_url)

    async with server:
        try:
            await server.serve_forever()
        except asyncio.CancelledError:
            pass


async def main():
    global scheduled_runner
    cleanup_existing_app_servers()

    # 恢复上次选中的 CLI（启动时 _current_cli 默认是第一个检测到的，这里覆盖为用户上次的选择）
    saved_cli = get_gui_settings().get("cli_path", "")
    if saved_cli and saved_cli in [c["path"] for c in get_available_clis()]:
        set_current_cli(saved_cli)

    server = None
    last_error = None
    for port in range(DEFAULT_PORT, 65536):
        try:
            server = await asyncio.start_server(handle_http, HOST, port)
            break
        except OSError as exc:
            last_error = exc

    if server is None:
        raise RuntimeError(f"Unable to bind port {DEFAULT_PORT}-65535: {last_error}")

    local_url = f"http://{BROWSER_HOST}:{port}"
    lan_urls = [f"http://{ip}:{port}" for ip in get_lan_ips()]

    if port != DEFAULT_PORT:
        print(f"[CC Bridge] Port {DEFAULT_PORT} is unavailable, using {port}")
    print(f"[CC Bridge] Server running at {local_url}")
    for lan_url in lan_urls:
        print(f"[CC Bridge] LAN access: {lan_url}")
    if not lan_urls:
        print("[CC Bridge] LAN access: no LAN IPv4 address detected")
    print(f"[CC Bridge] Press Ctrl+C to stop")

    # 自动打开浏览器（仅当显式设置环境变量时启用）
    if os.environ.get("CCB_GUI_OPEN_BROWSER") == "1":
        import webbrowser
        webbrowser.open(local_url)

    scheduled_runner = ScheduledTaskRunner(publish_scheduled_event)
    scheduled_task = asyncio.create_task(scheduled_runner.start())

    async with server:
        try:
            await server.serve_forever()
        except asyncio.CancelledError:
            pass
        finally:
            scheduled_runner.stop()
            scheduled_task.cancel()
            try:
                await scheduled_task
            except asyncio.CancelledError:
                pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[CC Bridge] Server stopped.")
