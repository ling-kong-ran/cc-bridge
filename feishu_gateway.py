"""飞书消息网关核心逻辑。"""
import asyncio
import datetime
import json
import os
import sys
import time
import threading
from dataclasses import dataclass
from typing import Any, Callable

_WS_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ws_debug.log")


def ws_log(msg: str) -> None:
    """写入 ws_debug.log 文件，确保日志不丢失。"""
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    line = f"{ts} {msg}"
    try:
        with open(_WS_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass

try:
    import lark_oapi as lark
    from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody
except ImportError:
    lark = None
    CreateMessageRequest = None
    CreateMessageRequestBody = None

try:
    import websockets  # noqa: F401  # lark_oapi.ws 依赖 websockets
    _WEBSOCKETS_AVAILABLE = True
except ImportError:
    _WEBSOCKETS_AVAILABLE = False

FEISHU_GATEWAY_AVAILABLE = lark is not None and CreateMessageRequest is not None and CreateMessageRequestBody is not None
FEISHU_GATEWAY_UNAVAILABLE_REASON = "" if FEISHU_GATEWAY_AVAILABLE else "飞书 SDK 未安装，网关功能已屏蔽"
FEISHU_WS_AVAILABLE = FEISHU_GATEWAY_AVAILABLE and _WEBSOCKETS_AVAILABLE

# WebSocket 事件回调（由 server.py 注册，用于将 WS 收到的消息推送到 SSE）
_ws_event_callback: Callable[[dict], None] | None = None


def set_feishu_ws_event_callback(cb: Callable[[dict], None] | None) -> None:
    global _ws_event_callback
    _ws_event_callback = cb

from ccb_bridge import get_current_cli
from feishu_gateway_store import (
    get_feishu_gateway_config,
    get_scope,
    is_event_processed,
    mark_event_processed,
    list_scopes,
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
        ws_log(f"handle_event 被调用, payload keys: {list(payload.keys())}")
        if not FEISHU_GATEWAY_AVAILABLE:
            ws_log("handle_event: FEISHU_GATEWAY_AVAILABLE=False")
            return {"ok": False, "error": FEISHU_GATEWAY_UNAVAILABLE_REASON}

        config = get_feishu_gateway_config(redact=False)
        if not config.get("enabled"):
            ws_log("handle_event: 网关未启用")
            return {"ok": False, "error": "飞书网关未启用"}

        if payload.get("challenge"):
            ws_log("handle_event: 收到 challenge，已响应")
            return {"challenge": payload.get("challenge")}

        if payload.get("schema") == "2.0" and payload.get("header", {}).get("event_type") == "url_verification":
            ws_log("handle_event: URL 验证请求")
            return {"challenge": payload.get("challenge")}

        token = str(config.get("verification_token") or "").strip()
        header = payload.get("header") if isinstance(payload.get("header"), dict) else {}
        if token and header.get("token") and header.get("token") != token:
            ws_log("handle_event: token 校验失败")
            return {"ok": False, "error": "飞书事件 token 校验失败"}

        message = self._parse_message(payload)
        if not message:
            ws_log(f"handle_event: _parse_message 返回 None, payload 内容: {json.dumps(payload, ensure_ascii=False)[:300]}")
            return {"ok": True, "ignored": True}
        ws_log(f"handle_event: 解析成功 user_id={message.user_id} chat_id={message.chat_id} text={message.text[:50]}")
        if is_event_processed(message.event_id):
            ws_log("handle_event: 重复事件，已忽略")
            return {"ok": True, "duplicate": True}
        if not self._is_allowed(config, message):
            ws_log(f"handle_event: 用户/群不在白名单 user_id={message.user_id} allowed_users={config.get('allowed_users')}")
            mark_event_processed(message.event_id)
            return {"ok": True, "ignored": True, "reason": "not_allowed"}
        mark_event_processed(message.event_id)

        ws_log(f"handle_event: 已接受，创建后台任务处理消息")
        asyncio.create_task(self._handle_message(config, message))
        return {"ok": True, "accepted": True}

    async def notify_session_complete(self, title: str, summary: str, model: str, cost_usd: float = 0, prompt: str = "", lang: str = "zh", elapsed: float = 0) -> None:
        """向所有活跃飞书聊天发送 GUI 会话完成通知。"""
        config = get_feishu_gateway_config(redact=False)
        if not config.get("enabled"):
            ws_log("notify_session_complete: 网关未启用，跳过")
            return
        if not config.get("complete_notify", True):
            ws_log("notify_session_complete: complete_notify=false，跳过")
            return
        scopes = list_scopes()
        if not scopes:
            ws_log("notify_session_complete: scopes 为空，无通知目标")
            return
        is_en = lang == "en"
        header = "Notification" if is_en else "通知"
        q_label = "Q" if is_en else "问"
        a_label = "A" if is_en else "答"
        model_label = "Model" if is_en else "模型"
        elapsed_label = "Duration" if is_en else "耗时"
        cost_info = f" (${cost_usd:.4f})" if cost_usd > 0 else ""
        parts = [f"**{header}**{cost_info}"]
        if prompt:
            parts.append(f"\n**{q_label}**\n{prompt}")
        if summary:
            parts.append(f"\n**{a_label}**\n{summary}")
        parts.append(f"\n{model_label}：{model}")
        if elapsed > 0:
            if elapsed < 60:
                parts.append(f"  |  {elapsed_label}：{elapsed:.0f}s")
            else:
                m = int(elapsed // 60)
                s = int(elapsed % 60)
                parts.append(f"  |  {elapsed_label}：{m}m{s}s")
        text = "\n".join(parts).strip()
        ws_log(f"notify_session_complete: 发送完成通知到 {len(scopes)} 个聊天")
        for scope in scopes:
            chat_id = scope.get("chat_id")
            if not chat_id:
                continue
            try:
                await self._send_reply(config, chat_id, text)
            except Exception as exc:
                ws_log(f"notify_session_complete: 发送到 {chat_id} 失败: {exc}")

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
        uid = str(sender_id.get("user_id") or sender_id.get("open_id") or sender.get("sender_id") or "").strip()
        open_id = str(sender_id.get("open_id") or "").strip()
        event_id = str(header.get("event_id") or message_id or f"feishu-{time.time()}")
        if not chat_id or not text.strip():
            return None
        return FeishuMessage(event_id=event_id, message_id=message_id, chat_id=chat_id, user_id=uid, text=text.strip(), raw=payload)

    def _is_allowed(self, config: dict[str, Any], message: FeishuMessage) -> bool:
        allowed_chats = set(config.get("allowed_chats") or [])
        allowed_users = set(config.get("allowed_users") or [])
        # 两个白名单都为空 → 默认允许所有（防止误拒；白名单仅作为额外限制使用）
        if not allowed_chats and not allowed_users:
            return True
        # user_id 可能与 open_id 不同，需要解开 raw 取 open_id 做比对
        sender_ids = {message.user_id}
        raw_sender = message.raw.get("event", {}).get("sender", {})
        sid = raw_sender.get("sender_id") if isinstance(raw_sender.get("sender_id"), dict) else {}
        if isinstance(sid, dict) and sid.get("open_id"):
            sender_ids.add(str(sid["open_id"]))
        return message.chat_id in allowed_chats or bool(sender_ids & allowed_users)

    async def _handle_message(self, config: dict[str, Any], message: FeishuMessage):
        scope_key = self._scope_key(message.chat_id)
        ws_log(f"_handle_message 开始: chat_id={message.chat_id} text={message.text[:50]}")
        lock = self._scope_locks.setdefault(scope_key, asyncio.Lock())
        if lock.locked() and config.get("busy_mode") == "reject":
            ws_log("_handle_message: 繁忙模式=reject，返回提示")
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
                ws_log("_handle_message: 调用 _run_agent_turn...")
                reply = await self._run_agent_turn(config, scope_key, message)
                ws_log(f"_handle_message: _run_agent_turn 返回 reply_len={len(reply) if reply else 0}")
            except Exception as exc:
                reply = f"执行失败：{exc}"
                ws_log(f"_handle_message: _run_agent_turn 异常: {exc}")
            ws_log(f"_handle_message: 发送回复到 chat_id={message.chat_id}")
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
        event_count = {"total": 0, "assistant": 0, "result": 0, "error": 0}

        async def on_event(event: dict[str, Any]):
            nonlocal session_id, final_text
            evt_type = event.get("type")
            event_count["total"] += 1
            if evt_type not in ("assistant", "system", "result", "error", "session_id_captured", "model_changed"):
                return
            sid = event.get("session_id") or session.session_id or session_id
            if evt_type == "session_id_captured" and sid:
                session_id = sid
                ws_log(f"_run_agent_turn: session_id_captured → {sid}")
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
                event_count["assistant"] += 1
                text = self._extract_text(event)
                if text:
                    collected.append(text)
                    ws_log(f"_run_agent_turn: assistant chunk len={len(text)}")
            elif evt_type == "result":
                event_count["result"] += 1
                result_text = str(event.get("result") or "").strip()
                if result_text:
                    final_text = result_text
                    ws_log(f"_run_agent_turn: result text len={len(result_text)}")
                usage = event.get("usage") if isinstance(event.get("usage"), dict) else None
                add_session_usage(sid or session_id, float(event.get("total_cost_usd") or 0), usage)
            elif evt_type == "error":
                event_count["error"] += 1
                msg = str(event.get("message") or "").strip()
                if msg:
                    final_text = f"执行失败：{msg}"
                ws_log(f"_run_agent_turn: error → {msg}")

        ws_log(f"_run_agent_turn: 启动 session model={model} cwd={cwd} cli={cli}")
        await session.start(model=model, cwd=cwd, resume_id=session_id or None, on_event=on_event, skip_permissions=bool(config.get("skip_permissions", True)), cli=cli)
        ws_log(f"_run_agent_turn: session 已启动，发送消息={message.text[:50]}")
        try:
            await session.send_message(message.text, owner_id=client_id, prefer_persistent=False)
            ws_log(f"_run_agent_turn: send_message 完成，等待 CLI 输出...")
            # send_message 只是启动了子进程和 _stream_output task，需等待 task 完成
            read_task = getattr(session, '_read_task', None)
            if read_task:
                try:
                    await asyncio.wait_for(read_task, timeout=300)
                except asyncio.TimeoutError:
                    ws_log("_run_agent_turn: CLI 超时")
                    await session.stop()
                except Exception:
                    pass
            ws_log(f"_run_agent_turn: CLI 输出流已结束")
        finally:
            self.session_manager.finish_run(run_id)
        ws_log(f"_run_agent_turn: 事件统计 total={event_count['total']} assistant={event_count['assistant']} result={event_count['result']} error={event_count['error']}")
        if session.session_id:
            save_scope(scope_key, {
                "session_id": session.session_id,
                "chat_id": message.chat_id,
                "model": model,
                "cwd": cwd,
                "cli": cli,
                "last_message_id": message.message_id,
            })
        result = final_text or "\n".join(part for part in collected if part).strip()
        ws_log(f"_run_agent_turn: 最终返回 len={len(result)} collected_chunks={len(collected)}")
        return result

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
        ws_log(f"_send_reply: chat_id={chat_id} text={text[:60]}...")
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
                ws_log(f"_send_reply 失败: code={response.code} msg={response.msg}")
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

    # ── WebSocket 长连接 ─────────────────────────────────────────────────

    _ws_client: Any = None
    _ws_running: bool = False
    _ws_thread: threading.Thread | None = None
    _ws_event_queue: Any = None  # asyncio.Queue, 在 _start_ws 中初始化
    _ws_consumer_started: bool = False  # 防止重复创建消费任务

    @property
    def is_ws_running(self) -> bool:
        return self._ws_running

    def ensure_ws_running(self) -> bool:
        """如果启用了 WebSocket 模式且未在运行，则启动 WebSocket 连接。"""
        if self._ws_running:
            return True
        ws_log("ensure_ws_running 被调用")
        config = get_feishu_gateway_config(redact=False)
        enabled = config.get("enabled")
        mode = config.get("connection_mode")
        has_app_id = bool(config.get("app_id"))
        ws_log(f"配置: enabled={enabled} mode={mode} has_app_id={has_app_id} ws_available={FEISHU_WS_AVAILABLE}")
        if not enabled:
            ws_log("未启用，跳过 WS 连接")
            return False
        if mode != "websocket":
            ws_log(f"连接模式为 {mode}，跳过 WS 连接")
            return False
        if not FEISHU_WS_AVAILABLE:
            ws_log("SDK/websockets 不可用，跳过 WS 连接")
            return False
        return self._start_ws(config)

    @staticmethod
    def _ws_msg_to_payload(data: Any) -> dict:
        """将 P2ImMessageReceiveV1 事件对象转为 handle_event 可用的 dict。"""
        event = getattr(data, "event", None)
        message = getattr(event, "message", None)
        sender = getattr(event, "sender", None)
        if not message:
            return {}
        sender_user_id = ""
        sender_open_id = ""
        if sender is not None:
            sid = getattr(sender, "sender_id", None)
            if sid is not None:
                # sender_id 是 UserId 对象（有 user_id/open_id/union_id 属性），不是 dict
                sender_user_id = str(getattr(sid, "user_id", "") or "")
                sender_open_id = str(getattr(sid, "open_id", "") or "")
                if not sender_user_id:
                    sender_user_id = sender_open_id
        msg_type = getattr(message, "message_type", "text")
        msg_id = str(getattr(message, "message_id", "") or "")
        chat_id = str(getattr(message, "chat_id", "") or "")
        content = getattr(message, "content", "") or ""
        return {
            "header": {
                "event_id": msg_id,
                "event_type": "im.message.receive_v1",
                "token": "",
                "create_time": str(int(time.time() * 1000)),
            },
            "event": {
                "message": {
                    "message_id": msg_id,
                    "chat_id": chat_id,
                    "message_type": msg_type,
                    "content": content,
                },
                "sender": {
                    "sender_id": {"user_id": sender_user_id, "open_id": sender_open_id},
                },
            },
        }

    def _start_ws(self, config: dict[str, Any]) -> bool:
        """启动 WebSocket 长连接（在独立线程中运行）。返回是否启动成功。"""
        app_id = str(config.get("app_id") or "").strip()
        app_secret = str(config.get("app_secret") or "").strip()
        if not app_id or not app_secret:
            ws_log("_start_ws: 缺少 app_id/app_secret，跳过")
            return False
        try:
            from lark_oapi.event.dispatcher_handler import EventDispatcherHandler
        except ImportError as exc:
            ws_log(f"_start_ws: 导入 EventDispatcherHandler 失败: {exc}")
            return False

        # 先停止旧连接（如果有的话），避免重复线程
        if self._ws_thread is not None and self._ws_thread.is_alive():
            ws_log("_start_ws: 检测到旧 WS 线程仍在运行，先停止")
            self._ws_running = False
            self._ws_client = None

        # 创建事件队列用于跨线程传递
        try:
            main_loop = asyncio.get_event_loop()
            self._ws_event_queue = asyncio.Queue()
        except Exception as exc:
            ws_log(f"_start_ws: 创建 event loop/queue 失败: {exc}")
            return False
        gateway = self
        _msg_to_payload = self._ws_msg_to_payload

        def _on_message(data: Any) -> None:
            """SDK 后台线程回调：将事件转为 dict 并投递到 asyncio 队列。"""
            payload = _msg_to_payload(data)
            if payload:
                main_loop.call_soon_threadsafe(gateway._ws_event_queue.put_nowait, payload)

        event_handler = (
            EventDispatcherHandler.builder("", "")
            .register_p2_im_message_receive_v1(_on_message)
            .build()
        )

        self._ws_running = True
        self._ws_thread = threading.Thread(
            target=self._run_ws_loop,
            args=(app_id, app_secret, event_handler),
            daemon=True,
            name="feishu-ws",
        )
        self._ws_thread.start()

        if not self._ws_consumer_started:
            self._ws_consumer_started = True
            asyncio.create_task(self._consume_ws_events())
        ws_log("_start_ws: WS 线程已启动")
        return True

    def _run_ws_loop(self, app_id: str, app_secret: str, event_handler: Any) -> None:
        """WebSocket 事件接收循环（在后台线程中运行）。"""
        ws_log(f"后台线程已启动 (app_id={app_id[:8]}***)")

        try:
            import lark_oapi.ws.client as ws_client_module
        except Exception as exc:
            ws_log(f"导入 ws.client 失败: {exc}")
            self._ws_running = False
            return

        # 为此线程创建独立的 event loop（SDK WS 客户端需要）
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            ws_client_module.loop = loop
        except Exception as exc:
            ws_log(f"创建 event loop 失败: {exc}")
            self._ws_running = False
            return

        # 追踪 SDK 内部重连状态（跨线程共享，由钩子和看门狗读写）
        sdk_reconnecting = {"at": 0.0}  # 用 dict 避免 nonlocal 闭包问题

        client = None
        try:
            ws_log("正在创建 WS Client (domain=open.feishu.cn)...")
            client = ws_client_module.Client(
                app_id=app_id,
                app_secret=app_secret,
                event_handler=event_handler,
            )
            # 注册 SDK 重连钩子，避免依赖看门狗被动等待
            def _on_reconnecting():
                sdk_reconnecting["at"] = time.time()
                ws_log("SDK 检测到断连，开始重连...")

            def _on_reconnected():
                ws_log("SDK 重连成功")
                sdk_reconnecting["at"] = 0.0

            client.on_reconnecting = _on_reconnecting
            client.on_reconnected = _on_reconnected
            self._ws_client = client
            self._sdk_reconnecting = sdk_reconnecting
            ws_log("Client 已创建，调用 start()...")
            client.start()
            ws_log("client.start() 返回（连接已关闭）")
        except Exception as exc:
            ws_log(f"连接异常: {exc}")
            import traceback
            ws_log(traceback.format_exc())
        finally:
            self._ws_running = False
            self._sdk_reconnecting = None
            if client is not None:
                try:
                    client.stop()
                except (AttributeError, Exception):
                    pass  # SDK Client 没有 stop() 方法，忽略
                self._ws_client = None
            # 清理线程 event loop 中的待处理任务
            if loop is not None and not loop.is_closed():
                try:
                    pending = asyncio.all_tasks(loop)
                    for task in pending:
                        task.cancel()
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                except Exception:
                    pass
                try:
                    loop.close()
                except Exception:
                    pass

    async def _consume_ws_events(self) -> None:
        """主 event loop 中的事件消费循环。WS 断开后自动重连。"""
        ws_log("事件消费循环已启动")
        _last_activity = time.time()
        _reconnect_backoff = 5
        while True:
            try:
                if not self._ws_running:
                    ws_log(f"WS 连接断开，{_reconnect_backoff} 秒后自动重连...")
                    await asyncio.sleep(_reconnect_backoff)
                    self.ensure_ws_running()
                    if self._ws_running:
                        _last_activity = time.time()
                        _reconnect_backoff = 5
                    else:
                        _reconnect_backoff = min(_reconnect_backoff * 2, 60)
                    continue

                try:
                    data = await asyncio.wait_for(self._ws_event_queue.get(), timeout=1.0)
                    _last_activity = time.time()
                    _reconnect_backoff = 5
                except asyncio.TimeoutError:
                    # 如果 WS 标记为运行中但长时间无事件，可能是连接僵死
                    stale = time.time() - _last_activity
                    # SDK 钩子已检测到断连时用更短的超时（60s），否则用 120s
                    sdk_reconnecting = getattr(self, '_sdk_reconnecting', None)
                    sdk_down_since = sdk_reconnecting["at"] if sdk_reconnecting else 0
                    threshold = 60 if (sdk_down_since and sdk_down_since > 0) else 120
                    if stale > threshold:
                        ws_log(f"WS 连接 {stale:.0f} 秒无活动 (threshold={threshold}s)，强制重连...")
                        self.stop_ws()
                        await asyncio.sleep(1)
                    continue
                except RuntimeError:
                    break
                try:
                    et = data.get("header", {}).get("event_type", "?")
                    cid = data.get("event", {}).get("message", {}).get("chat_id", "?")
                    ws_log(f"收到事件: type={et} chat_id={cid}")
                    result = await self.handle_event(data)
                    ws_log(f"handle_event 返回: {result}")
                except Exception as exc:
                    import traceback
                    ws_log(f"消费事件异常: {exc}\n{traceback.format_exc()}")
            except Exception as exc:
                import traceback
                ws_log(f"事件消费循环异常（5 秒后恢复）: {exc}\n{traceback.format_exc()}")
                await asyncio.sleep(5)

    def stop_ws(self) -> None:
        """停止 WebSocket 连接。"""
        self._ws_running = False
        self._sdk_reconnecting = None
        client = self._ws_client
        self._ws_client = None
        if client is not None:
            try:
                client.stop()
            except (AttributeError, Exception):
                pass  # SDK Client 没有 stop() 方法
