"""飞书消息网关配置存储。"""
import copy
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

CCB_DIR = Path.home() / ".ccb"
FEISHU_GATEWAY_FILE = CCB_DIR / "feishu_gateway.json"

_SECRET_KEYS = {"app_secret", "verification_token"}


def _default_session_notify_template() -> str:
    return (
        "通知：{{title}}{{cost}}\n\n"
        "问：\n{{prompt}}\n\n"
        "答：\n{{summary}}\n\n"
        "模型：{{model}}  |  耗时：{{elapsed}}"
    )


def _default_scheduled_notify_template() -> str:
    return (
        "通知：{{title}}\n\n"
        "任务：{{task_name}}\n"
        "状态：{{status}}\n"
        "触发方式：{{trigger}}\n"
        "模型：{{model}}\n"
        "Session：{{session_id}}\n\n"
        "错误：{{error}}"
    )


def _default_workflow_notify_template() -> str:
    return (
        "通知：工作流需要审批\n\n"
        "工作流：{{workflow_name}}\n"
        "Workflow ID：{{workflow_id}}\n"
        "Run ID：{{run_id}}\n"
        "节点：{{node_title}}\n"
        "Node ID：{{node_id}}\n\n"
        "请在 cc-bridge 工作流页面审批继续或拒绝。"
    )


_TEMPLATE_DEFAULTS = {
    "session_notify_template": _default_session_notify_template,
    "scheduled_notify_template": _default_scheduled_notify_template,
    "workflow_notify_template": _default_workflow_notify_template,
}


def _default_config() -> dict[str, Any]:
    return {
        "enabled": False,
        "app_id": "",
        "app_secret": "",
        "verification_token": "",
        "default_model": "",
        "default_cwd": "",
        "default_cli": "",
        "skip_permissions": True,
        "busy_mode": "queue",
        "allowed_users": [],
        "allowed_chats": [],
        "complete_notify": True,
        "session_notify_template": _default_session_notify_template(),
        "scheduled_notify_template": _default_scheduled_notify_template(),
        "workflow_notify_template": _default_workflow_notify_template(),
        "scopes": {},
        "processed_events": {},
        "updated_at": "",
    }


def _load_raw() -> dict[str, Any]:
    if not FEISHU_GATEWAY_FILE.exists():
        return _default_config()
    try:
        data = json.loads(FEISHU_GATEWAY_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (json.JSONDecodeError, OSError):
        data = {}
    config = _default_config()
    config.update(data)
    if not isinstance(config.get("scopes"), dict):
        config["scopes"] = {}
    if not isinstance(config.get("processed_events"), dict):
        config["processed_events"] = {}
    for key in ("allowed_users", "allowed_chats"):
        if not isinstance(config.get(key), list):
            config[key] = []
    if config.get("busy_mode") not in ("queue", "reject"):
        config["busy_mode"] = "queue"
    for key, default_factory in _TEMPLATE_DEFAULTS.items():
        if not str(config.get(key) or "").strip():
            config[key] = default_factory()
    return config


def _save_raw(config: dict[str, Any]) -> dict[str, Any]:
    config = dict(config)
    config["updated_at"] = datetime.now().isoformat(timespec="seconds")
    CCB_DIR.mkdir(parents=True, exist_ok=True)
    tmp = FEISHU_GATEWAY_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, FEISHU_GATEWAY_FILE)
    return config


def _redact(config: dict[str, Any]) -> dict[str, Any]:
    data = copy.deepcopy(config)
    for key in _SECRET_KEYS:
        if data.get(key):
            data[key] = "********"
    return data


def get_feishu_gateway_config(redact: bool = True) -> dict[str, Any]:
    config = _load_raw()
    return _redact(config) if redact else config


def update_feishu_gateway_config(patch: dict[str, Any]) -> dict[str, Any]:
    config = _load_raw()
    allowed = {
        "enabled",
        "app_id",
        "app_secret",
        "verification_token",
        "connection_mode",
        "default_model",
        "default_cwd",
        "default_cli",
        "skip_permissions",
        "busy_mode",
        "allowed_users",
        "allowed_chats",
        "complete_notify",
        "session_notify_template",
        "scheduled_notify_template",
        "workflow_notify_template",
    }
    for key, value in patch.items():
        if key not in allowed:
            continue
        if key in _SECRET_KEYS and value == "********":
            continue
        if key in ("allowed_users", "allowed_chats"):
            if isinstance(value, str):
                value = [part.strip() for part in value.splitlines() if part.strip()]
            elif isinstance(value, list):
                value = [str(part).strip() for part in value if str(part).strip()]
            else:
                value = []
        elif key == "enabled":
            value = bool(value)
        elif key == "skip_permissions":
            value = bool(value)
        elif key == "busy_mode":
            value = value if value in ("queue", "reject") else "queue"
        else:
            value = str(value or "").strip()
        config[key] = value
    return _redact(_save_raw(config))


def get_scope(scope_key: str) -> dict[str, Any]:
    return dict(_load_raw().get("scopes", {}).get(scope_key, {}))


def save_scope(scope_key: str, scope: dict[str, Any]) -> dict[str, Any]:
    config = _load_raw()
    scopes = config.setdefault("scopes", {})
    now = datetime.now().isoformat(timespec="seconds")
    existing = dict(scopes.get(scope_key, {}))
    existing.update(scope)
    existing.setdefault("created_at", now)
    existing["updated_at"] = now
    scopes[scope_key] = existing
    _save_raw(config)
    return existing


def reset_scope(scope_key: str) -> bool:
    config = _load_raw()
    scopes = config.setdefault("scopes", {})
    if scope_key not in scopes:
        return False
    scopes.pop(scope_key, None)
    _save_raw(config)
    return True


def list_scopes() -> list[dict[str, Any]]:
    scopes = _load_raw().get("scopes", {})
    items = []
    for key, value in scopes.items():
        item = dict(value) if isinstance(value, dict) else {}
        item["scope_key"] = key
        items.append(item)
    return sorted(items, key=lambda item: item.get("updated_at", ""), reverse=True)


def is_event_processed(event_id: str) -> bool:
    if not event_id:
        return False
    return event_id in _load_raw().get("processed_events", {})


def mark_event_processed(event_id: str, max_events: int = 500) -> None:
    if not event_id:
        return
    config = _load_raw()
    events = config.setdefault("processed_events", {})
    events[event_id] = datetime.now().isoformat(timespec="seconds")
    if len(events) > max_events:
        for key in sorted(events, key=lambda k: events.get(k, ""))[: len(events) - max_events]:
            events.pop(key, None)
    _save_raw(config)
