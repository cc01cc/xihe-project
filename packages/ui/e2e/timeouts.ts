// task-252: the single timeout budget for Playwright E2E.
//
// User ruling 2026-11-08: E2E waits are budgeted so a slow/broken step fails in seconds instead
// of minutes. Defaults: action/assertion 10 s, whole-test 30 s, and a `LONG_TIMEOUT_MS` escape
// hatch (30 s) that may only be used with a `// timeout-exempt: <reason>` marker (hard cap 60 s,
// enforced by scripts/check-e2e-timeouts.mjs).
//
// Every value is env-overridable (E2E_*_TIMEOUT_MS) for slow machines/CI lanes; the override is
// read at process start, so `E2E_ACTION_TIMEOUT_MS=5000 pnpm exec playwright test` tightens a run
// without editing code.
const envMs = (name: string, fallbackMs: number): number => {
    const raw = process.env[name];
    if (!raw) return fallbackMs;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
};

/** Budget for actions (click, fill, waitForEvent, ...): default 10 s. */
export const ACTION_TIMEOUT_MS = envMs("E2E_ACTION_TIMEOUT_MS", 10_000);

/** Budget for assertions (`expect(...).toBeVisible`, `expect.poll`): default 10 s. */
export const EXPECT_TIMEOUT_MS = envMs("E2E_EXPECT_TIMEOUT_MS", 10_000);

/** Whole-test budget (`test.setTimeout` / Playwright `timeout`): default 30 s. */
export const TEST_TIMEOUT_MS = envMs("E2E_TEST_TIMEOUT_MS", 30_000);

/**
 * Reviewed escape hatch for a genuinely long E2E step (real provider turn, multi-phase boot):
 * default 30 s, hard cap 60 s in the budget gate. Only legal together with
 * `// timeout-exempt: <reason>`.
 */
export const LONG_TIMEOUT_MS = envMs("E2E_LONG_TIMEOUT_MS", 30_000);

/** Upper bound the budget gate accepts for an exempted literal. */
export const LONG_TIMEOUT_CAP_MS = 60_000;

/** Playwright `webServer` start budget (the UI dev server, not a test wait): default 120 s. */
export const SERVER_START_TIMEOUT_MS = envMs("E2E_SERVER_START_TIMEOUT_MS", 120_000);
