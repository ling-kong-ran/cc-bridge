"""飞书消息网关核心逻辑。"""
import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any, Callable

try:
    import lark_oapi as lark
    from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody
except ImportError:
    lark = None
    CreateMessageRequest = None
    CreateMessageRequestBody = None

FEISHU_GATEWAY_AVAILABLE = lark is not None and CreateMessageRequest is not None and CreateMessageRequestBody is not None
FEISHU_GATEWAY_UNAVAILABLE_REASON = "" if FEISHU_GATEWAY_AVAILABLE else "飞书 SDK 未安装，网关功能已屏蔽"

from ccb_bridge import get_current_cli
from feishu_gateway_store import (
    get_feishu_gateway_config,
    get_scope,
    is_event_processed,
    mark_event_processed,
    reset_scope,
    save_scope,
)
from session_store import add_session_usage, save_session


@dataclass
class FeishuMessage:
    event_id: str
    message_id: str
    chat_id: str
    user_id: str
    text: str
    raw: dict[str, Any]


class FeishuGateway:
    def __init__(self, session_manager, default_cwd: str, default_model_getter: Callable[[], str]):
        self.session_manager = session_manager
        self.default_cwd = default_cwd
        self.default_model_getter = default_model_getter
        self._scope_locks: dict[str, asyncio.Lock] = {}
        self._lark_client = None
        self._lark_client_key = ""

    async def handle_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not FEISHU_GATEWAY_AVAILABLE:
            return {"ok": False, "error": FEISHU_GATEWAY_UNAVAILABLE_REASON}

        config = get_feishu_gateway_config(redact=False)
        if not config.get("enabled"):
            return {"ok": False, "error": "飞书网关未启用"}

        if payload.get("challenge"):
            return {"challenge": payload.get("challenge")}

        if payload.get("schema") == "2.0" and payload.get("header", {}).get("event_type") == "url_verification":
            return {"challenge": payload.get("challenge")}

        token = str(config.get("verification_token") or "").strip()
        header = payload.get("header") if isinstance(payload.get("header"), dict) else {}
        if token and header.get("token") and header.get("token") != token:
            return {"ok": False, "error": "飞书事件 token 校验失败"}

        message = self._parse_message(payload)
        if not message:
            return {"ok": True, "ignored": True}
        if is_event_processed(message.event_id):
            return {"ok": True, "duplicate": True}
        if not self._is_allowed(config, message):
            mark_event_processed(message.event_id)
            return {"ok": True, "ignored": True, "reason": "not_allowed"}
        mark_event_processed(message.event_id)

        asyncio.create_task(self._handle_message(config, message))
        return {"ok": True, "accepted": True}

    async def reset_scope(self, chat_id: str) -> bool:
        scope_key = self._scope_key(chat_id)
        session = self._get_scope_session(scope_key)
        if session and session.is_running:
            await session.stop()
        return reset_scope(scope_key)

    async def stop_scope(self, chat_id: str) -> bool:
        scope_key = self._scope_key(chat_id)
        session = self._get_scope_session(scope_key)
        if not session or not session.is_running:
            return False
        await session.stop()
        return True

    def _parse_message(self, payload: dict[str, Any]) -> FeishuMessage | None:
        header = payload.get("header") if isinstance(payload.get("header"), dict) else {}
        event = payload.get("event") if isinstance(payload.get("event"), dict) else payload
        message = event.get("message") if isinstance(event.get("message"), dict) else {}
        if not message:
            return None
        if message.get("message_type") != "text":
            return None
        chat_id = str(message.get("chat_id") or "").strip()
        message_id = str(message.get("message_id") or "").strip()
        content = message.get("content") or ""
        text = ""
        if isinstance(content, str):
            try:
                parsed = json.loads(content)
                text = str(parsed.get("text") or "") if isinstance(parsed, dict) else content
            except json.JSONDecodeError:
                text = content
        elif isinstance(content, dict):
            text = str(content.get("text") or "")
        sender = event.get("sender") if isinstance(event.get("sender"), dict) else {}
        sender_id = sender.get("sender_id") if isinstance(sender.get("sender_id"), dict) else {}
        user_id = str(sender_id.get("user_id") or sender_id.get("open_id") or sender.get("sender_id") or "").strip()
        event_id = str(header.get("event_id") or message_id or f"feishu-{time.time()}")
        if not chat_id or not text.strip():
            return None
        return FeishuMessage(event_id=event_id, message_id=message_id, chat_id=chat_id, user_id=user_id, text=text.strip(), raw=payload)

    def _is_allowed(self, config: dict[str, Any], message: FeishuMessage) -> bool:
        allowed_chats = set(config.get("allowed_chats") or [])
        allowed_users = set(config.get("allowed_users") or [])
        if not allowed_chats and not allowed_users:
            return False
        return message.chat_id in allowed_chats or message.user_id in allowed_users

    async def _handle_message(self, config: dict[str, Any], message: FeishuMessage):
        scope_key = self._scope_key(message.chat_id)
        lock = self._scope_locks.setdefault(scope_key, asyncio.Lock())
        if lock.locked() and config.get("busy_mode") == "reject":
            await self._send_reply(config, message.chat_id, "当前任务仍在执行，请稍后再发，或发送 /stop 中断。")
            return
        async with lock:
            if message.text in ("/new", "/reset"):
                reset_scope(scope_key)
                await self._send_reply(config, message.chat_id, "已开始新的会话。")
                return
            if message.text == "/status":
                await self._send_reply(config, message.chat_id, self._status_text(scope_key))
                return
            if message.text == "/stop":
                stopped = await self.stop_scope(message.chat_id)
                await self._send_reply(config, message.chat_id, "已停止当前任务。" if stopped else "当前没有运行中的任务。")
                return
            try:
                reply = await self._run_agent_turn(config, scope_key, message)
            except Exception as exc:
                reply = f"执行失败：{exc}"
            await self._send_reply(config, message.chat_id, reply or "[SILENT]")

    async def _run_agent_turn(self, config: dict[str, Any], scope_key: str, message: FeishuMessage) -> str:
        scope = get_scope(scope_key)
        client_id = f"gateway:feishu:{message.chat_id}"
        run_id, session = self.session_manager.create_session(client_id)
        session_id = str(scope.get("session_id") or "")
        if session_id:
            session.session_id = session_id
            self.session_manager.bind_native_session(session_id, run_id)

        model = str(scope.get("model") or config.get("default_model") or self.default_model_getter())
        cwd = str(scope.get("cwd") or config.get("default_cwd") or self.default_cwd)
        cli = str(scope.get("cli") or config.get("default_cli") or get_current_cli())
        collected: list[str] = []
        final_text = ""

        async def on_event(event: dict[str, Any]):
            nonlocal session_id, final_text
            evt_type = event.get("type")
            sid = event.get("session_id") or session.session_id or session_id
            if evt_type == "session_id_captured" and sid:
                session_id = sid
                save_scope(scope_key, {
                    "session_id": sid,
                    "chat_id": message.chat_id,
                    "model": model,
                    "cwd": cwd,
                    "cli": cli,
                    "last_message_id": message.message_id,
                })
                save_session(sid, message.text[:50] or "飞书会话", model, cwd, cli=cli)
            elif evt_type == "assistant":
                text = self._extract_text(event)
                if text:
                    collected.append(text)
            elif evt_type == "result":
                result_text = str(event.get("result") or "").strip()
                if result_text:
                    final_text = result_text
                usage = event.get("usage") if isinstance(event.get("usage"), dict) else None
                add_session_usage(sid or session_id, float(event.get("total_cost_usd") or 0), usage)
            elif evt_type == "error":
                msg = str(event.get("message") or "").strip()
                if msg:
                    final_text = f"执行失败：{msg}"

        await session.start(model=model, cwd=cwd, resume_id=session_id or None, on_event=on_event, skip_permissions=bool(config.get("skip_permissions", True)), cli=cli)
        try:
            await session.send_message(message.text, owner_id=client_id, prefer_persistent=False)
        finally:
            self.session_manager.finish_run(run_id)
        if session.session_id:
            save_scope(scope_key, {
                "session_id": session.session_id,
                "chat_id": message.chat_id,
                "model": model,
                "cwd": cwd,
                "cli": cli,
                "last_message_id": message.message_id,
            })
        return final_text or "\n".join(part for part in collected if part).strip()

    def _extract_text(self, value: Any) -> str:
        chunks: list[str] = []

        def walk(node: Any):
            if isinstance(node, dict):
                if isinstance(node.get("text"), str):
                    chunks.append(node["text"])
                for key in ("content", "message"):
                    if key in node:
                        walk(node[key])
            elif isinstance(node, list):
                for item in node:
                    walk(item)
            elif isinstance(node, str):
                chunks.append(node)

        walk(value.get("message") if isinstance(value, dict) else value)
        return "".join(chunks).strip()

    def _status_text(self, scope_key: str) -> str:
        scope = get_scope(scope_key)
        if not scope:
            return "当前聊天还没有绑定会话。"
        running = bool(self._get_scope_session(scope_key) and self._get_scope_session(scope_key).is_running)
        return "\n".join([
            f"session_id: {scope.get('session_id', '')}",
            f"model: {scope.get('model', '')}",
            f"cwd: {scope.get('cwd', '')}",
            f"running: {'yes' if running else 'no'}",
        ])

    def _scope_key(self, chat_id: str) -> str:
        return f"feishu:chat:{chat_id}"

    def _get_scope_session(self, scope_key: str):
        scope = get_scope(scope_key)
        sid = scope.get("session_id")
        return self.session_manager.get_session_by_native_id(sid) if sid else None

    async def _send_reply(self, config: dict[str, Any], chat_id: str, text: str):
        client = self._get_lark_client(config)
        for part in self._split_text(text):
            request = CreateMessageRequest.builder() \
                .receive_id_type("chat_id") \
                .request_body(CreateMessageRequestBody.builder()
                    .receive_id(chat_id)
                    .msg_type("text")
                    .content(json.dumps({"text": part}, ensure_ascii=False))
                    .build()) \
                .build()
            response = await asyncio.to_thread(client.im.v1.message.create, request)
            if not response.success():
                raise RuntimeError(f"飞书消息发送失败：{response.code} {response.msg}")

    def _get_lark_client(self, config: dict[str, Any]):
        if not FEISHU_GATEWAY_AVAILABLE:
            raise RuntimeError(FEISHU_GATEWAY_UNAVAILABLE_REASON)
        app_id = str(config.get("app_id") or "").strip()
        app_secret = str(config.get("app_secret") or "").strip()
        if not app_id or not app_secret:
            raise RuntimeError("飞书 app_id/app_secret 未配置")
        key = f"{app_id}:{app_secret}"
        if self._lark_client is None or self._lark_client_key != key:
            self._lark_client = lark.Client.builder().app_id(app_id).app_secret(app_secret).build()
            self._lark_client_key = key
        return self._lark_client

    def _split_text(self, text: str, limit: int = 3500) -> list[str]:
        text = text.strip() or "[SILENT]"
        return [text[i:i + limit] for i in range(0, len(text), limit)]
