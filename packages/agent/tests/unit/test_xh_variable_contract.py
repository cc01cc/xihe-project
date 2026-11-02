"""PLAN-0632 Gate G-0 — the ${xh.*} slot contract, driven by the shared fixture.

`spec/fixtures/xh-variables.json` is the single source of truth for the request-template
variable set and its substitution semantics. Both sides test against it, so adding,
renaming or re-classifying a slot on one side only turns this suite (or the CP mirror
`ApiRequestXhVariableFixtureTest`) red.

The concrete failure these tests exist to prevent: 0628 (skills listing) and 0629 (memory)
each added a "context component" that never reached the model wire, because the model-visible
surface is exactly `VARIABLES` and production chat renders an api-request template instead.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from xihe_agent.llm.api_request import VARIABLES, ApiRequestError, chat_type, render_request

FIXTURE_NAME = "xh-variables.json"


def _fixture_path() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "spec" / "fixtures" / FIXTURE_NAME
        if candidate.is_file():
            return candidate
    raise AssertionError(
        f"{FIXTURE_NAME} not found above {here}; the Agent and CP contract tests must share "
        "spec/fixtures/xh-variables.json (PLAN-0632 Gate G-0)"
    )


CONTRACT: dict[str, Any] = json.loads(_fixture_path().read_text(encoding="utf-8"))
SLOTS: dict[str, dict[str, Any]] = {slot["name"]: slot for slot in CONTRACT["slots"]}


def _values(case: dict[str, Any]) -> dict[str, Any]:
    values = {name: slot["sampleValue"] for name, slot in SLOTS.items()}
    values.update(case.get("valueOverride") or {})
    for name in case.get("omitValue") or []:
        values.pop(name, None)
    return values


def test_agent_registry_matches_shared_fixture() -> None:
    """The declared slot set and the Python types must match the fixture exactly."""

    expected = {name: (str if slot["type"] == "str" else list) for name, slot in SLOTS.items()}
    assert expected == VARIABLES


def test_new_slots_are_declared_scalars() -> None:
    """G-0's two slots exist, are plain strings, and carry their producer plan."""

    for name, producer in (("skill_catalog", "0628"), ("agent_memory", "0629")):
        assert name in VARIABLES, f"{name} must be a model-visible slot, not a side channel"
        assert VARIABLES[name] is str
        assert SLOTS[name]["cpClass"] == "scalar", "CP mirror lives in ApiRequestValidator.SCALARS"
        assert SLOTS[name]["producerPlan"] == producer


def test_chat_sender_declares_a_value_for_every_unproduced_slot() -> None:
    """Slots whose producer has not landed yet must still be supplied (declared empty).

    This is the difference between "declared but empty" (legal, honest) and "missing key"
    (MISSING_VARIABLE) — the latter would hard-fail every template that uses the slot.
    """

    from xihe_agent.api.chat import xh_context_slots

    supplied = xh_context_slots()
    unproduced = {
        name: slot["agentDefault"] for name, slot in SLOTS.items() if "agentDefault" in slot
    }
    assert supplied == unproduced
    assert set(supplied).issubset(VARIABLES)


@pytest.mark.parametrize("case", CONTRACT["cases"], ids=[case["id"] for case in CONTRACT["cases"]])
def test_fixture_cases_match_agent_semantics(case: dict[str, Any]) -> None:
    """Replay every fixture case through the real renderer."""

    api_type = chat_type(case["apiType"], 1)
    values = _values(case)

    if case["agent"] == "error":
        with pytest.raises(ApiRequestError) as failure:
            render_request(case["source"], api_type, values)
        assert failure.value.code == case["agentCode"], case["id"]
        return

    rendered = render_request(case["source"], api_type, values)
    if "expectMessages" in case:
        key = "input" if case["apiType"] == "mimo-responses" else "messages"
        assert rendered[key] == case["expectMessages"], case["id"]
    if "expectSystem" in case:
        assert rendered["system"] == case["expectSystem"], case["id"]


def test_undeclared_slot_is_never_rendered_empty() -> None:
    """The hard constraint: unknown variables raise, they do not decay to ''."""

    api_type = chat_type("openai-chat-completions", 1)
    source = '{"model":"${xh.model}","messages":[{"role":"user","content":"${xh.nope}"}]}'
    with pytest.raises(ApiRequestError) as failure:
        render_request(
            source,
            api_type,
            {
                "model": "m",
                "user_input": "u",
                "agent_instructions": "a",
                "skill_catalog": "",
                "agent_memory": "",
                "rag_context": "",
                "tools": [],
                "conversation_history": [],
            },
        )
    assert failure.value.code == "UNKNOWN_VARIABLE"


def test_declared_slot_without_value_still_fails() -> None:
    """Declared-empty is legal; absent-from-values is not."""

    api_type = chat_type("openai-chat-completions", 1)
    source = '{"model":"${xh.model}","messages":[{"role":"user","content":"${xh.agent_memory}"}]}'
    with pytest.raises(ApiRequestError) as failure:
        render_request(
            source,
            api_type,
            {
                "model": "m",
                "user_input": "u",
                "agent_instructions": "a",
                "skill_catalog": "",
                "rag_context": "",
                "tools": [],
                "conversation_history": [],
            },
        )
    assert failure.value.code == "MISSING_VARIABLE"
