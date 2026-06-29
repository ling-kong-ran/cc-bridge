"""定时任务持久化与时间计算。"""
import json
import time
import uuid
from pathlib import Path
from datetime import datetime, timedelta

STORE_PATH = Path.home() / ".ccb" / "cron_jobs.json"


def _now() -> float:
    return time.time()


def _read_raw() -> dict:
    if not STORE_PATH.exists():
        return {"tasks": []}
    try:
        data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"tasks": []}
    if isinstance(data, list):
        return {"tasks": data}
    if not isinstance(data, dict):
        return {"tasks": []}
    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        data["tasks"] = []
    return data


def _write_raw(data: dict):
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STORE_PATH)


def _as_float(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalize_schedule(schedule) -> dict:
    schedule = schedule if isinstance(schedule, dict) else {}
    typ = str(schedule.get("type") or "interval").strip().lower()
    if typ not in {"interval", "daily", "once"}:
        typ = "interval"
    if typ == "interval":
        minutes = max(1, int(_as_float(schedule.get("minutes"), 60) or 60))
        return {"type": "interval", "minutes": minutes}
    if typ == "daily":
        at = str(schedule.get("time") or "09:00").strip()
        if not _valid_hhmm(at):
            at = "09:00"
        return {"type": "daily", "time": at}
    run_at = _as_float(schedule.get("run_at"), None)
    if not run_at:
        run_at = _now() + 3600
    return {"type": "once", "run_at": run_at}


def _valid_hhmm(value: str) -> bool:
    try:
        hour, minute = value.split(":", 1)
        hour_i = int(hour)
        minute_i = int(minute)
    except (ValueError, AttributeError):
        return False
    return 0 <= hour_i <= 23 and 0 <= minute_i <= 59


def compute_next_run_at(task: dict, base_ts: float | None = None) -> float | None:
    if not task.get("enabled", True):
        return None
    schedule = _normalize_schedule(task.get("schedule"))
    base = datetime.fromtimestamp(base_ts or _now())
    if schedule["type"] == "interval":
        anchor = _as_float(task.get("last_run_at"), None) or _as_float(task.get("created_at"), None) or base.timestamp()
        next_ts = anchor + schedule["minutes"] * 60
        while next_ts <= base.timestamp():
            next_ts += schedule["minutes"] * 60
        return next_ts
    if schedule["type"] == "daily":
        hour, minute = [int(x) for x in schedule["time"].split(":", 1)]
        next_dt = base.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if next_dt.timestamp() <= base.timestamp():
            next_dt += timedelta(days=1)
        return next_dt.timestamp()
    run_at = _as_float(schedule.get("run_at"), None)
    if run_at and run_at > base.timestamp():
        return run_at
    return None


def normalize_task(task: dict) -> dict:
    now = _now()
    task = dict(task or {})
    task_id = str(task.get("id") or uuid.uuid4().hex)
    name = str(task.get("name") or "定时任务").strip()[:80] or "定时任务"
    prompt = str(task.get("prompt") or "").strip()
    created_at = _as_float(task.get("created_at"), None) or now
    normalized = {
        "id": task_id,
        "name": name,
        "prompt": prompt,
        "schedule": _normalize_schedule(task.get("schedule")),
        "enabled": bool(task.get("enabled", True)),
        "model": str(task.get("model") or "claude-sonnet-4-6"),
        "cwd": str(task.get("cwd") or ""),
        "cli": str(task.get("cli") or ""),
        "remote_target_id": str(task.get("remote_target_id") or ""),
        "allow_remote_mutate": bool(task.get("allow_remote_mutate", False)),
        "skip_permissions": bool(task.get("skip_permissions", True)),
        "reuse_session": bool(task.get("reuse_session", False)),
        "last_session_id": str(task.get("last_session_id") or ""),
        "created_at": created_at,
        "updated_at": _as_float(task.get("updated_at"), None) or now,
        "last_run_at": _as_float(task.get("last_run_at"), None),
        "next_run_at": _as_float(task.get("next_run_at"), None),
        "last_status": str(task.get("last_status") or ""),
        "last_error": str(task.get("last_error") or ""),
        "run_count": int(_as_float(task.get("run_count"), 0) or 0),
    }
    normalized["next_run_at"] = compute_next_run_at(normalized)
    return normalized


def list_tasks() -> list[dict]:
    data = _read_raw()
    tasks = [normalize_task(t) for t in data.get("tasks", []) if isinstance(t, dict)]
    data["tasks"] = tasks
    _write_raw(data)
    return tasks


def reset_running_tasks(error: str = "上次运行未正常结束") -> list[dict]:
    data = _read_raw()
    tasks = [normalize_task(t) for t in data.get("tasks", []) if isinstance(t, dict)]
    changed = False
    now = _now()
    for task in tasks:
        if task.get("last_status") == "running":
            task["last_status"] = "error"
            task["last_error"] = error
            task["updated_at"] = now
            task["next_run_at"] = compute_next_run_at(task)
            changed = True
    if changed:
        data["tasks"] = tasks
        _write_raw(data)
    return tasks


def get_task(task_id: str) -> dict | None:
    for task in list_tasks():
        if task.get("id") == task_id:
            return task
    return None


def save_task(payload: dict) -> dict:
    if not str(payload.get("prompt") or "").strip():
        raise ValueError("prompt required")
    data = _read_raw()
    tasks = [normalize_task(t) for t in data.get("tasks", []) if isinstance(t, dict)]
    now = _now()
    payload = dict(payload)
    payload["updated_at"] = now
    task_id = str(payload.get("id") or "")
    if task_id:
        for idx, existing in enumerate(tasks):
            if existing.get("id") == task_id:
                merged = dict(existing)
                merged.update(payload)
                tasks[idx] = normalize_task(merged)
                data["tasks"] = tasks
                _write_raw(data)
                return tasks[idx]
    payload["id"] = uuid.uuid4().hex
    payload["created_at"] = now
    task = normalize_task(payload)
    tasks.append(task)
    data["tasks"] = tasks
    _write_raw(data)
    return task


def delete_task(task_id: str) -> bool:
    data = _read_raw()
    tasks = [normalize_task(t) for t in data.get("tasks", []) if isinstance(t, dict)]
    kept = [t for t in tasks if t.get("id") != task_id]
    data["tasks"] = kept
    _write_raw(data)
    return len(kept) != len(tasks)


def set_task_enabled(task_id: str, enabled: bool) -> dict | None:
    task = get_task(task_id)
    if not task:
        return None
    task["enabled"] = bool(enabled)
    task["updated_at"] = _now()
    task["next_run_at"] = compute_next_run_at(task)
    return save_existing_task(task)


def save_existing_task(task: dict) -> dict:
    data = _read_raw()
    tasks = [normalize_task(t) for t in data.get("tasks", []) if isinstance(t, dict)]
    for idx, existing in enumerate(tasks):
        if existing.get("id") == task.get("id"):
            tasks[idx] = normalize_task(task)
            data["tasks"] = tasks
            _write_raw(data)
            return tasks[idx]
    tasks.append(normalize_task(task))
    data["tasks"] = tasks
    _write_raw(data)
    return tasks[-1]


def mark_task_started(task_id: str) -> dict | None:
    task = get_task(task_id)
    if not task:
        return None
    task["last_run_at"] = _now()
    task["last_status"] = "running"
    task["last_error"] = ""
    task["updated_at"] = _now()
    return save_existing_task(task)


def mark_task_finished(task_id: str, session_id: str = "", error: str = "") -> dict | None:
    task = get_task(task_id)
    if not task:
        return None
    if session_id:
        task["last_session_id"] = session_id
    task["last_status"] = "error" if error else "success"
    task["last_error"] = error
    if not error:
        task["run_count"] = int(task.get("run_count") or 0) + 1
    if task.get("schedule", {}).get("type") == "once" and not error:
        task["enabled"] = False
    task["updated_at"] = _now()
    task["next_run_at"] = compute_next_run_at(task)
    return save_existing_task(task)
