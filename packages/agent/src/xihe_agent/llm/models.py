import os
import re
from datetime import UTC, datetime
from typing import Any

import httpx
import litellm
from fastapi import APIRouter, Depends, HTTPException, Request
from loguru import logger

from xihe_agent.llm.base import fallback_provider_configs

router = APIRouter()


def verify_service_token(request: Request) -> None:
    expected = os.getenv("XIHE_AGENT_API_TOKEN") or os.getenv("XIHE_CP_API_TOKEN", "dev-token-not-secure")
    if request.headers.get("Authorization") != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Authorization required")


class _ModelsRouter:
    """Router for /v1/models endpoint, lazily bound to provider client."""

    def __init__(self):
        self.config_client = None

    def bind(self, config_client: Any) -> None:
        self.config_client = config_client


_models_router = _ModelsRouter()


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _model_capabilities(provider: str, model_id: str) -> dict[str, bool]:
    # The connection Catalog, rather than this function's provider allowlist,
    # is the authority for which adapters are enabled. Keep the conservative
    # suffix exclusions for endpoints that are clearly not chat models.
    chat = not bool(re.search(r"(?:-|_)(?:asr|tts)$", model_id, re.IGNORECASE))
    return {"chat": chat, "vision": False, "tools": False}


async def fetch_model_catalog(config_client: Any) -> dict[str, Any]:
    """Fetch provider models while preserving actionable status semantics."""
    if config_client is None:
        return {"models": {}, "providers": {}, "configRevision": ""}

    providers = fallback_provider_configs(config_client.get_domain("llm-provider"))
    results: dict[str, list[str]] = {}
    provider_catalog: dict[str, dict[str, Any]] = {}
    async with httpx.AsyncClient() as client:
        for provider_id, cfg in providers.items():
            api_key = cfg.get("apiKey") or cfg.get("api_key", "")
            base_url = (cfg.get("baseUrl") or cfg.get("base_url", "")).rstrip("/")
            if not api_key:
                results[provider_id] = []
                provider_catalog[provider_id] = {
                    "status": "missing_credentials",
                    "reasonCode": "LLM_NOT_CONFIGURED",
                    "models": [],
                    "verifiedAt": None,
                    "configRevision": config_client.config_revision,
                }
                continue

            status = "ready"
            reason_code = None
            models: list[dict[str, Any]] = []
            try:
                resp = await client.get(
                    f"{base_url}/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=5,
                )
                if resp.status_code in (401, 403):
                    status = "invalid_credentials"
                    reason_code = "LLM_CREDENTIALS_INVALID"
                elif resp.status_code >= 400:
                    status = "unreachable"
                    reason_code = "LLM_PROVIDER_UNREACHABLE"
                else:
                    data = resp.json()
                    raw_models = data.get("data") if isinstance(data, dict) else None
                    if not isinstance(raw_models, list):
                        status = "invalid_response"
                        reason_code = "LLM_MODEL_CATALOG_INVALID"
                    else:
                        model_ids: list[str] = []
                        for item in raw_models:
                            model_id = item.get("id") if isinstance(item, dict) else None
                            if isinstance(model_id, str) and model_id:
                                model_ids.append(model_id)
                        if len(model_ids) != len(raw_models):
                            status = "invalid_response"
                            reason_code = "LLM_MODEL_CATALOG_INVALID"
                        else:
                            results[provider_id] = model_ids
                            models = [
                                {
                                    "name": model_id,
                                    "capabilities": _model_capabilities(provider_id, model_id),
                                }
                                for model_id in model_ids
                            ]
            except httpx.TimeoutException:
                status = "unreachable"
                reason_code = "LLM_PROVIDER_TIMEOUT"
            except Exception as exc:
                logger.warning(
                    "Failed to fetch models from provider={} status=unreachable error={}",
                    provider_id,
                    exc,
                )
                status = "unreachable"
                reason_code = "LLM_PROVIDER_UNREACHABLE"

            results.setdefault(provider_id, [])
            provider_catalog[provider_id] = {
                "status": status,
                "reasonCode": reason_code,
                "models": models,
                "verifiedAt": _now_iso() if status == "ready" else None,
                "configRevision": config_client.config_revision,
            }
            logger.info(
                "Model catalog provider={} status={} modelCount={} reasonCode={}",
                provider_id,
                status,
                len(models),
                reason_code or "none",
            )

    return {
        "models": results,
        "providers": provider_catalog,
        "configRevision": config_client.config_revision,
    }


async def fetch_connection_catalog(
        config_client: Any,
        connections: list[dict[str, Any]],
) -> dict[str, Any]:
    """Fetch a user-scoped catalog using CP-issued credential leases."""
    results: dict[str, list[str]] = {}
    provider_catalog: dict[str, dict[str, Any]] = {}
    async with httpx.AsyncClient() as client:
        for descriptor in connections:
            provider_id = str(descriptor.get("providerId", ""))
            connection_id = str(descriptor.get("connectionId", ""))
            catalog_key = provider_id
            if not provider_id or not connection_id or catalog_key in provider_catalog:
                continue
            try:
                grant = await config_client.redeem_provider_lease({
                    "lease": descriptor.get("lease"),
                    "runId": descriptor.get("runId", ""),
                    "providerConnectionId": connection_id,
                    "providerId": provider_id,
                    "model": "*",
                    "connectionRevision": int(descriptor.get("connectionRevision", 0)),
                })
                status = "ready"
                reason_code = None
                models: list[dict[str, Any]] = []
                manual_models = grant.get("manualModels")
                if grant.get("modelDiscovery") == "manual" and isinstance(manual_models, list):
                    models = [
                        {"name": str(model_id), "capabilities": _model_capabilities(provider_id, str(model_id))}
                        for model_id in manual_models
                        if isinstance(model_id, str) and model_id
                    ]
                    if not models:
                        status = "invalid_response"
                        reason_code = "LLM_MODEL_CATALOG_INVALID"
                else:
                    api_key = grant.get("apiKey") or ""
                    base_url = str(grant.get("baseUrl") or "").rstrip("/")
                    if not base_url:
                        raise RuntimeError("Provider Base URL is missing")
                    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
                    response = await client.get(
                        f"{base_url}/models",
                        headers=headers,
                        timeout=5,
                    )
                    if response.status_code in (401, 403):
                        status = "invalid_credentials"
                        reason_code = "LLM_CREDENTIALS_INVALID"
                    elif response.status_code >= 400:
                        status = "unreachable"
                        reason_code = "LLM_PROVIDER_UNREACHABLE"
                    else:
                        data = response.json()
                        raw_models = data.get("data") if isinstance(data, dict) else None
                        if not isinstance(raw_models, list):
                            status = "invalid_response"
                            reason_code = "LLM_MODEL_CATALOG_INVALID"
                        else:
                            for item in raw_models:
                                model_id = item.get("id") if isinstance(item, dict) else None
                                if not isinstance(model_id, str) or not model_id:
                                    status = "invalid_response"
                                    reason_code = "LLM_MODEL_CATALOG_INVALID"
                                    models = []
                                    break
                                models.append({
                                    "name": model_id,
                                    "capabilities": _model_capabilities(provider_id, model_id),
                                })
                results[catalog_key] = [model["name"] for model in models]
                provider_catalog[catalog_key] = {
                    "connectionId": connection_id,
                    "scope": descriptor.get("scope", "USER"),
                    "displayName": descriptor.get("displayName", provider_id),
                    "connectionStatus": status,
                    "status": status,
                    "reasonCode": reason_code,
                    "models": models,
                    "verifiedAt": _now_iso() if status == "ready" else None,
                    "connectionRevision": descriptor.get("connectionRevision"),
                    "configRevision": config_client.config_revision,
                }
            except Exception as exc:
                logger.warning(
                    "Scoped model catalog failed provider={} connectionId={} errorType={}",
                    provider_id,
                    connection_id,
                    type(exc).__name__,
                )
                results[catalog_key] = []
                provider_catalog[catalog_key] = {
                    "connectionId": connection_id,
                    "scope": descriptor.get("scope", "USER"),
                    "displayName": descriptor.get("displayName", provider_id),
                    "connectionStatus": "unreachable",
                    "status": "unreachable",
                    "reasonCode": "LLM_PROVIDER_UNREACHABLE",
                    "models": [],
                    "verifiedAt": None,
                    "connectionRevision": descriptor.get("connectionRevision"),
                    "configRevision": config_client.config_revision,
                }
    return {
        "models": results,
        "providers": provider_catalog,
        "configRevision": config_client.config_revision,
    }


@router.get("/internal/v1/agent/models")
async def list_models(_token: None = Depends(verify_service_token)):
    """Proxy to each provider's /v1/models and preserve status semantics."""
    cc = _models_router.config_client
    return await fetch_model_catalog(cc)


@router.post("/internal/v1/agent/models")
async def list_scoped_models(request: Request, _token: None = Depends(verify_service_token)):
    cc = _models_router.config_client
    data = await request.json()
    connections = data.get("connections", []) if isinstance(data, dict) else []
    if not isinstance(connections, list):
        raise HTTPException(status_code=400, detail="connections must be an array")
    return await fetch_connection_catalog(cc, connections)


@router.get("/internal/v1/agent/embedding-models")
async def list_embedding_models(_token: None = Depends(verify_service_token)):
    """List available embedding models from litellm, filtered by configured providers."""
    cc = _models_router.config_client
    if cc is None:
        return {"models": []}
    providers = fallback_provider_configs(cc.get_domain("llm-provider"))
    if not providers:
        return {"models": []}
    result: list[dict[str, Any]] = []
    for model_key, info in litellm.model_cost.items():
        if info.get("mode") != "embedding":
            continue
        provider = info.get("litellm_provider")
        if provider not in providers:
            continue
        result.append({
            "model": model_key,
            "provider": provider,
            "dimensions": info.get("output_vector_size"),
        })
    return {"models": result}
