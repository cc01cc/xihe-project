"""PLAN-0629 M1-4 cross-language pin: the memory token estimate must be the SAME rule in both runtimes.

CP (``AgentMemoryInjectionService.estimateTokens``) decides how many memory entries fit into a
component's ``maxTokens``; this package's ``context/injection_budget.conservative_token_count`` decides
how much the run ledger charges. If the two drift, CP hands over more text than the ledger can pay for.

The rule is pinned by a shared fixture — ``spec/fixtures/memory-token-estimate.json`` — which is also
read by CP's ``AgentMemoryTokenEstimateContractTest``. Adding a case there makes both suites assert it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from xihe_agent.context.injection_budget import conservative_token_count


def _fixture_path() -> Path:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "spec" / "fixtures" / "memory-token-estimate.json"
        if candidate.is_file():
            return candidate
    raise AssertionError("shared fixture spec/fixtures/memory-token-estimate.json not found")


def _cases() -> list[dict[str, object]]:
    return json.loads(_fixture_path().read_text(encoding="utf-8"))["cases"]


def test_agentEstimateMatchesTheSharedContract() -> None:
    cases = _cases()
    assert cases, "the shared contract needs at least one case"
    for case in cases:
        text = str(case["input"])
        expected = int(case["tokens"])
        assert conservative_token_count(text) == expected, (
            f"estimate drift for input of length {len(text)}: agent says "
            f"{conservative_token_count(text)}, contract says {expected}"
        )


def test_contractCoversTheEdgeCasesTheCallersRelyOn() -> None:
    """Guard rails for the fixture itself: empty must stay 0 and a single char must stay 1."""
    by_length = {len(str(case["input"])): int(case["tokens"]) for case in _cases()}
    assert by_length.get(0) == 0
    assert by_length.get(1) == 1
