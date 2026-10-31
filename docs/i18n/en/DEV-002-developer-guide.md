---
title: DEV-002 - Developer Setup and Guide
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 2
status: active
created: 2026-05-28
updated: 2026-10-25
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
│           ├── DEV-004-logging.md
│           ├── DEV-011-ui-checklist.md
│           ├── DEV-016-mcp-architecture.md
│           ├── DEV-020-e2e-test-strategy.md
│           ├── DEV-021-integration-test-strategy.md
│           ├── DEV-022-unit-test-strategy.md
│           ├── DEV-030-documentation-layout-and-frontmatter.md
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
rustc --version  # 1.97.1+
cargo --version  # 1.97.1+
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
cd packages/ui && pnpm install

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

# [FROZEN 2026-10-07 — do not run; use dev:host for daily development]
mise run test:e2e:compose
mise run validate:full
```

If you prefer not to use root tasks, you can enter the module directory and execute manually; however, the root `.env` and corresponding profile env files will not be automatically loaded — you need to export environment variables yourself.

The root directory no longer uses pnpm workspace. `packages/ui/` is itself the pnpm root: it owns `pnpm-workspace.yaml`, the pnpm security policies (cooldown, build-script whitelist, overrides, patches) and the single lock file. Because it is a workspace root, pnpm commands run under `packages/ui/` must NOT pass `--ignore-workspace` — that flag is install-only and does not apply to `run`, and it would skip the package's own workspace policy. You can also use the root `mise run *` tasks, which are already wired to the UI root.

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

#### Parallel host stacks (PLAN-0533)

`XIHE_STACK_ID` (`stack-1`..`stack-8`, default `stack-1`) selects a stack. The launcher derives ports, compose project, PG database, sandbox container prefix and the log/host-root/state dirs; modules only read the derived `XIHE_*_PORT` env. **Every 1263X port elsewhere in this guide is the stack-1 default.**

```bash
mise run dev:stack -- --stack 2                    # or: XIHE_STACK_ID=stack-2 mise run dev:host
node ../scripts/ports.mjs plan xihe --stack 2      # show that stack's ports without starting
```

| Stack | UI | CP | Agent | Runtime | PG | compose project |
|---|---|---|---|---|---|---|
| stack-1 (default) | 12630 | 12631 | 12632 | 12633 | 12634 | `a03-xihe` |
| stack-2 | 12640 | 12641 | 12642 | 12643 | 12644 | `xihe-stack-2` |
| stack-3 / 4 | 12650 / 12660 blocks | … | … | … | … | `xihe-stack-3/4` |
| stack-5..8 | 12700 / 12710 / 12730 / 12740 blocks | … | … | … | … | `xihe-stack-5..8` |

- stack-1 keeps the legacy paths (`.xihe-workspaces`, `logs`, `.xihe-state`); stack≥2 uses `.xihe-stacks/<n>/{workspaces,logs,state}` (gitignored).
- Unregistered ids (`stack-9`, `foo`) fail fast instead of falling back to stack-1.
- `dev:host:stop` / `dev:reset` only touch the current stack (label `xihe.stack-id`; a missing label means stack-1).
- Two concurrent stacks at most are recommended.

#### Detached full-stack supervisor (PLAN-0603)

`mise run dev:host` is a **foreground** mise task: when the terminal / agent turn exits, its child tree is reaped. `node ../scripts/ports.mjs dev xihe` is already detached, but it only starts services that declare a `runner` (xihe: UI only) and always uses the main checkout as cwd. For "survives the turn + four services ready", use the repo supervisor (commands/cwd/stack env are reused from `scripts/stack-run.mjs`):

```bash
# Run from the A03 checkout root; works in the main checkout and in .worktrees/<name>
node scripts/dev-stack.mjs start --stack 4 --with-pg
mise run dev:stack -- --stack 4 --with-pg        # equivalent entry (forwards args)
node scripts/dev-stack.mjs status --stack 4
node scripts/dev-stack.mjs stop --stack 4                 # keeps PostgreSQL by default
node scripts/dev-stack.mjs stop --stack 4 --with-pg       # explicitly stop the PG container (volume kept)
```

- Services: CP / Agent / Runtime / UI; `start` waits for HTTP readiness (default 300s, `--timeout`) and exits 2 on timeout, pointing at `.xihe-stacks/<n>/logs/*.err.log`.
- Logs/PIDs: `.xihe-stacks/<n>/logs/<svc>.{out,err}.log` and `dev-stack-pids.json`; `--json` for machine-readable output.
- `node ../scripts/ports.mjs dev xihe --stack N` delegates to this supervisor; **`--next` is not supported for xihe** (use `--stack`).
- **Parallel worktrees must use different stacks** (the same stack shares the PG database `xihe_<n>`); first run in a worktree needs `pnpm install --offline` for `packages/ui`, and it is recommended to `. ../scripts/worktree-env.ps1 -Worktree <worktree>` first to externalize `CARGO_TARGET_DIR` / `UV_PROJECT_ENVIRONMENT`.
- `stop` only kills process trees recorded in the PID file whose command line matches `stack-run.mjs`; it never kills by port blindly.

#### Rust build cache and worktree isolation (PLAN-0596)

- **Default: one `CARGO_TARGET_DIR` per worktree.** `. ../scripts/worktree-env.ps1 -Worktree <name>` externalizes it under `one/.local/cargo-target/<name>` (and `UV_PROJECT_ENVIRONMENT` under `one/.local/venvs/<name>`). Do not point several worktrees at the same target: concurrent builds serialize on the target lock, and on Windows a running service holds the exe, so the other worktree's build fails.
- **Measured (2026-10-31 scratch):** two checkouts with identical source/profile shared one target: second cold build 48.9s → **0.3s**, disk 2×2.606GB → **2.606GB**. The benefit only applies when source/toolchain/profile match; real parallel branches differ, so the default stays isolated (user acceptance would be required to change it).
- **Sweep scope:** `mise run clean:runtime-sweep` only touches the single target resolved by the current `cargo metadata` (in-tree in a plain shell, the external dir after dot-sourcing `worktree-env.ps1`); it never scans other projects under `.local/cargo-target`. `--maxsize 12GB` is interpreted as MiB (≈11.18 GiB).
- **Permanent delete:** `mise run clean` runs `rm -rf logs packages/*/target packages/*/dist packages/*/coverage` with **no recycle bin and no prompt**; stop builds/services and confirm those are rebuildable artifacts first. Treat caches as "delete and rebuild", not cross-drive backup.

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
# Set admin-level configuration (PLAN-0504: the default identity is the whole profile unit)
curl -X PUT http://localhost:8080/config/admin/llm-provider \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"profile": {"providerId": "deepseek", "connectionKey": "default", "model": "deepseek-chat"}}'

# Read current effective configuration
curl http://localhost:8080/config/llm-provider \
  -H "Authorization: Bearer $TOKEN"
```

Provider API keys are not ConfigService values. Manage them through the Provider Connection commands below; `config import` accepts non-secret settings only.

**Method B: Explicit JSONC Import** (for non-secret settings)

```bash
# Import configuration to admin layer (canonical path: /api/v1/config/import)
curl -X POST http://localhost:12631/api/v1/config/import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d @config.import.local.jsonc
```

`mise run dev:host` does **not** import config or create/update Provider Connections. After CP is ready, explicitly run `mise run dev:host:import-config` (or `mise run xihe -- config import <file>`) for non-secret JSONC settings. The one-off `mise run dev:full` Compose script **is frozen (2026-10-07: only PostgreSQL remains in Docker; services run on host) and commented out in mise.toml**; it retains its separate legacy, environment-triggered import behavior for historical reference only. The freeze covers service containerization and image builds only; workspace execution backends are unchanged: `managed_import` still allows `docker` only, and `direct_attach` still allows `windows-mxc`/`windows-host` (see DEV-031).

JSONC supports comments and trailing commas; you can directly copy MCP configuration snippets from Claude Desktop / Cursor.

#### Development Workflow

1. **`cp config.import.example.jsonc config.import.local.jsonc`** — Fill in non-secret settings only (PowerShell: `Copy-Item`); API keys belong in Provider Connections, not JSONC.
2. **`mise run dev:host`** — Start the daily host stack; config import remains separate.
3. **`mise run dev:host:import-config`** — Explicitly import local non-secret config after CP is ready.
4. **`mise run dev:host:provider-init -- --provider xiaomi --scope USER --label xh-local --api-key-env XIHE_XIAOMI_API_KEY`** — Create or reuse and verify a local provider connection.
5. **`mise run test:e2e:host:real -- e2e/real/real-tool-roundtrip.spec.ts --route openai-compat`** — Run one real MiMo host test; requires `XIHE_E2E_REAL_XIAOMI_KEY`.

**Host-stack bootstrap and scripted-path notes (2026-10-18):**

- **`mise run dev:host` does not load `.env.dev`**: the internal service token must be injected or it falls back to the dev placeholder. Either use `scripts/dev-host.ps1 -Start` (it generates the internal token) or inject the env explicitly; when invoked without a TTY, that script's `Start-Process` makes the caller hang on inherited handles (the services do start) — for automation, launch each service as a tracked background process and probe readiness on ports 12631/12632/12633. Module auth and keys: see [DEV-024](DEV-024-authentication-matrix.md).
- **LLM readiness prerequisite**: without an imported `llm-provider` profile the Agent reports `llmReady=missing_credentials` and `POST /api/v1/chat` returns 503 `LLM_NOT_CONFIGURED`; `POST /api/v1/config/import?layer=instance` accepts **plain JSON only** (strip the line comments from `config.import.local.jsonc`, or just use the CLI above).
- **Scripted path, three points**: a new session already owns a root branch (`POST /sessions/{id}/branches` is fork semantics requiring `sourceBranchId` + `anchorMessageId` — reuse the root branch instead); `POST /api/v1/chat` requires an active SSE subscription for the session first (otherwise 409 `SSE_SUBSCRIPTION_REQUIRED`); Bearer tokens live only 900s, so keep the `reset-admin` → `login` token in a temp file and refresh it per batch (never in the repo).

The CLI is an operator entry point. It calls CP's authenticated HTTP API for Provider Connections; Agent execution continues to use its own lease/protocol path. The real E2E key is injected directly into the isolated Agent process and does not test a Provider Connection lease.

`--api-key-env` reads a variable already present in the CLI process. An interactive terminal prompts without echo when needed; non-interactive tasks must inject the environment variable. The CLI does not read `.env.local` itself.

`real-tool-roundtrip` may send up to two model prompts and can incur provider charges. Playwright retries are disabled for this command; decide manually whether to rerun after a failure.

6. **Runtime debugging** — `PUT /api/v1/config/admin/{domain}` or UI settings page modification, takes effect immediately

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

# Method 2: Host stack
# Use the tracked orchestrator; it owns the process lifecycle and readiness checks.
mise run dev:host

# In a separate terminal, probe CP before running Agent tests. The bounded health
# probe is a prerequisite and reports failure instead of silently skipping tests.
curl --fail-with-body --silent --show-error --max-time 5 http://localhost:12631/actuator/health
cd packages/agent && uv run pytest tests/test_agent_cp_integration.py -v
```

Test files may use `@pytest.mark.skipif` only for explicitly optional tests; an unreachable CP is otherwise an explicit test/setup failure. Do not use fixed sleeps, bare background shell operators, or untracked processes; use the tracked process/readiness/health probe with a bounded timeout.

## 3. Architecture Design

### 3.1. Communication Protocol

- UI ↔ CP: HTTP + SSE, for chat message streaming
- Agent ↔ CP: HTTP + SSE, for Agent streaming responses
- CP ↔ Runtime: a per-request Runtime executor boundary for tool invocation; the tracked executor owns process readiness and health probing.

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
- **Real Tests**: Depend on the declared real backend; readiness is checked before the test with a bounded probe, and unreachable required dependencies fail the test rather than being skipped
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

The UI `pnpm run lint` gate runs `oxfmt --check .` followed by `oxlint .`. Oxlint enables the `typescript`, `import`, `unicorn`, and `oxc` plugins; the Vitest plugin is scoped to `src/**/__tests__/**`, `src/**/*.spec.ts`, and `src/**/*.test.ts`, where `require-mock-type-parameters` and `require-to-throw-message` are blocking and other Vitest rules remain off. The Vue plugin and template lint are outside this gate; SFC/TypeScript type checking is handled by `pnpm run typecheck` (`vue-tsc --noEmit`). Vue template lint is a **known limitation** (only `<script>` is linted today): we wait for native oxlint support, tracking the oxc language-plugins umbrella #23207 / Phase-1 #24597 and the compatibility page; revisit when oxlint is upgraded or a real template structural defect (`v-for` missing key, duplicate attributes, etc.) appears; see PLAN-0479 decision #4. Oxfmt is pinned at 0.68.0; `.oxfmtrc.jsonc` explicitly sets `tabWidth: 4` and `printWidth: 100`, ignores Markdown and `AGENTS.md`, and leaves `proseWrap` unset to preserve the pre-config zero-drift behavior. Other style warnings remain visible but are not fatal, so a successful lint does not mean zero warnings. The full UI formatter migration completed in its dedicated wave (419 historical files normalized) and the format check is now wired into `lint`. CP's `mise run lint:cp` blocks **every** Checkstyle rule at error severity (baseline 0 violations after the rule/convention alignment wave; see PLAN-0458 evidence) — it must never be weakened back to warning or globally suppressed. Agent's `mise run lint:agent` runs mypy as a real blocking gate over `src/` (the global `ignore_errors` switch was removed; currently 0 errors) — type errors must be fixed, never masked by global or module-wide ignores (PLAN-0459).

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

### 4.7. One-shot stack verification (`mise run xihe -- verify`, PLAN-0574)

The manual v1 chain (login → session + root branch → SSE → model list → chat) also runs as one CLI command (implementation: `scripts/xihe-cli/verify.mjs`):

```bash
XIHE_VERIFY_PASSWORD=<admin password> mise run xihe -- verify \
  --stack 2 --email admin@xihe.local --workspace <wsId> --yes
```

- **Explicit target**: `--stack`, `--email` and `--workspace` are all required and missing values fail (exit 2). The CLI never falls back to the default workspace from the login response; `--yes` only confirms the execution prompt and never replaces a target flag. Without `--yes` a TTY confirmation is required.
- **Credentials**: the password comes from `XIHE_VERIFY_PASSWORD`, falling back to `XIHE_DEV_ADMIN_PASSWORD` (OS env > `.env` chain); a TTY prompt is used without echo. No password exits 2 and the token is never echoed. Generate a password with `mise run reset-admin`; it resolves the target stack as `-StackId` > `XIHE_STACK_ID` and the target database as `--url` > `XIHE_CP_DATASOURCE_URL` > `localhost:$XIHE_PG_PORT/$POSTGRES_DB` (default `12634/xihe_1`, matching the post-0533 `xihe_<n>` naming) and prints the target it used.
- **Stack derivation**: ports come from `node scripts/stack-run.mjs env-json --stack <id>`; an unknown stack exits 2.
- **Side effects**: creates an agent principal (when the workspace has none bound), a session and a chat run, and really calls the model provider, which may incur cost. Use an isolated stack and a test workspace, and confirm the prompt first.
- **Verdict and exit codes**: tier A (CP health / login / workspace access / principal / session + branch / messages / SSE / model list / agent health) must pass; tier B keeps the original `POST /api/v1/chat` acceptance semantics (200/202 with a `runId`). `0` = A/B passed and the run reached the `succeeded` terminal state, `4` = tier A passed but tier B precondition missing, `1` = failure (including a failed run terminal), `2` = missing target/credentials or stack derivation failure, `5` = run wait timeout (`--wait-seconds`, default 120; on timeout the CLI first calls `POST /api/v1/chat/runs/{runId}/cancel` and then deletes the session it created).
- **Cleanup and residue**: on completion or failure the CLI closes SSE first and then `DELETE /api/v1/sessions/{sessionId}` for the session it created. A principal created by this run has no confirmed delete API and is retained and reported (`cleanup.principal`); pre-existing principals are never modified or deleted. Audit and provider-side records may persist.
- **Agent principal**: creating a session requires `agentPrincipalId`. The CLI resolves it as explicit `XIHE_VERIFY_AGENT_PRINCIPAL_ID` → first principal already bound to the workspace → newly created one. It only calls `PUT …/agents/{id}` right after creating a principal — that call **narrows** the workspace cap of an existing principal. Diagnostics only print whitelisted status fields, never raw agent logs.
- **Template and connection binding (PLAN-0601)**: tier B requires the session to bind an explicitly published api-request-template triple plus a chat provider connection. The CLI resolves both automatically (`GET /api/v1/config/api-request-templates?layer=user|workspace|instance` for a published template matching the connection API type; `GET /api/v1/provider-connections` for a `status=READY` `operation=chat` connection) and sends `providerConnectionId` / `modelProvider` / `modelName` / `contextTemplateLayer|Id|Version` when creating the session. A missing template reports `VERIFY_TEMPLATE_MISSING`, a missing connection reports `VERIFY_CONNECTION_MISSING` (both exit 2 with actionable guidance) instead of failing with a bare `409 API_TYPE_REBIND_REQUIRED`. Publishing a template is an ADMIN instance-layer action (Settings → Configuration → API request templates → publish).

### 4.8. Operator CLI surface (PLAN-0574)

```bash
mise run xihe -- status                                              # /status + /health + /version aggregate
mise run xihe -- workspace list
mise run xihe -- workspace get <wsId>                                # includes environment
mise run xihe -- job list <wsId>
mise run xihe -- job output <wsId> <jobId> [--stream stdout|stderr] [--offset N] [--limit N]
mise run xihe -- job cancel <wsId> <jobId>                           # idempotent `changed:false` passthrough
mise run xihe -- checkpoint list <wsId>                              # includes retention (failures reported explicitly)
mise run xihe -- checkpoint preview-revert <wsId> <sliceRef>         # preview only, never reverts
mise run xihe -- scheduled-task list <wsId> [--page N] [--size N]
mise run xihe -- audit list [--type T] [--page N] [--size N]
mise run xihe -- config export [--include-secrets] [--out <file>] [--force]   # secrets off by default
mise run xihe -- provider delete <id> [--yes]                        # shows delete-impact first
mise run xihe -- version [--check]
```

- Every command supports `--json` (a single stdout object `{ok:true,data}` or `{ok:false,error:{code,message}}`); human output is a one-line/table summary. See `mise run xihe -- --help`.
- Stack port overrides (bootstrap allowlist): `node scripts/stack-run.mjs <cp|agent|runtime> --set XIHE_CP_PORT|XIHE_AGENT_PORT|XIHE_RUNTIME_PORT=<1..65535>` — the three allowlisted keys only, injected into the target that actually consumes the key; duplicates, unknown keys, secrets and invalid values are refused before any process starts, without echoing the input. When `XIHE_CP_URL` / `XIHE_AGENT_URL(_BASE_URL)` / `XIHE_RUNTIME_URL` is set explicitly, the port only changes the listening side and the launcher warns about a possible broken link. Mechanism details: DEV-003 §2 and `spec/configuration/env-effective.md`.

### 4.9. Credential CLI (PLAN-0575)

```bash
mise run xihe -- credential list [--owner-type USER|WORKSPACE --owner-id <id>]
mise run xihe -- credential references <id> --workspace <wsId>
mise run xihe -- credential events <id> --workspace <wsId>
mise run xihe -- credential precheck --permissions <atom[,atom...]>
mise run xihe -- credential create --kind token --owner-type <USER|WORKSPACE> --owner-id <id> --label <label> [--delivery-tier lease|reveal] --secret-env <NAME>
mise run xihe -- credential create --kind key_pair --owner-type <USER|WORKSPACE> --owner-id <id> --label <label> --access-key-env <NAME> --secret-key-env <NAME>
mise run xihe -- credential replace <id> --kind token|key_pair --workspace <wsId> (--secret-env <NAME> | --access-key-env <NAME> --secret-key-env <NAME>)
mise run xihe -- credential delete <id> --workspace <wsId> [--yes]   # references preview, then confirmed delete
mise run xihe -- credential bind <id> --workspace <wsId> --agent <principalId[,principalId...]>
mise run xihe -- credential unbind <id> --workspace <wsId> --agent <principalId[,principalId...]>
mise run xihe -- credential reveal <id> --workspace <wsId> (--password-env <NAME> | TTY) [--out <file> [--force]]
```

- **Secret channels**: `create`/`replace` read the token or key pair only from `--*-env <NAME>` environment variable names or a no-echo TTY prompt. Values are never accepted as arguments, read from JSONC or taken from input files; errors and logs only name the variable.
- **Explicit workspace**: every credential command except `list` and `create --owner-type USER` requires `--workspace`, and `X-Workspace-Id` matches it. `create --owner-type WORKSPACE` requires `--owner-id` to equal `--workspace`; the CLI never falls back to the token claim or first membership.
- **reveal**: on an explicit request it performs an independent step-up with the login password (`--password-env` or TTY) and prints to stdout or an `--out` regular file (existing files need confirmation or `--force`; symlinks/directories are refused). Terminal/file output is the only plaintext path; errors, progress and logs never carry the password or value. CP audit: `credential_revealed` on success, only `credential_reveal_failed` on a wrong password; other refusal branches write no event/audit.
- **delete gate**: fetch `…/references` and show it before `--yes`/interactive confirmation; `409 CREDENTIAL_IN_USE` is passed through with a re-query hint, never described as a complete report.
- CP error codes are preserved (`CREDENTIAL_NOT_FOUND`/`CREDENTIAL_IN_USE`/`CREDENTIAL_TIER_MISMATCH`/`CREDENTIAL_REVEAL_STEP_UP_FAILED`/`CREDENTIAL_REVEAL_RATE_LIMITED`, ...). Write 5xx/timeouts report an unknown outcome and are **never replayed**. All commands support `--json` (I8 shape).

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

Service ports (Docker internal / host mapping, stack-1; see "Parallel host stacks" for stack-2..8):
- CP: 8080 → 12631
- Agent: 8000 → 12632
- Runtime: 8001 → 12633
- PostgreSQL: 5432 → 12634

### 5.2. GraalVM Native Image (CP, experimental)

The current compatibility effort targets Windows x64 only and uses GraalVM Community Edition 25.4.4.1.1 (JDK 25.0.4.1.1). Linux/macOS are unverified. This is not a supported release artifact; the ordinary `dev:cp` and `mvn spring-boot:run` commands remain JVM-based.

Use a portable GraalVM installation and process-scoped environment in PowerShell (do not persistently replace the machine-wide Java configuration):

```powershell
$env:JAVA_HOME = '<portable GraalVM root>'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
java -version
native-image.cmd --version
mvn -version
```

Spring Boot `process-aot` starts the CP application context. Use a throwaway PostgreSQL project/database for AOT metadata discovery and enable the Runtime channel for the native host lane; never point it at the daily development database. Maven `native-aot` activates the matching Spring profile. `application-native-aot.properties` disables `.env` loading and only permits the explicit run-scoped `XIHE_CP_DATASOURCE_URL` or this run's `XIHE_PG_PORT`. The profile-only `NativeAotDataSourceConfiguration` creates the primary Hikari DataSource from the explicit URL, or from the isolated bootstrap database `xihe` on that run's port; it fails if both are absent, preventing embedded H2 and daily-port fallback. It enables `spring.aot.jpa.repositories.use-entitymanager=true` so Spring Data JPA builds metadata from the real `EntityManagerFactory`. The native host runner activates the same Spring profile; ordinary JVM/H2 tests do not. Database credentials remain process-environment-only. In the build PowerShell process, set the datasource URL/user/password from the temporary database:

```powershell
$env:XIHE_CP_DATASOURCE_URL = 'jdbc:postgresql://127.0.0.1:<port>/<throwaway-db>'
$env:XIHE_CP_DATASOURCE_USERNAME = 'xihe'
$env:XIHE_CP_DATASOURCE_PASSWORD = '<ephemeral password>'
$env:XIHE_CHANNEL_ENABLED = 'true'
$env:XIHE_LOAD_DOTENV = '0'
```

`process-aot` is bound at `prepare-package`; the Native Build Tools `native:compile` goal forks `package`, so use `native:compile-no-fork` after the lifecycle phase in the same Maven session to preserve the AOT configuration. Run from `packages/control-plane`:

```powershell
mvn -Pnative,native-build,native-aot -DskipTests prepare-package native:compile-no-fork
```

The Windows executable is `packages/control-plane/target/control-plane.exe`. The host E2E runner can use it explicitly with `node scripts/e2e-host.mjs --jar-mode=native --batch=native-compat`; this mode fails closed if the executable is missing/stale, enables the Runtime WebSocket channel, and uses a per-run isolated PostgreSQL database and host root. The runner self-starts its host stack, so stop the daily `dev:host` Runtime first to avoid a Windows binary lock; `--persistent` / `XIHE_E2E_EXTERNAL_SERVER=1` reuse is a separate explicit mode.

Before compiling, record available RAM, target-disk space, an explicit heap/parallelism cap, reserve, and a total build deadline. GraalVM changes Native Image builder mode below 8 GiB of available RAM, and peak RSS exceeds the Java heap cap. Do not build until the resource envelope is confirmed. The complete runbook and current evidence are in PLAN-0584 under `plans/`.

For bounded Native Test coverage, use the opt-in probe-only profile from `packages/control-plane`:

```powershell
mvn -PnativeTest,native-build,native-test-probe -Dtest=NativeImageCompatibilityProbeTest test
```

The profile compiles only the probe class and shares its output directory with Spring Test AOT and Native Build Tools. The four-test probe passed in the Windows native test image, covering JWT, AuthResponse JSON, ConfigDomainSchema, and PDFBox. The native-aot profile excludes `TomcatMetricsAutoConfiguration` because the tested GraalVM image cannot use the platform MBean path; JVM metrics remain enabled.

The `native-compat` host lane was accepted on 2026-10-31 on an isolated stack: `node scripts/e2e-host.mjs --jar-mode=native --batch=native-compat` reported 2 passed / 1 skipped / 0 failed (`journey-a` + `plan0584-native-config-schema`), covering provider connections, CP→Agent chat, `write_file` approval, SSE terminal events, message read-back, checkpoint capture, Runtime MCP and the channel handshake (`channel_connected` + `heartbeat: suppressed`); the teardown reverse check found zero containers/volumes/networks/Sandboxes. The component probe remains component-level evidence and does not replace this lane.

Native metadata maintenance: the record hints in `NativeAotRuntimeHints` come from a GraalVM tracing-agent capture on the JVM host lane (`plans/PLAN-0584-xh-cp-graalvm-native-image/evidence/agent-metadata-r5`). They register only `INVOKE_PUBLIC_METHODS` + `INVOKE_PUBLIC_CONSTRUCTORS`, live inside the `// BEGIN agent-captured records … // END` block, and must not be widened into a package-wide `TypeReference` pattern or all-declared reflection; the request-side records are defensive and may be trimmed once a host run proves them redundant. Capture note: an agent only flushes metadata on a graceful VM shutdown, so a forced service kill loses it — use `/actuator/shutdown` together with `spring.lifecycle.timeout-per-shutdown-phase=1s`.

Native probe semantics for operators: the native CP exposes `/actuator/health` anonymously, but **`/ready` requires authentication** (an anonymous request returns 401) — do not read an anonymous `/ready` 401 as a readiness failure; send the run-scoped token when probing readiness.

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

## 7. Module Version Bump (PLAN-0534)

The four modules version **independently**. Each manifest is the only authority;
business code must not contain a version literal.

| Module | Single authority | Runtime projection |
|---|---|---|
| UI | `packages/ui/package.json` `version` | Vite `define` → `VITE_XIHE_SERVICE_VERSION` |
| CP | `packages/control-plane/pom.xml` `<version>` | Maven-filtered `pom.properties` → `GET /api/v1/version` / MCP `clientInfo` |
| Agent | `packages/agent/pyproject.toml` `version` | `importlib.metadata.version("xihe-agent")` → health / `/version` |
| Runtime | `packages/runtime/Cargo.toml` `version` | `env!("CARGO_PKG_VERSION")` → `/ready` / `/version` |

### 7.1 Bump checklist

1. Pick the module and semver: in 0.x, breaking/features → minor, fixes/internal → patch (see `spec/version-contract.md` §2).
2. Change only that module's manifest version. Do not hand-edit the module entry in `uv.lock` / `Cargo.lock` / `pnpm-lock.yaml`.
3. When needed, refresh locks with the tool: Agent `uv lock`, Runtime `cargo check` (or `cargo update -p xihe-runtime`), UI `pnpm install --lockfile-only`.
4. Add an entry under `[Unreleased]` in the root `CHANGELOG.md`; when releasing, move it to `## [x.y.z] — YYYY-MM-DD`.
5. Run `node scripts/check-versions.mjs` (manifest semver, no production version literals, derivation anchors, CHANGELOG structure).
6. Restart the module and confirm `/internal/v1/agent/health`, Runtime `/ready`, `GET /api/v1/version`, and Settings → Monitoring agree.
7. Update affected doc references in the same batch. Do not copy a drifting version number into README.

### 7.2 Deployment identity

`GET /api/v1/version` (USER/ADMIN, same as `/api/v1/status`) returns:

- `stackId`: `XIHE_STACK_ID`, default `stack-1`; this is the only module surface allowed to read it.
- `releaseChannel`: `XIHE_RELEASE_CHANNEL` (`stable|beta|dev`, default `dev`).
- `startedAt`: CP process start time.
- `commit` / `modules.*.commit`: `XIHE_BUILD_COMMIT` (7–40 hex chars); `null` when not injected.
- `modules.cp/agent/runtime`: module versions; an unreachable Agent/Runtime yields `null` for that module while the endpoint still returns 200.
- **No `modules.ui`**: the UI displays its own `VITE_XIHE_SERVICE_VERSION`.

### 7.3 Known limitation

- When CP runs directly in an IDE that does not delegate resource filtering to Maven, `pom.properties` may still contain the raw `@project.version@` placeholder. `BuildVersion` rejects it and returns `null` with a WARN, so `cp.version` is `null`. Use `mvn spring-boot:run` or a Maven build for a real version.
- Commits are never fabricated; without build/deploy injection the UI shows “not injected”.

## 8. Related Documents

- [DEV-001 System Architecture](DEV-001-system-architecture.md)
- [USER-001 User Guide](USER-001-user-guide.md)
