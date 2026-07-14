"""Gemini/Imagen 图片生成 Provider。"""
from __future__ import annotations

import asyncio
import base64
import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .base import ImageGenerationError, ImageGenerationRequest, ImageProvider, ProviderGenerationResult, ProviderImagePayload


class GeminiImageProvider(ImageProvider):
    name = "gemini"
    display_name = "Gemini"
    default_model = "gemini-2.5-flash-image"
    default_aspect_ratios = ["1:1", "16:9", "9:16", "4:3", "3:4"]

    def __init__(self, env: dict[str, str] | None = None):
        self.env = env or {}

    def _env(self, key: str) -> str:
        return str(self.env.get(key) or os.environ.get(key) or "").strip()

    def _api_key(self) -> str:
        return self._env("GEMINI_API_KEY") or self._env("GOOGLE_API_KEY")

    def configured(self) -> bool:
        return bool(self._api_key())

    def models(self) -> list[dict]:
        configured = self._env("GEMINI_IMAGE_MODELS")
        model_ids = [item.strip() for item in configured.split(",") if item.strip()] or [self.default_model]
        return [
            {"id": model_id, "name": "Gemini 2.5 Flash Image" if model_id == self.default_model else model_id, "default": idx == 0}
            for idx, model_id in enumerate(model_ids)
        ]

    def options(self) -> dict:
        return {"aspect_ratios": self.default_aspect_ratios}

    async def generate(self, request: ImageGenerationRequest) -> ProviderGenerationResult:
        if not self.configured():
            raise ImageGenerationError("未配置 GEMINI_API_KEY 或 GOOGLE_API_KEY", 400)
        return await asyncio.to_thread(self._generate_sync, request)

    def _generate_sync(self, request: ImageGenerationRequest) -> ProviderGenerationResult:
        api_key = self._api_key()
        base_url = (self._env("GEMINI_BASE_URL") or "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
        model = request.model or self.default_model
        parts = [{"text": request.prompt}]
        for image in request.input_images:
            parts.append({
                "inlineData": {
                    "mimeType": image.mime_type,
                    "data": base64.b64encode(image.data).decode("ascii"),
                }
            })
        payload = {
            "contents": [
                {"role": "user", "parts": parts}
            ]
        }
        generation_config = {}
        if request.aspect_ratio:
            generation_config["aspectRatio"] = request.aspect_ratio
        if isinstance(request.extra, dict):
            for key, value in request.extra.items():
                if key in {"responseModalities", "aspectRatio", "imageConfig", "generationConfig"} and value not in (None, ""):
                    if key == "generationConfig" and isinstance(value, dict):
                        generation_config.update(value)
                    else:
                        generation_config[key] = value
        if generation_config:
            payload["generationConfig"] = generation_config

        url = f"{base_url}/models/{quote(model, safe='')}:generateContent?key={quote(api_key, safe='')}"
        req = Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(req, timeout=120) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                response_headers = dict(resp.headers.items())
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:1000]
            raise ImageGenerationError(f"Gemini 生图失败：HTTP {exc.code} {detail}", 502) from exc
        except URLError as exc:
            raise ImageGenerationError(f"Gemini 生图失败：{exc.reason}", 502) from exc
        except TimeoutError as exc:
            raise ImageGenerationError("Gemini 生图超时", 504) from exc

        try:
            data = json.loads(body)
        except json.JSONDecodeError as exc:
            raise ImageGenerationError("Gemini 返回了无效 JSON", 502) from exc

        images = []
        for candidate in data.get("candidates") or []:
            content = candidate.get("content") or {}
            for part in content.get("parts") or []:
                inline_data = part.get("inlineData") or part.get("inline_data") or {}
                raw = inline_data.get("data") or ""
                if raw:
                    images.append(ProviderImagePayload(
                        b64_json=str(raw),
                        mime_type=str(inline_data.get("mimeType") or inline_data.get("mime_type") or "image/png"),
                    ))
                file_data = part.get("fileData") or part.get("file_data") or {}
                uri = file_data.get("fileUri") or file_data.get("file_uri") or ""
                if uri:
                    images.append(ProviderImagePayload(
                        url=str(uri),
                        mime_type=str(file_data.get("mimeType") or file_data.get("mime_type") or "image/png"),
                    ))
        if not images:
            raise ImageGenerationError("Gemini 未返回图片", 502)
        usage = data.get("usageMetadata") or data.get("usage_metadata") or {}
        return ProviderGenerationResult(
            images=images,
            request_id=str(response_headers.get("x-request-id") or ""),
            usage=usage if isinstance(usage, dict) else {},
        )
