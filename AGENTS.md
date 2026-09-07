# xihe — 通用 Agent 运行时平台

> 四模块 Hub-Module 架构：多 Agent 编排、工具调用、沙盒执行、权限控制。

## Scope

| 包 | 描述 | 语言 |
|----|------|------|
| `packages/ui/` | 前端界面 (Vue 3 + Vite) | TypeScript |
| `packages/control-plane/` | 路由 + 认证 + MCP 反向代理 | Java 25 / Spring Boot 4 |
| `packages/agent/` | LLM 编排 + 工具调用 + RAG | Python 3.12 / LangChain |
| `packages/runtime/` | 文件系统 + 沙盒 + 进程管理 | Rust 1.88 / rmcp 3.1.4 (edition 2024) |

## Tech Stack

| 层 | 技术 | 版本 |
|----|------|------|
| UI 框架 | Vue 3 + Pinia + vue-router | ^3.5.41 / ^4.0.3 / ^5.2.0 |
| UI 构建 | Vite + Tailwind CSS 4 + shadcn-vue | ^8.2.2 / ^4.3.3 / ^2.8.2 |
| CP 框架 | Spring Boot 4 + Spring Security + Spring Data JPA | 4.0.6 |
| Agent 框架 | FastAPI + LangChain + LangGraph + litellm | — |
| Runtime 框架 | rmcp + Axum + Tokio + bollard | 3.1.4 / 0.8.9 / 1.53.1 / 0.21.1 |
| Runtime binary | `xihe-runtime`（Gateway）、`xihe-container-runtime`（容器内文件服务）、`xihe-mcp-bridge`（容器内 STDIO bridge） | 统一 `xihe-` 前缀 |
| 数据库 | PostgreSQL 17 + pgvector | — |
| 工具链 | Node 22 / pnpm 10 / Maven 3.9 / uv / task 3 / Docker | — |

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
| `mise run dev:host` | 日常 host 开发主入口：PostgreSQL Docker + CP/Agent/Runtime/UI 原生并行启动 | 推荐用于日常开发 |
| `mise run dev:full` | 一次性全容器场景（Docker + UI on host） | 自动导入 `config.import.local.jsonc`，不用于日常 host 开发 |
| `mise run dev:backend` | 启动 Docker 后端服务（无 UI） | — |
| `mise run dev:ui` | 启动 UI dev server | — |
| `mise run dev:agent` | 启动 Agent 服务 | — |
| `mise run dev:cp` | 启动 Control Plane | — |
| `mise run dev:runtime` | 启动 Runtime 服务 | — |
| `mise run dev:host` | PostgreSQL Docker + CP/Agent/Runtime/UI 原生并行启动 | Ctrl+C 由 mise 清理原生任务 |
| `mise run dev:host:watch` | 启动 host 栈并监控健康端点，故障后重启任务组 | Node watcher；不启动 CP/Agent/Runtime 容器 |
| `mise run dev:host:stop` | 停止 host 栈 PostgreSQL | 日常场景先 Ctrl+C 停止原生任务，再执行本命令 |
| `mise run dev:reset` | 默认 dry-run；显式 `-Reset` 后备份并重建本地 dev 数据、清理 host workspace/Sandbox | 仅 dev；不连接生产，不删除 Runtime device identity |
| `mise run reset-admin` | 重置 dev `admin@xihe.local` 密码（PLAN-229） | 缺省随机生成 24 字节 base64url 并打印；`pwsh scripts/reset-admin.ps1 -Password <pw>` 指定密码；免重启，账号不存在时以 ADMIN 创建，绝不删数据 |
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
| `mise run lint:runtime` | Runtime lint (clippy) | — |
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

### 3-Tier 配置管理 (ConfigService)

CP ConfigService 按 **三层所有权（System ⊃ Admin ⊃ User）+ 领域（Domain）** 组织配置。UI 入口 `/settings/config` 分 3 tab。

| Domain | S | A | U | Domain | S | A | U |
|--------|---|---|---|--------|---|---|---|
| `infrastructure` | ✅ | ❌ | ❌ | `user-preference` | ✅ | ✅ | ✅ |
| `logging` | ✅ | ✅ | ✅ | `mcp` | ✅ | ✅ | ✅ |
| `llm-provider` | ✅ | ✅ | ✅ | `rag` | ✅ | ✅ | ✅ |
| `embedding` | ✅ | ✅ | ✅ | `workspace-config` | ✅ | ✅ | ✅ |

详见 `plans/archive/20260629/A03-xihe/PLAN-042-unified-config-management.md`、`plans/archive/20260629/A03-xihe/PLAN-051-settings-ui-restructure.md`。
### Provider 配置共享

| 功能 | 配置来源 | 入口 |
|------|---------|------|
| Chat | `LLMConfig.from_config_client()` | `llm/base.py` |
| Image | `ProviderManager.from_config_client()` | `tools/__init__.py` |
| Embedding | 初始化时从 `config_client.get_providers()` 解析 | `main.py:134-150` |

### Agent 模块接口抽象

Agent 模块已引入接口抽象层，将 LangChain/LangGraph 实现隔离在接口之后：

- `AgentRunner` — 编排抽象，`LangGraphRunner` 为当前实现
- `BaseAgentTool` / `ToolSpec` — 工具抽象，MCP/Approval/Image 工具均实现该接口
- `EventAdapter` — 将框架原始事件翻译为 SSE `AgentEvent`
- `LLMProvider` — LLM 后端抽象，`complete()` / `stream_complete()`
- `EventStore` / `AgentContext` — Event Sourcing 上下文管理（PLAN-035）

详见 [docs/i18n/zh-Hans/DEV-013-agent-architecture.md](docs/i18n/zh-Hans/DEV-013-agent-architecture.md)。

### Runtime / Sandbox 生命周期边界

- 当前 v1 的控制面与执行面保持分离：CP 负责 workspace 元数据、授权、健康状态和降级；Runtime 负责实际文件、命令、容器和 MCP bridge 执行；进程保活由外部 orchestrator（Docker/mise watcher）负责。
- `GET /api/v1/workspaces/{workspaceId}/environment` 是只读诊断视图，展示 WorkspaceExecutionSpec、storageRef、Runtime observed status 和 heartbeat，不返回 raw host path、secret 或文件内容。
- Runtime 启动只完成自身 liveness/readiness；通过受保护的 targeted ExecutionSpec API 按 `workspaceId` 懒加载 Workspace，`/ready` 不等待全部 Sandbox 物化，`/health` 仅表示进程存活。
- `WorkspaceRegistry` 与真正的 `WorkspaceManager` 若同时存在，必须先收敛为一条可恢复的 workspace 状态机，统一覆盖 create、exec、MCP、pause/resume、restart 和 delete；不要在双路径上继续堆叠功能。
- 单 Runtime/单设备 v1 不把 registration、heartbeat、generation、warm pool、microVM 或多设备接管设为运行前置条件；这些属于后续 runtime hardening/生产化范围。
- 隔离引擎升级应排在生命周期状态机、持久化恢复和 fail-closed 边界之后。未知 workspace、Docker 不可用和执行超时必须显式失败，不能用默认目录或静默降级掩盖状态丢失。
- 远程 MCP 仍只经 CP logical endpoint；多 workspace MCP client 缓存和清理属于独立后续工作，不应复用另一个 workspace 的已发现工具。

## Code Style

- **Naming**: `camelCase` (TS/JS/Java), `snake_case` (Python/Rust)
- **Agent 术语**: 代码包用 Agent 模块 (module)，运行进程用 Agent 服务 (server)，运行时单元用 Agent Worker (Worker)
- **异常日志**: 每个 catch 必须有日志 + stacktrace，禁止 silent catch
- **UI**: reka-ui + Tailwind v4；聊天组件使用自研 MessageScroller / Message / Bubble / Attachment / Marker 五个组件族；Toast 为唯一反馈渠道
  - reka-ui 封装契约（PLAN-258 实证）：`ComboboxContent position=popper` 必须显式 `ComboboxAnchor` 包裹触发器，否则内容自参考内部 Input 定位到视口外且零报错；`CollapsibleTrigger` 已自带切换，触发按钮不得再绑额外 click handler（双重翻转 = 永远不折叠）
  - workspace UI 基座（PLAN-262）：文件树/右键菜单基于 reka-ui `Tree`/`ContextMenu` 原语 + `shadcn-vue add` 拷贝封装（零新增运行时依赖）；`AlertDialogAction` 点击无条件关闭——需校验失败保持打开的场景用普通 destructive `Button`；reka-ui MenuItem 程序化选择在 jsdom 下不可行，交互连接层由 Playwright 覆盖
  - workspace 管理（PLAN-262）：`POST /api/v1/workspaces` 接受 profile（strict/coding/isolated）+ image（白名单 v1 仅 `xihe/workspace:latest`），initialSpec 按选择生成；`POST /api/v1/workspaces/{id}/materialize` 异步触发（202）+ 轮询 environment；创建入口 = 无 workspace 空态；物理目录 `hostRoot/workspaceId` 派生，宿主机可直接系统文件操作访问
- **Chat 架构**: chat 与 workspace 为同一 Session 的不同视图，共享 `useSessionStore`；消息附件已持久化到后端 Session 专属空间，刷新后仍可渲染（详见 DEV-001 §7、DEV-017）。
  - 会话级持久 SSE（PLAN-230）：`GET /api/v1/events?sessionId=` 为单会话单活连接（`SseEmitterManager` generation + `compareAndRemove`），`done` 仅结束 run、不关闭 SSE，`heartbeat` 15s 不进业务气泡；`POST /api/v1/chat` 需已建立订阅（`409 SSE_SUBSCRIPTION_REQUIRED`）且单并发（`409 CHAT_IN_PROGRESS`），`requestId`/`runId` 经 `X-Request-Id`/`X-Chat-Run-Id` 显式透传。
  - 流式渲染：`useStreamParser` 将 token 实时分类为 `MessagePart[]`（`text`/`reasoning`/`citation`/`artifact`），`SSEStream` 每 `token` 调用 `chatStore.replaceStreamingParts` 整量替换当前流式 parts（修复旧 `lastSentCount` 仅 `parts.length` 增长时追加导致的卡首字符）；`Message.parts` 替代旧 `marked`，`useMarkdown` 仅处理纯 Markdown。
  - 真实流式：`XiheLiteLLM._astream()` 显式 `streaming=True` 使 `astream_events` 产生 `on_chat_model_stream` 多 token，`sse_adapter` 按 `run_id` 去重使 `on_chat_model_end` 仅作无流 fallback；多 `token` 事件驱动气泡在 `done` 前多次增长。
  - ChatRun（PLAN-247）：CP 在 LLM readiness gate 和 SSE subscription 通过后按 `(userId, sessionId, Idempotency-Key)` 持久化 run；`Message.runId` 关联 `success/error/partial/ambiguous` 终态，同 key 不重复启动 Agent，ambiguous 只能用新 key 手动重试。
  - Provider/model binding：UI、CP、Agent 全链路传递 `provider` + `model` + `toolMode`；`modelProvider + modelName` 是 session canonical pair，普通 Chat 固定 `toolMode=none`，Workspace/tool 操作显式使用 `workspace`。
- **配置**: 3-tier (system > admin > user)，CP ConfigService 统一管理
- **Service 纯函数**: Service 不依赖 ConfigClient，配置由调用方解析后传入
- **提交**: Conventional Commits，pass `mise run validate` 后可提交
- **跨协议/跨服务变更走 XH 跨包 checklist（2026-09 会话回溯沉淀）**：任何同时涉及 UI/CP/Agent 三层，或新增/修改 SSE 事件、public/internal route、AgentEvent、CP durable record、UI store 类型、OpenAPI、Flyway、env 的改动，必须先按 `one/.agents/skills/xc-cross-cutting-checklist/SKILL.md` 跑契约定稿 → UI/CP/Agent/Runtime 四层落地 → 契约/测试/证据 → 提交与收尾，禁止以 mock 绿代替真实链路，禁止路由/字段跨层漂移；项目级 `AGENTS.md` / DEV-001 / DEV-013 / DEV-014 文档同步按根 AGENTS 状态回写规则执行。

## Env Files

两层配置模型：

| 层 | 用途 | 文件 | 可运行时修改 |
|----|------|------|------------|
| **环境变量** | 运行前固定（端口/DB/JWT） | `.env.example` → `.env.dev`（gitignore） | ❌ |
| **ConfigService** | 运行时可改（API key/模型/日志） | `config.import.example.jsonc` → `config.import.local.jsonc`（gitignore） | ✅ UI / API |

日常 host 开发推荐 `mise run dev:host`；`mise run dev:full` 仅用于一次性全容器场景，CP ready 后按导入语义处理 `config.import.local.jsonc`（默认打印 reset-admin 指引，`XIHE_DEV_ADMIN_PASSWORD` 显式启用）。配置生效优先级推荐为：启动环境变量 → `.env.dev` → ConfigService / UI Settings；三类配置归属速查见 DEV-003 §2。

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
| E2E (host) | Native CP/Agent/Runtime/UI + 每轮隔离 DB/host root + Docker Sandbox | `mise run dev:host` + `mise run test:e2e:host` |

> Docker Desktop for Windows 须启用 WSL2 集成。所有标记 ✅ 的测试层不得因 Docker 环境跳过。

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

- Agent 只连接 CP logical MCP endpoint，不直接访问 Runtime、workspace bridge 或远程 MCP。
- Canonical HTTP contract is `docs/api/openapi.yaml`; public routes use `/api/v1`, service routes use `/internal/v1`, and all service calls use `Authorization: Bearer`.
- Xihe-owned JSON uses camelCase and RFC 9457 Problem Details (`code` and `requestId`); MCP JSON-RPC and OAuth wire fields remain protocol-defined.
- CP 负责 OAuth Authorization Code + PKCE、workspace/server 授权、refresh token envelope encryption、refresh/revoke 和 token broker。
- Runtime host-side connector 只接收短期 access token，负责远程 MCP 出网、HTTPS/allowlist/私网校验；workspace sandbox 不承载远程 OAuth。
- Fake OAuth/Fake MCP 只用于真实 integration/E2E，必须验证 PKCE、Bearer、MCP protocol、refresh/revoke 和清理，不得把 mock-only 测试作为链路完成证据。
- 远程 MCP 相关实施与 API 统一迁移分别见 `plans/archive/20260828/PLAN-190-XH-remote-mcp-oauth-egress.md`（已归档为架构基线，最小闭环由 PLAN-195 承接完成）和 `plans/PLAN-191-XH-unified-stable-api.md`。

## Known Issues

- **API migration**: Vite no longer rewrites API paths; callers must use the canonical `/api/v1` and `/internal/v1` contracts.
- **@PreAuthorize**: 与 `/health` 方法级注解冲突，需方法级而非类级
- **E2E 串行**: Playwright + Docker 同时运行易 OOM，mock/real 分开串行
- **容器资源约束**: compose 4 服务均有 `mem_limit`（pg 512m / cp 768m / agent 640m / runtime 128m），CP 内置 SerialGC + Xmx384m，沙盒容器限 512MB + 2 CPU（PLAN-097）。OOM 时按需上调
- **runtime 测试现状**: 全量 `cargo test` 可编译执行；当前库测试 128 通过、全量测试 210+ 通过并有 3 个明确 ignored 的 CP 实时测试（PLAN-235 M3，2026-09-03）。runtime Dockerfile 已修复 dummy 缓存陷阱（`touch` 源码），此前镜像曾包含 stub 二进制
- **Runtime 执行边界（PLAN-235）**: Workspace 操作统一经 `WorkspaceExecutionRouter` 的 per-request Docker exec（`--oneshot` 单帧 EOF），无 HTTP 通道/instance token/长驻 worker；background job 为 `/tmp/xihe-jobs` 状态文件约定（opaque `jobId` + `cancel_background_process`）；FS 写路径经 rustix openat2 helper
- **Vue i18n JSON placeholder**: `t()` 消息中不可含 `{...}`
- **MCP session-id 签名**: 必须使用 HMAC 签名，禁止明文或仅 Base64 编码
- **Agent MCP init 按需执行**: 纯 chat 即使带 current `workspaceId` 也不连接 CP MCP；只有明确需要 Workspace tool 的请求才触发工具发现和 Sandbox materialization。不得把一个 Workspace 的工具复用于其他 Workspace。
- **dev:full/T3 拓扑边界**: 当前验证主线是 Windows `dev:host`。完整 Compose E2E 仍需要为 Runtime 提供 Docker Engine socket 和容器内 WorkspaceStorage 映射；未完成前不得将 `dev:full`/T3 的 workspace、MCP 和截图失败归因于 host v1。
- **数据库必须 fresh baseline（PLAN-280）**：active Flyway 链只有 `V1__init_schema.sql`；`ddl-auto=validate`、`baseline-on-migrate=false`。旧本地数据库会被拒绝，恢复方式为 `mise run dev:reset -- -Reset`。`document_chunks` 由 Agent 侧 langchain_postgres 自建，不在 Flyway 链内。
- **dev seed 密码不可知**: `DataSeeder` 为 `admin@xihe.local` 生成的随机密码不打印、不落日志，`dev:reset` 重建库后无法用旧凭据登录；恢复方式为 `mise run reset-admin`（PLAN-229）。
- **Runtime 生命周期技术债**: `WorkspaceRegistry` 与 `WorkspaceManager` 若继续形成双路径，会使 create/exec/MCP/pause-resume/restart/delete 的状态不可恢复；后续应先收敛为单一生命周期状态机，再推进 warm pool、microVM 或多设备接管等隔离增强。
- **`dev:host` 原生编排**: `mise run dev:host` 先以 Docker 启动并等待 PostgreSQL，再由 mise 并行管理原生 CP/Agent/Runtime/UI；`mise run dev:host:watch` 通过 Node watcher 检查四个健康端点并在任务组失败后重启。`scripts/dev-host.ps1` 仅保留兼容的检查/包装入口。`XIHE_WORKSPACE_HOST_ROOT` 控制 `host_directory` 根，默认 `A03-xihe\.xihe-workspaces`
- **Host E2E 数据边界**: `mise run test:e2e:host` 每轮使用独立数据库和 host root，不连接长期 dev DB。成功、失败和中断都必须 teardown，并反向确认用户、Workspace、Session、ExecutionSpec、Sandbox、host 文件和 fixture 无本轮残留；`--keep` 仅限本地调试。
- **Visual evidence boundary**: `toHaveScreenshot()` 只证明当前画面接近 baseline；人工 UI 审查还需读取 actual/diff、检查 DOM/computed style、overflow、console/pageerror 和交互状态。当前 A03 `*-snapshots/*.png` 按 `.gitignore` 规则作为本地生成工件处理，不能声称为 fresh checkout 可复现的 Git baseline。
- **E2E evidence matrix**: 当前 profile、readiness、测试计数、失败分类和清理证据统一记录在 workspace 私有 internal 层（不在本仓库分发）；更新结果必须区分 Compose、host 和 manual，不得混合统计。

详见 `docs/i18n/zh-Hans/DEV-018-known-issues.md`。覆盖率缺口 `plans/archive/20260629/A03-xihe/PLAN-052-unit-test-gap-fill.md`。

## PLAN 实施收尾检查清单

涉及 Agent 模块接口抽象、Event Sourcing 上下文架构等 PLAN 时，代码完成后按以下清单收尾：

- [ ] 更新 `packages/agent/AGENTS.md` 的项目结构、接口约定与目录说明。
- [ ] 更新 `A03-xihe/AGENTS.md` 的 Architecture 关键设计小节。
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

本项目特有的 Agent Skills 位于 `.agents/skills/`（开放标准位置，兼容工具在本项目根下自动发现）。具体清单见 `.agents/skills/AGENTS.md`（目录级索引：名称/用途/路径）；one 根会话按 one/AGENTS.md「Skills 体系」节导航协议使用。

## Permissions

- **Allowed**: 任意代码变更（文档、源代码、配置），遵循项目规范
- **Require Approval**: 架构级变更（新增模块、修改通信协议）、破坏式 API 变更、生产部署
