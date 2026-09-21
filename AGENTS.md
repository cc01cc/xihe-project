# xihe — 通用 Agent 运行时平台

> 四模块 Hub-Module 架构：多 Agent 编排、工具调用、沙盒执行、权限控制。

## Scope

| 包 | 描述 | 语言 |
|----|------|------|
| `packages/ui/` | 前端界面 (Vue 3 + Vite) | TypeScript |
| `packages/control-plane/` | 路由 + 认证 + MCP 反向代理 | Java 25 / Spring Boot 4 |
| `packages/agent/` | LLM 编排 + 工具调用 + RAG | Python 3.12 / LangChain |
| `packages/runtime/` | 文件系统 + 沙盒 + 进程管理 | Rust 1.97.1 / rmcp 3.1.4 (edition 2024) |

## Tech Stack

| 层 | 技术 | 版本 |
|----|------|------|
| UI 框架 | Vue 3 + Pinia + vue-router | ^3.5.41 / ^4.0.3 / ^5.2.0 |
| UI 构建 | Vite + Tailwind CSS 4 + shadcn-vue | ^8.2.2 / ^4.3.3 / ^2.8.2 |
| CP 框架 | Spring Boot 4 + Spring Security + Spring Data JPA | 4.0.6 |
| Agent 框架 | FastAPI + LangChain + LangGraph + litellm | — |
| Runtime 框架 | rmcp + Axum + Tokio + bollard | 3.1.4 / 0.8.9 / 1.53.1 / 0.21.1 |
| Runtime binary | `xihe-runtime`（Gateway）、`xihe-container-runtime`（容器内文件服务，oneshot CLI） | 统一 `xihe-` 前缀；`xihe-mcp-bridge` 已随 PLAN-0347 退役 |
| 数据库 | PostgreSQL 17 + pgvector | — |
| 工具链 | Node 24 / pnpm 10 / Maven 3.9 / uv / task 3 / Docker | — |

## Setup

```bash
# 1. Install dependencies (all modules)
mise run setup

# 2. Start all modules for daily host development
#    Host-only Postgres rule: daily host development only runs PostgreSQL in Docker;
#    CP / Agent / Runtime / UI run as native mise tasks.
#    dev:host 先启动并等待 Postgres，再并行启动原生服务。
mise run dev:host

# 3. (Only for one-off full-stack container scenarios)
#    dev:full 会自动等待 CP ready 后导入 config.import.local.jsonc（如存在）
mise run dev:full

# 3. Run validation (Docker auto-managed)
mise run validate
```

## Commands

| 命令 | 说明 | 备注 |
|------|------|------|
| `mise run setup` | 安装所有模块依赖 | — |
| `mise run dev` | 启动 UI dev server（需后端已运行） | 等价于 `mise run dev:ui` |
| `mise run dev:host` | 日常 host 开发主入口：PostgreSQL Docker + CP/Agent/Runtime/UI 原生并行启动 | 推荐用于日常开发；CP ready 后自动导入 `config.import.local.jsonc`（需 `XIHE_DEV_ADMIN_PASSWORD`，否则跳过） |
| `mise run dev:full` | 一次性全容器场景（Docker + UI on host） | 自动导入 `config.import.local.jsonc`，不用于日常 host 开发 |
| `mise run dev:host:import-config` | 单独执行自动导入（等 CP ready → admin 登录 → POST import） | 需 `XIHE_DEV_ADMIN_PASSWORD`；文件缺失或未设密码时跳过并提示 |
| `mise run dev:backend` | 启动 Docker 后端服务（无 UI） | — |
| `mise run dev:ui` | 启动 UI dev server | — |
| `mise run dev:agent` | 启动 Agent 服务 | — |
| `mise run dev:cp` | 启动 Control Plane | — |
| `mise run dev:runtime` | 启动 Runtime 服务 | — |
| `mise run dev:host` | PostgreSQL Docker + CP/Agent/Runtime/UI 原生并行启动 | Ctrl+C 由 mise 清理原生任务 |
| `mise run dev:host:watch` | 启动 host 栈并监控健康端点，故障后重启任务组 | Node watcher；不启动 CP/Agent/Runtime 容器 |
| `mise run dev:host:stop` | 停止 host 栈 PostgreSQL | 日常场景先 Ctrl+C 停止原生任务，再执行本命令 |
| `mise run dev:reset` | 默认 dry-run；显式 `-Reset` 后备份并重建本地 dev 数据、清理 host workspace/Sandbox | 仅 dev；不连接生产，不删除 Runtime device identity |
| `mise run reset-admin` | 重置 dev `admin@xihe.local` 密码 | 缺省随机生成 24 字节 base64url 并打印；`pwsh scripts/reset-admin.ps1 -Password <pw>` 指定密码；免重启，账号不存在时以 ADMIN 创建，绝不删数据 |
| `mise run build` | 构建 UI + Runtime | — |
| `mise run build:ui` | 构建 UI bundle | — |
| `mise run build:runtime` | 构建 Runtime binaries | — |
| `mise run test` | 运行所有测试 | UI + Agent + CP + Runtime(lib) |
| `mise run test:ui` | UI 单元测试 | — |
| `mise run test:agent` | Agent 测试 | — |
| `mise run test:cp` | CP 测试 (Maven) | — |
| `mise run test:runtime` | Runtime 全部测试 | 部分需 Docker |
| `mise run test:runtime:lib` | Runtime 单元测试 | 无需 Docker |
| `mise run test:integration` | 后端集成测试 T2 + T3 | T3 需 Docker |
| `mise run test:integration:t2` | T2 stub 集成测试 | 无需 Docker |
| `mise run test:integration:t3` | T3 real 集成测试 | 需 Docker |
| `mise run test:e2e` | Compose-compatible Playwright E2E | 自动管理 frozen Docker Compose，排除 `@host` 用例 |
| `mise run test:e2e:host` | Host-only Playwright E2E | 需先运行 `mise run dev:host`，执行 `@host` 用例 |
| `mise run lint` | 运行所有 linter | — |
| `mise run lint:ui` | UI lint (oxlint) | — |
| `mise run lint:agent` | Agent lint (ruff + mypy) | — |
| `mise run lint:cp` | CP lint (Checkstyle) | — |
| `mise run lint:runtime` | Runtime lint (rustfmt check + clippy --all-targets) | — |
| `mise run lint:links` | 文档链接检查 | — |
| `mise run typecheck` | 运行类型检查 | 当前仅 UI |
| `mise run format` | 格式化代码 | UI + Agent + Runtime |
| `mise run validate` | 全量验证 — lint + typecheck + build + test | Docker 自动管理 |
| `mise run validate:full` | 完整验证 + 集成 + E2E | 需 Docker |
| `mise run clean` | 清理日志与构建产物 | 核选项，删全部 target |
| `mise run clean:runtime-sweep` | 清理 Rust 孤儿产物（7 天+/12GB 上限，保留活指纹） | 双周日常，策略见 DEV-002 §6 |
| `mise run image:workspace:build` | 构建 workspace 容器镜像 | — |

### 文件级命令

```bash
# UI
cd packages/ui && pnpm run lint && pnpm run typecheck && pnpm run test:unit
cd packages/ui && npx playwright test e2e/mock/    # Mock E2E
mise run test:e2e                                   # Compose-compatible Real E2E
# terminal 1: mise run dev:host
# terminal 2: mise run test:e2e:host                 # Host-only Sandbox/WorkspaceStorage E2E
cd packages/agent && uv run pytest tests/file_test.py     # Agent 单文件
cd packages/control-plane && mvn test -Dtest=TestClass    # CP 单类
cd packages/runtime && cargo test --lib -- test_name      # Runtime 单测
```

## Project Structure

```
packages/
├── ui/src/                   # Vue 3 + Vite 前端
├── control-plane/src/        # Spring Boot 4 (路由 + 认证 + MCP 代理)
├── agent/src/xihe_agent/     # Python Agent 服务
└── runtime/src/              # Rust 沙盒 (文件系统 + shell + 进程管理)
```

详见 `docs/i18n/zh-Hans/DEV-001-system-architecture.md`。

## Quality Gates

| 模块 | 覆盖维度 |
|------|---------|
| **UI** (TS) | lint + typecheck + build + test |
| **CP** (Java) | lint + test（build + typecheck 隐式） |
| **Agent** (Python) | lint + test（mypy 在 lint 内） |
| **Runtime** (Rust) | lint + test（build + typecheck 隐式） |

> `mise run validate` 自动管理 Docker，执行全部上述命令。

## Architecture

四模块 Hub-Module。设计细节见 `docs/i18n/zh-Hans/DEV-001-system-architecture.md` 及分模块文档（配置 DEV-003、Agent DEV-013、CP DEV-014、Runtime DEV-015、MCP DEV-016、Session DEV-017）。以下只留硬约束与关键边界：

- **配置（ConfigService）**：三层作用域 `instance / workspace / user`（域集合 `instance ⊇ user ⊇ workspace`），解析链 `workspace > user > instance > 代码默认`，env 为部署权威（命中即锁定并显式暴露）。凭证 BYOK 两级 `WORKSPACE > USER`（`provider_connections` 加密表；`SYSTEM` 归属已退役，见 PLAN-0364 M2）；config 层任何 `*ApiKey` 写入一律 `rejectProviderSecrets` 403。`mcp` 域拆 `mcp_stdio_servers` / `mcp_remote_servers` 两载体；`infrastructure` / `workspace-config` 域已撤。`pricing` 域（PLAN-0343）为 instance-only 计价权威（per-MTok；user/workspace 层写入即 400）。
- **Provider 共享**：Agent 不逐层拼装实例密钥；CP `GET /internal/v1/config/effective/{domain}` 提供单份 effective（含 env 覆盖），user/workspace 覆盖随 run payload push；凭证由 `provider_connections` 租约下发，env 兜底仅限离线/无租约路径。
- **Agent 接口抽象**：`AgentRunner`（`LangGraphRunner` 实现）、`BaseAgentTool`/`ToolSpec`、`EventAdapter`（→ SSE `AgentEvent`）、`LLMProvider`、`EventStore`/`AgentContext`；LangChain/LangGraph 实现必须隔离在接口之后。
- **Runtime / Sandbox 边界**：控制面（CP：workspace 元数据/授权/健康/降级）与执行面（Runtime：文件/命令/容器/进程/stdio MCP 会话）分离，进程保活由外部 orchestrator（Docker/mise watcher）负责。`/health` 仅进程存活、`/ready` 不等待全部 Sandbox 物化，Workspace 按 `workspaceId` 懒加载。单 Runtime/单设备 v1 不以 registration/heartbeat/generation/warm pool/microVM/多设备接管为前置条件。未知 workspace、后端不可用、执行超时必须显式失败，禁止默认目录或静默降级掩盖状态丢失。远程 MCP 仅经 CP logical endpoint，禁止跨 workspace 复用已发现工具。CP→Runtime 调用恒有界（connect 2s / read 10s，超时走既有显式降级）；MXC/Docker 失败不得自动裸执行，`windows-host/unrestricted` 只能由用户显式选择。工作区删除以 DB 逻辑删除为权威，Runtime 执行实体清理在事务提交后 best-effort（失败记 `RUNTIME_CLEANUP_FAILED`，孤儿实体由启动期清理兜底）。**执行后端须可替换**：执行层抽象建在能力（execute/session/fs/lifecycle）而非 Docker 传输，禁止把 `docker exec`/容器 IP/端口发布/`network_mode`/容器内 pid 文件/沙盒内 HTTP 服务泄漏到执行层之上（设计原则见 `sandbox-backend-abstraction` skill；**契约与能力声明见 DEV-031**，泄漏审计记录见 PLAN-0329）。**PLAN-0347 已落地首版接缝**：`backend.rs` 的 `SandboxBackend`（当前 Docker 实现，后续由 PLAN-0379 扩展 Windows MXC/宿主执行；能力声明 + fail-closed）与生命周期唯一写入口；stdio MCP 会话见 `mcp_session.rs`（会话按 `(workspace, serverId)` 共享，执行层之上零 Docker 概念）。
- **生命周期（PLAN-0345 已落地）**：六态权威状态机（`creating/ready/paused/stopped/failed/destroying`）经 `runtime/src/lifecycle.rs` `Lifecycle` 单一写路径；Registry 为可重建缓存；paused→unpause 激活（禁 force recreate）；destroying 窗口迟到 materialize → 409 `WORKSPACE_DESTROYING`（CP 透传）。新增生命周期代码必须走 `Lifecycle`，禁止直接写 `WorkspaceRegistry` 状态。隔离引擎升级仍属后续。详见 DEV-015。

## SPEC Contract Layer

- 根级 `spec/README.md` 是 XH 项目级 SPEC 入口；任务涉及架构、UI 交互、Agent、Session、认证/授权、Workspace、配置、协议或数据边界时，先读取入口，再按任务加载相关规范。
- `AGENTS.md` 负责 Agent 的工作规则；根级 SPEC 负责 XH 领域契约。`active` 表示已接受的目标契约，不等于实现已经完整；入口同时记录实现状态、owner、消费者和承接 PLAN。`proposed` 不得被当作当前运行事实。
- Security 拥有 authentication、principal、role/scope 和 authorization 的 canonical 正文；Agent 文档只描述 Agent-specific binding、传播和消费。能力策略、审批和审计分别建模。
- 一个根级 SPEC 文件同一时间只能由一个 active PLAN 承接；其他 PLAN 只能在自己的 `spec/` 中提出草案。Agent 可以提出写回建议，但不得自动改写 active SPEC。
- 每个 XH PLAN 必须声明 Spec Impact：`none`、`read`、`create`、`update` 或 `supersede`，并在同一变更波次同步根级 SPEC、DEV 摘要、OpenAPI/事件 schema 和测试。XH 试点规则暂不改变 workspace 全局 PLAN 模板。
- 根级 SPEC v1 仅作为 Agent/GitHub-only 契约入口，不纳入文档站 frontmatter 或渲染；DEV-030 和文档索引只提供导航。具体写作规则见 `spec/writing-guide.md`。
- Workspace/Configuration proposed SPEC 见 `spec/workspace/`、`spec/configuration/`；它们只冻结 owner、状态、能力、storage/checkpoint/import/events 和进程可见性，不替代 DEV-003/015/031、OpenAPI、代码或 PLAN-0379/0384 的实现边界。

## Code Style

- **Naming**: `camelCase` (TS/JS/Java), `snake_case` (Python/Rust)
- **Agent 术语**: 代码包用 Agent 模块 (module)，运行进程用 Agent 服务 (server)，运行时单元用 Agent Worker (Worker)
- **文档术语**: 一词多义与多词一义按 `docs/i18n/zh-Hans/DEV-032-terminology.md`（execution lease holder ≠ 角色 owner；ensure ≠ 裸 materialize 叙述；unpause ≠ run resume；context/diagnostic/checkpoint 的 L1 必须带域前缀）
- **异常日志**: 每个 catch 必须有日志 + stacktrace，禁止 silent catch
- **UI**: reka-ui + Tailwind v4；聊天组件使用自研 MessageScroller / Message / Bubble / Attachment / Marker 五个组件族；Toast 为唯一反馈渠道
  - reka-ui 封装契约：`ComboboxContent position=popper` 必须显式 `ComboboxAnchor` 包裹触发器（否则定位到视口外且零报错）；`CollapsibleTrigger` 自带切换，不得再绑 click（双重翻转 = 永不折叠）；`AlertDialogAction` 点击无条件关闭——需校验失败保持打开时用普通 destructive `Button`；reka-ui MenuItem 程序化选择在 jsdom 不可行，交互层由 Playwright 覆盖
  - workspace 管理：`POST /api/v1/workspaces` 接受 profile（strict/coding/isolated）+ image（v1 白名单仅 `xihe/workspace:latest`）；`materialize` 异步触发（202）+ 轮询 environment；创建入口 = 无 workspace 空态；托管副本物理目录由 `hostRoot/workspaceId` 派生，direct-attach 使用经 Runtime 校验的显式 `host_directory` binding；执行模式不改变 Workspace 逻辑身份
- **Chat 架构**: Workspace 是独立资源，Session 可选绑定 Workspace；同一工作界面可同时呈现 Chat 与 Workspace，但 Workspace 不依赖 Session。共享的 Session/fileContext 只在 Session 存在时生效；附件仍持久化到后端 Session 专属空间（详见 DEV-001 §7、DEV-017）
  - 会话级持久 SSE：`GET /api/v1/events?sessionId=` 单会话单活连接（`SseEmitterManager` generation），`done` 只结束 run 不关 SSE，`heartbeat` 15s 不进气泡；`POST /api/v1/chat` 需已订阅（`409 SSE_SUBSCRIPTION_REQUIRED`）且单并发（`409 CHAT_IN_PROGRESS`），`requestId`/`runId` 经 `X-Request-Id`/`X-Chat-Run-Id` 透传
  - Workspace 级实时事件订阅（PLAN-0350/BL-43 首批）按 `workspaceId` 独立 SSE；事件只携带相对路径/序号提示，文件正文与目录树仍经 Workspace HTTP/MCP 读取；不得把无 Session Workspace 的文件事件塞进 Chat SSE
  - 流式渲染：`useStreamParser` 将 token 分类为 `MessagePart[]`（text/reasoning/citation/artifact），每 token 整量替换流式 parts；`Message.parts` 替代旧 `marked`。真实流式：`XiheLiteLLM._astream()` 显式 `streaming=True` 产生多 token `on_chat_model_stream`，`sse_adapter` 按 `run_id` 去重，`on_chat_model_end` 仅作无流 fallback
  - ChatRun：按 `(userId, sessionId, Idempotency-Key)` 持久化 run；`Message.runId` 关联 success/error/partial/ambiguous 终态，同 key 不重复启动，ambiguous 只能新 key 手动重试
  - 上下文管道（PLAN-0340/0341）：LLM 输入 = CP 投影 keep-recent + SUM 槽（`epoch.system_messages`，摘要不双写 messages）+ L1；`CONTEXT_OVERFLOW` 经 relay 白名单 → force-compact → 预检 → 复用 runId 重跑一次（二次超窗显式报错）；prune 墓碑 + 摘要 carry-forward/熔断；手动压缩 `POST /api/v1/sessions/{id}/compact`（活跃 run 409；openapi 已登记）。U3/U4 toast 已接；M2 待 V9 浏览器验收。**LLM 摘要（0354）默认关**：0355 质量门 2026-09-19 裁定 reject → `summaryProvider` 默认 `rule`（显式 `llm` 仍可开 + 失败自动回退）；重开先决 = 修复 F1（`shrink_failed` 截断丢 `[Constraints]`）+ p95 ≤10s 端点复测（0355 `gate-decision.md`）。见 DEV-018 / PLAN-0341 / PLAN-0355
  - 诊断回灌（PLAN-0342）：失败命令结果按 L0 规则（`path:line[:col]: message`，path-like 锚定）提取，未命中保留原文（L2）；会话级账本连续重复抑制 + 预算（Top-N 20 / 单条 1k / 命令结果中段 48k 头尾保留）后，经不可信信封内 `<diagnostics>` 文本块（模型可见）、`ToolMessage.artifact`（结构化，不进模型 wire）、durable `tool.result` payload、SSE `tool_result.data.diagnostics` 四通道回灌；`ToolCallCard` 有诊断时整卡自动展开（前 3 条 +「另有 N 条」），原文回退默认折叠。见 DEV-013 §3.5
  - provider/model binding：全链路传 `provider` + `model` + `toolMode`；`modelProvider + modelName` 为 session canonical pair，普通 Chat 固定 `toolMode=none`，Workspace/tool 操作显式用 `workspace`
  - Operation Ledger（PLAN-0326 v3 通道事实模型）：新 Chat 持久化 ChatRun/Message 后创建 durable root `operationId` 并透传 Agent；**账本单位 = 通道事实**——中继按事件阶段经 `LedgerToolRecorder` 记 Agent 侧事实（`source=agent`），网关自建派发事实行（`source=mcp`），行身份 `(operation_id, source, tool_call_id)`（V14），`toolCallId` 为跨通道关联键、启发式匹配禁止；Runtime executor、Workspace lifecycle、Job/Snapshot 按各自里程碑接入，不得以局部 trace 充当全链路完成。**写路径有界等待（PLAN-0346）**：账本/context 写事务由 `DbLockTimeout` 下发事务级 `SET LOCAL lock_timeout`（`cp.lock-timeout-ms` / `XIHE_CP_LOCK_TIMEOUT_MS`，默认 5s；H2 测试跳过），超时统一 **503 `OPERATION_LOCK_TIMEOUT`**（可安全重试；日志 `event=operation_lock_timeout`），禁止把锁等待留成无限阻塞
- **配置**: 三层 `instance / user / workspace`（解析链 `workspace > user > instance`，env 覆盖锁定显式化），CP ConfigService 统一管理
- **配置 key 三方同步（硬约束）**: 新增/修改 config domain key 必须同步三处——（a）CP `config-schemas/*.json`（JSON Schema，同时约束 import 与 UI Settings 保存）、（b）`config.import.example.jsonc` 模板、（c）UI `/settings/config` 表单；任一漏改会导致 import 与保存**同时 400**（2026-09-09 logging/user-preference 双 400 实证）。
- **配置解析透明性（硬约束）**: env 与 DB 用户配置冲突时**必须显式暴露**——UI 显示被覆盖的 env 值并冻结/禁用该项、Agent 侧可见、日志记录冲突与最终生效来源；**禁止在底层静默合并/自动计算**（2026-09-11 用户明确「最核心是透明度」）。
- **Service 纯函数**: Service 不依赖 ConfigClient，配置由调用方解析后传入
- **提交**: Conventional Commits，pass `mise run validate` 后可提交
- **跨协议/跨服务变更走 XH 跨包 checklist（2026-09 会话回溯沉淀）**：任何同时涉及 UI/CP/Agent 三层，或新增/修改 SSE 事件、public/internal route、AgentEvent、CP durable record、UI store 类型、OpenAPI、Flyway、env 的改动，必须先按 `one/.agents/skills/xc-cross-cutting-checklist/SKILL.md` 跑契约定稿 → UI/CP/Agent/Runtime 四层落地 → 契约/测试/证据 → 提交与收尾，禁止以 mock 绿代替真实链路，禁止路由/字段跨层漂移；项目级 `AGENTS.md` / DEV-001 / DEV-013 / DEV-014 文档同步按根 AGENTS 状态回写规则执行。

## Env Files

两层配置模型：

| 层 | 用途 | 文件 | 可运行时修改 |
|----|------|------|------------|
| **环境变量** | 运行前固定（端口/DB/JWT/开关） | `.env` → `.env.$XIHE_ENV` → `.env.local`（模块内 dotenv loader 统一加载，后加载覆盖先加载、不覆盖系统 env；`.env`/`.env.dev`/`.env.test`/`.env.prod` 入库且仅非敏感占位值；`.env.local` gitignore 放真实本机值） | ❌（重启；`--set KEY=VALUE` 为 CLI 最高优先级） |
| **ConfigService** | 运行时可改（模型/域参数/日志；凭证走 `provider_connections`） | `config.import.example.jsonc` → `config.import.local.jsonc`（gitignore） | ✅ UI / API |

日常 host 开发推荐 `mise run dev:host`；`mise run dev:host` 与 `mise run dev:full` 均在 CP ready 后按导入语义处理 `config.import.local.jsonc`（默认打印 reset-admin 指引，`XIHE_DEV_ADMIN_PASSWORD` 显式启用；该密码仅经 OS 环境变量注入，禁止写入脚本/git/日志）。配置优先级：per-call > CLI `--set` > env 文件链 > ConfigService 用户配置 > 代码默认；env 与 DB 冲突时显式暴露（UI 锁定显示 env 生效值，禁止静默合并）。三类配置归属速查与危险默认 fail-fast 见 DEV-003。

## Testing

| 层级 | 框架 + Docker 要求 | 位置 |
|------|-------------------|------|
| UI 单元 | Vitest ❌ | `packages/ui/src/` |
| Agent 单元/T2 | pytest ± pytest-httpx ❌ | `packages/agent/tests/` |
| Agent 集成 (T3) | pytest + httpx ✅ | `packages/agent/tests/integration/` |
| CP 单元 | JUnit (Maven) ❌ | `packages/control-plane/src/test/` |
| CP 集成 (T1) | JUnit + Testcontainers ✅ | `packages/control-plane/src/test/` |
| CP 跨模块 (T2) | JUnit + WireMock ❌ | `.../crossmodule/` |
| Runtime 单元 | cargo test --lib ❌ | `packages/runtime/tests/` |
| Runtime 集成 | cargo test some ✅ | `packages/runtime/tests/` |
| Runtime 跨模块 (T2) | cargo test + mockito ❌ | `.../cp_stub_integration_test.rs` |
| Runtime 跨模块 (T3) | cargo test + httpx ✅ | `.../cp_real_integration_test.rs` |
| E2E (Playwright) | Playwright mock + real profiles | `e2e/mock/`, `e2e/real/`；`@host` 用例只在 host profile 执行 |
| E2E (Compose) | Compose-compatible real tests + curl | `mise run test:e2e`；不覆盖 Runtime-created Sandbox |
| E2E (host) | Native CP/Agent/Runtime/UI + 每轮隔离 DB/host root + Docker/MXC/host execution profile | `mise run dev:host` + `mise run test:e2e:host` |

> Docker Desktop for Windows 须启用 WSL2 集成。所有标记 ✅ 的测试层不得因 Docker 环境跳过。

默认按受影响边界选择测试层：单模块改动跑对应单元/文件级命令；跨模块协议改动跑 T2/T3 integration；UI 消费或端到端行为改动再跑对应 Playwright profile。测试编排与真实性规则见 `xc-cross-cutting-checklist`、`test`、`integration-test-realism` 和 `playwright` skills；全量仅在里程碑或 PLAN 收尾执行。

### Contract and document sync

Route/SSE/Flyway/tool-surface changes must update the OpenAPI contract or route/event inventory and the affected package docs in the same change wave. Do not defer this sync until PLAN completion.

## Telemetry & Logging

日志通过 `XIHE_LOG_LEVEL_<MODULE>` → `XIHE_LOG_LEVEL` 回退链设定，支持 ConfigService 动态调级。JSONL 格式，`mise run clean` 清空。四模块在序列化层统一脱敏（token/JWT/Bearer/PEM → `***redacted***`），`X-Request-Id` 经 CP filter 生成并向 Runtime/Agent 贯通；泄露扫描门禁 `node scripts/scan-log-secrets.mjs`。详见 `docs/i18n/zh-Hans/DEV-004-logging.md`。

### Real E2E readiness

- 默认开发端口：UI `12630`、CP `12631`、Agent `12632`、Runtime `12633`、PostgreSQL `12634`；临时 E2E 必须使用隔离端口并显式传入 Compose。
- Agent readiness 使用 `/internal/v1/agent/health`；CP 使用 `/actuator/health`；Runtime liveness/readiness 使用 `/health` 和 `/ready`，Workspace materialization 状态按 Workspace 单独返回。
- Compose real E2E 启动当前源码镜像、Fake OAuth/MCP 和 host UI；host real E2E 使用每轮隔离 DB/host root 的 native 服务。两种 profile 失败时都必须清理容器、网络、卷、子进程和端口。
- 不可达依赖必须让测试失败，禁止以静默 `return` 计为通过。完整测试真实性规则见根池 `.agents/skills/test/references/integration-test-realism/` skill。

### Remote MCP minimal boundary

最小闭环固定为单 provider、单 workspace、单 remote server、单工具：UI OAuth → CP callback/encrypted credential → Agent→CP→Runtime → Remote MCP；Runtime 仅允许一次 401 refresh/retry。SSE 恢复、多 server 聚合、动态 provider registration、生产 KMS 和完整生命周期属于后续生产化范围，不得在最小闭环中隐式扩大。

日志安全与可观测性要求见根池 `logging-observability-security` skill；XH 具体 endpoint 和 schema 以 `docs/api/openapi.yaml` 为准。

## MCP/OAuth Boundary

- Agent 只连接 CP logical MCP endpoint，不直接访问 Runtime、stdio MCP 会话或远程 MCP。
- Canonical HTTP contract is `docs/api/openapi.yaml`; public routes use `/api/v1`, service routes use `/internal/v1`, and all service calls use `Authorization: Bearer`.
- Xihe-owned JSON uses camelCase and RFC 9457 Problem Details (`code` and `requestId`); MCP JSON-RPC and OAuth wire fields remain protocol-defined.
- CP 负责 OAuth Authorization Code + PKCE、workspace/server 授权、refresh token envelope encryption、refresh/revoke 和 token broker。
- Runtime host-side connector 只接收短期 access token，负责远程 MCP 出网、HTTPS/allowlist/私网校验；workspace sandbox 不承载远程 OAuth。
- Fake OAuth/Fake MCP 只用于真实 integration/E2E，必须验证 PKCE、Bearer、MCP protocol、refresh/revoke 和清理，不得把 mock-only 测试作为链路完成证据。
- 远程 MCP 与统一 API 的架构基线与最小闭环见 DEV-016 / DEV-014；本仓库 public route 恒 `/api/v1`、service route 恒 `/internal/v1`。

## Known Issues

- **API migration**: Vite 不再重写 API 路径；调用方必须用 canonical `/api/v1`、`/internal/v1`
- **@PreAuthorize**: 与 `/health` 方法级注解冲突，需方法级而非类级
- **Spring Boot 4 HTTP 层 ≠ Hibernate Jackson2**: CP 响应不得直接放 Jackson2 `JsonNode` / 第三方 mapper 类型（Boot 4 消息转换器与 Hibernate JSON 映射不同源，`JsonNode` 会被当 POJO 序列化）；统一 `objectMapper.convertValue(node, Object.class)` 转普通 Map/List。`isProviderSecretKey` 类嗅探器注意 `maxTokens` 含 "token" 的误伤（`contains("token") && !contains("maxtoken")`）
- **E2E 串行**: Playwright + Docker 同时运行易 OOM，mock/real 分开串行
- **上下文管道现状（PLAN-0340/0341 实施中；2026-09-15 审计条目部分关闭）**: ① `CONTEXT_OVERFLOW` **已接线**（CP 白名单 + 至多一次重跑）；② 源去重键 workspace 级问题归 PLAN-0340 L1 每 run 刷新路径；③ 摘要双写已去（SUM only）；④ cwd 三层/嵌套 AGENTS 仍见 DEV-018；⑤ **待 M2**：V9 真实浏览器验收、情况 B 旧内容折叠、真实 overflow 链路证据；摘要质量门（0354/0355）已裁定 reject → LLM 摘要默认关（见 DEV-014 §10）
- **容器资源约束**: compose 4 服务均有 `mem_limit`（pg 512m / cp 768m / agent 640m / runtime 128m），CP 内置 SerialGC + Xmx384m，沙盒容器默认 512MB / 2 CPU / 100 pids，可用 `XIHE_SANDBOX_MEMORY_MB` / `XIHE_SANDBOX_CPUS` / `XIHE_SANDBOX_PIDS_LIMIT` 覆盖（env 部署权威，非法/越界值按字段回退默认并告警）；OOM 时按需上调
- **Runtime 执行边界**: 当前 Workspace 操作经 `WorkspaceExecutionRouter` 的 per-request Docker exec（`--oneshot` 单帧）；执行接缝目标态同时支持 Windows MXC 与用户显式 `windows-host/unrestricted`，不自动 fallback。无 HTTP 通道/instance token/长驻 worker；background job 用 `/tmp/xihe-jobs` 状态文件（opaque `jobId` + `cancel_background_process`）；受限 FS 写路径经 rustix openat2 或对应 backend guard
- **Durable job 档案与续看（PLAN-0344）**: `job_state` extension v1 锚定 tool_call item（按状态机前进 upsert，终态不可回退；`scope` 固定 `session` 占位）；续看 `GET /api/v1/operations/items/{itemId}/job-output`（字节游标、UTF-8 边界由 Runtime `utf8_safe_chunk` 保证、`JOB_OUTPUT_LOST`/`JOB_OUTPUT_EXPIRED` 显式化）；destroy 前 Runtime 枚举存活 job → CP 落 `orphaned`（fail-closed）；运行时限按累计运行时间（paused 不计时）。设计见 DEV-014 §9。**单 job 取消（PLAN-0366）**：`POST /api/v1/operations/items/{itemId}/cancel`（owner-only、与续看同键位；经 Runtime internal `jobs/cancel` 复用四阶段终止，僵尸不计存活；已终态幂等 `changed:false`；终止未确认 502 `JOB_CANCEL_UNCONFIRMED` 不改档案；取消 job ≠ 取消 run；写 `operation_events`/`job.cancel`/`actor=user`）。
- **Safe Coding Loop**: Runtime mutation core 用 snapshot manifest + pre/post content hash + 多文件 patch 失败回滚；Agent MCP interceptor 经一次性 durable approval grant 恢复批准后 dispatch，grant 缺失/不匹配/重复消费 fail-closed；grant 匹配键 = canonical arguments SHA-256（`arguments_hash`），preview 截断不影响批准后执行
- **Vue i18n JSON placeholder**: `t()` 消息中不可含 `{...}`
- **MCP session-id 签名**: 必须 HMAC 签名，禁止明文或仅 Base64
- **Agent MCP init 按需执行**: 纯 chat 即使带 `workspaceId` 也不连接 CP MCP；仅明确需要 Workspace tool 的请求才触发工具发现与 Sandbox materialization；不得跨 Workspace 复用已发现工具
- **dev:full/T3 拓扑边界**: 验证主线是 Windows `dev:host`；Compose E2E 需 Runtime 的 Docker Engine socket 与容器内 WorkspaceStorage 映射，未完成前不得把 `dev:full`/T3 失败归因于 host v1
- **数据库必须 fresh baseline**: 当前源码迁移目录包含 V1–V34；`V1__init_schema.sql` 是 fresh baseline，V22/V23 是 checkpoint/revert 历史迁移，V27 将 CP 投影重建为 workspace slice rows（旧行物理清空、不做格式迁移），V30–V33 为 PLAN-0351 的 schema 清理与改名（V30 chat/session CHECK、V31 FK 子列索引、V32 删死列、V33 `session_operations`→`ledger_operations` 改名），V34 为 PLAN-0367 的 `operation_extensions` 目标 FK `SET NULL`→`CASCADE` 修复，`ddl-auto=validate`、`baseline-on-migrate=false`；旧本地库会被拒绝，恢复用 `mise run dev:reset -- -Reset`。`document_chunks` 由 Agent 侧 langchain_postgres 自建，不在 Flyway 链内
- **dev seed 密码不可知**: `DataSeeder` 生成的 `admin@xihe.local` 随机密码不打印不落盘，`dev:reset` 后恢复用 `mise run reset-admin`
- **Runtime 生命周期技术债**: `WorkspaceRegistry` / `WorkspaceManager` 已部分收敛，但 REST 文件操作仍直连 host filesystem（未走 executor Docker exec），cross-map 一致性靠周期检查兜底；后续须消除 WorkspaceManager 直接 Docker 操作并统一 REST/MCP 执行路径。`runtime_jobs` 悬空 registry 已随 PLAN-0326 删除（V14）；J-3/P1-10 立项时按需重新设计
- **`dev:host` 原生编排**: `dev:host` 先以 Docker 起 PostgreSQL 再并行管理原生 CP/Agent/Runtime/UI；`dev:host:watch` 由 Node watcher 监控四健康端点并在任务组失败后重启；`XIHE_WORKSPACE_HOST_ROOT` 控制托管 `host_directory` 根（默认 `A03-xihe\.xihe-workspaces`），direct-attach 另由用户显式选择并经 Runtime path safety 校验
- **Host E2E 数据边界**: `test:e2e:host` 每轮独立 DB + host root，不连长期 dev DB；成功/失败/中断都必须 teardown 并反向确认无本轮残留；`--keep` 仅限本地调试
- **Visual evidence boundary**: `toHaveScreenshot()` 只证明画面接近 baseline；人工 UI 审查还须读 actual/diff、检查 DOM/computed style、overflow、console/pageerror 与交互状态；`*-snapshots/*.png` 为本地生成工件，不能声称为 fresh checkout 可复现的 Git baseline
- **E2E evidence matrix**: profile/readiness/测试计数/失败分类/清理证据记录在 workspace 私有 internal 层（不在本仓库分发）；必须区分 Compose/host/manual，不得混合统计
- **Agent MCP hop / Grant 终态**: MCP 本地 hop 超时默认 ~30s（审批等待不计入）；禁用 Streamable HTTP GET server stream；用户直连 MCP mutation 免 Agent 审批并记 `actorType=user`；Agent 单 workspace 绑定，换 workspace 须重启 Agent；`apply_patch` 是 Gateway-public 且走正常 Agent/CP 审批，legacy snapshot 工具已随 PLAN-0357 删除；断线恢复 `GET /api/v1/chat/runs/{runId}`；operation 允许 `waiting_for_approval→completed/failed`（run 终态为准）；审批等待期中断以 ambiguous 收尾
- **审批策略两层 + 审批来源（PLAN-0337）**: 审批模式只保留 `manual`（逐次判定）/`auto`（自动放行），其余档位已从代码清理。策略分两层——**审批策略**（逐次判定、用户可改）与**能力策略**（能力包络、沙盒创建时确定、仅管理员可改），包络方可单向下调被包络方，反向禁止。Instance 层可写 `approval-policy` 默认（`hasRole('ADMIN')`），Workspace 层可覆盖，user 层不可写；审计来源层由 `DbPolicyContextProvider` 按 `ConfigService.effective(...).source` 回填（PLAN-0364 决策 #9，supersede PLAN-0337 选项①）。Workspace 层内 user/owner/admin 均可改自身配置。`approval_requests.origin`（V25）区分来源：`cp_gate` = CP 工具门禁触发、决定权在 CP；`agent_relay` = 模型经 `request_approval` 提问（触发权在模型，但通道、SSE 中继、durable 落库与决定回传全经 CP，UI 无直连 Agent 通路）。origin 经 PLAN-0371 只读暴露到 live/replay envelope 与 UI 卡片来源徽章；legacy null 不渲染。

详见 `docs/i18n/zh-Hans/DEV-018-known-issues.md`。

## PLAN 实施收尾检查清单

涉及 Agent 模块接口抽象、Event Sourcing 上下文架构等 PLAN 时，代码完成后按以下清单收尾：

- [ ] 更新 `packages/agent/AGENTS.md` 的项目结构、接口约定与目录说明。
- [ ] 更新 `A03-xihe/AGENTS.md` 的 Architecture 关键设计小节。
- [ ] 若 PLAN 影响 XH 领域契约，声明 Spec Impact，并同步根级 `spec/README.md`/相关 SPEC 或记录子 PLAN 承接关系。
- [ ] 根级 SPEC 变更确认唯一 active 承接 PLAN、契约/实现状态、owner、消费者、来源和验证映射；Agent/GitHub-only 规则不引入文档站 frontmatter。
- [ ] 新增或更新 `docs/i18n/zh-Hans/DEV-013-agent-architecture.md` 等设计文档（编号见 DEV-030 分块规则）。
- [ ] 若系统架构有变，同步更新 `docs/i18n/zh-Hans/DEV-001-system-architecture.md`。
- [ ] 同步更新 `plans/PLAN-XXX.md` 的 frontmatter、§7 完成状态、§8 收尾总结与决策日志。
- [ ] 为新增接口/能力补充单元测试或集成测试。
- [ ] 运行 `mise run test:agent && mise run test:cp && mise run lint:links`。
- [ ] 新增文档必须包含完整 YAML frontmatter，且所有 Markdown 链接在 `docs/` 内解析。

## Branch & Release

- `develop` — 日常开发分支
- `main` — 公开发布分支
- 所有包均为私有（不发布 npm/pypi/crates.io），版本号仅用于内部追踪
- 发布流程：更新 CHANGELOG.md → 运行 sync-versions.sh 统一 bump 四包版本号 → 提交版本变更 → 同步到 main → 审查后 push

## Skills

项目特有 skill（按需 Read `.agents/skills/<name>/SKILL.md`）：

- `ai-chat-ui-design`：AI 聊天界面设计（MessageScroller 流式/自动滚动）
- `dev-host-verification`：host readiness / M1 / E2E profile 与可恢复清理

## Permissions

- **Allowed**: 任意代码变更（文档、源代码、配置），遵循项目规范
- **Require Approval**: 架构级变更（新增模块、修改通信协议）、破坏式 API 变更、生产部署
