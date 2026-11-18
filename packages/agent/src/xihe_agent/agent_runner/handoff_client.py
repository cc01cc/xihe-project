"""Transport for the two hand-off faces (see :mod:`xihe_agent.adapters.handoff_tools`).

Two CP internal calls, both run-scoped (the run in the path IS the actor — session, workspace, owner
and responder principal all come off the chat_runs row):

* ``GET  /internal/v1/chat/runs/{runId}/participants`` — the roster the model may read names from;
* ``POST /internal/v1/chat/runs/{runId}/to`` — TO by display name.

Deliberate details:

* ``trust_env=False`` (PLAN-0539): an internal CP hop must never read env proxies; a malformed
  NO_PROXY once aborted client construction.
* A name the roster does not know comes back as a 422 whose detail carries
  ``reason=mention_unresolved``. That is the platform's existing word for "this name resolved to
  nobody" and this client passes it through instead of inventing its own vocabulary.
* The idempotency key is derived from (runId, target, instruction): retrying the SAME call is a
  replay, changing the target or the text is a new submission — same rule the composer uses
  ("换受众就是换一次提交").

Gray release: no ``XIHE_CP_URL`` ⇒ the builder returns ``None`` and the tools answer
``HANDOFF_CLIENT_UNAVAILABLE``; a run without ``runId`` is equally un-wired (this face is run-scoped by
construction, so there is no meaningful fallback).
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Mapping
from typing import Any

import httpx
from loguru import logger

from xihe_agent.adapters.handoff_tools import (
    TOOL_DISPATCH,
    TOOL_LIST_PARTICIPANTS,
)

CODE_INPUT_REQUIRED = "HANDOFF_INPUT_REQUIRED"
CODE_TRANSPORT = "HANDOFF_TRANSPORT_ERROR"
CODE_PROTOCOL = "HANDOFF_PROTOCOL_ERROR"


class HandoffClientError(RuntimeError):
    """A CP refusal (or a client-side protocol violation) carrying a code."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


def resolve_cp_base_url(environ: Mapping[str, str] | None = None) -> str | None:
    """The gray-release gate: wired only when CP is explicitly configured."""
    env = os.environ if environ is None else environ
    raw = (env.get("XIHE_CP_URL") or "").strip()
    if not raw:
        return None
    return raw.rstrip("/")


def _resolve_api_token() -> str | None:
    """服务鉴权令牌的单属主是 app_state（懒加载避免模块导入环与测试副作用）。"""
    from xihe_agent.app_state import CP_API_TOKEN

    return CP_API_TOKEN


def _idempotency_key(run_id: str, target: str, instruction: str) -> str:
    digest = hashlib.sha256(f"{target}\n{instruction}".encode()).hexdigest()[:16]
    return f"{run_id}:to:{digest}"


def _problem(resp: httpx.Response) -> tuple[str, str]:
    """(code, detail) from an RFC 9457 body, without leaking anything else."""
    try:
        body = resp.json()
    except Exception:
        return f"HANDOFF_HTTP_{resp.status_code}", ""
    if not isinstance(body, Mapping):
        return f"HANDOFF_HTTP_{resp.status_code}", ""
    code = body.get("code")
    detail = body.get("detail")
    return (
        code if isinstance(code, str) and code else f"HANDOFF_HTTP_{resp.status_code}",
        detail if isinstance(detail, str) else "",
    )


def build_handoff_client(
    context: Any,
    *,
    environ: Mapping[str, str] | None = None,
    api_token: str | None = None,
) -> Any | None:
    """Build the run-scoped callable, or ``None`` to stay un-wired."""
    base = resolve_cp_base_url(environ)
    if base is None:
        return None
    metadata = getattr(context, "metadata", None)
    if not isinstance(metadata, Mapping):
        return None
    raw_run = metadata.get("runId")
    if not raw_run:
        return None
    run_id = str(raw_run)
    if api_token is None:
        api_token = _resolve_api_token()

    async def client(tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {api_token}"}
        run_url = f"{base}/internal/v1/chat/runs/{run_id}"
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=30) as http:
                if tool == TOOL_LIST_PARTICIPANTS:
                    resp = await http.get(f"{run_url}/participants", headers=headers)
                    if resp.status_code != 200:
                        code, detail = _problem(resp)
                        raise HandoffClientError(code, detail)
                    body = resp.json()
                    peers = body.get("participants") if isinstance(body, Mapping) else None
                    if not isinstance(peers, list):
                        raise HandoffClientError(CODE_PROTOCOL, "participants is not an array")
                    return {
                        "status": "ok",
                        "participants": [
                            {
                                "display_name": peer.get("displayName"),
                                "kind": peer.get("principalKind"),
                                "role": peer.get("role"),
                                "disabled": bool(peer.get("disabled")),
                            }
                            for peer in peers
                            if isinstance(peer, Mapping)
                        ],
                    }

                if tool == TOOL_DISPATCH:
                    target = str(arguments.get("target_display_name") or "").strip()
                    instruction = str(arguments.get("instruction") or "").strip()
                    if not target or not instruction:
                        raise HandoffClientError(
                            CODE_INPUT_REQUIRED,
                            "target_display_name and instruction are both required",
                        )
                    resp = await http.post(
                        f"{run_url}/to",
                        headers={**headers, "Idempotency-Key": _idempotency_key(run_id, target, instruction)},
                        json={
                            "content": instruction,
                            "toDisplayNames": [target],
                            "ccDisplayNames": [],
                        },
                    )
                    if resp.status_code == 200:
                        return _dispatch_success(target, resp.json())
                    code, detail = _problem(resp)
                    # 名字没解析是「可以改口重试」的失败，不是传输故障：把既有词与提示一起交回模型。
                    if "mention_unresolved" in detail:
                        return {
                            "status": "refused",
                            "reason": "mention_unresolved",
                            "target": target,
                            "detail": detail,
                            "hint": (
                                "That display name resolved to nobody in this conversation. "
                                f"Call {TOOL_LIST_PARTICIPANTS} and use a name from that list; "
                                "do not guess."
                            ),
                        }
                    raise HandoffClientError(code, detail)

                raise HandoffClientError(CODE_PROTOCOL, f"unknown hand-off tool: {tool}")
        except HandoffClientError:
            raise
        except Exception as exc:  # transport: reported, never silently swallowed
            logger.warning(
                "[LIFECYCLE] service=agent event=handoff_transport_error tool={} errorType={}",
                tool,
                type(exc).__name__,
            )
            raise HandoffClientError(CODE_TRANSPORT, type(exc).__name__) from None

    return client


def _dispatch_success(target: str, body: Any) -> dict[str, Any]:
    """A legible success: what happened to the one target, and whether a line was announced."""
    to = body.get("to") if isinstance(body, Mapping) else None
    run_ids = to.get("runIds") if isinstance(to, Mapping) else None
    dispatched = len(run_ids) if isinstance(run_ids, list) else 0
    announced = isinstance(body, Mapping) and body.get("messageId") is not None
    return {
        "status": "ok" if dispatched else "not_dispatched",
        "target": target,
        "dispatched_runs": dispatched,
        "announced": announced,
        "message": (
            f"{target} was woken: their agent now owns a run of its own and will answer in this "
            "conversation. You do not need to wait for it."
            if dispatched
            else (
                f"{target} was named but no run was started (muted, judged no, refused or failed). "
                "The platform recorded why; do not retry blindly."
            )
        ),
    }
