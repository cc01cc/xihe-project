---
title: DEV-002 - Developer Setup and Guide
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 2
status: active
created: 2026-05-28
updated: 2026-06-15
---

# Developer Guide — xihe Agent Platform

## 1. Project Structure

```text
xihe/
├── packages/
│   ├── ui/                    # Vue 3 + Vite + Tailwind CSS + reka-ui
│   │   ├── src/
│   │   │   ├── components/    # Sidebar / Chat / Multimodal / Settings
│   │   │   ├── composables/   # SSE / Theme / API / LangChain adapter
│   │   │   ├── stores/        # Pinia: session / chat / settings / agent
│   │   │   ├── views/         # Settings pages
│   │   │   ├── router/        # Vue Router
│   │   │   ├── i18n/          # Internationalization (zh-Hans / en)
│   │   │   ├── styles/        # HSL CSS variables / Tailwind v4
│   │   │   ├── mocks/         # MSW test mocks
│   │   │   └── types/         # TypeScript type definitions
│   │   ├── e2e/               # Playwright E2E tests
│   │   └── vitest.config.ts
│   ├── control-plane/         # Java + Spring Boot 4 + GraalVM
│   │   └── src/
│   │       ├── main/java/.../cp/
│   │       │   ├── auth/      # JWT authentication (login/register/refresh)
│   │       │   ├── chat/      # SSE streaming chat
│   │       │   ├── config/    # Security / Jackson / TenantContext
│   │       │   ├── entity/    # JPA entities (9)
│   │       │   ├── repository/# JPA repositories (8)
│   │       │   ├── mcp/       # MCP reverse proxy
│   │       │   └── audit/     # Audit logging
│   │       └── resources/
│   │           └── db/migration/  # Flyway migrations
│   ├── agent/                 # Python + LangChain + LangGraph
│   │   └── src/xihe_agent/
│   │       ├── adapters/      # SSE adapter / MCP client / approval tools
│   │       ├── agent/         # Executor / Prompts
│       │       └── llm/           # LLM abstraction (ChatLiteLLM wrapper, 100+ Providers)
│   └── runtime/               # Rust + rmcp + Tokio + Axum
│       └── src/
│           ├── main.rs        # MCP Server (8 tools)
│           ├── fs.rs          # File operations (ignore/walkdir/globset)
│           ├── sandbox.rs     # Docker sandbox (bollard)
│           └── error.rs       # Error types
├── docs/
│   └── i18n/
│       └── en/
│           ├── DEV-001-system-architecture.md
│           ├── DEV-002-developer-guide.md
│           ├── DEV-003-logging.md
│           ├── DEV-004-ui-checklist.md
│           ├── DEV-005-mcp-architecture.md
│           ├── DEV-010-documentation-layout-and-frontmatter.md
│           └── USER-001-user-guide.md
├── internal/
│   └── SPRINTS/                      # Sprint design documents
├── scripts/                          # Development helper scripts
├── postgres-init/                    # Docker PostgreSQL initialization
└── docker/                           # Container image builds
    └── images/workspace/             # xihe/workspace container image
```

## 2. Development Environment

### 2.1. Prerequisites

Using `mise` in the root directory is recommended for toolchain management and cross-module commands:

```bash
mise install
```

If the current shell hasn't executed `mise activate`, root tasks are recommended to use `mise run ...` format. `task` / `Taskfile.yml` have been removed (PLAN-245 M5); `mise run ...` is the only entry point.

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

### 2.2. Install Dependencies

Running directly from the root directory is recommended:

```bash
mise run setup
cp .env.example .env.dev
```

The root directory now uses `XIHE_ENV` to select environment files:

- `XIHE_ENV=dev`: Sequentially loads `.env`, `.env.dev`, `.env.local`, `.env.dev.local`
- `XIHE_ENV=test`: Sequentially loads `.env`, `.env.test`, `.env.local`, `.env.test.local`
- `XIHE_ENV_FILE=/path/to/file`: Explicitly specify a single env file

`mise run dev:*` uses `XIHE_ENV=dev` by default.
If the merged result of these files contains `XIHE_DEEPSEEK_API_KEY` and `XIHE_LLM_PROVIDER` is not explicitly set, the Agent automatically switches to `deepseek`; if no key is present, falls back to `mock`.

Equivalent module-level commands:

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

### 2.3. Root Directory Tasks

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

If you prefer not to use root tasks, you can enter the module directory and execute manually; however, the root `.env` and corresponding profile env files will not be automatically loaded — you need to export environment variables yourself.

The root directory no longer uses pnpm workspace. UI still uses pnpm, but manages dependencies and lock files only within `packages/ui/`. Since the current repository is located within the outer `one` workspace, running pnpm commands directly under `packages/ui/` requires `--ignore-workspace`, or you can use root `mise run *` tasks directly.

### 2.4. Runtime Modes

CP (Control Plane) supports two runtime modes:

#### Mode A: Docker Compose Full Stack (Recommended for Integration Tests)

```bash
docker compose up -d --build
```

Starts all 4 services: `postgres` + `control-plane` + `agent` + `runtime`.

CP connects to `postgres:5432` via Docker internal network `xihe-net`. PostgreSQL username/password is defined by `POSTGRES_USER` / `POSTGRES_PASSWORD` in `docker-compose.yml`.

Verification:

```bash
curl -s http://localhost:12631/actuator/health    # Expected: {"status":"UP"} (inside Docker: :8080)
curl -s http://localhost:12633/health              # Expected: OK (inside Docker: :8001)
```

#### Mode B: Host Development (CP runs on host, for unit tests)

```powershell
# Option B1: H2 in-memory database (no external DB required; PowerShell example)
$env:XIHE_CP_DATASOURCE_URL = 'jdbc:h2:mem:xihe;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1'
$env:XIHE_CP_DATASOURCE_DRIVER = 'org.h2.Driver'
$env:XIHE_CP_DATASOURCE_USERNAME = 'sa'
$env:XIHE_CP_DATASOURCE_PASSWORD = ''
$env:XIHE_CP_JPA_DIALECT = 'org.hibernate.dialect.H2Dialect'
$env:SPRING_FLYWAY_ENABLED = 'false'
$env:SPRING_JPA_HIBERNATE_DDL_AUTO = 'create-drop'

mvn -f packages/control-plane/pom.xml spring-boot:run

# Option B2: PostgreSQL container (requires Docker running first)
docker compose up -d postgres
mvn spring-boot:run -f packages/control-plane/pom.xml
```

**Note**: Under WSL2 mirror network mode, host connections to Docker PostgreSQL may fail password authentication. This is because the `bridge` network's port mapping causes NAT translation of the connection source address, and the `127.0.0.1/32 trust` rule in `pg_hba.conf` doesn't match. If you encounter this issue, use **Option B1 (H2)** or **Mode A (Full Docker Compose)**.

`.env.dev` file records two database configurations (PostgreSQL is default, H2 is commented out). Uncomment to switch.

### 2.5. Configuration Management (PLAN-042)

#### Architecture Overview

CP ConfigService is the unified configuration management entry point, using a two-layer model:

| Layer | Purpose | Modification Method |
|-------|---------|---------------------|
| **Environment Variables** | Pre-runtime fixed (port/DB/JWT) | `.env.dev` (gitignore) |
| **ConfigService** | Runtime modifiable (API key/model/logging) | UI Settings / `PUT /config/admin/{domain}` / `POST /config/import` |

**Priority**: ConfigService values override environment variable keys with the same name.

**Phase 3 Changes**:
- `XIHE_LOAD_DOTENV=0` — Modules no longer read application-layer configuration from `.env`/`.env.dev`
- All application-layer configuration (LLM provider, API key, model, log level, embedding, etc.) managed through CP ConfigService
- Only bootstrap variables retained for infrastructure startup (`XIHE_CP_URL`, `XIHE_CP_API_TOKEN`, `XIHE_RUNTIME_HOST/PORT`, `XIHE_DATASOURCE_*`, etc.)

#### Configuration Methods

**Method A: CP API** (runtime modification, takes effect immediately)

```bash
# Set admin-level configuration
curl -X PUT http://localhost:8080/config/admin/llm-provider \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"deepseekApiKey": "sk-xxx", "defaultProvider": "deepseek"}'

# Read current effective configuration
curl http://localhost:8080/config/llm-provider \
  -H "Authorization: Bearer $TOKEN"
```

**Method B: JSONC Import** (batch initialization, recommended for dev startup)

```bash
# Import configuration to admin layer (canonical path: /api/v1/config/import)
curl -X POST http://localhost:12631/api/v1/config/import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d @config.import.local.jsonc
```

`mise run dev:full` does **not** auto-import by default: `DataSeeder` generates a random admin password that is never printed, so the script cannot log in. After CP is ready, run `mise run reset-admin` to obtain the password and import manually, or set `XIHE_DEV_ADMIN_PASSWORD` (OS env only; never commit to scripts/git/logs) to enable automatic import.

JSONC supports comments and trailing commas; you can directly copy MCP configuration snippets from Claude Desktop / Cursor.

#### Development Workflow

1. **`cp config.import.example.jsonc config.import.local.jsonc`** — Fill in API keys (PowerShell: `Copy-Item`)
2. **`mise run dev:full`** — Docker Compose startup; import `config.import.local.jsonc` manually after CP is ready (see above)
3. **Runtime debugging** — `PUT /api/v1/config/admin/{domain}` or UI settings page modification, takes effect immediately

#### Configuration Clients

Each module accesses CP ConfigService through local clients:

| Module | Client File | Behavior |
|--------|-------------|----------|
| **Control Plane** | `ConfigService.java` | Built-in `@Service`, exposes CRUD API externally, PG persistence |
| **Agent** | `xihe_agent/config_client.py` | Fetches admin+system cache at startup, provides `get(key, default)` interface |
| **Runtime** | `src/config_client.rs` | Fetches and periodically refreshes at startup, provides `get(key)` interface |

### 2.6. Integration Tests

Agent integration tests (`packages/agent/tests/test_agent_cp_integration.py`) require CP running at `localhost:8080`.

```bash
# Method 1: Docker Compose (recommended)
docker compose up -d --build
cd packages/agent && uv run pytest tests/test_agent_cp_integration.py -v

# Method 2: Host H2 mode
XIHE_CP_DATASOURCE_URL="jdbc:h2:mem:xihe;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE" \
XIHE_CP_DATASOURCE_DRIVER="org.h2.Driver" \
XIHE_CP_DATASOURCE_USERNAME="sa" \
XIHE_CP_DATASOURCE_PASSWORD="" \
mvn spring-boot:run -q -f packages/control-plane/pom.xml &
sleep 12
cd packages/agent && uv run pytest tests/test_agent_cp_integration.py -v
```

Test files include `@pytest.mark.skipif` for automatic detection; when CP is unreachable, tests are silently skipped.

## 3. Architecture Design

### 3.1. Communication Protocol

- UI ↔ CP: HTTP + SSE, for chat message streaming
- Agent ↔ CP: HTTP + SSE, for Agent streaming responses
- CP ↔ Runtime: MCP (Streamable HTTP), for tool invocation

### 3.2. MCP Reverse Proxy

CP acts as an HTTP reverse proxy without depending on any MCP SDK:

```text
Agent → POST /mcp → CP (JSON parsing + permission check + request rewriting) → Runtime
```

See `internal/SPRINTS/SPRINT-001-cs-agent-mvp/DESIGN-007-mcp-gateway-reverse-proxy.md`

### 3.3. Tool Name Namespace

CP adds prefix during tools/list and removes prefix during tools/call:

- Runtime returns: `read_file`
- CP returns to Agent: `runtime__read_file`
- Agent calls: `runtime__read_file`
- CP removes prefix and forwards: `read_file` → Runtime

See `internal/SPRINTS/SPRINT-001-cs-agent-mvp/DESIGN-009-tool-namespace.md`

### 3.4. SSE Event Protocol

UI ↔ CP communicates through SSE with 7 event types:

| Event | Direction | Description |
|-------|-----------|-------------|
| `token` | CP→UI | LLM output token |
| `tool_call` | CP→UI | Tool execution started |
| `tool_result` | CP→UI | Tool execution result |
| `approval_request` | CP→UI | Request user confirmation |
| `status` | CP→UI | Agent status change |
| `error` | CP→UI | Error message |
| `done` | CP→UI | Completion (with token statistics) |

LangChain events are automatically mapped through the SSE adapter layer (`packages/agent/src/xihe_agent/adapters/sse_adapter.py`).

## 4. Testing

### 4.1. Test Landscape

| Module | Framework | Test Count | Run Command |
|--------|-----------|------------|-------------|
| **UI Unit** | Vitest + @vue/test-utils | 206 | `cd packages/ui && pnpm vitest run` |
| **UI E2E (Mock)** | Playwright + page.route() | 40 | `cd packages/ui && npx playwright test e2e/mock/` |
| **UI E2E (Real)** | Playwright + real CP | 32 | `cd packages/ui && npx playwright test e2e/real/` (requires Docker Compose) |
| **CP** | JUnit 5 + Mockito + Testcontainers | 152 | `cd packages/control-plane && mvn test` |
| **Agent Unit** | pytest + pytest-asyncio | 150 | `cd packages/agent && uv run pytest tests/unit/ -v` |
| **Agent Integration** | pytest + httpx | — | `cd packages/agent && uv run pytest tests/integration/ -v` (requires Docker Compose) |
| **Runtime** | cargo test | 176 | `cd packages/runtime && cargo test` |
| **Cross-module E2E** | pytest + httpx | 32 | `uv run --directory packages/agent pytest tests/ -v` |

### 4.2. Test Directory Naming Convention

Test directories are named by **test pattern**, not by functional module:

| Directory | Pattern | External Dependencies | Use Case |
|-----------|---------|----------------------|----------|
| `e2e/mock/` | 🔶 Mock | None | Quick verification of UI rendering and interaction logic |
| `e2e/real/` | 🔵 Real | Docker Compose full stack | End-to-end flows, visual regression |

> Visual regression baselines (`*-snapshots/`) are tracked directly by git, updated via `--update-snapshots` and committed. Failed test artifacts are in `test-results/` (gitignored).
| `tests/unit/` | ⚪ Unit | None | Pure logic, algorithms, component rendering |
| `tests/integration/` | 🔵 Real | Corresponding backend services | Cross-module communication, real database |

Rules:
- **Mock Tests**: Do not depend on external services; all APIs intercepted via `page.route()` or Mock objects
- **Real Tests**: Depend on real backend (Docker Compose); automatically checked for reachability via `skipif`
- **No Mixed Placement**: Same directory should not contain both Mock and Real tests (`e2e/` split into mock/ and real/ for this purpose)

**Total: 756+ tests**

### 4.3. Running Tests

```bash
# All module unit tests
mise run validate

# All tests (including integration + E2E)
mise run validate:full

# Individual module runs
cd packages/ui && pnpm vitest run --reporter=verbose
cd packages/agent && uv run pytest tests/ -v
cd packages/runtime && cargo test
cd packages/control-plane && mvn test
```

### 4.4. CP Integration Test Modes

CP integration tests support two modes:

- **Local Development** (default): `AbstractH2Test` + H2 in-memory database, zero configuration, no Docker needed
- **Docker Environment**: `AbstractIntegrationTest` + Testcontainers + PostgreSQL 17

### 4.5. Cross-module E2E Tests

```bash
# Ensure Docker Compose is running
docker compose up -d

# Cross-module tests (run within Agent)
cd packages/agent
uv run --with httpx pytest tests/ -v -m integration

# Includes:
# - test_e2e_stack.py: Health check / auth chain / chat flow / module communication (16 tests)
# - test_mcp_chain.py: CP→Runtime MCP proxy chain (8 tests)
# - test_full_chat_flow.py: Register → login → chat → SSE (6 tests)
```

### 4.6. MSW Mock Tests (UI)

UI API integration tests use MSW (Mock Service Worker) to intercept HTTP requests. Handlers are defined in `packages/ui/src/mocks/handlers.ts`, covering auth/session/health check scenarios. MSW does not intercept EventSource (SSE); SSE tests are verified through fetch-based approach.

## 5. Deployment

### 5.1. Docker Compose (Recommended)

```bash
# Build and start all 4 services
docker compose up -d --build

# Check status
docker compose ps

# View logs
docker compose logs -f control-plane
```

Service ports (Docker internal / host mapping):
- CP: 8080 → 12631
- Agent: 8000 → 12632
- Runtime: 8001 → 12633
- PostgreSQL: 5432 → 12634

### 5.2. GraalVM Native Image (CP)

```bash
cd packages/control-plane
mvn -Pnative native:compile
./target/control-plane
```

## 6. Debugging

### 6.1. CP Logs

By default, each `mise run dev:*` task in the root directory writes process logs to `logs/<module>.log`. The four default file names are:

- `logs/ui.log`
- `logs/agent.log`
- `logs/cp.log`
- `logs/runtime.log`

Log levels are also recommended to be configured from the root `.env`:

- `XIHE_LOG_LEVEL`: Default level shared by all four modules
- `XIHE_LOG_LEVEL_UI`
- `XIHE_LOG_LEVEL_AGENT`
- `XIHE_LOG_LEVEL_CP`
- `XIHE_LOG_LEVEL_RUNTIME`

Priority from highest to lowest:

1. `XIHE_RUNTIME_LOG_FILTER`
2. Module-specific variable: `XIHE_LOG_LEVEL_UI`, `XIHE_LOG_LEVEL_AGENT`, `XIHE_LOG_LEVEL_CP`, `XIHE_LOG_LEVEL_RUNTIME`
3. Global variable: `XIHE_LOG_LEVEL`

Note: Vite dev server only supports `info | warn | error | silent`; if you configure `debug` or `trace` for UI, it will automatically fall back to `info`.

Project-level environment variables use the `XIHE_` prefix, e.g.: `XIHE_CP_PORT`, `XIHE_AGENT_PORT`, `XIHE_RUNTIME_PORT`, `XIHE_UI_PORT`, `XIHE_LLM_PROVIDER`, `XIHE_DEEPSEEK_API_KEY`.

To change the directory, set `XIHE_LOG_DIR` in root `.env`; file logging is only disabled when you explicitly set `XIHE_LOG_TO_FILE=0`.

To clear file logs:

```bash
mise run clean
```

The following commands are mainly for increasing single-module log verbosity, not for enabling file logging itself.

```bash
# Enable debug logging
cd packages/control-plane && XIHE_LOG_LEVEL_CP=DEBUG mvn spring-boot:run
```

### 6.2. Runtime Logs

```bash
XIHE_RUNTIME_LOG_FILTER=xihe_runtime=debug,rmcp=info cargo run
```

### 6.3. Agent Logs

Agent uses `langchain-litellm` (`ChatLiteLLM(BaseChatModel)`) as the unified LLM backend, with `litellm` automatically routing to 100+ Providers at the bottom layer. Provider switching only requires specifying in the UI settings page or environment variables:

```bash
XIHE_LLM_PROVIDER=deepseek \
XIHE_DEEPSEEK_API_KEY=your-deepseek-api-key-here \
uv run python -m xihe_agent.main
# When started directly, logs output to terminal; when started via root task, also writes to logs/agent.log by default
```

Or add Providers through the settings page: OpenAI, DeepSeek, Xiaomi MiMo, Anthropic presets + custom.

## 7. Related Documents

- [DEV-001 System Architecture](DEV-001-system-architecture.md)
- [USER-001 User Guide](USER-001-user-guide.md)
