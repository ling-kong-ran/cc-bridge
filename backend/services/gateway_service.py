"""消息网关平台化服务。"""
from typing import Any, Callable

try:
    import qrcode
    import qrcode.image.svg

    QRCODE_AVAILABLE = True
except ImportError:
    qrcode = None
    QRCODE_AVAILABLE = False


GatewayFactory = Callable[[], Any]
LanIpProvider = Callable[[], list[str]]


def load_feishu_config(feishu: Any, get_lan_ips: LanIpProvider) -> dict[str, Any]:
    """读取飞书网关配置，并补充平台能力标记。"""
    data = feishu.get_feishu_gateway_config(redact=True)
    data["available"] = feishu.FEISHU_GATEWAY_AVAILABLE
    data["unavailable_reason"] = feishu.FEISHU_GATEWAY_UNAVAILABLE_REASON
    data["qrcode_available"] = QRCODE_AVAILABLE
    data["lan_ips"] = get_lan_ips()
    data["ws_available"] = feishu.FEISHU_WS_AVAILABLE
    return data


def list_feishu_scopes(feishu: Any) -> dict[str, Any]:
    """列出飞书网关授权范围。"""
    return {"scopes": feishu.list_feishu_scopes()}


def render_feishu_qr(url: str) -> tuple[int, str, bytes | dict[str, Any]]:
    """生成飞书接入二维码 SVG。"""
    if not QRCODE_AVAILABLE:
        return 503, "application/json; charset=utf-8", {"error": "QR code library not installed"}
    if not url:
        return 400, "application/json; charset=utf-8", {"error": "url query parameter required"}
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=5, border=3)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(image_factory=qrcode.image.svg.SvgFillImage)
    return 200, "image/svg+xml; charset=utf-8", img.to_string()


def describe_feishu_event_endpoint() -> dict[str, Any]:
    """返回飞书事件订阅端点说明。"""
    return {
        "ok": True,
        "endpoint": "Feishu event subscription",
        "method": "POST",
        "description": "Configure this URL in your Feishu open platform app's event subscription settings.",
        "event_types": ["im.message.receive_v1"],
    }


def save_feishu_config(data: dict[str, Any], feishu: Any, get_gateway: GatewayFactory) -> dict[str, Any]:
    """保存飞书网关配置，并按连接模式启停网关。"""
    result = feishu.update_feishu_gateway_config(data)
    result["available"] = feishu.FEISHU_GATEWAY_AVAILABLE
    result["unavailable_reason"] = feishu.FEISHU_GATEWAY_UNAVAILABLE_REASON
    result["qrcode_available"] = QRCODE_AVAILABLE
    result["ws_available"] = feishu.FEISHU_WS_AVAILABLE
    feishu.ws_log(
        "gateway_service: 配置已保存，"
        f"connection_mode={result.get('connection_mode')} enabled={result.get('enabled')}"
    )
    gateway = get_gateway()
    if result.get("connection_mode") == "websocket" and result.get("enabled"):
        gateway.ensure_ws_running()
    else:
        gateway.stop_ws()
    return result


async def handle_feishu_event(
    data: dict[str, Any],
    feishu: Any,
    get_gateway: GatewayFactory,
) -> tuple[int, dict[str, Any]]:
    """处理飞书事件回调。"""
    if not feishu.FEISHU_GATEWAY_AVAILABLE:
        return 503, {"ok": False, "error": feishu.FEISHU_GATEWAY_UNAVAILABLE_REASON}
    result = await get_gateway().handle_event(data)
    return 200 if result.get("ok", True) else 400, result


def _chat_id_from_scope(data: dict[str, Any]) -> str:
    scope_key = str(data.get("scope_key") or "").strip()
    chat_id = str(data.get("chat_id") or "").strip()
    if not chat_id and scope_key.startswith("feishu:chat:"):
        chat_id = scope_key.removeprefix("feishu:chat:")
    return chat_id


async def reset_feishu_scope(data: dict[str, Any], get_gateway: GatewayFactory) -> tuple[int, dict[str, Any]]:
    """重置飞书会话 scope。"""
    chat_id = _chat_id_from_scope(data)
    if not chat_id:
        return 400, {"error": "chat_id required"}
    ok = await get_gateway().reset_scope(chat_id)
    return 200, {"ok": ok}


async def stop_feishu_scope(data: dict[str, Any], get_gateway: GatewayFactory) -> tuple[int, dict[str, Any]]:
    """停止飞书会话 scope。"""
    chat_id = _chat_id_from_scope(data)
    if not chat_id:
        return 400, {"error": "chat_id required"}
    ok = await get_gateway().stop_scope(chat_id)
    return 200, {"ok": ok}


def begin_feishu_onboard(data: dict[str, Any], feishu: Any) -> tuple[int, dict[str, Any]]:
    """开始飞书应用自动配置流程。"""
    domain = str(data.get("domain") or "feishu").strip()
    try:
        result = feishu.api_begin_onboard(domain)
    except feishu.OnboardRegistrationError as exc:
        return 400, {"ok": False, "error": str(exc)}
    return 200, {"ok": True, **result}


def poll_feishu_onboard(data: dict[str, Any], feishu: Any) -> tuple[int, dict[str, Any]]:
    """轮询飞书应用自动配置流程。"""
    device_code = str(data.get("device_code") or "").strip()
    if not device_code:
        return 400, {"error": "device_code required"}
    return 200, feishu.api_poll_onboard(device_code)
