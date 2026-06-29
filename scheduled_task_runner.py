"""定时任务后台执行器。"""
import asyncio
import time
import uuid
from typing import Awaitable, Callable, Any

from ccb_bridge import CCBSession, get_current_cli
from session_store import save_session, add_session_usage
import remote_manager
import scheduled_task_store as store

EventPublisher = Callable[[str, dict], Awaitable[None]]


class ScheduledTaskRunner:
    def __init__(self, publish: EventPublisher | None = None):
        self._publish = publish
        self._running_ids: set[str] = set()
        self._stop_event = asyncio.Event()

    async def start(self):
        store.reset_running_tasks()
        while not self._stop_event.is_set():
            try:
                await self.tick()
            except Exception as exc:
                print(f"[CC Bridge] scheduled task runner error: {exc}")
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass

    def stop(self):
        self._stop_event.set()

    async def tick(self):
        now = time.time()
        for task in store.list_tasks():
            next_run = task.get("next_run_at")
            if not task.get("enabled") or not next_run or next_run > now:
                continue
            if task.get("id") in self._running_ids:
                continue
            asyncio.create_task(self.run_task(task.get("id", ""), manual=False))

    async def run_task(self, task_id: str, manual: bool = False) -> dict | None:
        task = store.get_task(task_id)
        if not task:
            return None
        if task_id in self._running_ids:
            return task
        self._running_ids.add(task_id)
        session = CCBSession()
        captured_session_id = ""
        try:
            started = store.mark_task_started(task_id) or task
            await self._emit("scheduled_task_started", {"task": started, "manual": manual})

            done_event = asyncio.Event()
            run_error = ""
            saw_result = False

            async def on_event(event: dict):
                nonlocal captured_session_id, run_error, saw_result
                evt_type = event.get("type")
                if evt_type == "session_id_captured":
                    captured_session_id = event.get("session_id") or captured_session_id
                    save_session(
                        captured_session_id,
                        task.get("name") or task.get("prompt", "")[:50] or "定时任务",
                        task.get("model") or "",
                        task.get("cwd") or "",
                        remote_target_id=task.get("remote_target_id", ""),
                        cli=task.get("cli", ""),
                    )
                elif evt_type == "result":
                    saw_result = True
                    sid = captured_session_id or session.session_id or task.get("last_session_id", "")
                    if sid:
                        add_session_usage(
                            sid,
                            cost_usd=event.get("total_cost_usd") or 0,
                            tokens=event.get("usage") or {},
                        )
                    done_event.set()
                elif evt_type == "process_ended":
                    exit_code = event.get("exit_code")
                    if not saw_result and exit_code not in (0, None):
                        run_error = f"Claude Code 进程退出，状态码 {exit_code}"
                    done_event.set()
                elif evt_type == "error":
                    run_error = event.get("message") or "定时任务执行失败"
                    await self._emit("scheduled_task_error", {
                        "task_id": task_id,
                        "message": run_error,
                    })
                    done_event.set()

            remote_target = None
            remote_target_id = task.get("remote_target_id") or ""
            if remote_target_id:
                remote_target = remote_manager.get_target(remote_target_id)
            resume_id = task.get("last_session_id") if task.get("reuse_session") else None
            await session.start(
                model=task.get("model") or "claude-sonnet-4-6",
                cwd=task.get("cwd") or None,
                resume_id=resume_id,
                on_event=on_event,
                skip_permissions=task.get("skip_permissions", True),
                remote_target=remote_target,
                allow_mutate=task.get("allow_remote_mutate", False),
                cli=task.get("cli") or get_current_cli(),
            )
            await session.send_message(
                task.get("prompt") or "",
                owner_id=f"scheduled_{task_id}_{uuid.uuid4().hex[:8]}",
                prefer_persistent=False,
            )
            try:
                await asyncio.wait_for(done_event.wait(), timeout=60 * 60)
            except asyncio.TimeoutError:
                run_error = "定时任务执行超时"
            if session._read_task:
                try:
                    await asyncio.wait_for(asyncio.shield(session._read_task), timeout=5.0)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    pass
            sid = captured_session_id or session.session_id or ""
            finished = store.mark_task_finished(task_id, session_id=sid, error=run_error) or store.get_task(task_id)
            if run_error:
                await self._emit("scheduled_task_error", {"task": finished, "task_id": task_id, "message": run_error, "manual": manual})
            else:
                await self._emit("scheduled_task_finished", {"task": finished, "session_id": sid, "manual": manual})
            return finished
        except Exception as exc:
            finished = store.mark_task_finished(task_id, session_id=captured_session_id or session.session_id or "", error=str(exc))
            await self._emit("scheduled_task_error", {"task": finished, "task_id": task_id, "message": str(exc), "manual": manual})
            return finished
        finally:
            self._running_ids.discard(task_id)
            await session.stop()

    async def _emit(self, event_type: str, data: dict):
        if self._publish:
            await self._publish(event_type, data)
