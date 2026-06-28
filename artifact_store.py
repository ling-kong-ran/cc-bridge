"""资产索引：从最近会话 JSONL 中提取图片、文件和链接。"""
import json
import re
from session_store import list_sessions, _find_jsonl_path

MARKDOWN_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")
MARKDOWN_LINK_RE = re.compile(r"(?<!!)\[([^\]]+)\]\(([^)\s]+)\)")
URL_RE = re.compile(r"https?://[^\s<>\"')]+")
PATH_RE = re.compile(r"(^|[\s(\"'`])((?:[A-Za-z]:[\\/]|/|~/|\.\.?/)[^\s\"'`<>]+(?:\.[a-zA-Z0-9]{1,8})?)")
IMAGE_EXT_RE = re.compile(r"\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\?.*)?$", re.I)
FILE_EXT_RE = re.compile(r"\.(?:png|jpe?g|gif|webp|svg|bmp|pdf|txt|json|md|csv|zip|tar|gz|mp3|wav|mp4|mov|html?)(?:\?.*)?$", re.I)
KEY_HINT_RE = re.compile(r"(path|file|url|image|artifact|output|download|result|target)", re.I)


def normalize_artifact_value(value: str) -> str:
    value = str(value or "").strip().strip(".,;:)]}")
    return value.replace("\\", "/")


def looks_like_path_or_url(value: str) -> bool:
    if not value or len(value) > 1200:
        return False
    if re.match(r"^https?://", value, re.I):
        return True
    if re.match(r"^(?:[A-Za-z]:/|/|~/|\.\.?/)", value):
        return bool(FILE_EXT_RE.search(value) or "/" in value)
    return False


def looks_like_artifact(value: str) -> bool:
    return looks_like_path_or_url(value) and (bool(FILE_EXT_RE.search(value)) or re.match(r"^https?://", value, re.I) is not None)


def artifact_kind(value: str) -> str:
    if IMAGE_EXT_RE.search(value):
        return "image"
    if FILE_EXT_RE.search(value):
        return "file"
    return "link"


def artifact_label(value: str) -> str:
    clean = value.split("?", 1)[0].rstrip("/")
    name = clean.rsplit("/", 1)[-1]
    return name or value


def collect_string_values(value, key_path: str, collector):
    if isinstance(value, str):
        if KEY_HINT_RE.search(key_path) or looks_like_path_or_url(normalize_artifact_value(value)):
            collector(value)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            collect_string_values(item, f"{key_path}.{index}" if key_path else str(index), collector)
    elif isinstance(value, dict):
        for key, item in value.items():
            collect_string_values(item, f"{key_path}.{key}" if key_path else str(key), collector)


def collect_artifacts_from_text(text: str, push_value):
    if not text:
        return
    for match in MARKDOWN_IMAGE_RE.finditer(text):
        push_value(match.group(2))
    for match in MARKDOWN_LINK_RE.finditer(text):
        push_value(match.group(2))
    for match in URL_RE.finditer(text):
        push_value(match.group(0))
    for match in PATH_RE.finditer(text):
        push_value(match.group(2))


def collect_artifacts_for_session(session: dict, max_records: int = 200, href_for_value=None) -> list[dict]:
    session_id = session.get("session_id", "")
    jsonl_path = _find_jsonl_path(session_id, session.get("cwd", "")) if session_id else None
    if not jsonl_path:
        return []

    found = {}
    title = session.get("title") or "新会话"

    def push(value: str, timestamp: str = ""):
        value = normalize_artifact_value(value)
        if not looks_like_artifact(value):
            return
        key = f"{session_id}:{value}"
        if key in found:
            return
        found[key] = {
            "id": key,
            "kind": artifact_kind(value),
            "value": value,
            "href": href_for_value(value) if href_for_value else "",
            "label": artifact_label(value),
            "session_id": session_id,
            "session_title": title,
            "cwd": (session.get("cwd") or "").replace("\\", "/"),
            "timestamp": timestamp or session.get("updated_at", ""),
        }

    try:
        lines = jsonl_path.read_text(encoding="utf-8").splitlines()
        for line in reversed(lines):
            if len(found) >= max_records:
                break
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            collect_artifacts_from_record(obj, session, push)
    except OSError:
        return []

    return list(found.values())


def collect_artifacts_from_record(obj: dict, session: dict, push):
    msg_type = obj.get("type", "")
    if msg_type not in ("assistant", "user"):
        return

    timestamp = obj.get("timestamp") or session.get("updated_at", "")
    content = (obj.get("message") or {}).get("content")

    if isinstance(content, str):
        collect_artifacts_from_text(content, lambda v, ts=timestamp: push(v, ts))
        return

    if not isinstance(content, list):
        return

    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text":
            collect_artifacts_from_text(block.get("text") or "", lambda v, ts=timestamp: push(v, ts))
        elif msg_type == "assistant" and block_type == "tool_use":
            collect_string_values(block.get("input"), "tool_use.input", lambda v, ts=timestamp: push(v, ts))
        elif msg_type == "user" and block_type == "tool_result":
            collect_tool_result_artifacts(block.get("content"), timestamp, push)


def collect_tool_result_artifacts(result, timestamp: str, push):
    if isinstance(result, str):
        collect_artifacts_from_text(result, lambda v, ts=timestamp: push(v, ts))
        try:
            collect_string_values(json.loads(result), "tool_result", lambda v, ts=timestamp: push(v, ts))
        except json.JSONDecodeError:
            pass
    else:
        collect_string_values(result, "tool_result", lambda v, ts=timestamp: push(v, ts))


def list_artifacts(limit_sessions: int = 30, href_for_value=None) -> dict:
    sessions = list_sessions()[:max(1, min(100, limit_sessions))]
    artifacts = []
    for session in sessions:
        artifacts.extend(collect_artifacts_for_session(session, href_for_value=href_for_value))
    artifacts.sort(key=lambda item: item.get("timestamp") or "", reverse=True)
    return {"artifacts": artifacts, "total": len(artifacts)}
