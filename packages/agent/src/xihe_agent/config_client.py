import asyncio
import hashlib
import json
import time
from typing import Any, TypedDict

import httpx
from loguru import logger

# PLAN-0307 s13/s37: eight-domain set; layer-less effective fetch (decision #19).
CONFIG_DOMAINS = (
    "llm-provider",
    "context-policy",
    "embedding",
    "logging",
    "agent-runtime",
    "agent-profile",
    "user-preference",
    "rag",
)

# Domains required for the Agent to become llm-ready (fail-closed otherwise).
REQUIRED_DOMAINS = ("llm-provider",)

# PLAN-0632 D32-27 Step 1: the STARTUP-ONLY config-sync budget.
#
# Measured 2026-11-02 (PLAN-0632 T1, packaged Agent): with the CP reachable the startup sync
# costs 0.025 s; with the CP absent the shared defaults (3 s per domain x 3 attempts, 1 s + 2 s
# backoff) cost **58.46 s** before the Agent degrades — which the user experiences as a black
# screen and "the program is hung".
#
# These constants are deliberately SEPARATE from those defaults. Raising the shared retry
# behaviour to a small budget would turn "the CP was 1 s slow" into a permanent startup failure
# on the periodic refresh path, so the startup caller passes them explicitly instead
# (`main._sync_config`, called with reason="startup").
#
# Budget arithmetic: 2 rounds of one per-domain budget + 1 s backoff. Measured on this host
# (2026-11-02): 13.97 s while the domains were fetched serially, **2.65 s** after Step 1.5 made
# them concurrent (tests/unit/test_config_startup_budget.py prints both). NOTE why the old path
# cost 58.46 s: Windows needs ~2.03 s to report ECONNREFUSED on a localhost port (measured), so
# one serial attempt cost 8 x 2.03 s = 16.2 s and three attempts plus backoff landed at 58.46 s.
# The 3 s httpx timeout was never the binding constraint.
STARTUP_CONFIG_TIMEOUT_S = 0.8
STARTUP_CONFIG_RETRIES = 2


class DomainSyncResult(TypedDict):
    status: str
    revision: str
    source: str


class EffectiveDomainResult(TypedDict):
    """One effective-domain pull result (PLAN-0590 run snapshot, spec §3)."""

    status: str
    entries: dict[str, str] | None
    revision: str
    source: str


class SyncReport(TypedDict):
    ok: bool
    domains: dict[str, DomainSyncResult]
    revision: str
    refreshed: bool
    degraded: list[str]


def _classify_transport_error(exc: BaseException) -> str:
    """Name a transport failure for the operator log (no secrets, no untrusted body).

    Why classify the exception instead of the elapsed time: Windows takes ~2.03 s to answer
    ECONNREFUSED on a localhost port (measured 2026-11-02), so with a sub-second startup budget
    the wait is cancelled *before* the OS reports anything — "it returned quickly" cannot mean
    "nothing is listening".
    """
    if isinstance(exc, TimeoutError):
        return "budget-exhausted"
    if isinstance(exc, (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout)):
        return "connect-timeout"
    text = str(exc).lower()
    if "refused" in text or "10061" in text:
        return "refused"
    if isinstance(exc, httpx.ConnectError):
        return "connect-failed"
    return "transport-error"


def _sync_failure_verdict(report: SyncReport, error_kinds: set[str]) -> str:
    """Turn per-domain statuses + the transport errors observed into one operator-facing verdict.

    `error_kinds` is a set because the domains are fetched concurrently (PLAN-0632 D32-27
    Step 1.5), so one attempt can observe several kinds. Precedence goes from the most specific
    OS-level cause to the most generic, so the verdict keeps naming the real reason.
    """
    statuses = {entry["status"] for entry in report.get("domains", {}).values()}
    if "unauthorized" in statuses:
        return "cp-rejected-service-token"
    if "invalid_response" in statuses:
        return "cp-returned-invalid-payload"
    if statuses == {"unreachable"}:
        for kind, verdict in (
            ("refused", "cp-not-listening"),
            ("connect-timeout", "cp-slow-or-hung"),
            # A sub-second budget cannot see the OS error, so "not started" and "hung" share this
            # verdict; the attempt log line right before it carries the per-domain budget spent.
            ("budget-exhausted", "cp-no-accept-within-budget"),
            ("connect-failed", "cp-unreachable"),
        ):
            if kind in error_kinds:
                return verdict
        return "cp-unreachable"
    if not statuses:
        return "no-domains-fetched"
    return "partial-failure"


class ProviderLeaseError(RuntimeError):
    """Safe CP lease classification, without copying untrusted error detail."""

    def __init__(self, code: str, status: int):
        self.code = code
        self.status = status
        super().__init__(code)


class ConfigClient:
    """Fetches and caches the **effective** config from CP ConfigService.

    PLAN-0307 decision #19 (layer encapsulation): the Agent never selects layers.
    CP resolves `env > workspace > user > instance > code default` server-side and
    returns a single merged value set per domain (plus `revision` and `source`).

    Workspace scope: the process-level sync still binds one workspace (`workspace_id`)
    for instance/readiness consumers; PLAN-0590 run config instead resolves a
    per-run snapshot through `fetch_run_domains(workspace_id, user_id)` and never
    uses the process binding as a run base (spec/run-config-snapshot.md).

    Credentials are deliberately absent from this client (decision #21): config
    `llm-provider` carries only non-secret parameters. Provider keys come from
    the per-run lease (`redeem_provider_lease`) with an env offline fallback
    (`xihe_agent.llm.base.fallback_provider_configs`).
    """

    def __init__(self, cp_url: str, api_token: str, workspace_id: str | None = None):
        self.cp_url = cp_url
        self.api_token = api_token
        self.workspace_id = workspace_id
        self._effective_cache: dict[str, dict[str, str]] = {}
        self._last_fetch = 0.0
        self._config_revision = ""
        self._last_sync_report: SyncReport = {
            "ok": False,
            "domains": {},
            "revision": "",
            "refreshed": False,
            "degraded": [],
        }
        # PLAN-0632 D32-27 Step 1: transport failure kinds observed in the current attempt, for the
        # operator log only. A set (not a single value) because Step 1.5 fetches all eight domains
        # concurrently, so several fetches record a kind at once. Cleared per sync attempt.
        self._last_transport_error_kinds: set[str] = set()

    async def sync(self, timeout_s: float | None = None) -> SyncReport:
        """Refresh all effective domains.

        `timeout_s` caps ONE domain fetch. It is only used by the startup path (PLAN-0632
        D32-27 Step 1); the default `None` keeps the shared per-request `timeout=3` in
        `_fetch_effective` for the periodic refresh.
        """
        # CFG-2: seed the staged snapshot from the current cache so that a
        # transient failure of a non-required domain keeps its last known-good
        # values. The old code replaced the cache wholesale, silently dropping
        # (e.g.) rag/embedding/agent-runtime settings on a single blip.
        self._last_transport_error_kinds.clear()
        staged: dict[str, dict[str, str]] = {domain: dict(entries) for domain, entries in self._effective_cache.items()}
        domain_results: dict[str, DomainSyncResult] = {}
        revisions: list[str] = []
        degraded: list[str] = []

        # Internal CP only: never read env proxies (PLAN-0539) — `trust_env`
        # parses NO_PROXY entries and a malformed one aborts construction.
        async with httpx.AsyncClient(trust_env=False) as client:
            headers = {"Authorization": f"Bearer {self.api_token}"}
            # PLAN-0632 D32-27 Step 1.5: the eight domains are independent reads against the same
            # CP, so fetch them concurrently instead of one after another. This is what turns the
            # startup cost from `rounds x 8 x budget` (13.97 s) into `rounds x budget` (~2.6 s):
            # the 2.03 s Windows connect-refusal latency is paid once per round, in parallel.
            #
            # Why nothing here needs a serial slot: no domain's *fetch* consumes another domain's
            # result. `llm-provider` matters only for the fail-closed decision, which is evaluated
            # after the batch from `domain_results` (see REQUIRED_DOMAINS below), and the revision
            # is computed from everything at the end. If a future domain needs another's value to
            # build its request, keep it out of this gather and document why at that call site.
            #
            # `return_exceptions=True`: one broken domain must not cancel the other seven. An
            # exception is folded into exactly the transport-failure shape, so the downstream
            # fail-closed/degraded path is byte-for-byte the same as the serial version.
            outcomes = await asyncio.gather(
                *(self._fetch_domain(client, domain, headers, timeout_s) for domain in CONFIG_DOMAINS),
                return_exceptions=True,
            )
            # `zip(..., strict=True)` + gather's input-order results keep `domain_results`,
            # `staged`, `degraded` and `revisions` in CONFIG_DOMAINS order, i.e. identical to the
            # serial version (asserted by tests/unit/test_config_startup_budget.py).
            for domain, outcome in zip(CONFIG_DOMAINS, outcomes, strict=True):
                if isinstance(outcome, BaseException):
                    logger.warning(
                        "ConfigClient: domain fetch raised domain={} kind={} error={}",
                        domain,
                        _classify_transport_error(outcome),
                        outcome,
                    )
                    self._last_transport_error_kinds.add(_classify_transport_error(outcome))
                    status, data, revision, source = "unreachable", None, "", ""
                else:
                    status, data, revision, source = outcome
                domain_results[domain] = {
                    "status": status,
                    "revision": revision,
                    "source": source,
                }
                if data is not None:
                    staged[domain] = data
                elif status == "missing":
                    # A definitive "no config for this domain" answer clears it.
                    staged.pop(domain, None)
                else:
                    # Transport-ish failure: keep the carried-over snapshot and
                    # surface the domain as degraded.
                    degraded.append(domain)
                if revision:
                    revisions.append(revision)

        required_statuses = [
            domain_results[domain]["status"] if domain in domain_results else "missing" for domain in REQUIRED_DOMAINS
        ]
        transport_failure = any(
            status in {"unreachable", "unauthorized", "invalid_response"} for status in required_statuses
        )
        revision = self._calculate_revision(staged, revisions)
        report: SyncReport = {
            "ok": not transport_failure,
            "domains": domain_results,
            "revision": revision,
            "refreshed": not transport_failure,
            "degraded": degraded,
        }

        if report["refreshed"]:
            self._effective_cache = staged
            self._last_fetch = time.time()
            self._config_revision = revision
            if degraded:
                logger.warning(
                    "ConfigClient: synced effective domains={} degraded={} revision={} workspaceBound={} llmStatus={}",
                    len(self._effective_cache),
                    degraded,
                    self._config_revision,
                    bool(self.workspace_id),
                    required_statuses,
                )
            else:
                logger.info(
                    "ConfigClient: synced effective domains={} revision={} workspaceBound={} llmStatus={}",
                    len(self._effective_cache),
                    self._config_revision,
                    bool(self.workspace_id),
                    required_statuses,
                )
        else:
            logger.error(
                "ConfigClient: required effective refresh failed statuses={} revision={} keeping previous snapshot",
                required_statuses,
                self._config_revision,
            )

        self._last_sync_report = report
        return report

    async def _fetch_domain(
        self,
        client: httpx.AsyncClient,
        domain: str,
        headers: dict[str, str],
        timeout_s: float | None,
    ) -> tuple[str, dict[str, str] | None, str, str]:
        """One domain fetch, optionally capped by the startup budget.

        Why wrap instead of changing the request timeout: `timeout=3` in `_fetch_effective` is
        the right default for the periodic refresh (a CP that is one second slow must be
        retried, not declared dead), while startup needs a much smaller budget so a missing CP
        cannot cost the user a minute. Wrapping keeps both honest without touching the default.

        A hit budget is reported exactly like a transport failure ("unreachable"), so the
        fail-closed -> degraded path downstream is unchanged.
        """
        if timeout_s is None:
            return await self._fetch_effective(client, domain, headers, workspace_id=self.workspace_id)
        try:
            return await asyncio.wait_for(
                self._fetch_effective(client, domain, headers, workspace_id=self.workspace_id),
                timeout=timeout_s,
            )
        except TimeoutError:
            self._last_transport_error_kinds.add("budget-exhausted")
            logger.warning(
                "ConfigClient: startup fetch budget exhausted domain={} budget={}s (counted as unreachable)",
                domain,
                timeout_s,
            )
            return "unreachable", None, "", ""

    async def _fetch_effective(
        self,
        client: httpx.AsyncClient,
        domain: str,
        headers: dict[str, str],
        workspace_id: str | None = None,
        user_id: str | None = None,
    ) -> tuple[str, dict[str, str] | None, str, str]:
        params: dict[str, str] = {}
        if workspace_id:
            params["workspaceId"] = workspace_id
        if user_id:
            params["userId"] = user_id
        try:
            resp = await client.get(
                f"{self.cp_url}/internal/v1/config/effective/{domain}",
                headers=headers,
                params=params,
                timeout=3,
            )
        except Exception as exc:
            kind = _classify_transport_error(exc)
            self._last_transport_error_kinds.add(kind)
            logger.warning(
                "ConfigClient: failed to fetch effective domain={} status=unreachable kind={} error={}",
                domain,
                kind,
                exc,
            )
            return "unreachable", None, "", ""

        if resp.status_code == 400:
            logger.warning(
                "ConfigClient: effective domain={} status=invalid_domain httpStatus=400",
                domain,
            )
            return "invalid_response", None, "", ""
        if resp.status_code == 404:
            return "missing", None, "", ""
        if resp.status_code in (401, 403):
            logger.warning(
                "ConfigClient: effective domain={} status=unauthorized httpStatus={}",
                domain,
                resp.status_code,
            )
            return "unauthorized", None, "", ""
        if resp.status_code != 200:
            logger.warning(
                "ConfigClient: effective domain={} status=unreachable httpStatus={}",
                domain,
                resp.status_code,
            )
            return "unreachable", None, "", ""

        try:
            payload = resp.json()
        except Exception as exc:
            logger.warning(
                "ConfigClient: effective domain={} status=invalid_response error={}",
                domain,
                exc,
            )
            return "invalid_response", None, "", ""
        entries = payload.get("entries") if isinstance(payload, dict) else None
        if not isinstance(entries, dict) or not all(
            isinstance(key, str) and isinstance(value, str) for key, value in entries.items()
        ):
            logger.warning(
                "ConfigClient: effective domain={} status=invalid_response reason=entries_object_of_strings_required",
                domain,
            )
            return "invalid_response", None, "", ""
        revision = payload.get("revision")
        source = payload.get("source")
        return (
            "ok",
            entries,
            revision if isinstance(revision, str) else "",
            source if isinstance(source, str) else "",
        )

    @staticmethod
    def _calculate_revision(
        staged: dict[str, dict[str, str]],
        revisions: list[str],
    ) -> str:
        # Prefer CP-supplied revisions when present; fall back to a content hash.
        if revisions:
            payload = json.dumps(sorted(revisions), ensure_ascii=True).encode()
            return hashlib.sha256(payload).hexdigest()[:16]
        payload = json.dumps(
            staged,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        return hashlib.sha256(payload).hexdigest()[:16]

    async def sync_with_retry(self, max_retries: int = 3) -> SyncReport:
        """Retry `sync()` up to `max_retries` attempts with the shared per-domain timeout.

        This is the periodic-refresh entry point and it keeps the shared defaults on purpose:
        `max_retries = 3` and the `timeout=3` request budget mean a CP that is momentarily slow
        is retried instead of being declared dead. The startup path uses a deliberately separate
        entry point (`sync_with_retry_budget`) so neither budget can drift into the other.
        """
        return await self._sync_attempts(max_retries, None)

    async def sync_with_retry_budget(self, max_retries: int, timeout: float) -> SyncReport:
        """PLAN-0632 D32-27 Step 1: startup entry point with an explicit per-domain budget.

        Measured 2026-11-02: with the shared defaults an absent CP cost 58.46 s before the Agent
        degraded (Windows needs ~2.03 s per refused localhost connect; 8 domains x 3 attempts);
        with STARTUP_CONFIG_TIMEOUT_S / STARTUP_CONFIG_RETRIES it costs 13.97 s.

        Failure semantics are identical to `sync_with_retry` — the caller still converges to
        `degraded` (fail-closed), never "up with empty config".
        """
        return await self._sync_attempts(max_retries, timeout)

    async def _sync_attempts(self, max_retries: int, timeout: float | None) -> SyncReport:
        """Shared retry loop: `timeout=None` keeps the shared `timeout=3` request budget.

        Every failed attempt logs the attempt index, that attempt's budget and elapsed time, the
        cumulative elapsed time, and a verdict that separates "CP is not listening" from "CP is
        slow or hung" (both look identical in the domain status, so the transport error kind and
        the timing are the only signals an operator has).
        """
        started = time.monotonic()
        last_report = self._last_sync_report
        for attempt in range(max_retries):
            attempt_started = time.monotonic()
            try:
                last_report = await self.sync(timeout_s=timeout)
                if last_report["ok"]:
                    return last_report
            except Exception as e:
                logger.warning(
                    "ConfigClient: sync attempt {}/{} raised: {}",
                    attempt + 1,
                    max_retries,
                    e,
                )
            attempt_elapsed = time.monotonic() - attempt_started
            logger.warning(
                "ConfigClient: sync attempt {}/{} failed in {:.2f}s domainBudget={} cumulative={:.2f}s verdict={} statuses={}",
                attempt + 1,
                max_retries,
                attempt_elapsed,
                f"{timeout:.2f}s" if timeout is not None else "3s (shared default)",
                time.monotonic() - started,
                _sync_failure_verdict(last_report, set(self._last_transport_error_kinds)),
                {domain: entry["status"] for domain, entry in last_report["domains"].items()},
            )
            if attempt < max_retries - 1:
                await asyncio.sleep(2**attempt)
        last_llm_domain = last_report["domains"].get("llm-provider")
        logger.error(
            "ConfigClient: failed to sync after {} attempts in {:.2f}s domainBudget={} status={}",
            max_retries,
            time.monotonic() - started,
            f"{timeout:.2f}s" if timeout is not None else "3s (shared default)",
            last_llm_domain["status"] if last_llm_domain else "unknown",
        )
        return last_report

    def get_domain(self, domain: str) -> dict[str, str]:
        """Snapshot of the effective entries for one domain (empty when absent)."""
        return dict(self._effective_cache.get(domain, {}))

    def effective_entries(self) -> dict[str, dict[str, str]]:
        """Copy of the process-level effective cache (instance/readiness consumers)."""
        return {domain: dict(entries) for domain, entries in self._effective_cache.items()}

    async def fetch_run_domains(
        self,
        domains: "list[str] | tuple[str, ...]",
        *,
        workspace_id: str | None,
        user_id: str | None,
    ) -> dict[str, EffectiveDomainResult]:
        """Pull `(workspaceId, userId)`-scoped effective domains in one pass (PLAN-0590).

        Never falls back to the process-bound workspace: identity comes only from
        the caller, which takes it from the CP run payload (spec §3, I2).
        """
        headers = {"Authorization": f"Bearer {self.api_token}"}
        async with httpx.AsyncClient(trust_env=False) as client:
            fetched = await asyncio.gather(
                *[
                    self._fetch_effective(
                        client,
                        domain,
                        headers,
                        workspace_id=workspace_id,
                        user_id=user_id,
                    )
                    for domain in domains
                ]
            )
        results: dict[str, EffectiveDomainResult] = {}
        for domain, (status, entries, revision, source) in zip(domains, fetched):
            results[domain] = {
                "status": status,
                "entries": entries,
                "revision": revision,
                "source": source,
            }
        return results

    def get(self, domain: str, key: str) -> str | None:
        entries = self._effective_cache.get(domain)
        if entries is None:
            return None
        return entries.get(key)

    def get_bool(self, domain: str, key: str) -> bool:
        val = self.get(domain, key)
        return val is not None and val.lower() in ("true", "1", "yes")

    async def redeem_provider_lease(self, payload: dict[str, Any], *, request_id: str | None = None) -> dict[str, Any]:
        """Redeem a short-lived CP credential lease without persisting the key."""
        # Internal CP only: never read env proxies (PLAN-0539).
        async with httpx.AsyncClient(trust_env=False) as client:
            response = await client.post(
                f"{self.cp_url}/internal/v1/provider-leases/redeem",
                headers={
                    "Authorization": f"Bearer {self.api_token}",
                    **({"X-Request-Id": request_id} if request_id else {}),
                },
                json=payload,
                timeout=5,
            )
        if response.status_code >= 400:
            code = "PROVIDER_CONNECTION_UNAVAILABLE"
            try:
                problem = response.json()
                candidate = problem.get("code") if isinstance(problem, dict) else None
                if candidate in {
                    "STALE_PROVIDER_CONNECTION",
                    "PROVIDER_CREDENTIAL_LEASE_INVALID",
                    "API_TYPE_OPERATION_MISMATCH",
                    "PROVIDER_CONNECTION_UNAVAILABLE",
                }:
                    code = candidate
            except ValueError:
                logger.warning(
                    "ConfigClient: provider lease returned malformed problem status={}", response.status_code
                )
            logger.warning(
                "ConfigClient: provider lease redeem failed status={} code={}",
                response.status_code,
                code,
            )
            raise ProviderLeaseError(code, response.status_code)
        try:
            data = response.json()
        except ValueError as exc:
            raise ProviderLeaseError("PROVIDER_CONNECTION_UNAVAILABLE", 503) from exc
        if not isinstance(data, dict):
            raise ProviderLeaseError("PROVIDER_CONNECTION_UNAVAILABLE", 503)
        return data

    @property
    def last_fetch(self) -> float:
        return self._last_fetch

    @property
    def config_revision(self) -> str:
        return self._config_revision

    @property
    def last_sync_report(self) -> SyncReport:
        return self._last_sync_report
