# xihe — 通用 Agent 运行时平台

> 四模块 Hub-Module 架构：多 Agent 编排、工具调用、沙盒执行、权限控制。

## Scope

| 包 | 描述 | 语言 |
|----|------|------|
| `packages/ui/` | 前端界面 (Vue 3 + Vite) | TypeScript |
| `packages/control-plane/` | 路由 + 认证 + MCP 反向代理 | Java 25 / Spring Boot 4 |
| `packages/agent/` | LLM 编排 + 工具调用 + RAG | Python 3.12 / LangChain |
| `packages/runtime/` | 文件系统 + 沙盒 + 进程管理 | Rust 1.97.1 / rmcp 3.7.0 (edition 2024) |

## Tech Stack

各包技术栈与版本以 package manifest/toolchain 为准；全局架构和模块边界见 `DEV-001` 与对应模块 DEV 文档。

## Setup

- 使用 `mise install` 和 `mise run setup` 安装固定工具链与依赖；前置条件及模块命令见 DEV-002。
- 日常 host 开发运行 `mise run dev:host`：仅 PostgreSQL 在 Docker 中，CP、Agent、Runtime、UI 由 mise 原生启动；该命令不导入配置或创建 Provider Connection。启动前会先跑一次 `mise run check:runtime-target`（watch 只打印，FORCE 线 ≥20GB 或 H 余量 <5GB 会阻止启动）。**启动顺序（PLAN-0632 T4.4）**：cp/runtime/ui 仍并行，但 Agent 会先等 CP `/actuator/health`==200（`dev:host:wait-for-cp`，上限 60 s，`XIHE_WAIT_FOR_CP_TIMEOUT` 可覆盖），超时**显式失败并给 CP 日志路径**而不是把 Agent 起成 degraded。项目开发/运维命令见 DEV-002 与 `mise run xihe -- --help`。
- 并行开发（PLAN-0533）：`mise run dev:stack -- --stack 2`（等价写法 —— POSIX shell：`XIHE_STACK_ID=stack-2 mise run dev:host`；Windows PowerShell：`$env:XIHE_STACK_ID='stack-2'; mise run dev:host`）起第二套栈；`stack-1` 端口/路径与单栈时逐项相同，stack-2 起使用独立段位、compose project、PG 库与 `.xihe-stacks/<n>/` 路径，详见 DEV-002「模式 D」。非法/未登记 `XIHE_STACK_ID` 启动即失败；`dev:host:stop`/`dev:reset` 只作用于当前栈。
- **Runtime target 缓存（PLAN-0596）**：worktree 默认保持**独立** `CARGO_TARGET_DIR`（自行用环境变量外置；若你在 one workspace 内，one 侧另有 `worktree-env.ps1` 统一外置），不共享同一 target——并发构建会在 target 锁上串行，且 Windows 上服务进程占用 exe 会让另一 worktree 构建失败；共享仅在源码/工具链/profile 完全一致时有收益。`clean:runtime-sweep` 只作用当前 `cargo metadata` 的单个 target；`--maxsize 12GB` 无单位按 MiB（≈11.18 GiB）。`mise run clean` 是 `rm -rf` 的**永久删除**入口（不进回收站、无警告），执行前确认无构建/服务占用；缓存按「删除 + 重建」处理，不做跨盘搬运。**构建产物根可配（task-80，2026-11-08）**：`XH_CARGO_TARGET_ROOT`（**本机值在 gitignored 的 `mise.local.toml`；仓库内不写机器绝对路径**）决定整个 target 家族的位置，布局 `<root>/{main,stack-N,e2e}`，linked worktree 再加一层 `<root>/<worktree 目录名>/`；优先级 `CARGO_TARGET_DIR` > 该变量 > 旧推导 `<one>/.tmp/cargo-target`，**未设变量时行为逐字节不变**（`scripts/lib/stack-cargo-target.test.mjs` 断言）；变量指向不存在/相对路径即 fail-fast。换盘改 `mise.local.toml`（`mise run` 下外壳 export 不生效）。**覆盖范围**：经 `scripts/cargo-run.mjs` 的 mise cargo 任务（build/test/lint/sweep）落 `<root>`；未经 wrapper 的裸 `cargo` 与 IDE/rust-analyzer 仍按 `.cargo/config.toml` 落 `<one>/.tmp/cargo-target/main`（残余）。详见 DEV-002 §6。
- **docker 冻结（2026-10-07 用户裁定，2026-10-09 强化；工作区后端面由 PLAN-0618 收口为完全冻结）**：
  - **现状（2026-11-01 起，PLAN-0618 完全冻结）——工作区 docker 执行后端不可用**：产品面 + 测试面 + 默认值**三面一起冻，解冻时一起解冻**。默认 `storageMode` 是 **`direct_attach`**，且 `POST /api/v1/workspaces` 的 **`storageMode` 必填、无默认值**（缺 → `400 INVALID_REQUEST`，字段契约见 `docs/api/openapi.yaml` 的 `WorkspaceCreateRequest.required`）；显式 `managed_import` → `409 BACKEND_DISABLED`；既有 docker 工作区的执行/文件/环境/**会话/聊天** → `503 BACKEND_DISABLED`（fail-closed，不回退宿主）。产品面（UI、CLI）**必须**在调用前显式提示不可用并指向 `direct_attach`，不得让用户走到容器创建才收到原始错误。测试面用 `@Tag("docker-frozen")` + Surefire `excludedGroups` 默认排除、E2E 用 `--include-docker-frozen` 恢复；范围与解冻步骤见 [`DEV-018`](docs/i18n/zh-Hans/DEV-018-known-issues.md)「docker 后端冻结范围」。**不存在"唯一豁免车道"**。
  - **服务容器化/镜像构建**（2026-10-07 裁定，2026-10-09 强化）：`mise run dev:full` / `dev:backend` / `test:e2e:compose` / `test:e2e` / `image:workspace:build` 已在 `mise.toml` 注释冻结（文件头有冻结说明与解冻条件），禁止误启；日常用 `mise run dev:host`，隔离 E2E 用 `mise run test:e2e:host`。
  - **历史（已 supersede，勿作现状引用）**：2026-10-25「Docker 执行后端代码内部同样冻结——可继续使用但不做功能修复」；~~"工作区 Docker 执行后端不受冻结影响，`managed_import` 仍以 docker 为唯一执行后端，默认新建工作区继续使用它"~~ 与 ~~"`test:e2e:host` 是本条唯一豁免"~~ —— 两句均被 **2026-10-31 裁定**收紧、并被 **2026-11-01 PLAN-0618 完全冻结**取代。若必须改 `backend.rs`/`container_runtime.rs`/`executor.rs` Docker 分支/`environment.rs`/`sandbox/`，descope 该子任务并另立计划。因此 `xihe/workspace:latest` 的镜像供给不再是产品首用前置。
- `mise run dev:reset` 默认 dry-run；显式重置前检查备份与数据范围。`reset-admin` 输出临时开发密码，不得写入脚本、源码或日志。**D-766 起** `dev-stack` 起栈会自动注入并 upsert dev 管理员密码，持久位置是 gitignored 的 `.local/dev/admin-password`（0600，日志不含值）——细则见 DEV-002 §4「dev 管理员密码自动注入」。

## Commands

- 台账只读校验（PLAN-0677）：在 ONE 工作区根运行 `mise run ledger:validate`，只读校验 BL/PLAN 结构；**报告不阻断**（保留工具退出码，未并入 `validate`），观察无新增违规后再议阻断。
- CP 已知基线门（BL-368，2026-11-06）：先跑 `mise run test:cp`（当前基线 0 条；全量现存预存红——最近记录 10 条，主因 PLAN-0691 插件面未同步，见 `BL-489`——修好后才可能绿），再独立跑 `mise run test:cp:baseline` 判定"失败 ⊆ `scripts/cp-known-baseline.json`"；基线**只许缩小**、条目转绿必须删、`reviewBy` 过期即失败，**不接 `validate`**（避免吞 Maven 输出）。**报告新鲜度门（2026-11-06 实测补）**：脚本会比较 surefire 报告最新 mtime 与 `HEAD` 提交时间，**报告早于 HEAD ⇒ exit 2 并要求重跑**（否则会拿旧树的失败去判新树 —— 实测曾在缩基线后误报"1 个新失败"）；显式 `--allow-stale-reports` 才可绕过。
- BL-262 防再犯门（2026-11-04）：`mise run test:runtime:lib:gate`（串行 1 + 并行 3 竞态复验）、`test:runtime:lib:ignored:isolated|functional|mxc`（ignored 三档，显式列名 + 实测超时；`:mxc` 需 `XIHE_MXC_EXECUTABLE`）均**不进 `validate`**；`test:cli` 内嵌 `scripts/check-test-global-state.mjs` 静态扫描（测试代码不得裸改进程级全局状态）。
- **E2E in-page bypass 静态门（PLAN-0687，report-only）**：`mise run check:e2e-bypass` 扫描 `packages/ui/e2e/real/**` 的 `page.evaluate(...)` 块内 `fetch(`（浏览器页内直连后端 API，可能绕过被测产品 UI）。命中必须带 `// fixture-only: <理由>` / `// read-only: <理由>` 标注，或登记在 `config/e2e-inpage-bypass-allowlist.json`；默认只报告（`--report-only` 恒 exit 0），显式 `--enforce` 才阻断，**不进 `validate`**。完成产品行为的 in-page fetch 必须改走产品 UI 路径，不得用标注洗白；mock lane 不在判据内。判据与裁定见 PLAN-0687。
- **i18n 门禁（task-96，2026-11-10）**：`mise run lint:i18n`（= `node scripts/i18n-scan.mjs`，**只读**：不改 UI 源码与 locale、不写文件）三查 —— ①zh-CN/en-US 键集合差集 ②同键 `{placeholder}` 漂移 ③源码静态 `t("…")` 引用能否在两侧解析。通过时**零输出**、exit 0；有问题 exit 1 并逐条点名（第 ③ 类带 `file:line`）；脚本自身或仓库结构坏掉 exit 2（脚本问题≠产品问题）。已并入 `mise run lint`，`-- --json` 出结构、`-- --root <dir>` 扫别的根。自测 `node --test scripts/i18n-scan.test.mjs`；口径与踩坑见 DEV-002 测试入口段与 [`packages/ui/AGENTS.md`](packages/ui/AGENTS.md)。
- 单文件/包级命令见对应包指南；里程碑和 PLAN 收尾运行 `mise run validate`，仅按改动边界增加集成/E2E profile（DEV-020/021/022/023）。**类型门（D-727）**：`mise run check:types` 依次跑 UI `typecheck` + `typecheck:e2e`（≈20–40 s，失败即非 0），**每个 verify 窗必跑**——`validate` 里的 `typecheck` 只覆盖 UI。`validate` 若被存量环境性基线失败 fail-fast 挡住（白名单见 workspace 私有技术债文档《xh-backlog-and-debt》的「环境性基线失败白名单」），改按组件级补跑（lint:links / runtime / test:cp / test:agent / test:ui / build:ui）并逐红点做基线对照，不因存量红点阻塞收尾。**契约面必须过 `mise run check:openapi`**（BL-162：它已是 `test:cp` 与 `validate` 的依赖，契约漂移会让 CP 测试波次直接红，不允许绕过）。
- Agent 质量回归门（PLAN-0512/0540，本地 lane）：`mise run gate:agent-quality -- --report <invariant.json> --report <behavior.json> --baseline <baseline.json>` 只读消费每个 lane 一份的评测报告（v2 gate 合并判定），退出码 `0/1/2/3` = `PASS/FAIL/NOT_EVALUATED/GATE_ERROR`（仅 PASS 退出 0）；阈值、required/expected task 集在 `packages/agent/evaluation/gate-v2.json`（含证据溯源），契约见 DEV-025，未接 CI。
- Compose E2E（`mise run test:e2e:compose`，旧名 `test:e2e`）**已冻结注释（2026-10-07 docker 冻结裁定）**，不得用于验收或临时验证；Sandbox/host E2E 使用 `mise run test:e2e:host`，由 host runner 管理每轮隔离环境。清理/就绪要求见 [`DEV-020`](docs/i18n/zh-Hans/DEV-020-e2e-test-strategy.md) / [`DEV-021`](docs/i18n/zh-Hans/DEV-021-integration-test-strategy.md)。
- 环境搭建、模块任务、资源清理和全栈排障见 [`DEV-002`](docs/i18n/zh-Hans/DEV-002-developer-guide.md)。
- **打包产物入口（PLAN-0632 M2）**：`mise run pkg:launcher -- start|status|stop`（随包 supervisor，顺序 **PG(TCP) → CP(`/actuator/health` 200) → Agent → Runtime → UI**，每步 readiness 门 + 探针日志；参数照旧用 `--` 透传）与 `mise run pkg:installer`（可重跑的 NSIS 构建，`-- --stage-only` 只组装 stage）。产物只写 `.tmp/pkg/`（gitignored），不入库；开发机上 `pkg:launcher status` 报 `ok:false`（把 `dev:host` 的监听视为 foreignListeners）属预期，不是打包安装的健康检查失败。
- **栈构建新鲜度（PLAN-0662，运维口径）**：`health UP` 不代表跑的是当前代码；**重启/复用栈前先看 verdict** ——`mise run dev:host:status`（`-- --json` 字段 `runningCommit`/`headCommit`/`behind`/`stale`/`verdict` 是 lane 脚本的固定契约）。`verdict` 非 `fresh` 时 `stack-run.mjs cp` 会在 `mvn` 前默认 `clean compile` 重建（`--no-rebuild` 显式跳过并 WARN）；外部复用栈跑 E2E 时 runner 会断言 CP build commit == `XIHE_E2E_EXPECT_CP_COMMIT`（缺省取 HEAD），不匹配或读不到 `build-info` 一律 fail-fast。构建戳在 `classes/META-INF/build-info.properties`。**判据释义（2026-11-05 实测补）**：`cpBuild.verdict` 永远是**相对当前 HEAD 的实时判定**——`stale` 只表示"该栈运行的 commit 落后于 HEAD"，不代表刷新失败；`.current` 指针里记录的 `fresh` 是**写入时刻**的事实，**不得当验收依据**。合入活跃期（1–2 分钟一跳、单轮刷新 ~40s）追"实时 fresh"无意义 ⇒ 分层：**日常运维口径** = `runningCommit` 是 HEAD 的已知祖先 + `dirty=false` + targetDir 同 sha + 端口 ready（`behind>0` 仅信息）；**验证口径（真栈证据/L2/归档门）** = `runningCommit == headCommit` 且**验证期间禁合入**（Lead 宣布冻结窗口 + 钉靶 SHA，或显式 `XIHE_E2E_EXPECT_CP_COMMIT`）。已知缺口：启动日志**并无** `cp.build commit=` 行（2026-11-05 两栈实测均无，与原描述不符）、`agent`/`runtime` **无 commit 字段** ⇒ 非 CP 服务的新鲜度目前只能靠 `dev-stack.mjs status` 的进程启动时间与 build 戳间接判，已登记 BL-324。判据与实测见 `plans/PLAN-0662-dev-stack-freshness/`。
- **栈租约（PLAN-0694，运维口径）**：`dev-stack.mjs` 用 `.xihe-stacks/<n>/lease.json` 记录"这栈是谁起的"，`status` 对**每个**租约字段做独立事实交叉校验（pid 死活 / 端口是否在听 / `instanceId` / `cpVersion` / pid 漂移 / 可选 `phase`），失配进 `mismatch[]`、核不了记 `unverifiable`；**心跳超 TTL（10 min）单独记 `lease-cold`（输出字段 `lease.state` = `live`|`cold`），是信息项：不进 `mismatch`、不进 `reasons`、不改 verdict 与退出码** —— `cold` 只表示"这栈最近 10 分钟没人跑过一次 `status` 交叉核对"，不是故障（`verdict` 只由事实决定）。因此 `ok` 只在"事实全绿 + 所有字段都核得上（冷暖不计）"时为真；**升级前起的旧栈首次 `status` 会报 `verdict=ghost` + exit 1（不是故障）**，迁移 = `acquire --stack <n>` 认领或重启一次；`acquire`/`release`/`gc`/`status --all` 只读优先、`gc` 零 kill。改 `.xihe-stacks` 路径/端口/`heartbeatAt` 语义见 DEV-002 §4（`dev-stack` 状态与租约契约）。
- 根 `README.md`（英文 GitHub 门面）与 `docs/i18n/zh-Hans/README.md`（中文文档页）独立维护；架构图、Quick Start 命令、端口和技术栈摘要同批同步，功能状态表仅在中文版维护。`scripts/sync-readmes.sh` 只管理包 README symlink，不管理根 README。
- **CP 构建目录按栈隔离（BL-253 L3）**：每栈一个 `C:/xihe-build/cp/<stackId>/<sha12>[-dirty]`（`XIHE_CP_BUILD_ROOT` 可改根），`.current` 记录该栈**最后一次启动**所用目录；`cpBuild.targetDirSource` = `pointer`/`newest`/`env`/`derived`（**新增字段，旧字段契约不变**）。保留只走显式清理 `mise run dev:host:cp-build:clean`（默认 dry-run，`-- --apply` 才删；每栈留最新 3 个 + 指针目标；绝不碰 legacy 目录）。回滚通道 = 显式 `XIHE_CP_TARGET_DIR`（优先级最高）。切布局后各栈**下次重启**首建约 60s，谁重启谁核 `verdict=fresh`+四端口。
- **dev 热循环（试行，2026-11-08）**：「改一行多久看到效果」的能力分层、dev/验证两条通道与两条禁令（**dev 产物不得当验收证据 / 验证通道不得复用 dev 根**）见 ONE 工作区 `internal/A03-xihe/docs/dev-hot-loop.md`（**跨仓路径**，不入本仓正文）；试行 2 个工作日后由 Lead 复核持久化/修订/废弃。

## Architecture

四模块 Hub-Module。全局架构见 [`DEV-001`](docs/i18n/zh-Hans/DEV-001-system-architecture.md)；当前实现与项目目标契约分别按模块查阅 DEV、OpenAPI/inventory 和根级 `spec/README.md`。

- 配置边界见 [`DEV-003`](docs/i18n/zh-Hans/DEV-003-config-management.md)：bootstrap/deployment env 与 ConfigService 业务配置不是同一层；凭证只走受控加密通道，env/DB 冲突必须显式呈现，secret 不得写入仓库或日志。
- Agent、CP、Runtime、MCP 当前实现分别见 [`DEV-013`](docs/i18n/zh-Hans/DEV-013-agent-architecture.md)、[`DEV-014`](docs/i18n/zh-Hans/DEV-014-control-plane-architecture.md)、[`DEV-015`](docs/i18n/zh-Hans/DEV-015-runtime-architecture.md)、[`DEV-016`](docs/i18n/zh-Hans/DEV-016-mcp-architecture.md)；API wire 以 `docs/api/openapi.yaml` / `inventory.md` 为准。SPEC 是目标契约入口，`proposed` 不代表已经实现。
- Runtime/Sandbox 后端与生命周期契约见 [`DEV-031`](docs/i18n/zh-Hans/DEV-031-sandbox-backend-contract.md)。未知 Workspace、后端不可用或超时必须显式失败；MXC/Docker 故障不得自动回退到宿主执行。`windows-host/unrestricted` 只能由用户显式选择；进程沙盒只约束受其管理的进程，不得据此宣称宿主 Workspace 外写入安全。host execution 仍受原有授权/审批约束；删除执行实体不得删除 WorkspaceStorage。
- Runtime 的实现字段（如 pid、wrapperPid、policyPath、mxcTier）不得透传到 API；CP/API view 必须显式过滤内部与敏感字段。
- Workspace/Session、ChatRun、Workspace Job 与 MCP invocation 不变量见 [`DEV-017`](docs/i18n/zh-Hans/DEV-017-session-architecture.md)、DEV-014 和对应 SPEC；模块间变更必须按下方跨协议门禁同步。

## SPEC Contract Layer

- `spec/README.md` 是项目契约入口；涉及 XH 架构/数据/API/安全边界时先读入口和关联 SPEC。`AGENTS.md` 只定义工作规则，DEV/OpenAPI/代码分别承载实现解释、wire schema 和当前事实。
- `proposed` 是目标草案，不得当作运行事实。Security 是 authentication/principal/role/scope/authorization 的唯一正文 owner；Agent 规范只写自身绑定、传播和消费。
- 一个根 SPEC 同时只能由一个 active PLAN 承接；不得由 Agent 自动改写 active SPEC。XH PLAN 声明 Spec Impact，并按 `spec/README.md` 同步 DEV、OpenAPI/事件 schema 与测试。
- SPEC 是 Agent/GitHub-only，不走文档站 frontmatter。详细规则见 `spec/README.md`、`spec/writing-guide.md` 和 [`DEV-030`](docs/i18n/zh-Hans/DEV-030-documentation-layout-and-frontmatter.md)。

### API 契约治理（2026-11-10 用户裁定，见台账 D-800）

- **`docs/api/openapi.yaml` 是 API wire 契约的唯一 SSOT，并且是人工维护的**（CP 源码 springdoc 注解实测为 0；运行时 `/v3/api-docs` 只是反射产物）。**代码与之背离时改代码**，不得拿文档去迁就现状；确属有意变更契约时走 PLAN + 同批改消费者。
- **改接口的顺序固定**：先改 yaml（`requestBody`、错误码、示例）→ 再改代码 → 最后跑契约门。顺序反了等于先上车后补票。
- **四条契约门各管一轴，禁止混用**（混用会得出「有缺口」或「已覆盖」的错误结论）：

  | 轴 | 守门人 |
  | --- | --- |
  | 语法 + 冻结切片 | `check:openapi`（BL-162，`scripts/validate-openapi.mjs`；**注意它用 oxfmt 当 YAML 解析器，不报重复键**） |
  | contract ↔ code | `RouteContractParityTest`（BL-320，用 live `RequestMappingHandlerMapping`，带豁免表） |
  | 规范级自洽（`$ref` 可解析 / `operationId` 唯一 / 无 unused） | `check:openapi:lint`（redocly，dev-only，**report-only 起步**） |
  | doc ↔ contract | `check:api-docs`（生成器 `--check`，PLAN-0763 M4） |

- **各服务运行时原生文档一律降级为调试/对账产物**：CP 的 `/v3/api-docs` **默认关闭**（`XIHE_SPRINGDOC_ENABLED=true` 或 `dev`/`e2e`/`test` profile 才开，PLAN-0763 M6），Agent（FastAPI）的 `/openapi.json`，不得当文档引用、也不得当「实现侧分母」。实测 springdoc 比 live mapping **少报 15 条路由**，且**完全不收录 `/internal/**`**（yaml 独有 84 条里 64 条是 `/internal/`）。**Agent 的 HTTP 面 SSOT 同样是本 yaml**（`/internal/v1/agent/**` 26 条），其 `/openapi.json` 只用于漂移对账（PLAN-0763）。
- **配置域 `{domain}`**：合法集合由 `classpath:config-schemas/*.json` 决定（13 个域，`ConfigDomainSchema` 启动加载）。yaml 侧用 `enum` 声明同一集合，另设一道门断言「yaml enum 集合 == schema 文件名集合」。**json 承载每域字段结构、enum 承载域名名单，二者不可互替**；新增域 = 加一份 schema + 加一个 enum 值，门会拦住单边改动。
- 分组与快照：`openapi.yaml` 用 `tags`（operation 级）+ `x-tagGroups`（两级：public 17 / internal 3）；MCP tool 面见 [`docs/api/mcp-tools.md`](docs/api/mcp-tools.md)（**权威是 `tools/list` 握手，文档是快照**）。契约地图见 [`DEV-034`](docs/i18n/zh-Hans/DEV-034-spec-contract-map.md)。

## Code Style and Cross-Boundary Rules

- 命名遵循语言惯例；领域术语见 [`DEV-032`](docs/i18n/zh-Hans/DEV-032-terminology.md)。`catch` 必须记录、转换或重抛异常（`exception-audit`）。
- UI 组件与交互规则见 [`DEV-010`](docs/i18n/zh-Hans/DEV-010-ui-architecture.md)、[`DEV-011`](docs/i18n/zh-Hans/DEV-011-ui-checklist.md) 和 `packages/ui/AGENTS.md`；Chat/Session 细节见 DEV-013/014/017。
- Service 层保留纯函数边界：配置由所属调用方解析并注入；要改变 ConfigClient 依赖方向时，先核对该模块的当前 DEV/调用者。
- 配置 key 变更须同步 schema、导入模板、UI 表单和 store 域白名单；env/DB 冲突必须显式呈现，禁止静默合并，详见 DEV-003。
- 文件操作不得静默失败或绕过 `apply_patch` best-effort rollback；仍须经过正常授权/审批 gate。
- **权限面先定能力原子**：可见性 / 投递受众 / 操作面在 `PermissionAtomCatalog` 能力层求值，**禁止** `isInstanceAdmin()` 之类角色名特判；新增面须同批定义默认授予集（`instance:admin` 属固定权限集，默认显式列入）与命中来源审计，名单结果落快照。细则见 workspace `.agents/skills/plan-mode` §权限面设计。
- 跨协议改动涉及 route、SSE/AgentEvent、durable record、OpenAPI、Flyway、env 或多个模块时，按 `../.agents/skills/xc-cross-cutting-checklist/SKILL.md` 先定契约、同批同步消费者并验证真实链路。

## Environment and Secrets

- Bootstrap/deployment env 与运行时业务配置是不同配置面；loader、优先级和覆盖透明度以 DEV-003 与各模块实现为准。
- `.env*` 入库文件只能放非敏感占位值；真实凭证用受保护的本机/部署注入，不写入 git、脚本或日志。模块间认证与密钥解析顺序见 DEV-024；MCP 逻辑入口无会话，见 DEV-016。
- Config import、dev admin password 和 host/Compose 导入差异见 DEV-002/003；不得因配置未导入而绕过认证或写入明文 secret。

## Testing

- 跨服务契约按受影响边界跑真实集成链路；全量验证只在里程碑或 PLAN 收尾执行。
- UI/浏览器消费者必须做真实 Playwright 验证。Sandbox/direct-attach/WorkspaceStorage 使用隔离 DB/root 的 host profile；每次结果都 teardown，不可达依赖必须失败而非静默通过。
- **默认排除的测试面要显式知道**（2026-11-06 审计）：docker 冻结 `@Tag("docker-frozen")` 6 条（`WorkspaceServiceCustomPathTest` 整类无报告）、LiveChain 两类、Agent `integration` marker（默认 30/1471 deselected）分别见 DEV-018「docker 后端冻结范围」、DEV-020、DEV-021；它们**默认不跑不等于已覆盖**。
- **e2e 夹具自测是门禁的一部分**：`mise run test:e2e:fixtures`（= `packages/ui` 的 `node --test "e2e/fixtures/__tests__/*.test.mjs"`）已并入 `mise run validate`，排在 UI 单测之后、E2E 之前。它只跑夹具自身的状态机（fake LLM `mode=chain` 的会话游标 / 重试重放 / 耗尽回落），不起栈、不开浏览器、秒级；**改 `packages/ui/e2e/fixtures/` 下的模式机必须先跑这条**——夹具坏了在真栈上的表现是"工具莫名不出现"，排障成本远高于这条门。
- Compose E2E 不证明 Runtime-created Sandbox 行为；Mock/Compose/Host E2E profile 串行运行，避免本机 Docker/浏览器资源 OOM。profile/命令见 DEV-020/021/022/023。
- Route/SSE/Flyway/tool-surface 变更须同批更新 OpenAPI/inventory 和受影响包文档，按 `xc-cross-cutting-checklist` 执行。

## Telemetry and Logging

禁止记录原始 token、凭证、私钥或不可信请求正文；保留脱敏和 secret 扫描门禁。日志与 request ID 规则见 [`DEV-004`](docs/i18n/zh-Hans/DEV-004-logging.md)。

## Runtime and MCP Boundaries

- E2E readiness、host/Compose profile、隔离数据根、teardown 和失败证据见 DEV-002/020/021；端口默认值的**事实源在本仓库** `scripts/lib/stack-ports.mjs`（PLAN-0612），one 侧 `config/ports.mjs` 为编排镜像，改一侧须同批改另一侧并由 `check:ports` 校验。
- Agent 仅经 CP logical MCP endpoint 访问工具；CP 管 OAuth 凭证/策略，Runtime host connector 校验出网 allowlist/私网。协议、retry 和 endpoint 见 DEV-014/016 与 OpenAPI/inventory。
- 用户直连 MCP mutation 与 Agent-mediated approval 是不同授权路径；变更前先在 DEV-014/016 核对 actor 和 gate owner。Fake OAuth/MCP 单独通过不等于真实链路完成。

## Known Issues

[`DEV-018`](docs/i18n/zh-Hans/DEV-018-known-issues.md) 是 XH 当前 Known Issues/技术债入口；其未关闭条目按具体模块 DEV/承接 PLAN 核对，不能仅根据此指南或旧 PLAN 快照推断当前状态。

- 用户反馈文本中的 Vue `t()` placeholder 不得包含 `{...}`；UI 测试和封装规则见 `packages/ui/AGENTS.md`。
- MCP 逻辑入口无协议会话：CP 不签发也不接受 `mcp-session-id`，入站一律 403 `MCP_SESSION_INVALID`（DEV-016/DEV-024）。
- Chat 若显式要求 workspace tools 才初始化 MCP；纯 Chat 不因携带 workspaceId 自动发现工具，MCP context 不得跨 Workspace 复用（DEV-013）。
- 工作区运行资源释放（PLAN-0391）的锁内 active-Job 门只覆盖 host/MXC（Job engine）；docker 模式（服务容器化冻结；**工作区 Docker 后端同样已冻结，见 [DEV-018](docs/i18n/zh-Hans/DEV-018-known-issues.md)「docker 后端冻结范围」**）下 Runtime 侧不感知容器 job，且 `cleanupFailed` 暂恒为 false。见 DEV-018。

## Plan and Release Rules

- 遵循 workspace `plan-mode`（收尾验收见其 `references/plan-completion/` 分册）；PLAN 工作包统一存放在 workspace 根 `plans/`，不在本仓库另设；XH Spec Impact 和 DEV/OpenAPI 同批同步按 `spec/README.md`、DEV-030 执行。PLAN 是目录工作包，不是单文件 `PLAN-XXX.md`。
- **XH PLAN 隔离实施复用固定 worktree 池**（`worktree-lifecycle` skill 为 SSOT；池表见项目私有层 `.local/xh-d28/worktree-pool.md`）：一个 lane 领一个**已存在**的槽位，`git switch develop && git merge develop && git switch -c task/<topic>` 开工，合并后回 `develop` 休息态。**禁止 `git worktree add` 新建**——H: 卷建树实测 470s 且会在 checkout 未完成时留下 0 MB 半成品目录（2026-11-05 实测一天新建 34 个 + 14 个空残留）；只有池内 6 个槽位全忙、且用户明确授权时才可新建，**新建必须同批登记进池表**。**禁止**用 Kilo / Agent Manager 的 worktree 模式代劳（两者是不同机制，2026-10-14 用户再次纠正；工作区硬规则见 `../AGENTS.md` §Git 操作约束）。
- 本指南不授权 package 发布、版本 bump、commit 或 push；任何 release 动作先核对当前项目依据并遵循 workspace permissions。
- **开发期数据无迁移包袱（D-215，2026-11-06 用户裁定）**：**XH 尚未上线**，本地/隔离栈的开发数据属可丢弃物 —— **旧数据不得成为开发与设计的阻碍**。schema 变更可以**直接清库重建**（`mise run dev:reset` 或删库重跑 Flyway），**不写回填脚本、不做双读/双写/灰度开关、不保留"新旧快照并存"的兼容分支**，也不把"存量行数对照"当验收判据。边界：①仅限**开发期数据**（lane/隔离栈/dev 栈）；②任何用户可见的发布产物、备份、`.local/evidence/` 证据、仓库历史不在此列；③清库前必须声明**目标栈与库身份**（避免误清他人 lane），不可逆动作执行前留一句"将清哪些库"的说明。

## Skills

项目特有 skill（按需 Read `.agents/skills/<name>/SKILL.md`）：

- `ai-chat-ui-design`：AI 聊天界面设计（MessageScroller 流式/自动滚动）
- `dev-host-verification`：host readiness / M1 / E2E profile 与可恢复清理
- `team-roles`：常驻团队角色化（DSH 专用；角色分层/命名=角色名/并行上限/测量值班/交接联动）

## Permissions

- **Allowed**：在已批准 PLAN 范围内修改本项目文档、源码和配置；本规则不豁免 workspace 授权与验证流程。
- **Require Approval**：架构级变更（新增模块/通信协议）、破坏式 API 变更、生产部署。

### 提交信息（2026-11-06 起，机读门禁）

- 首行 `<type>(<scope>): <摘要>`；`type` ∈ feat|fix|docs|test|chore|refactor|perf|build|ci|style|revert；`scope` 如 `cp`/`agent`/`ui`/`runtime`/`l2`/`docs`/`spec`。
- **摘要显示宽度 ≤72 列（CJK 记 2 列，约 ≤36 汉字）；merge 提交 ≤100 列**。超过就说明细节该进 body——实测历史中位 85 列、p90 114 列，正是"越写越长"的量化证据。
- 首行不带 emoji、不以句号结尾、不以「更新/修改/调整/优化/处理/完善/整理」开头（写清"改了什么"）。
- 空行后写 body；非 merge 提交必须在首行或 body 引用 `PLAN-####` / `BL-###` / `D-###`。body 建议 `Why:` / `What:` / `Verify:` / `Risk:` 四段，只写**为什么与怎么验**，不重复 diff 内容。
- **校验**：`mise run check:commit-msg`（**已阻断，且是 `mise run validate` 的依赖**；D-216）或 `node scripts/check-commit-msg.mjs --file .git/COMMIT_EDITMSG`（hook）/`--range a..b --enforce`（阻断）；`--stats` 出观察窗统计、`--json` 给 agent。历史提交豁免（默认 `--since 1dd57056`）。**观察窗已结**（自 `a632de77` 起 32 条、违规率 0% ⇒ 已翻 `--enforce` 并接入 validate，D-216）；历史提交豁免。
- 可选本地 hook（不改仓库）：`git config core.hooksPath scripts/hooks`（仓库内 `scripts/hooks/commit-msg` 已提供）。
**合并前必跑 UI 单测**：`cd packages/ui && pnpm exec vitest run`（全量 ~150s）。`mise run validate` 的 `test` 依赖 `test:ui`，但 `validate` 极少真跑 ⇒ 单测红点会被当"存量基线"长期放过（2026-11-06 实测 develop 上 14 红/5 文件，见 `BL-357`）。合并前至少跑一次全量，红点逐条归类（规格落后产品 / 测试基建 / 产品回归）后再合。
**合并分支前先校验分支自身**：`node scripts/check-commit-msg.mjs --range develop..<branch> --enforce`。门禁只校验 develop 上的历史，**分支里的超宽/缺引用的提交要到合并后才被发现**（2026-11-06 实际发生过一次，已按 `scripts/commit-msg-allowlist.json` 显式豁免并留痕）。白名单只接受"已进 develop、不可改写"的既成事实，每条必须带 reason，禁止批量塞历史提交。
## 测试与验证基座（2026-11-08 固化指针；正文以 SSOT 为准）

- **验证分级**：L0 受影响子集（默认）/ L1 波次（里程碑打点）/ L2 全量（仅三触发点：PLAN verify 判定、跨层契约合并前、归档/发布前）；host E2E 与浏览器全套恒归 L2。
- **候选与窗口**：`internal/A03-xihe/docs/l2-window-protocol.md` §19–§20（lane→候选树→develop 八步、I1–I5、窗口冻结 §20.6）。
- **测试超时**：`internal/A03-xihe/docs/test-timeout-budget.md`（action/expect 10 s、test 30 s、boot 120 s；>10 s 必须 `timeout-exempt`；预算门 `mise run lint:e2e`）。
- **测试成本/context 根因**：`internal/A03-xihe/docs/test-suite-cost.md` §1–§7；复用设计 `test-context-reuse-design.md`。
- **dev 热循环与 lane 同步**：`internal/A03-xihe/docs/dev-hot-loop.md` §1–§11（develop 前进后 merge→分类→hot/mvn/restart）。
- **团队角色/并行上限**：`internal/A03-xihe/docs/team-roster.md`（常驻 6、≤2 编译、测量值班 16:00–18:00）。
