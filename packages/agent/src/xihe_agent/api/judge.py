"""PLAN-0624 M1 (D24-01, path A): the judge decision endpoint.

CP's ``JudgeDecisionService`` assembles the Q1 input window and a short-lived credential
lease; this endpoint redeems the lease (the credential never travels in the request body,
same contract as ``rag/embedding/test``), sends ONE completion through the shared
:class:`ApiSender` transport, and returns the raw verdict plus the metered facts.

The model wire shape is confined to ``_run_judge``: the Q6 probe currently supports the
OpenAI-compatible hypothesis; if the probe eventually proves a dedicated decision API,
only this module's body/sender construction changes — the CP-side ``JudgeModelClient``
seam and this endpoint's contract stay untouched.

Fail-closed (PLAN-0624 Q2) is CP-side: any problem here surfaces as a Problem Details
response, and the CP service records the refusal and does not speak.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from xihe_agent.api.shared import problem_details, verify_api_token
from xihe_agent.config_client import ProviderLeaseError
from xihe_agent.llm.api_request import CHAT_TYPES, ApiRequestError
from xihe_agent.llm.api_sender import ApiSender, NativeResponse

router = APIRouter()

# The judge speaks the OpenAI-compatible chat shape (Q6 probe hypothesis H1). Kept as a
# named constant so a dedicated-decision-API pivot touches exactly one place.
JUDGE_API_TYPE_ID = "openai-chat-completions"
# Q2: the judge sits on the wake-round critical path. 8s matches the CP audit vocabulary
# ("judge did not answer within 8s"); beyond that the run is better off without an answer.
JUDGE_TIMEOUT_SECONDS = 8.0
# The verdict is a short JSON object (Q1); bounding the completion bounds the per-call
# spend (G-04 — judge is a metered model consumer like any chat turn).
JUDGE_MAX_COMPLETION_TOKENS = 400


class JudgeDecideRequest(BaseModel):
    """camelCase wire names (CP contract) behind snake_case fields."""

    model_config = ConfigDict(populate_by_name=True)

    model_provider: str | None = Field(default=None, alias="modelProvider")
    model_name: str = Field(min_length=1, alias="modelName")
    prompt: str = Field(min_length=1)
    judge_credential_lease: str | None = Field(default=None, alias="judgeCredentialLease")


async def _run_judge(
    grant: dict[str, Any],
    model_name: str,
    prompt: str,
    request_id: str,
    sender_factory: Callable[[dict[str, Any]], Any] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """One provider completion; returns the raw verdict plus metered facts.

    ``sender_factory`` is the test seam — production always builds the shared ApiSender.
    Provider counters the response did not carry stay ``None`` (PLAN-0416 T2.3: unknown,
    never synthesized as 0).
    """
    api_type = CHAT_TYPES[JUDGE_API_TYPE_ID]
    factory = sender_factory or (
        lambda g: ApiSender(api_type, g, request_id, JUDGE_TIMEOUT_SECONDS)
    )
    sender = factory(grant)
    body = {
        "model": model_name,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": JUDGE_MAX_COMPLETION_TOKENS,
        "temperature": 0,
    }
    started = clock()
    last: NativeResponse | None = None
    async for _kind, _text, response in sender.stream(body):
        if response is not None:
            last = response
    latency_ms = int((clock() - started) * 1000)
    if last is None or not isinstance(last.text, str):
        raise ApiRequestError("LLM_PROVIDER_INVALID_RESPONSE", 502)
    return {
        "verdictText": last.text,
        "promptTokens": last.provider_usage.get("input_tokens"),
        "completionTokens": last.provider_usage.get("output_tokens"),
        "latencyMs": latency_ms,
    }


@router.post("/internal/v1/agent/judge/decide", dependencies=[Depends(verify_api_token)])
async def judge_decide(request: Request) -> JSONResponse:
    """One judge completion for one CP-assembled prompt (PLAN-0624 M1, D24-01 path A)."""
    request_id = request.headers.get("X-Request-Id", "")
    try:
        payload = JudgeDecideRequest(**(await request.json()))
    except ValueError as invalid:
        return problem_details(request_id, 400, "INVALID_REQUEST", str(invalid))
    if not payload.judge_credential_lease:
        return problem_details(
            request_id, 409, "PROVIDER_CREDENTIAL_LEASE_INVALID",
            "judgeCredentialLease is required; the credential never travels in the body",
        )
    try:
        from xihe_agent.app_state import config_client

        grant = await config_client.redeem_provider_lease(
            {"lease": payload.judge_credential_lease, "runId": None, "model": payload.model_name},
            request_id=request_id or None,
        )
        if grant.get("operation") != "chat":
            return problem_details(
                request_id, 400, "API_TYPE_OPERATION_MISMATCH",
                "the judge lease must be a chat-operation lease",
            )
        result = await _run_judge(grant, payload.model_name, payload.prompt, request_id)
    except ProviderLeaseError as exc:
        return problem_details(request_id, exc.status, exc.code, exc.code)
    except ApiRequestError as exc:
        return problem_details(request_id, exc.status or 502, "JUDGE_PROVIDER_FAILED", exc.code)
    return JSONResponse(
        status_code=200,
        headers={"X-Request-Id": request_id},
        content={"status": "ok", **result, "requestId": request_id},
    )
