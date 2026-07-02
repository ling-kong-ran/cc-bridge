"""飞书 / Lark OAuth App Registration —— 扫码自动创建 Bot。

设备码流程（Device Code Flow）：
1. init  — 检查注册环境是否支持 client_secret 认证
2. begin — 发起设备码注册，获取 QR 码 URL
3. poll  — 轮询等待用户在飞书 App 中扫码确认
4. probe — 验证新创建的 Bot 连通性

全程使用 urllib.request，不依赖 lark_oapi SDK（因为注册发生在配置前）。
"""

import json
import time
import logging
from typing import Optional
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode

logger = logging.getLogger("feishu_onboard")

# ── 常量 ────────────────────────────────────────────────────────────────────

_ACCOUNTS_URLS = {
    "feishu": "https://accounts.feishu.cn",
    "lark": "https://accounts.larksuite.com",
}
_OPEN_URLS = {
    "feishu": "https://open.feishu.cn",
    "lark": "https://open.larksuite.com",
}
_REGISTRATION_PATH = "/oauth/v1/app/registration"
_REQUEST_TIMEOUT = 10


# ── 内部工具 ─────────────────────────────────────────────────────────────────

def _post_json(url: str, body: dict) -> dict:
    """POST JSON 并解析响应。HTTP 4xx 也尝试解析 JSON body。"""
    data = json.dumps(body).encode("utf-8")
    req = Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=_REQUEST_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        body_bytes = exc.read()
        if body_bytes:
            try:
                return json.loads(body_bytes.decode("utf-8"))
            except (ValueError, json.JSONDecodeError):
                raise exc from None
        raise


def _post_form(url: str, body: dict) -> dict:
    """POST form-encoded 并解析响应。"""
    data = urlencode(body).encode("utf-8")
    req = Request(url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urlopen(req, timeout=_REQUEST_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        body_bytes = exc.read()
        if body_bytes:
            try:
                return json.loads(body_bytes.decode("utf-8"))
            except (ValueError, json.JSONDecodeError):
                raise exc from None
        raise


# ── 注册步骤 ─────────────────────────────────────────────────────────────────

class RegistrationError(RuntimeError):
    """注册过程中断（网络错误、认证拒绝、超时等）。"""


def init_registration(domain: str = "feishu") -> bool:
    """验证注册环境是否可用。返回 True 表示支持 client_secret 认证。"""
    base_url = _ACCOUNTS_URLS.get(domain, _ACCOUNTS_URLS["feishu"])
    url = f"{base_url}{_REGISTRATION_PATH}"
    try:
        res = _post_form(url, {"action": "init"})
    except (URLError, OSError) as exc:
        raise RegistrationError(f"无法连接飞书注册服务 ({base_url})：{exc}") from exc
    methods = res.get("supported_auth_methods") or []
    if "client_secret" not in methods:
        raise RegistrationError(
            f"当前飞书环境不支持 client_secret 认证。"
            f"支持的方式：{methods}"
        )
    return True


def begin_registration(domain: str = "feishu") -> dict:
    """发起设备码注册流程。

    Returns:
        {
            "device_code": str,     # 轮询时使用
            "qr_url": str,          # 转换为二维码让用户扫描
            "user_code": str,       # 可选展示给用户的验证码
            "interval": int,        # 轮询间隔（秒）
            "expire_in": int,       # 过期时间（秒）
        }
    """
    base_url = _ACCOUNTS_URLS.get(domain, _ACCOUNTS_URLS["feishu"])
    url = f"{base_url}{_REGISTRATION_PATH}"
    try:
        res = _post_form(url, {
            "action": "begin",
            "archetype": "PersonalAgent",
            "auth_method": "client_secret",
            "request_user_info": "open_id",
        })
    except (URLError, OSError) as exc:
        raise RegistrationError(f"发起注册失败：{exc}") from exc

    device_code = res.get("device_code")
    if not device_code:
        raise RegistrationError("飞书注册服务未返回 device_code")

    qr_url = res.get("verification_uri_complete", "")
    # 附加来源标识
    if "?" in qr_url:
        qr_url += "&from=cc-bridge&tp=ccb"
    else:
        qr_url += "?from=cc-bridge&tp=ccb"

    return {
        "device_code": device_code,
        "qr_url": qr_url,
        "user_code": res.get("user_code", ""),
        "interval": res.get("interval") or 5,
        "expire_in": res.get("expire_in") or 600,
    }


def poll_registration(device_code: str, domain: str = "feishu", timeout_seconds: int = 600) -> Optional[dict]:
    """轮询等待用户扫码确认。

    Returns 成功时:
        {
            "app_id": str,
            "app_secret": str,
            "domain": "feishu" | "lark",
            "open_id": str | None,
        }

    Returns None 表示用户拒绝或超时。
    """
    deadline = time.monotonic() + timeout_seconds
    _interval = 5
    domain_switched = False

    while time.monotonic() < deadline:
        base_url = _ACCOUNTS_URLS.get(domain, _ACCOUNTS_URLS["feishu"])
        url = f"{base_url}{_REGISTRATION_PATH}"
        try:
            res = _post_form(url, {
                "action": "poll",
                "device_code": device_code,
                "tp": "ob_app",
            })
        except (URLError, OSError):
            time.sleep(_interval)
            continue

        user_info = res.get("user_info") or {}
        tenant_brand = user_info.get("tenant_brand")
        if tenant_brand == "lark" and not domain_switched:
            domain = "lark"
            domain_switched = True

        # 成功：拿到了 app_id 和 app_secret
        if res.get("client_id") and res.get("client_secret"):
            return {
                "app_id": res["client_id"],
                "app_secret": res["client_secret"],
                "domain": domain,
                "open_id": user_info.get("open_id"),
            }

        error = res.get("error", "")
        if error in {"access_denied", "expired_token"}:
            return None

        # authorization_pending — 用户还没扫码，继续轮询
        time.sleep(_interval)

    return None


def probe_bot(app_id: str, app_secret: str, domain: str = "feishu") -> Optional[dict]:
    """验证 Bot 连通性（获取 Bot 名称和 open_id）。

    使用 /open-apis/bot/v3/info 接口，纯 HTTP 实现，不依赖 SDK。

    Returns:
        {"bot_name": str, "bot_open_id": str}  or  None
    """
    base_url = _OPEN_URLS.get(domain, _OPEN_URLS["feishu"])

    # Step 1: 获取 tenant_access_token
    try:
        token_data = json.dumps({
            "app_id": app_id,
            "app_secret": app_secret,
        }).encode("utf-8")
        token_req = Request(
            f"{base_url}/open-apis/auth/v3/tenant_access_token/internal",
            data=token_data,
            headers={"Content-Type": "application/json"},
        )
        with urlopen(token_req, timeout=_REQUEST_TIMEOUT) as resp:
            token_res = json.loads(resp.read().decode("utf-8"))
        access_token = token_res.get("tenant_access_token")
        if not access_token:
            logger.debug("[Feishu onboard] token 获取失败: %s", token_res)
            return None
    except (URLError, OSError, json.JSONDecodeError) as exc:
        logger.debug("[Feishu onboard] HTTP probe (token) 失败: %s", exc)
        return None

    # Step 2: 调用 bot/v3/info
    try:
        bot_req = Request(
            f"{base_url}/open-apis/bot/v3/info",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
        )
        with urlopen(bot_req, timeout=_REQUEST_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (URLError, OSError, json.JSONDecodeError) as exc:
        logger.debug("[Feishu onboard] HTTP probe (bot info) 失败: %s", exc)
        return None

    if data.get("code") != 0:
        logger.debug("[Feishu onboard] bot info 返回非 0: %s", data)
        return None

    bot = data.get("bot") or data.get("data", {}).get("bot") or {}
    return {
        "bot_name": bot.get("app_name") or bot.get("bot_name"),
        "bot_open_id": bot.get("open_id"),
    }


# ── 完整注册流程 ─────────────────────────────────────────────────────────────

def run_onboard(domain: str = "feishu", timeout_seconds: int = 600) -> dict:
    """执行完整扫码注册流程（init → begin → poll → probe），阻塞式。

    Returns 成功时:
        {
            "app_id": str,
            "app_secret": str,
            "domain": "feishu" | "lark",
            "open_id": str | None,
            "bot_name": str | None,
            "bot_open_id": str | None,
        }

    Raises RegistrationError 表示网络错误或协议问题。
    """
    init_registration(domain)

    begin = begin_registration(domain)

    result = poll_registration(
        device_code=begin["device_code"],
        domain=domain,
        timeout_seconds=timeout_seconds,
    )
    if not result:
        raise RegistrationError("注册未完成：用户取消或超时")

    # 探测 Bot 信息（best-effort，失败了不丢注册结果）
    bot_info = probe_bot(result["app_id"], result["app_secret"], result["domain"])
    if bot_info:
        result["bot_name"] = bot_info.get("bot_name")
        result["bot_open_id"] = bot_info.get("bot_open_id")
    else:
        result["bot_name"] = None
        result["bot_open_id"] = None

    return result


# ── API 辅助函数 ─────────────────────────────────────────────────────────────

# 内存中暂存正在进行的注册（device_code → domain），因为是单用户本地服务。
_ongoing_registrations: dict[str, dict] = {}


def api_begin_onboard(domain: str = "feishu") -> dict:
    """供 API 调用：发起注册，返回给前端展示 QR 码。"""
    init_registration(domain)
    begin = begin_registration(domain)
    key = begin["device_code"]
    _ongoing_registrations[key] = {
        "domain": domain,
        "interval": begin["interval"],
        "expire_in": begin["expire_in"],
        "started_at": time.time(),
    }
    return {
        "device_code": key,
        "qr_url": begin["qr_url"],
        "user_code": begin["user_code"],
        "expire_in": begin["expire_in"],
    }


def api_poll_onboard(device_code: str) -> dict:
    """供 API 调用：轮询注册状态。

    Returns:
        {"status": "pending" | "completed" | "failed", ...}
    """
    info = _ongoing_registrations.get(device_code)
    if not info:
        return {"status": "failed", "error": "未找到此注册会话"}

    domain = info["domain"]
    expire_in = info["expire_in"]
    elapsed = time.time() - info["started_at"]
    if elapsed > expire_in:
        del _ongoing_registrations[device_code]
        return {"status": "failed", "error": "注册已过期"}

    result = poll_registration(
        device_code=device_code,
        domain=domain,
        timeout_seconds=1,  # 单次轮询，不等待
    )

    if result is None:
        # 需要区分"拒绝"和"仍在等待"。轮询超时＝仍在等待。
        # poll_registration 在单次超时（timeout_seconds=1）后会返回 None
        return {"status": "pending"}

    # 成功 — 探测 bot 信息
    bot_info = probe_bot(result["app_id"], result["app_secret"], result["domain"])
    if bot_info:
        result["bot_name"] = bot_info.get("bot_name")
        result["bot_open_id"] = bot_info.get("bot_open_id")

    del _ongoing_registrations[device_code]
    result["status"] = "completed"
    return result
