"""PLAN-0588 M1–M3: ShardedMcpRegistry (per-workspace lock, failure semantics ①).

Covers the frozen contract (`spec/shard-registry-contract.md` §2/§3/§4/§5):
per-workspace lock + in-lock double check (I3a), cross-workspace parallelism
(I3b), failure-is-not-cached (①), LRU/idle reclamation, single-shard ``reinit``,
the read-only ``mcp_manager`` compat view, and the two observation shapes.
"""

import asyncio
import gc
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient

import xihe_agent.app_state as app_state
from xihe_agent.app_state import (
    McpCompatView,
    McpShard,
    McpShardNotFoundError,
    ShardedMcpRegistry,
)
from xihe_agent.main import app


class FakeTool:
    def __init__(self, name: str):
        self.spec = type("Spec", (), {"name": name, "description": f"{name} description"})()


class FakeManager:
    """MCPClientManager stand-in with an optional gate and failure switch."""

    def __init__(
        self,
        workspace_id: str,
        names: list[str] | None = None,
        gate: asyncio.Event | None = None,
    ):
        self.workspace_id = workspace_id
        self.tools: list[Any] = [FakeTool(name) for name in (names or [f"{workspace_id}-tool"])]
        self.initialize_calls: list[str | None] = []
        self.reinitialize_calls = 0
        self.fail = False
        self._gate = gate

    async def initialize(self, workspace_id: str | None = None) -> None:
        self.initialize_calls.append(workspace_id)
        if self._gate is not None:
            await self._gate.wait()
        if self.fail:
            raise OSError("runtime unavailable")

    async def reinitialize(self) -> None:
        self.reinitialize_calls += 1


def build_registry(
    managers: dict[str, FakeManager],
    **kwargs: Any,
) -> tuple[ShardedMcpRegistry, dict[str, int]]:
    created: dict[str, int] = {}

    def factory(workspace_id: str) -> FakeManager:
        created[workspace_id] = created.get(workspace_id, 0) + 1
        return managers[workspace_id]

    defaults: dict[str, Any] = {"max_shards": 16, "idle_ttl_s": 1800}
    defaults.update(kwargs)
    registry = ShardedMcpRegistry(factory=factory, **defaults)
    return registry, created


def install_shard(registry: ShardedMcpRegistry, workspace_id: str, names: list[str]) -> McpShard:
    """Insert a shard without discovery (route tests only)."""
    now = time.monotonic()
    shard = McpShard(manager=FakeManager(workspace_id, names), last_used=now, initialized_at=now)
    registry._shards[workspace_id] = shard
    return shard


# ── §2 lock granularity (I3a / I3b) ────────────────────────────────────────
@pytest.mark.asyncio
async def test_get_or_create_discovers_once_and_reuses_the_shard():
    manager = FakeManager("ws-a")
    registry, created = build_registry({"ws-a": manager})

    first = await registry.get_or_create("ws-a")
    second = await registry.get_or_create("ws-a")

    assert first is second
    assert manager.initialize_calls == ["ws-a"]
    assert created == {"ws-a": 1}
    assert registry.shard_count() == 1


@pytest.mark.asyncio
async def test_concurrent_first_calls_for_one_workspace_share_one_discovery():
    manager = FakeManager("ws-a")
    registry, created = build_registry({"ws-a": manager})

    shards = await asyncio.gather(*[registry.get_or_create("ws-a") for _ in range(5)])

    assert len({id(shard) for shard in shards}) == 1
    assert manager.initialize_calls == ["ws-a"], "R1: per-workspace lock merges concurrent first calls"
    assert created == {"ws-a": 1}


@pytest.mark.asyncio
async def test_slow_discovery_of_one_workspace_does_not_block_another():
    """I3b: B's first call must not wait for A's slow discovery (no global lock)."""

    class SlowManager(FakeManager):
        async def initialize(self, workspace_id: str | None = None) -> None:
            await asyncio.sleep(0.3)
            await super().initialize(workspace_id)

    slow = SlowManager("ws-a")
    fast = FakeManager("ws-b")
    registry, _ = build_registry({"ws-a": slow, "ws-b": fast})

    slow_task = asyncio.create_task(registry.get_or_create("ws-a"))
    await asyncio.sleep(0.02)  # let A enter its own lock/initialize
    started = time.monotonic()
    shard_b = await asyncio.wait_for(registry.get_or_create("ws-b"), timeout=1.0)
    elapsed_b = time.monotonic() - started

    assert shard_b.manager is fast
    # V1 lock-granularity judgment: B's cost is its own discovery, not A's 300 ms.
    assert elapsed_b < 0.15, f"B waited {elapsed_b:.3f}s on A's slow discovery"
    assert not slow_task.done()

    await asyncio.wait_for(slow_task, timeout=1.0)
    assert registry.shard_count() == 2


@pytest.mark.asyncio
async def test_default_factory_wires_the_call_tool_touch_hook():
    registry = ShardedMcpRegistry(max_shards=4, idle_ttl_s=60)

    manager = registry._default_factory("ws-a")

    assert manager.workspace_id == "ws-a"
    assert manager._on_use is not None


# ── §3.2 failure semantics ① ───────────────────────────────────────────────
@pytest.mark.asyncio
async def test_failed_discovery_stores_nothing_and_retries_without_cooldown():
    failing = FakeManager("ws-a")
    failing.fail = True
    registry, created = build_registry({"ws-a": failing})

    with pytest.raises(OSError):
        await registry.get_or_create("ws-a")

    assert registry.shard_count() == 0, "failure must not enter the table"
    assert registry.stats()["initFailures"] == 1

    failing.fail = False
    shard = await registry.get_or_create("ws-a")

    assert shard.manager is failing
    assert created == {"ws-a": 2}, "no failure cache: the next call rediscovers"
    assert registry.shard_count() == 1


@pytest.mark.asyncio
async def test_concurrent_first_calls_after_a_failure_each_retry():
    """Failure semantics ①: no shared failure object; the waiter rediscovers."""

    class FlakyManager(FakeManager):
        def __init__(self, workspace_id: str):
            super().__init__(workspace_id)
            self.calls = 0

        async def initialize(self, workspace_id: str | None = None) -> None:
            self.calls += 1
            await super().initialize(workspace_id)
            if self.calls == 1:
                raise OSError("first discovery failed")

    flaky = FlakyManager("ws-a")
    registry, created = build_registry({"ws-a": flaky})

    results = await asyncio.gather(
        registry.get_or_create("ws-a"),
        registry.get_or_create("ws-a"),
        return_exceptions=True,
    )

    failures = [item for item in results if isinstance(item, Exception)]
    successes = [item for item in results if not isinstance(item, Exception)]
    assert len(failures) == 1, "the lock leader surfaces its own failure"
    assert len(successes) == 1, "the waiter retries instead of sharing the failure"
    assert created == {"ws-a": 2}
    assert registry.shard_count() == 1


@pytest.mark.asyncio
async def test_failure_of_one_workspace_does_not_affect_another():
    bad = FakeManager("ws-bad")
    bad.fail = True
    good = FakeManager("ws-good")
    registry, _ = build_registry({"ws-bad": bad, "ws-good": good})

    with pytest.raises(OSError):
        await registry.get_or_create("ws-bad")

    shard = await registry.get_or_create("ws-good")

    assert shard.manager is good
    assert registry.workspace_ids() == ["ws-good"], "a failed workspace leaves no entry behind"


# ── R3 hardening: the lock table must not accumulate entries ───────────────
@pytest.mark.asyncio
async def test_failed_discovery_does_not_leak_lock_entries():
    """R3 hardening: a never-succeeding workspace leaves no Lock behind."""

    def factory(workspace_id: str) -> FakeManager:
        manager = FakeManager(workspace_id)
        manager.fail = True
        return manager

    registry = ShardedMcpRegistry(factory=factory, max_shards=16, idle_ttl_s=1800)

    for index in range(100):
        with pytest.raises(OSError):
            await registry.get_or_create(f"ws-fail-{index}")

    gc.collect()
    assert registry.shard_count() == 0
    assert len(registry._locks) == 0, "failure paths must not accumulate lock entries"


@pytest.mark.asyncio
async def test_unknown_workspace_reinitialize_does_not_leak_lock_entries():
    """R3 hardening: ``/reinit?workspaceId=<ghost>`` accepts any string."""

    registry, _ = build_registry({})

    for index in range(100):
        with pytest.raises(McpShardNotFoundError):
            await registry.reinitialize(f"ghost-{index}")

    gc.collect()
    assert len(registry._locks) == 0, "unknown-workspace reinit must not accumulate locks"


@pytest.mark.asyncio
async def test_waiter_shares_the_same_lock_object_for_one_workspace():
    """R1: the self-pruning lock table must never hand out two locks per ws."""
    gate = asyncio.Event()
    slow = FakeManager("ws-a", gate=gate)
    registry, _ = build_registry({"ws-a": slow})

    leader = asyncio.create_task(registry.get_or_create("ws-a"))
    for _ in range(50):
        held = registry._locks.get("ws-a")
        if held is not None and held.locked():
            break
        await asyncio.sleep(0)
    else:
        raise AssertionError("leader never acquired the workspace lock")

    leader_lock = registry._locks["ws-a"]
    waiter = asyncio.create_task(registry.get_or_create("ws-a"))
    await asyncio.sleep(0)
    assert registry._locks.get("ws-a") is leader_lock, "waiter must reuse the leader's lock"

    gate.set()
    await asyncio.gather(leader, waiter)
    assert registry.shard_count() == 1


# ── §3.3 reclamation ──────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_max_shards_evicts_lru_entry_and_its_lock():
    managers = {ws: FakeManager(ws) for ws in ("ws-1", "ws-2", "ws-3")}
    registry, _ = build_registry(managers, max_shards=2)

    await registry.get_or_create("ws-1")
    await registry.get_or_create("ws-2")
    await registry.get_or_create("ws-3")

    assert registry.shard_count() == 2
    assert registry.workspace_ids() == ["ws-2", "ws-3"]
    assert "ws-1" not in registry._locks, "R3: lock entries never outlive their shard"

    # The evicted workspace rediscovers on its next request.
    await registry.get_or_create("ws-1")
    assert managers["ws-1"].initialize_calls == ["ws-1", "ws-1"]
    assert registry.shard_count() == 2


@pytest.mark.asyncio
async def test_touch_moves_the_workspace_out_of_eviction_range():
    managers = {ws: FakeManager(ws) for ws in ("ws-1", "ws-2", "ws-3")}
    registry, _ = build_registry(managers, max_shards=2)

    await registry.get_or_create("ws-1")
    await registry.get_or_create("ws-2")
    registry.touch("ws-1")
    await registry.get_or_create("ws-3")

    assert registry.workspace_ids() == ["ws-1", "ws-3"]


@pytest.mark.asyncio
async def test_idle_ttl_is_enforced_on_the_next_get_or_create():
    managers = {"ws-old": FakeManager("ws-old"), "ws-new": FakeManager("ws-new")}
    registry, _ = build_registry(managers, max_shards=4, idle_ttl_s=1)

    await registry.get_or_create("ws-old")
    registry._shards["ws-old"].last_used = time.monotonic() - 5

    await registry.get_or_create("ws-new")

    assert registry.workspace_ids() == ["ws-new"], "idle shard reclaimed lazily (no timer)"


@pytest.mark.asyncio
async def test_evicted_shard_manager_stays_usable_for_in_flight_tools():
    """I4: reclamation only drops registry entries; a held manager keeps working."""
    manager = FakeManager("ws-a")
    registry, _ = build_registry({"ws-a": manager, "ws-b": FakeManager("ws-b")}, max_shards=1)

    shard = await registry.get_or_create("ws-a")
    await registry.get_or_create("ws-b")

    assert registry.workspace_ids() == ["ws-b"]
    await shard.manager.initialize(workspace_id="ws-a")  # in-flight caller still works
    assert shard.manager.tools


# ── §3.5 reinit paths ─────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_reinitialize_one_shard_only():
    managers = {"ws-a": FakeManager("ws-a"), "ws-b": FakeManager("ws-b")}
    registry, _ = build_registry(managers)
    await registry.get_or_create("ws-a")
    await registry.get_or_create("ws-b")

    reinitialized = await registry.reinitialize("ws-a")

    assert reinitialized == ["ws-a"]
    assert managers["ws-a"].reinitialize_calls == 1
    assert managers["ws-b"].reinitialize_calls == 0


@pytest.mark.asyncio
async def test_reinitialize_unknown_workspace_raises_shard_not_found():
    registry, _ = build_registry({})

    with pytest.raises(McpShardNotFoundError) as excinfo:
        await registry.reinitialize("ws-missing")

    assert excinfo.value.code == "MCP_SHARD_NOT_FOUND"


@pytest.mark.asyncio
async def test_reinitialize_all_shards():
    managers = {"ws-a": FakeManager("ws-a"), "ws-b": FakeManager("ws-b")}
    registry, _ = build_registry(managers)
    await registry.get_or_create("ws-a")
    await registry.get_or_create("ws-b")

    reinitialized = await registry.reinitialize()

    assert sorted(reinitialized) == ["ws-a", "ws-b"]
    assert managers["ws-a"].reinitialize_calls == 1
    assert managers["ws-b"].reinitialize_calls == 1


# ── §5 compat view ────────────────────────────────────────────────────────
def test_compat_view_is_read_only_over_the_first_shard():
    registry = ShardedMcpRegistry(max_shards=4, idle_ttl_s=60, factory=lambda ws: FakeManager(ws))
    view = McpCompatView(registry)

    assert view.initialized is False
    assert view.tools == []
    assert view.workspace_id is None
    assert not hasattr(view, "initialize"), "compat view must not offer lifecycle calls"
    assert not hasattr(view, "reinitialize")

    install_shard(registry, "ws-a", ["tool-a"])

    assert view.initialized is True
    assert view.workspace_id == "ws-a"
    assert [tool.spec.name for tool in view.tools] == ["tool-a"]


def test_aggregate_tool_names_deduplicates_without_workspace_ids():
    registry = ShardedMcpRegistry(max_shards=4, idle_ttl_s=60, factory=lambda ws: FakeManager(ws))
    install_shard(registry, "ws-a", ["shared", "only-a"])
    install_shard(registry, "ws-b", ["shared", "only-b"])

    assert sorted(registry.aggregate_tool_names()) == ["only-a", "only-b", "shared"]
    assert registry.stats()["shards"] == 2


# ── §4.1/§4.2 observation shapes ──────────────────────────────────────────
def _client() -> TestClient:
    return TestClient(app)


def _auth() -> dict[str, str]:
    return {"Authorization": "Bearer dev-token-not-secure"}


@pytest.fixture()
def route_registry(monkeypatch: pytest.MonkeyPatch) -> ShardedMcpRegistry:
    registry = ShardedMcpRegistry(max_shards=4, idle_ttl_s=60, factory=lambda ws: FakeManager(ws))
    monkeypatch.setattr(app_state, "mcp_shard_registry", registry)
    monkeypatch.delenv("XIHE_WORKSPACE_ID", raising=False)
    return registry


def test_health_reports_counts_and_never_workspace_ids(route_registry: ShardedMcpRegistry) -> None:
    install_shard(route_registry, "ws-a", ["tool-a"])
    install_shard(route_registry, "ws-b", ["tool-b"])

    response = _client().get("/internal/v1/agent/health")

    assert response.status_code == 200
    body = response.json()
    assert body["mcpShards"] == 2
    assert body["mcpInitialized"] is True
    assert body["toolsCount"] == 2
    # I8 hardening (2026-10-31): unauthenticated route exposes counts only; a
    # cross-shard name list would disclose each tenant's MCP integrations.
    assert "tools" not in body, "unauth /health must not return tool names (I8)"
    assert "tool-a" not in response.text and "tool-b" not in response.text
    assert "ws-a" not in response.text and "ws-b" not in response.text


def test_health_startup_state_is_boolean_false(route_registry: ShardedMcpRegistry) -> None:
    body = _client().get("/internal/v1/agent/health").json()

    assert body["mcpInitialized"] is False
    assert body["mcpShards"] == 0
    assert body["toolsCount"] == 0
    assert "tools" not in body, "unauth /health must not return tool names (I8)"
    assert isinstance(body["mcpInitialized"], bool)


def test_tools_without_workspace_and_without_env_requires_workspace(
    route_registry: ShardedMcpRegistry,
) -> None:
    install_shard(route_registry, "ws-a", ["tool-a"])

    response = _client().get("/internal/v1/agent/tools", headers=_auth())

    assert response.status_code == 200
    body = response.json()
    assert body["tools"] == [], "must not return the union of shards (I8)"
    assert body["workspaceRequired"] is True
    assert body["customTools"]


def test_tools_for_a_known_workspace_returns_only_that_shard(
    route_registry: ShardedMcpRegistry,
) -> None:
    install_shard(route_registry, "ws-a", ["tool-a"])
    install_shard(route_registry, "ws-b", ["tool-b"])

    body = (
        _client()
        .get("/internal/v1/agent/tools?workspaceId=ws-a", headers=_auth())
        .json()
    )

    assert [tool["name"] for tool in body["tools"]] == ["tool-a"]
    assert body["workspaceId"] == "ws-a"


def test_tools_for_unknown_workspace_is_shard_not_found(
    route_registry: ShardedMcpRegistry,
) -> None:
    response = _client().get("/internal/v1/agent/tools?workspaceId=ws-missing", headers=_auth())

    assert response.status_code == 404
    assert response.json()["code"] == "MCP_SHARD_NOT_FOUND"


def test_reinit_unknown_workspace_is_shard_not_found(route_registry: ShardedMcpRegistry) -> None:
    response = _client().post(
        "/internal/v1/agent/mcp/reinit?workspaceId=ws-missing",
        headers=_auth(),
    )

    assert response.status_code == 404
    assert response.json()["code"] == "MCP_SHARD_NOT_FOUND"


def test_reinit_without_workspace_reinitializes_every_shard(
    route_registry: ShardedMcpRegistry,
) -> None:
    install_shard(route_registry, "ws-a", ["tool-a"])
    install_shard(route_registry, "ws-b", ["tool-b"])

    response = _client().post("/internal/v1/agent/mcp/reinit", headers=_auth())

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["shards"] == 2
    assert sorted(body["tools"]) == ["tool-a", "tool-b"]
