"""
记忆辅助模型 LLM 抽取。

每轮对话结束后，用一次短命 ccb/claude CLI 子进程（-p one-shot stream-json），
让「记忆辅助模型」从「用户消息 + 助手回复」里抽取值得长期记住的记忆。

设计上完全脱钩会话状态：不依赖 CCBSession，只镜像 _discover_slash_commands_uncached
的短命子进程模式（ccb_bridge.py:114）。任何异常都降级为返回空列表，绝不抛出——
调用方把 None 当作「退回纯正则兜底」、把 [] 当作「LLM 成功但无内容」。
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import ccb_bridge
from ccb_bridge import get_current_cli, validate_cli, validate_cwd

# 与 extract_candidates 返回的候选 dict 形状保持一致（memory_consolidator.py:121），
# 这样 resolve_and_write / _render_memory / _similar_title 等可原样复用。
_VALID_TYPES = ("user", "feedback", "preference")

_EXTRACT_PROMPT = """你是一个记忆提取助手。分析下面的【用户消息】和【助手回复】，提取出值得长期记住的用户偏好、协作规则、习惯或事实。

只提取明确、持久、可复用的信息。忽略一次性问题、临时上下文、代码片段本身、本轮临时结论。
如果没有值得记住的内容，返回空数组 []。

严格只输出一个 JSON 数组，不要包含任何解释文字、markdown 标记或代码块围栏。
每个元素格式：
{"title": "简短标题(<=36字)", "content": "完整记忆内容(一句话)", "type": "user | feedback | preference"}
- user: 用户的事实信息（角色、项目结构、环境等）
- feedback: 协作偏好或规则（以后用…、不要…、默认…、每次…）
- preference: 工具/技术/风格偏好

【用户消息】
{user_msg}

【助手回复】
{assistant}
"""


_ORGANIZE_PROMPT = """你是一个记忆库整理助手。下面是一个项目的全部记忆文件清单。你的任务是找出两类问题并给出修正建议：
1. 跨文件重复：同一条事实/规则/偏好出现在多个文件里（措辞不同但语义相同）。
2. 内容不准确：某条记忆明显错误、过时或自相矛盾，应当修正或删除。

【严格要求】
- 只标记真正的重复和真正的不准确。绝大多数文件应保持为 "keep"。
- 不要因为主题相近就合并 — 只有"同一事实被重复记录"才算重复。
- 不要重写正确的内容。只有"确有错误"才给 rewrite。
- delete 仅用于"完全无价值或已被其他文件完全覆盖"的情况，谨慎使用。
- 合并后的 new_content 必须保留所有被合并文件中的有效信息，不要丢内容。
- 严格只输出一个 JSON 数组，不要任何解释文字、markdown 或代码围栏。

【输出格式】每个元素：
{"action": "keep | merge | delete | rewrite",
 "targets": ["文件名.md", ...],
 "new_filename": "可选，merge 时建议的新文件名",
 "new_content": "可选，merge/rewrite 时的完整新内容",
 "reason": "简短中文说明"}

- keep: targets 是单个文件，其余字段留空。
- merge: targets 是 2 个及以上被合并文件，new_filename 给合并后文件名，new_content 给合并后完整正文（含 frontmatter）。
- delete: targets 是单个要删除的文件。删除前确认其信息已被其他文件覆盖或确无价值。
- rewrite: targets 是单个文件，new_content 是修正后的完整正文（保留 frontmatter）。

【记忆文件清单】
{memories}
"""


async def _run_llm_oneshot(
    prompt: str,
    model: str,
    cwd: str,
    cli: str | None = None,
    skip_permissions: bool = True,
    timeout: float = 120.0,
) -> str:
    """运行一次 ccb one-shot stream-json 子进程，返回累积的助手文本；任何失败返回空字符串。"""
    prompt = (prompt or "").strip()
    if not prompt:
        return ""

    try:
        cli_path = validate_cli(cli or get_current_cli())
        run_cwd = validate_cwd(cwd or "")
    except Exception:
        return ""

    cmd = [
        cli_path,
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--model", model,
    ]
    if skip_permissions:
        cmd += ["--dangerously-skip-permissions"]

    proc = None
    probe_session_id: str | None = None
    stderr_lines: list[str] = []
    stderr_task = None

    async def _read_stderr(process: asyncio.subprocess.Process) -> None:
        if not process.stderr:
            return
        try:
            while True:
                line = await process.stderr.readline()
                if not line:
                    break
                stderr_lines.append(line.decode("utf-8", errors="replace").strip())
        except (asyncio.CancelledError, Exception):
            pass

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=run_cwd,
            limit=1024 * 1024 * 5,
        )
        stderr_task = asyncio.create_task(_read_stderr(proc))

        if proc.stdin:
            proc.stdin.write(prompt.encode("utf-8"))
            await proc.stdin.drain()
            proc.stdin.close()

        accumulated: list[str] = []
        deadline = time.time() + timeout

        async def _drain() -> None:
            nonlocal probe_session_id
            assert proc is not None and proc.stdout is not None
            while True:
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=max(0.1, remaining))
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                try:
                    event = json.loads(text)
                except json.JSONDecodeError:
                    continue
                sid = event.get("session_id")
                if sid and not probe_session_id:
                    probe_session_id = sid
                if event.get("type") in ("assistant", "stream_event", "result"):
                    piece = _extract_text(event)
                    if piece:
                        accumulated.append(piece)

        await asyncio.wait_for(_drain(), timeout=timeout)
        return "\n\n".join(accumulated).strip()
    except (asyncio.TimeoutError, Exception):
        return ""
    finally:
        if proc:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                try:
                    await proc.wait()
                except Exception:
                    pass
        if stderr_task:
            stderr_task.cancel()
        if probe_session_id:
            try:
                from session_store import _delete_session_files
                _delete_session_files(probe_session_id, run_cwd)
            except Exception:
                pass


async def llm_json(
    prompt: str,
    model: str,
    cwd: str,
    cli: str | None = None,
    skip_permissions: bool = True,
    timeout: float = 120.0,
) -> list | dict | None:
    """通用 LLM 一次性调用，返回解析后的 JSON；任何失败返回 None。"""
    text = await _run_llm_oneshot(prompt, model, cwd, cli, skip_permissions, timeout)
    return _parse_json_lenient(text)


async def extract_memories_via_llm(
    user_message: str,
    assistant_summary: str,
    model: str,
    cwd: str,
    cli: str | None = None,
    skip_permissions: bool = True,
    timeout: float = 60.0,
) -> list[dict[str, Any]]:
    """用记忆辅助模型抽取候选记忆，返回候选 dict 列表；任何失败返回 []。"""
    user_message = (user_message or "").strip()
    assistant_summary = (assistant_summary or "").strip()
    if not user_message or len(user_message) < 4:
        return []

    try:
        cli_path = validate_cli(cli or get_current_cli())
        run_cwd = validate_cwd(cwd or "")
    except Exception:
        return []

    # 不能用 .format()：模板里的 JSON 示例 {"title": ...} 的花括号会被当成占位符，
    # 抛 KeyError。改用显式 replace 绕开 format 的花括号解析。
    prompt = _EXTRACT_PROMPT.replace("{user_msg}", user_message[:2000]).replace(
        "{assistant}", assistant_summary[:2000]
    )

    text = await _run_llm_oneshot(
        prompt=prompt,
        model=model,
        cwd=cwd,
        cli=cli,
        skip_permissions=skip_permissions,
        timeout=timeout,
    )
    return _parse_memory_json(text)


def _extract_text(event: dict) -> str:
    """从 assistant / stream_event / result 事件中提取文本块（镜像 server.py:_extract_assistant_text）。"""
    message = event.get("message") if isinstance(event.get("message"), dict) else {}
    content = message.get("content") if isinstance(message.get("content"), list) else []
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and block.get("text"):
            parts.append(str(block.get("text") or ""))
    return "\n\n".join(p.strip() for p in parts if p and p.strip()).strip()


def _strip_json_fences(text: str) -> str:
    """剥离 LLM 常见的 markdown JSON 围栏。"""
    text = (text or "").strip()
    if text.startswith("```"):
        parts = text.split("```", 2)
        if len(parts) >= 2:
            inner = parts[1]
            if inner.lstrip().startswith("json"):
                inner = inner.lstrip()[4:]
            text = inner.strip()
    return text


def _parse_json_lenient(text: str) -> list | dict | None:
    """宽松解析 LLM 返回的 JSON；支持前后混入散文或代码围栏。"""
    text = _strip_json_fences(text)
    if not text:
        return None

    candidates = [text]
    arr_start = text.find("[")
    arr_end = text.rfind("]")
    if arr_start >= 0 and arr_end > arr_start:
        candidates.append(text[arr_start:arr_end + 1])
    obj_start = text.find("{")
    obj_end = text.rfind("}")
    if obj_start >= 0 and obj_end > obj_start:
        candidates.append(text[obj_start:obj_end + 1])

    for fragment in candidates:
        try:
            data = json.loads(fragment)
        except json.JSONDecodeError:
            continue
        if isinstance(data, (list, dict)):
            return data
    return None


def _parse_memory_json(text: str) -> list[dict[str, Any]]:
    """把 LLM 返回的文本解析为候选 dict 列表；解析失败返回 []。"""
    data = _parse_json_lenient(text)
    if not isinstance(data, list):
        return []

    today = time.strftime("%Y-%m-%d")
    candidates: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "").strip()
        if len(content) < 4:
            continue
        mem_type = str(item.get("type") or "feedback").strip().lower()
        if mem_type not in _VALID_TYPES:
            mem_type = "feedback"
        title = str(item.get("title") or "").strip()
        if not title:
            title = content[:36].strip(" ，。,.：:")
        candidates.append({
            "type": mem_type,
            "title": title,
            "content": content,
            "session_id": "",
            "run_id": "",
            "created_at": today,
        })
    return candidates
