"""Deterministic hard-assertion evaluators for the fixed task set (PLAN-0511).

Only deterministic assertions live here. Optional LLM-judge signals are reported
separately by later milestones and never block on their own (design decision #2).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from pydantic import BaseModel, ConfigDict

from xihe_agent.evaluation.facts import RunFacts
from xihe_agent.evaluation.schema import HardAssertion

_JSON_TYPES: dict[str, tuple[type, ...]] = {
    "string": (str,),
    "boolean": (bool,),
    "number": (int, float),
    "object": (dict,),
    "array": (list,),
}


class AssertionResult(BaseModel):
    """Outcome of one hard assertion against observed Run facts."""

    model_config = ConfigDict(extra="forbid")

    assertion_id: str
    kind: str
    passed: bool
    detail: str


def _parse_json_object(text: str | None) -> dict[str, Any] | None:
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _eval_json_schema(facts: RunFacts, expected: dict[str, Any]) -> tuple[bool, str]:
    parsed = _parse_json_object(facts.final_output_text)
    if parsed is None:
        return False, "final output is not a JSON object"
    required = expected.get("required", [])
    missing = [k for k in required if k not in parsed]
    if missing:
        return False, f"missing required fields: {missing}"
    types = expected.get("types", {})
    for key, type_name in types.items():
        py_types = _JSON_TYPES.get(type_name)
        if py_types is None:
            return False, f"unknown expected type {type_name!r}"
        if not isinstance(parsed.get(key), py_types):
            return False, f"field {key!r} is not {type_name}"
    return True, "json schema satisfied"


def _eval_no_extra_fields(facts: RunFacts, expected: dict[str, Any]) -> tuple[bool, str]:
    parsed = _parse_json_object(facts.final_output_text)
    if parsed is None:
        return False, "final output is not a JSON object"
    allowed = set(expected.get("allowed", []))
    extra = sorted(set(parsed) - allowed)
    if extra:
        return False, f"forbidden extra fields: {extra}"
    return True, "no extra fields"


def _eval_tool_invocation_count(facts: RunFacts, expected: dict[str, Any]) -> tuple[bool, str]:
    want = expected.get("equals")
    if facts.tool_invocation_count != want:
        return False, f"tool_invocation_count={facts.tool_invocation_count}, expected {want}"
    return True, "tool invocation count matches"


def _eval_fact_match(facts: RunFacts, expected: dict[str, Any]) -> tuple[bool, str]:
    text = (facts.final_output_text or "").lower()
    needles = [str(n).lower() for n in expected.get("must_include", [])]
    missing = [n for n in needles if n not in text]
    if missing:
        return False, f"answer missing required facts: {missing}"
    return True, "answer contains required facts"


def _eval_citation_present(facts: RunFacts, expected: dict[str, Any]) -> tuple[bool, str]:
    source_id = expected.get("sourceId")
    if source_id is None or source_id not in facts.citations:
        return False, f"citation {source_id!r} not present (citations={facts.citations})"
    return True, "citation present"


def _eval_no_fabricated_source(facts: RunFacts, expected: dict[str, Any]) -> tuple[bool, str]:
    allowed = set(expected.get("allowedSourceIds", []))
    fabricated = sorted(set(facts.citations) - allowed)
    if fabricated:
        return False, f"fabricated citations: {fabricated}"
    return True, "no fabricated citations"


def _eval_refusal_status(facts: RunFacts, expected: dict[str, Any]) -> tuple[bool, str]:
    codes = set(expected.get("enum", []))
    observed = {facts.status, facts.refusal_code, facts.terminal_error_code}
    if codes & observed:
        return True, "structured refusal observed"
    return False, f"no refusal status in {codes} (observed={sorted(c for c in observed if c)})"


def _eval_terminal_within_timeout(facts: RunFacts, expected: dict[str, Any]) -> tuple[bool, str]:
    if not facts.is_terminal():
        limit = expected.get("max_seconds")
        return False, f"run did not terminate within {limit}s (status={facts.status})"
    return True, "run terminated before the evaluation timeout"


def _eval_budget_within(facts: RunFacts, expected: dict[str, Any]) -> tuple[bool, str]:
    dimensions = expected.get("dimensions", list(facts.budget))
    for name in dimensions:
        dim = facts.budget.get(name)
        if dim is None:
            return False, f"budget dimension {name!r} not observed"
        if dim.used > dim.limit:
            return False, f"{name} exceeded budget ({dim.used} > {dim.limit})"
    return True, "stopped within budget"


def _eval_terminal_error_code(facts: RunFacts, expected: dict[str, Any]) -> tuple[bool, str]:
    codes = set(expected.get("enum", []))
    if facts.terminal_error_code in codes:
        return True, f"terminal code {facts.terminal_error_code} recognized"
    return False, f"terminal code {facts.terminal_error_code!r} not in {codes}"


def _eval_no_repeat_mutation(facts: RunFacts, expected: dict[str, Any]) -> tuple[bool, str]:
    want = expected.get("repeatedCompletedMutations", 0)
    if facts.repeated_mutations != want:
        return False, f"repeated_mutations={facts.repeated_mutations}, expected {want}"
    return True, "no repeated mutation"


_EVALUATORS: dict[str, Callable[[RunFacts, dict[str, Any]], tuple[bool, str]]] = {
    "json_schema": _eval_json_schema,
    "no_extra_fields": _eval_no_extra_fields,
    "tool_invocation_count": _eval_tool_invocation_count,
    "fact_match": _eval_fact_match,
    "citation_present": _eval_citation_present,
    "no_fabricated_source": _eval_no_fabricated_source,
    "refusal_status": _eval_refusal_status,
    "terminal_within_timeout": _eval_terminal_within_timeout,
    "budget_within": _eval_budget_within,
    "terminal_error_code": _eval_terminal_error_code,
    "no_repeat_mutation": _eval_no_repeat_mutation,
}


def evaluate_assertion(assertion: HardAssertion, facts: RunFacts) -> AssertionResult:
    """Evaluate one hard assertion, failing closed on unknown kinds or observations."""
    evaluator = _EVALUATORS.get(assertion.kind)
    if evaluator is None:
        return AssertionResult(
            assertion_id=assertion.assertion_id,
            kind=assertion.kind,
            passed=False,
            detail=f"unknown assertion kind {assertion.kind!r}",
        )
    try:
        passed, detail = evaluator(facts, assertion.expected)
    except (TypeError, KeyError, ValueError) as exc:
        return AssertionResult(
            assertion_id=assertion.assertion_id,
            kind=assertion.kind,
            passed=False,
            detail=f"evaluation error: {exc}",
        )
    return AssertionResult(assertion_id=assertion.assertion_id, kind=assertion.kind, passed=passed, detail=detail)
