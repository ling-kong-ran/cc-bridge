"""消息网关 REST 路由处理。"""
import json
from typing import Any, Callable

from backend.services.gateway_service import (
    begin_feishu_onboard,
    describe_feishu_event_endpoint,
    handle_feishu_event,
    list_feishu_scopes,
    load_feishu_config,
    poll_feishu_onboard,
    render_feishu_qr,
    reset_feishu_scope,
    save_feishu_config,
    stop_feishu_scope,
)

GatewayFactory = Callable[[], Any]
LanIpProvider = Callable[[], list[str]]


def _query_value(query: dict[str, list[str]] | None, name: str, default: str = "") -> str:
    return ((query or {}).get(name, [default])[0] or default)


def handle_gateway_get(
    path: str,
    query: dict[str, list[str]] | None,
    *,
    feishu: Any,
    get_lan_ips: LanIpProvider,
) -> tuple[int, str, bytes | dict[str, Any] | None]:
    """处理消息网关 GET API。"""
    if not path.startswith("/api/feishu-gateway/"):
        return 0, "application/json; charset=utf-8", None

    if path == "/api/feishu-gateway/config":
        return 200, "application/json; charset=utf-8", load_feishu_config(feishu, get_lan_ips)
    if path == "/api/feishu-gateway/scopes":
        return 200, "application/json; charset=utf-8", list_feishu_scopes(feishu)
    if path == "/api/feishu-gateway/qr":
        return render_feishu_qr(_query_value(query, "url"))
    if path == "/api/feishu-gateway/events":
        return 200, "application/json; charset=utf-8", describe_feishu_event_endpoint()
    return 0, "application/json; charset=utf-8", None


async def handle_gateway_post(
    path: str,
    data: dict[str, Any],
    *,
    feishu: Any,
    get_gateway: GatewayFactory,
) -> tuple[int, dict[str, Any] | None]:
    """处理消息网关 POST API。"""
    if not path.startswith("/api/feishu-gateway/"):
        return 0, None

    if path == "/api/feishu-gateway/config":
        return 200, save_feishu_config(data, feishu, get_gateway)
    if path == "/api/feishu-gateway/events":
        return await handle_feishu_event(data, feishu, get_gateway)
    if path == "/api/feishu-gateway/reset-scope":
        return await reset_feishu_scope(data, get_gateway)
    if path == "/api/feishu-gateway/stop-scope":
        return await stop_feishu_scope(data, get_gateway)
    if path == "/api/feishu-gateway/onboard/begin":
        return begin_feishu_onboard(data, feishu)
    if path == "/api/feishu-gateway/onboard/poll":
        return poll_feishu_onboard(data, feishu)
    return 0, None


def encode_gateway_get_body(body: bytes | dict[str, Any]) -> bytes:
    """编码消息网关 GET 响应体。"""
    if isinstance(body, bytes):
        return body
    return json.dumps(body, ensure_ascii=False).encode("utf-8")
