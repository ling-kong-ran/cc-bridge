"""OpenAI 图片生成 Provider。"""
from __future__ import annotations

import asyncio
import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .base import ImageGenerationError, ImageGenerationRequest, ImageProvider, ProviderGenerationResult, ProviderImagePayload


class OpenAIImageProvider(ImageProvider):
    name = "openai"
    display_name = "OpenAI"
    default_model = "gpt-image-1"
    default_sizes = ["1024x1024", "1536x1024", "1024x1536", "auto"]
    default_qualities = ["low", "medium", "high", "auto"]

    def __init__(self, env: dict[str, str] | None = None):
        self.env = env or {}

    def _env(self, key: str) -> str:
        return str(self.env.get(key) or os.environ.get(key) or "").strip()

    def configured(self) -> bool:
        return bool(self._env("OPENAI_API_KEY"))

    def models(self) -> list[dict]:
        configured = self._env("OPENAI_IMAGE_MODELS")
        model_ids = [item.strip() for item in configured.split(",") if item.strip()] or [self.default_model]
        return [
            {"id": model_id, "name": "GPT Image 1" if model_id == self.default_model else model_id, "default": idx == 0}
            for idx, model_id in enumerate(model_ids)
        ]

    def options(self) -> dict:
        return {"sizes": self.default_sizes, "qualities": self.default_qualities}

    async def generate(self, request: ImageGenerationRequest) -> ProviderGenerationResult:
        if not self.configured():
            raise ImageGenerationError("未配置 OPENAI_API_KEY", 400)
        return await asyncio.to_thread(self._generate_sync, request)

    def _generate_sync(self, request: ImageGenerationRequest) -> ProviderGenerationResult:
        api_key = self._env("OPENAI_API_KEY")
        base_url = (self._env("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
        payload = {
            "model": request.model or self.default_model,
            "prompt": request.prompt,
            "n": request.n,
        }
        if request.size:
            payload["size"] = request.size
        if request.quality:
            payload["quality"] = request.quality
        if isinstance(request.extra, dict):
            for key in ("background", "moderation", "output_compression", "output_format", "response_format", "style"):
                if request.extra.get(key) not in (None, ""):
                    payload[key] = request.extra[key]

        req = Request(
            f"{base_url}/images/generations",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(req, timeout=120) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                response_headers = dict(resp.headers.items())
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:1000]
            raise ImageGenerationError(f"OpenAI 生图失败：HTTP {exc.code} {detail}", 502) from exc
        except URLError as exc:
            raise ImageGenerationError(f"OpenAI 生图失败：{exc.reason}", 502) from exc
        except TimeoutError as exc:
            raise ImageGenerationError("OpenAI 生图超时", 504) from exc

        try:
            data = json.loads(body)
        except json.JSONDecodeError as exc:
            raise ImageGenerationError("OpenAI 返回了无效 JSON", 502) from exc

        images = []
        for item in data.get("data") or []:
            images.append(ProviderImagePayload(
                b64_json=str(item.get("b64_json") or ""),
                url=str(item.get("url") or ""),
                mime_type=_mime_from_format(payload.get("output_format")),
            ))
        if not images:
            raise ImageGenerationError("OpenAI 未返回图片", 502)
        return ProviderGenerationResult(
            images=images,
            request_id=str(data.get("id") or response_headers.get("x-request-id") or ""),
            usage=data.get("usage") if isinstance(data.get("usage"), dict) else {},
        )


def _mime_from_format(value: object) -> str:
    text = str(value or "").lower()
    if text in {"jpeg", "jpg"}:
        return "image/jpeg"
    if text == "webp":
        return "image/webp"
    return "image/png"
