---
title: DEV-011 - E2E 测试策略与截图方案
category: dev-guide
sidebar_order: 11
lang: zh-Hans
sidebar_group: "开发指南"
---

# DEV-011: E2E 测试策略与截图方案

> xihe 项目 E2E 测试架构设计、Playwright 配置、截图策略和目录规范的持久化文档。

## 1. 测试架构

### 1.1 两层分离

E2E 测试分 mock 和 real 两层，位于 `packages/ui/e2e/`：

```
e2e/
├── playwright.config.ts      # Playwright 全局配置
├── helpers/
│   └── auth.ts              # setupMockAuth：统一 mock /api/v1/** 认证
├── mock/                     # Mock 模式：page.route() 拦截 API，无需后端
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
│   ├── screenshots.spec.ts   # 全路由截图遍历
│   ├── session-management.spec.ts
│   ├── session-switch.spec.ts
│   ├── tab-navigation.spec.ts
│   ├── theme.spec.ts
│   └── toast.spec.ts
├── real/                     # Real 模式：需 Docker Compose 全栈
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
    └── sample.pdf            # PDF viewer 测试 fixture
```

| 层 | 外部依赖 | 启动方式 | 用例数 |
|----|---------|---------|--------|
| mock | 无 | `webServer` 自动启动 Vite dev | 66 |
| real | Docker Compose (CP/Agent/Runtime/PG) | 需先 `docker compose up -d` | 37 |

### 1.2 Playwright 配置

```typescript
// playwright.config.ts 核心配置
projects: 1 (chromium, 1920×1080@2x)
timeout: 30000ms
retries: 1
screenshot: 'only-on-failure'  // 仅失败时保存实际截图
toHaveScreenshot: { threshold: 0.2, maxDiffPixelRatio: 0.01 }
deviceScaleFactor: 2            // Retina 级别截图
```

所有页面跳转使用 `load`/`domcontentloaded` 并配合具体 DOM 元素可见性断言；禁止 `networkidle` 等待策略，以避免 Vite HMR 和 SSE 长连接导致假死。

### 1.3 Project 策略

xihe 使用单个 Playwright project（chromium）。xihe 是工具型 SPA，主要面向桌面端用户，暂不需要多 viewport 覆盖。

## 2. 截图与视觉回归方案

### 2.1 基线追踪

视觉回归使用 Playwright `toHaveScreenshot()`，基线文件存于 `*-snapshots/` 目录，直接 git 追踪：

```
e2e/mock/login.spec.ts-snapshots/
├── login-page-linux.png        # 当前平台基线
├── login-page-darwin.png
└── login-page-win32.png
```

Playwright 自动按 `{snapshotName}-{browser}-{platform}.png` 命名。

### 2.2 更新基线

UI 有意变更后：

```bash
npx playwright test e2e/mock/ --update-snapshots
git add e2e/mock/*-snapshots/ e2e/real/*-snapshots/
git commit -m "chore: update visual regression baselines"
```

### 2.3 gitignore 规则

```gitignore
# Playwright E2E artifacts
playwright-report/    # HTML 报告
test-results/         # 失败测试截图/diff
screenshots/          # 手动截图存档（项目未使用，为未来预留）
```

`*-snapshots/` 不在 gitignore 中——基线文件进 git 追踪。

### 2.4 历史说明

此前 xihe 使用自定义 `expectWithArchive()` 函数实现双写（同时写时间戳存档和 Playwright 基线）。该设计存在冗余（同一截图存两份），且基线被 gitignore 导致历史不可追溯。

当前统一为纯净的 `toHaveScreenshot()` 方案：
- 基线直接 git 追踪，`*-snapshots/` 不在 gitignore 中
- `screenshots/` 目录仅供手动截图存档使用（gitignore），本项目未使用
- 所有 spec 文件直接调用 `expect(page).toHaveScreenshot()`

## 3. 运行命令

```bash
# Mock E2E（无需后端，自动启动 Vite dev）
npx playwright test e2e/mock/

# 单个测试文件
npx playwright test e2e/mock/chat.spec.ts

# Real E2E（需 Docker Compose 全栈运行）
docker compose up -d
npx playwright test e2e/real/

# 更新视觉基线
npx playwright test e2e/mock/ --update-snapshots
```

## 4. 参考

- `.kilo/rules/test-strategy.md` — 测试策略决策框架
