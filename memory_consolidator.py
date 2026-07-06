"""
自动记忆沉淀 MVP。

规则目标很保守：只沉淀用户明确要求长期记住的偏好/规则，避免把普通对话流水写入 memory。
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any

from memory_index import index_memory, save_memory_file, search_memory

JOBS_PATH = Path.home() / ".ccb" / "memory_consolidation_jobs.json"
JOBS_PATH.parent.mkdir(parents=True, exist_ok=True)

_CONFIRM_RE = re.compile(r"(记住|记一下|以后|下次|每次|不要再|别再|不需要确认|无需确认|默认|偏好|习惯)")
_SENSITIVE_RE = re.compile(
    r"(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Authorization\s*:|password\s*=|token\s*=)",
    re.IGNORECASE,
)


def enqueue_consolidation(session_id: str, cwd: str, run_id: str, client_id: str, user_message: str = "", assistant_summary: str = "") -> str:
    """创建后台沉淀任务，返回 job_id。"""
    key = f"{session_id}|{run_id}|{client_id}|{user_message[:120]}"
    job_id = "memjob_" + hashlib.sha1(key.encode("utf-8", "ignore")).hexdigest()[:16]
    jobs = _load_jobs()
    if job_id not in jobs:
        now = time.time()
        jobs[job_id] = {
            "job_id": job_id,
            "session_id": session_id,
            "run_id": run_id,
            "client_id": client_id,
            "cwd": cwd,
            "status": "queued",
            "created_at": now,
            "updated_at": now,
            "user_message": user_message,
            "assistant_summary": assistant_summary,
            "candidates": 0,
            "written": 0,
            "skipped": 0,
            "files": [],
            "error": "",
        }
        _save_jobs(jobs)
    return job_id


def run_consolidation_job(job_id: str, settings: dict[str, Any] | None = None) -> dict[str, Any]:
    """执行沉淀任务。失败只记录到 job，不抛到主链路。"""
    settings = settings or {}
    jobs = _load_jobs()
    job = jobs.get(job_id)
    if not job:
        return {"job_id": job_id, "status": "failed", "error": "job not found"}
    if job.get("status") == "completed":
        return job
    try:
        job["status"] = "running"
        job["updated_at"] = time.time()
        _save_jobs(jobs)

        mode = settings.get("memoryAutoConsolidate", "auto")
        if mode == "off":
            job.update({"status": "skipped", "skipped": 1, "error": "memoryAutoConsolidate off"})
            job["updated_at"] = time.time()
            jobs[job_id] = job
            _save_jobs(jobs)
            return job

        candidates = extract_candidates(job, settings)
        job["candidates"] = len(candidates)
        written: list[dict[str, Any]] = []
        skipped = 0
        for candidate in candidates:
            result = resolve_and_write(candidate, job.get("cwd") or "")
            if result.get("ok"):
                written.append(result)
            else:
                skipped += 1

        if written:
            index_memory(job.get("cwd") or "", force=True)
        job.update({
            "status": "completed",
            "written": len(written),
            "skipped": skipped,
            "files": written,
            "updated_at": time.time(),
        })
    except Exception as exc:
        job.update({"status": "failed", "error": str(exc), "updated_at": time.time()})
    jobs[job_id] = job
    _save_jobs(jobs)
    return job


def extract_candidates(job: dict[str, Any], settings: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """规则提取：只处理明确长期偏好/协作规则。"""
    user_message = (job.get("user_message") or "").strip()
    if not user_message or len(user_message) < 4:
        return []
    if user_message.lstrip().startswith("/"):
        return []
    if _SENSITIVE_RE.search(user_message):
        return []
    if not _CONFIRM_RE.search(user_message):
        return []

    content = _clean_user_memory(user_message)
    if len(content) < 4:
        return []
    mem_type = _classify_type(content)
    title = _title_for(content, mem_type)
    return [{
        "type": mem_type,
        "title": title,
        "content": content,
        "session_id": job.get("session_id") or "",
        "run_id": job.get("run_id") or "",
        "created_at": time.strftime("%Y-%m-%d"),
    }]


def resolve_and_write(candidate: dict[str, Any], cwd: str) -> dict[str, Any]:
    """简单去重后自动写入 memory。"""
    content = candidate.get("content") or ""
    title = candidate.get("title") or "自动沉淀记忆"
    existing = search_memory(content[:200], cwd, limit=5)
    for item in existing:
        if _similar_title(title, item.get("title") or item.get("name") or ""):
            return {"ok": False, "reason": "duplicate", "title": title}

    filename = _unique_filename(candidate, cwd)
    body = _render_memory(candidate)
    saved = save_memory_file(filename, body, cwd)
    if not saved:
        return {"ok": False, "reason": "save failed", "title": title}
    return {"ok": True, "filename": saved.get("name", filename), "title": saved.get("title", title), "type": candidate.get("type", "feedback")}


def _clean_user_memory(text: str) -> str:
    text = re.sub(r"^\s*(请|麻烦你|帮我)?\s*(记住|记一下)[:：,，\s]*", "", text).strip()
    return re.sub(r"\s+", " ", text).strip()


def _classify_type(text: str) -> str:
    if re.search(r"(不要再|别再|不需要|无需|每次|以后|默认|偏好|习惯)", text):
        return "feedback"
    return "user"


def _title_for(text: str, mem_type: str) -> str:
    compact = re.sub(r"[\r\n#*_`\[\]<>]", "", text).strip()
    compact = compact[:36].strip(" ，。,.：:")
    prefix = "协作偏好" if mem_type == "feedback" else "用户记忆"
    return f"{prefix}：{compact}" if compact else prefix


def _slug(text: str) -> str:
    ascii_part = "-".join(re.findall(r"[A-Za-z0-9]+", text.lower()))[:48].strip("-")
    if ascii_part:
        return ascii_part
    digest = hashlib.sha1(text.encode("utf-8", "ignore")).hexdigest()[:10]
    return f"auto-memory-{digest}"


def _unique_filename(candidate: dict[str, Any], cwd: str) -> str:
    base = f"auto-{candidate.get('type') or 'memory'}-{_slug(candidate.get('content') or candidate.get('title') or '')}"
    filename = base + ".md"
    try:
        from memory_index import get_memory_file
        idx = 2
        while get_memory_file(filename, cwd):
            filename = f"{base}-{idx}.md"
            idx += 1
    except Exception:
        pass
    return filename


def _render_memory(candidate: dict[str, Any]) -> str:
    title = candidate.get("title") or "自动沉淀记忆"
    mem_type = candidate.get("type") or "feedback"
    created = candidate.get("created_at") or time.strftime("%Y-%m-%d")
    session_id = candidate.get("session_id") or ""
    run_id = candidate.get("run_id") or ""
    content = candidate.get("content") or ""
    return f"""---
name: {title}
description: 自动从对话沉淀的长期记忆
type: {mem_type}
source: session
created: {created}
session_id: {session_id}
run_id: {run_id}
inject: auto
---

{content}
""".strip() + "\n"


def _similar_title(a: str, b: str) -> bool:
    a_set = set(re.findall(r"[A-Za-z0-9\u4e00-\u9fff]", a.lower()))
    b_set = set(re.findall(r"[A-Za-z0-9\u4e00-\u9fff]", b.lower()))
    if not a_set or not b_set:
        return False
    return len(a_set & b_set) / max(1, min(len(a_set), len(b_set))) > 0.85


def _load_jobs() -> dict[str, Any]:
    if not JOBS_PATH.exists():
        return {}
    try:
        data = json.loads(JOBS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_jobs(jobs: dict[str, Any]) -> None:
    tmp = JOBS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(jobs, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(JOBS_PATH)
