"""`POST /internal/v1/agent/user-question/respond` — CP answer push for `ask_user`.

PLAN-0660 T5.12 (Agent half): CP's `UserQuestionAgentClient` delivers the user's answer to the run
blocked in `ask_user`. Contract (`docs/api/inventory.md`): 200 with ``status=accepted`` or
``status=already_delivered`` (idempotent replay); every non-2xx is fail-closed on the CP side (the
durable row stays ``pending`` and CP maps the delivery failure to
``502 AGENT_QUESTION_DELIVERY_FAILED``), so this route never reports success unless a resident
waiter accepted the answer.

Errors are returned as problem+json **directly** (same reason as the chat route's 413): the
app-level ``HTTPException`` handler rewrites every bare ``HTTPException`` into
``AGENT_REQUEST_FAILED`` and would erase the 400/404/409 vocabulary CP logs and maps.

The answer body is never logged — only the question id, the run id and the outcome.
"""

from uuid import uuid4

from fastapi import APIRouter, Depends, Request
from loguru import logger

from xihe_agent.api.shared import problem_details, verify_api_token
from xihe_agent.app_state import user_question_tool

router = APIRouter()


def _text(payload: dict, key: str) -> str:
    value = payload.get(key)
    return value if isinstance(value, str) else ""


@router.post("/internal/v1/agent/user-question/respond", dependencies=[Depends(verify_api_token)])
async def user_question_respond(request: Request):
    data = await request.json()
    payload = data if isinstance(data, dict) else {}
    question_id = _text(payload, "questionId")
    session_id = _text(payload, "sessionId")
    run_id = _text(payload, "runId")
    answer = _text(payload, "answer")

    status, _question = user_question_tool.resolve_answer(question_id, session_id, run_id, answer)
    if status in {"accepted", "already_delivered"}:
        logger.info(
            "User question answer delivered: id={} runId={} status={}",
            question_id,
            run_id,
            status,
        )
        return {"status": status}

    request_id = request.headers.get("X-Request-Id") or str(uuid4())
    if status == "invalid":
        logger.warning("User question answer rejected: id={} runId={} code=INVALID_REQUEST", question_id, run_id)
        return problem_details(request_id, 400, "INVALID_REQUEST", "User question answer is empty")
    if status == "conflict":
        logger.warning("User question answer rejected: id={} runId={} code=QUESTION_CONFLICT", question_id, run_id)
        return problem_details(
            request_id,
            409,
            "QUESTION_CONFLICT",
            "User question session or question id does not match the pending ask",
        )
    logger.warning("User question answer rejected: id={} runId={} code=QUESTION_NOT_FOUND", question_id, run_id)
    return problem_details(request_id, 404, "QUESTION_NOT_FOUND", "No pending user question for this run")
