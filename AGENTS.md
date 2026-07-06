# xihe — 通用 Agent 运行时平台

> 四模块 Hub-Module 架构：多 Agent 编排、工具调用、沙盒执行、权限控制。

## Scope

| 包 | 描述 | 语言 |
|----|------|------|
| `packages/ui/` | 前端界面 (Vue 3 + Vite) | TypeScript |
| `packages/control-plane/` | 路由 + 认证 + MCP 反向代理 | Java 25 / Spring Boot 4 |
| `packages/agent/` | LLM 编排 + 工具调用 + RAG | Python 3.12 / LangChain |
| `packages/runtime/` | 文件系统 + 沙盒 + 进程管理 | Rust 1.88 / rmcp |

## Tech Stack

| 层 | 技术 | 版本 |
|----|------|------|
| UI 框架 | Vue 3 + Pinia + vue-router | ^3.5 / ^3.0 / ^5.1 |
| UI 构建 | Vite + Tailwind CSS 4 + shadcn-vue | ^8 / ^4.3 / ^2.7 |
| CP 框架 | Spring Boot 4 + Spring Security + Spring Data JPA | 4.0.6 |
| Agent 框架 | FastAPI + LangChain + LangGraph + litellm | — |
| Runtime 框架 | rmcp + Axum + Tokio + bollard | 1.7.0 / 0.8.9 / 1.52.3 |
| Runtime binary | `xihe-runtime`（Gateway）、`xihe-container-runtime`（容器内文件服务）、`xihe-mcp-bridge`（容器内 STDIO bridge） | 统一 `xihe-` 前缀 |
| 数据库 | PostgreSQL 17 + pgvector | — |
| 工具链 | Node 22 / pnpm 10 / Maven 3.9 / uv / task 3 / Docker | — |

## Setup

```bash
# 1. Install dependencies (all modules)
mise run setup

# 2. Start all modules (Docker Compose backend + UI on host)
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
| `mise run dev:full` | 启动全部服务 (Docker + UI) | 自动导入 `config.import.local.jsonc` |
| `mise run dev:backend` | 启动 Docker 后端服务（无 UI） | — |
| `mise run dev:ui` | 启动 UI dev server | — |
| `mise run dev:agent` | 启动 Agent 服务 | — |
| `mise run dev:cp` | 启动 Control Plane | — |
| `mise run dev:runtime` | 启动 Runtime 服务 | — |
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
| `mise run test:e2e` | Playwright E2E 测试 | 自动管理 Docker Compose |
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
| `mise run clean` | 清理日志与构建产物 | — |
| `mise run image:workspace:build` | 构建 workspace 容器镜像 | — |

### 文件级命令

```bash
# UI
cd packages/ui && pnpm run lint && pnpm run typecheck && pnpm run test:unit
cd packages/ui && npx playwright test e2e/mock/    # Mock E2E
cd packages/ui && npx playwright test e2e/real/    # Real E2E (需 Docker)
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

## Code Style

- **Naming**: `camelCase` (TS/JS/Java), `snake_case` (Python/Rust)
- **Agent 术语**: 代码包用 Agent 模块 (module)，运行进程用 Agent 服务 (server)，运行时单元用 Agent Worker (Worker)
- **异常日志**: 每个 catch 必须有日志 + stacktrace，禁止 silent catch
- **UI**: reka-ui + Tailwind v4；聊天组件使用自研 MessageScroller / Message / Bubble / Attachment / Marker 五个组件族；Toast 为唯一反馈渠道
- **Chat 架构**: chat 与 workspace 为同一 Session 的不同视图，共享 `useSessionStore`；消息附件已持久化到后端 Session 专属空间，刷新后仍可渲染（详见 DEV-001 §7）
- **配置**: 3-tier (system > admin > user)，CP ConfigService 统一管理
- **Service 纯函数**: Service 不依赖 ConfigClient，配置由调用方解析后传入
- **提交**: Conventional Commits，pass `mise run validate` 后可提交

## Env Files

两层配置模型：

| 层 | 用途 | 文件 | 可运行时修改 |
|----|------|------|------------|
| **环境变量** | 运行前固定（端口/DB/JWT） | `.env.example` → `.env.dev`（gitignore） | ❌ |
| **ConfigService** | 运行时可改（API key/模型/日志） | `config.import.example.jsonc` → `config.import.local.jsonc`（gitignore） | ✅ UI / API |

`mise run dev:full` 自动导入 `config.import.local.jsonc`；CP 配置统一走 `config.import.*.jsonc`，内部种子已移除。

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
| E2E (Playwright) | Playwright (real only ✅) | `e2e/mock/`, `e2e/real/` |
| E2E (Docker Compose) | docker compose + curl | — |

> Docker Desktop for Windows 须启用 WSL2 集成。所有标记 ✅ 的测试层不得因 Docker 环境跳过。

## Telemetry & Logging

日志通过 `XIHE_LOG_LEVEL_<MODULE>` → `XIHE_LOG_LEVEL` 回退链设定，支持 ConfigService 动态调级。JSONL 格式，`mise run clean` 清空。详见 `docs/i18n/zh-Hans/DEV-003-logging.md`。

## Known Issues

- **Vite proxy rewrite**: CP `@RequestMapping` 不含 `/api/v1` 前缀，由 Vite rewrite 剥离
- **@PreAuthorize**: 与 `/health` 方法级注解冲突，需方法级而非类级
- **E2E 串行**: Playwright + Docker 同时运行易 OOM，mock/real 分开串行
- **Vue i18n JSON placeholder**: `t()` 消息中不可含 `{...}`
- **MCP session-id 签名**: 必须使用 HMAC 签名，禁止明文或仅 Base64 编码

详见 `docs/i18n/zh-Hans/DEV-012-known-issues.md`。覆盖率缺口 `plans/archive/20260629/A03-xihe/PLAN-052-unit-test-gap-fill.md`。

## Branch & Release

- `internal/develop` — 日常开发分支
- `main` — 公开发布分支
- 所有包均为私有（不发布 npm/pypi/crates.io），版本号仅用于内部追踪
- 发布流程：更新 CHANGELOG.md → 运行 sync-versions.sh 统一 bump 四包版本号 → 提交版本变更 → 同步到 main → 审查后 push

## Permissions

- **Allowed**: 任意代码变更（文档、源代码、配置），遵循项目规范
- **Require Approval**: 架构级变更（新增模块、修改通信协议）、破坏式 API 变更、生产部署
