"""定时任务 REST 路由处理。"""
from typing import Any, Awaitable, Callable

from backend.services.scheduled_tasks_service import (
    list_scheduled_tasks,
    save_scheduled_task,
    delete_scheduled_task,
    toggle_scheduled_task,
    trigger_scheduled_task_now,
)
from scheduled_task_runner import ScheduledTaskRunner

ScheduledEventPublisher = Callable[[str, dict[str, Any]], Awaitable[None]]


def handle_scheduled_tasks_get(path: str) -> tuple[int, dict[str, Any] | None]:
    """处理定时任务 GET API。"""
    if path == "/api/scheduled-tasks":
        return 200, list_scheduled_tasks()
    return 0, None


async def handle_scheduled_tasks_post(
    path: str,
    data: dict[str, Any],
    *,
    scheduled_runner: ScheduledTaskRunner | None,
    publish_scheduled_event: ScheduledEventPublisher,
) -> tuple[int, dict[str, Any] | None]:
    """处理定时任务 POST API。"""
    if path == "/api/scheduled-tasks":
        try:
            task = save_scheduled_task(data)
        except ValueError as exc:
            return 400, {"error": str(exc)}
        await publish_scheduled_event("scheduled_task_updated", {"task": task})
        return 200, task
    if path == "/api/scheduled-tasks/delete":
        ok, tasks = delete_scheduled_task(str(data.get("id", "")))
        await publish_scheduled_event("scheduled_task_updated", {"tasks": tasks})
        return 200, {"ok": ok}
    if path == "/api/scheduled-tasks/toggle":
        task = toggle_scheduled_task(str(data.get("id", "")), bool(data.get("enabled", True)))
        if not task:
            return 404, {"error": "not found"}
        await publish_scheduled_event("scheduled_task_updated", {"task": task})
        return 200, task
    if path == "/api/scheduled-tasks/run-now":
        if not trigger_scheduled_task_now(scheduled_runner, str(data.get("id", ""))):
            return 400, {"error": "invalid task"}
        return 200, {"ok": True}
    return 0, None
