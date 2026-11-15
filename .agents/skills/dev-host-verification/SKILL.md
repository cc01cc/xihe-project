---
name: dev-host-verification
description: '[Scope: A03-xihe] 验证 Windows native + Docker dev:host 的 Runtime readiness、M1 Sandbox/WorkspaceStorage、Playwright host profile 和可恢复清理。适用于 Xihe Runtime 调试与 E2E 排查。'
---

# Dev-Host Verification — Xihe M1

`M1`（`M1a/b/c`）在 `dev:host` 的四层验证曾需手工串联 `cargo`/`docker`/`Playwright`。本 skill 固化验证顺序、host/Compose 边界、Runtime readiness 门和可恢复清理要求；它不把日常开发数据库当作隔离的 E2E 数据库。

## 四层

| 层 | 命令 | 判定 |
|----|------|------|
| 纯逻辑 | `cargo test --lib` | Runtime library tests pass; do not hard-code an old count in the skill |
| 挂载 | `cargo test --test m1b_mount_test -- --nocapture` | `sentinel` host/container content and writability agree |
| 隔离 | `cargo test --test m1c_strict_test -- --nocapture` | Strict `network none` and both probes pass |
| 端到端 | `POST /internal/v1/runtime/workspaces` → `docker ps` → read `/workspace/.xihe-sentinel` → delete | Native Runtime, Docker Sandbox and `XIHE_WORKSPACE_HOST_ROOT` are all in the same topology |
| 真机 UI | `mise run test:e2e:host` or a named `@host` Playwright file | Browser evidence is reported separately from Compose and includes readiness/cleanup |

## Host Preconditions

Before running host-only tests:

1. Start PostgreSQL and native CP/Agent/Runtime/UI with `mise run dev:host`.
2. Verify CP `/actuator/health`, Agent `/internal/v1/agent/health`, Runtime `/health`, Runtime `/ready`, and UI root separately. `/health` is liveness; `/ready` means assignment hydrate/reconcile has completed.
3. Build `xihe/workspace:latest` when a test creates a Sandbox container.
4. Use an isolated E2E database or a controlled assignment set. The daily database accumulates assignments, and serial cold hydrate can keep `/ready` at `503` long enough to prevent Playwright from starting.
5. Record profile, ports, assignment count, readiness result, test count, and cleanup result.
6. **worktree 内跑 CP 测试要显式传 Python 环境**：worktree 没有 `.venv` 时 `ContextEventReadContractIntegrationTest` 会**失败（不是 skip）**，加 `-Dxihe.context.python=<主检出 .venv 的 python>` 即可；看到该测试红先确认此 property，别当回归排。

## Commands

```toml
[tasks."test:e2e:host"]
run = "node scripts/e2e-host.mjs"
description = "Run host-only real E2E after Runtime readiness"
```

```powershell
cargo test --lib
cargo test --test m1b_mount_test -- --nocapture
cargo test --test m1c_strict_test -- --nocapture
mise run dev:host
mise run test:e2e:host
```

需 Docker Desktop 运行且 `xihe/workspace:latest` 已构建。Compose profile 不提供 Runtime-created Sandbox 所需的 Docker socket 和 host storage 映射，不能用 Compose 结果替代 host evidence。

## Cleanup and Evidence

- `scripts/e2e-host.mjs` 失败时必须保留 readiness、最近 hydrate/reconcile 和 Playwright 是否启动的结果。
- 停止 host 栈使用 `pwsh -File scripts/dev-host.ps1 -Stop`；它可以移除 Sandbox 容器，但必须保留 `XIHE_WORKSPACE_HOST_ROOT` 下的文件。
- 不要清空日常数据库或删除 host workspace 作为隐式测试前置。若需要重置，先创建隔离 DB/volume 或获得明确的数据处置确认。
- 截图 baseline、actual/diff、trace 和日志分别记录来源；baseline 通过不等于人工 UI 审查通过。

## Persistent 栈窄用例跑法（2026-09-13 实证）

1. `node scripts/e2e-host.mjs --persistent --llm-mode=<mode>` 起栈；状态在 `.tmp/e2e-host/persistent-stack.json`（ui/cp/agent/runtime 端口与 pid）。
2. 窄跑 Playwright：**必须带 `--config`**（只传 spec 路径会因无 baseURL 报 `Cannot navigate to invalid URL`）：
   `npx playwright test --config e2e/playwright.config.ts e2e/real/<spec>.ts`
   env：`XIHE_E2E_PROFILE=host`、`XIHE_E2E_EXTERNAL_SERVER=1`、`XIHE_UI_PORT`、`XIHE_CP_PORT`、`XIHE_E2E_LLM_MODE`、`XIHE_E2E_BROWSER_CHANNEL=chrome-beta`。
3. 冒烟脚本复用账号：首跑 `SMOKE_REGISTER_EMAIL=<email>`，后续用 `SMOKE_EMAIL=<email>`（Agent 单 workspace 绑定，换 workspace 会被拒）；fake LLM 模式对内容标记有要求（如 `XIHE-E2E-WRITE <path> <content>`）。
4. 收尾 `node scripts/e2e-host.mjs --teardown`；三跳结果在 `logs/{agent,cp}.log`（JSONL，按 `toolCallId` 过滤）。

## 探针代码的 lint 规则夹逼（2026-11-15 实证）

E2E 探针经常要**在浏览器侧挂钩平台对象**（例：记录 `writeTabWorkspace()` 的落盘时刻，只需给 `sessionStorage` 的写入打时间戳）。这类代码会同时踩到两条 oxlint 规则，**单看一条会以为另一条是错的** —— 这是「规则夹逼」：两条都满足才算修好。

**两条规则各自的诉求**

| 规则 | 诉求 | 对钩子代码的影响 |
| --- | --- | --- |
| `eslint/func-names` | 函数表达式**必须有名字**（调用栈里能看出是谁） | `= function (key, value) {…}` 被点名 2 次 |
| `eslint/func-name-matching` | 赋给属性/变量的函数名**必须与目标同名** | 改成 `= function xhSetItem(…)` 后反而被点名 2 次（`0 → 2`） |

**最小可复现片段（唯一正确解就是最后一行的写法）**

```js
const original = Storage.prototype.setItem;

// ❌ eslint/func-names ×2：函数表达式没有名字
Storage.prototype.setItem = function (key, value) { /* … */ };

// ❌ 改成有名字了，但 eslint/func-name-matching ×2：名字与赋值目标 `setItem` 不同
Storage.prototype.setItem = function xhSetItem(key, value) { /* … */ };

// ✅ 两条同时满足：有名字，且名字 === 赋值目标
Storage.prototype.setItem = function setItem(key, value) { /* … */ };
```

**实测顺序（先看到哪条错、改了又被哪条拦）**

1. 首版匿名函数 ⇒ `check-lint-warnings --enforce` 报 **`+2 eslint(func-names)`**（该族 `1 → 3`）。
2. 改名 `xhSetItem` / `xhRemoveItem` ⇒ `func-names` 绿，但同一门改报 **`+2 eslint(func-name-matching)`（`0 → 2`）** —— **红点只是换了名字、总数没变**，这一步最容易误判成「上一步的修复没生效」。
3. 改名成与赋值目标**完全同名**（`function setItem` / `function removeItem`）⇒ 两条同时绿，回到 `warnings 711 / 基线 711（Δ+0）/ errors 0`。

**判据与规则**

- 钩子/包装代码写完后**一次跑完** `node scripts/check-lint-warnings.mjs --enforce`（在 `packages/ui`）看**族名**，不要只看条数：`errors` 是硬失败、`warnings` 有 ratchet 基线，**族名才是「哪条规则」**。
- 连续两次红、**条数相等而族名不同** ⇒ 先怀疑规则夹逼，把两条规则名一起查；不要在两颗红之间来回改。
- 这类截面结论写进卡面时**两条规则都要写**（只写一条会让下一个人重踩另一半）。