"""定时任务相关服务。"""
import asyncio
from typing import Any

import scheduled_task_store
from scheduled_task_runner import ScheduledTaskRunner


def list_scheduled_tasks() -> dict[str, Any]:
    """读取定时任务列表。"""
    return {"tasks": scheduled_task_store.list_tasks()}


def save_scheduled_task(data: dict[str, Any]) -> dict[str, Any]:
    """保存定时任务。"""
    return scheduled_task_store.save_task(data)


def delete_scheduled_task(task_id: str) -> tuple[bool, list[dict[str, Any]]]:
    """删除定时任务，并返回最新任务列表。"""
    ok = scheduled_task_store.delete_task(task_id)
    return ok, scheduled_task_store.list_tasks()


def toggle_scheduled_task(task_id: str, enabled: bool) -> dict[str, Any] | None:
    """启用或停用定时任务。"""
    return scheduled_task_store.set_task_enabled(task_id, enabled)


def trigger_scheduled_task_now(runner: ScheduledTaskRunner | None, task_id: str) -> bool:
    """后台触发一次定时任务。"""
    if not task_id or not runner:
        return False
    asyncio.create_task(runner.run_task(task_id, manual=True))
    return True
