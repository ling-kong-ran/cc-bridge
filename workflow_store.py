"""
Workflow Store - Agent 工作流定义与运行记录持久化
存储位置: ~/.ccb/workflows.json / ~/.ccb/workflow_runs.json
"""
import copy
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

STORE_DIR = Path.home() / ".ccb"
WORKFLOWS_PATH = STORE_DIR / "workflows.json"
RUNS_PATH = STORE_DIR / "workflow_runs.json"


def _now() -> float:
    return time.time()


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return copy.deepcopy(default)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return copy.deepcopy(default)
    return data if isinstance(data, type(default)) else copy.deepcopy(default)


def _save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp_path, path)


def _load_workflows() -> list[dict]:
    data = _load_json(WORKFLOWS_PATH, [])
    if isinstance(data, dict):
        data = data.get("workflows", [])
    return data if isinstance(data, list) else []


def _save_workflows(workflows: list[dict]) -> None:
    _save_json(WORKFLOWS_PATH, workflows)


def _load_runs() -> list[dict]:
    data = _load_json(RUNS_PATH, [])
    if isinstance(data, dict):
        data = data.get("runs", [])
    return data if isinstance(data, list) else []


def _save_runs(runs: list[dict]) -> None:
    _save_json(RUNS_PATH, runs)


def _default_workflow() -> dict:
    now = _now()
    return {
        "id": "wf-code-change-pipeline",
        "name": "代码修改流水线",
        "description": "模拟执行需求分析、代码修改、测试、复核和报告生成，适合前端验收工作流交互。",
        "version": 1,
        "enabled": True,
        "variables": {
            "cwd": "",
            "model": "",
            "execution_mode": "mock",
        },
        "nodes": [
            {"id": "start", "type": "start", "title": "开始"},
            {"id": "analyze", "type": "agent", "title": "分析需求", "config": {"prompt": "分析需求和当前改动，输出实施计划。", "output_key": "analysis", "mode": "mock"}},
            {"id": "implement", "type": "agent", "title": "模拟代码修改", "config": {"prompt": "根据分析结果模拟修改代码。", "output_key": "implementation", "mode": "mock"}},
            {"id": "test", "type": "command", "title": "模拟运行测试", "config": {"command": "python -m py_compile server.py", "requires_approval": False}},
            {"id": "review", "type": "approval", "title": "人工复核", "config": {"message": "请确认模拟修改和测试结果是否可以继续生成报告。", "approve_label": "继续", "reject_label": "取消"}},
            {"id": "report", "type": "artifact", "title": "生成报告", "config": {"format": "markdown", "filename": "workflow-report.md"}},
            {"id": "end", "type": "end", "title": "完成"},
        ],
        "edges": [
            {"id": "edge-start-analyze", "from": "start", "to": "analyze"},
            {"id": "edge-analyze-implement", "from": "analyze", "to": "implement"},
            {"id": "edge-implement-test", "from": "implement", "to": "test"},
            {"id": "edge-test-review", "from": "test", "to": "review"},
            {"id": "edge-review-report", "from": "review", "to": "report", "when": "approved"},
            {"id": "edge-report-end", "from": "report", "to": "end"},
        ],
        "created_at": now,
        "updated_at": now,
    }


def ensure_default_workflows() -> list[dict]:
    workflows = _load_workflows()
    if workflows:
        return workflows
    workflows = [_default_workflow()]
    _save_workflows(workflows)
    return workflows


def list_workflows() -> list[dict]:
    """返回所有工作流定义；首次为空时写入并返回默认模板。"""
    workflows = ensure_default_workflows()
    return sorted((copy.deepcopy(w) for w in workflows), key=lambda item: item.get("updated_at", 0), reverse=True)


def get_workflow(workflow_id: str) -> dict | None:
    for workflow in ensure_default_workflows():
        if str(workflow.get("id")) == str(workflow_id):
            return copy.deepcopy(workflow)
    return None


def save_workflow(workflow: dict) -> dict:
    if not isinstance(workflow, dict):
        raise ValueError("workflow must be object")
    now = _now()
    saved = copy.deepcopy(workflow)
    saved["id"] = str(saved.get("id") or f"wf-{uuid.uuid4().hex[:12]}")
    saved["name"] = str(saved.get("name") or "未命名工作流")
    saved["description"] = str(saved.get("description") or "")
    saved["version"] = int(saved.get("version") or 1)
    saved["enabled"] = bool(saved.get("enabled", True))
    saved["variables"] = saved.get("variables") if isinstance(saved.get("variables"), dict) else {}
    saved["nodes"] = saved.get("nodes") if isinstance(saved.get("nodes"), list) else []
    saved["edges"] = saved.get("edges") if isinstance(saved.get("edges"), list) else []
    saved.setdefault("created_at", now)
    saved["updated_at"] = now

    workflows = ensure_default_workflows()
    for idx, item in enumerate(workflows):
        if str(item.get("id")) == saved["id"]:
            saved["created_at"] = item.get("created_at") or saved["created_at"]
            workflows[idx] = saved
            break
    else:
        workflows.append(saved)
    _save_workflows(workflows)
    return copy.deepcopy(saved)


def delete_workflow(workflow_id: str) -> bool:
    workflows = ensure_default_workflows()
    next_workflows = [w for w in workflows if str(w.get("id")) != str(workflow_id)]
    if len(next_workflows) == len(workflows):
        return False
    _save_workflows(next_workflows)
    return True


def create_run(workflow_id: str, inputs: dict | None = None) -> dict:
    workflow = get_workflow(workflow_id)
    if not workflow:
        raise ValueError("workflow not found")
    now = _now()
    run = {
        "id": f"run-{uuid.uuid4().hex}",
        "workflow_id": str(workflow_id),
        "workflow_name": workflow.get("name", ""),
        "status": "running",
        "inputs": inputs if isinstance(inputs, dict) else {},
        "started_at": now,
        "updated_at": now,
        "ended_at": None,
        "current_node_ids": [],
        "node_runs": {},
        "outputs": {},
        "artifacts": [],
        "events": [],
        "last_error": "",
    }
    runs = _load_runs()
    runs.append(run)
    _save_runs(runs)
    return copy.deepcopy(run)


def list_runs(workflow_id: str | None = None, limit: int = 100) -> list[dict]:
    runs = _load_runs()
    if workflow_id:
        runs = [r for r in runs if str(r.get("workflow_id")) == str(workflow_id)]
    runs.sort(key=lambda item: item.get("updated_at") or item.get("started_at") or 0, reverse=True)
    return copy.deepcopy(runs[: max(1, min(int(limit or 100), 500))])


def get_run(run_id: str) -> dict | None:
    for run in _load_runs():
        if str(run.get("id")) == str(run_id):
            return copy.deepcopy(run)
    return None


def update_run(run_id: str, patch: dict) -> dict | None:
    runs = _load_runs()
    updated = None
    for idx, run in enumerate(runs):
        if str(run.get("id")) != str(run_id):
            continue
        next_run = dict(run)
        next_run.update(copy.deepcopy(patch or {}))
        next_run["updated_at"] = _now()
        runs[idx] = next_run
        updated = next_run
        break
    if updated is None:
        return None
    _save_runs(runs)
    return copy.deepcopy(updated)


def append_node_event(run_id: str, node_id: str, event: str, payload: dict | None = None) -> dict | None:
    runs = _load_runs()
    updated = None
    now = _now()
    entry = {
        "ts": now,
        "node_id": str(node_id or ""),
        "event": str(event or ""),
        "payload": copy.deepcopy(payload or {}),
    }
    for idx, run in enumerate(runs):
        if str(run.get("id")) != str(run_id):
            continue
        events = run.get("events") if isinstance(run.get("events"), list) else []
        events.append(entry)
        run["events"] = events[-1000:]
        node_runs = run.get("node_runs") if isinstance(run.get("node_runs"), dict) else {}
        if node_id:
            node = node_runs.get(node_id) if isinstance(node_runs.get(node_id), dict) else {}
            node.setdefault("events", [])
            node["events"].append(entry)
            node["events"] = node["events"][-200:]
            node_runs[node_id] = node
        run["node_runs"] = node_runs
        run["updated_at"] = now
        runs[idx] = run
        updated = run
        break
    if updated is None:
        return None
    _save_runs(runs)
    return copy.deepcopy(updated)


def update_run_output(run_id: str, node_id: str, output_key: str, output: dict) -> dict | None:
    """记录节点输出，供后续节点模板引用。"""
    run = get_run(run_id)
    if not run:
        return None
    outputs = run.get("outputs") if isinstance(run.get("outputs"), dict) else {}
    key = str(output_key or node_id or "")
    if key:
        outputs[key] = copy.deepcopy(output or {})
    if node_id and node_id != key:
        outputs[str(node_id)] = copy.deepcopy(output or {})
    return update_run(run_id, {"outputs": outputs})


def append_run_artifact(run_id: str, artifact: dict) -> dict | None:
    """追加运行产物记录。"""
    run = get_run(run_id)
    if not run:
        return None
    artifacts = run.get("artifacts") if isinstance(run.get("artifacts"), list) else []
    item = copy.deepcopy(artifact or {})
    item.setdefault("id", f"artifact-{uuid.uuid4().hex[:8]}")
    item.setdefault("created_at", _now())
    artifacts.append(item)
    return update_run(run_id, {"artifacts": artifacts})
