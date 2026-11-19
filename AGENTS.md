# xihe — 通用 Agent 运行时平台

> 四模块 Hub-Module 架构：多 Agent 编排、工具调用、沙盒执行、权限控制。

## Scope

| 包 | 描述 | 语言 |
|----|------|------|
| `packages/ui/` | 前端界面 (Vue 3 + Vite) | TypeScript |
| `packages/control-plane/` | 路由 + 认证 + MCP 反向代理 | Java 25 / Spring Boot 4 |
| `packages/agent/` | LLM 编排 + 工具调用 + RAG | Python 3.14 / LangChain |
| `packages/runtime/` | 文件系统 + 沙盒 + 进程管理 | Rust 1.97.1 / rmcp 3.7.0 (edition 2024) |

## Tech Stack

各包技术栈与版本以 package manifest/toolchain 为准；全局架构和模块边界见 `DEV-001` 与对应模块 DEV 文档。

## Setup

- 工具链与依赖安装、前置条件 → **DEV-002 §2「环境与安装」**（`mise install` / `mise run setup`）。
- **长驻服务（cp/agent/runtime/ui/watch）只能走 `dev-stack.mjs` 受管起停**：`dev-stack start --stack <n>` 把 stdout/stderr 重定向进 `.xihe-stacks/<n>/logs/*.{out,err}.log` 并 detach 进程树，`status`/`stop` 才有据可依。直调 `node scripts/stack-run.mjs <target>` 只适合**终端前台**调试——它按设计不自己开日志文件，且进程随调用方退出被回收；被一次性调用方（后台 job／agent 工具调用／`| tee`）经管道捕获时会打 WARNING 点名正确命令，症状是「日志停在启动前 + pid 记录在而进程已死 + 租约仍 `started`」（task-64 / D-1715）。
- 日常起栈 `dev:host`、并行栈 `dev:stack --stack <n>`、`--stack` 两义陷阱，以及 `dev:host` 之后 `orphan` + `lease-pid-dead` 属正常（`dev-stack.mjs acquire --stack <n>` 认领即 `healthy`）→ **DEV-002 §3「模式 A：dev:host」** 与 **§4.10「`dev-stack` 状态与租约契约」**。
- **docker 冻结（产品面 / 测试面 / 默认值三面一起冻）**：工作区 docker 后端不可用，默认 `direct_attach`，`managed_import` ⇒ 409、既有 docker 工作区 ⇒ 503 且 fail-closed 不回退宿主；**禁止误启** `dev:full` / `dev:backend` / `test:e2e:compose` / `test:e2e` / `image:workspace:build` → **DEV-018「docker 后端冻结范围」**。
- Runtime target 缓存：`XH_CARGO_TARGET_ROOT` 定家族位置、worktree 保持独立 target、本机值在 gitignored `mise.local.toml` → **DEV-002 §6「Rust 构建缓存策略」**。
- 重置与清理：`dev:reset` 默认 dry-run；`reset-admin` 临时密码不得入库；**`mise run clean` 是永久删除入口（不进回收站）** → **DEV-002 §4「全栈调试」**。

## Commands

- 单文件/包级命令见对应包指南；里程碑与收尾跑 `mise run validate`，仅按改动边界增加集成/E2E profile（DEV-020/021/022/023）。**类型门**：`mise run check:types` 每个 verify 窗必跑——`validate` 的 `typecheck` 只覆盖 UI。**契约面必须过 `mise run check:openapi`**（BL-162）。`validate` 自 task-176 起是 **keep-going 聚合执行器**（`scripts/validate-run.mjs`）：门段并行恒跑完、逐门报退出，test 串行末段——任一門红 overall 非 0，但**不再首红 5 s abort 掐掉慢门**（旧 depends 并行首红中止曾令 test:ui/build/typecheck 零执行）；存量红门如实显示，逐红点做基线对照、归对应卡，不因存量红点阻塞收尾。UI 单测另有增量入口 `mise run test:ui:changed`（git diff 选相关 spec，收尾默认；report-only 不接 validate，全量留里程碑）。
- **两套 lint 口径不是一回事（BL-630）**：包级 `pnpm run lint`（cwd `packages/ui`）**只覆盖 UI 包**；仓根 `scripts/**` 归 `mise run lint:scripts`（`mise run lint` 聚合成员）⇒ **收尾跑 `mise run lint`**。`oxlint` 按 **cwd** 发现配置：在 `packages/ui` 里跑仓根脚本会报 `options.typeAware is only supported in the root config`，**别读成「没有门」**。
- **门的分档（哪条进 validate、哪条 report-only）**：`lint:cp` / `lint:agent` / `lint:scripts` / `lint:i18n` / `lint:e2e` / **`check:config-schema`**（schema 生成物漂移门，task-101）/ **`check:ui-copy` + `check:i18n-fixture-copies` + `check:dev-i18n-drift`**（task-172 文案判据快档，report-only，实测增量 ≈6 s）属 `mise run lint`；`i18n-scan` 通过零输出、有问题 exit 1 逐条点名（第 ③ 类带 `file:line`）、脚本自身坏 exit 2。E2E 静态卫生双门（超时预算 + 块注释提前闭合，后者事故见 task-66）见 DEV-002。**`check:openapi:lint` 属 validate 门段**（`scripts/validate-run.mjs` 的 `GATES`，errors-only，基线 0；task-60 2026-11-19 清账）—— **不是** report-only，它 exit 1 时 `mise run validate` 恒红。**report-only（默认恒 exit 0，显式 `--enforce` 才阻断）**：`check:e2e-bypass`、`check:dev-i18n-drift`、`check:ui-copy`、`check:i18n-fixture-copies`（后两者 + drift 的 `:enforce` 兄弟不接聚合，连续两窗 findings=0 再议转阻断，task-172）；其盲区由脚本自己在输出里打印。`test:cp:baseline` / `test:runtime:lib:gate` / `ignored` 三档**不接 validate**。
- 台账只读校验：ONE 根 `mise run ledger:validate`（只读、报告不阻断）。迁移测试覆盖门：`mise run test:cp:migration`（漏映射先 exit 1 点名文件）。CP 已知基线门：先 `test:cp` 再独立 `test:cp:baseline` —— 基线**只许缩小**、条目转绿必须删、`reviewBy` 过期即失败、**报告早于 HEAD ⇒ exit 2 要求重跑**（否则拿旧树失败判新树）。
- 栈运维判据：`dev:host:status` 的 `verdict` 非 `fresh` ⇒ `stack-run.mjs cp` 在 mvn 前默认 `clean compile` 重建（`--no-rebuild` 显式跳过并 WARN）；外部复用栈跑 E2E 时 runner 断言 CP build commit == `XIHE_E2E_EXPECT_CP_COMMIT`。`lease-cold` 只表示 10 分钟没人做过 status 交叉核对，**不进 mismatch/reasons/verdict/退出码**（`ghost` + exit 1 是迁移态不是故障）。CP 构建目录按栈隔离，保留只走 `dev:host:cp-build:clean`（默认 dry-run），回滚通道 `XIHE_CP_TARGET_DIR`。字段表与释义见 DEV-002 §4/§6。
- 其它入口：打包 `mise run pkg:launcher -- start|status|stop` / `pkg:installer`（产物只写 `.tmp/pkg/`，不入库）；`gate:agent-quality`（0/1/2/3 = PASS/FAIL/NOT_EVALUATED/GATE_ERROR，未接 CI）；Compose E2E 已冻结 ⇒ host E2E 用 `test:e2e:host`；根 README 与中文文档页独立维护（`sync-readmes.sh` 只管包 README symlink）；**dev 热循环已 deprecated（D-818 ①）**，读前先看其 §0 判定表。

## Architecture

四模块 Hub-Module。全局架构见 [`DEV-001`](docs/i18n/zh-Hans/DEV-001-system-architecture.md)；模块实现见 [`DEV-013`](docs/i18n/zh-Hans/DEV-013-agent-architecture.md) / [`DEV-014`](docs/i18n/zh-Hans/DEV-014-control-plane-architecture.md) / [`DEV-015`](docs/i18n/zh-Hans/DEV-015-runtime-architecture.md) / [`DEV-016`](docs/i18n/zh-Hans/DEV-016-mcp-architecture.md)；API wire 以 `docs/api/openapi.yaml` / `inventory.md` 为准。SPEC 是目标契约入口，`proposed` 不代表已经实现。

- 配置边界见 [`DEV-003`](docs/i18n/zh-Hans/DEV-003-config-management.md)：bootstrap/deployment env 与 ConfigService 业务配置不是同一层；凭证只走受控加密通道，secret 不得写入仓库或日志；env/DB 冲突必须显式呈现。
- 沙盒后端与生命周期契约见 [`DEV-031`](docs/i18n/zh-Hans/DEV-031-sandbox-backend-contract.md)：未知 Workspace、后端不可用或超时必须显式失败，MXC/Docker 故障不得自动回退到宿主执行；`windows-host/unrestricted` 只能由用户显式选择；Runtime 实现字段（pid/wrapperPid/policyPath/mxcTier）不得透传到 API，CP/API view 必须显式过滤（DEV-031 §5）。
- Workspace/Session、ChatRun、Workspace Job 与 MCP invocation 不变量见 [`DEV-017`](docs/i18n/zh-Hans/DEV-017-session-architecture.md)、DEV-014 和对应 SPEC；模块间变更必须按下方跨协议门禁同步。

## SPEC Contract Layer

- `spec/README.md` 是项目契约入口，`proposed` 不得当运行事实；Security 是认证/主体/角色/scope/授权正文的唯一 owner；一个根 SPEC 同时只由一个 active PLAN 承接，XH PLAN 声明 Spec Impact 并同批同步 DEV/OpenAPI/测试（细则 `spec/README.md`、`writing-guide.md`、DEV-030）。
- **API 契约治理（D-800）**：`docs/api/openapi.yaml` 是人工维护的唯一 SSOT，改接口顺序固定（yaml → 代码 → 门）；**四道门各管一轴、禁止混用**，`RouteContractParityTest` 两侧 `unexpected` 必须为 0 ⇒ 四门清单 / springdoc 对账 / 分组快照 / `proposed` 口径全在 **DEV-034 §8–§9**（双语）。
- **配置域与 env**：`{domain}` 权威是 `ConfigService.DOMAINS`（14 域，schema 文件集合不是权威）⇒ **DEV-014「配置域权威与新增域流程」**（单语）；`XIHE_*` 登记 ⇒ `xc-cross-cutting-checklist` §env 变量登记。

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
- **`XIHE_SEED_ADMIN`（登记，task-60 2026-11-19）**：是否在首跑建 `admin@xihe.local`。产品默认 **false**（`application.properties` 的 `${XIHE_SEED_ADMIN:false}`，全新安装走 `/onboarding`，task-172 / `D-1532` ④）；host/e2e 车道由 `scripts/dev-stack.mjs` 与 `scripts/stack-run.mjs` 显式置 `true`（`application-e2e.properties` 的 `cp.bootstrap.seed-admin=${XIHE_SEED_ADMIN:true}`），运维自己导出的值优先。**不登记会让 `check:mise-env` 恒红 ⇒ `mise run validate` 恒红**（本行就是那次清账）。
- Config import、dev admin password 和 host/Compose 导入差异见 DEV-002/003；不得因配置未导入而绕过认证或写入明文 secret。

## Testing

- 跨服务契约按受影响边界跑真实集成链路；全量验证只在里程碑或 PLAN 收尾执行。
- UI/浏览器消费者必须做真实 Playwright 验证；Sandbox/direct-attach/WorkspaceStorage 用隔离 DB/root 的 host profile，每次 teardown，不可达依赖必须失败而非静默通过。
- **默认不跑 ≠ 已覆盖**：docker 冻结 `@Tag("docker-frozen")` 6 条、LiveChain 两类、Agent `integration` marker 默认排除；计数以 **DEV-018** / **DEV-020** / **DEV-021** 为准。
- **改 `packages/ui/e2e/fixtures/` 模式机必先跑 `mise run test:e2e:fixtures`**（并入 `validate`，UI 单测后、E2E 前；不起栈、秒级）—— 夹具坏了在真栈上表现为「工具莫名不出现」（DEV-020 §3.7）。
- Compose E2E 不证明 Runtime-created Sandbox 行为；Mock/Compose/Host profile 串行防 OOM（DEV-020/021/022/023）。
- Route/SSE/Flyway/tool-surface 变更须同批更新 OpenAPI/inventory 与受影响包文档（`xc-cross-cutting-checklist`）。

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

- 遵循 workspace `plan-mode`（收尾验收见其 `references/plan-completion/`）；PLAN 工作包统一放在 workspace 根 `plans/`，本仓不另设；XH Spec Impact 与 DEV/OpenAPI 同批同步按 `spec/README.md`、DEV-030 执行。PLAN 是目录工作包，不是单文件 `PLAN-XXX.md`。
- **XH PLAN 隔离实施复用固定 worktree 池**（`worktree-lifecycle` skill 为唯一 SSOT：池槽判定与槽表均以 `.agents/skills/worktree-lifecycle` 为准；**本仓当前未维护本地池表**，需要时按该 skill 建立并登记）：一个 lane 领一个**已存在**的槽位，开工/休息态与「常驻模块分支槽 vs 任务槽」的判定顺序**以该 skill 为准，本行不复述**。**禁止 `git worktree add` 新建**（仅池内全忙 + 用户明确授权时可建，且**必须同批登记池表**；本机实测 470 s 与空残留事故见 `DEV-002` §8.2）；**禁止**用 Kilo / Agent Manager 的 worktree 模式代劳（工作区硬规则见 `../AGENTS.md` §Git 操作约束）。
- 本指南不授权 package 发布、版本 bump、commit 或 push；任何 release 动作先核对当前项目依据并遵循 workspace permissions。
- **开发期数据无迁移包袱（D-215）**：XH 尚未上线，本地/隔离栈的开发数据属可丢弃物 ⇒ schema 变更可**直接清库重建**，**不写回填脚本、不做双读/双写/灰度开关、不保留「新旧快照并存」兼容分支**，也不把「存量行数对照」当验收判据；三条边界与清库前声明要求见 `DEV-002` §8.3。

## Skills

项目特有 skill（按需 Read `.agents/skills/<name>/SKILL.md`）：

- `ai-chat-ui-design`：AI 聊天界面设计（MessageScroller 流式/自动滚动）
- `dev-host-verification`：host readiness / M1 / E2E profile 与可恢复清理
- `team-roles`：常驻团队角色化（DSH 专用；角色分层/命名=角色名/并行上限/测量值班/交接联动）
- `xh-settings-ui-design`：设置区 UI 判据（层×域两层模型 / 内容列 1152px / 计数与徽标量纲 / 字段级编辑闭环 / vendor 优先；写改设置区页或 settings mock 前读）

## Permissions

- **Allowed**：在已批准 PLAN 范围内修改本项目文档、源码和配置；本规则不豁免 workspace 授权与验证流程。
- **Require Approval**：架构级变更（新增模块/通信协议）、破坏式 API 变更、生产部署。

### 提交信息（机读门禁；细则见 `DEV-002` §8.1 与 `scripts/check-commit-msg.mjs`）

- 首行 `<type>(<scope>): <摘要>`；`type` ∈ feat|fix|docs|test|chore|refactor|perf|build|ci|style|revert，`scope` 如 `cp`/`agent`/`ui`/`runtime`/`l2`/`docs`/`spec`；非 merge 必须在首行或 body 引用 `PLAN-####` / `BL-###` / `D-###`。
- **摘要显示宽度 ≤72 列（CJK 记 2 列，约 ≤36 汉字），merge ≤100 列**；首行不带 emoji、不以句号结尾、不以「更新/修改/调整/优化/处理/完善/整理」开头。超过就说明细节该进 body。
- 校验：`mise run check:commit-msg`（**已阻断**，`mise run validate` 的依赖，D-216）或 `node scripts/check-commit-msg.mjs --file .git/COMMIT_EDITMSG`（hook）/ `--range a..b --enforce`（阻断）；可选 hook：`git config core.hooksPath scripts/hooks`。
- **合并前必跑 UI 单测**：`cd packages/ui && pnpm exec vitest run`（全量实测 **604.64 s** / 379 文件 / 3636 例，2026-11-17；旧口径 "~150 s" 已失真）。`validate` 的 `test` 依赖 `test:ui`，但 `validate` 极少真跑 ⇒ 红点会被当存量基线长期放过（2026-11-06 实测 develop 上 14 红/5 文件，`BL-357`；2026-11-17 实测 13 红/4 文件裸奔 ≥半天，task-172）。文案判据不必等全量：`mise run lint` 已含 `check:ui-copy` 快档（report-only）。
- **合并分支前先校验分支自身**：`node scripts/check-commit-msg.mjs --range develop..<branch> --enforce`（门禁只看 develop 历史，分支内的超宽/缺引用要到合并后才暴露；白名单规则见 `DEV-002` §8.1）。

## 测试与验证基座（指针；正文以 SSOT 为准，路径相对 `internal/A03-xihe/docs/`）

- **验证分级**：L0 受影响子集（默认）/ L1 波次（里程碑）/ L2 全量（三触发点：卡面验收、跨层契约合并前、归档/发布前）；host E2E 与浏览器全套恒归 L2。
- **候选与窗口**：`l2-window-protocol.md` §19–§20（八步、I1–I5、窗口冻结 §20.6）。
- **测试超时**：`test-timeout-budget.md`（10/30/120 s；>10 s 须 `timeout-exempt`；`mise run lint:e2e`）。
- **测试成本根因**：`test-suite-cost.md` §1–§7；复用设计 `test-context-reuse-design.md`。
- **dev 热循环/lane 同步**：`dev-hot-loop.md`（§11 有效；§1–§10 按 D-818 ① 废弃，看 §0 判定表）。
- **团队角色/并行度**：`team-roster.md`（工位表：4 条常驻模块分支 `ui-1`/`cp-1`/`agent-1`/`runtime-1` + `infra-N` + `verify` + `research-N` + `lead`；不设编译位上限 D-936；测量值班 16:00–18:00 独占）。