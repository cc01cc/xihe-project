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

> 🧊 **lane 冻结（2026-10-07 用户裁定；2026-10-09 mise 已注释）**：`real/compose` lane 及其 `mise run test:e2e:compose` / `test:e2e` 已随 docker 服务化冻结停用（只有 PostgreSQL 保留容器，服务全 host）。下表 compose 行保留作历史参考；实际验收走 `real/host` lane（`mise run test:e2e:host`）。

| 层 | 外部依赖 | 启动方式 | 用例数 |
|----|---------|---------|--------|
| mock | 无 | `webServer` 自动启动 Vite dev | 数量随用例扩展变化 |
| real / compose | Docker Compose 的 CP/Agent/Runtime/PG + host UI | `mise run test:e2e:compose` 自动管理 Compose **[已冻结 2026-10-07]** | 默认排除 `@host` 用例 |
| real / host | Windows native CP/Agent/Runtime/UI + 每轮隔离 PostgreSQL/host root/Sandbox | Host E2E runner 按每轮 `e2eRunId` 编排隔离环境 | 执行 `@host` 用例；禁止连接长期 dev DB |

### 1.2 Playwright 配置

```typescript
// playwright.config.ts 核心配置
单 project（chromium 语义，配置无 projects 数组；viewport 1920×1080）+ `animations:disabled` + `trace: retain-on-failure`（**非空** real/embedding key `XIHE_E2E_REAL_KEY`/`XIHE_E2E_REAL_XIAOMI_KEY`/`XIHE_E2E_REAL_DASHSCOPE_KEY` 存在于测试进程时强制 `off`，空串回退 `retain-on-failure`——trace 会捕获 `APIRequestContext` 请求体，2026-10-30 BL-148）+ 按 profile 的 `grep/grepInvert` + `webServer: pnpm dev`
timeout: 30000ms
retries: 1
screenshot: 'only-on-failure'  // 仅失败时保存实际截图
toHaveScreenshot: { threshold: 0.2, maxDiffPixelRatio: 0.01 }
deviceScaleFactor: 2            // Retina 级别截图
```

所有页面跳转使用 `load`/`domcontentloaded` 并配合具体 DOM 元素可见性断言；禁止 `networkidle` 等待策略，以避免 Vite HMR 和 SSE 长连接导致假死。

### 1.3 Profile 策略

xihe 使用单个浏览器 project（chromium），通过 `XIHE_E2E_PROFILE` 区分运行拓扑：

- `compose`：**[已冻结 2026-10-07]** 由 `scripts/e2e-compose.mjs`（任务 `test:e2e:compose`，旧名 `test:e2e`/`e2e-real.mjs`）启动 frozen Compose，只执行 Compose 可支持用例，排除 `@host`。任务已在 mise.toml 注释，禁止用于验收。
- `host`：以每轮隔离的 host 环境执行 `@host` 用例，覆盖 Runtime-created Sandbox 和 WorkspaceStorage；成功、失败和中断都必须 teardown 并反向断言无残留。
- 未设置 profile：不做过滤，供人工诊断使用；不能将该结果作为标准 Compose 或 host 门禁。

依赖 Docker Engine socket、`XIHE_WORKSPACE_HOST_ROOT` 或 Runtime Sandbox 的用例必须标记 `@host`。

受本机 Docker/Playwright 内存预算约束，Mock、Compose 和 Host E2E profile 应分开串行执行；不要并发启动多个浏览器/Docker 测试套件，以免 OOM 后产生不可靠失败。

禁止通过 `test.skip()` 或放宽断言掩盖拓扑缺失。

### 1.3a 会话终止的 E2E 口径（PLAN-0581）

账号被管理员禁用/软删/重置密码后，**双通道同时失效**（access 的 `tv` 与 refresh 的 `sv`），E2E 侧的可判定链路固定为：

1. 用户上下文发一次业务请求 → 网络层出现 **401**（`code=AUTHORIZATION_REQUIRED`，来自 access 通道，不是新错误码）；
2. 前端的静默刷新（0546 `ensureRefreshed`）打到 `/api/v1/auth/refresh` → **刷新失败**（refresh 通道的 `sv` 不匹配）；
3. 页面落到 `/login`，且 `localStorage` 的 `xihe-token`／`xihe-refresh-token`／`xihe-user` 三个键均已清除。

反向对照必须同批存在：**角色变更后用户不被登出**（access 401 → 刷新成功 → 重放，刷新出的 access 带新 `role`），用来证明双通道没有被错误地合并成一个开关。这两条属 `browserConsumer` 证据，归 L1/L2 波次执行；API 级的同源断言在 CP 集成测试（`UserAdminIntegrationTest`）里已有。

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

### 3.2 E2E-only 时序屏障（PLAN-0536）

需要确定性排列「浏览器请求已到 CP」与「真实状态变更」时，不要在测试里 mock 服务端响应——那证明不了真实状态校验。CP 提供 `@Profile("e2e")` 的 Run-scoped 屏障（`/internal/v1/e2e/guidance-barrier`），仅 host runner 的服务 token 可调用；`dev`/`prod` 不激活该 profile，路由不存在。

```bash
node scripts/e2e-host-detached.mjs --timeout-min 45 \
  e2e/real/plan0536-guidance-race.spec.ts --llm-mode=approval --retries=0
```

约束（实测得出，细则见 `plans/archive/PLAN-0536-xh-guidance-race-error-e2e/spec/e2e-guidance-barrier.md`）：

- 屏障必须挂在 controller、service 事务之外。service 事务内先锁 Session 再锁 Run，与 cancel 路径同序，停在那里会让 cancel 撞锁超时（503），竞态永远构造不出来。
- 起跑顺序固定为 arm → `state=reached` → 真实状态变更 → release → 生产校验返回原错误码。
- 超时返回 `503 E2E_GUIDANCE_BARRIER_TIMEOUT` 且不落库；`try/finally` 里无条件 release。
- 断言 console 时，被测试**故意触发**的 4xx 会带一条浏览器资源错误日志，需精确放行该条，不要整体放宽。

### 3.3 认证限流车道（PLAN-0566 D6 双栈）

runner 以 `--auth-lane=<exempt|ratelimit>`（默认 `exempt`）选择 CP 的认证限流 env 注入；键面全部复用既有 `XIHE_CP_AUTH_*`（`application.properties` 0558 段），产品代码零改动，禁止 shell/mise 全局预设：

| 车道 | 注入键（CP serviceEnv） | 用途 |
|---|---|---|
| `exempt`（默认，全矩阵） | `XIHE_CP_AUTH_LOGIN_REGISTER_MAX_ATTEMPTS=0`（维度关闭，service 直接 return） | journey/mock-full 等批内 register 调用不被 429 击穿 |
| `ratelimit`（限流断言栈） | `XIHE_CP_AUTH_LOGIN_REGISTER_MAX_ATTEMPTS=6`、`XIHE_CP_AUTH_TRUSTED_PROXIES=127.0.0.1/32,::1/128`（回环 remote 判 trusted → 非回环 XFF literal 生效）、`XIHE_CP_AUTH_LOGIN_ACCOUNT_MAX_FAILURES=3`、`XIHE_CP_AUTH_LOGIN_ACCOUNT_LOCK_SECONDS=6` | `auth-rate-limit.spec.ts` 反向断言（429 + `AUTH_RATE_LIMITED` + `Retry-After`）与 `auth-lockout.spec.ts`（`@host`，登录用 identifier 选择器）接线运行 |

```bash
node scripts/e2e-host-detached.mjs --timeout-min 25 --auth-lane=ratelimit \
  e2e/real/auth-rate-limit.spec.ts e2e/real/auth-lockout.spec.ts --llm-mode=mock
```

生产与日常 host 栈默认限流开启（不注入 = 既有默认值）；`XIHE_E2E_EXTERNAL_SERVER=1` 复用模式不在该车道判定内。限流的产品侧根因（IPv6 回环豁免失效）另见 PLAN-0571。

### 3.4 时间预算与网络分类（PLAN-0586）

- **批次预算**：mock-full 整批墙钟基线 7.5 min → 6.7 min（0586 优化后 402.8 s，82 passed / 0 unexpected / 0 flaky；证据 `plans/PLAN-0586-XH-e2e-runtime-slim/evidence/m4-final-ab.md`）。新增/改动不得使整批退回 7.5 min 以上。
- **网络分类**：E2E 内的网络等待分三类处置——① 确定性 HTTP/SSE（`waitForResponse`/事件断言）；② 进程 readiness（Agent 重启、Runtime 心跳，用 `expect.poll` + 明确终态）；③ 不确定外部依赖（不得固定 sleep，必须显式 timeout 或 mock）。固定 `waitForTimeout` 视为缺陷（V4）。
- **Agent readiness 实测**：整批负载下 `spawn → health+llmReady` 6 次样本 5.1–7.6 s（n=6 时 p95 等价于 max，即 7.6 s），默认预算 30 s 保留（`XIHE_E2E_AGENT_READY_TIMEOUT_MS` 可覆盖）；失败信息必须带「已等待时长 + 最后状态 + agent 日志路径」便于定位。
- **清理耗时**：带 import 作业的 workspace DELETE ≈11 s/次（空闲工作区 29 ms），批量清理必须并发而不是串行；runner teardown 的零残留复核不变。

## 4. 参考

- XH E2E profile、readiness 和实际结果矩阵：维护在 workspace 私有 internal 层（不在本仓库分发）
- 测试策略决策框架 — 维护在 workspace skill 中
