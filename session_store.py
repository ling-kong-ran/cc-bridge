"""
Session Store - 会话元数据持久化
存储位置: ~/.claude/gui_sessions.json
"""
import html
import json
import os
import re
import uuid
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Optional

# --- 历史消息缓存 ---
# key: (str(path), mtime, size) → value: list[dict] (全量消息列表)
_HISTORY_CACHE_MAX = 30
_history_cache: "OrderedDict[tuple, list]" = OrderedDict()

STORE_PATH = Path.home() / ".claude" / "gui_sessions.json"
PROJECTS_DIR = Path.home() / ".claude" / "projects"
HIDDEN_PATH = Path.home() / ".claude" / "gui_hidden_sessions.json"


def empty_tokens() -> dict:
    return {"input": 0, "output": 0, "cache_creation": 0, "cache_read": 0}


def normalize_tokens(tokens: Optional[dict]) -> dict:
    result = empty_tokens()
    if not isinstance(tokens, dict):
        return result
    for key in result:
        try:
            result[key] = max(0, int(tokens.get(key) or 0))
        except (TypeError, ValueError):
            result[key] = 0
    return result


def _load_hidden() -> set[str]:
    """读取被隐藏（已从 GUI 删除）的会话 id 集合。"""
    if not HIDDEN_PATH.exists():
        return set()
    try:
        data = json.loads(HIDDEN_PATH.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return {str(x) for x in data if x}
    except (json.JSONDecodeError, OSError):
        pass
    return set()


def _save_hidden(hidden: set[str]):
    HIDDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    HIDDEN_PATH.write_text(json.dumps(sorted(hidden), ensure_ascii=False, indent=2), encoding="utf-8")



def _load() -> list[dict]:
    if not STORE_PATH.exists():
        return []
    try:
        return json.loads(STORE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def _save(sessions: list[dict]):
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STORE_PATH.write_text(json.dumps(sessions, ensure_ascii=False, indent=2), encoding="utf-8")


def list_sessions() -> list[dict]:
    """返回本机所有历史会话，按底层 jsonl 修改时间倒序。"""
    indexed_sessions = _load()
    hidden = _load_hidden()

    # 先扫描本地 jsonl 一次（只读头尾），结果复用：既用于合并，也用于刷新已索引会话的标题，
    # 避免对每个已索引会话再单独读一次文件。
    discovered_list = discover_local_sessions()
    discovered_by_id = {d.get("session_id"): d for d in discovered_list if d.get("session_id")}

    changed = False
    for s in indexed_sessions:
        if "total_cost_usd" not in s:
            s["total_cost_usd"] = 0
            changed = True
        if "total_tokens" not in s:
            s["total_tokens"] = empty_tokens()
            changed = True
        if not s.get("manual_title"):
            fresh_title = (discovered_by_id.get(s.get("session_id", "")) or {}).get("title", "")
            if fresh_title and s.get("title") != fresh_title:
                s["title"] = fresh_title
                changed = True
    if changed:
        _save(indexed_sessions)

    sessions_by_id = {
        s.get("session_id"): dict(s)
        for s in indexed_sessions
        if s.get("session_id") and s.get("session_id") not in hidden
    }

    for discovered in discovered_list:
        sid = discovered.get("session_id")
        if not sid or sid in hidden:
            continue
        existing = sessions_by_id.get(sid, {})
        merged = dict(discovered)
        if existing:
            if existing.get("manual_title"):
                merged["title"] = existing.get("title", "")
            else:
                merged["title"] = discovered.get("title") or existing.get("title", "")
            merged["model"] = discovered.get("model") or existing.get("model", "")
            merged["cwd"] = existing.get("cwd") or discovered.get("cwd", "")
            merged["total_cost_usd"] = float(existing.get("total_cost_usd") or 0)
            merged["total_tokens"] = normalize_tokens(existing.get("total_tokens"))
            merged["remote_target_id"] = existing.get("remote_target_id", "")
            merged["cli"] = existing.get("cli", "")
            merged["pinned"] = bool(existing.get("pinned"))
            merged["manual_title"] = bool(existing.get("manual_title"))
            merged["created_at"] = existing.get("created_at") or discovered.get("created_at", "")
            merged["source"] = existing.get("source") or "gui"
            if existing.get("scheduled_task_id"):
                merged["scheduled_task_id"] = existing.get("scheduled_task_id", "")
            if existing.get("scheduled_task_name"):
                merged["scheduled_task_name"] = existing.get("scheduled_task_name", "")
        sessions_by_id[sid] = merged

    sessions = list(sessions_by_id.values())
    sessions.sort(key=lambda s: (not bool(s.get("pinned")), -(s.get("mtime", 0) or 0)))
    return sessions


def discover_local_sessions() -> list[dict]:
    """扫描 ~/.claude/projects 下的顶层会话 jsonl。"""
    if not PROJECTS_DIR.exists():
        return []

    sessions = []
    try:
        project_dirs = [p for p in PROJECTS_DIR.iterdir() if p.is_dir()]
    except OSError:
        return []

    for project_dir in project_dirs:
        try:
            jsonl_files = [p for p in project_dir.iterdir() if p.is_file() and p.suffix == ".jsonl"]
        except OSError:
            continue
        for jsonl_path in jsonl_files:
            entry = parse_session_jsonl(jsonl_path)
            if entry:
                sessions.append(entry)
    return sessions


_PARSE_CACHE: dict[str, tuple[float, int, "dict | None"]] = {}


def parse_session_jsonl(jsonl_path: Path) -> dict | None:
    """从 jsonl 提取会话元数据（标题/cwd/model/时间），只读头尾各一小段，不读整文件。

    结果按 (path, mtime, size) 缓存：会话列表频繁刷新时命中缓存，不再读文件。
    """
    try:
        stat = jsonl_path.stat()
        mtime = stat.st_mtime
        size = stat.st_size
    except OSError:
        return None

    cache_key = str(jsonl_path)
    cached = _PARSE_CACHE.get(cache_key)
    if cached and cached[0] == mtime and cached[1] == size:
        return cached[2]

    session_id = jsonl_path.stem
    updated_at = datetime.fromtimestamp(mtime).isoformat(timespec="seconds")

    cap = 1 << 20  # 1MB：小文件一次读完，大文件只读头尾各 1MB
    if size <= cap:
        cwd = model = first_ts = ""
        last_text = last_prompt = ""
        try:
            with jsonl_path.open("rb") as f:
                data = f.read()
        except OSError:
            return None
        for raw in data.split(b"\n"):
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                continue
            if not cwd and obj.get("cwd"):
                cwd = obj.get("cwd", "")
            if not first_ts and obj.get("timestamp"):
                first_ts = obj.get("timestamp", "")
            if not model:
                msg = obj.get("message", {})
                if isinstance(msg, dict) and msg.get("model"):
                    model = msg.get("model", "")
            mtype = obj.get("type", "")
            if mtype == "user":
                text = _extract_user_text(obj)
                if text:
                    last_text = text
            elif mtype == "last-prompt":
                prompt = _clean_user_text(obj.get("lastPrompt", ""))
                if prompt:
                    last_prompt = prompt
    else:
        cwd, model, first_ts = _read_head_meta(jsonl_path, cap)
        last_text, last_prompt = _scan_tail_meta(jsonl_path, cap)

    title = (last_prompt or last_text)[:50]

    # 探测类启动（如读取 slash 命令的 /help 短命会话）只会留下没有真实用户
    # 消息、也没有 last-prompt 的空 jsonl。跳过它们，避免列表里冒出空"新会话"。
    if (
        not last_prompt
        and (not title or title == "Unknown skill: help")
    ):
        _PARSE_CACHE[cache_key] = (mtime, size, None)
        return None

    entry = {
        "session_id": session_id,
        "title": title or "新会话",
        "model": model,
        "cwd": cwd,
        "total_cost_usd": 0,
        "total_tokens": empty_tokens(),
        "created_at": first_ts or updated_at,
        "updated_at": updated_at,
        "mtime": mtime,
        "source": "local",
    }
    _PARSE_CACHE[cache_key] = (mtime, size, entry)
    return entry


def save_session(session_id: str, title: str, model: str, cwd: str,
                 remote_target_id: str = "", cli: str = "",
                 scheduled_task_id: str = "", scheduled_task_name: str = "") -> dict:
    """创建或更新会话记录"""
    sessions = _load()
    now = datetime.now().isoformat(timespec="seconds")

    # 若该会话之前被删除（隐藏），重新激活时取消隐藏
    hidden = _load_hidden()
    if session_id in hidden:
        hidden.discard(session_id)
        _save_hidden(hidden)

    # 查找已有记录
    for s in sessions:
        if s["session_id"] == session_id:
            # 已手动重命名的会话保留其标题，不被自动标题覆盖
            if title and not s.get("manual_title"):
                s["title"] = title
                s["manual_title"] = False
            else:
                s["title"] = s.get("title", "")
            s["model"] = model
            if not s.get("cwd"):
                s["cwd"] = cwd
            s["total_cost_usd"] = float(s.get("total_cost_usd") or 0)
            s["total_tokens"] = normalize_tokens(s.get("total_tokens"))
            s["updated_at"] = now
            s["remote_target_id"] = remote_target_id
            s["pinned"] = bool(s.get("pinned"))
            if cli:
                s["cli"] = cli
            if scheduled_task_id:
                s["scheduled_task_id"] = scheduled_task_id
            if scheduled_task_name:
                s["scheduled_task_name"] = scheduled_task_name
            _save(sessions)
            return s

    # 新建记录
    entry = {
        "session_id": session_id,
        "title": title or "新会话",
        "model": model,
        "cwd": cwd,
        "cli": cli,
        "total_cost_usd": 0,
        "total_tokens": empty_tokens(),
        "remote_target_id": remote_target_id,
        "created_at": now,
        "updated_at": now,
    }
    if scheduled_task_id:
        entry["scheduled_task_id"] = scheduled_task_id
    if scheduled_task_name:
        entry["scheduled_task_name"] = scheduled_task_name
    sessions.insert(0, entry)
    _save(sessions)
    return entry


def add_session_usage(session_id: str, cost_usd: float = 0, tokens: Optional[dict] = None) -> dict:
    """一次性累加会话费用和 token 用量，减少重复读写。"""
    try:
        cost = max(0, float(cost_usd or 0))
    except (TypeError, ValueError):
        cost = 0
    usage = normalize_tokens(tokens)
    if not session_id or (cost <= 0 and not any(usage.values())):
        return {"total_cost_usd": 0, "total_tokens": empty_tokens()}

    sessions = _load()
    now = datetime.now().isoformat(timespec="seconds")
    for s in sessions:
        if s["session_id"] == session_id:
            if cost > 0:
                s["total_cost_usd"] = round(float(s.get("total_cost_usd") or 0) + cost, 8)
            total_tokens = normalize_tokens(s.get("total_tokens"))
            if any(usage.values()):
                for key, value in usage.items():
                    total_tokens[key] += value
                s["total_tokens"] = total_tokens
            s["updated_at"] = now
            _save(sessions)
            return {
                "total_cost_usd": float(s.get("total_cost_usd") or 0),
                "total_tokens": normalize_tokens(s.get("total_tokens")),
            }

    return {"total_cost_usd": 0, "total_tokens": empty_tokens()}


def add_session_cost(session_id: str, cost_usd: float) -> float:
    """累加会话费用并返回最新累计值。"""
    return float(add_session_usage(session_id, cost_usd=cost_usd).get("total_cost_usd") or 0)


def add_session_tokens(session_id: str, tokens: dict) -> dict:
    """累加会话 token 用量并返回最新累计值。"""
    return normalize_tokens(add_session_usage(session_id, tokens=tokens).get("total_tokens"))


def _delete_session_files(session_id: str, cwd: str = "") -> bool:
    """删除会话的本地转录文件 ~/.claude/projects/<dir>/<session_id>.jsonl。

    优先用 cwd 推导路径，同时扫描所有项目目录兜底（cwd 可能缺失或与实际目录不一致）。
    返回是否至少删除了一个文件。
    """
    targets = []
    if cwd:
        targets.append(_jsonl_path(session_id, cwd))
    if PROJECTS_DIR.exists():
        try:
            for project_dir in PROJECTS_DIR.iterdir():
                if project_dir.is_dir():
                    targets.append(project_dir / f"{session_id}.jsonl")
        except OSError:
            pass

    deleted = False
    seen = set()
    for path in targets:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        try:
            if path.exists() and path.is_file():
                path.unlink()
                deleted = True
        except OSError:
            pass
    return deleted


def toggle_pin(session_id: str) -> bool:
    """切换会话置顶状态，返回当前 pinned 值。"""
    if not session_id:
        return False
    sessions = _load()
    now = datetime.now().isoformat(timespec="seconds")
    for s in sessions:
        if s["session_id"] == session_id:
            s["pinned"] = not s.get("pinned", False)
            s["updated_at"] = now
            _save(sessions)
            return s["pinned"]

    # 会话不在 GUI 索引中（由 CLI 原生创建），插入一条 pinned 记录
    discovered = next((s for s in discover_local_sessions() if s.get("session_id") == session_id), None)
    if discovered:
        discovered["pinned"] = True
        discovered["total_cost_usd"] = float(discovered.get("total_cost_usd") or 0)
        discovered["total_tokens"] = normalize_tokens(discovered.get("total_tokens"))
        discovered["updated_at"] = now
        sessions.insert(0, discovered)
        _save(sessions)
        return True
    return False


def delete_session(session_id: str, cwd: str = "") -> bool:
    """彻底删除会话：移除 GUI 索引并删除本地转录文件，不可恢复。

    若转录文件因被占用等原因无法删除，则记入隐藏集合，保证其不再出现在列表中。
    """
    if not session_id:
        return False

    sessions = _load()
    new_sessions = [s for s in sessions if s["session_id"] != session_id]
    if len(new_sessions) < len(sessions):
        _save(new_sessions)

    removed_file = _delete_session_files(session_id, cwd)

    if not removed_file:
        # 文件未能删除（可能正被占用），隐藏以免重新出现
        hidden = _load_hidden()
        if session_id not in hidden:
            hidden.add(session_id)
            _save_hidden(hidden)
    return True


def get_session(session_id: str) -> Optional[dict]:
    """获取单条会话记录"""
    for s in _load():
        if s["session_id"] == session_id:
            return s
    return None


def rename_session(session_id: str, title: str) -> tuple[bool, str]:
    """手动重命名会话标题。"""
    title = (title or "").strip()[:80]
    if not session_id:
        return False, "missing_session_id"
    if not title:
        return False, "empty_title"

    sessions = _load()
    now = datetime.now().isoformat(timespec="seconds")
    for s in sessions:
        if s["session_id"] == session_id:
            s["title"] = title
            s["manual_title"] = True
            s["updated_at"] = now
            _save(sessions)
            return True, ""

    discovered = next((s for s in discover_local_sessions() if s.get("session_id") == session_id), None)
    if not discovered:
        return False, "not_found"

    discovered["title"] = title
    discovered["manual_title"] = True
    discovered["total_cost_usd"] = float(discovered.get("total_cost_usd") or 0)
    discovered["total_tokens"] = normalize_tokens(discovered.get("total_tokens"))
    discovered["updated_at"] = now
    sessions.insert(0, discovered)
    _save(sessions)
    return True, ""


def update_session_cwd(session_id: str, new_cwd: str) -> tuple[bool, str]:
    """更新会话的工作目录，并将 JSONL 转录文件迁移到新项目目录。"""
    if not session_id:
        return False, "missing_session_id"
    new_cwd = (new_cwd or "").strip()
    if not new_cwd:
        return False, "empty_cwd"
    if not os.path.isdir(new_cwd):
        return False, "cwd_not_exist"

    sessions = _load()
    now = datetime.now().isoformat(timespec="seconds")

    old_cwd = ""
    for s in sessions:
        if s["session_id"] == session_id:
            old_cwd = (s.get("cwd") or "").strip()
            s["cwd"] = new_cwd
            s["updated_at"] = now
            _save(sessions)
            _migrate_session_file(session_id, old_cwd, new_cwd)
            return True, ""

    # 会话不在索引中（由 CLI 原生创建），插入新记录
    discovered = next((s for s in discover_local_sessions() if s.get("session_id") == session_id), None)
    if discovered:
        old_cwd = (discovered.get("cwd") or "").strip()
        discovered["cwd"] = new_cwd
        discovered["total_cost_usd"] = float(discovered.get("total_cost_usd") or 0)
        discovered["total_tokens"] = normalize_tokens(discovered.get("total_tokens"))
        discovered["updated_at"] = now
        sessions.insert(0, discovered)
        _save(sessions)
        _migrate_session_file(session_id, old_cwd, new_cwd)
        return True, ""

    # 完全不存在的会话，也可能有残留的 JSONL 文件需要迁移
    _migrate_session_file(session_id, "", new_cwd)
    return False, "not_found"


def _migrate_session_file(session_id: str, old_cwd: str, new_cwd: str) -> bool:
    """将会话 JSONL 文件从旧项目目录迁移到新项目目录。

    优先根据 old_cwd 定位，找不到时扫描 ~/.claude/projects/ 全目录。
    返回 True 表示成功迁移或无需迁移。
    """
    if not new_cwd:
        return False

    # 用 fallback 查找现有 JSONL 文件
    old_path = _find_jsonl_path(session_id, old_cwd) if old_cwd else None
    if not old_path:
        old_path = _find_jsonl_path(session_id, "")  # 全量扫描
    if not old_path:
        return False  # 没有任何旧文件，无需迁移

    new_path = _jsonl_path(session_id, new_cwd)
    if old_path.resolve() == new_path.resolve():
        return True  # 已在目标位置

    if new_path.exists():
        # 目标位置已有文件 — 合并：如果新文件更新则保留新文件
        try:
            if new_path.stat().st_mtime >= old_path.stat().st_mtime:
                old_path.unlink()  # 删掉旧的
            else:
                old_path.unlink()  # 旧文件更新，但 rename 会覆盖...换个策略：删旧留新
                # 新的有数据不动，旧的删掉
        except OSError:
            pass
        return True

    try:
        new_path.parent.mkdir(parents=True, exist_ok=True)
        old_path.rename(new_path)

        # 如果旧项目目录已空，清理之
        try:
            remaining = list(old_path.parent.iterdir())
            if not remaining:
                old_path.parent.rmdir()
        except OSError:
            pass
        return True
    except OSError:
        return False  # 迁移失败


def _sanitize_cwd(cwd: str) -> str:
    """将 cwd 转为 ccb 的项目目录名格式 (与 ccb sanitizePath 一致: 所有非字母数字→'-')"""
    import re
    return re.sub(r'[^a-zA-Z0-9]', '-', cwd)


def _jsonl_path(session_id: str, cwd: str) -> Path:
    sanitized = _sanitize_cwd(cwd)
    return Path.home() / ".claude" / "projects" / sanitized / f"{session_id}.jsonl"


def _find_jsonl_path(session_id: str, cwd: str) -> Path | None:
    """查找会话 JSONL 文件：先在 CWD 对应项目目录找，找不到则扫描所有项目目录。"""
    # 优先精确路径
    if cwd:
        exact = _jsonl_path(session_id, cwd)
        if exact.exists():
            return exact

    # Fallback: 扫描所有项目目录（处理 CWD 变更后旧路径的遗留文件）
    if PROJECTS_DIR.exists():
        try:
            for project_dir in PROJECTS_DIR.iterdir():
                if not project_dir.is_dir():
                    continue
                candidate = project_dir / f"{session_id}.jsonl"
                if candidate.exists():
                    return candidate
        except OSError:
            pass

    return None


def append_generated_image_message(session_id: str, cwd: str, prompt: str, result: dict) -> bool:
    """把 GUI 生图结果追加到当前会话 JSONL，供历史恢复。"""
    if not session_id:
        return False
    jsonl_path = _find_jsonl_path(session_id, cwd) or _jsonl_path(session_id, cwd)
    now = datetime.utcnow().isoformat(timespec="milliseconds") + "Z"
    user_message = {
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": f"生图：{prompt}"}],
        },
        "uuid": str(uuid.uuid4()),
        "timestamp": now,
        "sessionId": session_id,
        "isSidechain": False,
    }
    assistant_message = {
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "ccb_generated_image",
                "provider": result.get("provider", ""),
                "model": result.get("model", ""),
                "prompt": prompt,
                "size": result.get("size", ""),
                "aspect_ratio": result.get("aspect_ratio", ""),
                "quality": result.get("quality", ""),
                "images": result.get("images") or [],
                "request_id": result.get("request_id", ""),
                "usage": result.get("usage") or {},
            }],
        },
        "uuid": str(uuid.uuid4()),
        "timestamp": now,
        "sessionId": session_id,
        "isSidechain": False,
    }
    try:
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        with jsonl_path.open("ab") as f:
            f.write((json.dumps(user_message, ensure_ascii=False) + "\n").encode("utf-8"))
            f.write((json.dumps(assistant_message, ensure_ascii=False) + "\n").encode("utf-8"))
        invalidate_history_cache(session_id, cwd)
        return True
    except OSError:
        return False


def _generated_image_block(block: dict) -> dict:
    return {
        "type": "generated_image",
        "provider": block.get("provider", ""),
        "model": block.get("model", ""),
        "prompt": block.get("prompt", ""),
        "size": block.get("size", ""),
        "aspect_ratio": block.get("aspect_ratio", ""),
        "quality": block.get("quality", ""),
        "images": block.get("images") or [],
        "request_id": block.get("request_id", ""),
        "usage": block.get("usage") or {},
    }


def _append_assistant_block(blocks: list, block: dict):
    btype = block.get("type")
    if btype == "text" and block.get("text"):
        blocks.append({"type": "text", "text": block["text"]})
    elif btype == "thinking" and block.get("thinking"):
        blocks.append({"type": "thinking", "thinking": block["thinking"]})
    elif btype == "ccb_generated_image":
        blocks.append(_generated_image_block(block))


def _extract_user_text(obj: dict) -> str:
    text = _extract_raw_user_text(obj)
    user_text, _ = _split_injected_context(text)
    return _clean_user_text(user_text)


def _extract_raw_user_text(obj: dict) -> str:
    content = obj.get("message", {}).get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for block in content:
            if block.get("type") == "text":
                return block.get("text", "") or ""
    return ""


_CONTEXT_PREFIX_RE = re.compile(
    r"^\s*<cc_bridge_context>([\s\S]*?)</cc_bridge_context>\s*\n*\s*<user_request>\s*\n?([\s\S]*?)\n?\s*</user_request>\s*$",
    re.IGNORECASE,
)
_MEMORY_TAG_RE = re.compile(r"<memory\s+([^>]*)>([\s\S]*?)</memory>", re.IGNORECASE)
_ATTR_RE = re.compile(r"([\w:-]+)=\"([^\"]*)\"")


def _split_injected_context(text: str) -> tuple[str, dict | None]:
    """把注入上下文拆成原始用户请求和可用于前端复现命中卡片的 trace。"""
    match = _CONTEXT_PREFIX_RE.match(text or "")
    if not match:
        return text, None
    context_body, user_text = match.groups()
    injected = []
    used_tokens = 0
    for item_match in _MEMORY_TAG_RE.finditer(context_body or ""):
        attrs = {
            key: html.unescape(value)
            for key, value in _ATTR_RE.findall(item_match.group(1) or "")
        }
        content = (item_match.group(2) or "").strip()
        tokens = _estimate_tokens(content)
        used_tokens += tokens
        score = attrs.get("score") or 0
        try:
            score = float(score)
        except (TypeError, ValueError):
            score = 0
        injected.append({
            "id": attrs.get("id", ""),
            "title": attrs.get("title", ""),
            "source": attrs.get("source", ""),
            "path": attrs.get("path", ""),
            "score": score,
            "tokens": tokens,
            "compressed": str(attrs.get("compressed", "")).lower() == "true",
            "reason": "历史消息中的自动上下文注入",
            "content": content,
        })
    trace = {
        "used_tokens": used_tokens,
        "injected": injected,
        "skipped": [],
        "from_history": True,
    } if injected else None
    return user_text.strip(), trace


def _estimate_tokens(text: str) -> int:
    text = text or ""
    chinese_chars = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    other_chars = max(0, len(text) - chinese_chars)
    return max(1, chinese_chars + other_chars // 4)


def _clean_user_text(text: str) -> str:
    text = (text or "").strip()
    if (
        text.startswith("<local-command-")
        or text.startswith("<command-name>")
        or text.startswith("This session is being continued from a previous conversation")
        or text.startswith("Unknown skill:")
    ):
        return ""
    return text


def _extract_tool_results(obj: dict) -> dict[str, dict]:
    """从 user 事件中提取 tool_result，按 tool_use_id 返回。"""
    content = obj.get("message", {}).get("content", "")
    results = {}
    if not isinstance(content, list):
        return results
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_result":
            continue
        tool_use_id = block.get("tool_use_id")
        if not tool_use_id:
            continue
        result_content = block.get("content", "")
        if isinstance(result_content, list):
            texts = []
            for item in result_content:
                if isinstance(item, dict) and item.get("type") == "text":
                    texts.append(item.get("text", ""))
            result_content = "\n".join(texts)
        elif not isinstance(result_content, str):
            result_content = json.dumps(result_content, ensure_ascii=False)
        if len(result_content) > 8000:
            result_content = result_content[:8000] + "\n... (truncated)"
        results[str(tool_use_id)] = {
            "content": result_content,
            "is_error": bool(block.get("is_error")),
        }
    return results


def get_last_user_message(session_id: str, cwd: str) -> str:
    """读取会话文件中的最后一条用户消息（只读文件尾部，不读整文件）。"""
    if not session_id:
        return ""

    jsonl_path = _find_jsonl_path(session_id, cwd)
    if not jsonl_path:
        return ""

    last_text, last_prompt = _scan_tail_meta(jsonl_path)
    return last_prompt or last_text


def _iter_lines_reversed(path):
    """从文件末尾向前逐行 yield (line_start_byte_offset, raw_bytes)。

    只读末尾需要的行，避免对超长会话整文件解析。跳过空行。
    """
    chunk_size = 1 << 16  # 64KB
    with path.open("rb") as f:
        f.seek(0, os.SEEK_END)
        pos = f.tell()
        leftover = b""
        while pos > 0:
            read_size = min(chunk_size, pos)
            new_pos = pos - read_size
            f.seek(new_pos)
            chunk = f.read(read_size)
            data = chunk + leftover  # 老字节 + 上轮未处理的半行
            parts = data.split(b"\n")
            leftover = parts[0]  # 最老半行，留到下一轮拼接
            running = new_pos + len(parts[0])
            collected = []
            for i in range(1, len(parts)):
                running += 1  # 跨过上一个 \n
                line = parts[i]
                if line:
                    collected.append((running, line))
                running += len(line)
            for item in reversed(collected):
                yield item
            pos = new_pos
        if leftover:
            yield (0, leftover)


def _scan_tail_meta(path, max_bytes: int = 1 << 20):
    """反向扫描文件尾部，返回 (last_user_text, last_prompt)。

    只读末尾 max_bytes 字节，用于会话列表展示的标题，不读整文件。
    """
    last_text = ""
    last_prompt = ""
    found_text = False
    found_prompt = False
    consumed = 0
    try:
        for _pos, raw in _iter_lines_reversed(path):
            consumed += len(raw) + 1
            if consumed > max_bytes:
                break
            try:
                obj = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                continue
            mtype = obj.get("type", "")
            if mtype == "user":
                if not found_text:
                    text = _extract_user_text(obj)
                    if text:
                        last_text = text
                        found_text = True
            elif mtype == "last-prompt":
                if not found_prompt:
                    prompt = _clean_user_text(obj.get("lastPrompt", ""))
                    if prompt:
                        last_prompt = prompt
                        found_prompt = True
            if found_text and found_prompt:
                break
    except OSError:
        pass
    return last_text, last_prompt


def _read_head_meta(path, max_bytes: int = 1 << 20):
    """正向读取文件头部，返回 {cwd, model, first_ts}，只读头部 max_bytes 字节。"""
    cwd = ""
    model = ""
    first_ts = ""
    try:
        with path.open("rb") as f:
            data = f.read(max_bytes)
    except OSError:
        return cwd, model, first_ts
    # 丢弃末尾可能被截断的不完整行
    parts = data.split(b"\n")
    if not data.endswith(b"\n"):
        parts = parts[:-1]
    for raw in parts:
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        if not cwd and obj.get("cwd"):
            cwd = obj.get("cwd", "")
        if not first_ts and obj.get("timestamp"):
            first_ts = obj.get("timestamp", "")
        if not model:
            msg = obj.get("message", {})
            if isinstance(msg, dict) and msg.get("model"):
                model = msg.get("model", "")
        if cwd and model and first_ts:
            break
    return cwd, model, first_ts


def _aggregate_messages(f_bin):
    """正向聚合二进制文件句柄中的消息（从当前指针读到 EOF）。"""
    messages = []
    current_assistant_msg: dict | None = None
    current_turn_appended = False  # 当前 turn 是否已 append（避免用值相等比较误判重复 turn）
    tool_blocks_by_id: dict[str, dict] = {}
    pending_results: dict[str, dict] = {}
    for raw_line in f_bin:
        line = raw_line.decode("utf-8", "replace").strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg_type = obj.get("type", "")
        if msg_type == "user":
            results = _extract_tool_results(obj)
            for tool_id, result in results.items():
                block = tool_blocks_by_id.get(tool_id)
                if block is not None:
                    block["result"] = result
                else:
                    pending_results[tool_id] = result
            text = _extract_user_text(obj)
            if text:
                current_assistant_msg = None
                current_turn_appended = False
                message = {"role": "user", "text": text}
                raw_text = _extract_raw_user_text(obj)
                _, context_trace = _split_injected_context(raw_text)
                if context_trace:
                    message["context_trace"] = context_trace
                messages.append(message)
        elif msg_type == "assistant":
            if obj.get("parent_tool_use_id"):
                continue
            content = obj.get("message", {}).get("content", [])
            blocks = current_assistant_msg["blocks"] if current_assistant_msg else []
            if current_assistant_msg is None:
                current_assistant_msg = {"role": "assistant", "blocks": blocks}
                current_turn_appended = False
            before_count = len(blocks)
            if isinstance(content, list):
                for block in content:
                    if block.get("type") == "tool_use":
                        tool_id = block.get("id", "")
                        item = {
                            "type": "tool_use",
                            "id": tool_id,
                            "name": block.get("name", ""),
                            "input": block.get("input", {}),
                        }
                        if tool_id:
                            tool_blocks_by_id[tool_id] = item
                            if tool_id in pending_results:
                                item["result"] = pending_results.pop(tool_id)
                        blocks.append(item)
                    else:
                        _append_assistant_block(blocks, block)
            if len(blocks) > before_count and not current_turn_appended:
                messages.append(current_assistant_msg)
                current_turn_appended = True
    return messages


def _aggregate_tail_messages(path, need: int):
    """反向聚合文件末尾的消息，最多 need+1 条。

    用与 _aggregate_messages 一致的聚合状态机，但从文件末尾反向遍历，
    只读末尾所需的行，超长会话也能快速返回末尾若干条。

    返回 (messages_forward, has_more)：
    - messages_forward: 正向顺序的末尾消息（最多 need+1 条）
    - has_more: 是否还存在更早的消息（实际消息数 > need）
    """
    msgs_rev: list = []  # 从末尾往前收集
    pending_turn_blocks: list = []  # 当前 assistant turn 的 blocks（正向更晚方向），保持正向顺序
    pending_results: dict[str, dict] = {}  # tool_id -> result，等更早的 tool_use 配对
    stopped = False
    try:
        for _pos, raw in _iter_lines_reversed(path):
            try:
                obj = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                continue
            mtype = obj.get("type", "")
            if mtype == "assistant":
                if obj.get("parent_tool_use_id"):
                    continue
                content = obj.get("message", {}).get("content", [])
                if isinstance(content, list):
                    new_blocks: list = []
                    for block in content:
                        if block.get("type") == "tool_use":
                            tool_id = block.get("id", "")
                            item = {
                                "type": "tool_use",
                                "id": tool_id,
                                "name": block.get("name", ""),
                                "input": block.get("input", {}),
                            }
                            if tool_id and tool_id in pending_results:
                                item["result"] = pending_results.pop(tool_id)
                            new_blocks.append(item)
                        else:
                            before = len(new_blocks)
                            _append_assistant_block(new_blocks, block)
                            if len(new_blocks) == before:
                                continue
                    if new_blocks:
                        # 反向遇到，prepend 以保持 turn 内 block 的正向顺序
                        pending_turn_blocks = new_blocks + pending_turn_blocks
                continue
            if mtype == "user":
                results = _extract_tool_results(obj)
                for tool_id, result in results.items():
                    pending_results[tool_id] = result
                text = _extract_user_text(obj)
                if text:
                    # user(text) 关闭当前 turn：先输出 turn（正向更晚），再输出 user 自身
                    if pending_turn_blocks:
                        msgs_rev.append({"role": "assistant", "blocks": pending_turn_blocks})
                        pending_turn_blocks = []
                    message = {"role": "user", "text": text}
                    raw_text = _extract_raw_user_text(obj)
                    _, context_trace = _split_injected_context(raw_text)
                    if context_trace:
                        message["context_trace"] = context_trace
                    msgs_rev.append(message)
                    if len(msgs_rev) > need:
                        stopped = True
                        break
                # 无 text 的 user（纯 tool_result）：已关联 result，不产生消息、不关闭 turn
    except OSError:
        pass
    if not stopped and pending_turn_blocks:
        msgs_rev.append({"role": "assistant", "blocks": pending_turn_blocks})

    has_more = len(msgs_rev) > need
    msgs_forward = list(reversed(msgs_rev))
    return msgs_forward, has_more


def _load_history_fallback(path, limit: int, offset: int):
    """兜底：正向全量聚合后切片（与旧版逻辑一致，反向扫描异常时不返回错误数据）。"""
    try:
        with path.open("rb") as f:
            messages = _aggregate_messages(f)
    except OSError:
        return {"messages": [], "total": 0, "has_more": False}
    total = len(messages)
    if offset > 0:
        end = total - offset
        if end <= 0:
            return {"messages": [], "total": total, "has_more": False}
        page = messages[max(0, end - limit):end]
    else:
        page = messages[max(0, total - limit):]
    has_more = (total - offset - len(page)) > 0
    return {"messages": page, "total": total, "has_more": has_more}


def _load_all_messages_cached(jsonl_path: Path) -> list:
    """全量解析并缓存会话消息列表。mtime/size 不变时直接返回缓存。"""
    try:
        st = jsonl_path.stat()
        key = (str(jsonl_path), st.st_mtime, st.st_size)
    except OSError:
        return []
    if key in _history_cache:
        _history_cache.move_to_end(key)
        return _history_cache[key]
    try:
        with jsonl_path.open("rb") as f:
            messages = _aggregate_messages(f)
    except OSError:
        return []
    _history_cache[key] = messages
    if len(_history_cache) > _HISTORY_CACHE_MAX:
        _history_cache.popitem(last=False)
    return messages


def invalidate_history_cache(session_id: str, cwd: str = "") -> None:
    """会话写入新消息后主动失效缓存（路径匹配即删除）。"""
    jsonl_path = _find_jsonl_path(session_id, cwd)
    if not jsonl_path:
        return
    path_str = str(jsonl_path)
    for key in list(_history_cache.keys()):
        if key[0] == path_str:
            del _history_cache[key]
            break


def load_session_history(
    session_id: str,
    cwd: str,
    limit: int = 20,
    offset: int = 0,
) -> dict:
    """从 ccb 的 .jsonl 文件中加载历史消息，返回 {messages, total, has_more}

    反向从文件末尾聚合，只读末尾所需行，超长会话也能秒级返回。
    offset: 从末尾倒数跳过的条数（0 表示从最末尾开始取 limit 条）
    limit:  本次返回的最大条数
    """
    jsonl_path = _find_jsonl_path(session_id, cwd)
    if not jsonl_path:
        return {"messages": [], "total": 0, "has_more": False}

    # 全量缓存命中：直接切片，无 IO
    try:
        st = jsonl_path.stat()
        cache_key = (str(jsonl_path), st.st_mtime, st.st_size)
    except OSError:
        return {"messages": [], "total": 0, "has_more": False}

    if cache_key in _history_cache:
        _history_cache.move_to_end(cache_key)
        messages = _history_cache[cache_key]
        total = len(messages)
        if offset > 0:
            end = total - offset
            if end <= 0:
                return {"messages": [], "total": total, "has_more": False}
            page = messages[max(0, end - limit):end]
        else:
            page = messages[max(0, total - limit):]
        has_more = (total - offset - len(page)) > 0
        return {"messages": page, "total": total, "has_more": has_more}

    # 反向聚合末尾 offset+limit+1 条（正向旧→新），跳过最新 offset 条取前面 limit 条
    need = offset + limit
    try:
        msgs_forward, has_more = _aggregate_tail_messages(jsonl_path, need)
    except Exception:
        return _load_history_fallback(jsonl_path, limit, offset)

    n = len(msgs_forward)
    end = n - offset  # 跳过最新 offset 条后的边界
    if end <= 0:
        return {"messages": [], "total": n if not has_more else (need + 1), "has_more": False}
    page = msgs_forward[max(0, end - limit):end]
    total = n if not has_more else (need + 1)
    return {"messages": page, "total": total, "has_more": has_more}
