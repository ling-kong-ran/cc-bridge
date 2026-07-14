"""
Workflow Runner - Agent 工作流模拟执行器
第一版仅模拟节点执行，不执行 shell，也不调用 Claude CLI。
"""
import asyncio
import time
from typing import Awaitable, Callable

import workflow_store

WorkflowEventSink = Callable[[dict], Awaitable[None]]


class WorkflowRunner:
    def __init__(self, session_manager=None, event_sink: WorkflowEventSink | None = None):
        self.session_manager = session_manager
        self.event_sink = event_sink
        self._running: dict[str, asyncio.Task] = {}
        self._paused: dict[str, dict] = {}

    async def start_run(self, workflow_id: str, inputs: dict | None = None) -> dict:
        """创建运行记录并启动后台模拟执行。"""
        workflow = workflow_store.get_workflow(workflow_id)
        if not workflow:
            raise ValueError("workflow not found")
        run = workflow_store.create_run(workflow_id, inputs or {})
        await self._emit(workflow_id, run["id"], "", "run_started", {"status": "running", "message": f"{workflow.get('name', '工作流')} 开始执行"})
        task = asyncio.create_task(self._run_workflow(workflow, run["id"]))
        self._running[run["id"]] = task
        task.add_done_callback(lambda _task, rid=run["id"]: self._running.pop(rid, None))
        return run

    async def cancel_run(self, run_id: str) -> dict | None:
        """取消运行中的或暂停中的工作流。"""
        run = workflow_store.get_run(run_id)
        if not run:
            return None
        current_node_ids = [str(node_id) for node_id in run.get("current_node_ids", []) if node_id]
        task = self._running.pop(run_id, None)
        if task and not task.done():
            task.cancel()
        self._paused.pop(run_id, None)
        now = time.time()
        for node_id in current_node_ids:
            self._mark_node(run_id, node_id, "cancelled", {"summary": "工作流已取消"})
        run = workflow_store.update_run(run_id, {"status": "cancelled", "ended_at": now, "current_node_ids": []})
        await self._emit(str((run or {}).get("workflow_id") or ""), run_id, "", "run_cancelled", {"status": "cancelled", "message": "工作流已取消"})
        return run

    async def approve_run(self, run_id: str, approval_id: str | None = None, approved: bool = True) -> dict | None:
        """处理人工审批；通过后继续执行，拒绝后取消运行。"""
        run = workflow_store.get_run(run_id)
        if not run:
            return None
        paused = self._paused.pop(run_id, None)
        workflow_id = str(run.get("workflow_id") or "")
        node_id = str((paused or {}).get("node_id") or approval_id or "")
        if not approved:
            now = time.time()
            if node_id:
                self._mark_node(run_id, node_id, "cancelled", {"summary": "审批已拒绝"})
            run = workflow_store.update_run(run_id, {"status": "cancelled", "ended_at": now, "current_node_ids": [], "last_error": "approval rejected"})
            await self._emit(workflow_id, run_id, node_id, "run_cancelled", {"status": "cancelled", "message": "审批拒绝，工作流已取消"})
            return run

        workflow_store.append_node_event(run_id, node_id, "approval_approved", {"approved": True})
        self._mark_node(run_id, node_id, "succeeded", {"summary": "审批已通过"})
        run = workflow_store.update_run(run_id, {"status": "running", "current_node_ids": []})
        await self._emit(workflow_id, run_id, node_id, "run_resumed", {"status": "running", "message": "审批通过，继续执行"})
        if paused:
            task = asyncio.create_task(self._continue_after_approval(paused["workflow"], run_id, node_id))
            self._running[run_id] = task
            task.add_done_callback(lambda _task, rid=run_id: self._running.pop(rid, None))
        return run

    async def _continue_after_approval(self, workflow: dict, run_id: str, node_id: str) -> None:
        try:
            await self._execute_from_next(workflow, run_id, node_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._fail_run(workflow, run_id, str(exc))

    async def _run_workflow(self, workflow: dict, run_id: str) -> None:
        try:
            start_node = self._find_start_node(workflow)
            if not start_node:
                raise ValueError("workflow has no start node")
            await self._execute_linear(workflow, run_id, start_node)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._fail_run(workflow, run_id, str(exc))

    async def _execute_from_next(self, workflow: dict, run_id: str, node_id: str) -> None:
        next_node = self._next_node(workflow, node_id, approved=True)
        if next_node:
            await self._execute_linear(workflow, run_id, next_node)
        else:
            await self._succeed_run(workflow, run_id)

    async def _execute_linear(self, workflow: dict, run_id: str, node: dict) -> None:
        current = node
        approved_path = False
        while current:
            paused = await self._execute_node(workflow, run_id, current)
            if paused:
                return
            node_type = str(current.get("type") or "")
            if node_type == "end":
                await self._succeed_run(workflow, run_id)
                return
            current = self._next_node(workflow, str(current.get("id") or ""), approved=approved_path)
            approved_path = False
        await self._succeed_run(workflow, run_id)

    async def _execute_node(self, workflow: dict, run_id: str, node: dict) -> bool:
        node_id = str(node.get("id") or "")
        node_type = str(node.get("type") or "agent")
        title = str(node.get("title") or node_id or node_type)
        workflow_id = str(workflow.get("id") or "")

        workflow_store.update_run(run_id, {"status": "running", "current_node_ids": [node_id]})
        self._mark_node(run_id, node_id, "running", {"type": node_type, "title": title})
        await self._emit(workflow_id, run_id, node_id, "node_started", {"status": "running", "type": node_type, "title": title, "message": f"{title} 开始执行"})

        if node_type in {"start", "condition", "end"}:
            await asyncio.sleep(0.05)
        elif node_type == "approval":
            message = str((node.get("config") or {}).get("message") or f"{title} 等待人工审批")
            workflow_store.update_run(run_id, {"status": "paused", "current_node_ids": [node_id]})
            workflow_store.append_node_event(run_id, node_id, "approval_required", {"message": message})
            self._paused[run_id] = {"workflow": workflow, "node_id": node_id}
            await self._emit(workflow_id, run_id, node_id, "approval_required", {"status": "paused", "message": message, "config": node.get("config") or {}})
            await self._emit(workflow_id, run_id, node_id, "run_paused", {"status": "paused", "message": "工作流等待人工审批"})
            return True
        else:
            await asyncio.sleep(0.45)

        output = self._mock_output(node)
        self._mark_node(run_id, node_id, "succeeded", output)
        await self._emit(workflow_id, run_id, node_id, "node_succeeded", {"status": "succeeded", "output": output, "message": f"{title} 执行成功"})
        return False

    def _mark_node(self, run_id: str, node_id: str, status: str, payload: dict | None = None) -> None:
        run = workflow_store.get_run(run_id)
        if not run:
            return
        node_runs = run.get("node_runs") if isinstance(run.get("node_runs"), dict) else {}
        now = time.time()
        item = node_runs.get(node_id) if isinstance(node_runs.get(node_id), dict) else {}
        item.update({"status": status, "updated_at": now})
        if status == "running":
            item.setdefault("started_at", now)
        if status in {"succeeded", "failed", "cancelled"}:
            item["ended_at"] = now
        if payload:
            item["payload"] = payload
            if payload.get("summary"):
                item["summary"] = payload.get("summary")
        node_runs[node_id] = item
        workflow_store.update_run(run_id, {"node_runs": node_runs})
        workflow_store.append_node_event(run_id, node_id, f"node_{status}", payload or {})

    def _mock_output(self, node: dict) -> dict:
        node_type = str(node.get("type") or "agent")
        title = str(node.get("title") or node.get("id") or node_type)
        if node_type == "command":
            return {"summary": f"已模拟执行命令节点：{title}", "stdout": "模拟命令执行成功", "exit_code": 0}
        if node_type == "artifact":
            return {"summary": f"已模拟生成产物：{title}", "artifact": {"name": (node.get("config") or {}).get("filename") or "workflow-artifact.md"}}
        if node_type == "condition":
            return {"summary": "条件判断结果：true", "result": True}
        return {"summary": f"已模拟完成节点：{title}", "text": "这是第一版工作流编排的模拟输出。"}

    def _find_start_node(self, workflow: dict) -> dict | None:
        nodes = workflow.get("nodes") if isinstance(workflow.get("nodes"), list) else []
        for node in nodes:
            if isinstance(node, dict) and node.get("type") == "start":
                return node
        return nodes[0] if nodes else None

    def _next_node(self, workflow: dict, node_id: str, approved: bool = False) -> dict | None:
        nodes = {str(n.get("id")): n for n in workflow.get("nodes", []) if isinstance(n, dict)}
        edges = workflow.get("edges") if isinstance(workflow.get("edges"), list) else []
        candidates = [e for e in edges if isinstance(e, dict) and str(e.get("from")) == str(node_id)]
        if not candidates:
            return None
        selected = None
        for edge in candidates:
            when = str(edge.get("when") or "").strip().lower()
            if not when or when in {"true", "succeeded"} or (approved and when == "approved"):
                selected = edge
                break
        selected = selected or candidates[0]
        return nodes.get(str(selected.get("to") or ""))

    async def _succeed_run(self, workflow: dict, run_id: str) -> None:
        now = time.time()
        workflow_store.update_run(run_id, {"status": "succeeded", "ended_at": now, "current_node_ids": []})
        await self._emit(str(workflow.get("id") or ""), run_id, "", "run_succeeded", {"status": "succeeded", "message": "工作流执行成功"})

    async def _fail_run(self, workflow: dict, run_id: str, error: str) -> None:
        now = time.time()
        workflow_store.update_run(run_id, {"status": "failed", "ended_at": now, "current_node_ids": [], "last_error": error})
        await self._emit(str(workflow.get("id") or ""), run_id, "", "run_failed", {"status": "failed", "message": error})

    async def _emit(self, workflow_id: str, run_id: str, node_id: str, event: str, payload: dict | None = None) -> None:
        workflow_store.append_node_event(run_id, node_id, event, payload or {})
        if not self.event_sink:
            return
        await self.event_sink({
            "type": "workflow_event",
            "workflow_id": workflow_id,
            "run_id": run_id,
            "node_id": node_id,
            "event": event,
            "payload": payload or {},
        })
