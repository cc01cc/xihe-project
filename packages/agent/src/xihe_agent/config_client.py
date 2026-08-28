import asyncio
import time
from typing import Any

import httpx
from loguru import logger

DEFAULT_PROVIDER_BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "xiaomi": "https://api.xiaomimimo.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "dashscope": "https://dashscope.aliyuncs.com/compatible-mode/v1",
}


class ConfigClient:
    """Fetches and caches config from CP ConfigService (admin + system layers).

    Resolution: user > admin > system (handled server-side).
    """

    def __init__(self, cp_url: str, api_token: str):
        self.cp_url = cp_url
        self.api_token = api_token
        self._provider_cache: dict[str, dict[str, Any]] = {}
        self._system_cache: dict[str, dict[str, str]] = {}
        self._admin_cache: dict[str, dict[str, str]] = {}
        self._last_fetch = 0.0

    async def sync(self) -> None:
        async with httpx.AsyncClient() as client:
            headers = {"Authorization": f"Bearer {self.api_token}"}
            admin_domains = [
                "llm-provider", "logging", "embedding",
                "workspace-config", "user-preference",
            ]
            for domain in admin_domains:
                try:
                    resp = await client.get(
                        f"{self.cp_url}/internal/v1/config/admin/{domain}",
                        headers=headers,
                        timeout=3,
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        if isinstance(data, dict):
                            self._admin_cache[domain] = data
                except Exception as e:
                    logger.debug("ConfigClient: failed to fetch admin/{}: {}", domain, e)

            system_domains = admin_domains + ["infrastructure"]
            for domain in system_domains:
                try:
                    resp = await client.get(
                        f"{self.cp_url}/internal/v1/config/system/{domain}",
                        headers=headers,
                        timeout=3,
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        if isinstance(data, dict):
                            self._system_cache[domain] = data
                except Exception as e:
                    logger.debug("ConfigClient: failed to fetch system/{}: {}", domain, e)

            self._rebuild_provider_cache()
            self._last_fetch = time.time()
            logger.info(
                "ConfigClient: synced %d admin domains, %d system domains",
                len(self._admin_cache), len(self._system_cache,
            ))

    def _rebuild_provider_cache(self) -> None:
        merged: dict[str, dict[str, Any]] = {}
        admin_llm = self._admin_cache.get("llm-provider", {})
        system_llm = self._system_cache.get("llm-provider", {})
        api_keys = {
            "openai": admin_llm.get("openaiApiKey") or system_llm.get("openaiApiKey", ""),
            "deepseek": admin_llm.get("deepseekApiKey") or system_llm.get("deepseekApiKey", ""),
            "xiaomi": admin_llm.get("xiaomiApiKey") or system_llm.get("xiaomiApiKey", ""),
            "anthropic": admin_llm.get("anthropicApiKey") or system_llm.get("anthropicApiKey", ""),
            "dashscope": admin_llm.get("dashscopeApiKey") or system_llm.get("dashscopeApiKey", ""),
        }
        for provider, api_key in api_keys.items():
            if api_key:
                base_url = (
                    admin_llm.get(f"{provider}ApiBase")
                    or system_llm.get(f"{provider}ApiBase")
                    or admin_llm.get("baseUrl")
                    or system_llm.get("baseUrl", "")
                    or DEFAULT_PROVIDER_BASE_URLS.get(provider, "")
                )
                merged[provider] = {
                    "provider": provider,
                    "apiKey": api_key,
                    "baseUrl": base_url,
                    "model": (
                        admin_llm.get(f"{provider}Model")
                        or system_llm.get(f"{provider}Model", "")
                    ),
                }
        self._provider_cache = merged

    async def sync_with_retry(self, max_retries: int = 3) -> None:
        for attempt in range(max_retries):
            try:
                return await self.sync()
            except Exception as e:
                logger.warning(
                    "ConfigClient: sync attempt %d/%d failed: %s",
                    attempt + 1, max_retries, e,
                )
                if attempt < max_retries - 1:
                    await asyncio.sleep(2**attempt)
        logger.error("ConfigClient: failed to sync after {} retries", max_retries)

    def get(self, domain: str, key: str) -> str | None:
        if domain in self._admin_cache and key in self._admin_cache[domain]:
            return self._admin_cache[domain][key]
        if domain in self._system_cache and key in self._system_cache[domain]:
            return self._system_cache[domain][key]
        return None

    def get_bool(self, domain: str, key: str) -> bool:
        val = self.get(domain, key)
        return val is not None and val.lower() in ("true", "1", "yes")

    def get_providers(self) -> dict[str, dict[str, Any]]:
        return self._provider_cache

    def get_provider(self, provider: str) -> dict[str, Any] | None:
        return self._provider_cache.get(provider)

    @property
    def last_fetch(self) -> float:
        return self._last_fetch
