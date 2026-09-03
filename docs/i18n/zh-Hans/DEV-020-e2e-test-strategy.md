---
title: DEV-020 - E2E 测试策略与截图方案
category: dev-guide
sidebar_order: 20
lang: zh-Hans
sidebar_group: "开发指南"
---

# DEV-020: E2E 测试策略与截图方案

> 面向测试开发者：mock/real 分层 + profile 策略（§1）→ 截图基线（§2）→ 运行命令（§3）。契约测试见 DEV-021。

## 1. 测试架构

### 1.1 两层分离

E2E 测试分 mock 和 real 两层，位于 `packages/ui/e2e/`：

<details>
<summary>完整目录树（点击展开）</summary>

```
e2e/
├── playwright.config.ts      # Playwright 全局配置
├── mock/helpers/
│   └── auth.ts              # setupMockAuth：统一 mock /api/v1/** 认证（各 mock spec 以 `./helpers/auth` 引用）
├── fixtures/ / page-objects/ / utils/ / assets/  # fixture 与页面对象（utils 为空目录）
├── real/helpers/
│   └── password.ts          # real 侧密码辅助
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
├── real/                     # Real 模式：按 compose/host profile 执行
│   ├── auth-login.spec.ts
│   ├── chat.spec.ts
│   ├── cross-module-auth-guard.spec.ts
│   ├── cross-module-chat.spec.ts
│   ├── cross-module-rag.spec.ts
│   ├── cross-module-workspace.spec.ts
│   ├── auth-flows.spec.ts
│   ├── message-search.spec.ts
│   ├── pdf-viewer-perf.spec.ts
│   ├── pdf-viewer.spec.ts
│   ├── screenshots.spec.ts
│   ├── session-management.spec.ts
│   ├── settings-visual.spec.ts
│   ├── settings-interactions.spec.ts
│   ├── visual.spec.ts
│   ├── chat-interactions.spec.ts
│   ├── environment.spec.ts
│   ├── mobile-viewport.spec.ts
│   ├── runtime-m1.spec.ts
│   ├── ui-health.spec.ts
│   └── workspace-files.spec.ts
└── assets/
    └── sample.pdf            # PDF viewer 测试 fixture
```

</details>

| 层 | 外部依赖 | 启动方式 | 用例数 |
|----|---------|---------|--------|
| mock | 无 | `webServer` 自动启动 Vite dev | 数量随用例扩展变化 |
| real / compose | Docker Compose 的 CP/Agent/Runtime/PG + host UI | `mise run test:e2e` 自动管理 Compose | 默认排除 `@host` 用例 |
| real / host | Windows native CP/Agent/Runtime/UI + 每轮隔离 PostgreSQL/host root/Sandbox | Host E2E runner 按每轮 `e2eRunId` 编排隔离环境 | 执行 `@host` 用例；禁止连接长期 dev DB |

### 1.2 Playwright 配置

```typescript
// playwright.config.ts 核心配置
单 project（chromium 语义，配置无 projects 数组；viewport 1920×1080）+ `animations:disabled` + `trace:retain-on-failure` + 按 profile 的 `grep/grepInvert` + `webServer: pnpm dev`
timeout: 30000ms
retries: 1
screenshot: 'only-on-failure'  // 仅失败时保存实际截图
toHaveScreenshot: { threshold: 0.2, maxDiffPixelRatio: 0.01 }
deviceScaleFactor: 2            // Retina 级别截图
```

所有页面跳转使用 `load`/`domcontentloaded` 并配合具体 DOM 元素可见性断言；禁止 `networkidle` 等待策略，以避免 Vite HMR 和 SSE 长连接导致假死。

### 1.3 Profile 策略

xihe 使用单个浏览器 project（chromium），通过 `XIHE_E2E_PROFILE` 区分运行拓扑：

- `compose`：由 `scripts/e2e-real.mjs` 启动 frozen Compose，只执行 Compose 可支持用例，排除 `@host`。
- `host`：以每轮隔离的 host 环境执行 `@host` 用例，覆盖 Runtime-created Sandbox 和 WorkspaceStorage；成功、失败和中断都必须 teardown 并反向断言无残留。
- 未设置 profile：不做过滤，供人工诊断使用；不能将该结果作为标准 Compose 或 host 门禁。

依赖 Docker Engine socket、`XIHE_WORKSPACE_HOST_ROOT` 或 Runtime Sandbox 的用例必须标记 `@host`。禁止通过 `test.skip()` 或放宽断言掩盖拓扑缺失。

## 2. 截图与视觉回归方案

### 2.1 基线追踪

视觉回归使用 Playwright `toHaveScreenshot()`，基线文件存于 `*-snapshots/` 目录。当前 A03 的 `.gitignore` 将 `**/*-snapshots/*.png` 作为本地生成工件忽略，因此这些文件只能证明当前准备好的工作区中的视觉回归，不能声称 fresh checkout 可以直接复现。若未来需要仓库级视觉门禁，应另行移除忽略规则并审查二进制基线的提交边界。

```
e2e/mock/login.spec.ts-snapshots/
├── login-page-linux.png        # 当前平台基线
├── login-page-darwin.png
└── login-page-win32.png
```

Playwright 自动按 `{snapshotName}-{platform}.png` 命名（单 project，无 browser 段）。

### 2.2 更新基线

UI 有意变更且完成 actual/diff、DOM/CSS 和人工视觉复核后：

```bash
npx playwright test e2e/mock/ --update-snapshots
```

更新结果必须记录 viewport、URL、页面数据状态、actual/diff 路径和 reviewer decision。当前 baseline 被忽略时，不执行 `git add`，也不把本地通过结果当作提交级证据。

### 2.3 gitignore 规则

```gitignore
# Playwright E2E artifacts
playwright-report/    # HTML 报告
test-results/         # 失败测试截图/diff
screenshots/          # 手动截图存档（项目未使用，为未来预留）
**/*-snapshots/*.png  # 当前 A03 本地生成的视觉 baseline
```

`*-snapshots/` 当前在 A03 的 gitignore 中；mock/real screenshot 测试依赖预先准备的本地 baseline。

### 2.4 历史说明

此前 xihe 使用自定义 `expectWithArchive()` 函数实现双写（同时写时间戳存档和 Playwright 基线）。该设计存在冗余（同一截图存两份）；当前实际策略仍是本地 ignored baseline，因此必须显式记录生成命令和可复现性限制。

当前统一为纯净的 `toHaveScreenshot()` 方案：
- baseline、actual/diff 和 trace 按来源分别管理；当前 `*-snapshots/` 为本地 ignored 工件
- `screenshots/` 目录仅供手动截图存档使用（gitignore），本项目未使用
- 所有 spec 文件直接调用 `expect(page).toHaveScreenshot()`

## 3. 运行命令

```bash
# Mock E2E（无需后端，自动启动 Vite dev；cwd=e2e/，或从 packages/ui 用 --config e2e/playwright.config.ts）
npx playwright test e2e/mock/

# 单个测试文件
npx playwright test e2e/mock/chat.spec.ts

# Compose-compatible Real E2E（自动启动/清理 frozen Compose）
mise run test:e2e

# Host-only Real E2E（默认自编排每轮隔离栈）
mise run test:e2e:host

# 仅本地调试：复用已运行的 dev:host，不作为标准验收证据
XIHE_E2E_EXTERNAL_SERVER=1 mise run test:e2e:host

# 更新视觉基线
npx playwright test e2e/mock/ --update-snapshots
```

`dev:full`/T3 Compose 当前不提供 Runtime 创建 Sandbox 所需的 Docker Engine socket 和宿主 WorkspaceStorage 映射，因此不作为 host-directory、Sandbox recreate 或 Runtime remote MCP 的完成门。Host E2E 不连接长期 dev DB，必须使用每轮隔离数据库和 host root。移动端 screenshot 必须在服务健康且数据加载稳定后复核，不能因 Compose 错误态直接更新基线。

## 4. 参考

- XH E2E profile、readiness 和实际结果矩阵：维护在 workspace 私有 internal 层（不在本仓库分发）
- 测试策略决策框架 — 维护在 workspace skill 中
