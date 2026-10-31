"""PLAN-0590 unit-test defaults for the run-config snapshot resolver.

Production resolves one `(workspaceId, userId)` effective snapshot per run over
HTTP. Unit tests exercise route/resolver logic without a CP, so they install a
resolver whose "fetch" returns the process-level effective cache — the same base
the pre-0590 code used. Tests that assert snapshot semantics (cache/TTL/stale/
identity) build their own resolver instead of using this fixture.
"""

from collections.abc import Iterator

import pytest

from xihe_agent import app_state
from xihe_agent.api import chat as chat_route
from xihe_agent.api import misc as misc_route
from xihe_agent.config_snapshot import RunConfigResolver, RunConfigSnapshot, process_config_snapshot


def process_snapshot(*, stale: bool = False) -> RunConfigSnapshot:
    """Snapshot of the (monkeypatched) process effective cache."""
    snapshot = process_config_snapshot(app_state.config_client)
    return snapshot.as_stale() if stale else snapshot


def _process_fetch_resolver() -> RunConfigResolver:
    resolver = RunConfigResolver(app_state.config_client, ttl_seconds=60, max_entries=8)

    async def _fetch(workspace_id: str | None, user_id: str | None) -> RunConfigSnapshot:
        return process_config_snapshot(app_state.config_client)

    resolver._fetch = _fetch  # type: ignore[method-assign]
    return resolver


@pytest.fixture(autouse=True)
def process_run_config_resolver(monkeypatch: pytest.MonkeyPatch) -> Iterator[RunConfigResolver]:
    resolver = _process_fetch_resolver()
    monkeypatch.setattr(chat_route, "run_config_resolver", resolver)
    monkeypatch.setattr(misc_route, "run_config_resolver", resolver)
    yield resolver
