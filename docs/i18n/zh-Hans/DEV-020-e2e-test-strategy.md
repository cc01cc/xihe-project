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

> **host runner CLI 语义（PLAN-0664 / BL-267，2026-11-04）**：
> ① `--batch=<name>` 与位置 spec 路径是**并集**——批内 spec 全部照跑，位置参数只是追加；要收窄用 `--only=<完整路径|basename|唯一子串>`（子串多命中直接拒绝并列出候选，不猜）；
> ② `--llm-mode`（或 `XIHE_E2E_LLM_MODE`）与 `scripts/e2e-batches.jsonc` 的 `llmMode` 不一致会**拒绝启动**（批声明的车道不能被静默改掉）；跨车道调试需显式 `--allow-llm-mode-override`；
> ③ `--retries` 是 Playwright 每次用例重试，`XIHE_E2E_RETRY_ROUNDS` 是整轮重跑（轮间重置 DB 状态），两者叠加时总尝试 = 轮数 × (1 + retries)；取证跑法建议 `--retries=0` + `XIHE_E2E_RETRY_ROUNDS=1`，避免"重试后通过"掩盖真故障；
> ④ 启动前自检（不启栈、秒级）：`node scripts/e2e-host.mjs --batch=<name> [--only=…] --check-cli`。

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

### 3.1b 有头走查批次（PLAN-0621）

有头走查是**人眼可复核**的场景批次（每步 `test.step` + 截图 + 断言），与无头批次**互不收集**：它放在 `packages/ui/e2e/headed/`，而 `mock-full` / `real-full` 的 specs 是目录级 `e2e/real`，因此默认批次永远不含它（`--batch=headed` 才跑）。

```powershell
# 1) 起持久隔离栈（关键：必须带 --bootstrap-user=register，否则 Agent 报 llmReady=missing_credentials，
#    runner 直接判栈未就绪）
node scripts/e2e-host.mjs --persistent --llm-mode=mock --first-run=local --bootstrap-user=register

# 2) 有头走查（复用上面那套栈；Chrome Beta 全机单窗口，跑前确认没有其它有头会话）
$env:XIHE_E2E_EXTERNAL_SERVER="1"; $env:XIHE_E2E_HEADED="1"; $env:XIHE_E2E_BROWSER_CHANNEL="chrome-beta"
node scripts/e2e-host.mjs --batch=headed --retries=0

# 3) 收尾
node scripts/e2e-host.mjs --teardown
```

- **证据落点**：`packages/ui/.tmp/xh-headed-walkthrough/runs/<XIHE_E2E_RUN_ID>/`（`shots/NN-*.png` + `report.json`（每步 step/URL/断言/截图）+ `console-errors.log`）。截图是本地工件，**不提交**。
- **`--bootstrap-user=register` 的必要性**：不传时栈虽起来，但没有账号导入 fake provider profile ⇒ Agent `llmReady=missing_credentials` ⇒ runner 判"栈未就绪"，后续任何 spec 都跑不了。这是 2026-11-02 实测踩到的坑。
- **不进常规门禁**：需要真实显示器 + Chrome Beta，慢且环境敏感；`mise run validate` 与 smoke/mock-full 基线都不含 headed（证明：`npx playwright test e2e/real --list` = 213 tests / 83 files，headed 命中 0；`npx playwright test e2e/headed --list` = 8 tests / 1 file）。
- **走查发现的问题先记账后修**：finding 进 `plans/PLAN-0621-*/evidence/findings.md`，修复前必须先补一条能复现的断言（详见该计划 design §4）。
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

### 3.3b 工作区 docker 后端冻结（PLAN-0612 M4 → **PLAN-0618 完全冻结**）

2026-10-31 的"`test:e2e:host` 唯一豁免"**已被 PLAN-0618（2026-11-01 用户裁定）supersede**：测试面与产品面、默认值一起冻结。

- runner 不再为"跑 docker 用例"注入 `XIHE_WORKSPACE_DOCKER_BACKEND=enabled`；CP 侧按默认 `disabled` 行走（`POST /api/v1/workspaces` 缺 `storageMode` → `400 INVALID_REQUEST`、显式 `managed_import` → `409 BACKEND_DISABLED`、既有 docker 工作区 → `503`，见 [DEV-014 §8b](DEV-014-control-plane-architecture.md)、[DEV-003 §2](DEV-003-config-management.md)）。
- 真依赖容器的 spec 从批次剔除；恢复收集用 `--include-docker-frozen`（**口径由 PLAN-0618 M3 定稿**，本轮文档按此写）。
- 冻结清单（哪些 spec、为什么、解冻后验证什么）只维护在 `plans/PLAN-0618-XH-docker-freeze-complete/evidence/m3-frozen-tests.md`，本文不复制条目；三面冻结范围与解冻步骤见 [DEV-018](DEV-018-known-issues.md)「docker 后端冻结范围」。

### 3.4 时间预算与网络分类（PLAN-0586）

- **批次预算**：mock-full 整批墙钟基线 7.5 min → 6.7 min（0586 优化后 402.8 s，82 passed / 0 unexpected / 0 flaky；证据 `plans/PLAN-0586-XH-e2e-runtime-slim/evidence/m4-final-ab.md`）。新增/改动不得使整批退回 7.5 min 以上。
- **网络分类**：E2E 内的网络等待分三类处置——① 确定性 HTTP/SSE（`waitForResponse`/事件断言）；② 进程 readiness（Agent 重启、Runtime 心跳，用 `expect.poll` + 明确终态）；③ 不确定外部依赖（不得固定 sleep，必须显式 timeout 或 mock）。固定 `waitForTimeout` 视为缺陷（V4）。
- **Agent readiness 实测**：整批负载下 `spawn → health+llmReady` 6 次样本 5.1–7.6 s（n=6 时 p95 等价于 max，即 7.6 s），默认预算 30 s 保留（`XIHE_E2E_AGENT_READY_TIMEOUT_MS` 可覆盖）；失败信息必须带「已等待时长 + 最后状态 + agent 日志路径」便于定位。
- **清理耗时**：带 import 作业的 workspace DELETE ≈11 s/次（空闲工作区 29 ms），批量清理必须并发而不是串行；runner teardown 的零残留复核不变。

### 3.5 隔离栈复用纪律（2026-11-05 实测新增）

`--persistent` 起的隔离栈**不是**可任意换模式的沙箱：`llm-provider` profile 与 fake 连接都落在该栈自己的 PG 行里，换一次 profile 就污染后续所有轮次。

- **真实 provider 轮与 fake 夹具轮不得在同一栈先后跑**。实测（PLAN-0630 S6 真实 key 轮之后紧接 `real/agent-spawn-caller`）：真实轮把 instance 层 profile 换成真实模型（`mimo-v2.6-flash`），而 fake 夹具连接只注册了 `fake-openai` ⇒ 后续建会话 `400 "Model is not registered under this Connection"`；反向切换（real→fake）还会出现 `POST /chat 503` 瞬态。**要么换栈，要么重新 `--first-run=local --bootstrap-user=register` 且不带 real key 重导 fake profile，并等 agent `llmReady=ready`。**
- **每次换代码后必须重建 CP 并落戳**：`scripts/e2e-host.mjs` 的重建分支在打包成功后落 `build-info.properties`（`gitHead()` 取当前 worktree HEAD），并在 task-90 后同批写 jar 指纹清单（§3.6.1）；手跑 `mvn -q -DskipTests clean package -Dxihe.target.dir=<target>` 时清单由谁产出、怎么补，见 §3.6.1「迁移」——外部复用栈（`XIHE_E2E_EXTERNAL_SERVER=1`）会对照 `build-info` fail-fast。
- **浏览器网络瞬态不登记为产品缺陷**：合并后首次启动时 Vite 会 `Re-optimizing dependencies`，此时偶发 `net::ERR_NO_BUFFER_SPACE`（普通 GET 经 dev proxy，非 SSE）。判据=同栈复跑不复现 + CP/agent 侧无断流日志 ⇒ 记观察项，**不得**加白名单或放宽断言。
- mock 车道的 `XIHE_EVIDENCE_DIR` 未设时由 `e2e/helpers/evidence.ts` 回退 `<repo>/.local/evidence/e2e-auto` 并 WARN 一次（此前 4 条用例因此判红，属环境前置非回归）。

### 3.6 E2E 构建根与并行运行（PLAN-0656 R2）

E2E 的 CP 构建根默认是 `C:/xihe-build/e2e`（`scripts/e2e-host.mjs:59-63`，默认值在 `:62`；显式设 `XIHE_CP_TARGET_DIR` 时以环境值为准）。它省掉每个 run 2–3 min 的冷编，代价是**同一构建根同一时刻只服务一个 run**（并发 repackage 的后果见窗口协议 §5，本文不重复）。

- **要并行就给第二个 run 换根**：`XIHE_CP_TARGET_DIR=C:/xihe-build/e2e-runs/<runId>` —— runner 直接把这个值传给 mvn（`scripts/e2e-host.mjs:59-63`），**不需要改代码**；代价是该 run 独立冷编（~2–3 min + 磁盘）。
- **共用根是 E2E 的默认值，不是架构限制**：dev 栈侧的 CP 构建目录早已按 `<root>/<stackId>/<sha12>[-dirty]` 分目录（`scripts/lib/cp-build-dir.mjs:11`，默认根 `:29`，dirty 后缀 `:36`），E2E 只是没走那套派生逻辑。
- **并行只在三条同时成立时允许**：① 两个 run 构建根不同；② 都不是测量类 spec；③ 钉住同一个 SHA（跨 commit 的数字不可比）。开窗前另跑 `node scripts/e2e-preflight.mjs`（只读）：任何 `FAIL` 即阻塞，只有 exit 0（无 blocking finding，`scripts/e2e-preflight.mjs:26`）才开窗。
- **测量类恒独占**：会话规模/内存采样这类 spec 并发跑时，旁边多一个 spec 就改写 GC 压力与内存水位 —— 量出来不是它要的量。
- **窗口本身不在这里**：开窗/冻结/钉靶 SHA 的规则见 SSOT `one/internal/A03-xihe/docs/l2-window-protocol.md`（ONE 私有层，不在本仓）§3–§5。

### 3.6.1 CP jar 指纹（BL-477 / task-90）

共享 CP jar 的身份不再靠 mtime，也不再靠 jar 内的 `META-INF/build-info.properties`：后者是 Spring Boot 打包期生成、`scripts/stack-run.mjs` 事后覆盖的产物，实测**落后 jar 打包 77 分钟**（jar 内含的 commit 与实际构建树差 11 个 CP 文件），拿它当判据会制造新的假红。判据改为 jar **旁边**的清单 `<jar>.buildinfo.json`（例：`control-plane-0.1.0.jar.buildinfo.json`），由产出 jar 的同一段代码在打包完成后**原子写入**（临时文件 + rename），字段：

| 字段 | 含义 | 用途 |
|------|------|------|
| `jarSha256` / `jarBytes` / `jarName` | jar 自身字节哈希与大小 | **身份锚**：证明清单说的是这个 jar，不是上次构建的残留 |
| `sourceTreeSha256` | `git ls-tree -r HEAD -- packages/control-plane` 原始 stdout 的 sha256 | 输入指纹：与 HEAD 现算值相等即"由当前树构建" |
| `commit` / `dirty` / `sourceScope` | 构建时 HEAD 与树是否脏 | 溯源；`dirty=true` 时树哈希不能证明对应 HEAD ⇒ 回退内容判据 |
| `builtAt` | **打包完成**时间（不早于 jar mtime） | 人工核对顺序；不参与判定 |

读取优先序（`scripts/lib/cp-jar-sidecar.mjs`，preflight 产物段第 0 步）：清单匹配且树哈希 == HEAD ⇒ `fresh`；树哈希不同 ⇒ `stale` 归 **`build`**（可延期：`resolveCpBootPlan()` 在门之前跑，重建即治好）；jar 字节与清单不符或清单不可用 ⇒ 归 **`artifact-truth`**（**不可延期**：重建前不许放行）；无清单 ⇒ 回退 task-84 内容判据（行为不变）；树哈希算不出（git 不可用 / 当前树脏 / 构建时树脏）⇒ 同样回退内容判据。

**跳过面（2026-11-08 裁定）**：`--jar-mode=use`、`--jar-mode=native`、`XIHE_E2E_EXTERNAL_SERVER=1` 三种模式（runner 统一折叠成 `--ignore-build` 传给 preflight）**整段跳过产物面**，因此**清单不参与判定**——即使 `C:/xihe-build/e2e` 里躺着 `*.buildinfo.json`，本次运行也不会读它、不会用它、不会因它变绿或变红。跳过不是缺陷，**静默跳过才是**：产物段会打一条 WARN 明写"CP artifact section SKIPPED — <原因>：本模式跳过产物段，CP jar 身份未被校验，后续无人再查"，并紧跟一行"旁边的清单不参与本次判定"。要判定身份就只有两条路：用默认 `--jar-mode=auto|rebuild` 跑一次（门前重建会重写清单），或在外部栈上单独手工核对（见下「迁移」）。

**迁移（旧 jar）**：task-90 之前的 jar（以及手跑 `mvn package` 产出的 jar）没有清单，一律走内容判据；**`scripts/e2e-host.mjs` 重建一次即产出清单，无需任何兼容代码，也不设过期窗口**。手工核对：`git ls-tree -r HEAD -- packages/control-plane | sha256sum` 应与清单 `sourceTreeSha256` 相等；`sha256sum <jar>` 应与 `jarSha256` 相等。**禁止伪造清单**：只有产出 jar 的那条路径能写它，手写清单等于伪造身份证据——写入侧还有一道守卫，jar 的 mtime 比调用时刻早 120 s 以上即**拒写**（事后补写的清单会把当前树冒充成产出树，读侧会据此报 `fresh`，实测复现过）。

**两道闸，别把 120 s 当全部**：写入侧守卫防的是**「事后补写」**（时间窗：补的那一刻写的是"现在"，被证明的是"过去"），**不防「构建期间工作树被改动」**——那种情况下清单记的树哈希确实等于"构建时读到的 HEAD"，但 jar 里装的可能是改到一半的代码。后者由清单的 `dirty` 字段与 `sourceTreeSha256` 记录：`dirty=true` 或树哈希与 HEAD 不符时读侧判 `degraded`/`stale` 并**回落内容判据**（`unverifiable` 依旧阻断）。⇒ **时间窗与树一致性是两道不同的闸，有 120 s 不等于有身份。**

## mode 门控 spec 的漂移风险与夹具前提（2026-11-06 实测）

- **LiveChain 两类默认整类不跑（2026-11-06 审计）**：`ContextSourceLiveChainTest`（`Assumptions.assumeTrue` 要求 Runtime `/ready` 与 dev CP `/actuator/health` 可达）与 `ContextToolHistoryLiveChainTest`（`@EnabledIfSystemProperty xihe.run.v15.live=true`）各 **1/1 用例默认 skip**，全量汇总只体现为 `Skipped: 2`。恢复：起 host 栈后重跑前者；后者加 `mvn -o test "-Dxihe.run.v15.live=true"`。不是漏跑，但不可当作已覆盖。
- **风险**：受 `--llm-mode` 门控的 spec 在日常 mock 车道恒 skip ⇒ **无人跑 ⇒ 随契约漂移**（`BL-358`：`chat-follow-up-queue.spec.ts` 的 approval 路径缺必需 `X-Workspace-Id`，撞 `409 WORKSPACE_CONTEXT_REQUIRED`）。这是"低频路径静默腐烂"的 E2E 版本（同 `BL-357`）。
- **机制**：`--llm-mode` **不经 env 透传给 Playwright**（spec 内读不到 `XIHE_E2E_LLM_MODE`）⇒ 用 `test.skip(process.env.XIHE_E2E_LLM_MODE !== ...)` 做前置门控的 spec，在 runner 直跑下**恒 skip**。
- **要求**：
  1. mode 门控**不要用 env 前置 `test.skip`**，改**运行时探测**（连上后按车道/夹具特征判定可测性）。
  2. 受门控的 spec 必须**定期在对应模式下整跑一次**：每次改动该路径时 + 每周一次（记入该次改动备注或运行记录）。
  3. **UI 建会话夹具前置**：先 `ensureFakeUserProvider` 建 READY provider，再建会话；断言匹配**路径形式** `POST /api/v1/workspaces/{id}/sessions`，不要把字面量焊死。
- **排查顺序**（卡在"建会话"段时）：①READY provider → ②请求路径形态/头（`X-Workspace-Id`）→ **最后**才怀疑车道能力。实测 mock 与 approval 两车道**均支持** UI 建会话（对照探针均 201）。


## 4. 参考

- XH E2E profile、readiness 和实际结果矩阵：维护在 workspace 私有 internal 层（不在本仓库分发）
- 测试策略决策框架 — 维护在 workspace skill 中
