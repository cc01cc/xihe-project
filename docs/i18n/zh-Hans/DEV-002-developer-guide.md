---
title: DEV-002 - 开发环境搭建与指南
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 2
status: active
created: 2026-05-28
updated: 2026-06-15
---

# 开发者指南 — xihe Agent 平台

## 1. 项目结构

```text
xihe/
├── packages/
│   ├── ui/                    # Vue 3 + Vite + Tailwind CSS + reka-ui
│   │   ├── src/
│   │   │   ├── components/    # 侧边栏 / 聊天 / 多模态 / 设置
│   │   │   ├── composables/   # SSE / Theme / API / LangChain 适配
│   │   │   ├── stores/        # Pinia: session / chat / settings / agent
│   │   │   ├── views/         # 设置页面
│   │   │   ├── router/        # Vue Router
│   │   │   ├── i18n/          # 国际化（zh-Hans / en）
│   │   │   ├── styles/        # HSL CSS 变量 / Tailwind v4
│   │   │   ├── mocks/         # MSW 测试 mock
│   │   │   └── types/         # TypeScript 类型定义
│   │   ├── e2e/               # Playwright E2E 测试
│   │   └── vitest.config.ts
│   ├── control-plane/         # Java + Spring Boot 4 + GraalVM
│   │   └── src/
│   │       ├── main/java/.../cp/
│   │       │   ├── auth/      # JWT 认证（登录/注册/刷新）
│   │       │   ├── chat/      # SSE 流式聊天
│   │       │   ├── config/    # Security / Jackson / TenantContext
│   │       │   ├── entity/    # JPA 实体（9 个）
│   │       │   ├── repository/# JPA Repository（8 个）
│   │       │   ├── mcp/       # MCP 反向代理
│   │       │   └── audit/     # 审计日志
│   │       └── resources/
│   │           └── db/migration/  # Flyway 迁移
│   ├── agent/                 # Python + LangChain + LangGraph
│   │   └── src/xihe_agent/
│   │       ├── adapters/      # SSE 适配 / MCP 客户端 / 审批工具
│   │       ├── agent/         # Executor / Prompts
│       │       └── llm/           # LLM 抽象（ChatLiteLLM 包装，100+ Provider）
│   └── runtime/               # Rust + rmcp + Tokio + Axum
│       └── src/
│           ├── main.rs        # MCP Server（8 个工具）
│           ├── fs.rs          # 文件操作（ignore/walkdir/globset）
│           ├── sandbox.rs     # Docker 沙盒（bollard）
│           └── error.rs       # 错误类型
├── docs/
│   └── i18n/
│       └── zh-Hans/
│           ├── DEV-001-system-architecture.md
│           ├── DEV-002-developer-guide.md
│           ├── DEV-003-logging.md
│           ├── DEV-004-ui-checklist.md
│           ├── DEV-005-mcp-architecture.md
│           ├── DEV-010-documentation-layout-and-frontmatter.md
│           └── USER-001-user-guide.md
├── internal/
│   └── SPRINTS/                      # Sprint 设计文档
├── scripts/                          # 开发辅助脚本
├── postgres-init/                    # Docker PostgreSQL 初始化
└── docker/                           # 容器镜像构建
    └── images/workspace/             # xihe/workspace 容器镜像
```

## 2. 开发环境

### 2.1. 2.1 前置依赖

推荐在根目录使用 `mise` 管理工具链和跨模块命令：

```bash
mise install
```

如果当前 shell 还没有执行 `mise activate`，后面的根任务建议统一写成 `mise run ...`。`task` / `Taskfile.yml` 已弃用，仅作为 backwards compatibility 保留。

```bash
node --version  # v22+
pnpm --version  # v10+

# Python (Agent)
python --version  # 3.12+
uv --version

# Java (CP)
java --version   # 25+
mvn --version    # 3.8+ (system) / 3.9.x via mise

# Rust (Runtime)
rustc --version  # 1.88+
cargo --version  # 1.88+
```

### 2.2. 2.2 安装依赖

推荐直接在根目录执行：

```bash
mise run setup
cp .env.example .env.dev
```

根目录现在通过 `XIHE_ENV` 选择环境文件：

- `XIHE_ENV=dev`：依次加载 `.env`、`.env.dev`、`.env.local`、`.env.dev.local`
- `XIHE_ENV=test`：依次加载 `.env`、`.env.test`、`.env.local`、`.env.test.local`
- `XIHE_ENV_FILE=/path/to/file`：显式指定单个 env 文件

`mise run dev:*` 默认使用 `XIHE_ENV=dev`。
如果这些文件合并后的结果中存在 `XIHE_DEEPSEEK_API_KEY`，且没有显式设置
`XIHE_LLM_PROVIDER`，Agent 会自动切到 `deepseek`；如果没有 key，则回落到
`mock`。

等价的模块级命令如下：

```bash
# UI
cd packages/ui && pnpm install --ignore-workspace

# Agent
cd packages/agent && uv sync --all-extras

# CP
cd packages/control-plane && mvn dependency:resolve

# Runtime
cd packages/runtime && cargo fetch
```

### 2.3. 2.3 根目录任务

```bash
mise run dev:ui
mise run build:ui
mise run build:runtime

mise run dev:agent
mise run test:agent
mise run test:integration

mise run dev:cp
mise run test:cp

mise run dev:runtime
mise run test:runtime

mise run test:e2e
mise run validate:full
```

如果你不想依赖根任务，也可以进入模块目录手动执行；但这时根 `.env`
和对应 profile env 不会被自动读取，需要你自己先导出环境变量。

根目录已经不再使用 pnpm workspace。UI 仍使用 pnpm，但仅在 `packages/ui/` 内部管理依赖和锁文件。
由于当前仓库位于外层 `one` workspace 内，直接在 `packages/ui/`
下执行 pnpm 命令时需要带上 `--ignore-workspace`，或者直接使用根目录
`mise run *` 任务。

### 2.4. 2.2 运行模式

CP (Control Plane) 支持两种运行模式：

#### 模式 A: Docker Compose 全栈（推荐用于集成测试）

```bash
docker compose up -d --build
```

启动全部 4 个服务：`postgres` + `control-plane` + `agent` + `runtime`。

CP 通过 Docker 内部网络 `xihe-net` 连接 `postgres:5432`，PostgreSQL 用户密码由 `docker-compose.yml` 中 `POSTGRES_USER` / `POSTGRES_PASSWORD` 定义。

**资源约束**（PLAN-097）：4 个服务均设有 `mem_limit`（postgres 512m / control-plane 768m / agent 640m / runtime 128m）。CP 镜像内置 JVM 调参（SerialGC + `-Xmx384m`），postgres 降配为 `max_connections=40`。沙盒容器另有 512MB 内存 + 2 CPU 上限。若服务因 OOM 被杀（`docker inspect <容器> --format '{{.State.OOMKilled}}'` 返回 true），按需上调对应 `mem_limit`。

验证：

```bash
curl -s http://localhost:12631/actuator/health    # 预期: {"status":"UP"}（Docker 内为 :8080）
curl -s http://localhost:12633/health              # 预期: OK（Docker 内为 :8001）
```

#### 模式 B: 宿主开发（CP 在宿主机运行，用于单元测试）

```bash
# 方式 B1: H2 内存库（零配置，推荐）
XIHE_CP_DATASOURCE_URL="jdbc:h2:mem:xihe;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE" \
XIHE_CP_DATASOURCE_DRIVER="org.h2.Driver" \
XIHE_CP_DATASOURCE_USERNAME="sa" \
XIHE_CP_DATASOURCE_PASSWORD="" \
mvn spring-boot:run -f packages/control-plane/pom.xml

# 方式 B2: PostgreSQL 容器（需先启动 Docker）
docker compose up -d postgres
mvn spring-boot:run -f packages/control-plane/pom.xml
```

**注意**：在 WSL2 mirror 网络模式下，宿主连接 Docker PostgreSQL 可能遇到密码认证失败。这是因为 `bridge` 网络的端口映射导致连接源地址被 NAT 转换，`pg_hba.conf` 中的 `127.0.0.1/32 trust` 规则不匹配。遇到此问题时请使用**方式 B1（H2）**或**模式 A（全 Docker Compose）**。

`.env.dev` 文件记录了两种数据库配置（PostgreSQL 为默认，H2 被注释），取消注释即可切换。

### 2.5. 2.3 配置管理 (PLAN-042)

#### 架构概览

CP ConfigService 是统一的配置管理入口，采用两层模型：

| 层 | 用途 | 修改方式 |
|----|------|---------|
| **环境变量** | 运行前固定（端口/DB/JWT） | `.env.dev`（gitignore）|
| **ConfigService** | 运行时可改（API key/模型/日志） | UI Settings / `PUT /config/admin/{domain}` / `POST /config/import` |

**优先级**：ConfigService 值覆盖环境变量同名 key。

**Phase 3 变更**：
- `XIHE_LOAD_DOTENV=0` — 各模块不再从 `.env`/`.env.dev` 读取应用层配置
- 所有应用层配置（LLM provider、API key、model、log level、embedding 等）通过 CP ConfigService 管理
- 仅保留 bootstrap 变量用于基础设施启动（`XIHE_CP_URL`、`XIHE_CP_API_TOKEN`、`XIHE_RUNTIME_HOST/PORT`、`XIHE_DATASOURCE_*` 等）

#### 配置方式

**方式 A: CP API**（运行时修改，立即生效）

```bash
# 设置 admin 级配置
curl -X PUT http://localhost:8080/config/admin/llm-provider \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"deepseekApiKey": "sk-xxx", "defaultProvider": "deepseek"}'

# 读取当前生效配置
curl http://localhost:8080/config/llm-provider \
  -H "Authorization: Bearer $TOKEN"
```

**方式 B: JSONC 导入**（批量初始化，推荐用于 dev 启动）

```bash
# 导入配置到 admin 层
curl -X POST http://localhost:8080/config/import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d @config.import.local.jsonc
```

`mise run dev:full` 会自动执行此导入（CP ready 后）。

JSONC 支持注释和尾部逗号，可直接复制 Claude Desktop / Cursor 的 MCP 配置片段。

#### 开发流程

1. **`cp config.import.example.jsonc config.import.local.jsonc`** — 填入 API key
2. **`mise run dev:full`** — Docker Compose 启动 + CP ready 后自动导入 `config.import.local.jsonc`
3. **运行时调试** — `PUT /config/admin/{domain}` 或 UI 设置页修改，立即生效

#### 配置客户端

各模块通过本地客户端访问 CP ConfigService：

| 模块 | 客户端文件 | 行为 |
|------|-----------|------|
| **Control Plane** | `ConfigService.java` | 内建 `@Service`，对外暴露 CRUD API，PG 持久化 |
| **Agent** | `xihe_agent/config_client.py` | 启动时拉取 admin+system 缓存，提供 `get(key, default)` 接口 |
| **Runtime** | `src/config_client.rs` | 启动时拉取并定期刷新，提供 `get(key)` 接口 |

### 2.6. 2.4 集成测试

Agent 集成测试（`packages/agent/tests/test_agent_cp_integration.py`）需要 CP 运行在 `localhost:8080`。

```bash
# 方式 1: Docker Compose（推荐）
docker compose up -d --build
cd packages/agent && uv run pytest tests/test_agent_cp_integration.py -v

# 方式 2: 宿主 H2 模式
XIHE_CP_DATASOURCE_URL="jdbc:h2:mem:xihe;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE" \
XIHE_CP_DATASOURCE_DRIVER="org.h2.Driver" \
XIHE_CP_DATASOURCE_USERNAME="sa" \
XIHE_CP_DATASOURCE_PASSWORD="" \
mvn spring-boot:run -q -f packages/control-plane/pom.xml &
sleep 12
cd packages/agent && uv run pytest tests/test_agent_cp_integration.py -v
```

测试文件已包含 `@pytest.mark.skipif` 自动检测，CP 不可达时静默跳过。

## 3. 架构设计

### 3.1. 3.1 通信协议

- UI ↔ CP：HTTP + SSE，用于聊天消息流
- Agent ↔ CP：HTTP + SSE，用于 Agent 流式响应
- CP ↔ Runtime：MCP（Streamable HTTP），用于工具调用

### 3.2. 3.2 MCP 反向代理

CP 作为 HTTP 反向代理，不依赖任何 MCP SDK：

```text
Agent → POST /mcp → CP (JSON 解析 + 权限检查 + 请求改写) → Runtime
```

详见 `internal/SPRINTS/SPRINT-001-cs-agent-mvp/DESIGN-007-mcp-gateway-reverse-proxy.md`

### 3.3. 3.3 工具名命名空间

CP 在 tools/list 时加前缀，tools/call 时去前缀：

- Runtime 返回：`read_file`
- CP 返回给 Agent：`runtime__read_file`
- Agent 调用：`runtime__read_file`
- CP 去前缀后转发：`read_file` -> Runtime

详见 `internal/SPRINTS/SPRINT-001-cs-agent-mvp/DESIGN-009-tool-namespace.md`

### 3.4. 3.4 SSE 事件协议

UI ↔ CP 之间通过 SSE 传输 7 种事件：

| 事件 | 方向 | 说明 |
|------|------|------|
| `token` | CP→UI | LLM 输出 token |
| `tool_call` | CP→UI | 工具开始执行 |
| `tool_result` | CP→UI | 工具执行结果 |
| `approval_request` | CP→UI | 请求用户确认 |
| `status` | CP→UI | Agent 状态变更 |
| `error` | CP→UI | 错误信息 |
| `done` | CP→UI | 完成（含 token 统计） |

LangChain 事件通过 SSE 适配层（`packages/agent/src/xihe_agent/adapters/sse_adapter.py`）自动映射。

## 4. 测试

### 4.1. 4.1 测试全景

| 模块 | 框架 | 测试数 | 运行命令 |
|------|------|--------|---------|
| **UI 单元** | Vitest + @vue/test-utils | 206 | `cd packages/ui && pnpm vitest run` |
| **UI E2E (Mock)** | Playwright + page.route() | 40 | `cd packages/ui && npx playwright test e2e/mock/` |
| **UI E2E (Real)** | Playwright + 真实 CP | 32 | `cd packages/ui && npx playwright test e2e/real/` (需 Docker Compose) |
| **CP** | JUnit 5 + Mockito + Testcontainers | 152 | `cd packages/control-plane && mvn test` |
| **Agent 单元** | pytest + pytest-asyncio | 150 | `cd packages/agent && uv run pytest tests/unit/ -v` |
| **Agent 集成** | pytest + httpx | — | `cd packages/agent && uv run pytest tests/integration/ -v` (需 Docker Compose) |
| **Runtime** | cargo test | 176 | `cd packages/runtime && cargo test` |
| **跨模块 E2E** | pytest + httpx | 32 | `uv run --directory packages/agent pytest tests/ -v` |

### 4.2. 4.2 测试目录命名约定

测试目录按 **测试模式** 命名，而非按功能模块：

| 目录 | 模式 | 外部依赖 | 适用场景 |
|------|------|----------|----------|
| `e2e/mock/` | 🔶 Mock | 无 | 快速验证 UI 渲染、交互逻辑 |
| `e2e/real/` | 🔵 Real | Docker Compose 全栈 | 端到端流程、视觉回归 |

> 视觉回归基线（`*-snapshots/`）直接 git 追踪，`--update-snapshots` 更新后 commit。失败测试产物在 `test-results/`（gitignored）。
| `tests/unit/` | ⚪ Unit | 无 | 纯逻辑、算法、组件渲染 |
| `tests/integration/` | 🔵 Real | 对应后端服务 | 跨模块通信、真实数据库 |

规则：
- **Mock 测试**：不依赖外部服务，所有 API 通过 `page.route()` 或 Mock 对象拦截
- **Real 测试**：依赖真实后端（Docker Compose），自动通过 `skipif` 检测可达性
- **不混放**：同一目录下不应同时有 Mock 和 Real 测试（`e2e/` 拆分 mock/ 和 real/ 即为此目的）

**总计：756+ 个测试**

### 4.3. 4.2 运行测试

```bash
# 全部模块单元测试
mise run validate

# 全部测试（含集成 + E2E）
mise run validate:full

# 各模块单独运行
cd packages/ui && pnpm vitest run --reporter=verbose
cd packages/agent && uv run pytest tests/ -v
cd packages/runtime && cargo test
cd packages/control-plane && mvn test
```

### 4.4. 4.3 CP 集成测试模式

CP 集成测试支持两种模式：

- **本地开发**（默认）：`AbstractH2Test` + H2 内存数据库，零配置，无需 Docker
- **Docker 环境**：`AbstractIntegrationTest` + Testcontainers + PostgreSQL 17

### 4.5. 4.4 跨模块 E2E 测试

```bash
# 确保 Docker Compose 运行中
docker compose up -d

# 跨模块测试（Agent 内运行）
cd packages/agent
uv run --with httpx pytest tests/ -v -m integration

# 包含:
# - test_e2e_stack.py: 健康检查 / 认证链路 / 聊天流 / 模块通信 (16 tests)
# - test_mcp_chain.py: CP→Runtime MCP 代理链路 (8 tests)
# - test_full_chat_flow.py: 注册→登录→聊天→SSE (6 tests)
```

### 4.6. 4.5 MSW Mock 测试（UI）

UI 的 API 集成测试使用 MSW（Mock Service Worker）拦截 HTTP 请求。handlers 在 `packages/ui/src/mocks/handlers.ts` 中定义，覆盖认证/会话/健康检查等场景。MSW 不拦截 EventSource（SSE），SSE 测试通过 fetch-based 验证。

## 5. 部署

### 5.1. 5.1 Docker Compose（推荐）

```bash
# 构建并启动全部 4 个服务
docker compose up -d --build

# 查看状态
docker compose ps

# 查看日志
docker compose logs -f control-plane
```

服务端口（Docker 内部 / 宿主机映射）：
- CP: 8080 → 12631
- Agent: 8000 → 12632
- Runtime: 8001 → 12633
- PostgreSQL: 5432 → 12634

### 5.2. 5.2 GraalVM Native Image (CP)

```bash
cd packages/control-plane
mvn -Pnative native:compile
./target/control-plane
```

## 6. 调试

### 6.1. 6.1 CP 日志

日常 host 开发（`mise run dev:host` / `mise run dev:host:watch`）下，日志约定为：

- `logs/cp.log`
- `logs/agent.log`
- `logs/runtime.log.<YYYY-MM-DD>`（Runtime 按日滚动）
- `logs/ui.log`
- `logs/host.log`（host watcher 自身日志）

UI host 任务通过 `scripts/dev-ui-host.mjs` 将 Vite stdout/stderr 同时写入 `logs/ui.log`；Runtime 的每日文件名带日期后缀。若使用旧的根目录 `task *:dev`，也会写入 `logs/<module>.log`，但日常 host 开发以 `dev:host` 为准。

日志等级也建议统一从根 `.env` 配：

- `XIHE_LOG_LEVEL`：四个模块共享的默认等级
- `XIHE_LOG_LEVEL_UI`
- `XIHE_LOG_LEVEL_AGENT`
- `XIHE_LOG_LEVEL_CP`
- `XIHE_LOG_LEVEL_RUNTIME`

优先级从高到低如下：

1. `XIHE_RUNTIME_LOG_FILTER`
2. 模块统一变量：`XIHE_LOG_LEVEL_UI`、`XIHE_LOG_LEVEL_AGENT`、`XIHE_LOG_LEVEL_CP`、`XIHE_LOG_LEVEL_RUNTIME`
3. 全局统一变量：`XIHE_LOG_LEVEL`

注意：Vite dev server 只支持 `info | warn | error | silent`；
如果你给 UI 配了 `debug` 或 `trace`，会自动回落到 `info`。

项目级环境变量统一以 `XIHE_` 为前缀，例如：`XIHE_CP_PORT`、
`XIHE_AGENT_PORT`、`XIHE_RUNTIME_PORT`、`XIHE_UI_PORT`、
`XIHE_LLM_PROVIDER`、`XIHE_DEEPSEEK_API_KEY`。

如果要更换目录，在根 `.env` 里设置 `XIHE_LOG_DIR`；只有在你明确设置 `XIHE_LOG_TO_FILE=0` 时，才会关闭文件日志。

需要清空文件日志时：

```bash
mise run clean
```

下面这些命令主要用于提升单模块的日志详细程度，而不是开启落盘本身。

```bash
# 启用调试日志
cd packages/control-plane && XIHE_LOG_LEVEL_CP=DEBUG mvn spring-boot:run
```

### 6.2. 6.2 Runtime 日志

```bash
XIHE_RUNTIME_LOG_FILTER=xihe_runtime=debug,rmcp=info cargo run
```

### 6.3. 6.3 Agent 日志

Agent 使用 `langchain-litellm`（`ChatLiteLLM(BaseChatModel)`）作为统一的 LLM 后端，底层由 `litellm` 自动路由到 100+ Provider。Provider 切换只需在 UI 设置页或环境变量中指定：

```bash
XIHE_LLM_PROVIDER=deepseek \
XIHE_DEEPSEEK_API_KEY=your-deepseek-api-key-here \
uv run python -m xihe_agent.main
# 直接启动时日志输出到终端；host 启动时还会默认写入 logs/agent.log
```

或通过设置页添加 Provider：OpenAI、DeepSeek、小米 MiMo、Anthropic 预设 + 自定义。

## 7. 相关文档

- [DEV-001 系统架构](DEV-001-system-architecture.md)
- [USER-001 用户指南](USER-001-user-guide.md)
