"""PLAN-0660 M5-C (T5.14/T5.15): the ``ask_user`` tool — Agent asks its human a question.

Symmetric to :mod:`xihe_agent.adapters.approval_tool`, deliberately without sharing its
waiter or branching on "is this an approval?":

* same wait primitive (``asyncio.Event``) and the same run-scoped pause boundary — the runner
  binds one shared human-wait queue, so a blocked question pauses the elapsed budget clock
  exactly like a blocked approval;
* a **separate** tool name (``ask_user``), a **separate** event type (``session_question_asked``) and a
  separate coordinator — approval and question waiters never resolve each other.

Wire shape (CP relay consumer, ``ChatController.relayUserQuestion``): the published payload
carries only ``question`` and, for a timed ask, ``expiresAt``; ``askedByParticipantId`` is
optional. The question body never enters a log line — only its length does.

T5.16 (root-run gate / error mapping): only a **root run** may ask. CP refuses a child run's
question with ``409 SUBAGENT_QUESTION_REFUSED`` (``UserQuestionService.recordPending`` — the
``chat_runs.parent_run_id`` gate). The tool must never wait out an hour-long ceiling for that
refusal: when the delivery path surfaces a refusal — an explicit
:class:`UserQuestionRefusedError`, an exception carrying a string ``code``, or an
``httpx.HTTPStatusError``-shaped 409 whose problem body has a ``code`` — the waiter is dropped
and the model gets a readable ``status=error`` result with the CP code. It is never
``no_answer`` and never a fabricated success. Unknown delivery failures still raise: a refusal
is a decision, a transport bug is a bug.

G3-a「checkpoint_safe_schema」(task-208 acceptance draft): every return path of this tool —
answered / no_answer / refused (子会话门, QUESTION_ALREADY_PENDING, CP 409 codes) / error
(INVALID_QUESTION, INVALID_TIMEOUT) — now produces the ask-user-envelope.v1 JSON envelope
as its result content, and the ToolSpec carries a CheckpointSafeToolSchema so a waiting
run's checkpoints persist instead of tripping the checkpoint-saver unsafe latch (draft §0-3).

Privacy registration (draft §0-2 / 判据 4, 登记不隐瞒): the checkpoint *input* projection of a
pending AI tool call necessarily contains the question body verbatim — the projection
mechanism (interfaces/tool.py) copies declared fields losslessly, and the body is already
durable in CP's user_questions.prompt (same DB trust domain, V128). The correct boundary is
the *output* envelope: it carries only questionId + status + answer + code — never the
question body — and the body never leaves the DB trust domain.

Resume 认领 (draft A2, 判据 5/6 agent 腿): when the run metadata carries a
_user_question_resume_lookup callable, a (replayed) ask first looks up the CP durable
waiting row by runId — answered → answered envelope without re-asking; pending → re-arm
the local wait WITHOUT re-publishing (the user must never see a second question); expired /
cancelled → no_answer envelope. The callable is the agent-side client shape for the CP C4
read-only endpoint (cp lane, 后做); until CP ships it nothing registers the key and behavior
is exactly today's fresh ask.
"""

import asyncio
import json
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from loguru import logger

from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import BaseAgentTool, CheckpointSafeToolSchema, ToolSpec

USER_QUESTION_EVENT_SINK_KEY = "_user_question_event_sink"
UserQuestionEventSink = Callable[[dict[str, Any]], Awaitable[None]]
# CP dispatch marks a spawned run with its parent's run id (PLAN-0660 T5.16, LD-16=A). Absent or
# blank means a root run — the pre-T5.16 CP never sends this key, so the read stays additive.
PARENT_RUN_ID_KEY = "parentRunId"

# CP's writer rule (UserQuestionService.MAX_PROMPT_LENGTH) mirrored at the tool edge so an
# oversize prompt is a model-readable validation error instead of a refused relay.
MAX_QUESTION_LENGTH = 2000
# Fail-closed local ceiling: a plain ``ask`` has no CP deadline (expires_at NULL owns the
# semantics), so an unbounded wait must still end. Same order as the approval external wait.
DEFAULT_WAIT_CEILING_S = 3600.0
# ``timeoutSeconds`` is clamped to this ceiling (a bogus far-future value cannot pin a run).
MAX_TIMEOUT_SECONDS = 3600.0
# How long a delivered question id stays queryable for idempotent replays (T5.16 route).
COMPLETED_RETENTION_S = 3600.0

STATUS_ANSWERED = "answered"
STATUS_NO_ANSWER = "no_answer"
STATUS_REFUSED = "refused"
STATUS_ERROR = "error"

# CP durable-row states (V128 CHECK constraint) used by the resume lookup (G3-a A2).
STATE_PENDING = "pending"
STATE_EXPIRED = "expired"
STATE_CANCELLED = "cancelled"

# ---------------------------------------------------------------------------
# G3-a checkpoint-safe envelope (task-208 acceptance draft 判据 1/3/4)
# ---------------------------------------------------------------------------

ASK_USER_ENVELOPE_VERSION = "ask-user-envelope.v1"

# G3-a 判据 3 note — the draft baseline suggests maxLength 2000 for the checkpoint
# input schema, but 判据 2/3 force a wider bound: the checkpointed *pending AI
# message* carries the model's raw args, and a question of 2001..N chars is a live
# arg that execute() maps to an INVALID_QUESTION *envelope* — if the schema bound
# were 2000, the adapter's dispatch-time project_input would reject it first and the
# run would die (or latch) instead of producing the envelope. The semantic bound
# (MAX_QUESTION_LENGTH) stays in execute(); this bound only caps the checkpoint
# payload. 65536 is the validator ceiling (interfaces/tool.py).
CHECKPOINT_SAFE_QUESTION_INPUT_MAX_LENGTH = 65536

# G3-a 判据 3 note — no minimum/maximum on timeoutSeconds on purpose: _resolve_timeout
# validates ("must be positive") and clamps (> MAX_TIMEOUT_SECONDS) live values, and
# both outcomes must stay reachable as envelopes rather than becoming dispatch-time
# projection failures. The number projection already rejects non-finite values.
ASK_USER_CHECKPOINT_SAFE_SCHEMA = CheckpointSafeToolSchema(
    version=ASK_USER_ENVELOPE_VERSION,
    input_schema={
        "type": "object",
        "properties": {
            "question": {"type": "string", "maxLength": CHECKPOINT_SAFE_QUESTION_INPUT_MAX_LENGTH},
            "timeoutSeconds": {"type": "number"},
        },
        "required": ["question"],
        "additionalProperties": False,
    },
    output_schema={
        "type": "object",
        "properties": {
            "questionId": {"type": "string", "maxLength": 64},
            "status": {
                "type": "string",
                "enum": [STATUS_ANSWERED, STATUS_NO_ANSWER, STATUS_REFUSED, STATUS_ERROR],
            },
            # CP caps durable answers at MAX_ANSWER_LENGTH = 2000
            # (UserQuestionService); 4096 leaves headroom without unbounding the
            # payload. Only meaningful for status=answered; "" otherwise.
            "answer": {"type": "string", "maxLength": 4096},
            # CP problem code (e.g. SUBAGENT_QUESTION_REFUSED); "" unless
            # status=refused/error.
            "code": {"type": "string", "maxLength": 64},
        },
        "required": ["questionId", "status"],
        "additionalProperties": False,
    },
)

# Agent-side client shape for the CP C4 read-only endpoint (draft §2-C4, implemented
# by the cp lane): given a runId, return the durable waiting row, or None when the
# run has none:
#   {"questionId": str, "state": "pending"|"answered"|"expired"|"cancelled",
#    "answer": str | None, "expiresAt": str | None}   # ISO-8601, timed rows only
# The lookup must not carry the question body — the read face follows the existing
# addressee/session visibility rules and never discloses the prompt (C4 contract).
USER_QUESTION_RESUME_LOOKUP_KEY = "_user_question_resume_lookup"
UserQuestionResumeLookup = Callable[[str], Awaitable[dict[str, Any] | None]]

REASON_TIMEOUT = "timeout"
REASON_LOCAL_CEILING = "local_ceiling"

NO_ANSWER_CONTENT = (
    "No answer before the deadline (no_answer). Continue without an answer; "
    "do not invent or assume one."
)

# CP's refusal code for a child run's ask (PLAN-0660 T5.16; the gate lives in
# UserQuestionService.recordPending). The tool maps it to a model-readable error result so a
# spawned run hands the question back instead of blocking on an answer that cannot arrive.
CODE_SUBAGENT_QUESTION_REFUSED = "SUBAGENT_QUESTION_REFUSED"
SUBAGENT_QUESTION_REFUSED_CONTENT = (
    "Only a root run may ask the user a question; this run was spawned by a parent run. "
    "A child run cannot open the human channel — pass the question back to the parent run and "
    "let it ask on your behalf."
)


class UserQuestionRefusedError(Exception):
    """CP refused the question (a problem ``code`` such as ``SUBAGENT_QUESTION_REFUSED``).

    Explicit carrier for :func:`_refused_code`: whoever learns CP said no (today the tests, and
    any future relay-refusal channel) raises this so :meth:`UserQuestionCoordinator.ask` turns
    the refusal into a readable result instead of waiting for an answer that never comes.
    """

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class PendingQuestion:
    """One blocked ask_user wait, keyed by the run that asked it."""

    local_id: str
    run_id: str
    session_id: str
    payload: dict[str, Any]
    event: asyncio.Event = field(default_factory=asyncio.Event)
    answer: str | None = None
    answered_question_id: str | None = None
    asked_at: datetime = field(default_factory=lambda: datetime.now(UTC))


class UserQuestionCoordinator:
    """Coordinates one pending question per run and resolves it from the CP answer push."""

    def __init__(self, wait_ceiling_seconds: float | None = None) -> None:
        self.wait_ceiling_seconds = (
            wait_ceiling_seconds if wait_ceiling_seconds is not None else DEFAULT_WAIT_CEILING_S
        )
        # One pending human interaction per run is a CP invariant; the Agent keeps the same
        # shape locally so a second ask fails closed before publishing anything.
        self.pending_by_run: dict[str, PendingQuestion] = {}
        # Replay/idempotency tables for the T5.16 respond route: questionId → run, run → qid.
        self.question_runs: dict[str, str] = {}
        self.delivered_at: dict[str, datetime] = {}

    # -- ask -----------------------------------------------------------------
    async def ask(
        self,
        question: str,
        timeout_seconds: Any,
        context: AgentContext,
        event_sink: UserQuestionEventSink | None,
    ) -> dict[str, Any]:
        metadata = context.metadata
        run_id = str(metadata.get("runId") or context.aggregate_id)
        session_id = str(metadata.get("sessionId", context.aggregate_id))
        # PLAN-0660 T5.16 (LD-16=A): CP already told the Agent that this run was spawned, so the
        # refusal happens at the door — nothing is published and nothing waits. That keeps the CP
        # side clean (no ``session_question_asked`` event without a question row) and turns a
        # one-hour wait into a model-readable error.
        parent_run_id = metadata.get(PARENT_RUN_ID_KEY)
        if isinstance(parent_run_id, str) and parent_run_id.strip():
            logger.warning(
                "User question refused before delivery: runId={} parentRunId={} code={}",
                run_id,
                parent_run_id,
                CODE_SUBAGENT_QUESTION_REFUSED,
            )
            return _refusal_result(CODE_SUBAGENT_QUESTION_REFUSED)
        self._purge_completed()
        if run_id in self.pending_by_run:
            logger.warning("User question refused: a question is already pending for runId={}", run_id)
            return _refusal_result(
                "QUESTION_ALREADY_PENDING",
                message="A question is already pending for this run; wait for its answer first.",
            )
        # G3-a resume 认领: on replay after a restart the CP durable waiting row
        # (keyed by runId, CP C4 read-only endpoint via the registered lookup)
        # decides the outcome BEFORE anything new is published — answered rows are
        # consumed directly, pending rows re-arm the wait, expired/cancelled rows
        # collapse to no_answer. Without a registered lookup this is a no-op.
        resume_lookup = metadata.get(USER_QUESTION_RESUME_LOOKUP_KEY)
        if callable(resume_lookup):
            row = await self._resume_row(resume_lookup, run_id)
            if row is not None:
                resumed = await self._ask_from_resume_row(row, run_id, session_id)
                if resumed is not None:
                    return resumed
        wait_timeout, expires_at, timeout_error = self._resolve_timeout(timeout_seconds)
        if timeout_error is not None:
            return _error_result("INVALID_TIMEOUT", timeout_error)
        if event_sink is None:
            logger.error("User question event sink is unavailable: runId={}", run_id)
            raise RuntimeError("User question could not be delivered")

        local_id = str(uuid4())
        payload: dict[str, Any] = {"question": question}
        if expires_at is not None:
            payload["expiresAt"] = expires_at.isoformat().replace("+00:00", "Z")
        asked_by = metadata.get("askedByParticipantId")
        if isinstance(asked_by, str) and asked_by:
            payload["askedByParticipantId"] = asked_by

        pending = PendingQuestion(
            local_id=local_id, run_id=run_id, session_id=session_id, payload=payload
        )
        self.pending_by_run[run_id] = pending
        logger.info(
            "User question asked: id={} runId={} length={} timed={}",
            local_id,
            run_id,
            len(question),
            expires_at is not None,
        )
        try:
            await event_sink(payload)
            await asyncio.wait_for(pending.event.wait(), timeout=wait_timeout)
        except TimeoutError:
            self.pending_by_run.pop(run_id, None)
            reason = REASON_TIMEOUT if expires_at is not None else REASON_LOCAL_CEILING
            logger.warning(
                "User question wait ended without an answer: id={} runId={} reason={}",
                local_id,
                run_id,
                reason,
            )
            return _envelope_result(
                _ask_user_envelope(question_id=local_id, status=STATUS_NO_ANSWER),
                reason=reason,
            )
        except asyncio.CancelledError:
            # A cancelled run must not leave a waiter the answer route could still resolve.
            self.pending_by_run.pop(run_id, None)
            logger.warning("User question wait cancelled: id={} runId={}", local_id, run_id)
            raise
        except Exception as exc:
            self.pending_by_run.pop(run_id, None)
            refused_code = _refused_code(exc)
            if refused_code is not None:
                logger.warning(
                    "User question refused: id={} runId={} code={}",
                    local_id,
                    run_id,
                    refused_code,
                )
                return _refusal_result(refused_code, question_id=local_id)
            logger.warning("User question wait failed: id={} runId={}", local_id, run_id, exc_info=True)
            raise

        answer = pending.answer
        self.pending_by_run.pop(run_id, None)
        if answer is None:
            # The event was set without an answer: never fabricate one.
            return _envelope_result(
                _ask_user_envelope(question_id=local_id, status=STATUS_NO_ANSWER),
                reason=REASON_LOCAL_CEILING,
            )
        return _envelope_result(
            _ask_user_envelope(
                # The CP-owned questionId learned from the answer push is the
                # durable identity; the local id is the fallback for paths that
                # never reached CP.
                question_id=pending.answered_question_id or local_id,
                status=STATUS_ANSWERED,
                answer=answer,
            )
        )

    # -- resolve (CP → Agent answer push, T5.16 route) -----------------------
    def resolve(
        self, question_id: str, session_id: str, run_id: str, answer: str
    ) -> tuple[str, dict[str, Any] | None]:
        """Resolve the pending wait for ``run_id``.

        Matching is by **run**: the CP answer push carries the CP-owned ``questionId``, which the
        Agent first learns at delivery time (the relay payload has no id). The questionId is kept
        for idempotent replays and for the route's 404/409 vocabulary, never used to guess a
        waiter the Agent has not seen.
        """
        self._purge_completed()
        pending = self.pending_by_run.get(run_id)
        if pending is not None:
            if session_id and pending.session_id and session_id != pending.session_id:
                return "conflict", None
            if pending.answered_question_id is not None:
                if pending.answered_question_id == question_id:
                    return "already_delivered", pending.payload
                return "conflict", None
            if answer is None or not answer.strip():
                return "invalid", None
            pending.answer = answer
            pending.answered_question_id = question_id
            self.question_runs[question_id] = run_id
            self.delivered_at[question_id] = datetime.now(UTC)
            pending.event.set()
            return "accepted", pending.payload

        known_run = self.question_runs.get(question_id)
        if known_run is not None:
            return ("already_delivered", None) if known_run == run_id else ("conflict", None)
        return "not_found", None

    def get_pending(self) -> list[dict[str, Any]]:
        return [pending.payload for pending in self.pending_by_run.values()]

    # -- helpers -------------------------------------------------------------
    def _resolve_timeout(
        self, timeout_seconds: Any
    ) -> tuple[float, datetime | None, str | None]:
        """Return ``(local wait, CP expiresAt (timed only), error)``.

        Absent/None = plain blocking ``ask`` (CP row has expires_at NULL; the Agent owns the
        deadline) → no ``expiresAt`` on the wire, local wait = ceiling.
        """
        if timeout_seconds is None:
            return self.wait_ceiling_seconds, None, None
        if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)):
            return 0.0, None, "timeoutSeconds must be a number of seconds"
        value = float(timeout_seconds)
        if not math.isfinite(value) or value <= 0:
            return 0.0, None, "timeoutSeconds must be a positive, finite number"
        clamped = min(value, MAX_TIMEOUT_SECONDS)
        if clamped != value:
            logger.warning(
                "User question timeout clamped to local ceiling: requested={} clamped={}",
                value,
                clamped,
            )
        return clamped, datetime.now(UTC) + timedelta(seconds=clamped), None

    def _purge_completed(self) -> None:
        cutoff = datetime.now(UTC) - timedelta(seconds=COMPLETED_RETENTION_S)
        for question_id, delivered_at in list(self.delivered_at.items()):
            if delivered_at < cutoff:
                self.delivered_at.pop(question_id, None)
                self.question_runs.pop(question_id, None)

    # -- resume 认领 (G3-a A2: replay after restart claims the CP durable row) ----
    async def _resume_row(
        self, lookup: UserQuestionResumeLookup, run_id: str
    ) -> dict[str, Any] | None:
        """Call the C4 resume lookup, mapping every failure to "no row".

        A failed lookup must never block the run: falling through to a fresh ask is
        fail-closed because CP's uq_user_questions_run_pending unique constraint
        refuses a duplicate pending row — the degradation is a refused envelope, not
        a second durable question.
        """
        try:
            row = await lookup(run_id)
        except Exception:
            logger.warning(
                "User question resume lookup failed; falling back to a fresh ask: runId={}",
                run_id,
                exc_info=True,
            )
            return None
        if not isinstance(row, dict) or not isinstance(row.get("questionId"), str) or not row["questionId"]:
            return None
        return row

    async def _ask_from_resume_row(
        self, row: dict[str, Any], run_id: str, session_id: str
    ) -> dict[str, Any] | None:
        """Map one CP durable waiting row (looked up by runId) to a tool result.

        Returns None for unrecognized states so the caller falls through to a fresh
        ask; every recognized state settles the wait WITHOUT publishing anything.
        """
        question_id = row["questionId"]
        state = row.get("state")
        if state == STATUS_ANSWERED:
            answer = row.get("answer")
            if not isinstance(answer, str) or not answer.strip():
                # A durable row without a usable answer never fabricates one.
                return _envelope_result(
                    _ask_user_envelope(question_id=question_id, status=STATUS_NO_ANSWER),
                    reason="resume_answer_missing",
                )
            self.question_runs[question_id] = run_id
            self.delivered_at[question_id] = datetime.now(UTC)
            return _envelope_result(
                _ask_user_envelope(
                    question_id=question_id, status=STATUS_ANSWERED, answer=answer
                )
            )
        if state in (STATE_EXPIRED, STATE_CANCELLED):
            return _envelope_result(
                _ask_user_envelope(question_id=question_id, status=STATUS_NO_ANSWER),
                reason=f"resume_{state}",
            )
        if state == STATE_PENDING:
            return await self._rearm_pending_question(row, run_id, session_id)
        logger.warning(
            "User question resume row has an unrecognized state: runId={} state={}",
            run_id,
            state,
        )
        return None

    async def _rearm_pending_question(
        self, row: dict[str, Any], run_id: str, session_id: str
    ) -> dict[str, Any]:
        """Re-arm the local wait for a CP row that is still pending.

        The question is deliberately NOT re-published: the user already sees the
        durable row (draft 判据 6 — a restarted run must never show a second
        question). The waiter keeps the ordinary runId keying; the answer push
        resolves it exactly like a fresh wait.

        L-8 (draft §4, conservative choice recorded): a timed row waits out only its
        REMAINING durable window and is never extended by the restart; a row without
        a usable expiresAt falls back to the local fail-closed ceiling.
        """
        question_id = row["questionId"]
        wait_timeout = self.wait_ceiling_seconds
        expires_at: datetime | None = None
        raw_expires = row.get("expiresAt")
        if isinstance(raw_expires, str) and raw_expires:
            try:
                expires_at = datetime.fromisoformat(raw_expires.replace("Z", "+00:00"))
            except ValueError:
                expires_at = None
            if expires_at is not None:
                if expires_at.tzinfo is None:
                    expires_at = expires_at.replace(tzinfo=UTC)
                remaining = (expires_at - datetime.now(UTC)).total_seconds()
                if remaining <= 0:
                    return _envelope_result(
                        _ask_user_envelope(question_id=question_id, status=STATUS_NO_ANSWER),
                        reason="resume_expired",
                    )
                wait_timeout = min(remaining, self.wait_ceiling_seconds)
        pending = PendingQuestion(
            local_id=question_id,
            run_id=run_id,
            session_id=session_id,
            payload={"questionId": question_id, "resumed": True},
        )
        self.pending_by_run[run_id] = pending
        logger.info(
            "User question wait re-armed from the durable row: id={} runId={}",
            question_id,
            run_id,
        )
        try:
            await asyncio.wait_for(pending.event.wait(), timeout=wait_timeout)
        except TimeoutError:
            self.pending_by_run.pop(run_id, None)
            reason = REASON_TIMEOUT if expires_at is not None else REASON_LOCAL_CEILING
            logger.warning(
                "Re-armed user question wait ended without an answer: id={} runId={} reason={}",
                question_id,
                run_id,
                reason,
            )
            return _envelope_result(
                _ask_user_envelope(question_id=question_id, status=STATUS_NO_ANSWER),
                reason=reason,
            )
        except asyncio.CancelledError:
            self.pending_by_run.pop(run_id, None)
            logger.warning(
                "Re-armed user question wait cancelled: id={} runId={}", question_id, run_id
            )
            raise
        answer = pending.answer
        self.pending_by_run.pop(run_id, None)
        if answer is None:
            return _envelope_result(
                _ask_user_envelope(question_id=question_id, status=STATUS_NO_ANSWER),
                reason=REASON_LOCAL_CEILING,
            )
        return _envelope_result(
            _ask_user_envelope(
                question_id=pending.answered_question_id or question_id,
                status=STATUS_ANSWERED,
                answer=answer,
            )
        )


# Keys the checkpoint-saver/tool-adapter never persist: the message and reason
# extras are dict-only diagnostics for tests/debugging; only content reaches the
# model and the durable ToolMessage, and content is exactly the canonical JSON
# envelope.
def _envelope_result(envelope: dict[str, Any], **extra: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "content": json.dumps(envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        **envelope,
    }
    result.update(extra)
    return result


def _ask_user_envelope(
    *, question_id: str, status: str, answer: str = "", code: str = ""
) -> dict[str, Any]:
    # Always emit the full field set (answer/code as "" when not applicable) so the
    # canonical form is stable across paths; the schema whitelist is exactly these
    # four fields — the question body never appears here (draft 判据 4).
    return {"questionId": question_id, "status": status, "answer": answer, "code": code}


def _error_result(code: str, message: str) -> dict[str, Any]:
    """Local validation failure → status=error envelope (draft 判据 3 mapping:
    INVALID_QUESTION / INVALID_TIMEOUT are error; refusals are refused)."""
    return _envelope_result(
        _ask_user_envelope(question_id="", status=STATUS_ERROR, code=code),
        message=message,
    )


def _refused_code(exc: BaseException) -> str | None:
    """Return the CP problem code when ``exc`` carries a refusal, else ``None``.

    Recognised shapes, duck-typed on purpose (the tool keeps no CP-client import): an explicit
    :class:`UserQuestionRefusedError`, any exception exposing a non-empty string ``code``, and an
    ``httpx.HTTPStatusError``-shaped 409 whose problem body carries ``code``. A 409 whose body has
    no readable code is still not a transport bug, but there is no code to report, so the original
    failure is re-raised instead of being turned into a guess.
    """
    if isinstance(exc, UserQuestionRefusedError):
        return exc.code
    code = getattr(exc, "code", None)
    if isinstance(code, str) and code:
        return code
    response = getattr(exc, "response", None)
    if response is not None and getattr(response, "status_code", None) == 409:
        try:
            body = response.json()
        except Exception:
            logger.warning("User question refusal body is not JSON; re-raising the transport error")
            return None
        if isinstance(body, dict):
            body_code = body.get("code")
            if isinstance(body_code, str) and body_code:
                return body_code
    return None


def _refusal_result(
    code: str, question_id: str = "", message: str | None = None
) -> dict[str, Any]:
    """CP/local refusal → status=refused envelope (draft 判据 3 mapping: the 子会话门,
    QUESTION_ALREADY_PENDING and every CP 409 problem code are refused, never error
    and never a fabricated no_answer)."""
    if message is None:
        if code == CODE_SUBAGENT_QUESTION_REFUSED:
            message = SUBAGENT_QUESTION_REFUSED_CONTENT
        else:
            message = f"User question refused by CP ({code}); it was not delivered."
    return _envelope_result(
        _ask_user_envelope(question_id=question_id, status=STATUS_REFUSED, code=code),
        message=message,
    )


class UserQuestionTool(BaseAgentTool):
    """Agent-tool implementation of ``ask_user`` (independent of the approval waiter)."""

    def __init__(self, wait_ceiling_seconds: float | None = None) -> None:
        self.coordinator = UserQuestionCoordinator(wait_ceiling_seconds)

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="ask_user",
            description=(
                "Ask the human user a question and wait for their answer. Use it when a decision "
                "or missing information blocks further work. Returns the answer, or an explicit "
                "no_answer when the deadline passes (continue without inventing an answer)."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": f"The question to ask the user (max {MAX_QUESTION_LENGTH} chars)",
                        "maxLength": MAX_QUESTION_LENGTH,
                    },
                    "timeoutSeconds": {
                        "type": "number",
                        "description": (
                            "Optional deadline in seconds. Omit for a plain blocking ask "
                            "(the Agent applies its own fail-closed ceiling)."
                        ),
                    },
                },
                "required": ["question"],
            },
            # G3-a 判据 1: waiting runs must checkpoint — the pending AI message args
            # project through this schema and every result below projects through
            # the output envelope (判据 3).
            checkpoint_safe_schema=ASK_USER_CHECKPOINT_SAFE_SCHEMA,
        )

    @property
    def name(self) -> str:
        return self.spec.name

    @property
    def description(self) -> str:
        return self.spec.description

    async def execute(self, input: dict[str, Any], context: AgentContext) -> dict[str, Any]:
        raw_question = input.get("question")
        if not isinstance(raw_question, str) or not raw_question.strip():
            return _error_result("INVALID_QUESTION", "question must be a non-empty string")
        question = raw_question.strip()
        if len(question) > MAX_QUESTION_LENGTH:
            return _error_result(
                "INVALID_QUESTION",
                f"question must be at most {MAX_QUESTION_LENGTH} characters",
            )
        event_sink = context.metadata.get(USER_QUESTION_EVENT_SINK_KEY)
        if event_sink is not None and not callable(event_sink):
            event_sink = None
        return await self.coordinator.ask(question, input.get("timeoutSeconds"), context, event_sink)

    def resolve_answer(
        self, question_id: str, session_id: str, run_id: str, answer: str
    ) -> tuple[str, dict[str, Any] | None]:
        return self.coordinator.resolve(question_id, session_id, run_id, answer)

    def get_pending(self) -> list[dict[str, Any]]:
        return self.coordinator.get_pending()
