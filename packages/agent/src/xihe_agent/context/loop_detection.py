"""PLAN-0493 observation window: semantic-repeat / no-progress detection.

A per-Run, in-process, bounded **observation window** (never authoritative —
the DiagnosticsLedger convention applies verbatim: a restart or an eviction
only loses detection state, never correctness).

Frozen I/O contract (design §方案 1-6, tasks T1.1-T1.3):

* ``pre_check(tool_name, args) -> LoopVerdict`` — before execution; evaluates
  the *repeat* signal only (warn @2 / refuse @3 / escalate @5 consecutive
  identical signatures). The attempt advances the streak exactly once, even
  when the verdict is ``refuse``.
* ``record_result(tool_name, args, *, ok, error_key, result_text) ->
  LoopVerdict`` — after the attempt (MUST be called exactly once per attempt,
  including refused attempts, whose "result" is the refusal message);
  appends the attempt to the window and evaluates the *error-streak* (warn @3
  / escalate @5 consecutive same-class failures) and *stale-result* signals
  (warn @2 / escalate @5 consecutive identical results for idempotent tools).
* ``mark_boundary()`` — approval/interrupt boundary: resets the consecutive
  counters while keeping the window, so an authorized/approved silent retry
  never counts as a repeat (verify V3, T1.4 assertion 3).

Levels: ``ok`` / ``warn`` (tier-1 hint, Run continues) / ``refuse`` (tier-1,
this call is rejected, Run continues — I1) / ``escalate`` (tier-2; the wiring
reports the ``no_progress`` trigger through the PLAN-0492 {stop, interrupt}
contract in M2 — this module never terminates a Run).

Signature = ``sha256(tool_name + canonical_json(args))`` where canonical JSON
reuses the approval-gate serialization shape (``ensure_ascii=False,
sort_keys=True, separators=(",", ":")`` — ``adapters/approval_tool.py``
PLAN-292) on top of loop-specific normalization:

* deep key sort with **keys lowercased** (field-name case is cosmetic);
* string values are **trimmed but case-preserved** (paths/commands are
  case-sensitive — folding values would create false repeats);
* ``None``-valued keys and unparseable-absent args normalize to ``{}``
  (empty-parameter normalization);
* volatile per-call fields are dropped (``VOLATILE_ARG_FIELDS``); the
  ``toolCallId`` never enters the signature (it is not part of args).

The signature is intentionally NOT the approval ``arguments_hash``: different
normalization, different purpose (identity-of-action vs grant binding).
"""

from __future__ import annotations

import hashlib
import json
from collections import deque
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

Level = Literal["ok", "warn", "refuse", "escalate"]
Signal = Literal["none", "repeat", "error", "stale"]

# design §方案 3 配置键表（T2.2 会把 8 值键 + 4 ceiling 接到此处；
# 默认值 = 用户 2026-10-12 裁定的 2/3/5 与窗口 20）。
DEFAULT_REPEAT_WARN = 2
DEFAULT_REPEAT_REFUSE = 3
DEFAULT_REPEAT_ESCALATE = 5
DEFAULT_ERROR_WARN = 3
DEFAULT_ERROR_ESCALATE = 5
DEFAULT_STALE_WARN = 2
DEFAULT_STALE_ESCALATE = 5
DEFAULT_WINDOW_SIZE = 20

# PLAN-0493 T2.1 wiring contract (AgentContext.metadata keys):
#   LOOP_WINDOW_KEY          -> LoopObservationWindow owned by the runner, one
#                               per Run; the tool adapter reads it for
#                               pre_check/record_result.
#   NO_PROGRESS_SIGNAL_KEY   -> set by the adapter on an escalate verdict; the
#                               runner stops the stream and converges the
#                               RUN_NO_PROGRESS error event (tier-2).
LOOP_WINDOW_KEY = "loop_observation_window"
NO_PROGRESS_SIGNAL_KEY = "loop_no_progress_signal"

# 易变字段剔除清单（design 方案 1；M4 时同步进 SPEC）。
# 匹配按 casefold 后的键名；只剔除“每次调用都会变”的标识字段。
VOLATILE_ARG_FIELDS: frozenset[str] = frozenset(
    {
        "toolcallid",
        "tool_call_id",
        "requestid",
        "request_id",
        "nonce",
        "timestamp",
        "ts",
    }
)

# 内置豁免清单（T0.3 evidence/m0-exclusion-list.md §1；轮询/探活语义）。
# 合并语义 = 本集合恒并集 + 配置只追加（decision #12）。
BUILTIN_EXEMPT_TOOLS: frozenset[str] = frozenset(
    {
        "get_background_process",
        "list_background_processes",
        "read_command_output",
        "watch_directory",
        "get_file_info",
    }
)

# 幂等/只读工具集（T0.3 §2；第二类信号的启用范围 = ToolFaceRegistry.READ_TOOLS，
# readOnlyHint 注解通道当前不存在，见 T0.3 §0）。
IDEMPOTENT_TOOLS: frozenset[str] = frozenset(
    {
        "read_file",
        "read_file_range",
        "list_directory",
        "glob",
        "grep",
        "get_file_info",
        "watch_directory",
        "extract_pdf_text",
        "read_command_output",
        "list_background_processes",
        "get_background_process",
    }
)


@dataclass(frozen=True)
class LoopThresholds:
    """Effective thresholds (caller applies ceiling clamping first)."""

    repeat_warn: int = DEFAULT_REPEAT_WARN
    repeat_refuse: int = DEFAULT_REPEAT_REFUSE
    repeat_escalate: int = DEFAULT_REPEAT_ESCALATE
    error_warn: int = DEFAULT_ERROR_WARN
    error_escalate: int = DEFAULT_ERROR_ESCALATE
    stale_warn: int = DEFAULT_STALE_WARN
    stale_escalate: int = DEFAULT_STALE_ESCALATE
    window: int = DEFAULT_WINDOW_SIZE


@dataclass(frozen=True)
class LoopVerdict:
    """Outcome of one observation phase.

    ``message`` is model-facing tier-1 text (empty for ``ok``/``escalate``;
    M2 wiring supplies the escalate-facing copy). Counts are observational.
    """

    level: Level
    signal: Signal
    message: str = ""
    repeat_streak: int = 0
    error_streak: int = 0
    stale_streak: int = 0


@dataclass(frozen=True)
class WindowRecord:
    """One observed attempt inside the bounded window."""

    signature: str
    tool_name: str
    exempt: bool
    ok: bool
    error_key: str = ""
    result_hash: str = ""


def _canonical_value(value: Any) -> Any:
    """Deep-normalize: strip strings, lowercase keys, drop None values."""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if item is None:
                continue
            norm_key = str(key).strip().casefold()
            if norm_key in VOLATILE_ARG_FIELDS:
                continue
            out[norm_key] = _canonical_value(item)
        return out
    if isinstance(value, list):
        return [_canonical_value(item) for item in value]
    if isinstance(value, tuple):
        return [_canonical_value(item) for item in value]
    return value


def canonicalize_args(args: Any) -> str:
    """Canonical JSON for signature hashing (see module docstring).

    Absent/None/``{}`` all normalize to ``{}``; unparseable string input is
    trimmed and used verbatim (mirrors the approval-gate fallback).
    """
    if args is None:
        return "{}"
    parsed: Any = args
    if isinstance(args, str):
        raw = args.strip()
        if not raw:
            return "{}"
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return raw
    normalized = _canonical_value(parsed)
    if isinstance(normalized, (dict, list)) and not normalized:
        return "{}" if isinstance(normalized, dict) else "[]"
    return json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def compute_signature(tool_name: str, args: Any) -> str:
    """``sha256(tool_name + canonical_json(args))`` (T1.1)."""
    payload = f"{tool_name}{canonicalize_args(args)}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _normalize_error_key(error_key: str | None) -> str:
    return (error_key or "").strip().casefold() or "unknown"


def _result_hash(result_text: str | None) -> str:
    normalized = (result_text or "").strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _base_tool_name(tool_name: str) -> str:
    """``runtime__read_file`` -> ``read_file`` (ToolNameRewriter prefixes)."""
    lowered = tool_name.strip().casefold()
    if "__" in lowered:
        return lowered.split("__", 1)[-1]
    return lowered


class LoopObservationWindow:
    """Per-Run rolling observation window (bounded, non-authoritative).

    Consecutive counters reset on a different call or :meth:`mark_boundary`;
    exempt tools are invisible to judgment (they neither trigger nor reset
    consecutive counters) but still occupy the bounded window.
    """

    def __init__(
        self,
        thresholds: LoopThresholds | None = None,
        exempt_tools: Iterable[str] | None = None,
        idempotent_tools: Iterable[str] | None = None,
    ) -> None:
        self._thresholds = thresholds or LoopThresholds()
        window_size = max(1, int(self._thresholds.window))
        self._window: deque[WindowRecord] = deque(maxlen=window_size)
        candidates = (
            {item.strip().casefold() for item in exempt_tools}
            if exempt_tools is not None
            else set(BUILTIN_EXEMPT_TOOLS)
        )
        self._exempt: frozenset[str] = frozenset(candidates)
        self._idempotent: frozenset[str] = frozenset(
            {item.strip().casefold() for item in idempotent_tools}
            if idempotent_tools is not None
            else IDEMPOTENT_TOOLS
        )
        self._repeat_sig: str | None = None
        self._repeat_streak = 0
        self._error_key: str | None = None
        self._error_streak = 0
        self._stale_key: str | None = None
        self._stale_streak = 0

    # -- helpers -----------------------------------------------------------

    @property
    def thresholds(self) -> LoopThresholds:
        return self._thresholds

    def _is_exempt(self, tool_name: str) -> bool:
        lowered = tool_name.strip().casefold()
        return lowered in self._exempt or _base_tool_name(tool_name) in self._exempt

    def recent(self) -> list[WindowRecord]:
        """Bounded snapshot (oldest first) — observability only."""
        return list(self._window)

    def __len__(self) -> int:
        return len(self._window)

    def mark_boundary(self, reason: str = "") -> None:
        """Approval/interrupt boundary: reset consecutive counters only.

        ``reason`` is accepted for call-site clarity (e.g. ``approval``);
        the window is intentionally retained.
        """
        del reason  # informational at the call site
        self._repeat_sig = None
        self._repeat_streak = 0
        self._error_key = None
        self._error_streak = 0
        self._stale_key = None
        self._stale_streak = 0

    # -- phases ------------------------------------------------------------

    def pre_check(self, tool_name: str, args: Any) -> LoopVerdict:
        """Pre-execution repeat judgment (T1.3 tier-1 admission)."""
        if not tool_name:
            return LoopVerdict(level="ok", signal="none")
        signature = compute_signature(tool_name, args)
        if self._is_exempt(tool_name):
            return LoopVerdict(level="ok", signal="none")
        if signature == self._repeat_sig:
            count = self._repeat_streak + 1
        else:
            count = 1
        self._repeat_sig = signature
        self._repeat_streak = count
        t = self._thresholds
        if count >= t.repeat_escalate:
            return LoopVerdict(
                level="escalate", signal="repeat", repeat_streak=count
            )
        if count >= t.repeat_refuse:
            return LoopVerdict(
                level="refuse",
                signal="repeat",
                message=(
                    f"已拒绝本次调用：你已重复调用 {tool_name}，结果不会变；"
                    "请换策略或总结，或改用不同的参数/工具。"
                ),
                repeat_streak=count,
            )
        if count >= t.repeat_warn:
            return LoopVerdict(
                level="warn",
                signal="repeat",
                message=(
                    f"提示：你已连续第 {count} 次以相同参数调用 {tool_name}；"
                    "重复相同调用不会得到新结果，请调整策略。"
                ),
                repeat_streak=count,
            )
        return LoopVerdict(level="ok", signal="none", repeat_streak=count)

    def record_result(
        self,
        tool_name: str,
        args: Any,
        *,
        ok: bool = True,
        error_key: str | None = None,
        result_text: str | None = None,
    ) -> LoopVerdict:
        """Post-attempt bookkeeping: window append + error/stale judgment."""
        exempt = not tool_name or self._is_exempt(tool_name)
        signature = compute_signature(tool_name, args) if tool_name else ""
        err_key = _normalize_error_key(error_key) if not ok else ""
        r_hash = ""
        if (
            not exempt
            and ok
            and tool_name.strip().casefold() in self._idempotent
        ):
            r_hash = _result_hash(result_text)
        self._window.append(
            WindowRecord(
                signature=signature,
                tool_name=tool_name,
                exempt=exempt,
                ok=ok,
                error_key=err_key,
                result_hash=r_hash,
            )
        )
        if exempt:
            return LoopVerdict(level="ok", signal="none")

        # 同类连续失败（design 阈值表第 2 行）。
        if not ok:
            if err_key == self._error_key:
                self._error_streak += 1
            else:
                self._error_key = err_key
                self._error_streak = 1
            self._stale_key = None
            self._stale_streak = 0
            t = self._thresholds
            if self._error_streak >= t.error_escalate:
                return LoopVerdict(
                    level="escalate",
                    signal="error",
                    error_streak=self._error_streak,
                )
            if self._error_streak >= t.error_warn:
                return LoopVerdict(
                    level="warn",
                    signal="error",
                    message=(
                        f"提示：连续第 {self._error_streak} 次同类失败"
                        f"（{err_key}）：{tool_name}；请换方法而不是原样重试。"
                    ),
                    error_streak=self._error_streak,
                )
            return LoopVerdict(
                level="ok", signal="none", error_streak=self._error_streak
            )

        # 成功：失败连击清零；幂等工具同签名同结果连击判定（阈值表第 3 行）。
        self._error_key = None
        self._error_streak = 0
        if r_hash:
            stale_key = f"{signature}:{r_hash}"
            if stale_key == self._stale_key:
                self._stale_streak += 1
            else:
                self._stale_key = stale_key
                self._stale_streak = 1
            t = self._thresholds
            if self._stale_streak >= t.stale_escalate:
                return LoopVerdict(
                    level="escalate",
                    signal="stale",
                    stale_streak=self._stale_streak,
                )
            if self._stale_streak >= t.stale_warn:
                return LoopVerdict(
                    level="warn",
                    signal="stale",
                    message=(
                        f"提示：{tool_name} 连续第 {self._stale_streak} 次返回"
                        "相同结果，状态没有变化；若在等待请稍后再查，否则请换策略。"
                    ),
                    stale_streak=self._stale_streak,
                )
            return LoopVerdict(
                level="ok", signal="none", stale_streak=self._stale_streak
            )
        self._stale_key = None
        self._stale_streak = 0
        return LoopVerdict(level="ok", signal="none")
