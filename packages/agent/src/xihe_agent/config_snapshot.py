"""PLAN-0590: run-scoped effective config snapshot (spec/run-config-snapshot.md).

The Agent used to resolve per-run config from a process-wide effective snapshot
bound to the process workspace (`XIHE_WORKSPACE_ID`). A run for another workspace
therefore inherited the process workspace's layer. This module replaces that base
with a snapshot resolved from the run's own `(workspaceId, userId)` identity,
frozen for the run and shared through a bounded `(ws,user)` cache.

Invariants (spec §1): I1 single snapshot per run; I2 identity keys come from the
CP payload only; I3 missing keys fall back to instance/user/code defaults, never
to the process workspace snapshot; I4 bounded cache with TTL + LRU; I5 no
snapshot -> fail closed, stale snapshot -> bounded reuse + WARN.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from loguru import logger

from xihe_agent.config_client import ConfigClient

#: Domains with per-run Agent consumers (Lead decision #1: `embedding` removed —
#: the chat run path does not read it; RAG is request-scoped since PLAN-0485).
RUN_CONFIG_DOMAINS: tuple[str, ...] = (
    "llm-provider",
    "agent-profile",
    "rag",
    "agent-runtime",
    "context-policy",
)

SNAPSHOT_UNAVAILABLE_CODE = "AGENT_CONFIG_SNAPSHOT_UNAVAILABLE"

#: Effective-fetch statuses that mean "the domain could not be read".
_TRANSPORT_FAILURE_STATUSES = frozenset({"unreachable", "unauthorized", "invalid_response"})

DEFAULT_TTL_SECONDS = 60
DEFAULT_MAX_ENTRIES = 128

_metrics: dict[str, int] = {
    "resolved_total": 0,
    "stale_total": 0,
    "unavailable_total": 0,
    "evictions_total": 0,
}


def snapshot_metrics() -> dict[str, int]:
    """Process-lifetime counters (log-backed metrics, no external exporter)."""
    return dict(_metrics)


class ConfigSnapshotUnavailableError(RuntimeError):
    """The run cannot obtain a usable config snapshot (fail-closed, I5)."""

    code = SNAPSHOT_UNAVAILABLE_CODE

    def __init__(self, workspace_id: str | None, user_id: str | None, detail: str):
        super().__init__(detail)
        self.workspace_id = workspace_id or ""
        self.user_id = user_id or ""
        self.detail = detail


@dataclass(frozen=True)
class RunConfigSnapshot:
    """Immutable effective entries for one `(workspaceId, userId)` identity."""

    workspace_id: str | None
    user_id: str | None
    fetched_at: float
    entries: dict[str, dict[str, str]]
    revisions: dict[str, str]
    stale: bool = False
    degraded: tuple[str, ...] = ()

    def domain_entries(self, domain: str) -> dict[str, str]:
        return dict(self.entries.get(domain, {}))

    def get(self, domain: str, key: str) -> str | None:
        return self.entries.get(domain, {}).get(key)

    def get_bool(self, domain: str, key: str) -> bool:
        value = self.get(domain, key)
        return value is not None and value.lower() in ("true", "1", "yes")

    def merge(
        self,
        domain: str,
        user_overrides: Mapping[str, Mapping[str, str]] | None = None,
        workspace_overrides: Mapping[str, Mapping[str, str]] | None = None,
    ) -> dict[str, str]:
        """Snapshot -> user overrides -> workspace overrides (decision #3)."""
        merged = self.domain_entries(domain)
        if user_overrides:
            merged.update(user_overrides.get(domain, {}))
        if workspace_overrides:
            merged.update(workspace_overrides.get(domain, {}))
        return merged

    def age_seconds(self, now: float | None = None) -> float:
        return max(0.0, (time.monotonic() if now is None else now) - self.fetched_at)

    def as_stale(self) -> RunConfigSnapshot:
        return RunConfigSnapshot(
            workspace_id=self.workspace_id,
            user_id=self.user_id,
            fetched_at=self.fetched_at,
            entries=self.entries,
            revisions=self.revisions,
            stale=True,
            degraded=self.degraded,
        )


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("Ignoring invalid {} value {!r}; using default {}", name, raw, default)
        return default
    if value < 0:
        logger.warning("Ignoring negative {} value {}; using default {}", name, value, default)
        return default
    return value


def process_config_snapshot(client: ConfigClient) -> RunConfigSnapshot:
    """Snapshot of the process-wide config cache (instance/readiness paths only).

    Used by the periodic runtime refresh (log level, tokenizer ref, readiness) —
    never by a chat run, which must resolve its own snapshot (I1/I3).
    """
    all_entries = client.effective_entries()
    return RunConfigSnapshot(
        workspace_id=client.workspace_id,
        user_id=None,
        fetched_at=client.last_fetch,
        entries={domain: dict(all_entries.get(domain, {})) for domain in RUN_CONFIG_DOMAINS},
        revisions={},
        stale=False,
    )


class RunConfigResolver:
    """Resolves and caches per-`(ws,user)` snapshots with TTL, LRU and single-flight."""

    def __init__(
        self,
        client: ConfigClient,
        *,
        ttl_seconds: int | None = None,
        max_entries: int | None = None,
    ):
        self._client = client
        self._ttl = _env_int("XIHE_AGENT_CONFIG_SNAPSHOT_TTL_S", DEFAULT_TTL_SECONDS) if ttl_seconds is None else ttl_seconds
        self._max_entries = (
            _env_int("XIHE_AGENT_CONFIG_SNAPSHOT_MAX", DEFAULT_MAX_ENTRIES) if max_entries is None else max_entries
        )
        self._cache: OrderedDict[tuple[str, str], RunConfigSnapshot] = OrderedDict()
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    @property
    def ttl_seconds(self) -> int:
        return self._ttl

    @property
    def max_entries(self) -> int:
        return self._max_entries

    def cache_size(self) -> int:
        return len(self._cache)

    def clear(self) -> None:
        self._cache.clear()
        self._locks.clear()

    async def resolve(self, workspace_id: str | None, user_id: str | None) -> RunConfigSnapshot:
        """Return the frozen snapshot for this identity (cache hit or fresh fetch)."""
        key = (workspace_id or "", user_id or "")
        cached = self._cache.get(key)
        if cached is not None and self._is_fresh(cached):
            self._cache.move_to_end(key)
            self._log_resolved(cached, "hit")
            return cached

        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self._cache.get(key)
            if cached is not None and self._is_fresh(cached):
                self._cache.move_to_end(key)
                self._log_resolved(cached, "hit")
                return cached
            try:
                snapshot = await self._fetch(workspace_id, user_id)
            except ConfigSnapshotUnavailableError:
                stale = self._stale_fallback(key, workspace_id, user_id)
                if stale is not None:
                    return stale
                _metrics["unavailable_total"] += 1
                raise
            self._store(key, snapshot)
            self._log_resolved(snapshot, "miss", previous=cached)
            return snapshot

    def _is_fresh(self, snapshot: RunConfigSnapshot) -> bool:
        return self._max_entries > 0 and self._ttl > 0 and snapshot.age_seconds() <= self._ttl

    def _stale_fallback(
        self,
        key: tuple[str, str],
        workspace_id: str | None,
        user_id: str | None,
    ) -> RunConfigSnapshot | None:
        """Bounded stale reuse: only while age <= 2x TTL (Lead decision #2)."""
        cached = self._cache.get(key)
        if cached is None or self._max_entries <= 0 or self._ttl <= 0:
            return None
        age = cached.age_seconds()
        if age > self._ttl * 2:
            self._cache.pop(key, None)
            self._locks.pop(key, None)
            return None
        stale = cached.as_stale()
        _metrics["stale_total"] += 1
        logger.warning(
            "[LIFECYCLE] service=agent event=config_snapshot_stale workspaceId={} userId={} ageSeconds={} ttlSeconds={}",
            workspace_id or "none",
            user_id or "none",
            round(age, 1),
            self._ttl,
        )
        self._log_resolved(stale, "stale")
        return stale

    def _store(self, key: tuple[str, str], snapshot: RunConfigSnapshot) -> None:
        if self._max_entries <= 0:
            self._cache.clear()
            return
        self._cache[key] = snapshot
        self._cache.move_to_end(key)
        while len(self._cache) > self._max_entries:
            evicted, _ = self._cache.popitem(last=False)
            _metrics["evictions_total"] += 1
            if evicted not in self._cache:
                self._locks.pop(evicted, None)
            logger.info(
                "[LIFECYCLE] service=agent event=config_snapshot_evicted workspaceId={} userId={} entries={}",
                evicted[0] or "none",
                evicted[1] or "none",
                len(self._cache),
            )

    async def _fetch(self, workspace_id: str | None, user_id: str | None) -> RunConfigSnapshot:
        results = await self._client.fetch_run_domains(
            RUN_CONFIG_DOMAINS,
            workspace_id=workspace_id,
            user_id=user_id,
        )
        entries: dict[str, dict[str, str]] = {}
        revisions: dict[str, str] = {}
        degraded: list[str] = []
        for domain in RUN_CONFIG_DOMAINS:
            result = results.get(domain)
            status = result["status"] if result else "unreachable"
            if status == "ok" and result is not None:
                entries[domain] = dict(result["entries"] or {})
                revisions[domain] = result["revision"] or ""
            elif status == "missing":
                entries[domain] = {}
                revisions[domain] = ""
            else:
                if domain == "llm-provider":
                    # The run has no usable model config: fail closed (I5).
                    raise ConfigSnapshotUnavailableError(
                        workspace_id,
                        user_id,
                        f"effective pull failed for {domain} status={status}",
                    )
                degraded.append(domain)
                entries[domain] = {}
                revisions[domain] = ""
        if degraded:
            logger.warning(
                "[LIFECYCLE] service=agent event=config_snapshot_partial workspaceId={} userId={} domains={}",
                workspace_id or "none",
                user_id or "none",
                degraded,
            )
        return RunConfigSnapshot(
            workspace_id=workspace_id,
            user_id=user_id,
            fetched_at=time.monotonic(),
            entries=entries,
            revisions=revisions,
            stale=False,
            degraded=tuple(degraded),
        )

    def _log_resolved(
        self,
        snapshot: RunConfigSnapshot,
        cache_state: str,
        previous: RunConfigSnapshot | None = None,
    ) -> None:
        _metrics["resolved_total"] += 1
        changed = [
            domain
            for domain in RUN_CONFIG_DOMAINS
            if previous is not None and previous.revisions.get(domain) != snapshot.revisions.get(domain)
        ]
        logger.info(
            "[LIFECYCLE] service=agent event=config_snapshot_resolved workspaceId={} userId={} domains={} cache={} ageSeconds={} changedDomains={}",
            snapshot.workspace_id or "none",
            snapshot.user_id or "none",
            len(snapshot.entries),
            cache_state,
            round(snapshot.age_seconds(), 1),
            changed,
        )


__all__ = [
    "ConfigSnapshotUnavailableError",
    "DEFAULT_MAX_ENTRIES",
    "DEFAULT_TTL_SECONDS",
    "RUN_CONFIG_DOMAINS",
    "RunConfigResolver",
    "RunConfigSnapshot",
    "SNAPSHOT_UNAVAILABLE_CODE",
    "process_config_snapshot",
    "snapshot_metrics",
]


def _domains_tuple(domains: Sequence[str] | None = None) -> tuple[str, ...]:
    return tuple(domains) if domains is not None else RUN_CONFIG_DOMAINS
