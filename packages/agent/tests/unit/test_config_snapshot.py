"""PLAN-0590 (V4/V6/V7): run-config snapshot semantics.

Covers: identity-scoped fetch (I2), TTL/LRU/bounded cache (I4), single-flight,
stale window + fail-closed (I5), partial-domain degradation, merge order (I3),
and the process snapshot used by instance-level refresh paths.
"""

import asyncio

import pytest

from xihe_agent.config_snapshot import (
    ConfigSnapshotUnavailableError,
    RunConfigResolver,
    RunConfigSnapshot,
    process_config_snapshot,
    snapshot_metrics,
)


class FakeClient:
    """ConfigClient stand-in: returns fixed effective domains and records calls."""

    def __init__(self, results=None, failures=None):
        self.calls: list[dict[str, str | None]] = []
        self._results = results or {}
        self._failures = failures or {}

    async def fetch_run_domains(self, domains, *, workspace_id, user_id):
        self.calls.append({"workspace_id": workspace_id, "user_id": user_id, "domains": tuple(domains)})
        results = {}
        for domain in domains:
            failure = self._failures.get(domain)
            if failure == "raise":
                raise RuntimeError("transport exploded")
            status = failure or "ok"
            results[domain] = {
                "status": status,
                "entries": dict(self._results.get(domain, {})) if status == "ok" else None,
                "revision": "rev-1" if status == "ok" else "",
                "source": "workspace" if status == "ok" else "",
            }
        return results


def _resolver(client, **kwargs) -> RunConfigResolver:
    return RunConfigResolver(client, **kwargs)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_resolve_fetches_identity_scoped_domains_and_caches():
    client = FakeClient(results={"rag": {"topK": "9"}})
    resolver = _resolver(client, ttl_seconds=60, max_entries=4)

    first = await resolver.resolve("ws-a", "user-1")
    second = await resolver.resolve("ws-a", "user-1")

    assert first.workspace_id == "ws-a" and first.user_id == "user-1"
    assert first.entries["rag"] == {"topK": "9"}
    assert second is first, "fresh cache hit must reuse the frozen snapshot"
    assert len(client.calls) == 1
    assert client.calls[0]["workspace_id"] == "ws-a"
    assert client.calls[0]["user_id"] == "user-1"
    assert len(client.calls[0]["domains"]) == 5


@pytest.mark.asyncio
async def test_missing_workspace_never_asks_for_a_workspace_layer(monkeypatch):
    client = FakeClient()
    resolver = _resolver(client, ttl_seconds=60, max_entries=4)

    await resolver.resolve(None, "user-1")

    assert client.calls[0]["workspace_id"] is None
    assert client.calls[0]["user_id"] == "user-1"


@pytest.mark.asyncio
async def test_ttl_expiry_refetches(monkeypatch):
    client = FakeClient()
    resolver = _resolver(client, ttl_seconds=30, max_entries=4)

    await resolver.resolve("ws-a", None)
    snapshot = resolver._cache[("ws-a", "")]
    # Age the entry past the TTL.
    object.__setattr__(snapshot, "fetched_at", snapshot.fetched_at - 31)
    await resolver.resolve("ws-a", None)

    assert len(client.calls) == 2


@pytest.mark.asyncio
async def test_lru_eviction_keeps_cache_bounded():
    client = FakeClient()
    resolver = _resolver(client, ttl_seconds=60, max_entries=2)

    await resolver.resolve("ws-1", None)
    await resolver.resolve("ws-2", None)
    await resolver.resolve("ws-3", None)

    assert resolver.cache_size() == 2
    assert ("ws-1", "") not in resolver._cache
    assert ("ws-2", "") in resolver._cache
    assert ("ws-3", "") in resolver._cache
    assert snapshot_metrics()["evictions_total"] >= 1


@pytest.mark.asyncio
async def test_zero_max_entries_disables_cache():
    client = FakeClient()
    resolver = _resolver(client, ttl_seconds=60, max_entries=0)

    await resolver.resolve("ws-a", None)
    await resolver.resolve("ws-a", None)

    assert len(client.calls) == 2
    assert resolver.cache_size() == 0


@pytest.mark.asyncio
async def test_single_flight_shares_one_fetch():
    client = FakeClient()
    resolver = _resolver(client, ttl_seconds=60, max_entries=4)

    await asyncio.gather(
        resolver.resolve("ws-a", "u"),
        resolver.resolve("ws-a", "u"),
        resolver.resolve("ws-a", "u"),
    )

    assert len(client.calls) == 1


@pytest.mark.asyncio
async def test_failed_refresh_within_stale_window_serves_stale(monkeypatch):
    client = FakeClient(results={"rag": {"topK": "3"}})
    resolver = _resolver(client, ttl_seconds=10, max_entries=4)
    fresh = await resolver.resolve("ws-a", "u")

    object.__setattr__(fresh, "fetched_at", fresh.fetched_at - 15)
    client._failures = {"llm-provider": "unreachable"}
    stale = await resolver.resolve("ws-a", "u")

    assert stale.stale is True
    assert stale.entries["rag"] == {"topK": "3"}
    assert snapshot_metrics()["stale_total"] >= 1


@pytest.mark.asyncio
async def test_failed_refresh_beyond_stale_window_fails_closed():
    client = FakeClient()
    resolver = _resolver(client, ttl_seconds=10, max_entries=4)
    fresh = await resolver.resolve("ws-a", "u")

    object.__setattr__(fresh, "fetched_at", fresh.fetched_at - 25)
    client._failures = {"llm-provider": "unreachable"}
    with pytest.raises(ConfigSnapshotUnavailableError):
        await resolver.resolve("ws-a", "u")
    assert snapshot_metrics()["unavailable_total"] >= 1


@pytest.mark.asyncio
async def test_first_pull_failure_without_cache_fails_closed():
    client = FakeClient(failures={"llm-provider": "unauthorized"})
    resolver = _resolver(client, ttl_seconds=10, max_entries=4)

    with pytest.raises(ConfigSnapshotUnavailableError) as excinfo:
        await resolver.resolve("ws-a", "u")

    assert excinfo.value.code == "AGENT_CONFIG_SNAPSHOT_UNAVAILABLE"


@pytest.mark.asyncio
async def test_non_required_domain_failure_degrades_only_that_domain():
    client = FakeClient(results={"rag": {"topK": "7"}}, failures={"agent-runtime": "unreachable"})
    resolver = _resolver(client, ttl_seconds=10, max_entries=4)

    snapshot = await resolver.resolve("ws-a", "u")

    assert snapshot.degraded == ("agent-runtime",)
    assert snapshot.entries["agent-runtime"] == {}
    assert snapshot.entries["rag"] == {"topK": "7"}


@pytest.mark.asyncio
async def test_missing_domain_is_empty_not_degraded():
    client = FakeClient(failures={"context-policy": "missing"})
    resolver = _resolver(client, ttl_seconds=10, max_entries=4)

    snapshot = await resolver.resolve("ws-a", "u")

    assert snapshot.degraded == ()
    assert snapshot.entries["context-policy"] == {}


def test_merge_order_snapshot_then_user_then_workspace():
    snapshot = RunConfigSnapshot(
        workspace_id="ws",
        user_id="u",
        fetched_at=0.0,
        entries={"llm-provider": {"timeout": "30", "temperature": "0.9"}},
        revisions={},
    )

    merged = snapshot.merge(
        "llm-provider",
        {"llm-provider": {"temperature": "0.5", "maxTokens": "2048"}},
        {"llm-provider": {"temperature": "0.1"}},
    )

    assert merged == {"timeout": "30", "temperature": "0.1", "maxTokens": "2048"}
    # Merging must not mutate the frozen snapshot.
    assert snapshot.entries["llm-provider"]["temperature"] == "0.9"


def test_get_bool_treats_absent_as_false():
    snapshot = RunConfigSnapshot(
        workspace_id=None,
        user_id=None,
        fetched_at=0.0,
        entries={"agent-runtime": {"useSupervisor": "true", "useRegistry": "false"}},
        revisions={},
    )

    assert snapshot.get_bool("agent-runtime", "useSupervisor") is True
    assert snapshot.get_bool("agent-runtime", "useRegistry") is False
    assert snapshot.get_bool("agent-runtime", "unknown") is False


def test_process_config_snapshot_reads_process_cache():
    from xihe_agent.config_client import ConfigClient

    client = ConfigClient(cp_url="http://cp.invalid", api_token="t", workspace_id="ws-process")
    client._effective_cache = {"rag": {"topK": "4"}, "logging": {"levelAgent": "debug"}}

    snapshot = process_config_snapshot(client)

    assert snapshot.workspace_id == "ws-process"
    assert snapshot.entries["rag"] == {"topK": "4"}
    # Only run domains are carried; instance-only domains stay out of run snapshots.
    assert "logging" not in snapshot.entries
