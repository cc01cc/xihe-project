"""PLAN-0660 T5.12 (Agent half): the CP answer-push route for `ask_user`.

Contract (`docs/api/inventory.md`): ``200 {status: accepted|already_delivered}``; a non-2xx is
fail-closed on the CP side (durable row stays ``pending``), so the route must never answer 200
unless a resident waiter accepted the answer. Error bodies are problem+json returned directly by
the route (the app-level ``HTTPException`` handler would rewrite bare exceptions to
``AGENT_REQUEST_FAILED`` and erase the 400/404/409 vocabulary).
"""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from xihe_agent.adapters.user_question_tool import PendingQuestion
from xihe_agent.app_state import user_question_tool
from xihe_agent.main import app
from xihe_agent.service_token import resolve_service_token

ROUTE = "/internal/v1/agent/user-question/respond"


@pytest.fixture(autouse=True)
def clean_waiter() -> Iterator[None]:
    """The route resolves the process-wide coordinator; leave no waiter or replay entry behind."""
    coordinator = user_question_tool.coordinator
    coordinator.pending_by_run.clear()
    coordinator.question_runs.clear()
    coordinator.delivered_at.clear()
    yield
    coordinator.pending_by_run.clear()
    coordinator.question_runs.clear()
    coordinator.delivered_at.clear()


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {resolve_service_token()}"}


def _wait(run_id: str = "run-1", session_id: str = "session-1", question_id: str = "q-1") -> None:
    user_question_tool.coordinator.pending_by_run[run_id] = PendingQuestion(
        local_id=question_id,
        run_id=run_id,
        session_id=session_id,
        payload={"question": "Which environment?"},
    )


def _body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "questionId": "q-1",
        "sessionId": "session-1",
        "runId": "run-1",
        "answer": "staging",
    }
    body.update(overrides)
    return body


def _post(body: dict[str, Any], headers: dict[str, str] | None = None):
    # No `with TestClient(app)`: that runs the lifespan (real CP config sync), which unit tests
    # deliberately skip — the route itself needs no startup state.
    return TestClient(app).post(ROUTE, json=body, headers=_headers() if headers is None else headers)


def test_respond_accepts_the_pending_ask() -> None:
    _wait()

    response = _post(_body())

    assert response.status_code == 200
    assert response.json() == {"status": "accepted"}
    pending = user_question_tool.coordinator.pending_by_run["run-1"]
    assert pending.answer == "staging"
    assert pending.answered_question_id == "q-1"
    assert pending.event.is_set()


def test_respond_replay_is_idempotent() -> None:
    _wait()
    first = _post(_body())
    replay = _post(_body())

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json() == {"status": "already_delivered"}


def test_respond_rejects_empty_answer_with_400() -> None:
    _wait()

    response = _post(_body(answer="   "))

    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_REQUEST"
    assert not user_question_tool.coordinator.pending_by_run["run-1"].event.is_set()


def test_respond_unknown_run_is_404() -> None:
    response = _post(_body(runId="run-ghost", questionId="q-ghost"))

    assert response.status_code == 404
    assert response.json()["code"] == "QUESTION_NOT_FOUND"


def test_respond_session_mismatch_is_409() -> None:
    _wait(session_id="session-1")

    response = _post(_body(sessionId="session-2"))

    assert response.status_code == 409
    assert response.json()["code"] == "QUESTION_CONFLICT"


def test_respond_different_question_after_accept_is_409() -> None:
    _wait()
    assert _post(_body()).status_code == 200

    response = _post(_body(questionId="q-2", answer="other"))

    assert response.status_code == 409
    assert response.json()["code"] == "QUESTION_CONFLICT"


def test_respond_requires_the_service_token() -> None:
    _wait()

    response = _post(_body(), headers={})

    assert response.status_code == 403
