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
                # 捕获本次 one-shot 产生的会话 id，结束后清理其残留 jsonl
                sid = event.get("session_id")
                if sid and not probe_session_id:
                    probe_session_id = sid
                evt_type = event.get("type")
                if evt_type in ("assistant", "stream_event", "result"):
                    piece = _extract_text(event)
                    if piece:
                        accumulated.append(piece)

        await asyncio.wait_for(_drain(), timeout=timeout)
        return _parse_memory_json("\n\n".join(accumulated))
    except (asyncio.TimeoutError, Exception):
        return []
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
        # 删除 one-shot 探测会话残留的空 jsonl，避免历史里堆积
        if probe_session_id:
            try:
                from session_store import _delete_session_files
                _delete_session_files(probe_session_id, run_cwd)
            except Exception:
                pass


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


def _parse_memory_json(text: str) -> list[dict[str, Any]]:
    """把 LLM 返回的文本解析为候选 dict 列表；解析失败返回 []。"""
    text = (text or "").strip()
    if not text:
        return []
    # 剥离 markdown 代码块围栏
    if text.startswith("```"):
        text = text.split("```", 2)
        # 取第一对围栏之间的内容
        if len(text) >= 2:
            inner = text[1]
            if inner.startswith("json"):
                inner = inner[4:]
            text = inner.strip()
    # 容忍前后混入散文：截取首个 [ 到末个 ]
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end < 0 or end <= start:
        return []
    fragment = text[start:end + 1]
    try:
        data = json.loads(fragment)
    except json.JSONDecodeError:
        return []
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
