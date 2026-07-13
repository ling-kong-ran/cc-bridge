"""图片生成 Provider 抽象与数据模型。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class ImageGenerationError(Exception):
    """图片生成失败，message 可直接返回给前端。"""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


@dataclass
class ImageGenerationRequest:
    provider: str
    model: str
    prompt: str
    cwd: str = ""
    size: str = "1024x1024"
    aspect_ratio: str = ""
    quality: str = ""
    n: int = 1
    input_images: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class ProviderImagePayload:
    data: bytes | None = None
    b64_json: str = ""
    url: str = ""
    mime_type: str = "image/png"


@dataclass
class ProviderGenerationResult:
    images: list[ProviderImagePayload]
    request_id: str = ""
    usage: dict[str, Any] = field(default_factory=dict)


@dataclass
class GeneratedImage:
    path: str
    url: str
    mime_type: str
    name: str
    width: int | None = None
    height: int | None = None
    type: str = "generated_image"


@dataclass
class ImageGenerationResult:
    provider: str
    model: str
    prompt: str
    images: list[GeneratedImage]
    request_id: str = ""
    usage: dict[str, Any] = field(default_factory=dict)


class ImageProvider:
    name: str = ""

    def configured(self) -> bool:
        raise NotImplementedError

    def models(self) -> list[dict[str, Any]]:
        raise NotImplementedError

    def options(self) -> dict[str, Any]:
        return {}

    async def generate(self, request: ImageGenerationRequest) -> ProviderGenerationResult:
        raise NotImplementedError
