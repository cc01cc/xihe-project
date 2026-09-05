import asyncio
import hashlib
import json
import time
from typing import Any, TypedDict

import httpx
from loguru import logger

DEFAULT_PROVIDER_BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "xiaomi": "https://api.xiaomimimo.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "dashscope": "https://dashscope.aliyuncs.com/compatible-mode/v1",
}

CONFIG_DOMAINS = (
    "llm-provider",
    "logging",
    "embedding",
    "workspace-config",
    "user-preference",
)


class DomainSyncResult(TypedDict):
    admin: str
    system: str
    effective: str


class SyncReport(TypedDict):
    ok: bool
    domains: dict[str, DomainSyncResult]
    revision: str
    refreshed: bool


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
        self._config_revision = ""
        self._last_sync_report: SyncReport = {
            "ok": False,
            "domains": {},
            "revision": "",
            "refreshed": False,
        }

    async def sync(self) -> SyncReport:
        staged_admin: dict[str, dict[str, str]] = {}
        staged_system: dict[str, dict[str, str]] = {}
        domain_results: dict[str, DomainSyncResult] = {
            domain: {"admin": "missing", "system": "missing", "effective": "missing"}
            for domain in (*CONFIG_DOMAINS, "infrastructure")
        }

        async with httpx.AsyncClient() as client:
            headers = {"Authorization": f"Bearer {self.api_token}"}
            for domain in CONFIG_DOMAINS:
                result, data = await self._fetch_domain(
                    client, "admin", domain, headers,
                )
                domain_results[domain]["admin"] = result
                if data is not None:
                    staged_admin[domain] = data

            for domain in (*CONFIG_DOMAINS, "infrastructure"):
                result, data = await self._fetch_domain(
                    client, "system", domain, headers,
                )
                domain_results[domain]["system"] = result
                if data is not None:
                    staged_system[domain] = data

        for domain, result in domain_results.items():
            result["effective"] = self._effective_status(result["admin"], result["system"])

        required = domain_results["llm-provider"]["effective"]
        transport_failure = required in {"unreachable", "unauthorized", "invalid_response"}
        report: SyncReport = {
            "ok": not transport_failure,
            "domains": domain_results,
            "revision": self._calculate_revision(staged_admin, staged_system),
            "refreshed": not transport_failure,
        }

        if report["refreshed"]:
            self._admin_cache = staged_admin
            self._system_cache = staged_system
            self._rebuild_provider_cache()
            self._last_fetch = time.time()
            self._config_revision = report["revision"]
            logger.info(
                "ConfigClient: synced adminDomains={} systemDomains={} revision={} llmStatus={} adminLlmKeys={} xiaomiPresent={}",
                len(self._admin_cache),
                len(self._system_cache),
                self._config_revision,
                required,
                list(self._admin_cache.get("llm-provider", {}).keys()),
                bool(self._admin_cache.get("llm-provider", {}).get("xiaomiApiKey")),
            )
        else:
            logger.error(
                "ConfigClient: required llm-provider refresh failed status={} revision={} keeping previous snapshot",
                required,
                self._config_revision,
            )

        self._last_sync_report = report
        return report

    async def _fetch_domain(
        self,
        client: httpx.AsyncClient,
        layer: str,
        domain: str,
        headers: dict[str, str],
    ) -> tuple[str, dict[str, str] | None]:
        try:
            resp = await client.get(
                f"{self.cp_url}/internal/v1/config/{layer}/{domain}",
                headers=headers,
                timeout=3,
            )
        except Exception as exc:
            logger.warning(
                "ConfigClient: failed to fetch layer={} domain={} status=unreachable error={}",
                layer,
                domain,
                exc,
            )
            return "unreachable", None

        if resp.status_code == 404:
            return "missing", None
        if resp.status_code in (401, 403):
            logger.warning(
                "ConfigClient: layer={} domain={} status=unauthorized httpStatus={}",
                layer,
                domain,
                resp.status_code,
            )
            return "unauthorized", None
        if resp.status_code != 200:
            logger.warning(
                "ConfigClient: layer={} domain={} status=unreachable httpStatus={}",
                layer,
                domain,
                resp.status_code,
            )
            return "unreachable", None

        try:
            data = resp.json()
        except Exception as exc:
            logger.warning(
                "ConfigClient: layer={} domain={} status=invalid_response error={}",
                layer,
                domain,
                exc,
            )
            return "invalid_response", None
        if not isinstance(data, dict) or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in data.items()
        ):
            logger.warning(
                "ConfigClient: layer={} domain={} status=invalid_response reason=object_of_strings_required",
                layer,
                domain,
            )
            return "invalid_response", None
        return "ok", data

    @staticmethod
    def _effective_status(admin_status: str, system_status: str) -> str:
        if "ok" in (admin_status, system_status):
            return "ok"
        if admin_status == "missing" and system_status == "missing":
            return "missing"
        if "unauthorized" in (admin_status, system_status):
            return "unauthorized"
        if "invalid_response" in (admin_status, system_status):
            return "invalid_response"
        return "unreachable"

    @staticmethod
    def _calculate_revision(
        admin_cache: dict[str, dict[str, str]],
        system_cache: dict[str, dict[str, str]],
    ) -> str:
        payload = json.dumps(
            {"admin": admin_cache, "system": system_cache},
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        return hashlib.sha256(payload).hexdigest()[:16]

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

    async def sync_with_retry(self, max_retries: int = 3) -> SyncReport:
        last_report = self._last_sync_report
        for attempt in range(max_retries):
            try:
                last_report = await self.sync()
                if last_report["ok"]:
                    return last_report
            except Exception as e:
                logger.warning(
                    "ConfigClient: sync attempt %d/%d failed: %s",
                    attempt + 1, max_retries, e,
                )
            if attempt < max_retries - 1:
                await asyncio.sleep(2**attempt)
        logger.error(
            "ConfigClient: failed to sync after {} retries status={}",
            max_retries,
            last_report["domains"].get("llm-provider", {}).get("effective", "unknown"),
        )
        return last_report

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

    @property
    def config_revision(self) -> str:
        return self._config_revision

    @property
    def last_sync_report(self) -> SyncReport:
        return self._last_sync_report
