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
WORKFLOW_REQUEST_TOKEN = "{{inputs.request}}"
SUPERVISOR_PROMPTS = {
    "supervisor": (
        "用户需求：\n{{inputs.request}}\n\n"
        "你是工作流调度节点。只做任务拆解和下一步判断，不要创建、修改或删除文件，不要执行命令。\n"
        "输出：1. 目标摘要；2. 需要读取/确认的信息；3. 给 Worker 的具体执行指令；4. 验收标准。"
    ),
    "researcher": (
        "用户需求：\n{{inputs.request}}\n\nSupervisor 输出：\n{{outputs.supervision}}\n\n"
        "你是研究节点。只阅读和分析相关代码、目录、日志或上下文，不要修改文件。\n"
        "输出事实依据、相关路径和给 Worker 的注意事项。"
    ),
    "worker": (
        "用户需求：\n{{inputs.request}}\n\nSupervisor 输出：\n{{outputs.supervision}}\n\nResearcher 输出：\n{{outputs.research}}\n\n"
        "你是执行节点。根据上游结论完成必要修改或创建文件，保持改动聚焦，最后说明修改了哪些文件。"
    ),
    "checker": (
        "用户需求：\n{{inputs.request}}\n\nWorker 输出：\n{{outputs.work}}\n\n"
        "你是验证节点。检查执行结果，运行必要的轻量验证，输出是否通过、失败原因和后续建议。"
    ),
}


def _now() -> float:
    return time.time()


def _timeout_at_least(value: Any, minimum: int) -> int:
    try:
        current = int(value or 0)
    except (TypeError, ValueError):
        current = 0
    return max(minimum, current)


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


def _normalize_workflow(workflow: dict) -> dict:
    """移除旧版模拟执行配置，确保工作流默认真实执行。"""
    item = copy.deepcopy(workflow)
    variables = item.get("variables") if isinstance(item.get("variables"), dict) else {}
    variables.pop("execution_mode", None)
    item["variables"] = variables
    if item.get("pattern") == "supervisor_dynamic":
        for edge in item.get("edges", []) if isinstance(item.get("edges"), list) else []:
            if not isinstance(edge, dict):
                continue
            if edge.get("from") == "decision" and edge.get("to") == "end" and edge.get("when") == "approved":
                edge["when"] = "true"
    for node in item.get("nodes", []) if isinstance(item.get("nodes"), list) else []:
        if not isinstance(node, dict):
            continue
        config = node.get("config") if isinstance(node.get("config"), dict) else {}
        config.pop("mode", None)
        if str(node.get("type") or "") == "agent":
            role = str(config.get("role") or "").strip()
            if item.get("pattern") == "supervisor_dynamic" and role in SUPERVISOR_PROMPTS:
                config["prompt"] = SUPERVISOR_PROMPTS[role]
                if role == "supervisor":
                    config["timeout_seconds"] = _timeout_at_least(config.get("timeout_seconds"), 240)
                elif role in {"researcher", "checker"}:
                    config["timeout_seconds"] = _timeout_at_least(config.get("timeout_seconds"), 600)
                elif role == "worker":
                    config["timeout_seconds"] = _timeout_at_least(config.get("timeout_seconds"), 900)
            prompt = str(config.get("prompt") or "").strip()
            if WORKFLOW_REQUEST_TOKEN not in prompt:
                config["prompt"] = f"用户需求：\n{WORKFLOW_REQUEST_TOKEN}\n\n{prompt}".strip()
        node["config"] = config
    return item


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
        "description": "执行需求分析、代码修改、测试、复核和报告生成，适合真实代码变更工作流。",
        "version": 1,
        "enabled": True,
        "variables": {
            "cwd": "",
            "model": "",
        },
        "nodes": [
            {"id": "start", "type": "start", "title": "开始"},
            {"id": "analyze", "type": "agent", "title": "分析需求", "config": {"prompt": "用户需求：\n{{inputs.request}}\n\n分析需求和当前改动，输出实施计划。", "output_key": "analysis"}},
            {"id": "implement", "type": "agent", "title": "代码修改", "config": {"prompt": "用户需求：\n{{inputs.request}}\n\n分析输出：\n{{outputs.analysis}}\n\n根据分析结果修改代码。", "output_key": "implementation"}},
            {"id": "test", "type": "command", "title": "运行测试", "config": {"command": "python -m py_compile server.py", "requires_approval": False}},
            {"id": "review", "type": "approval", "title": "人工复核", "config": {"message": "请确认修改和测试结果是否可以继续生成报告。", "approve_label": "继续", "reject_label": "取消"}},
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


def _template_catalog() -> list[dict]:
    """返回内置多 Agent 工作流模板。"""
    return [
        {
            "id": "single_agent_chat",
            "name": "单 Agent 对话",
            "description": "一个 Claude Code Agent 独立完成理解、执行与总结，适合轻量任务。",
            "pattern": "single_agent_chat",
            "nodes": [
                {"id": "start", "type": "start", "title": "开始", "position": {"x": 44, "y": 120}},
                {"id": "agent", "type": "agent", "title": "执行任务", "position": {"x": 300, "y": 120}, "config": {"role": "generalist", "prompt": "用户需求：\n{{inputs.request}}\n\n理解用户目标并完成任务，最后输出简明总结。", "output_key": "answer"}},
                {"id": "end", "type": "end", "title": "完成", "position": {"x": 560, "y": 120}},
            ],
            "edges": [
                {"id": "edge-start-agent", "from": "start", "to": "agent"},
                {"id": "edge-agent-end", "from": "agent", "to": "end"},
            ],
        },
        {
            "id": "router_specialists",
            "name": "路由专家协作",
            "description": "先由 Router 判断任务方向，再分发给前端/后端/验证专家。",
            "pattern": "router_specialists",
            "nodes": [
                {"id": "start", "type": "start", "title": "开始", "position": {"x": 44, "y": 210}},
                {"id": "router", "type": "agent", "title": "Router 分类", "position": {"x": 270, "y": 210}, "config": {"role": "router", "prompt": "用户需求：\n{{inputs.request}}\n\n判断任务更偏前端、后端还是验证，并输出路由建议。", "output_key": "route"}},
                {"id": "frontend", "type": "agent", "title": "前端专家", "position": {"x": 535, "y": 60}, "config": {"role": "frontend_specialist", "prompt": "用户需求：\n{{inputs.request}}\n\n路由输出：\n{{outputs.route}}\n\n处理 UI、交互、样式与本地化相关问题。", "output_key": "frontend"}},
                {"id": "backend", "type": "agent", "title": "后端专家", "position": {"x": 535, "y": 210}, "config": {"role": "backend_specialist", "prompt": "用户需求：\n{{inputs.request}}\n\n路由输出：\n{{outputs.route}}\n\n处理 API、持久化、执行器与服务端逻辑。", "output_key": "backend"}},
                {"id": "validate", "type": "agent", "title": "验证专家", "position": {"x": 535, "y": 360}, "config": {"role": "validator", "prompt": "用户需求：\n{{inputs.request}}\n\n检查方案风险、边界条件与验证步骤。", "output_key": "validation"}},
                {"id": "merge", "type": "artifact", "title": "汇总结果", "position": {"x": 800, "y": 210}, "config": {"role": "synthesizer", "format": "markdown", "filename": "router-specialists.md", "output_key": "summary"}},
                {"id": "end", "type": "end", "title": "完成", "position": {"x": 1060, "y": 210}},
            ],
            "edges": [
                {"id": "edge-start-router", "from": "start", "to": "router"},
                {"id": "edge-router-frontend", "from": "router", "to": "frontend", "when": "true"},
                {"id": "edge-router-backend", "from": "router", "to": "backend", "when": "true"},
                {"id": "edge-router-validate", "from": "router", "to": "validate", "when": "succeeded"},
                {"id": "edge-frontend-merge", "from": "frontend", "to": "merge"},
                {"id": "edge-backend-merge", "from": "backend", "to": "merge"},
                {"id": "edge-validate-merge", "from": "validate", "to": "merge"},
                {"id": "edge-merge-end", "from": "merge", "to": "end"},
            ],
        },
        {
            "id": "planner_executor",
            "name": "计划-执行-复核",
            "description": "Planner 制定计划，Executor 执行，Reviewer 审核后生成报告。",
            "pattern": "planner_executor",
            "nodes": [
                {"id": "start", "type": "start", "title": "开始", "position": {"x": 44, "y": 150}},
                {"id": "planner", "type": "agent", "title": "Planner 计划", "position": {"x": 285, "y": 150}, "config": {"role": "planner", "prompt": "用户需求：\n{{inputs.request}}\n\n拆解目标，产出可执行步骤和验收标准。", "output_key": "plan"}},
                {"id": "executor", "type": "agent", "title": "Executor 执行", "position": {"x": 545, "y": 150}, "config": {"role": "executor", "prompt": "用户需求：\n{{inputs.request}}\n\n计划输出：\n{{outputs.plan}}\n\n按计划完成具体修改或操作，并记录关键结果。", "output_key": "execution"}},
                {"id": "reviewer", "type": "agent", "title": "Reviewer 复核", "position": {"x": 805, "y": 150}, "config": {"role": "reviewer", "prompt": "用户需求：\n{{inputs.request}}\n\n计划输出：\n{{outputs.plan}}\n\n执行输出：\n{{outputs.execution}}\n\n根据验收标准检查执行结果，指出问题和建议。", "output_key": "review"}},
                {"id": "approval", "type": "approval", "title": "人工确认", "position": {"x": 1065, "y": 150}, "config": {"role": "human_gate"}},
                {"id": "report", "type": "artifact", "title": "生成报告", "position": {"x": 1325, "y": 150}, "config": {"role": "reporter", "format": "markdown", "filename": "planner-executor-report.md"}},
                {"id": "end", "type": "end", "title": "完成", "position": {"x": 1585, "y": 150}},
            ],
            "edges": [
                {"id": "edge-start-planner", "from": "start", "to": "planner"},
                {"id": "edge-planner-executor", "from": "planner", "to": "executor"},
                {"id": "edge-executor-reviewer", "from": "executor", "to": "reviewer"},
                {"id": "edge-reviewer-approval", "from": "reviewer", "to": "approval"},
                {"id": "edge-approval-report", "from": "approval", "to": "report", "when": "approved"},
                {"id": "edge-report-end", "from": "report", "to": "end"},
            ],
        },
        {
            "id": "supervisor_dynamic",
            "name": "Supervisor 动态分配",
            "description": "监督者持续评估状态，按需派发研究、执行和验证节点。",
            "pattern": "supervisor_dynamic",
            "nodes": [
                {"id": "start", "type": "start", "title": "开始", "position": {"x": 44, "y": 190}},
                {"id": "supervisor", "type": "agent", "title": "Supervisor", "position": {"x": 300, "y": 190}, "config": {"role": "supervisor", "prompt": SUPERVISOR_PROMPTS["supervisor"], "output_key": "supervision", "timeout_seconds": 240}},
                {"id": "researcher", "type": "agent", "title": "Researcher", "position": {"x": 565, "y": 70}, "config": {"role": "researcher", "prompt": SUPERVISOR_PROMPTS["researcher"], "output_key": "research", "timeout_seconds": 600}},
                {"id": "worker", "type": "agent", "title": "Worker", "position": {"x": 565, "y": 220}, "config": {"role": "worker", "prompt": SUPERVISOR_PROMPTS["worker"], "output_key": "work", "timeout_seconds": 900}},
                {"id": "checker", "type": "agent", "title": "Checker", "position": {"x": 565, "y": 370}, "config": {"role": "checker", "prompt": SUPERVISOR_PROMPTS["checker"], "output_key": "check", "timeout_seconds": 600}},
                {"id": "decision", "type": "condition", "title": "是否通过", "position": {"x": 835, "y": 220}, "config": {"role": "decision_gate"}},
                {"id": "end", "type": "end", "title": "完成", "position": {"x": 1105, "y": 220}},
            ],
            "edges": [
                {"id": "edge-start-supervisor", "from": "start", "to": "supervisor"},
                {"id": "edge-supervisor-researcher", "from": "supervisor", "to": "researcher", "when": "succeeded"},
                {"id": "edge-researcher-worker", "from": "researcher", "to": "worker"},
                {"id": "edge-worker-checker", "from": "worker", "to": "checker"},
                {"id": "edge-checker-decision", "from": "checker", "to": "decision"},
                {"id": "edge-decision-supervisor", "from": "decision", "to": "supervisor", "when": "false"},
                {"id": "edge-decision-end", "from": "decision", "to": "end", "when": "true"},
            ],
        },
        {
            "id": "peer_handoff",
            "name": "Peer Handoff 接力",
            "description": "多个同级 Agent 依次接力：分析、实现、验证、总结。",
            "pattern": "peer_handoff",
            "nodes": [
                {"id": "start", "type": "start", "title": "开始", "position": {"x": 44, "y": 150}},
                {"id": "analyst", "type": "agent", "title": "Analyst", "position": {"x": 285, "y": 150}, "config": {"role": "peer_analyst", "handoff": "developer", "prompt": "用户需求：\n{{inputs.request}}\n\n分析目标、约束和风险，把上下文交接给开发者。", "output_key": "analysis"}},
                {"id": "developer", "type": "agent", "title": "Developer", "position": {"x": 545, "y": 150}, "config": {"role": "peer_developer", "handoff": "tester", "prompt": "用户需求：\n{{inputs.request}}\n\nAnalyst 输出：\n{{outputs.analysis}}\n\n基于 Analyst 的结论完成实现，并交接给测试者。", "output_key": "development"}},
                {"id": "tester", "type": "agent", "title": "Tester", "position": {"x": 805, "y": 150}, "config": {"role": "peer_tester", "handoff": "summarizer", "prompt": "用户需求：\n{{inputs.request}}\n\nDeveloper 输出：\n{{outputs.development}}\n\n验证实现结果，记录通过项和失败项。", "output_key": "test"}},
                {"id": "summarizer", "type": "artifact", "title": "Summarizer", "position": {"x": 1065, "y": 150}, "config": {"role": "peer_summarizer", "format": "markdown", "filename": "peer-handoff-summary.md"}},
                {"id": "end", "type": "end", "title": "完成", "position": {"x": 1325, "y": 150}},
            ],
            "edges": [
                {"id": "edge-start-analyst", "from": "start", "to": "analyst"},
                {"id": "edge-analyst-developer", "from": "analyst", "to": "developer"},
                {"id": "edge-developer-tester", "from": "developer", "to": "tester"},
                {"id": "edge-tester-summarizer", "from": "tester", "to": "summarizer"},
                {"id": "edge-summarizer-end", "from": "summarizer", "to": "end"},
            ],
        },
    ]


def list_workflow_templates() -> list[dict]:
    """返回可用于创建工作流的模板元数据。"""
    return [
        {"id": item["id"], "name": item["name"], "description": item["description"], "pattern": item["pattern"], "nodes_count": len(item.get("nodes", []))}
        for item in _template_catalog()
    ]


def instantiate_workflow_template(template_id: str) -> dict:
    """基于模板创建并保存一个新工作流。"""
    template = next((item for item in _template_catalog() if item.get("id") == template_id), None)
    if not template:
        raise ValueError("template not found")
    now = _now()
    workflow = {
        "id": f"wf-{template_id}-{uuid.uuid4().hex[:8]}",
        "name": template["name"],
        "description": template["description"],
        "version": 1,
        "enabled": True,
        "pattern": template.get("pattern", template_id),
        "variables": {"cwd": "", "model": ""},
        "nodes": copy.deepcopy(template.get("nodes", [])),
        "edges": copy.deepcopy(template.get("edges", [])),
        "created_at": now,
        "updated_at": now,
    }
    return save_workflow(workflow)


def ensure_default_workflows() -> list[dict]:
    workflows = _load_workflows()
    if workflows:
        normalized = [_normalize_workflow(workflow) for workflow in workflows if isinstance(workflow, dict)]
        if normalized != workflows:
            _save_workflows(normalized)
        return normalized
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
            return _normalize_workflow(workflow)
    return None


def save_workflow(workflow: dict) -> dict:
    if not isinstance(workflow, dict):
        raise ValueError("workflow must be object")
    workflow = _normalize_workflow(workflow)
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
