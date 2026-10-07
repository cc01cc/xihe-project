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
| real / compose | Docker Compose 的 CP/Agent/Runtime/PG + host UI | `mise run test:e2e:compose` 自动管理 Compose | 默认排除 `@host` 用例 |
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

- `compose`：由 `scripts/e2e-compose.mjs`（任务 `test:e2e:compose`，旧名 `test:e2e`/`e2e-real.mjs`）启动 frozen Compose，只执行 Compose 可支持用例，排除 `@host`。
- `host`：以每轮隔离的 host 环境执行 `@host` 用例，覆盖 Runtime-created Sandbox 和 WorkspaceStorage；成功、失败和中断都必须 teardown 并反向断言无残留。
- 未设置 profile：不做过滤，供人工诊断使用；不能将该结果作为标准 Compose 或 host 门禁。

依赖 Docker Engine socket、`XIHE_WORKSPACE_HOST_ROOT` 或 Runtime Sandbox 的用例必须标记 `@host`。

受本机 Docker/Playwright 内存预算约束，Mock、Compose 和 Host E2E profile 应分开串行执行；不要并发启动多个浏览器/Docker 测试套件，以免 OOM 后产生不可靠失败。

禁止通过 `test.skip()` 或放宽断言掩盖拓扑缺失。

## 2. 截图与视觉回归方案

### 2.1 基线追踪

视觉回归使用 Playwright `toHaveScreenshot()`，基线文件存于 `*-snapshots/` 目录。当前 Git index 跟踪 64 个 Linux PNG；`.gitignore` 忽略平台本地快照，并显式放行 `*-linux.png`，以便新 Linux 基线可复现和审查。

- Linux 是唯一提交级视觉基线平台；启用 Linux workflow 时用锁定的 Playwright/Chromium 版本比较 Linux PNG。
- Windows/macOS 本地通过 `expectPlatformScreenshot` 跳过视觉 matcher 并记录 annotation；同一 E2E 用例的动作、DOM、网络和持久化断言照常运行。不得跳过整条测试或生成本地平台基线。
- Linux baseline 缺失时 matcher 必须失败；禁止用 `--update-snapshots` 自动生成并接受差异。

本地候选 Linux 视觉 workflow 配置为只运行 `e2e/mock/screenshots.spec.ts` 与 Compose-compatible `e2e/real/screenshots.spec.ts`（各 9 个路由场景，共消费 18 个 baseline）。按 PLAN-0440 用户决策 #6/#7（2026-10-05/06），远端 workflow 与 Linux 测试不属于 PLAN-0440 的当前任务，仅作未来事实记录；workflow 未触发、未验证。其余 46 个已跟踪 Linux baseline 不在候选范围；不得声称 Linux 视觉回归已通过。原生平台运行这些 spec 时仍执行导航、HTTP、根节点可见性和 console/page-error 断言。

```
e2e/mock/login.spec.ts-snapshots/
└── login-page-linux.png        # 唯一跟踪的验收基线
```

Playwright 自动按 `{snapshotName}-{platform}.png` 命名（单 project，无 browser 段）；win32/darwin 文件只可能是本地诊断工件。

### 2.2 更新基线

只有 UI 有意变更、actual/diff、DOM/CSS 和人工视觉复核通过后，才在 Linux 环境运行目标 spec 的 `--update-snapshots`；Windows/macOS 不生成验收基线。复核只提交实际变更的 `*-linux.png`。

未来获准恢复 Linux 基线更新后，只运行已人工审查的目标 spec（Linux-only，cwd=`packages/ui`）：

```bash
pnpm exec playwright test e2e/mock/<reviewed-spec>.spec.ts --config e2e/playwright.config.ts --update-snapshots
```

更新结果必须记录 viewport、URL、页面数据状态、actual/diff 路径和 reviewer decision；Linux CI 必须通过干净 checkout 复验。

### 2.3 gitignore 规则

```gitignore
# Playwright E2E artifacts
playwright-report/    # HTML 报告
test-results/         # 失败测试截图/diff
screenshots/          # 手动截图存档（项目未使用，为未来预留）
**/*-snapshots/*.png  # 忽略本地平台快照
!**/*-snapshots/*-linux.png # 跟踪 Linux 验收基线
```

Linux baseline 已跟踪；win32/darwin 生成物保持忽略。

### 2.4 历史说明

此前 xihe 使用自定义 `expectWithArchive()` 函数实现双写（同时写时间戳存档和 Playwright 基线）。该设计存在冗余（同一截图存两份）。

当前统一为纯净的 `toHaveScreenshot()` 方案：
- E2E 通过 `expectPlatformScreenshot` 统一断言；Linux 调用原生 `toHaveScreenshot()`，其他本机平台记录 annotation 并保留同一测试内非视觉断言
- Linux baseline、失败 actual/diff 和 trace 按来源分别管理
- `screenshots/` 目录仅供手动截图存档使用（gitignore），本项目未使用
- baseline 只在 Linux workflow 中比较，不在 Windows 本地更新

## 3. 运行命令

```bash
# Mock E2E（无需后端，自动启动 Vite dev；cwd=packages/ui）
pnpm exec playwright test e2e/mock/ --config e2e/playwright.config.ts --workers=1 --retries=0

# 单个测试文件
pnpm exec playwright test e2e/mock/chat.spec.ts --config e2e/playwright.config.ts

# Compose-compatible Real E2E（自动启动/清理 frozen Compose）
node scripts/e2e-compose.mjs e2e/real --workers=1 --retries=0

# Host-only Real E2E（默认自编排每轮隔离栈）
mise run test:e2e:host

# 仅本地调试：复用已运行的 dev:host，不作为标准验收证据
XIHE_E2E_EXTERNAL_SERVER=1 node scripts/e2e-host.mjs --retries=0 <spec>.spec.ts

# Linux 上经人工视觉审查后，定向更新被接受的 baseline
pnpm exec playwright test e2e/mock/<reviewed-spec>.spec.ts --config e2e/playwright.config.ts --update-snapshots
```

未来另行授权恢复 Linux 验收时，候选 workflow 使用以下命令（各执行 9 个路由截图用例）：

```bash
pnpm exec playwright test e2e/mock/screenshots.spec.ts --config e2e/playwright.config.ts --workers=1 --retries=0
node scripts/e2e-compose.mjs e2e/real/screenshots.spec.ts --workers=1 --retries=0
```

Compose 命令由现有 runner 管理隔离服务生命周期；这两个视觉命令不代表全量 Mock/Compose E2E 验收。

`dev:full`/T3 Compose 当前不提供 Runtime 创建 Sandbox 所需的 Docker Engine socket 和宿主 WorkspaceStorage 映射，因此不作为 host-directory、Sandbox recreate 或 Runtime remote MCP 的完成门。Host E2E 不连接长期 dev DB，必须使用每轮隔离数据库和 host root。移动端 screenshot 必须在服务健康且数据加载稳定后复核，不能因 Compose 错误态直接更新基线。

### 3.1 PLAN-247 fake LLM Host matrix

Host runner 支持隔离 fake provider，配置通过 CP Admin API 导入后再启动 Agent，避免绕过真实 ConfigService：

```bash
node scripts/e2e-host.mjs --llm-mode=missing e2e/real/chat-availability.spec.ts
node scripts/e2e-host.mjs --llm-mode=invalid e2e/real/chat-availability.spec.ts
node scripts/e2e-host.mjs --llm-mode=success e2e/real/chat-availability.spec.ts
node scripts/e2e-host.mjs --llm-mode=disconnect e2e/real/chat-availability.spec.ts
```

`--llm-mode` 只选择受控 fixture 行为：missing 不提供 key，invalid 让 models/chat 返回 401，success 返回至少两个 SSE token，disconnect 在首个 token 后断开。可用 `XIHE_E2E_HEADED=1` 和 `XIHE_E2E_BROWSER_CHANNEL=chrome-beta` 启用 Chrome Beta headed 模式；每轮仍使用独立 DB、host root、端口和 evidence 输出。

## 4. 参考

- XH E2E profile、readiness 和实际结果矩阵：维护在 workspace 私有 internal 层（不在本仓库分发）
- 测试策略决策框架 — 维护在 workspace skill 中
