/**
 * task-180 (PLAN-0632 T4.4 follow-up): path-layered wait budget for `dev:host:wait-for-cp`.
 *
 * Why this module exists: the 60 s window was sized for a **warm** CP. When `stack-run.mjs cp`
 * decides the classes are not from HEAD (stale/missing/dirty build-info stamp) it runs
 * `mvn -DskipTests clean compile` first, and the boot then runs its own test-compile — while
 * runtime may be cargo-compiling on the same machine. 2026-11-11 (task-178 event ①) stack-1's
 * first start died exactly there: `CP NOT ready on 127.0.0.1:12631 after 60.0 s (ECONNREFUSED)`.
 *
 * The budget is selected from the **pre-start build verdict**, read with the same libs
 * (`cp-build-info.mjs` + `cp-build-dir.mjs`) that stack-run uses to decide the rebuild — one
 * implementation of "are these classes from HEAD":
 *
 *   fresh                → reuse path   (REUSE_BUDGET_SECONDS, today's fast restart)
 *   stale/missing/dirty  → rebuild path (DEFAULT_REBUILD_BUDGET_SECONDS)
 *   unverified / no git  → reuse path   (stack-run WARNs and boots as-is, no clean compile)
 *   probe failed         → rebuild path (cannot prove freshness ⇒ assume a rebuild)
 *
 * Overrides (both in **seconds**, matching the pre-existing env semantics):
 *   XIHE_WAIT_FOR_CP_TIMEOUT         — explicit override for BOTH paths (name/semantics unchanged)
 *   XIHE_WAIT_FOR_CP_REBUILD_TIMEOUT — new: rebuild path only; reuse path stays 60 s
 *
 * Invalid values are a hard error in the caller (exit 2) rather than silently expiring the wait:
 * the old `Math.max(1, Number(...))` turned a typo into NaN, so the loop never ran and CP was
 * reported "not ready" after one poll tick.
 */

/** Existing override: wins for both paths (kept for compatibility). */
export const WAIT_TIMEOUT_ENV = "XIHE_WAIT_FOR_CP_TIMEOUT";

/** New rebuild-path-only override. */
export const REBUILD_TIMEOUT_ENV = "XIHE_WAIT_FOR_CP_REBUILD_TIMEOUT";

/** Reuse path: the stack boots classes that are already stamped from HEAD. */
export const REUSE_BUDGET_SECONDS = 60;

/**
 * Rebuild path: `clean compile` + the boot's own test-compile (+ possible cargo contention).
 *
 * Evidence used to pick 240 s (task-180, 2026-11-11) — only the first number is measured:
 *   measured  `mvn -o -q -DskipTests clean test-compile` = **22.5 s** (C: build dir, warm maven
 *             repo, no competing compile);
 *   estimated the boot's test-compile + Spring context + Flyway + web-server readiness and
 *             the cargo-contention factor are NOT yet measured end-to-end — the real-start
 *             evidence (rebuild path) records the actual end-to-end time; if that lands far
 *             from ~240 s this constant gets re-tuned with the measured value, not a guess;
 *   observed  the old fixed 60 s window was not enough for the rebuild path on 2026-11-11
 *             (task-178 event ①: ECONNREFUSED after 60.0 s while runtime was cargo-compiling).
 * 240 s is therefore a deliberate upper bound (~22.5 s × 10), not a claim about the real total.
 */
export const DEFAULT_REBUILD_BUDGET_SECONDS = 240;

const REBUILD_VERDICTS = new Set(["stale", "missing", "dirty"]);

/**
 * Which budget family applies, from the pre-start freshness verdict.
 *
 * @param {{status?: string}|null|undefined} freshness verdict from `evaluateCpFreshness`
 * @returns {"rebuild"|"reuse"}
 */
export function classifyBuildPath(freshness) {
    const status = typeof freshness?.status === "string" ? freshness.status : "";
    if (status === "fresh") return "reuse";
    if (REBUILD_VERDICTS.has(status)) return "rebuild";
    if (status === "unverified") return "reuse";
    // No verdict at all (probe failure) ⇒ assume the expensive path: a too-long wait is
    // recoverable, a too-short one aborts `dev:host` exactly like task-178.
    return "rebuild";
}

function positiveSeconds(raw, name) {
    if (raw === undefined || raw === null || String(raw).trim() === "") return null;
    const text = String(raw).trim();
    // Number() accepts "1e3"/" 12 " but also "Infinity"; reject anything non-finite or <= 0.
    if (!/^[0-9]*\.[0-9]+$|^[0-9]+(\.0*)?$/u.test(text)) {
        throw new Error(`invalid ${name}=${JSON.stringify(text)}: expected a positive number of seconds`);
    }
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`invalid ${name}=${JSON.stringify(text)}: expected a positive number of seconds`);
    }
    return seconds;
}

/**
 * Select the wait budget. Pure function: no env reads beyond the passed object, no clock, no I/O.
 *
 * @param {{env?: Record<string, string|undefined>, freshness?: {status?: string}|null}} input
 * @returns {{timeoutMs: number, seconds: number, path: "rebuild"|"reuse", source: string}}
 */
export function selectWaitBudget({ env = process.env, freshness = null } = {}) {
    const path = classifyBuildPath(freshness);
    const common = positiveSeconds(env[WAIT_TIMEOUT_ENV], WAIT_TIMEOUT_ENV);
    const rebuildOnly = positiveSeconds(env[REBUILD_TIMEOUT_ENV], REBUILD_TIMEOUT_ENV);
    if (common !== null) {
        return { timeoutMs: common * 1000, seconds: common, path, source: `${WAIT_TIMEOUT_ENV} (both paths)` };
    }
    if (path === "reuse") {
        return { timeoutMs: REUSE_BUDGET_SECONDS * 1000, seconds: REUSE_BUDGET_SECONDS, path, source: "default reuse budget" };
    }
    if (rebuildOnly !== null) {
        return { timeoutMs: rebuildOnly * 1000, seconds: rebuildOnly, path, source: REBUILD_TIMEOUT_ENV };
    }
    return {
        timeoutMs: DEFAULT_REBUILD_BUDGET_SECONDS * 1000,
        seconds: DEFAULT_REBUILD_BUDGET_SECONDS,
        path,
        source: "default rebuild budget",
    };
}

/**
 * Human-readable one-liner for the launcher log: why this budget was picked.
 *
 * @param {{path: string, seconds: number, source: string}} budget
 * @param {{status?: string, reason?: string}|null} freshness
 * @returns {string}
 */
export function describeBudget(budget, freshness) {
    const status = typeof freshness?.status === "string" ? freshness.status : "unknown";
    const reason = typeof freshness?.reason === "string" && freshness.reason ? freshness.reason : "no freshness verdict";
    return `build path ${budget.path} → budget ${budget.seconds.toFixed(1)}s`
        + ` (source: ${budget.source}; freshness: ${status} — ${reason})`;
}
