from typing import Any

import httpx
import litellm
import os

from fastapi import APIRouter, Depends, HTTPException, Request
from loguru import logger

router = APIRouter()


def verify_service_token(request: Request) -> None:
    expected = os.getenv("XIHE_CP_API_TOKEN", "dev-token-not-secure")
    if request.headers.get("Authorization") != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Authorization required")


class _ModelsRouter:
    """Router for /v1/models endpoint, lazily bound to provider client."""

    def __init__(self):
        self.config_client = None

    def bind(self, config_client: Any) -> None:
        self.config_client = config_client


_models_router = _ModelsRouter()


@router.get("/internal/v1/agent/models")
async def list_models(_token: None = Depends(verify_service_token)):
    """Proxy to each provider's /v1/models, merge and return."""
    cc = _models_router.config_client
    if cc is None:
        return {"models": {}}

    providers = cc.get_providers()
    results: dict[str, list[str]] = {}
    for pid, cfg in providers.items():
        api_key = cfg.get("apiKey") or cfg.get("api_key", "")
        base_url = cfg.get("baseUrl") or cfg.get("base_url", "")
        if not api_key:
            logger.debug("Skipping provider {}: no API key", pid)
            results[pid] = []
            continue
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{base_url}/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=10,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    model_ids = [m["id"] for m in data.get("data", [])]
                    results[pid] = model_ids
                    logger.debug(
                        "Fetched {} models from {}", len(model_ids), pid
                    )
                else:
                    logger.warning(
                        "{} /v1/models returned {}", pid, resp.status_code
                    )
                    results[pid] = []
        except Exception as e:
            logger.warning("Failed to fetch models from {}: {}", pid, e)
            results[pid] = []
    return {"models": results}


@router.get("/internal/v1/agent/embedding-models")
async def list_embedding_models(_token: None = Depends(verify_service_token)):
    """List available embedding models from litellm, filtered by configured providers."""
    cc = _models_router.config_client
    if cc is None:
        return {"models": []}
    providers = cc.get_providers()
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
