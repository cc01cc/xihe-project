"""Real CP transport for the evaluation runner (PLAN-0511 M2 / T2.1).

Drives the CP public Chat API exactly as the UI does: create a session and
branch, hold an active SSE subscription for the session, create a ChatRun with a
task-derived Idempotency-Key, wait for the terminal state and read the PLAN-0509
trace. No prompt/response bodies are persisted; raw JSON is dumped only under the
caller-provided (git-ignored) raw directory for debugging.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

import httpx

from xihe_agent.evaluation.runner import RunTerminal
from xihe_agent.evaluation.trace import TraceResponse

_TERMINAL = {
    "completed",
    "failed",
    "partial",
    "cancelled",
    "interrupted",
    "succeeded",
    "error",
    "ambiguous",
}


def _norm_status(raw: Any) -> str:
    text = str(raw or "").lower()
    if text in {"succeeded", "success"}:
        return "completed"
    if text in {"error"}:
        return "failed"
    return text or "unknown"


class HttpCpClient:
    """`CpClient` implementation over the CP public HTTP/SSE API."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        provider: str | None = None,
        model: str | None = None,
        agent_principal_id: str | None = None,
        raw_dir: Path | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._provider = provider
        self._model = model
        self._agent_principal_id = agent_principal_id
        self._raw_dir = raw_dir
        self._timeout = timeout
        self._client = httpx.Client(
            base_url=self._base,
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout,
            trust_env=False,
        )
        self._sse_stop: dict[str, threading.Event] = {}
        self._branch_by_session: dict[str, str] = {}

    # -- auth -----------------------------------------------------------------

    @classmethod
    def login(cls, base_url: str, email: str, password: str, **kwargs: Any) -> HttpCpClient:
        with httpx.Client(base_url=base_url.rstrip("/"), timeout=kwargs.get("timeout", 30.0), trust_env=False) as c:
            resp = c.post("/api/v1/auth/login", json={"identifier": email, "password": password})
            resp.raise_for_status()
            token = resp.json()["accessToken"]
        return cls(base_url, token, **kwargs)

    # -- session / branch -----------------------------------------------------

    def create_session(self, title: str = "eval") -> str:
        body: dict[str, Any] = {"title": title}
        if self._agent_principal_id:
            body["agentPrincipalId"] = self._agent_principal_id
        # CP resolves modelProvider/modelName against a verified provider Connection
        # (the legacy provider/model pair is accepted by the session API but later
        # rejects chat with API_TYPE_REBIND_REQUIRED; PLAN-0532 M1 finding).
        if self._provider:
            body["modelProvider"] = self._provider
        if self._model:
            body["modelName"] = self._model
        resp = self._client.post("/api/v1/sessions", json=body)
        resp.raise_for_status()
        data = resp.json()
        self._dump("session", data)
        return str(data.get("id") or data.get("sessionId"))

    def create_branch(self, session_id: str) -> str:
        """Return the session's root branch (CP creates it with the session)."""
        resp = self._client.get(f"/api/v1/sessions/{session_id}/branches")
        if resp.status_code == 200:
            data = resp.json() or {}
            items = data.get("items") or []
            if items:
                branch_id = str(items[0].get("branchId"))
                self._branch_by_session[session_id] = branch_id
                return branch_id
        resp = self._client.post(f"/api/v1/sessions/{session_id}/branches", json={})
        resp.raise_for_status()
        data = resp.json()
        self._dump("branch", data)
        branch_id = str(data.get("id") or data.get("branchId"))
        self._branch_by_session[session_id] = branch_id
        return branch_id

    # -- SSE subscription -----------------------------------------------------

    def subscribe(self, session_id: str) -> None:
        """Open and hold the SSE subscription CP requires before a ChatRun."""
        stop = threading.Event()
        self._sse_stop[session_id] = stop
        thread = threading.Thread(target=self._sse_loop, args=(session_id, stop), daemon=True)
        thread.start()
        # Give the emitter a moment to register; CP rejects POST /chat without it.
        time.sleep(0.8)

    def _sse_loop(self, session_id: str, stop: threading.Event) -> None:
        try:
            with httpx.stream(
                "GET",
                f"{self._base}/api/v1/events",
                params={"sessionId": session_id},
                headers={"Authorization": self._client.headers["Authorization"]},
                timeout=httpx.Timeout(None),
                trust_env=False,
            ) as resp:
                for _line in resp.iter_lines():
                    if stop.is_set():
                        break
        except (httpx.HTTPError, OSError):
            return

    def close(self) -> None:
        for stop in self._sse_stop.values():
            stop.set()
        self._client.close()

    # -- run ------------------------------------------------------------------

    def create_run(
        self,
        *,
        session_id: str,
        branch_id: str,
        content: str,
        provider: str | None,
        model: str | None,
        tool_mode: str,
        idempotency_key: str,
    ) -> str:
        # CP rejects POST /chat without an active SSE emitter for the session.
        self.subscribe(session_id)
        body: dict[str, Any] = {
            "sessionId": session_id,
            "branchId": branch_id,
            "content": content,
            "toolMode": tool_mode,
        }
        if provider:
            body["provider"] = provider
        if model:
            body["model"] = model
        resp = self._client.post(
            "/api/v1/chat", json=body, headers={"Idempotency-Key": idempotency_key}
        )
        if resp.status_code >= 400:
            self._dump(f"run-error-{session_id}", resp.text)
        resp.raise_for_status()
        data = resp.json()
        return str(data["runId"])

    def wait_terminal(self, run_id: str, timeout_s: float) -> RunTerminal:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            resp = self._client.get(f"/api/v1/chat/runs/{run_id}")
            if resp.status_code == 200:
                data = resp.json()
                self._dump(f"run-{run_id}", data)
                status = _norm_status(data.get("status"))
                if status in _TERMINAL:
                    return RunTerminal(
                        status=status,
                        error_code=data.get("errorCode") or data.get("code"),
                        duration_ms=data.get("durationMs"),
                    )
            time.sleep(1.0)
        return RunTerminal(status="timeout", error_code="EVAL_TIMEOUT")

    def get_trace(self, run_id: str) -> TraceResponse:
        resp = self._client.get(f"/api/v1/chat/runs/{run_id}/trace")
        resp.raise_for_status()
        data = resp.json()
        self._dump(f"trace-{run_id}", data)
        return TraceResponse.model_validate(data)

    def read_final_output(self, session_id: str, run_id: str) -> str | None:
        branch_id = self._branch_by_session.get(session_id, "")
        resp = self._client.get(
            f"/api/v1/sessions/{session_id}/messages", params={"branchId": branch_id}
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        self._dump(f"messages-{session_id}", data)
        rows = data.get("messages") if isinstance(data, dict) else data
        if not isinstance(rows, list):
            return None
        for row in reversed(rows):
            if not isinstance(row, dict):
                continue
            if str(row.get("role", "")).lower() == "assistant" and row.get("content"):
                return str(row["content"])
        return None

    def _dump(self, name: str, payload: Any) -> None:
        if self._raw_dir is None:
            return
        self._raw_dir.mkdir(parents=True, exist_ok=True)
        text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, indent=2)
        (self._raw_dir / f"{name}.json").write_text(text, encoding="utf-8")
