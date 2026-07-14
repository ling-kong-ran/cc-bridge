"""
自动记忆沉淀 MVP。

规则目标很保守：只沉淀用户明确要求长期记住的偏好/规则，避免把普通对话流水写入 memory。
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from pathlib import Path
from typing import Any

from memory_index import index_memory, save_memory_file, search_memory

JOBS_PATH = Path.home() / ".ccb" / "memory_consolidation_jobs.json"
JOBS_PATH.parent.mkdir(parents=True, exist_ok=True)
_JOBS_LOCK = threading.RLock()

_CONFIRM_RE = re.compile(r"(记住|记一下|以后|下次|每次|不要再|别再|不需要确认|无需确认|默认|偏好|习惯)")
_SENSITIVE_RE = re.compile(
    r"(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Authorization\s*:|password\s*=|token\s*=)",
    re.IGNORECASE,
)


def enqueue_consolidation(session_id: str, cwd: str, run_id: str, client_id: str, user_message: str = "", assistant_summary: str = "") -> str:
    """创建后台沉淀任务，返回 job_id。"""
    key = f"{session_id}|{run_id}|{client_id}|{user_message[:120]}"
    job_id = "memjob_" + hashlib.sha1(key.encode("utf-8", "ignore")).hexdigest()[:16]
    with _JOBS_LOCK:
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


def run_consolidation_job(
    job_id: str,
    settings: dict[str, Any] | None = None,
    candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """执行沉淀任务。失败只记录到 job，不抛到主链路。

    candidates 语义：
    - None：调用方未提供 LLM 抽取结果，退回纯正则 extract_candidates（兜底）。
    - []   ：LLM 成功但无可抽取内容，什么都不写。
    - [...]：使用 LLM 抽取的候选记忆。
    """
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

        mode = settings.get("memoryAutoConsolidate", "safe")
        if mode == "off":
            job.update({"status": "skipped", "skipped": 1, "error": "memoryAutoConsolidate off"})
            job["updated_at"] = time.time()
            jobs[job_id] = job
            _save_jobs(jobs)
            return job

        # candidates 支持旧 list 语义，也支持 memory_llm.ExtractionResult。
        extraction_status = getattr(candidates, "status", None)
        if extraction_status == "failed":
            job["extraction_source"] = "regex_fallback"
            job["extraction_error"] = getattr(candidates, "error", "")
            candidates = extract_candidates(job, settings)
        elif extraction_status == "ok":
            job["extraction_source"] = "llm"
            candidates = list(getattr(candidates, "candidates", []) or [])
        elif candidates is None:
            candidates = extract_candidates(job, settings)
            job["extraction_source"] = "regex"
        else:
            job["extraction_source"] = "llm"

        for idx, candidate in enumerate(candidates):
            candidate.setdefault("session_id", job.get("session_id") or "")
            candidate.setdefault("run_id", job.get("run_id") or "")
            candidate.setdefault("source", job.get("extraction_source") or "")
            candidate.setdefault("candidate_index", idx)
        candidates = filter_sensitive(candidates)
        job["candidates"] = len(candidates)
        written: list[dict[str, Any]] = []
        skipped = 0
        pending: list[dict[str, Any]] = []
        for candidate in candidates:
            if mode == "suggest":
                pending.append(_candidate_to_pending(candidate, job))
                skipped += 1
                continue
            if mode == "safe" and job.get("extraction_source") != "regex_fallback":
                pending.append(_candidate_to_pending(candidate, job))
                skipped += 1
                continue
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
            "pending": pending,
            "updated_at": time.time(),
        })
    except Exception as exc:
        job.update({"status": "failed", "error": str(exc), "updated_at": time.time()})
    jobs[job_id] = job
    _save_jobs(jobs)
    return job


def _candidate_to_pending(candidate: dict[str, Any], job: dict[str, Any]) -> dict[str, Any]:
    """把候选转成待审核记录，暂不写入 Markdown。"""
    raw = f"{job.get('job_id', '')}|{candidate.get('candidate_index', 0)}|{candidate.get('content', '')}"
    return {
        "id": "memcand_" + hashlib.sha1(raw.encode("utf-8", "ignore")).hexdigest()[:16],
        "status": "pending",
        "type": candidate.get("type", "feedback"),
        "title": candidate.get("title", ""),
        "content": candidate.get("content", ""),
        "confidence": candidate.get("confidence"),
        "suggested_action": "create",
        "suggested_target": "",
        "source_session_id": job.get("session_id") or "",
        "source_run_id": job.get("run_id") or "",
        "created_at": time.time(),
        "decision_at": None,
        "decision_reason": "",
    }


def filter_sensitive(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """过滤掉命中敏感内容正则的候选（无论来自正则还是 LLM）。"""
    result: list[dict[str, Any]] = []
    for candidate in candidates:
        blob = f"{candidate.get('title', '')} {candidate.get('content', '')}"
        if _SENSITIVE_RE.search(blob):
            continue
        result.append(candidate)
    return result


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
    with _JOBS_LOCK:
        if not JOBS_PATH.exists():
            return {}
        try:
            data = json.loads(JOBS_PATH.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}


def _save_jobs(jobs: dict[str, Any]) -> None:
    with _JOBS_LOCK:
        JOBS_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = JOBS_PATH.with_name(f"{JOBS_PATH.name}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(jobs, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(JOBS_PATH)
