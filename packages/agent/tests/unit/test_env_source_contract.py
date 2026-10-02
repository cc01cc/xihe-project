"""PLAN-0382 T3.1 (Agent side): env/source contract tests.

Covers verify V1 (epoch field round-trip + absent-key preservation), V2
(Runtime facts are the only env authority — the renderer never host-fills),
V5 (L1 fail-closed family), and replay parity for the new state/fact keys.
"""

from datetime import UTC, datetime

from xihe_agent.agent_runner.langgraph_runner import LangGraphRunner, _render_env_block
from xihe_agent.interfaces.agent_runner import RunnerConfig
from xihe_agent.interfaces.context import AgentContext, ContextEpoch, ContextSource, _derive_l1_status
from xihe_agent.interfaces.event import Event

SNAPSHOT_SENTINEL = {
    "env_status": "ok",
    "env_observed_at": "2026-10-01T00:00:00Z",
    "env_cwd": "/workspace",
    "env_platform": "planos-sentinel",
    "env_shell": "xihe-shell",
    "l1_status": "ok",
}


def _event(event_type: str, payload: dict, sequence: int = 1) -> Event:
    return Event(
        aggregate_id="session-1",
        sequence=sequence,
        type=event_type,
        payload=payload,
        created_at=datetime.now(UTC),
    )


def _epoch(**overrides) -> ContextEpoch:
    base = dict(
        epoch_id="epoch-1",
        baseline_hash="hash-1",
        system_messages=[],
        **SNAPSHOT_SENTINEL,
    )
    base.update(overrides)
    return ContextEpoch(**base)


# --- V1: round-trip -------------------------------------------------------

def test_epoch_state_and_facts_roundtrip_through_snapshot():
    ctx = AgentContext.empty("session-1")
    ctx.set_epoch(_epoch(env_branch="main", env_head="abc1234", env_is_repository=True))
    restored = AgentContext.from_snapshot(ctx.to_snapshot())
    env = restored.epoch
    assert env is not None
    assert env.l1_status == "ok"
    assert env.env_status == "ok"
    assert env.env_observed_at == "2026-10-01T00:00:00Z"
    assert env.env_cwd == "/workspace"
    assert env.env_platform == "planos-sentinel"
    assert env.env_shell == "xihe-shell"
    assert env.env_branch == "main"
    assert env.env_head == "abc1234"
    # A second round-trip is byte-stable (absent stays absent, values stay).
    again = AgentContext.from_snapshot(restored.to_snapshot())
    assert again.to_snapshot()["epoch"] == restored.to_snapshot()["epoch"]


def test_absent_keys_roundtrip_as_absent_not_fabricated():
    ctx = AgentContext.empty("session-1")
    ctx.set_epoch(ContextEpoch(epoch_id="e", baseline_hash="h", system_messages=[]))
    raw = ctx.to_snapshot()["epoch"]
    # spec §5: defaults must serialize as absent keys (legacy inference reads absence).
    for key in ("l1_status", "env_status", "env_observed_at", "env_cwd", "env_platform", "env_shell"):
        assert key not in raw, key
    restored = AgentContext.from_snapshot(ctx.to_snapshot()).epoch
    assert restored is not None
    assert restored.l1_status == ""
    assert restored.env_status == ""
    assert restored.env_cwd is None
    assert restored.env_platform is None
    assert restored.env_shell is None


# --- V2: renderer authority ----------------------------------------------

def test_render_env_block_uses_only_snapshot_facts():
    epoch = _epoch()
    text = _render_env_block(epoch)
    assert "cwd: /workspace" in text
    assert "platform: planos-sentinel" in text
    assert "shell: xihe-shell" in text
    # Host values must never stand in for workspace facts (§4).
    import platform as host_platform
    if host_platform.system() != "planos-sentinel":
        assert f"platform: {host_platform.system()}" not in text


def test_render_env_block_unknown_when_facts_absent():
    epoch = ContextEpoch(epoch_id="e", baseline_hash="h", system_messages=[])
    text = _render_env_block(epoch)
    assert "cwd: unknown" in text
    assert "platform: unknown" in text
    assert "shell: unknown" in text
    # The old host-filling signature must be gone entirely.
    import os
    import platform as host_platform
    assert f"platform: {host_platform.system()}" not in text
    host_shell = os.environ.get("SHELL") or os.environ.get("COMSPEC")
    if host_shell:
        assert f"shell: {host_shell}" not in text


# --- V5: L1 fail-closed family -------------------------------------------

def _messages_for(epoch: ContextEpoch) -> list[str]:
    ctx = AgentContext.empty("session-1")
    ctx.set_epoch(epoch)
    config = RunnerConfig(
        model="mock",
        system_prompt="base system prompt",
        tools=[],
        context=ctx,
    )
    runner = LangGraphRunner(model_factory=lambda _model: None)
    return [str(m.content) for m in runner._build_system_messages(config, ctx)]


def test_l1_fail_closed_family_never_injects():
    stale_sources = [
        {"key": "AGENTS.md", "source_type": "agents_md", "content": "STALE RULES", "content_hash": "h"}
    ]
    stale = [ContextSource(key="AGENTS.md", source_type="agents_md",
                           content="STALE RULES", content_hash="h")]
    for status in ("failed", "unavailable", "missing"):
        epoch = _epoch(l1_status=status, l1_rendered="STALE RENDERED", sources=stale)
        rendered = "\n".join(_messages_for(epoch))
        assert "STALE RENDERED" not in rendered, status
        assert "STALE RULES" not in rendered, status


def test_legacy_empty_status_still_injects_content():
    """Upgrades must not blank every pre-0382 session: "" + content = ok."""
    epoch = _epoch(
        l1_status="",
        l1_rendered="CURRENT RULES",
        sources=[ContextSource(key="AGENTS.md", source_type="agents_md", content="CURRENT RULES", content_hash="h")],
    )
    rendered = "\n".join(_messages_for(epoch))
    assert "CURRENT RULES" in rendered


# --- replay parity ---------------------------------------------------------

def test_env_updated_copy_on_present_and_legacy_preserves():
    ctx = AgentContext.empty("session-1")
    ctx.apply_event(_event("context.env_updated", {
        "branch": "main", "head": "abc1234", "is_repository": True,
        "env_status": "ok", "env_observed_at": "2026-10-01T00:00:00Z",
        "env_cwd": "/workspace", "env_platform": "linux", "env_shell": "xihe-shell",
    }, 1))
    # A legacy env event (pre-0382 payload) must not wipe the newer keys.
    ctx.apply_event(_event("context.env_updated", {
        "branch": "dev", "head": "def5678", "is_repository": True,
    }, 2))
    epoch = ctx.epoch
    assert epoch.env_branch == "dev"
    assert epoch.env_status == "ok"
    assert epoch.env_cwd == "/workspace"
    assert epoch.env_platform == "linux"
    assert epoch.env_shell == "xihe-shell"


def test_source_clear_keeps_env_and_marks_status():
    ctx = AgentContext.empty("session-1")
    ctx.apply_event(_event("context.env_updated", {
        "branch": "main", "head": "abc1234", "is_repository": True,
        "env_status": "ok", "env_cwd": "/workspace", "env_platform": "linux",
        "env_shell": "xihe-shell", "env_observed_at": "2026-10-01T00:00:00Z",
    }, 1))
    ctx.apply_event(_event("context.source_changed", {
        "status": "ok", "l1_status": "ok", "source_hash": "h1",
        "rendered_text": "RULES",
        "sources": [{"key": "AGENTS.md", "source_type": "agents_md",
                     "content": "RULES", "content_hash": "h1"}],
    }, 2))
    assert ctx.epoch.sources and ctx.epoch.l1_status == "ok"

    ctx.apply_event(_event("context.source_changed", {
        "status": "unavailable", "l1_status": "unavailable",
        "source_hash": "", "rendered_text": "", "sources": [],
    }, 3))
    epoch = ctx.epoch
    # Q2=A: slot cleared with its mark; legacy sources dropped too (BL-48);
    # env facts survive the clear.
    assert epoch.l1_status == "unavailable"
    assert epoch.l1_rendered == ""
    assert epoch.sources == []
    assert epoch.source_hash == ""
    assert epoch.env_status == "ok"
    assert epoch.env_cwd == "/workspace"


def test_compaction_preserves_env_and_state():
    ctx = AgentContext.empty("session-1")
    ctx.apply_event(_event("context.env_updated", {
        "branch": "main", "head": "abc1234", "is_repository": True,
        "env_status": "ok", "env_cwd": "/workspace", "env_platform": "linux",
        "env_shell": "xihe-shell", "env_observed_at": "2026-10-01T00:00:00Z",
    }, 1))
    ctx.apply_event(_event("context.source_changed", {
        "status": "created", "l1_status": "ok", "source_hash": "h1",
        "rendered_text": "RULES",
        "sources": [{"key": "AGENTS.md", "source_type": "agents_md",
                     "content": "RULES", "content_hash": "h1"}],
    }, 2))
    ctx.apply_event(_event("compaction.applied", {
        "contextEpoch": "epoch-2", "summary": "sum", "summaryHash": "sh",
    }, 3))
    epoch = ctx.epoch
    assert epoch.env_status == "ok"
    assert epoch.env_cwd == "/workspace"
    assert epoch.l1_status == "ok"
    assert epoch.l1_rendered == "RULES"


def test_derive_l1_status_legacy_mapping():
    assert _derive_l1_status({"status": "created"}, "created") == "ok"
    assert _derive_l1_status({"status": "updated"}, "updated") == "ok"
    assert _derive_l1_status({"status": "failed"}, "failed") == "failed"
    assert _derive_l1_status({"status": "missing"}, "missing") == "missing"
    assert _derive_l1_status({"l1_status": "unavailable", "status": "failed"}, "failed") == "unavailable"
    assert _derive_l1_status({"status": "unchanged"}, "unchanged") == ""
