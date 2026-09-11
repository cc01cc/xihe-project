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

# PLAN-0307 s13/s37: eight-domain set; layer-less effective fetch (decision #19).
CONFIG_DOMAINS = (
    "llm-provider",
    "context-policy",
    "embedding",
    "logging",
    "agent-runtime",
    "agent-profile",
    "user-preference",
    "rag",
)

# Domains required for the Agent to become llm-ready (fail-closed otherwise).
REQUIRED_DOMAINS = ("llm-provider",)


class DomainSyncResult(TypedDict):
    status: str
    revision: str
    source: str


class SyncReport(TypedDict):
    ok: bool
    domains: dict[str, DomainSyncResult]
    revision: str
    refreshed: bool


class ConfigClient:
    """Fetches and caches the **effective** config from CP ConfigService.

    PLAN-0307 decision #19 (layer encapsulation): the Agent never selects layers.
    CP resolves `env > workspace > user > instance > code default` server-side and
    returns a single merged value set per domain (plus `revision` and `source`).

    Workspace scope is bound per process (`workspace_id`, Agent is single-workspace);
    user scope arrives per run via the `userOverrides` payload field (decision #3a).
    """

    def __init__(self, cp_url: str, api_token: str, workspace_id: str | None = None):
        self.cp_url = cp_url
        self.api_token = api_token
        self.workspace_id = workspace_id
        self._provider_cache: dict[str, dict[str, Any]] = {}
        self._effective_cache: dict[str, dict[str, str]] = {}
        self._last_fetch = 0.0
        self._config_revision = ""
        self._last_sync_report: SyncReport = {
            "ok": False,
            "domains": {},
            "revision": "",
            "refreshed": False,
        }

    async def sync(self) -> SyncReport:
        staged: dict[str, dict[str, str]] = {}
        domain_results: dict[str, DomainSyncResult] = {}
        revisions: list[str] = []

        async with httpx.AsyncClient() as client:
            headers = {"Authorization": f"Bearer {self.api_token}"}
            for domain in CONFIG_DOMAINS:
                status, data, revision, source = await self._fetch_effective(
                    client, domain, headers,
                )
                domain_results[domain] = {
                    "status": status,
                    "revision": revision,
                    "source": source,
                }
                if data is not None:
                    staged[domain] = data
                if revision:
                    revisions.append(revision)

        required_statuses = [
            domain_results.get(domain, {}).get("status", "missing")
            for domain in REQUIRED_DOMAINS
        ]
        transport_failure = any(
            status in {"unreachable", "unauthorized", "invalid_response"}
            for status in required_statuses
        )
        revision = self._calculate_revision(staged, revisions)
        report: SyncReport = {
            "ok": not transport_failure,
            "domains": domain_results,
            "revision": revision,
            "refreshed": not transport_failure,
        }

        if report["refreshed"]:
            self._effective_cache = staged
            self._rebuild_provider_cache()
            self._last_fetch = time.time()
            self._config_revision = revision
            logger.info(
                "ConfigClient: synced effective domains={} revision={} workspaceBound={} llmStatus={}",
                len(self._effective_cache),
                self._config_revision,
                bool(self.workspace_id),
                required_statuses,
            )
        else:
            logger.error(
                "ConfigClient: required effective refresh failed statuses={} revision={} keeping previous snapshot",
                required_statuses,
                self._config_revision,
            )

        self._last_sync_report = report
        return report

    async def _fetch_effective(
        self,
        client: httpx.AsyncClient,
        domain: str,
        headers: dict[str, str],
    ) -> tuple[str, dict[str, str] | None, str, str]:
        params: dict[str, str] = {}
        if self.workspace_id:
            params["workspaceId"] = self.workspace_id
        try:
            resp = await client.get(
                f"{self.cp_url}/internal/v1/config/effective/{domain}",
                headers=headers,
                params=params,
                timeout=3,
            )
        except Exception as exc:
            logger.warning(
                "ConfigClient: failed to fetch effective domain={} status=unreachable error={}",
                domain,
                exc,
            )
            return "unreachable", None, "", ""

        if resp.status_code == 400:
            logger.warning(
                "ConfigClient: effective domain={} status=invalid_domain httpStatus=400",
                domain,
            )
            return "invalid_response", None, "", ""
        if resp.status_code == 404:
            return "missing", None, "", ""
        if resp.status_code in (401, 403):
            logger.warning(
                "ConfigClient: effective domain={} status=unauthorized httpStatus={}",
                domain,
                resp.status_code,
            )
            return "unauthorized", None, "", ""
        if resp.status_code != 200:
            logger.warning(
                "ConfigClient: effective domain={} status=unreachable httpStatus={}",
                domain,
                resp.status_code,
            )
            return "unreachable", None, "", ""

        try:
            payload = resp.json()
        except Exception as exc:
            logger.warning(
                "ConfigClient: effective domain={} status=invalid_response error={}",
                domain,
                exc,
            )
            return "invalid_response", None, "", ""
        entries = payload.get("entries") if isinstance(payload, dict) else None
        if not isinstance(entries, dict) or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in entries.items()
        ):
            logger.warning(
                "ConfigClient: effective domain={} status=invalid_response reason=entries_object_of_strings_required",
                domain,
            )
            return "invalid_response", None, "", ""
        revision = payload.get("revision")
        source = payload.get("source")
        return (
            "ok",
            entries,
            revision if isinstance(revision, str) else "",
            source if isinstance(source, str) else "",
        )

    @staticmethod
    def _calculate_revision(
        staged: dict[str, dict[str, str]],
        revisions: list[str],
    ) -> str:
        # Prefer CP-supplied revisions when present; fall back to a content hash.
        if revisions:
            payload = json.dumps(sorted(revisions), ensure_ascii=True).encode()
            return hashlib.sha256(payload).hexdigest()[:16]
        payload = json.dumps(
            staged,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        return hashlib.sha256(payload).hexdigest()[:16]

    def _rebuild_provider_cache(self) -> None:
        merged: dict[str, dict[str, Any]] = {}
        llm = self._effective_cache.get("llm-provider", {})
        api_keys = {
            "openai": llm.get("openaiApiKey", ""),
            "deepseek": llm.get("deepseekApiKey", ""),
            "xiaomi": llm.get("xiaomiApiKey", ""),
            "anthropic": llm.get("anthropicApiKey", ""),
            "dashscope": llm.get("dashscopeApiKey", ""),
        }
        for provider, api_key in api_keys.items():
            if api_key:
                base_url = (
                    llm.get(f"{provider}ApiBase")
                    or llm.get("baseUrl")
                    or DEFAULT_PROVIDER_BASE_URLS.get(provider, "")
                )
                merged[provider] = {
                    "provider": provider,
                    "apiKey": api_key,
                    "baseUrl": base_url,
                    "model": llm.get(f"{provider}Model", ""),
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
            last_report["domains"].get("llm-provider", {}).get("status", "unknown"),
        )
        return last_report

    def get(self, domain: str, key: str) -> str | None:
        entries = self._effective_cache.get(domain)
        if entries is None:
            return None
        return entries.get(key)

    def get_bool(self, domain: str, key: str) -> bool:
        val = self.get(domain, key)
        return val is not None and val.lower() in ("true", "1", "yes")

    def get_providers(self) -> dict[str, dict[str, Any]]:
        return self._provider_cache

    def get_provider(self, provider: str) -> dict[str, Any] | None:
        return self._provider_cache.get(provider)

    async def redeem_provider_lease(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Redeem a short-lived CP credential lease without persisting the key."""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.cp_url}/internal/v1/provider-leases/redeem",
                headers={"Authorization": f"Bearer {self.api_token}"},
                json=payload,
                timeout=5,
            )
        if response.status_code >= 400:
            logger.warning(
                "ConfigClient: provider lease redeem failed status={} code={}",
                response.status_code,
                response.json().get("code") if response.headers.get("content-type", "").startswith("application/json") else "unknown",
            )
            raise RuntimeError("Provider credential lease is unavailable")
        data = response.json()
        if not isinstance(data, dict):
            raise RuntimeError("Provider credential lease response is invalid")
        return data

    @property
    def last_fetch(self) -> float:
        return self._last_fetch

    @property
    def config_revision(self) -> str:
        return self._config_revision

    @property
    def last_sync_report(self) -> SyncReport:
        return self._last_sync_report
