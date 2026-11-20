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

### 1.3a Session termination: the E2E criterion (PLAN-0581)

Once an account is disabled / soft-deleted / password-reset by an administrator, **both channels fail at once** (the access `tv` and the refresh `sv`), so the checkable chain is fixed:

1. a business request in the user context → the network layer sees **401** (`code=AUTHORIZATION_REQUIRED`, coming from the access channel, not a new error code);
2. the frontend's silent refresh (0546 `ensureRefreshed`) hits `/api/v1/auth/refresh` → the **refresh fails** (the refresh channel's `sv` no longer matches);
3. the page lands on `/login`, and all three `localStorage` keys `xihe-token` / `xihe-refresh-token` / `xihe-user` are cleared.

The reverse control must exist in the same batch: **a role change does not log the user out** (access 401 → refresh succeeds → replay, with the refreshed access carrying the new `role`), which proves the two channels were not wrongly merged into one switch. Both are `browserConsumer` evidence and belong to L1/L2 batches; the API-level equivalent lives in the CP integration test `UserAdminIntegrationTest`.

## 2. Screenshot and Visual Regression Plan

### 2.1 Baseline Tracking

Visual regression uses Playwright `toHaveScreenshot()`. `[measured]` Git tracks **61** Linux PNG baselines (`git -C A03-xihe ls-files '*-linux.png' | wc -l`; two measurements on 2026-11-12 at **20:27 and 20:32 both returned 61**, at `HEAD` `bc7a482df` and `ae2ade487` respectively, with `309`/`312`/`323` landed in between — the figure held, so the drift came from deleting baselines rather than from ordinary commits) — a figure that is **computed, not constant**: commit `37f42e6e1` deleted 3 unreferenced legacy baselines (`settings-knowledge-linux.png` × 3 paths) later the same day, which is why the previously documented 64 is stale. Linux is the only commit-level baseline platform; Windows/macOS screenshots are local-only artifacts:

```
e2e/mock/login.spec.ts-snapshots/
└── login-page-linux.png        # Tracked CI baseline
```

With the current single Chromium project, Playwright names files as `{snapshotName}-{platform}.png`.

On Windows/macOS, `expectPlatformScreenshot` records a `visual-baseline-platform` annotation and skips only the visual matcher; the test's browser actions and non-visual assertions still run. When the Linux workflow is enabled, it compares the tracked baseline. A missing Linux baseline must fail; do not generate/update baselines as part of a normal run.

The local candidate Linux visual workflow is configured to run only `e2e/mock/screenshots.spec.ts` and Compose-compatible `e2e/real/screenshots.spec.ts` (9 route cases each ⇒ **18 baselines expected**; `[measured]` 2026-11-12 the two snapshot directories hold **16** `-linux.png` files: 11 match a current route name, **5 are old-name orphans left by route renames**, and **7 are missing** — per-file causes and the unblock prerequisite are in `BL-601`). Per PLAN-0440 user decisions #6/#7 (2026-10-05/06), remote workflow execution and Linux testing are not part of PLAN-0440; this is an unexecuted record for possible future work. The remaining **43** tracked Linux baselines are outside the candidate scope (61 − 18). Do not claim that Linux visual regression has passed. Both specs retain their navigation, HTTP, root visibility, and console/page-error assertions when run natively (`helpers/visual.ts:16-27` returns early on non-Linux platforms and only records a `visual-baseline-platform` annotation).

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
> ⑤ phase-order self-check (no rebuild, no window, no stack): `node scripts/e2e-host.mjs --plan-only` — it runs the real `enter()` statements in `main()` and prints `declared` (plan) vs `executed` (actual order); a mismatch exits 1, and combining it with `XIHE_E2E_EXTERNAL_SERVER=1` is refused (see §3.1c).

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

### 3.1b Headed walkthrough batch (PLAN-0621)

The headed walkthrough is a batch of scenarios a **human can re-check** (every step is a `test.step` + screenshot + assertion). It is **never collected together with the headless batches**: it lives in `packages/ui/e2e/headed/`, while `mock-full` / `real-full` collect the directory `e2e/real`, so the default batches always exclude it (`--batch=headed` is the only way to run it).

```powershell
# 1) start the persistent isolated stack (important: pass --bootstrap-user=register, otherwise the Agent
#    reports llmReady=missing_credentials and the runner judges the stack not ready)
node scripts/e2e-host.mjs --persistent --llm-mode=mock --first-run=local --bootstrap-user=register

# 2) headed walkthrough (reuse that stack; Chrome Beta is single-window per machine, so make sure no other
#    headed session is running)
$env:XIHE_E2E_EXTERNAL_SERVER="1"; $env:XIHE_E2E_HEADED="1"; $env:XIHE_E2E_BROWSER_CHANNEL="chrome-beta"
node scripts/e2e-host.mjs --batch=headed --retries=0

# 3) tear down
node scripts/e2e-host.mjs --teardown
```

- **Where the evidence lands**: `packages/ui/.tmp/xh-headed-walkthrough/runs/<XIHE_E2E_RUN_ID>/` (`shots/NN-*.png` + `report.json` with per-step step/URL/assertion/screenshot + `console-errors.log`). Screenshots are local artefacts and are **not committed**.
- **Why `--bootstrap-user=register` is required**: without it the stack does come up, but no account imports the fake provider profile ⇒ the Agent reports `llmReady=missing_credentials` ⇒ the runner judges the stack not ready and no spec can run. Measured 2026-11-02.
- **Not part of the regular gates**: it needs a real display plus Chrome Beta, is slow and environment-sensitive; `mise run validate` and the smoke/mock-full baselines exclude headed (proof: `npx playwright test e2e/real --list` = 213 tests / 83 files with 0 headed hits; `npx playwright test e2e/headed --list` = 8 tests / 1 file).
- **Findings are banked before being fixed**: findings go to `plans/PLAN-0621-*/evidence/findings.md`, and every fix must first add a reproducing assertion (see that plan's design §4).

### 3.1c `--plan-only` dry run: phase order only (PLAN-0680)

```bash
# healthy wiring: declared == executed == [cp-boot-plan, preflight-gate], exit 0
node scripts/e2e-host.mjs --plan-only

# wiring moved (the gate now runs before the CP rebuild): reports
# "boot phase order violated" and exits 1 before any heavy work
# — no rebuild, no window, no stack
```

It answers exactly one question: **are the boot steps in `main()` still entered in the order the plan declares?**

- **It does no heavy work**: it only reads the CP jar state (`previewCpBootPlan()` shares the `decideCpBoot()` table with the real path but **never runs `mvn`**), runs no preflight, starts no service and prunes no run directory; its `CP boot:` line says `--plan-only preview (no rebuild ran)` so it cannot be misread as "the jar is fresh".
- **Unavailable modes fail loudly**: combining it with `XIHE_E2E_EXTERNAL_SERVER=1` (reuse an already-running stack) is **refused** — a reuse run has no rebuild phase, hence no "gate must come after the rebuild" order to verify; refusing beats degrading silently.
- **It is not a safety exit**: `--plan-only` does not verify artifact identity (the jar sidecar / sha256 / build-info match against HEAD lives in `resolveCpBootPlan()` and `runPreflightGate()`), and it never stands in for window acceptance. Exit 0 says "the wiring has not drifted", not "you may open a window".

### 3.2 E2E-only timing barrier (PLAN-0536)

When a test needs a deterministic ordering between "the browser request has reached CP" and "the real state change", do **not** mock the server response — that proves nothing about the real state check. CP ships a `@Profile("e2e")` run-scoped barrier (`/internal/v1/e2e/guidance-barrier`) that only the host runner's service token may call; `dev`/`prod` never activate that profile, so the route does not exist there.

```bash
node scripts/e2e-host-detached.mjs --timeout-min 45 \
  e2e/real/plan0536-guidance-race.spec.ts --llm-mode=approval --retries=0
```

Constraints (measured; details in `plans/archive/PLAN-0536-xh-guidance-race-error-e2e/spec/e2e-guidance-barrier.md`):

- The barrier must hang **outside** the controller/service transaction. Inside the service transaction it locks the Session and then the Run (the same order as the cancel path), so parking there makes cancel hit the lock and time out (503) — the race can never be constructed.
- The start order is fixed: arm → `state=reached` → real state change → release → the production check returns the original error code.
- A timeout returns `503 E2E_GUIDANCE_BARRIER_TIMEOUT` and writes nothing; `try/finally` releases unconditionally.
- When asserting on the console, the 4xx that the test **deliberately triggers** comes with one browser resource-error log line — allow that single line exactly, do not widen the filter.

### 3.3 Auth rate-limit lane (PLAN-0566 D6, dual stack)

The runner picks how CP's auth rate-limit env is injected with `--auth-lane=<exempt|ratelimit>` (default `exempt`); every key reuses the existing `XIHE_CP_AUTH_*` set (`application.properties` §0558), so product code is untouched — no shell/mise global preset is allowed:

| Lane | Injected keys (CP serviceEnv) | Purpose |
|---|---|---|
| `exempt` (default, whole matrix) | `XIHE_CP_AUTH_LOGIN_REGISTER_MAX_ATTEMPTS=0` (dimension disabled, the service returns immediately) | register calls inside journey/mock-full batches cannot be broken by a 429 |
| `ratelimit` (rate-limit assertion stack) | `XIHE_CP_AUTH_LOGIN_REGISTER_MAX_ATTEMPTS=6`, `XIHE_CP_AUTH_TRUSTED_PROXIES=127.0.0.1/32,::1/128` (a loopback remote counts as trusted ⇒ a non-loopback XFF literal takes effect), `XIHE_CP_AUTH_LOGIN_ACCOUNT_MAX_FAILURES=3`, `XIHE_CP_AUTH_LOGIN_ACCOUNT_LOCK_SECONDS=6` | wires up `auth-rate-limit.spec.ts` (reverse assertions: 429 + `AUTH_RATE_LIMITED` + `Retry-After`) and `auth-lockout.spec.ts` (`@host`, uses the identifier selector for login) |

```bash
node scripts/e2e-host-detached.mjs --timeout-min 25 --auth-lane=ratelimit \
  e2e/real/auth-rate-limit.spec.ts e2e/real/auth-lockout.spec.ts --llm-mode=mock
```

Production and the everyday host stack keep rate limiting on by default (not injecting = the existing defaults); the `XIHE_E2E_EXTERNAL_SERVER=1` reuse mode is outside this lane's judgement. The product-side root cause behind rate limiting (IPv6 loopback exemption not working) is tracked in PLAN-0571.

### 3.3b Workspace docker backend freeze (PLAN-0612 M4 → **PLAN-0618 full freeze**)

The 2026-10-31 rule "`test:e2e:host` is the only exemption" **was superseded by PLAN-0618 (user ruling 2026-11-01)**: the test surface is frozen together with the product surface and the defaults.

- The runner no longer injects `XIHE_WORKSPACE_DOCKER_BACKEND=enabled` "so the docker cases can run"; CP walks its default `disabled` (`POST /api/v1/workspaces` without `storageMode` → `400 INVALID_REQUEST`, explicit `managed_import` → `409 BACKEND_DISABLED`, an existing docker workspace → `503`; see [DEV-014 §8b](DEV-014-control-plane-architecture.md), [DEV-003 §2](DEV-003-config-management.md)).
- Specs that genuinely need containers are dropped from the batches; restore collection with `--include-docker-frozen` (**the criterion was finalised by PLAN-0618 M3** and this document follows it).
- The frozen list (which specs, why, what to verify after unfreezing) lives only in `plans/PLAN-0618-XH-docker-freeze-complete/evidence/m3-frozen-tests.md`; this document does not copy the entries. The three-surface freeze scope and unfreeze steps are in [DEV-018 (zh)](../zh-Hans/DEV-018-known-issues.md).

### 3.4 Time Budget and Network Classification (PLAN-0586)

- **Batch budget**: the mock-full wall clock baseline moved from 7.5 min to 6.7 min after PLAN-0586 (402.8 s, 82 passed / 0 unexpected / 0 flaky; evidence `plans/PLAN-0586-XH-e2e-runtime-slim/evidence/m4-final-ab.md`). New changes must not push the batch back above 7.5 min.
- **Network classification**: waits in E2E fall into three buckets — (1) deterministic HTTP/SSE waits (`waitForResponse` / event assertions); (2) process readiness (Agent restart, Runtime heartbeat) via `expect.poll` with an explicit terminal state; (3) uncertain external dependencies, which must use explicit timeouts or mocks, never fixed sleeps. A fixed `waitForTimeout` is a defect (V4).
- **Agent readiness measurement**: under full-batch load `spawn → health+llmReady` measured 5.1–7.6 s across 6 samples (with n=6, p95 equals the max 7.6 s); the 30 s default budget stays (override with `XIHE_E2E_AGENT_READY_TIMEOUT_MS`), and failures must report waited time + last state + agent log path.
- **Cleanup cost**: a workspace DELETE with an import job takes ≈11 s (29 ms when idle); batch cleanups must run concurrently, not serially. The runner's zero-residue teardown check is unchanged.

### 3.5 Isolated-stack reuse discipline (added 2026-11-05 from measurement)

A `--persistent` isolated stack is **not** a sandbox you can re-mode freely: the `llm-provider` profile and the fake connection both live in that stack's own PG rows, so switching the profile once contaminates every later round.

- **A real-provider round and a fake-fixture round must never run one after the other on the same stack.** Measured (right after PLAN-0630 S6's real-key round, then `real/agent-spawn-caller`): the real round replaced the instance-layer profile with a real model (`mimo-v2.6-flash`), while the fake fixture connection had only registered `fake-openai` ⇒ creating a session returned `400 "Model is not registered under this Connection"`; switching the other way (real→fake) additionally produced a transient `POST /chat 503`. **Either use another stack, or re-run `--first-run=local --bootstrap-user=register` without the real key to re-import the fake profile, and wait for the agent to report `llmReady=ready`.**
- **Rebuild CP and stamp it after every code change**: the rebuild branch of `scripts/e2e-host.mjs` writes `build-info.properties` after a successful package (`gitHead()` reads the current worktree HEAD) and, since task-90, writes the jar fingerprint manifest in the same batch (§3.6.1); for a hand-run `mvn -q -DskipTests clean package -Dxihe.target.dir=<target>` see §3.6.1 Migration for who produces the manifest and how to supply it — an external reuse stack (`XIHE_E2E_EXTERNAL_SERVER=1`) fails fast against `build-info`.
- **Browser network transients are not product defects**: on the first start after a merge Vite runs `Re-optimizing dependencies`, and in that window `net::ERR_NO_BUFFER_SPACE` can appear once (a plain GET through the dev proxy, not SSE). Criterion = not reproducible on the same stack + no stream-drop logs on CP/agent ⇒ record as an observation; **never** add it to an allow-list or relax an assertion.
- When `XIHE_EVIDENCE_DIR` is unset on the mock lane, `e2e/helpers/evidence.ts` falls back to `<repo>/.local/evidence/e2e-auto` and warns once (4 cases went red over this earlier; it is an environment prerequisite, not a regression).

### 3.6 E2E Build Roots and Parallel Runs (PLAN-0656 R2)

The E2E CP build root defaults to `C:/xihe-build/e2e` (`scripts/e2e-host.mjs:59-63`, the default itself on `:62`; an explicit `XIHE_CP_TARGET_DIR` wins). It skips a 2–3 min cold build per run, at the price that **one build root serves one run at a time** (what concurrent repackaging does is in the window protocol §5 and is not repeated here).

- **To run in parallel, give the second run its own root**: `XIHE_CP_TARGET_DIR=C:/xihe-build/e2e-runs/<runId>` — the runner passes that value straight to mvn (`scripts/e2e-host.mjs:59-63`), **no code change needed**; the cost is an independent cold build (~2–3 min + disk).
- **The shared root is the E2E default, not an architectural limit**: dev stacks already isolate CP build directories per `<root>/<stackId>/<sha12>[-dirty]` (`scripts/lib/cp-build-dir.mjs:11`, default root on `:29`, dirty suffix on `:36`); E2E simply does not use that derivation.
- **Parallel is allowed only when all three hold**: ① the two runs use different build roots; ② neither is a measurement spec; ③ both are pinned to the same SHA (numbers from different commits are not comparable). Before opening a window, also run `node scripts/e2e-preflight.mjs` (read-only): any `FAIL` blocks, and only exit 0 (no blocking finding, `scripts/e2e-preflight.mjs:26`) opens the window.
- **Measurement specs always run alone**: with another spec alongside, session-scale/memory-sampling numbers move because GC pressure and memory watermarks change — the run no longer measures what it is meant to measure.
- **The window itself is not here**: opening, freezing and pinned-SHA rules live in the SSOT `one/internal/A03-xihe/docs/l2-window-protocol.md` (ONE private layer, not in this repo) §3–§5.
- **Two runs must not share one `packages/ui/test-results/`** (task-224, measured 2026-11-15): when two Playwright processes share that directory, the one that starts later wipes it, so the earlier process gets `ENOENT … playwright-artifacts-N\traces\…` in `browserContext.close` while writing traces; **that failure's error carries no assertion failure at all**, so it disguises itself as a test failure.

    ```powershell
    # give each lane its own artifact directory when running concurrently (cwd=packages/ui)
    $env:XIHE_MOCK_OUTPUT_DIR = "H:\zeotmp\<lane>\test-results"
    ```

    When the variable is unset, `e2e/playwright.config.ts` **does not add an `outputDir` key**, so the default stays `packages/ui/test-results` and every existing gate/report read path is byte-for-byte unchanged; `--output <dir>` works as an ad-hoc alternative. **Do not hide this with `retries`**: under a shared directory the measured run turned 3 ENOENT errors into `1 flaky` (exit 0) via the existing `retries: 1`, whereas the same run with isolated directories reported 6 passed / 0 flaky / 0 ENOENT (the `D-1588` family).

- **Report locations need per-lane isolation too, and an argv `--reporter` overrides the config reporter** (task-227, measured 2026-11-15): with `XIHE_MOCK_REPORT=1` the report goes to `e2e/.mock-report.json` (full run) or `e2e/.mock-report.subset.json` (**any run that lists explicit `*.spec.ts` files**) — the subset file is a **shared path**, so two concurrent lanes overwrite each other and you may read someone else's numbers. Isolate it by setting `XIHE_MOCK_REPORT_FILE` (absolute path) together with `XIHE_MOCK_OUTPUT_DIR`. Separately, command-line flags such as `--reporter=line` **override the reporter declared in the config** ⇒ the JSON reporter never runs and the report file is not updated, while the operator only sees that the run finished; the config now prints `[e2e] 命令行 --reporter=… 覆盖 config reporter ⇒ 本跑不产出 JSON 报告`. **No wrapper script for this**: a wrapper would have to filter user arguments (worse than overriding) and would also swallow exit codes — documentation plus one diagnostic line is enough. Check: with `XIHE_MOCK_REPORT=1` and no `--reporter`, the log shows `[e2e] 报告落点 <path>` and that file's mtime advances.

    ```powershell
    # concurrent runs: give each lane its own artifact directory and report file (cwd=packages/ui)
    $env:XIHE_MOCK_OUTPUT_DIR = "H:\zeotmp\<lane>\test-results"
    $env:XIHE_MOCK_REPORT_FILE = "H:\zeotmp\<lane>\mock-report.json"
    $env:XIHE_MOCK_REPORT = "1"
    ```

### 3.6.1 CP jar fingerprint (BL-477 / task-90)

The identity of the shared CP jar is no longer taken from mtime, and no longer from the jar's own `META-INF/build-info.properties`: that stamp is generated during the Spring Boot package phase and *rewritten afterwards* by `scripts/stack-run.mjs`, so the copy inside the jar lags the artifact by a measured **77 minutes** (its `commit` was 11 CP files behind the tree the jar was actually built from) — using it as the criterion manufactures a new false red. The criterion is now a manifest **next to** the jar, `<jar>.buildinfo.json` (e.g. `control-plane-<version>.jar.buildinfo.json`), written **atomically** (temp file + rename) by the same code path that produces the jar, immediately after packaging:

| Field | Meaning | Role |
|------|------|------|
| `jarSha256` / `jarBytes` / `jarName` | the jar's own byte hash and size | **identity anchor**: proves the manifest is about *this* jar, not a leftover from an earlier build |
| `sourceTreeSha256` | sha256 of the raw `git ls-tree -r HEAD -- packages/control-plane` stdout | input fingerprint: equal to the freshly computed value ⇒ "built from the checked-out tree" |
| `commit` / `dirty` / `sourceScope` | HEAD at build time and whether the tree was dirty | provenance; with `dirty=true` the tree hash cannot prove HEAD ⇒ fall back to content evidence |
| `builtAt` | **packaging completion** time (never earlier than the jar mtime) | human cross-check of ordering; not a decision input |

Read priority (`scripts/lib/cp-jar-sidecar.mjs`, step 0 of the preflight artifact section): manifest matches and tree hash == HEAD ⇒ `fresh`; tree hash differs ⇒ `stale` on the **`build`** scope (deferrable — `resolveCpBootPlan()` runs before the gate, so a rebuild heals it); jar bytes disagree with the manifest, or the manifest is unusable ⇒ **`artifact-truth`** (**non-deferrable**: no pass before a rebuild); no manifest ⇒ fall back to the task-84 content path (behaviour unchanged); tree hash not computable (git unavailable / tree dirty now / built from a dirty tree) ⇒ also fall back to content evidence.

**Skip surface (ruled 2026-11-08)**: `--jar-mode=use`, `--jar-mode=native` and `XIHE_E2E_EXTERNAL_SERVER=1` (the runner collapses all three into `--ignore-build` for the preflight) skip the whole artifact section, so **the manifest does not participate in the verdict** — even when a `*.buildinfo.json` sits in `C:/xihe-build/e2e`, that run neither reads it nor lets it turn anything green or red. Skipping is not the defect; skipping *silently* is: the artifact section prints a WARN naming the cause and stating that the CP jar's identity is NOT verified and nothing later re-checks it, followed by a line saying the neighbouring manifest does not participate. To judge identity there are exactly two paths: run once with the default `--jar-mode=auto|rebuild` (the pre-gate rebuild rewrites the manifest), or cross-check by hand on an external stack (see Migration).

**Migration (old jars)**: artifacts built before task-90 (and any jar from a hand-run `mvn package`) have no manifest and simply take the content path; **one rebuild through `scripts/e2e-host.mjs` produces it — no compatibility code and no expiry window**. Manual cross-check: `git ls-tree -r HEAD -- packages/control-plane | sha256sum` must equal `sourceTreeSha256`, and `sha256sum <jar>` must equal `jarSha256`. **Never forge a manifest**: only the path that produced the jar may write it; a hand-written manifest is fabricated identity evidence — and the writer refuses outright when the jar's mtime is more than 120 s older than the call (an after-the-fact manifest would claim the current tree built that artifact, which the reader would report as `fresh`; reproduced during task-90 evidence collection).

**Two different gates — 120 s is not the whole story**: the write-side guard stops an **after-the-fact manifest** (a time window: you write "now" while the thing being attested is the past). It does **not** stop **the working tree changing during the build** — there the recorded tree hash really was HEAD at build time, but the jar may contain half-finished code. That case is carried by the manifest's `dirty` field and by `sourceTreeSha256`: when `dirty=true` or the tree hash disagrees with HEAD the reader reports `degraded`/`stale` and **falls back to content evidence** (`unverifiable` still blocks). So the time window and tree consistency are two separate gates; having 120 s does not mean having identity.

## Drift risk of mode-gated specs, and fixture prerequisites (measured 2026-11-06)

- **Two LiveChain classes are skipped by default (2026-11-06 audit)**: `ContextSourceLiveChainTest` (`Assumptions.assumeTrue`, requires Runtime `/ready` and dev CP `/actuator/health`) and `ContextToolHistoryLiveChainTest` (`@EnabledIfSystemProperty xihe.run.v15.live=true`) each have **1/1 test skipped**; the full-suite summary shows only `Skipped: 2`. Restore: start the host stack for the first; add `mvn -o test "-Dxihe.run.v15.live=true"` for the second. Not a missing run, but not coverage either.
- **Risk**: a spec gated by `--llm-mode` is skipped on the everyday mock lane ⇒ **nobody runs it ⇒ it drifts** (`BL-358`: the approval path of `chat-follow-up-queue.spec.ts` was missing the required `X-Workspace-Id` header and hit `409 WORKSPACE_CONTEXT_REQUIRED`). This is the E2E version of "low-frequency paths rot silently" (same class as `BL-357`).
- **Mechanism**: `--llm-mode` is **not passed to Playwright through env** (specs cannot read `XIHE_E2E_LLM_MODE`), so a `test.skip(process.env.XIHE_E2E_LLM_MODE !== ...)` guard **always skips** under a direct runner invocation.
- **Requirements**:
  1. Do not gate on env with a leading `test.skip`; use **runtime detection** instead (decide testability from lane/fixture characteristics after connecting).
  2. Run every gated spec **once in its own mode on a schedule**: whenever that path is changed, and once per week (record it in the change note or run log).
  3. **UI session fixture prerequisite**: call `ensureFakeUserProvider` and wait for a READY provider *before* creating a session; assert on the **path shape** `POST /api/v1/workspaces/{id}/sessions`, not on the literal string.
- **Triage order** (when stuck at "create session"): ① READY provider → ② request path/headers (`X-Workspace-Id`) → **only then** suspect lane capability. Both the mock and approval lanes were measured to **support** UI session creation (control probes returned 201 in both).


### 3.6.2 Mock count-baseline maintenance semantics (task-250, model "C")

`counts.expected` / `counts.skipped` in `packages/ui/e2e/mock-baseline.json` **follow the actual collected counts automatically** via `scripts/check-mock-baseline.mjs`; both numbers and that run's `sourceRun` come from the **same** `summarizeReport` result, so judging and writing can never cross runs.

- **Written by default**: with `failed=0`, one `mise run check:mock-baseline` (or a direct script run) rewrites the two counts to the report's actual values and records provenance in `sourceRun` (command + collection time + HEAD + `specs sha256` + the four counts). The collection time comes from the report's own `stats.startTime`, **not** from the moment the gate runs ⇒ running twice on the same run is byte-identical (idempotent).
- **Guard: with `failed≠0` nothing is written.** The default mode prints "count auto-follow **skipped**" and still fails on drift; `--write-baseline` exits **2** and lists every failed case (`file :: title`).
- **Two flags**: `--no-write-baseline` = fall back to read-only comparison (a ruler that contradicts itself becomes a hard failure again, `E_MOCK_BASELINE_SELF_INCONSISTENT`); `--write-baseline` = write only, no comparison, exit 2 when `failed≠0`.
- When the baseline disagrees with the current lane (the lane is still red) the gate **does not** touch it — the next clean full run follows automatically.
### 3.7 E2E fixture self-test gate (`mise run test:e2e:fixtures`; added by task-98 when it moved down from `AGENTS.md`)

The fixture state machines under `packages/ui/e2e/fixtures/` have their own gate: `mise run test:e2e:fixtures` (= `node --test "e2e/fixtures/__tests__/*.test.mjs"` in `packages/ui`), **already wired into `mise run validate`**, running after the UI unit tests and before E2E. It only exercises the fake-LLM `mode=chain` state machines (session cursor / retry replay / exhaustion fallback) and **starts no stack, opens no browser, and takes seconds**.

**Changing a state machine under `packages/ui/e2e/fixtures/` requires running this first**: a broken fixture shows up on a real stack as "a tool mysteriously does not appear", which costs far more to triage than this gate.

## 4. References

- Test strategy decision framework is maintained as a workspace skill.
