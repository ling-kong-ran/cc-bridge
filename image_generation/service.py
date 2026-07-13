"""图片生成服务：参数校验、Provider 调度与文件落盘。"""
from __future__ import annotations

import base64
import mimetypes
import os
import uuid
from dataclasses import asdict
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from .base import (
    GeneratedImage,
    ImageGenerationError,
    ImageGenerationRequest,
    ImageGenerationResult,
    ProviderImagePayload,
)
from .gemini_provider import GeminiImageProvider
from .openai_provider import OpenAIImageProvider

PROMPT_MAX_CHARS = 4000
MAX_IMAGES = 4
MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024
ALLOWED_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/webp"}
MIME_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}


class ImageGenerationService:
    """统一管理图片生成 Provider 与本地文件输出。"""

    def __init__(self, env: dict[str, str] | None = None, default_cwd: str = ""):
        self.env = env or {}
        self.default_cwd = default_cwd
        self.providers = {
            "openai": OpenAIImageProvider(self.env),
            "gemini": GeminiImageProvider(self.env),
        }

    def models_payload(self) -> dict:
        providers = []
        for provider_id, provider in self.providers.items():
            item = {
                "id": provider_id,
                "name": getattr(provider, "display_name", provider_id),
                "configured": provider.configured(),
                "models": provider.models(),
            }
            item.update(provider.options())
            providers.append(item)
        default_provider = self._default_provider(providers)
        default_model = self._default_model(default_provider)
        return {
            "providers": providers,
            "defaults": {
                "provider": default_provider.get("id") or "openai",
                "model": default_model,
                "size": "1024x1024",
                "aspect_ratio": "1:1",
                "quality": "medium",
            },
        }

    async def generate(self, data: dict) -> ImageGenerationResult:
        request = self._parse_request(data)
        provider = self.providers.get(request.provider)
        if not provider:
            raise ImageGenerationError(f"不支持的生图 Provider：{request.provider}", 400)
        output_dir = self._resolve_output_dir(request.cwd)
        provider_result = await provider.generate(request)
        images = []
        for payload in provider_result.images:
            images.append(self._save_payload(payload, output_dir))
        if not images:
            raise ImageGenerationError("未生成图片", 502)
        return ImageGenerationResult(
            provider=request.provider,
            model=request.model,
            prompt=request.prompt,
            images=images,
            request_id=provider_result.request_id,
            usage=provider_result.usage,
        )

    def result_to_dict(self, result: ImageGenerationResult) -> dict:
        data = asdict(result)
        data["ok"] = True
        return data

    def _default_provider(self, providers: list[dict]) -> dict:
        configured = [item for item in providers if item.get("configured")]
        candidates = configured or providers
        for item in candidates:
            if item.get("id") == "openai":
                return item
        return candidates[0] if candidates else {}

    def _default_model(self, provider: dict) -> str:
        models = provider.get("models") if isinstance(provider, dict) else []
        for model in models or []:
            if model.get("default"):
                return str(model.get("id") or "")
        if models:
            return str(models[0].get("id") or "")
        provider_obj = self.providers.get(str(provider.get("id") or "")) if isinstance(provider, dict) else None
        return str(getattr(provider_obj, "default_model", "") or "")

    def _parse_request(self, data: dict) -> ImageGenerationRequest:
        if not isinstance(data, dict):
            raise ImageGenerationError("请求体必须是 JSON 对象", 400)
        provider = str(data.get("provider") or "openai").strip().lower()
        provider_obj = self.providers.get(provider)
        model = str(data.get("model") or getattr(provider_obj, "default_model", "")).strip()
        prompt = str(data.get("prompt") or "").strip()
        if not prompt:
            raise ImageGenerationError("prompt 不能为空", 400)
        if len(prompt) > PROMPT_MAX_CHARS:
            raise ImageGenerationError(f"prompt 不能超过 {PROMPT_MAX_CHARS} 字符", 400)
        try:
            n = int(data.get("n") or 1)
        except (TypeError, ValueError) as exc:
            raise ImageGenerationError("n 必须是数字", 400) from exc
        if n < 1 or n > MAX_IMAGES:
            raise ImageGenerationError(f"n 必须在 1-{MAX_IMAGES} 之间", 400)
        extra = data.get("extra") if isinstance(data.get("extra"), dict) else {}
        input_images = data.get("input_images") if isinstance(data.get("input_images"), list) else []
        return ImageGenerationRequest(
            provider=provider,
            model=model,
            prompt=prompt,
            cwd=str(data.get("cwd") or self.default_cwd or ""),
            size=str(data.get("size") or "1024x1024").strip(),
            aspect_ratio=str(data.get("aspect_ratio") or "").strip(),
            quality=str(data.get("quality") or "").strip(),
            n=n,
            input_images=[str(item) for item in input_images],
            extra=extra,
        )

    def _resolve_output_dir(self, cwd: str) -> Path:
        if not cwd:
            raise ImageGenerationError("缺少工作目录 cwd", 400)
        root = Path(cwd).expanduser().resolve()
        if not root.exists() or not root.is_dir():
            raise ImageGenerationError(f"工作目录不存在：{cwd}", 400)
        output_dir = root / ".gui-uploads" / "generated"
        output_dir.mkdir(parents=True, exist_ok=True)
        return output_dir

    def _save_payload(self, payload: ProviderImagePayload, output_dir: Path) -> GeneratedImage:
        data = payload.data
        mime_type = _normalize_mime(payload.mime_type)
        if payload.b64_json:
            try:
                data = base64.b64decode(payload.b64_json, validate=True)
            except Exception as exc:
                raise ImageGenerationError("Provider 返回了无效 Base64 图片", 502) from exc
        elif payload.url:
            data, downloaded_mime = self._download_image(payload.url)
            if downloaded_mime:
                mime_type = _normalize_mime(downloaded_mime)
        if not data:
            raise ImageGenerationError("Provider 返回的图片为空", 502)
        detected_mime = _detect_image_mime(data) or mime_type
        if detected_mime in ALLOWED_IMAGE_MIME_TYPES:
            mime_type = detected_mime
        if mime_type not in ALLOWED_IMAGE_MIME_TYPES:
            raise ImageGenerationError(f"不支持的图片类型：{mime_type}", 415)
        suffix = MIME_EXTENSIONS[mime_type]
        file_path = output_dir / f"generated_{uuid.uuid4().hex}{suffix}"
        file_path.write_bytes(data)
        width, height = _detect_image_size(data, mime_type)
        normalized_path = str(file_path.resolve()).replace("\\", "/")
        return GeneratedImage(
            path=normalized_path,
            url="/api/file?path=" + quote(normalized_path, safe=""),
            mime_type=mime_type,
            name=file_path.name,
            width=width,
            height=height,
        )

    def _download_image(self, url: str) -> tuple[bytes, str]:
        parsed = urlparse(url)
        if parsed.scheme.lower() != "https":
            raise ImageGenerationError("只允许下载 https 图片 URL", 400)
        req = Request(url, headers={"User-Agent": "ccb-gui-image-generation/1.0"})
        try:
            with urlopen(req, timeout=120) as resp:
                content_length = resp.headers.get("Content-Length")
                if content_length and int(content_length) > MAX_REMOTE_IMAGE_BYTES:
                    raise ImageGenerationError("远程图片超过 20MB", 413)
                data = resp.read(MAX_REMOTE_IMAGE_BYTES + 1)
                if len(data) > MAX_REMOTE_IMAGE_BYTES:
                    raise ImageGenerationError("远程图片超过 20MB", 413)
                content_type = (resp.headers.get("Content-Type") or "").split(";", 1)[0].strip()
                return data, content_type
        except ImageGenerationError:
            raise
        except HTTPError as exc:
            raise ImageGenerationError(f"下载生成图片失败：HTTP {exc.code}", 502) from exc
        except URLError as exc:
            raise ImageGenerationError(f"下载生成图片失败：{exc.reason}", 502) from exc
        except TimeoutError as exc:
            raise ImageGenerationError("下载生成图片超时", 504) from exc


def _normalize_mime(mime_type: str) -> str:
    value = (mime_type or "").split(";", 1)[0].strip().lower()
    if value in {"image/jpg", "jpg", "jpeg"}:
        return "image/jpeg"
    if value in {"png", "image/png"}:
        return "image/png"
    if value in {"webp", "image/webp"}:
        return "image/webp"
    guessed = mimetypes.guess_type("file." + value)[0] if value and "/" not in value else None
    return guessed or value or "image/png"


def _detect_image_mime(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return ""


def _detect_image_size(data: bytes, mime_type: str) -> tuple[int | None, int | None]:
    """从常见图片头中读取宽高，失败时返回空值。"""
    try:
        if mime_type == "image/png" and len(data) >= 24:
            return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
        if mime_type == "image/webp" and len(data) >= 30 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            chunk = data[12:16]
            if chunk == b"VP8X" and len(data) >= 30:
                return int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1
            if chunk == b"VP8 " and len(data) >= 30:
                return int.from_bytes(data[26:28], "little") & 0x3fff, int.from_bytes(data[28:30], "little") & 0x3fff
            if chunk == b"VP8L" and len(data) >= 25:
                bits = int.from_bytes(data[21:25], "little")
                return (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1
        if mime_type == "image/jpeg":
            return _detect_jpeg_size(data)
    except Exception:
        return None, None
    return None, None


def _detect_jpeg_size(data: bytes) -> tuple[int | None, int | None]:
    if len(data) < 4 or not data.startswith(b"\xff\xd8"):
        return None, None
    idx = 2
    while idx + 9 < len(data):
        if data[idx] != 0xff:
            idx += 1
            continue
        marker = data[idx + 1]
        idx += 2
        while marker == 0xff and idx < len(data):
            marker = data[idx]
            idx += 1
        if marker in {0xd8, 0xd9} or 0xd0 <= marker <= 0xd7:
            continue
        if idx + 2 > len(data):
            return None, None
        length = int.from_bytes(data[idx:idx + 2], "big")
        if length < 2 or idx + length > len(data):
            return None, None
        if marker in {0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf} and length >= 7:
            height = int.from_bytes(data[idx + 3:idx + 5], "big")
            width = int.from_bytes(data[idx + 5:idx + 7], "big")
            return width, height
        idx += length
    return None, None
