---
title: DEV-020 - E2E Test Strategy and Screenshot Plan
category: dev-guide
sidebar_order: 20
lang: en
sidebar_group: "Developer Guide"
---

# DEV-020: E2E Test Strategy and Screenshot Plan

> Persistent documentation for xihe project E2E test architecture design, Playwright configuration, screenshot strategy, and directory standards.

## 1. Test Architecture

### 1.1 Two-Layer Separation

E2E tests are split into mock and real layers, located in `packages/ui/e2e/`:

```
e2e/
├── playwright.config.ts      # Playwright global configuration
├── helpers/
│   └── auth.ts              # setupMockAuth: uniform mock for /api/v1/** auth
├── mock/                     # Mock mode: page.route() intercepts APIs, no backend needed
│   ├── aria-label.spec.ts
│   ├── base-modal.spec.ts
│   ├── chat-attachment.spec.ts
│   ├── chat-scroll.spec.ts
│   ├── chat.spec.ts
│   ├── config-settings.spec.ts
│   ├── confirm-modal.spec.ts
│   ├── data-controls.spec.ts
│   ├── i18n-switch.spec.ts
│   ├── knowledge-base.spec.ts
│   ├── login.spec.ts
│   ├── model-popover.spec.ts
│   ├── prefers-reduced-motion.spec.ts
│   ├── screenshots.spec.ts   # Full route screenshot traversal
│   ├── session-management.spec.ts
│   ├── session-switch.spec.ts
│   ├── tab-navigation.spec.ts
│   ├── theme.spec.ts
│   └── toast.spec.ts
├── real/                     # Real mode: requires Docker Compose full stack
│   ├── auth-login.spec.ts
│   ├── chat.spec.ts
│   ├── cross-module-auth-guard.spec.ts
│   ├── cross-module-chat.spec.ts
│   ├── cross-module-rag.spec.ts
│   ├── cross-module-workspace.spec.ts
│   ├── message-search.spec.ts
│   ├── pdf-viewer-perf.spec.ts
│   ├── pdf-viewer.spec.ts
│   ├── screenshots.spec.ts
│   ├── session-management.spec.ts
│   ├── settings-visual.spec.ts
│   └── visual.spec.ts
└── assets/
    └── sample.pdf            # PDF viewer test fixture
```

| Layer | External Dependencies | Startup Method | Test Count |
|-------|----------------------|----------------|------------|
| mock | None | `webServer` auto-starts Vite dev | 66 |
| real | Docker Compose (CP/Agent/Runtime/PG) | Requires `docker compose up -d` first | 37 |

### 1.2 Playwright Configuration

```typescript
// playwright.config.ts core configuration
projects: 1 (chromium, 1920×1080@2x)
timeout: 30000ms
retries: 1
screenshot: 'only-on-failure'  # Save actual screenshots only on failure
toHaveScreenshot: { threshold: 0.2, maxDiffPixelRatio: 0.01 }
deviceScaleFactor: 2            # Retina-level screenshots
```

All page navigations use `load`/`domcontentloaded` plus concrete DOM visibility assertions; `networkidle` is avoided because Vite HMR and SSE long-polling make it unreliable.

### 1.3 Project Strategy

xihe uses a single Playwright project (chromium). Desktop coverage is complemented by explicit mobile viewport specs; host-only scenarios are marked `@host` and run against an isolated native stack.

## 2. Screenshot and Visual Regression Plan

### 2.1 Baseline Tracking

Visual regression uses Playwright `toHaveScreenshot()`. Git currently tracks 64 Linux PNG baselines. Linux is the only commit-level baseline platform; Windows/macOS screenshots are local-only artifacts:

```
e2e/mock/login.spec.ts-snapshots/
└── login-page-linux.png        # Tracked CI baseline
```

With the current single Chromium project, Playwright names files as `{snapshotName}-{platform}.png`.

On Windows/macOS, `expectPlatformScreenshot` records a `visual-baseline-platform` annotation and skips only the visual matcher; the test's browser actions and non-visual assertions still run. When the Linux workflow is enabled, it compares the tracked baseline. A missing Linux baseline must fail; do not generate/update baselines as part of a normal run.

The local candidate Linux visual workflow is configured to run only `e2e/mock/screenshots.spec.ts` and Compose-compatible `e2e/real/screenshots.spec.ts` (9 route cases each, 18 baselines total). Per PLAN-0440 user decisions #6/#7 (2026-10-05/06), remote workflow execution and Linux testing are not part of PLAN-0440; this is an unexecuted record for possible future work. The remaining 46 tracked Linux baselines are outside the candidate scope. Do not claim that Linux visual regression has passed. Both specs retain their navigation, HTTP, root visibility, and console/page-error assertions when run natively.

### 2.2 Updating Baselines

Only after an intentional UI change and review of actual/diff, DOM/CSS, and the resulting page state, update the selected baseline on Linux. Windows/macOS must not generate acceptance baselines.

```bash
pnpm exec playwright test e2e/mock/<reviewed-spec>.spec.ts --config e2e/playwright.config.ts --update-snapshots
git add e2e/mock/<reviewed-spec>-snapshots/*-linux.png e2e/real/<reviewed-spec>-snapshots/*-linux.png
```

Run from `packages/ui` on Linux only. Do not update snapshots on Windows/macOS.

### 2.3 Gitignore Rules

```gitignore
# Playwright E2E artifacts
playwright-report/    # HTML reports
test-results/         # Failed test screenshots/diffs
screenshots/          # Manual screenshot archive (not used by project, reserved for future)
**/*-snapshots/*.png  # Ignore local platform snapshots
!**/*-snapshots/*-linux.png # Track Linux acceptance baselines
```

Linux baseline PNGs are re-included by `.gitignore`; other platform-local PNGs remain ignored.

### 2.4 Historical Notes

Previously xihe used a custom `expectWithArchive()` function for dual-writing (simultaneously writing to timestamped archive and Playwright baseline). This design had redundancy (same screenshot stored twice).

Currently unified to a clean `toHaveScreenshot()` approach:
- Specs call `expectPlatformScreenshot`; Linux delegates to Playwright `toHaveScreenshot`, other platforms add an annotation and preserve non-visual assertions
- Linux baselines are tracked; actual/diff/trace remain failure artifacts
- `screenshots/` directory only for manual screenshot archive (gitignored), not used by this project

## 3. Run Commands

```bash
# Mock E2E (no backend needed, auto-starts Vite dev; cwd=packages/ui)
pnpm exec playwright test e2e/mock/ --config e2e/playwright.config.ts --workers=1 --retries=0

# Single test file
pnpm exec playwright test e2e/mock/chat.spec.ts --config e2e/playwright.config.ts

# Compose-compatible real E2E (runner manages isolated Compose lifecycle; XH root)
node scripts/e2e-compose.mjs e2e/real --workers=1 --retries=0

# Update one reviewed visual baseline on Linux only (cwd=packages/ui)
pnpm exec playwright test e2e/mock/<reviewed-spec>.spec.ts --config e2e/playwright.config.ts --update-snapshots
```

> **Host runner CLI semantics (PLAN-0664 / BL-267, 2026-11-04)**:
> ① `--batch=<name>` and positional spec paths are a **union** — every batch spec still runs and a positional path only appends; narrow with `--only=<full path|basename|unique substring>` (an ambiguous substring is refused with candidates instead of guessing);
> ② a `--llm-mode` (or `XIHE_E2E_LLM_MODE`) that differs from the batch `llmMode` in `scripts/e2e-batches.jsonc` **refuses to start** (the declared lane must not be silently overridden); cross-lane debugging needs the explicit `--allow-llm-mode-override`;
> ③ `--retries` is Playwright's per-test retry, `XIHE_E2E_RETRY_ROUNDS` is a whole-run replay (with a DB reset between rounds); when both are set the total attempts = rounds × (1 + retries); evidence runs should use `--retries=0` plus `XIHE_E2E_RETRY_ROUNDS=1` so a retry cannot mask a real failure;
> ④ pre-flight your arguments without booting anything: `node scripts/e2e-host.mjs --batch=<name> [--only=…] --check-cli`.

If Linux validation is authorized in future work, the local candidate workflow uses these two screenshot specs:

```bash
# cwd=packages/ui
pnpm exec playwright test e2e/mock/screenshots.spec.ts --config e2e/playwright.config.ts --workers=1 --retries=0

# XH root; the existing runner manages the Compose lifecycle
node scripts/e2e-compose.mjs e2e/real/screenshots.spec.ts --workers=1 --retries=0
```

### 3.1 PLAN-247 Fake LLM Host Matrix

The Host runner imports a controlled provider configuration through the CP Admin API before starting Agent, so these tests exercise the real ConfigService boundary:

```bash
node scripts/e2e-host.mjs --llm-mode=missing e2e/real/chat-availability.spec.ts
node scripts/e2e-host.mjs --llm-mode=invalid e2e/real/chat-availability.spec.ts
node scripts/e2e-host.mjs --llm-mode=success e2e/real/chat-availability.spec.ts
node scripts/e2e-host.mjs --llm-mode=disconnect e2e/real/chat-availability.spec.ts
```

`missing` omits credentials, `invalid` makes the fake provider return 401, `success` emits at least two SSE tokens, and `disconnect` closes after the first token. Set `XIHE_E2E_HEADED=1` and `XIHE_E2E_BROWSER_CHANNEL=chrome-beta` for Chrome Beta headed runs. Each run uses isolated database, host root, ports, and evidence output.

### 3.2 Time Budget and Network Classification (PLAN-0586)

- **Batch budget**: the mock-full wall clock baseline moved from 7.5 min to 6.7 min after PLAN-0586 (402.8 s, 82 passed / 0 unexpected / 0 flaky; evidence `plans/PLAN-0586-XH-e2e-runtime-slim/evidence/m4-final-ab.md`). New changes must not push the batch back above 7.5 min.
- **Network classification**: waits in E2E fall into three buckets — (1) deterministic HTTP/SSE waits (`waitForResponse` / event assertions); (2) process readiness (Agent restart, Runtime heartbeat) via `expect.poll` with an explicit terminal state; (3) uncertain external dependencies, which must use explicit timeouts or mocks, never fixed sleeps. A fixed `waitForTimeout` is a defect (V4).
- **Agent readiness measurement**: under full-batch load `spawn → health+llmReady` measured 5.1–7.6 s across 6 samples (with n=6, p95 equals the max 7.6 s); the 30 s default budget stays (override with `XIHE_E2E_AGENT_READY_TIMEOUT_MS`), and failures must report waited time + last state + agent log path.
- **Cleanup cost**: a workspace DELETE with an import job takes ≈11 s (29 ms when idle); batch cleanups must run concurrently, not serially. The runner's zero-residue teardown check is unchanged.

### 3.3 E2E Build Roots and Parallel Runs (PLAN-0656 R2)

The E2E CP build root defaults to `C:/xihe-build/e2e` (`scripts/e2e-host.mjs:59-63`, the default itself on `:62`; an explicit `XIHE_CP_TARGET_DIR` wins). It skips a 2–3 min cold build per run, at the price that **one build root serves one run at a time** (what concurrent repackaging does is in the window protocol §5 and is not repeated here).

- **To run in parallel, give the second run its own root**: `XIHE_CP_TARGET_DIR=C:/xihe-build/e2e-runs/<runId>` — the runner passes that value straight to mvn (`scripts/e2e-host.mjs:59-63`), **no code change needed**; the cost is an independent cold build (~2–3 min + disk).
- **The shared root is the E2E default, not an architectural limit**: dev stacks already isolate CP build directories per `<root>/<stackId>/<sha12>[-dirty]` (`scripts/lib/cp-build-dir.mjs:11`, default root on `:29`, dirty suffix on `:36`); E2E simply does not use that derivation.
- **Parallel is allowed only when all three hold**: ① the two runs use different build roots; ② neither is a measurement spec; ③ both are pinned to the same SHA (numbers from different commits are not comparable). Before opening a window, also run `node scripts/e2e-preflight.mjs` (read-only): any `FAIL` blocks, and only exit 0 (no blocking finding, `scripts/e2e-preflight.mjs:26`) opens the window.
- **Measurement specs always run alone**: with another spec alongside, session-scale/memory-sampling numbers move because GC pressure and memory watermarks change — the run no longer measures what it is meant to measure.
- **The window itself is not here**: opening, freezing and pinned-SHA rules live in the SSOT `one/internal/A03-xihe/docs/l2-window-protocol.md` (ONE private layer, not in this repo) §3–§5.

## Drift risk of mode-gated specs, and fixture prerequisites (measured 2026-11-06)

- **Two LiveChain classes are skipped by default (2026-11-06 audit)**: `ContextSourceLiveChainTest` (`Assumptions.assumeTrue`, requires Runtime `/ready` and dev CP `/actuator/health`) and `ContextToolHistoryLiveChainTest` (`@EnabledIfSystemProperty xihe.run.v15.live=true`) each have **1/1 test skipped**; the full-suite summary shows only `Skipped: 2`. Restore: start the host stack for the first; add `mvn -o test "-Dxihe.run.v15.live=true"` for the second. Not a missing run, but not coverage either.
- **Risk**: a spec gated by `--llm-mode` is skipped on the everyday mock lane ⇒ **nobody runs it ⇒ it drifts** (`BL-358`: the approval path of `chat-follow-up-queue.spec.ts` was missing the required `X-Workspace-Id` header and hit `409 WORKSPACE_CONTEXT_REQUIRED`). This is the E2E version of "low-frequency paths rot silently" (same class as `BL-357`).
- **Mechanism**: `--llm-mode` is **not passed to Playwright through env** (specs cannot read `XIHE_E2E_LLM_MODE`), so a `test.skip(process.env.XIHE_E2E_LLM_MODE !== ...)` guard **always skips** under a direct runner invocation.
- **Requirements**:
  1. Do not gate on env with a leading `test.skip`; use **runtime detection** instead (decide testability from lane/fixture characteristics after connecting).
  2. Run every gated spec **once in its own mode on a schedule**: whenever that path is changed, and once per week (record it in the change note or run log).
  3. **UI session fixture prerequisite**: call `ensureFakeUserProvider` and wait for a READY provider *before* creating a session; assert on the **path shape** `POST /api/v1/workspaces/{id}/sessions`, not on the literal string.
- **Triage order** (when stuck at "create session"): ① READY provider → ② request path/headers (`X-Workspace-Id`) → **only then** suspect lane capability. Both the mock and approval lanes were measured to **support** UI session creation (control probes returned 201 in both).


## 4. References

- Test strategy decision framework is maintained as a workspace skill.
