"""Image generation tool with multi-provider support.

Supported providers:
- gpt-image: OpenAI GPT-Image-2 (DALL-E successor)
- qwen-image: Alibaba Qwen-Image via DashScope API
"""

import base64
import os
from abc import ABC, abstractmethod
from typing import Any

import httpx
from langchain_core.tools import BaseTool
from loguru import logger
from pydantic import BaseModel, Field

from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import BaseAgentTool, ToolSpec


class ImageProvider(ABC):
    @abstractmethod
    async def generate(self, prompt: str, size: str, quality: str) -> bytes:
        """Generate image from prompt, return PNG bytes."""


class GPTImageProvider(ImageProvider):
    """OpenAI GPT-Image-2 provider."""

    def __init__(self, api_key: str, base_url: str = "https://api.openai.com/v1"):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    async def generate(self, prompt: str, size: str = "1024x1024", quality: str = "medium") -> bytes:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{self.base_url}/images/generations",
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                json={"model": "gpt-image-2", "prompt": prompt, "size": size, "quality": quality, "n": 1},
            )
            resp.raise_for_status()
            data = resp.json()
            b64 = data["data"][0]["b64_json"]
            return base64.b64decode(b64)


class QwenImageProvider(ImageProvider):
    """Alibaba Qwen-Image provider via DashScope API."""

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.base_url = "https://dashscope.aliyuncs.com/api/v1"

    async def generate(self, prompt: str, size: str = "1024x1024", quality: str = "medium") -> bytes:
        width, height = (int(x) for x in size.split("x"))
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{self.base_url}/services/aigc/text2image/image-synthesis",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "X-DashScope-Async": "enable",
                },
                json={
                    "model": "qwen-image-2.0-pro",
                    "input": {"prompt": prompt},
                    "parameters": {"size": f"{width}*{height}", "n": 1},
                },
            )
            resp.raise_for_status()
            task_id = resp.json()["output"]["task_id"]
            logger.info("Qwen image task submitted: %s", task_id)

            for _ in range(60):
                await __import__("asyncio").sleep(2)
                status_resp = await client.get(
                    f"{self.base_url}/tasks/{task_id}",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
                status_resp.raise_for_status()
                status_data = status_resp.json()
                status = status_data["output"]["task_status"]
                if status == "SUCCEEDED":
                    image_url = status_data["output"]["results"][0]["url"]
                    img_resp = await client.get(image_url)
                    img_resp.raise_for_status()
                    return img_resp.content
                elif status in ("FAILED", "CANCELED"):
                    raise RuntimeError(f"Qwen image generation failed: {status_data}")

            raise RuntimeError("Qwen image generation timed out after 120s")


class ProviderManager:
    """Manages image generation providers."""

    def __init__(self):
        self.providers: dict[str, ImageProvider] = {}
        self.default_provider: str | None = None

    def register(self, name: str, provider: ImageProvider) -> None:
        self.providers[name] = provider
        if self.default_provider is None:
            self.default_provider = name

    def get(self, name: str | None = None) -> ImageProvider:
        key = name or self.default_provider
        if key not in self.providers:
            available = ", ".join(self.providers.keys()) or "none"
            raise ValueError(f"Unknown image provider '{key}'. Available: {available}")
        return self.providers[key]

    @classmethod
    def from_env(cls) -> "ProviderManager":
        mgr = cls()
        openai_key = os.getenv("XIHE_OPENAI_API_KEY")
        if openai_key:
            base_url = os.getenv("XIHE_OPENAI_BASE_URL", "https://api.openai.com/v1")
            mgr.register("gpt-image", GPTImageProvider(api_key=openai_key, base_url=base_url))

        dashscope_key = os.getenv("XIHE_DASHSCOPE_API_KEY")
        if dashscope_key:
            mgr.register("qwen-image", QwenImageProvider(api_key=dashscope_key))

        default = os.getenv("XIHE_IMAGE_PROVIDER")
        if default and default in mgr.providers:
            mgr.default_provider = default

        return mgr

    @classmethod
    def from_config_client(cls, cc) -> "ProviderManager":
        mgr = cls()
        openai_key = cc.get("llm-provider", "openaiApiKey")
        if openai_key:
            base_url = cc.get("llm-provider", "baseUrl") or "https://api.openai.com/v1"
            mgr.register("gpt-image", GPTImageProvider(api_key=openai_key, base_url=base_url))

        dashscope_key = cc.get("llm-provider", "dashscopeApiKey")
        if dashscope_key:
            mgr.register("qwen-image", QwenImageProvider(api_key=dashscope_key))

        default = cc.get("llm-provider", "imageProvider")
        if default and default in mgr.providers:
            mgr.default_provider = default

        return mgr


class GenerateImageInput(BaseModel):
    prompt: str = Field(description="图片描述，越详细越好")
    size: str = Field(default="1024x1024", description="图片尺寸：1024x1024, 1024x1792, 1792x1024")
    quality: str = Field(default="medium", description="图片质量：low, medium, high")


class GenerateImageAgentTool(BaseAgentTool):
    """Agent-tool implementation of the image generation tool."""

    def __init__(self, provider_manager: ProviderManager) -> None:
        self._provider_manager = provider_manager

    async def execute(self, input: dict[str, Any], context: AgentContext) -> dict[str, Any]:
        prompt = input.get("prompt", "")
        size = input.get("size", "1024x1024")
        quality = input.get("quality", "medium")
        provider = self._provider_manager.get()
        logger.info(
            "Generating image: provider=%s, prompt=%s, size=%s",
            type(provider).__name__, prompt[:60], size,
        )
        try:
            image_bytes = await provider.generate(prompt, size, quality)
            b64 = base64.b64encode(image_bytes).decode()
            logger.info("Image generated: %d bytes", len(image_bytes))
            return {
                "content": f"[IMAGE:{type(provider).__name__}:{size}]\ndata:image/png;base64,{b64}",
            }
        except Exception as e:
            logger.error("Image generation failed: %s", e, exc_info=True)
            return {"content": f"图片生成失败: {e}"}

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="generate_image",
            description="根据文字描述生成图片。返回生成的图片。",
            input_schema={
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "图片描述，越详细越好"},
                    "size": {"type": "string", "default": "1024x1024"},
                    "quality": {"type": "string", "default": "medium"},
                },
                "required": ["prompt"],
            },
        )

    @property
    def name(self) -> str:
        return self.spec.name

    @property
    def description(self) -> str:
        return self.spec.description


class GenerateImageTool(BaseTool):
    """Legacy LangChain BaseTool implementation kept for supervisor/registry compatibility."""

    name: str = "generate_image"
    description: str = "根据文字描述生成图片。返回生成的图片。"
    args_schema: type[BaseModel] = GenerateImageInput

    provider_manager: ProviderManager

    def _run(self, prompt: str, size: str = "1024x1024", quality: str = "medium") -> str:
        raise NotImplementedError("Use async run")

    async def _arun(self, prompt: str, size: str = "1024x1024", quality: str = "medium") -> str:
        provider = self.provider_manager.get()
        logger.info("Generating image: provider=%s, prompt=%s, size=%s", type(provider).__name__, prompt[:60], size)
        try:
            image_bytes = await provider.generate(prompt, size, quality)
            b64 = base64.b64encode(image_bytes).decode()
            logger.info("Image generated: %d bytes", len(image_bytes))
            return f"[IMAGE:{type(provider).__name__}:{size}]\ndata:image/png;base64,{b64}"
        except Exception as e:
            logger.error("Image generation failed: %s", e, exc_info=True)
            return f"图片生成失败: {e}"
