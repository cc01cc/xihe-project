---
title: DEV-011 - E2E Test Strategy and Screenshot Plan
category: dev-guide
sidebar_order: 11
lang: en
sidebar_group: "Developer Guide"
---

# DEV-011: E2E Test Strategy and Screenshot Plan

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

xihe uses a single Playwright project (chromium). xihe is a tool-type SPA primarily targeting desktop users, so multi-viewport coverage is not needed at this time.

## 2. Screenshot and Visual Regression Plan

### 2.1 Baseline Tracking

Visual regression uses Playwright `toHaveScreenshot()`. Baseline files are stored in `*-snapshots/` directories and tracked directly by git:

```
e2e/mock/login.spec.ts-snapshots/
├── login-page-linux.png        # Current platform baseline
├── login-page-darwin.png
└── login-page-win32.png
```

Playwright automatically names files as `{snapshotName}-{browser}-{platform}.png`.

### 2.2 Updating Baselines

After intentional UI changes:

```bash
npx playwright test e2e/mock/ --update-snapshots
git add e2e/mock/*-snapshots/ e2e/real/*-snapshots/
git commit -m "chore: update visual regression baselines"
```

### 2.3 Gitignore Rules

```gitignore
# Playwright E2E artifacts
playwright-report/    # HTML reports
test-results/         # Failed test screenshots/diffs
screenshots/          # Manual screenshot archive (not used by project, reserved for future)
```

`*-snapshots/` is not in gitignore — baseline files are tracked by git.

### 2.4 Historical Notes

Previously xihe used a custom `expectWithArchive()` function for dual-writing (simultaneously writing to timestamped archive and Playwright baseline). This design had redundancy (same screenshot stored twice), and baselines were gitignored making history untraceable.

Currently unified to a clean `toHaveScreenshot()` approach:
- Baselines tracked directly by git, `*-snapshots/` not in gitignore
- `screenshots/` directory only for manual screenshot archive (gitignored), not used by this project
- All spec files directly call `expect(page).toHaveScreenshot()`

## 3. Run Commands

```bash
# Mock E2E (no backend needed, auto-starts Vite dev)
npx playwright test e2e/mock/

# Single test file
npx playwright test e2e/mock/chat.spec.ts

# Real E2E (requires Docker Compose full stack running)
docker compose up -d
npx playwright test e2e/real/

# Update visual baselines
npx playwright test e2e/mock/ --update-snapshots
```

## 4. References

- Test strategy decision framework is maintained as a workspace skill.
