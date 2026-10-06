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
node scripts/e2e-real.mjs e2e/real --workers=1 --retries=0

# Update one reviewed visual baseline on Linux only (cwd=packages/ui)
pnpm exec playwright test e2e/mock/<reviewed-spec>.spec.ts --config e2e/playwright.config.ts --update-snapshots
```

If Linux validation is authorized in future work, the local candidate workflow uses these two screenshot specs:

```bash
# cwd=packages/ui
pnpm exec playwright test e2e/mock/screenshots.spec.ts --config e2e/playwright.config.ts --workers=1 --retries=0

# XH root; the existing runner manages the Compose lifecycle
node scripts/e2e-real.mjs e2e/real/screenshots.spec.ts --workers=1 --retries=0
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

## 4. References

- Test strategy decision framework is maintained as a workspace skill.
