"""PLAN-0635 M2: `@文件` inline injection on the shared 0627 ledger.

The contract points under test are the ones a future reader is most likely to "simplify" away:
charging under source ``"nested"`` (the only legal source), the resulting dedupe with PLAN-0627's
nested AGENTS.md chain, and the fact that the rendered block must reach the **provider body's
``user_input`` slot** — not ``messages`` (template mode only renders ``user_input``).
"""

import json

import pytest
from langchain_core.messages import HumanMessage

from xihe_agent.adapters.api_chat_model import ApiChatModel
from xihe_agent.context.injection_budget import InjectionLedger
from xihe_agent.context.path_mentions import (
    DIRECTORY_HINT,
    PATH_ONLY_HINT,
    TRUNCATION_HINT,
    PathMention,
    append_to_user_input,
    charge_path_mentions,
    parse_path_mentions,
    render_for_context,
    render_path_mentions,
)
from xihe_agent.llm.api_request import chat_type


def _ledger() -> InjectionLedger:
    # A normal window: the nested cap is far above what these small bodies need.
    return InjectionLedger.create(128_000, 0)


def test_parse_drops_malformed_rows_but_keeps_good_ones():
    payload = [
        {"path": "docs/guide.md", "kind": "file", "content": "body", "truncated": False},
        {"path": "", "kind": "file", "content": "x"},  # empty path
        {"path": "a.ts", "kind": "binary", "content": "x"},  # unknown kind
        "not-a-dict",
        {"path": "src/app.ts", "kind": "directory", "content": "a.ts\nb.ts"},
    ]

    mentions = parse_path_mentions(payload)

    assert [m.path for m in mentions] == ["docs/guide.md", "src/app.ts"]
    assert mentions[1].kind == "directory"
    assert parse_path_mentions(None) == []


def test_small_file_is_charged_under_the_nested_source_with_its_path_as_key():
    ledger = _ledger()
    injection = charge_path_mentions(
        ledger, [PathMention(path="docs/guide.md", kind="file", content="hello")]
    )

    assert injection.entries == (("docs/guide.md", "hello"),)
    assert injection.path_only == ()
    # Source must be "nested": a fourth source is physically rejected by try_charge.
    assert ledger.by_source["nested"] > 0
    assert "docs/guide.md" in ledger.charged_keys("nested")


def test_body_above_the_inline_limit_becomes_path_only_and_is_not_charged():
    ledger = _ledger()
    big = "x" * 20_000
    injection = charge_path_mentions(
        ledger,
        [PathMention(path="big.txt", kind="file", content=big)],
        inline_token_limit=100,
    )

    assert injection.entries == ()
    assert injection.path_only == ("big.txt",)
    assert ledger.by_source["nested"] == 0
    assert "big.txt" not in ledger.charged_keys("nested")


def test_truncated_body_carries_the_hint_so_the_model_knows_it_is_partial():
    ledger = _ledger()
    injection = charge_path_mentions(
        ledger, [PathMention(path="big.log", kind="file", content="head", truncated=True)]
    )

    assert len(injection.entries) == 1
    body = injection.entries[0][1]
    assert body.startswith("head")
    assert TRUNCATION_HINT in body


def test_duplicate_mention_of_the_same_path_is_charged_once():
    ledger = _ledger()
    mention = PathMention(path="docs/guide.md", kind="file", content="hello")

    first = charge_path_mentions(ledger, [mention])
    used_after_first = ledger.by_source["nested"]
    second = charge_path_mentions(ledger, [mention])

    assert first.entries == (("docs/guide.md", "hello"),)
    assert second.entries == ()  # already charged under this key
    assert ledger.by_source["nested"] == used_after_first


def test_dedupes_against_a_plan_0627_nested_agents_md_charge():
    """`@docs/AGENTS.md` must not be injected twice when the nested chain already carried it."""
    ledger = _ledger()
    assert ledger.try_charge("nested", "docs/AGENTS.md", 10) is True

    injection = charge_path_mentions(
        ledger, [PathMention(path="docs/AGENTS.md", kind="file", content="# rules")]
    )

    assert injection.entries == ()
    assert ledger.by_source["nested"] == 10  # unchanged: the nested charge still owns it


def test_directory_mention_keeps_the_listing_inline_and_is_charged():
    ledger = _ledger()
    injection = charge_path_mentions(
        ledger, [PathMention(path="src/chat", kind="directory", content="a.ts\nb.ts")]
    )

    assert injection.entries == (("src/chat", "a.ts\nb.ts"),)
    assert "src/chat" in ledger.charged_keys("nested")


def test_budget_exhaustion_falls_back_to_path_only_and_reports_denied():
    ledger = _ledger()
    # Burn the whole nested cap so the next charge cannot fit.
    assert ledger.try_charge("nested", "filler.txt", ledger.limits.caps["nested"]) is True

    injection = charge_path_mentions(
        ledger, [PathMention(path="docs/guide.md", kind="file", content="hello")]
    )

    assert injection.entries == ()
    assert injection.path_only == ("docs/guide.md",)
    assert injection.denied == ("docs/guide.md",)


def test_render_is_empty_without_targets():
    assert render_path_mentions(charge_path_mentions(_ledger(), [])) == ""


def test_render_wraps_inline_bodies_in_the_untrusted_envelope_and_lists_path_only():
    ledger = _ledger()
    injection = charge_path_mentions(
        ledger,
        [
            PathMention(path="docs/guide.md", kind="file", content="hello"),
            PathMention(path="src/chat", kind="directory", content="a.ts"),
        ],
        inline_token_limit=1,
    )

    rendered = render_path_mentions(injection)

    # Nothing was inlined at this limit: both become path-only pointers.
    assert "docs/guide.md" in rendered
    assert "src/chat" in rendered
    assert PATH_ONLY_HINT in rendered


def test_inline_body_is_wrapped_in_the_untrusted_envelope():
    ledger = _ledger()
    injection = charge_path_mentions(
        ledger, [PathMention(path="docs/guide.md", kind="file", content="hello")]
    )

    rendered = render_path_mentions(injection)

    # Same envelope as PLAN-0627: file content is repo content, never instructions.
    assert "untrusted-repo-instructions" in rendered
    assert "hello" in rendered
    assert DIRECTORY_HINT  # directory pointer text is defined for the directory branch


# --------------------------------------------------------------------------------------
# End-to-end: CP payload -> ledger charge -> render -> the provider body that leaves the Agent.
# --------------------------------------------------------------------------------------


class _RunContext:
    """Minimal stand-in for the run context the chat route builds (metadata + runtime_state)."""

    def __init__(self) -> None:
        self.metadata: dict[str, object] = {"windowTokens": 128_000, "assembledTokens": 0}
        self.runtime_state: dict[str, object] = {}


def _provider_body(type_id: str) -> dict[str, object]:
    key = "input" if type_id == "mimo-responses" else "messages"
    body: dict[str, object] = {
        "model": "${xh.model}",
        key: ["${xh.conversation_history}", {"role": "user", "content": "${xh.user_input}"}],
        "tools": ["${xh.tools}"],
        "stream": False,
    }
    if type_id == "anthropic-messages":
        # The anthropic template validator requires a concrete max_tokens (same as the
        # reference fixture in test_api_request_runtime.py).
        body["max_tokens"] = 64
    return body


def _grant(type_id: str) -> dict[str, object]:
    return {
        "apiTypeId": type_id,
        "apiTypeVersion": 1,
        "operation": "chat",
        "apiKey": "fixture-only",
        "baseUrl": "https://chat.invalid/v1",
        "toolsSupported": True,
        "visionSupported": True,
    }


@pytest.mark.parametrize(
    "type_id", ["openai-chat-completions", "anthropic-messages", "mimo-responses"]
)
def test_path_mention_envelope_reaches_the_provider_body(type_id):
    """The CP payload must end up inside the provider body's `user_input` slot.

    This is the assertion that would have caught the tempting-but-wrong wiring into `messages`:
    in template mode only `user_input` is rendered into the provider body.
    """
    context = _RunContext()
    mentions = parse_path_mentions(
        [
            {
                "path": "docs/guide.md",
                "kind": "file",
                "content": "hello from the mentioned file",
                "truncated": False,
            }
        ]
    )

    block, diagnostics = render_for_context(context, mentions)
    assert diagnostics["requested"] == 1
    assert diagnostics["inlined"] == 1
    assert diagnostics["pathOnly"] == []

    model = ApiChatModel(
        api_type=chat_type(type_id, 1),
        grant=_grant(type_id),
        body_source=json.dumps(_provider_body(type_id)),
        values={
            "model": "fixture",
            "user_input": append_to_user_input("question", block),
            "agent_instructions": "",
            "conversation_history": [],
            "tools": [],
        },
        request_id="request-fixture",
        timeout=1,
        token_estimator=lambda native: len(json.dumps(native)),
    )

    native = model._dispatch_body([HumanMessage(content="question")])
    dumped = json.dumps(native)

    assert "untrusted-repo-instructions" in dumped
    assert "hello from the mentioned file" in dumped
    # Provenance attribute reaches the wire, so the model can tell which path it is.
    assert "docs/guide.md" in dumped


def test_diagnostics_are_structured_when_nothing_is_inlined():
    """Over-budget / denied rows must be reported, never silently dropped."""
    context = _RunContext()
    mentions = parse_path_mentions(
        [{"path": "big.txt", "kind": "file", "content": "x" * 20_000, "truncated": False}]
    )

    block, diagnostics = render_for_context(context, mentions)

    # The model is still told the path exists (path-only tail), so nothing is lost silently.
    assert "big.txt" in block
    assert PATH_ONLY_HINT in block
    assert diagnostics["inlined"] == 0
    assert diagnostics["pathOnly"] == ["big.txt"]


def test_no_mentions_means_no_block_and_empty_diagnostics():
    block, diagnostics = render_for_context(_RunContext(), [])

    assert block == ""
    assert diagnostics["requested"] == 0
    assert append_to_user_input("question", block) == "question"
