"""Shared API route dependencies and response helpers.

Moved verbatim from `main.py` (PLAN-0473 T2.2): the Bearer token dependency
and the RFC 9457 problem+json response builder used by the summarize route.
"""

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from loguru import logger

from xihe_agent.app_state import CP_API_TOKEN


def verify_api_token(request: Request) -> None:
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.removeprefix("Bearer ") if auth_header.startswith("Bearer ") else None
    if token != CP_API_TOKEN:
        logger.warning("Agent API token mismatch")
        raise HTTPException(status_code=403, detail="Forbidden: invalid API token")


def problem_details(
    request_id: str,
    status_code: int,
    code: str,
    detail: str,
    retryable: bool = False,
) -> JSONResponse:
    """RFC 9457 problem+json used by the summarize endpoint (spec §8)."""
    return JSONResponse(
        status_code=status_code,
        media_type="application/problem+json",
        headers={"X-Request-Id": request_id},
        content={
            "type": f"https://xihe.dev/problems/{code.lower()}",
            "title": code,
            "status": status_code,
            "code": code,
            "detail": detail,
            "retryable": retryable,
            "requestId": request_id,
        },
    )
