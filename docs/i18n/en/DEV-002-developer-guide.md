---
title: DEV-002 - Developer Setup and Guide
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 2
status: active
created: 2026-05-28
updated: 2026-11-20
---

# Developer Guide — xihe Agent Platform

Related documents:
- [DEV-001 System Architecture](DEV-001-system-architecture.md)
- [USER-001 User Guide](USER-001-user-guide.md)

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
│           ├── main.rs        # rmcp MCP server (23 tools) + Axum router
│           ├── executor.rs    # WorkspaceExecutionRouter (docker / windows-mxc / windows-host)
│           ├── backend.rs     # SandboxBackend seam + capability snapshot
│           ├── mcp_session.rs # long-lived stdio sessions (exec attach)
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

**Architecture design — protocol notes (SSOT: `DEV-001` §1.5, `DEV-016`, `DEV-004` §6.3)**

**Communication protocol**

- UI ↔ CP: HTTP + SSE, for chat message streaming
- Agent ↔ CP: HTTP + SSE, for Agent streaming responses
- CP ↔ Runtime: a per-request Runtime executor boundary for tool invocation; the tracked executor owns process readiness and health probing. The boundary is backend-agnostic — the same HTTP call dispatches to `docker` / `windows-mxc` / `windows-host` inside Runtime by `ExecutionSpec.executionMode` (see DEV-001 §1.3).

**MCP reverse proxy**

CP acts as an HTTP reverse proxy without depending on any MCP SDK:

```text
Agent → POST /mcp → CP (JSON parsing + permission check + request rewriting) → Runtime
```

See `internal/SPRINTS/SPRINT-001-cs-agent-mvp/DESIGN-007-mcp-gateway-reverse-proxy.md`

**Tool name namespace**

CP adds prefix during tools/list and removes prefix during tools/call:

- Runtime returns: `read_file`
- CP returns to Agent: `runtime__read_file`
- Agent calls: `runtime__read_file`
- CP removes prefix and forwards: `read_file` → Runtime

See `internal/SPRINTS/SPRINT-001-cs-agent-mvp/DESIGN-009-tool-namespace.md`

**SSE event protocol**

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

## 2. Development Environment

**Prerequisites**

Using `mise` in the root directory is recommended for toolchain management and cross-module commands:

```bash
mise install
```

If the current shell hasn't executed `mise activate`, root tasks are recommended to use `mise run ...` format. `task` / `Taskfile.yml` have been removed (PLAN-245 M5); `mise run ...` is the only entry point.

> **This repository runs from a single clone (PLAN-0612)** — no parent ONE workspace required. `mise run check:standalone` exports a parent-less copy and verifies `stack-run` / `dev check` do not need the one root. Port defaults are **sourced from this repository** (`scripts/lib/stack-ports.mjs`); the ONE-side `config/ports.mjs` is only a mirror for orchestration (see the last two bullets of "Parallel host stacks").

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

**Install dependencies**

Running directly from the root directory is recommended:

```bash
mise run setup
# .env / .env.dev / .env.test / .env.prod are committed with non-secret placeholders — do not copy or overwrite them.
# Put machine-specific overrides (ports/DB/JWT/workspace root) in the gitignored .env.local.
```

The root directory now uses `XIHE_ENV` to select environment files:

- `XIHE_ENV=dev`: Sequentially loads `.env`, `.env.dev`, `.env.local`, `.env.dev.local`
- `XIHE_ENV=test`: Sequentially loads `.env`, `.env.test`, `.env.local`, `.env.test.local`
- `XIHE_ENV_FILE=/path/to/file`: Explicitly specify a single env file

`mise run dev:*` uses `XIHE_ENV=dev` by default.
If the merged result of these files contains `XIHE_DEEPSEEK_API_KEY` and `XIHE_LLM_PROVIDER` is not explicitly set, the Agent automatically switches to `deepseek`; if no key is present, falls back to `mock`.

> **Checkpoint storage (PLAN-0653 P3)**: `XIHE_CHECKPOINT_STORAGE=git|dual|self`, **default `git`**; `self` must be set explicitly and requires `XIHE_ENV=dev|staging` plus `XIHE_CHECKPOINT_SELF_ACK=1` (an installed image must not pre-set `self`). `XIHE_CHECKPOINT_STORE_PATH` points at a dedicated directory outside the workspace (default `<hostRoot>/.xihe-store`). Under `self`, **the store is the primary path and the git shadow is a best-effort backup**: a missing git only degrades the backup (WARN + `shadowBackupFailures`) and never blocks capture/startup, so **the self lane no longer treats git as a hard prerequisite** (git mode, `dual`, and the `Opaque`/`Reject` policies still need it). Legacy shadow history migration: `.local/evidence/plan-0653/p3/migration-sop.md`; the toggle/rollback runbook: `.local/evidence/plan-0653/p2.4-sop.md`.

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

**Root directory tasks**

> Dev hot-loop policy (dev channel "edit → see effect ≤30 s", verification channel keeps per-sha build roots, two prohibitions) lives in the ONE workspace: `internal/A03-xihe/docs/dev-hot-loop.md` — a cross-repo path, not part of this repo's body.

```bash
mise run dev:ui
mise run build:ui
mise run build:runtime

mise run dev:agent
mise run test:agent
mise run test:integration

mise run dev:cp
mise run test:cp
# BL-368 known-baseline gate: reads the reports written by test:cp; exits 0 only when every
# failure is a fresh entry in scripts/cp-known-baseline.json (run it AFTER test:cp, NOT part of validate)
mise run test:cp:baseline

mise run dev:runtime
mise run test:runtime

# BL-262 race gate: serial once + parallel 3x (milestone / post-race-fix; NOT part of validate)
mise run test:runtime:lib:gate
# BL-262 ignored-suite tiers: explicit test names + measured timeouts (NOT part of validate)
mise run test:runtime:lib:ignored:isolated
mise run test:runtime:lib:ignored:functional
# MXC boundary cases need XIHE_MXC_EXECUTABLE (installed wxc-exec.exe); without it they fail loudly
mise run test:runtime:lib:ignored:mxc

# e2e fixture self-tests (fake LLM chain state machine; no stack, seconds) — part of `validate`
mise run test:e2e:fixtures

# mock-lane S1 smoke (31 spec files; measured 2026-11-15, single run, port 28640:
# 107 passed + 0 flaky + 27 skipped + 0 failed, 77 s wall, --workers=4, headless).
# No backend needed.
# XIHE_UI_PORT is REQUIRED: playwright.config.ts defaults to 12630, which sits inside the
# verification-window forbidden range 12630-12633, so unset or in-range exits 2.
mise run test:mock:smoke
# test:mock (full mock lane, same config, all spec files) ALREADY EXISTS and was NOT measured in this
# round — TODO: record wall time / test counts / red count from a real run before quoting numbers.
mise run test:mock
# preview-chain lane (task-249 B, D-1649): runs ONLY the 2 preview specs
# (task25-preview-sessions + task449-workspace-agents, 11 cases) with XIHE_E2E_EXPECT_CHAIN=preview;
# the config injects the mock-login preview-real.html entry. In the default mock lane these 11
# cases are skipped with a reason — this lane is what actually runs them (skip-rot prevention).
# Measured 2026-11-16, single run, port 28642: 11 passed, 24.7 s test-time, --workers=1 --retries=0,
# headless. No backend needed. XIHE_UI_PORT is REQUIRED (unset or in 12630-12633 exits 2).
# The effective chain is asserted to be preview before running (all-skip would be a false green).
# A cold vite deps cache may fail the first run with env(stale-deps) — rerun once (warm steady state).
# Writes no JSON report (never touches the full-lane baseline). NOT part of validate.
mise run test:mock:preview

# read-only ledger (BL/PLAN) validation, run from the ONE workspace root; report-only (not part of `validate`)
mise run ledger:validate

# Font subset coverage gate - DEFERRED, NOT part of `validate` any more. It WAS wired into validate
# by task-258; D-1132 removed it on 2026-11-13 together with the whole font self-hosting effort
# (BL-622). The task definition is kept for manual re-runs (D-1133 "removal is not deletion"); running
# it now exits 2 because the scripts moved to ONE-side internal/A03-xihe/deferred/font-self-hosted/.
# Product uses the system font stack today; reinstate criteria: that directory's README section 3.
mise run check:font

# A03 private docs index gate, run from the ONE workspace root: top-level md registered / links exist /
# §2 subdir counts match disk / S4 row-decidability / H6 (§1.0 ownership table = 8 rows × 5 cols with
# executable criteria) / H7 (references to `status: deprecated` docs). Since 2026-11-12 this task runs
# with `--strict-deprecated`, so H7 is BLOCKING (the single real hit — `dev-hot-loop.md` listed as a
# trial feature — was fixed in the same commit, so the gate went green before it was armed).
mise run check:docs-index

# [FROZEN 2026-10-07 — do not run; use dev:host for daily development]
mise run test:e2e:compose
mise run validate:full
```

If you prefer not to use root tasks, you can enter the module directory and execute manually; however, the root `.env` and corresponding profile env files will not be automatically loaded — you need to export environment variables yourself.

The root directory no longer uses pnpm workspace. `packages/ui/` is itself the pnpm root: it owns `pnpm-workspace.yaml`, the pnpm security policies (cooldown, build-script whitelist, overrides, patches) and the single lock file. Because it is a workspace root, pnpm commands run under `packages/ui/` must NOT pass `--ignore-workspace` — that flag is install-only and does not apply to `run`, and it would skip the package's own workspace policy. You can also use the root `mise run *` tasks, which are already wired to the UI root.

### First-boot account: where `admin@xihe.local` comes from (task-172 / `D-1532 ④`)

CP defaults to `cp.bootstrap.seed-admin=${XIHE_SEED_ADMIN:false}`, so a fresh install has an empty `users` table, `GET /api/v1/auth/bootstrap-status` returns `{"initialized": false}`, and the UI sends the first user to `/onboarding` where the first registered account carries the admin duty (user ruling `39D-2`: keep first-run account creation). To get a ready-made `admin@xihe.local` for dev/test/demo, export `XIHE_SEED_ADMIN=true` plus `XIHE_DEV_ADMIN_PASSWORD` **before starting the stack**; seed insert is idempotent (`findByEmail` reuses an existing row and never overwrites the password), so a restart never creates a second account. Supersede (task-42 / D-1753 ②, 2026-11-17): the generated-password branch no longer prints the value (logs are a permanent-retention surface) — it only points at `mise run reset-admin`, and `DataSeeder` writes no persistent file, so "an account exists but nobody knows the password" **does happen** and the remedy is `mise run reset-admin` (an accepted cost, not a malfunction). `mise run reset-admin` is **not** a substitute for the switch: it only UPDATEs and exits 3 when the row is missing. Full Chinese-side section: `docs/i18n/zh-Hans/DEV-002-developer-guide.md` section 2 (the packaged launcher below opts in for you).

### Configuration management (PLAN-042)

**Architecture overview**

CP ConfigService is the unified configuration management entry point, using a two-layer model:

| Layer | Purpose | Modification Method |
|-------|---------|---------------------|
| **Environment Variables** | Pre-runtime fixed (port/DB/JWT) | `.env.dev` (committed baseline; personal overrides in gitignored `.env.local`) |
| **ConfigService** | Runtime modifiable (API key/model/logging) | UI Settings / `PUT /config/admin/{domain}` / `POST /config/import` |

**Priority**: ConfigService values override environment variable keys with the same name.

**Phase 3 Changes**:
- `XIHE_LOAD_DOTENV=0` — Modules no longer read application-layer configuration from `.env`/`.env.dev`
- All application-layer configuration (LLM provider, API key, model, log level, embedding, etc.) managed through CP ConfigService
- Only bootstrap variables retained for infrastructure startup (`XIHE_CP_URL`, `XIHE_CP_API_TOKEN`, `XIHE_RUNTIME_HOST/PORT`, `XIHE_DATASOURCE_*`, etc.)

**Configuration methods**

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

**Development workflow**

1. **`cp config.import.example.jsonc config.import.local.jsonc`** — Fill in non-secret settings only (PowerShell: `Copy-Item`); API keys belong in Provider Connections, not JSONC.
2. **`mise run dev:host`** — Start the daily host stack; config import remains separate.
3. **`mise run dev:host:import-config`** — Explicitly import local non-secret config after CP is ready.
4. **`mise run dev:host:provider-init -- --provider xiaomi --scope USER --label xh-local --api-key-env XIHE_XIAOMI_API_KEY`** — Create or reuse and verify a local provider connection.
5. **`mise run test:e2e:host:real -- e2e/real/real-tool-roundtrip.spec.ts --route openai-compat`** — Run one real MiMo host test; requires `XIHE_E2E_REAL_XIAOMI_KEY`.

**Host-stack bootstrap and scripted-path notes (2026-10-18):**

- **`mise run dev:host` does not load `.env.dev`**: the internal service token must be injected or it falls back to the dev placeholder. Either use `scripts/dev-host.ps1 -Start` (it generates the internal token) or inject the env explicitly; when invoked without a TTY, that script's `Start-Process` makes the caller hang on inherited handles (the services do start) — for automation, launch each service as a tracked background process and probe readiness on ports 12631/12632/12633. Module auth and keys: see [DEV-024](DEV-024-authentication-matrix.md).
- **Runtime target guard**: before starting services, `dev:host` runs `mise run check:runtime-target`; the watch level only prints, while the FORCE line (≥20 GB, or H: free <5 GB) blocks startup. The script also prints one line `default-stack runtime binary: … classification=present|migrated-away|unverifiable` (JSON field `runtimeBinary`): **a missing binary is a legal post-migration state** (`migrated-away` = a root is configured but that root has no `main/debug/xihe-runtime.exe` yet, back on the next build/restart; `unverifiable` = no root configured and no binary at any known root). It is **informational only and never changes `verdict` or the exit code** — the check must not report a failure for something that was legitimately moved away.
- **LLM readiness prerequisite**: without an imported `llm-provider` profile the Agent reports `llmReady=missing_credentials` and `POST /api/v1/chat` returns 503 `LLM_NOT_CONFIGURED`; `POST /api/v1/config/import?layer=instance` accepts **plain JSON only** (strip the line comments from `config.import.local.jsonc`, or just use the CLI above).
- **Scripted path, three points**: a new session already owns a root branch (`POST /sessions/{id}/branches` is fork semantics requiring `sourceBranchId` + `anchorMessageId` — reuse the root branch instead); `POST /api/v1/chat` requires an active SSE subscription for the session first (otherwise 409 `SSE_SUBSCRIPTION_REQUIRED`); Bearer tokens live only 900s, so keep the `reset-admin` → `login` token in a temp file and refresh it per batch (never in the repo).

The CLI is an operator entry point. It calls CP's authenticated HTTP API for Provider Connections; Agent execution continues to use its own lease/protocol path. The real E2E key is injected directly into the isolated Agent process and does not test a Provider Connection lease.

`--api-key-env` reads a variable already present in the CLI process. An interactive terminal prompts without echo when needed; non-interactive tasks must inject the environment variable. The CLI entry point **fills missing keys** from the `.env` → `.env.$XIHE_ENV` → `.env.local` chain (PLAN-0547 `loadEnvFileChain`; an existing OS env value is never overwritten by a file); secrets are still read only from env or a TTY, never from argv, logs, or reports.

`real-tool-roundtrip` may send up to two model prompts and can incur provider charges. Playwright retries are disabled for this command; decide manually whether to rerun after a failure.

6. **Runtime debugging** — `PUT /api/v1/config/admin/{domain}` or UI settings page modification, takes effect immediately

**Configuration clients**

Each module accesses CP ConfigService through local clients:

| Module | Client File | Behavior |
|--------|-------------|----------|
| **Control Plane** | `ConfigService.java` | Built-in `@Service`, exposes CRUD API externally, PG persistence |
| **Agent** | `xihe_agent/config_client.py` | Fetches admin+system cache at startup, provides `get(key, default)` interface |
| **Runtime** | `src/config_client.rs` | Fetches and periodically refreshes at startup, provides `get(key)` interface |

## 3. Runtime Modes

CP (Control Plane) supports two runtime modes:

### Mode A: `dev:host` daily development (recommended)

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

**Note**: Under WSL2 mirror network mode, host connections to Docker PostgreSQL may fail password authentication. This is because the `bridge` network's port mapping causes NAT translation of the connection source address, and the `127.0.0.1/32 trust` rule in `pg_hba.conf` doesn't match. If you encounter this issue, use **Option B1 (H2)** or reach PostgreSQL on the host directly (`mise run dev:host` keeps only PostgreSQL in a container, so the host-side port is the one that matters). **Mode A (Full Docker Compose) is frozen since 2026-10-07** and stays historical reference only.

`.env.dev` file records two database configurations (PostgreSQL is default, H2 is commented out). Uncomment to switch.

**Startup order (PLAN-0632 T4.4)**: in `dev:host`, cp/runtime/ui still start in parallel, but the **Agent waits for CP readiness first** — `dev:host:wait-for-cp` polls `/actuator/health` until 200 (**budget is path-layered**: reuse-of-built-classes **60 s**; rebuild path (stale/missing/dirty ⇒ this start runs `clean compile` first) defaults to **240 s**; override both paths with `XIHE_WAIT_FOR_CP_TIMEOUT`, the rebuild path only with `XIHE_WAIT_FOR_CP_REBUILD_TIMEOUT`); on timeout it **fails loudly and prints the CP log path** instead of starting the Agent into `degraded` (the old behaviour burned ~2.8 s of startup config sync for nothing). Starting the Agent on its own still works via `mise run dev:host:start:agent` (it carries the wait).

**Stack build freshness (PLAN-0662)** — a long-running stack does **not** follow `develop` by itself, and `health UP` does not mean "this is the current code" (that is how BL-240 was misjudged). Build output carries `classes/META-INF/build-info.properties` (`commit`/`builtAt`/`dirty`) and the startup log has a `cp.build commit=… built=… dirty=…` line. Operationally **read the verdict before restarting**: `mise run dev:host:status` (add `-- --json` for fixed fields, which lane scripts assert on); `verdict=fresh` alone means these classes came from the current HEAD; `verdict=dirty` (BL-325) is the right commit built from a dirty tree and **counts as non-fresh** (not stale — stale only means a different commit).
- `stale`/`missing` **rebuild by default**: `mise run dev:host:start:cp`, `dev:host` and `dev:stack` all compare build-info against `git rev-parse HEAD` before `mvn` and run `clean compile` first when they disagree (single implementation: `scripts/stack-run.mjs`). To bring a stack up on old classes anyway, pass `--no-rebuild`: the log keeps a `WARNING` plus the old commit so it stays traceable.
- When an E2E run reuses an external stack (`XIHE_E2E_EXTERNAL_SERVER=1`), the runner asserts CP build commit == `XIHE_E2E_EXPECT_CP_COMMIT` (defaulting to the HEAD of this checkout) before starting, and fails fast on a mismatch **or an unreadable build-info**, pointing at "rebuild/restart CP first" — so an old build is never reported as a product defect (BL-240).
- **Build directories are isolated per stack and per commit (BL-253 L3)**: each stack compiles into its own `C:/xihe-build/cp/<stackId>/<sha12>[-dirty]` (root overridable via `XIHE_CP_BUILD_ROOT`); a sibling `<stackId>/.current` records the directory **that stack last actually started from**, and status/E2E assertions read it, so `cpBuild.targetDirSource` tells you `pointer` (the record owned by that stack, most trustworthy) / `newest` (newest build slot on disk) / `env` (explicit `XIHE_CP_TARGET_DIR`) / `derived` (not built yet, derived from HEAD). **Read both verdict and source before restarting**: only `pointer+fresh` means "this stack is running the current code".
- Retention happens **only through explicit cleanup**: `mise run dev:host:cp-build:clean` is a **dry run** by default, printing `keep N / prune M` per stack; add `-- --apply` to delete. Every stack keeps its newest 3 slots plus whatever `.current` points at, and only `cp/<stack-N>/<sha12>` is scanned — legacy directories (`dev-host`/`bl240-cp`/`e2e`/rust target) never match. The **rollback channel** stays the explicit `XIHE_CP_TARGET_DIR` (highest precedence, passed through as-is). Note that after switching to the isolated layout **the next restart of a stack** compiles into its own `<sha12>` for the first time (~60 s, during which that stack is unavailable): whoever restarts it owns checking the four ports and `verdict=fresh` — never restart a stack owned by somebody else just to "refresh".

### Operator CLI surface (PLAN-0574)

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

### Credential CLI (PLAN-0575)

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

### Mode A2: detached full stack (PLAN-0603)

`mise run dev:host` is a **foreground** mise task: when the terminal / agent turn exits, its child tree is reaped. For "survives the turn + four services ready", use the repo supervisor (commands/cwd/stack env are reused from `scripts/stack-run.mjs`, with no parent-directory lookup):

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
- `mise run dev:stack -- --stack N` forwards to this supervisor; **`--next` is not supported for xihe** (use `--stack`).
- **Parallel worktrees must use different stacks** (the same stack shares the PG database `xihe_<n>`); first run in a worktree needs `pnpm install --offline` for `packages/ui`. Inside the ONE workspace the external-cache convention for `CARGO_TARGET_DIR` / `UV_PROJECT_ENVIRONMENT` is documented on the ONE side; a standalone clone just uses the default cache.
- `stop` only kills process trees recorded in the PID file whose command line matches `stack-run.mjs`; it never kills by port blindly.
- **Dev admin password auto-injection (D-766)**: `start` resolves, persists and injects the dev admin password itself, then upserts it into the database once the four services are ready; source precedence, skip conditions and the log contract are in §4 "Dev admin password auto-injection".

### Mode B: Docker Compose full stack (one-shot baseline, frozen since 2026-10-07)

```bash
# [frozen 2026-10-07 — do not run; daily work uses `mise run dev:host`, isolated E2E uses `mise run test:e2e:host`]
docker compose up -d --build
```

Starts all 4 services: `postgres` + `control-plane` + `agent` + `runtime`.

> **Topology limit (read first)**: Compose already mounts Runtime's Docker Engine socket and aligns `XIHE_AGENT_API_TOKEN`/`XIHE_CP_API_TOKEN` (fixed in PLAN-0401), but the container-side WorkspaceStorage mapping is still missing (runtime mounts `./logs/runtime:/logs` and `/var/run/docker.sock`, with no host workspace directory mapping). Compose mode therefore **still cannot replace the `dev:host` main line**: workspace / MCP / screenshot verification must run in host mode, and a Compose failure must never be attributed to host v1. Separately, Agent single-workspace MCP binding conflicting with "one workspace per E2E case" is an architecture-level known boundary (see the project AGENTS Known Issues).

CP connects to `postgres:5432` via Docker internal network `xihe-net`. PostgreSQL username/password is defined by `POSTGRES_USER` / `POSTGRES_PASSWORD` in `docker-compose.yml`.

The development-stack PostgreSQL is **passwordless** (`POSTGRES_HOST_AUTH_METHOD: trust` plus an empty `POSTGRES_PASSWORD`, kept deliberately per DSD-1491) and its published port is **loopback-only**: `docker-compose.yml` maps `127.0.0.1:${XIHE_PG_PORT:-12634}:5432`, so `localhost:12634` still works on this machine while hosts on the same subnet cannot connect (task-97, 2026-11-20). The CP startup check therefore only WARNs about a blank database password in dev, and `.env.dev` silences it with `XIHE_CP_DATASOURCE_PASSWORD_ALLOW_BLANK=true`; under `XIHE_ENV=prod` that switch is ignored and `XIHE_CP_DATASOURCE_PASSWORD` stays mandatory (task-98 / DSD-1491 ②).

Verification:

```bash
curl -s http://localhost:12631/actuator/health    # Expected: {"status":"UP"} (inside Docker: :8080)
curl -s http://localhost:12633/health              # Expected: OK (inside Docker: :8001)
```

**Compose lane reference (frozen 2026-10-07 — historical only)**

```bash
# [frozen 2026-10-07 — do not run; daily start uses `mise run dev:host`, isolated E2E uses `mise run test:e2e:host`]
# Scope details: see the two banners in `docs/i18n/zh-Hans/DEV-002-developer-guide.md` "Mode B (Docker Compose)"
# — workspace Docker backend freeze (PLAN-0618) / Compose topology limits.
# Build and start all 4 services
docker compose up -d --build

# Check status
docker compose ps

# View logs
docker compose logs -f control-plane
```

Service ports (Docker internal / host mapping, stack-1; see "Mode D: parallel stacks" for stack-2..8):
- CP: 8080 → 12631
- Agent: 8000 → 12632
- Runtime: 8001 → 12633
- PostgreSQL: 5432 → 12634

### Mode C: single-module host testing

The CP can boot on its own against in-memory H2 — no PostgreSQL, no Docker (the datasource URL/driver/dialect must all be overridden and Flyway disabled; PowerShell example):

```powershell
$env:XIHE_CP_DATASOURCE_URL = 'jdbc:h2:mem:xihe;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1'
$env:XIHE_CP_DATASOURCE_DRIVER = 'org.h2.Driver'
$env:XIHE_CP_DATASOURCE_USERNAME = 'sa'
$env:XIHE_CP_DATASOURCE_PASSWORD = ''
$env:XIHE_CP_JPA_DIALECT = 'org.hibernate.dialect.H2Dialect'
$env:SPRING_FLYWAY_ENABLED = 'false'
$env:SPRING_JPA_HIBERNATE_DDL_AUTO = 'create-drop'

mvn -f packages/control-plane/pom.xml spring-boot:run
```

Per-file commands live in `A03-xihe/AGENTS.md` (UI lint/typecheck/test:unit, single-file Agent pytest, single-class CP `mvn`, Runtime `cargo test --lib`).

### Mode D: parallel stacks (PLAN-0533)

`XIHE_STACK_ID` (`stack-1`..`stack-8`, default `stack-1`) selects a stack. The launcher derives ports, compose project, PG database, sandbox container prefix and the log/host-root/state dirs; modules only read the derived `XIHE_*_PORT` env. **Every 1263X port elsewhere in this guide is the stack-1 default.**

```bash
mise run dev:stack -- --stack 2                    # or: XIHE_STACK_ID=stack-2 mise run dev:host
node scripts/stack-run.mjs env-json --stack 2      # print that stack's derived values without starting
```

| Stack | UI | CP | Agent | Runtime | PG | compose project |
|---|---|---|---|---|---|---|
| stack-1 (default) | 12630 | 12631 | 12632 | 12633 | 12634 | `a03-xihe` |
| stack-2 | 12640 | 12641 | 12642 | 12643 | 12644 | `xihe-stack-2` |
| stack-3 / 4 | 12650 / 12660 blocks | … | … | … | … | `xihe-stack-3/4` |
| stack-5..8 | 12700 / 12710 / 12730 / 12740 blocks | … | … | … | … | `xihe-stack-5..8` |

- stack-1 keeps the legacy paths (`.xihe-workspaces`, `logs`, `.xihe-state`); stack≥2 uses `.xihe-stacks/<n>/{workspaces,logs,state}` (gitignored).
- **On-demand stacks (D-808① reversed the PLAN-0656 "routine dual-stack")**: the `stack-1..8` slots remain the port/isolation infrastructure, so stacks are started on demand — **do not keep two resident stacks**; parallel development runs through the **four resident module branches** (`m/ui` / `m/cp` / `m/agent` / `m/runtime`, D-810). `node scripts/dev-stack.mjs status --all` gives a read-only overview of **every running stack's** ports/health/DB/compose/build target (a stack that is not running is not a fault). Three build-surface rules: **per-stack cargo target** — non-default stacks get `CARGO_TARGET_DIR=<root>/<stackId>` automatically (`<root>` = `XH_CARGO_TARGET_ROOT`, falling back to `<workspace>/.tmp/cargo-target` when unset) (stack-1 keeps the shared `main` warm cache from `.cargo/config.toml`; an explicitly set `CARGO_TARGET_DIR` is never overridden), so two stacks can no longer fight over one exe (BL-221); **orphan sweep** — `dev-stack stop` and every `stack-run <service>` launch sweep leftover processes by "this stack's port + service identity profile" with per-action logs (foreign occupants are warned, never killed); **E2E build isolation** — `test:e2e:host` uses its own `cargo-target/e2e` and `C:/xihe-build/e2e` and no longer requires stopping the dev stacks (see §5 Test entry points). Every directory under `cargo-target` (`main` / `stack-N` / `e2e` / worktree names) is a rebuildable cache (pair-delete per the workspace `worktree-lifecycle` discipline); the `check:runtime-target` water level intentionally measures only the resolved single target, never a cross-stack sum (so one stack's cache cannot gate another stack's start).
- **Configurable build-output root (task-80, 2026-11-08)**: `XH_CARGO_TARGET_ROOT` decides where the whole target family lives (the machine value lives in the gitignored `mise.local.toml`, while `mise.toml` carries only the contract and never a machine path), layout `<root>/{main,stack-N,e2e}`; a linked worktree adds its own level `<root>/<worktree-dir>/` so two lanes on the same stack id never overwrite each other's exe. Precedence: `CARGO_TARGET_DIR` > `XH_CARGO_TARGET_ROOT` > the old derivation `<one>/.tmp/cargo-target`; **with the variable unset the behavior is byte-for-byte unchanged**. See §6 "Rust build cache strategy" for fail-fast semantics, the wrapper scope, and the bare-`cargo`/IDE residue.
- Unregistered ids (`stack-9`, `foo`) fail fast instead of falling back to stack-1.
- `dev:host:stop` / `dev:reset` only touch the current stack (label `xihe.stack-id`; a missing label means stack-1).
- Two concurrent stacks at most are recommended.
- **Port source of truth (PLAN-0612)**: default ports live in this repository (`scripts/lib/stack-ports.mjs`, `STACK_PORTS` + `deriveStack()`); the ONE workspace `config/ports.mjs` is only a mirror for orchestration. Changing one side requires changing the other **in the same batch**, verified by `mise run check:ports` (per stack × per port, derived fields, and `.env.dev` self-consistency). That gate is **fail-closed** (task-61 P1-3): it runs with `--require-mirror`, so a missing ONE workspace exits 2 — a skip no longer reads as a pass. A standalone clone that only needs the in-repo self-check runs the bare script `node scripts/check-ports-parity.mjs` (prints `SKIP`, json `skipped:true`, exit 0); do not treat the gate as passable there.
- **Single-clone self-check**: `mise run check:standalone` exports a parent-less copy and verifies startup/self-check do not depend on the one root.
- **OpenAPI contract gate (BL-162)**: `mise run check:openapi` validates `docs/api/openapi.yaml` (3.1 header, unique paths, path-parameter declarations, Problem Details, plus the frozen checkpoint-revert and session-read contract slices). It is a **dependency of `test:cp`**, so running the CP test suite checks the contract; PLAN closeout / wave acceptance must run it explicitly. A failure prints the parsed path count, the first failure and a fix hint (`docs/api/openapi.yaml` stays the single source of truth). It deliberately does **not** diff Spring routes against the contract — "route implemented but undocumented" is a known blind spot tracked as a separate BL.
- **API docs freshness gate (PLAN-0763 M4)**: `mise run check:api-docs` asserts `docs/api/inventory.generated.md` is **byte-identical** to what `docs/api/openapi.yaml` generates (`--check`: stale ⇒ exit 1 with the first differing lines plus `fix: mise run gen:api-docs`; missing PyYAML interpreter ⇒ exit 2, never a silent pass); regenerate with `mise run gen:api-docs`. Parsing is delegated to the PyYAML that ships in `packages/agent/.venv` (**no new dependency**, and the script never hand-writes a YAML parser); grouping is two levels via `x-tagGroups` then `operation.tags[0]`, degrading to one section per path prefix (with a TODO marker) while the contract carries no tags. The hand-written `docs/api/inventory.md` is **kept and not replaced** — route-migration mappings, callers and error contracts cannot be expressed by the contract. The gate sits in the `validate` dependency chain next to `check:openapi` (not chained under it: that would force the Maven-only `test:cp` lane to depend on python).
- **Migration-number gate (task-164 judgement / task-168 wiring)**: `mise run check:migrations` compares the Flyway numbers under `packages/control-plane/src/main/resources/db/migration` with the workspace registry `one/internal/A03-xihe/docs/migration-numbers.md` (duplicate numbers / registry behind / unregistered new number). **Three exit states 0/1/2: 1 = findings (each prints its code + file); 2 = cannot answer (migration dir or registry unreadable, or the registry headline values do not parse) — exit 2 is NOT green.** The registry is a workspace file and lives outside this repository, so it is located in this order: `mise run check:migrations -- --registry <path>` > sibling `../internal/…` > **the main checkout** (worktree/lane case, prints `NOTE cross-repo registry`); if none resolves the gate exits 2 and prints both fixes. Self-test: `node scripts/check-migration-numbers.mjs --selftest` (5 judgement fixtures + 4 resolution fixtures). **Not wired into `validate`** — prove it fires before hanging it on the pipeline.
- **Migration test coverage gate (task-181 delivered / task-192 wired)**: `mise run test:cp:migration` runs `scripts/run-migration-tests.mjs`, which asks `scripts/check-migration-test-coverage.mjs --test-filter` for the class list and then runs `mvn -o test -Dtest=<list>` under `packages/control-plane`, i.e. only the CP tests that cover registered Flyway migrations; **why not inline the mvn call in `mise.toml`**: mise executes run strings through `cmd.exe` on this host and `$(...)` is not expanded (measured 2026-11-13: mvn reported `No tests matching pattern "$(node … --test-filter)"`) — the executable form and the criterion stay separate, and the criterion still lives only in that script; when the migration→test mapping has a gap the script exits non-zero first and names the file. **One-sentence criterion**: the task exists ⇒ "did anyone miss one" is answered by the script; it does not exist ⇒ it is answered by someone's memory. **Deliberately not part of `test:cp`** (wiring it there would swallow the maven output).
- **Commit-message gate (2026-11-06)**: `mise run check:commit-msg` **now blocks** and is a dependency of `mise run validate` (D-216 measured at the flip, 2026-11-06 02:02: 32 commits since `a632de77`, 0 violations). Rules: first line `<type>(<scope>): <summary>`; **summary display width ≤72 columns (CJK counts as 2, ≈36 Han chars), merge ≤100**; non-merge commits must reference `PLAN-####`/`BL-###`/`D-###`. Shell script `scripts/check-commit-msg.mjs` (`--file` for hooks, `--range` for review, `--stats` for the window, `--report-only` for the old never-fails audit; blocking is the default) — the `mise` task runs `--enforce` and gates `validate`; enable a local hook with `git config core.hooksPath scripts/hooks`. The flip to blocking is decided by **commit count** (D-213: **≥30 commits** since `a632de77`, 12 h cap, whichever first; violation rate ≤10% with zero over-wide merges). Two different numbers by nature: 30 is the criterion threshold, 32 is the sample measured at the flip.

- **Migration immutability gate (task-134 judgement / task-842 wiring)**: `mise run check:migration-immutability` enforces "a published migration is read-only, byte for byte". The published set is exactly the `**/db/migration/V*.sql` files present in the tree of `git merge-base develop HEAD` (authority, never mtime/author/"the filename looks old"), so a **new** higher-numbered `V*.sql` added on a branch is always allowed. Four findings each name `V<n>` + file: `E_PUBLISHED_MIGRATION_MODIFIED` (comments/whitespace included), `_DELETED`, `_RENAMED`, and `_BYTE_DRIFT` — the last one is an independent raw-byte blob comparison, so `git update-index --assume-unchanged` (which makes `git diff` completely blind) is still caught (measured). **Why it exists**: Flyway checksums the whole file (comments included), so editing a migration already merged into `develop` is not "one red test" — it is **every already-migrated database refusing to start** (checksum mismatch). The rule previously lived only in the prose of `packages/control-plane/AGENTS.md`, and the judgement script (task-134) had only its **self-test** wired into `test:cli`: the scanner had no mise entry point at all, so task-835 rewriting ~30 historical migrations had no gate to trip on it (breakpoint analysis and counter-evidence: `internal/A03-xihe/evidence/2026-11-22-migration-immutability-gate/README.md`). **Blocks by default** (a finding exits 1) and is wired into `mise run lint` via `LINT_GATES`; the only escape hatches are the **paired** `--allow-published-edit <V> --reason <text>` (prints WARN, never blocks, leaves a trace in the command line and the output) and `--report-only` — **no environment variable switches this gate off** (AGENTS.md §emergency bypass: turning a gate off must leave a trace). `-- --base <ref>` changes the baseline; exit 2 means **cannot answer** (not a git repo / no merge-base, i.e. no local `develop` ref) and is NOT green — a `--single-branch --branch develop` clone measures exit 0. Self-tests: `node scripts/check-migration-immutability.mjs --selftest` (5 fixtures) and `node --test scripts/check-migration-immutability.test.mjs` (10 cases). Measured gate cost: **238–330 ms**.

### Mode E: packaged product (PLAN-0632, `pkg:launcher` / `pkg:installer`)

The distribution shape ("double-click the installer → services start → browser opens localhost"), not the daily dev path (that stays Mode A).

```bash
mise run pkg:launcher -- start --install <install-dir>  # order: PG(TCP) -> CP(/actuator/health 200) -> Agent -> Runtime -> UI(same-origin /)
mise run pkg:launcher -- status --stack 1 --json        # read-only state (health/ports/PIDs)
mise run pkg:launcher -- stop                           # reverse-order tree kill + residual port check
mise run pkg:installer                                  # NSIS build from the four existing service artifacts (-- --stage-only skips makensis)
```

- **The order is the contract**: PG must accept TCP (the CP runs Flyway on boot), then CP `/actuator/health` 200, then Agent (its startup config sync is fail-closed on `llm-provider`), then Runtime, then UI (D32-06 same-origin serving). Every step is a readiness probe with an explicit timeout — **no fixed sleeps** (implementation: `scripts/lib/service-supervisor.mjs`).
- Extra arguments go after `--` (`--install`, `--stack`, `--exe <service>=<path>`, `--skip <service>`), the same convention as `dev:stack` and `dev:host:provider-init`.
- **Two launchers, two jobs (do not mix them)**: `mise run pkg:launcher` (Node, `scripts/pkg/launcher.mjs`) is the **dev/smoke supervisor** — it starts the five stages from an install-relative manifest and **does no first-run work** (an uninitialized data directory fails with `PostgreSQL data directory is not initialized`); the **product first run** (extract PG, `initdb`, secrets, data root, JDBC bootstrap, open the browser) belongs to the **bundled Java launcher** (`scripts/pkg/launcher/src/com/cc01cc/xihe/pkg/Launcher.java`, compiled into the installer by `build-installer.mjs`).
- **Artifacts only land in `.tmp/pkg/` (gitignored) and are never committed.**
- On a dev machine `pkg:launcher status` reports the `dev:host` listeners as `foreignListeners` and returns `ok:false` (exit 1): that is the correct answer to "this is not a packaged install", not a failure.
- Capabilities deliberately not included (auto-update, autostart, code signing, per-machine service install): `plans/archive/PLAN-0632-xh-mvp-self-contained-packaging/installer-scope.md`.

#### E.1 Empirical landing path (task-187, 2026-11-18) [measured]

> This section records the **product deployment** path proven by the task-187 empirical run (not the daily dev path — that stays Mode A).
> **Do not mix the two launchers**: the product first run / start / stop uses the **bundled Java launcher** (`app/xihe-launcher.jar` — it does secrets / initdb / pgvector / data root / JDBC bootstrap); `mise run pkg:launcher` (Node `scripts/pkg/launcher.mjs`) is the **dev/smoke supervisor and does no first-run work** (an uninitialized data directory fails outright). Every command below targets the Java launcher.

**Build the stage (assemble only; no makensis)**

```bash
# cwd = A03-xihe/; artifacts land only under .tmp/pkg/ (gitignored)
node scripts/pkg/build-installer.mjs --stage-only \
  --empirical-pgvector "<pgvector dist dir>" \
  --runtime-exe "<xihe-runtime.exe>"
# or via mise: mise run pkg:installer -- --stage-only --empirical-pgvector <dir> --runtime-exe <exe>
```

- `--empirical-pgvector <dir>`: the **D-1817 parameterized bypass**, **off by default**. When given, it uses a locally rebuilt pgvector artifact but **the shipped sha gate is untouched**, prints full provenance plus an `EMPIRICAL — NOT FOR SHIPPING` marker, and appends an audit line to `.tmp/pkg/empirical-audit.log`. Use it only when the genuine pgvector inputs are unavailable for empirical work; **a release must not pass this flag**.
- **PG share-trim keep-set v2 (fixed by task-187)**: CP Flyway V163 needs `ltree` (`V163__plan0773_org_units.sql:43`); a keep-set with only plpgsql leaves the CP unable to boot (`extension "ltree" is not available`). The set now keeps all of plpgsql plus all of ltree (control + the 1.1 base script + the 1.1→1.2→1.3 upgrade chain). `PG_SHARE_TRIM_VERSION` is now v2 — changing the keep-set **requires a version bump**, otherwise the unchanged stamp reuses the stale cache.

**Single-instance first-run start/stop (product Java launcher)**

```bash
S=<stage dir>; LA=<data root, e.g. /d/tmp/xh/la-1>
export LOCALAPPDATA="$LA"        # data root = <LOCALAPPDATA>/Xihe (PG cluster / secrets / workspaces / attachments)
"$S/payload/jre/bin/java.exe" -jar "$S/app/xihe-launcher.jar" start \
  --install "$S" --no-browser --cleanup-on-failure
```

- **`start` blocks** through the pg→cp→agent→runtime→ui gates, then exits 0 leaving detached children (no Job Object). First-run chain: secrets (7 keys, owner-only ACL) → security env=prod 5/5 → pgvector install → initdb → db-bootstrap (role xihe / db xihe_1 / extension vector / SELECT 1) → CP (Flyway incl. V163) → agent → runtime → ui.
- **A fresh instance boots with a seeded admin** (task-205/D-1818): the launcher injects `XIHE_SEED_ADMIN=true`, so CP DataSeeder creates **admin@xihe.local** (instance owner, SUPER_ADMIN) with the launcher-generated password disclosed only in **FIRST-RUN.txt (0600)**; the first user logs in with instance:admin — no self-service claim needed.
- **webui = CP same-origin** (D32-06): `GET http://127.0.0.1:<cpPort>/` = 200; `/actuator/health` = 200.
- **status**: `... status --install "$S"` prints each service's alive/ready plus "stack is up". **Note the status process exits 1 even when "stack is up" — judge liveness by the text, not the exit code.**
- **stop**: `... stop --install "$S"` kills the tree in reverse order and rechecks residual ports; success prints `residual=[]` and removes the pid file.
- **Execution discipline (or it hangs)**: launcher children detach but **inherit the stdout pipe** ⇒ **never pipe `start` into `tee`** (tee waits forever on the children); redirect to a file instead. Under a DSH/agent tool call **run it in the background + collect with job_output** (a foreground ops_bash waits on the detached children's handles and hangs); keep start→verify→stop inside one job so the job ending does not take the services down with it.

**Dual instance (port / DB / data-root isolation)**

```bash
# instance A: stack-1 ports 12631-34, data root la-1 (stage's default app/ports.json)
# instance B: own data root la-2 + own ports.json (a clean custom range, e.g. 12730-34)
node scripts/pkg/ports-json.mjs --stack stack-2 --out <stage2>/app/ports.json   # or hand-write a clean range
# the payload may be junction-shared (read-only): <stage2>/payload -> <stage1>/payload
```

- **Three isolation levers**: ① the five ports in `app/ports.json`; ② the `LOCALAPPDATA` data root (each instance gets its own PG cluster / secrets / workspaces); ③ a separate install directory (logs / pid file). The payload may be junction-shared to save disk.
- **Both webui reachable at the same moment**: A `GET :1263x/`=200 + B `GET :1273x/`=200 (different ports, same moment).
- **Data-isolation check**: register a user in A → logging in with the same credentials against B must return 401; create a workspace in A → B's list must not contain it and B directly requesting that workspaceId must return 404 `WORKSPACE_NOT_FOUND`.
- **Windows TIME_WAIT trap**: Windows postgres **has no SO_REUSEADDR** ⇒ if a pg port accumulated TIME_WAIT from repeated probes, bind fails outright (`could not bind ... Only one usage`, even with no LISTEN). **Give the second instance a clean range never probed before** (e.g. 12730-34); do not reuse a range that just failed.
- **Start/verify/stop in one job, run in the background** (same reason as above).

**Known limitations (recorded as-is; unverified items)**

- **NSIS Setup.exe unverified**: `makensis` is not installed and a host install needs user approval ⇒ the installer shell was not run; this path uses **stage + Java launcher** (functionally equivalent, not the double-click installer shape). Verifying NSIS needs user approval for a host install plus makensis.
- **launcher hardcodes stack-1 / xihe_1** (`Launcher.java` @1048/1050/1074): both instances name the DB `xihe_1` and the stack `stack-1`, but the **clusters are separate** (different data roots) ⇒ isolation holds; the DB name is cosmetic. Proper multi-stack needs the launcher to read the stackId from ports.json (a code change; this card only documents).
- **status exit=1**: judge liveness by the text (see above).
- **Artifacts / evidence**: the skeleton stage lands under `.tmp/pkg/`; full evidence is `internal/A03-xihe/evidence/2026-11-18-exe-dual-instance-infra/`.

## 4. Full-stack debugging (merged from DEV-005-fullstack)

**CP logs**

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

**Runtime logs**

```bash
XIHE_RUNTIME_LOG_FILTER=xihe_runtime=debug,rmcp=info cargo run
```

**Agent logs**

Agent uses `langchain-litellm` (`ChatLiteLLM(BaseChatModel)`) as the unified LLM backend, with `litellm` automatically routing to 100+ Providers at the bottom layer. Provider switching only requires specifying in the UI settings page or environment variables:

```bash
XIHE_LLM_PROVIDER=deepseek \
XIHE_DEEPSEEK_API_KEY=your-deepseek-api-key-here \
uv run python -m xihe_agent.main
# When started directly, logs output to terminal; when started via root task, also writes to logs/agent.log by default
```

Or add Providers through the settings page: OpenAI, DeepSeek, Xiaomi MiMo, Anthropic presets + custom.

### One-shot stack verification (`mise run xihe -- verify`, PLAN-0574)

The manual v1 chain (login → session + root branch → SSE → model list → chat) also runs as one CLI command (implementation: `scripts/xihe-cli/verify.mjs`):

```bash
XIHE_VERIFY_PASSWORD=<admin password> mise run xihe -- verify \
  --stack 2 --email admin@xihe.local --workspace <wsId> --yes
```

- **Explicit target**: `--stack`, `--email` and `--workspace` are all required and missing values fail (exit 2). The CLI never falls back to the workspace from the login response (since 0614 login only returns the account's **first active** workspace, which may be null for a new account); `--yes` only confirms the execution prompt and never replaces a target flag. Without `--yes` a TTY confirmation is required.
- **Credentials**: the password comes from `XIHE_VERIFY_PASSWORD`, falling back to `XIHE_DEV_ADMIN_PASSWORD` (OS env > `.env` chain); a TTY prompt is used without echo. No password exits 2 and the token is never echoed. Generate a password with `mise run reset-admin`; it resolves the target stack as `-StackId` > `XIHE_STACK_ID` and the target database as `--url` > `XIHE_CP_DATASOURCE_URL` > `localhost:$XIHE_PG_PORT/$POSTGRES_DB` (default `12634/xihe_1`, matching the post-0533 `xihe_<n>` naming) and prints the target it used. For a stack started by `dev-stack`, the password is also persisted at `.local/dev/admin-password` (D-766, see §4 "Dev admin password auto-injection"), so no reset is required first.
- **Stack derivation**: ports come from `node scripts/stack-run.mjs env-json --stack <id>`; an unknown stack exits 2.
- **Side effects**: creates an agent principal (when the workspace has none bound), a session and a chat run, and really calls the model provider, which may incur cost. Use an isolated stack and a test workspace, and confirm the prompt first.
- **Verdict and exit codes**: tier A (CP health / login / workspace access / principal / session + branch / messages / SSE / model list / agent health) must pass; tier B keeps the original `POST /api/v1/chat` acceptance semantics (200/202 with a `runId`). `0` = A/B passed and the run reached the `succeeded` terminal state, `4` = tier A passed but tier B precondition missing, `1` = failure (including a failed run terminal), `2` = missing target/credentials or stack derivation failure, `5` = run wait timeout (`--wait-seconds`, default 120; on timeout the CLI first calls `POST /api/v1/chat/runs/{runId}/cancel` and then deletes the session it created).
- **Cleanup and residue**: on completion or failure the CLI closes SSE first and then `DELETE /api/v1/sessions/{sessionId}` for the session it created. A principal created by this run has no confirmed delete API and is retained and reported (`cleanup.principal`); pre-existing principals are never modified or deleted. Audit and provider-side records may persist.
- **Agent principal**: creating a session requires `agentPrincipalId`. The CLI resolves it as explicit `XIHE_VERIFY_AGENT_PRINCIPAL_ID` → first principal already bound to the workspace → newly created one. It only calls `PUT …/agents/{id}` right after creating a principal — that call **narrows** the workspace cap of an existing principal. Diagnostics only print whitelisted status fields, never raw agent logs.
- **Template and connection binding (PLAN-0601)**: tier B requires the session to bind an explicitly published api-request-template triple plus a chat provider connection. The CLI resolves both automatically (`GET /api/v1/config/api-request-templates?layer=user|workspace|instance` for a published template matching the connection API type; `GET /api/v1/provider-connections` for a `status=READY` `operation=chat` connection) and sends `providerConnectionId` / `modelProvider` / `modelName` / `contextTemplateLayer|Id|Version` when creating the session. A missing template reports `VERIFY_TEMPLATE_MISSING`, a missing connection reports `VERIFY_CONNECTION_MISSING` (both exit 2 with actionable guidance) instead of failing with a bare `409 API_TYPE_REBIND_REQUIRED`. Publishing a template is an ADMIN instance-layer action (Settings → Configuration → API request templates → publish).

### `dev:host` vs `dev:stack` — leases and the two meanings of `--stack` (measured 2026-11-12)

- **`dev:host`** runs the four services (CP/Agent/Runtime/UI) **in the current terminal** and **writes no `lease` / `pidFile`**; bookkeeping under `.xihe-stacks/<n>/` is written only by the detached supervisor.
- **`dev:stack`** (= `node scripts/dev-stack.mjs start`) starts **detached**, **writes the lease**, and outlives the terminal.
- **Consequence**: after a `dev:host` session, `dev-stack status` first reports **`orphan` + `lease-pid-dead`** (4/4 services listening, lease pointing at a dead pid). That is **not a fault** — run `node scripts/dev-stack.mjs acquire --stack 1` to reclaim it and get back to `healthy`.
- **One flag, two meanings (`--stack`)**:
  - `scripts/dev-stack.mjs --stack 1` ⇒ **stack number**, lease under `.xihe-stacks/1/`;
  - `scripts/cp-build-clean.mjs --stack stack-1` ⇒ **directory name**; passing `--stack 1` **silently no-ops with exit 0** and prints `nothing to prune` (`planForStack:72`, `join(root, stackId)`) — no error, no hint.

### `dev-stack` status and lease contract (PLAN-0694)

Since PLAN-0694 `node scripts/dev-stack.mjs` (verbs are documented in §3 "Mode A2: detached full stack") records **who started a stack** in a lease, and `status` cross-checks **every** lease field against a fact that is independent of the lease itself. The direction of trust is one-way: **facts beat intent** — what the lease claims does not matter until pids, ports and the heartbeat verify it ("a field nobody checks is a comment").

- **Lease location and shape**: `.xihe-stacks/<n>/lease.json` (atomic write: tmp + rename; `version: 2`). Fields = `instanceId`/`projectRoot`/`stackId`/`ports`/`pids{svc:{launcher,listener}}`/`cpVersion`/`startedAt`/`heartbeatAt`, plus `releaseFailed{at,services,reason}` when a stop was partial. Since task-75 the shape also carries an **optional** `phase` (`starting`|…). **Version policy**: `isShapedLease` compares `version` **strictly**, so a future bump to 3 makes every existing v2 lease `corrupt`, `status --all` reports all `ghost` and exits 1 — a loud rejection that is the intended behaviour; introducing v3 must relax the read side to a set membership and migrate in the same batch (which is why task-75 added `phase` **without** bumping the version). `ports` covers **only the four supervised services** (CP/Agent/Runtime/UI).
- **Exit codes**: `0` = healthy / a verification window may open (`status` passed every check; `status --all` found no non-healthy stack; `gc` found no candidates); `1` = hard problem (some stack is non-healthy, `gc` has candidates, or `stop` left residual ports/pid records); `2` = argument or environment error (unknown verb, **unknown option also exits 2**, invalid/unregistered `--stack`, derivation failure). Always parse stdout of `status --json` first and read the exit code second — `1` does not mean the tool is broken.
- **`ok = factsOk && checks.allOk`**: `factsOk` = the pid records' processes are alive + all four service ports listen + PG listens; `checks` cross-checks each field — pid incarnation (launcher liveness + listener liveness + whether the port is still held by the recorded pid — **merged into one** `lease-incarnation-stale` with old→new pids in `expected`/`actual`, `task-586`), port actually listening (`port-not-listening`), heartbeat freshness (`lease-cold`, **informational**), `instanceId` match (`instance-mismatch`), `cpVersion` match (`cp-version-mismatch`, **informational** per D-1410: CP changes its build stamp on every rebuild, so this equality is always false during active development and would be ignored anyway — the `cpBuild` section (`runningCommit`/`behind`/`verdict`) covers what it was meant to catch), declared port match (`port-declared-mismatch`) and more. Mismatches land in `mismatch[]`; a field that **is declared but cannot be verified right now** lands in `unverifiable` (also blocks `healthy`); only an **undeclared** field is `skipped` (non-blocking). No field ever passes just because the lease says so.
- **`heartbeatAt` = the time of the most recent successful verification**: `status` refreshes it when every check is green (`--json` reports `leaseRenewed` so the refresh is observable); it is **not** a self-reported uptime. `gc` is strictly read-only and never refreshes the heartbeat. An expired heartbeat is reported as `lease.state=cold` plus a P3 hint; it never changes `verdict` and never promotes a stack to `ghost`. Renewal admission is **facts verified** (four service ports listening + HTTP ready + PG), **not** fields match (`task-586`): requiring an empty `mismatch[]` meant any legitimate single-service restart froze the heartbeat forever, so `cold` became permanent and every `status` exited 1 — the other half of the self-lock described in the Chinese source. `status` re-reads the lease after a successful renewal so one screen never shows both "renewed" and a stale heartbeat.
- **PG is not in the lease `ports`**: PG is a compose resident service that the supervisor does not own the lifecycle of, so declaring it would create a field that can never verify. PG facts stay in `status.pg` (`{port, listening}`).
- **Migrating pre-upgrade stacks (not a fault)**: stacks started before this change have no lease ⇒ the first `status` / `status --all` reports `verdict: ghost` (reasons include `lease-missing`) and exits `1`. Fix it by either `node scripts/dev-stack.mjs acquire --stack <n>` (adopts the stack and writes the lease from current facts — it does **not create** pid records, it only reuses existing ones, so `ok` can stay `false` even when `verdict` is `healthy` because pid records are the factual substantiation layer) or restarting that stack once.
- **Cross-checkout ghosts**: the port space is global while the lease space is per checkout ⇒ **a live stack started by another checkout also looks like a ghost here**. `gc --dry-run` candidates therefore carry `serving` (does the service still answer on that port) and `ownTrace` (does this checkout have a lease/pid trace) to disambiguate, and you must **not** `stop` based on them alone: confirm ownership first (run `stop` in the checkout that owns it, or `acquire` it here). `gc` never kills anything and offers no `--apply` (`--dry-run` is accepted and behaviour is always dry-run).

### Dev admin password auto-injection (D-766, `dev-stack` starts)

Since D-766, `node scripts/dev-stack.mjs start` (runtime mode "Mode A2: detached full stack" in §3, or `mise run dev:stack`) **decides** the dev admin password itself and injects it into the child environment, so a manual `mise run reset-admin` is no longer a prerequisite (implementation: `scripts/lib/dev-admin-password.mjs`; **zero product-surface change** — CP still only reads `XIHE_DEV_ADMIN_PASSWORD`, PLAN-0547).

- **Source precedence** (high → low — the **B′ four-layer order**, user ruling 2026-11-11; isomorphic to Spring Boot / AWS CLI / Ansible / Docker Compose: explicit override > persisted file (truth) > packaged default): ① an explicit OS env `XIHE_DEV_ADMIN_PASSWORD` (caller/CI; **never persisted**); ② the value already persisted in `.local/dev/admin-password` (directory `0700` / file `0600`; `.local/` is gitignored) — **the persisted single source of truth**; ③ the machine's `.env` chain (`.env` → `.env.$XIHE_ENV` → `.env.local`, same semantics as CP's `DotenvLoader`, fill-gaps only) — **seed only for the first time**, not consulted when ② exists; ④ when none of the above applies, generate 24 bytes of base64url (32 chars) and persist it to ②'s path, reused stably across restarts. Blank/whitespace-only values always count as unconfigured (the empty placeholder in `.env.example` is not an empty password).
- **Injection point**: `start` writes the value into the supervisor's child env (`childEnv.XIHE_DEV_ADMIN_PASSWORD`) *before* spawning anything ⇒ CP's `DataSeeder` seeds `admin@xihe.local` with exactly that password on an **empty** database.
- **Upsert timing**: after all four services pass `waitReady` and the lease flips to `started`, it reuses the existing `scripts/reset-admin.ps1` (internally `ResetAdmin.java`) for an **UPDATE only** — `DataSeeder` **creates but never updates**, so an **existing** database only picks up the same password through this step. No new SQL. **Since BL-523 that entry point no longer self-creates the account**: when the `admin@xihe.local` row is missing it fails explicitly (exit 3) and points at `mise run dev:reset` or a stack restart so `DataSeeder` creates it (the old INSERT branch wrote `users.role`, which V89 dropped, so it always raised a SQL error; a self-created row would also lack the instance owner / SUPER_ADMIN binding).
- **Skip conditions** (each prints the reason): non-Windows (`reset-admin.ps1` is Windows-only; the hint is to run `mise run reset-admin` manually); stack not ready.
- **Failures never block the start**: a failed upsert is a WARN plus a repair command (`mise run reset-admin`, or just re-run `start`); a failed **password resolve/persist** degrades the same way — WARN plus skipped injection (neither `XIHE_DEV_ADMIN_PASSWORD` nor the upsert) — and `start` keeps going. Its exit code still depends only on the four ports becoming ready, never on a pre-spawn password read/write failure.
- **Logs never contain the value**: only `source`/`file`/`persisted` (with `value=not-logged`; since PLAN-0770 **not even `length`** — length is a derived quantity); the password reaches the entry point through the child env, **not the command line**. The reset-admin leg uses **`XIHE_RESET_ADMIN_PASSWORD`** (BL-523: inside the entry point the precedence is `stdin > env > --password`, the last one kept but deprecated with a WARN; use `--password-stdin` when you need deterministic piped input); the wrapper's `-Password` entry point has been removed entirely (D-1753 ③: passing it is rejected by parameter binding with a non-zero exit), so **no plaintext ever appears in argv**. The full conclusion and options are logged in the internal note `internal/A03-xihe/docs/BL-523-reset-admin-insert-broken.md` (cross-repo path).- **The first upsert may occupy one build slot**: if `packages/control-plane/target/reset-admin-classpath.txt` is missing or older than `pom.xml`, that upsert first runs `mvn dependency:build-classpath` — **not a compile**, but it does enter Maven, so **do not misreport it as build contention**; the cache is generated once and reused afterwards.
- **Relationship to older statements**: runtime mode A (`mise run dev:host`) does **not** take this path, so for it the "random password is not printed ⇒ scripts cannot log in" conclusion still holds (see the supersede note in the Chinese-side Mode B section); the English section carries no such claim to supersede.
- **How to check which layer a given stack is actually using (PLAN-0770 INV-3)**: `node scripts/dev-stack.mjs status --stack <n>` now prints one extra non-secret line —
  ```
  dev-admin user=admin@xihe.local source=file stack=stack-2 db=xihe_2 hasFile=true persisted=.local/dev/admin-password upsert=ok
  ```
  `--json` carries the same fields in a `devAdmin` block (`{user, source, envFile, stack, database, persistedPath, hasFile, wouldGenerate, upsert, upsertAt, upsertReason, bootSource, bootAt}`), and `node scripts/stack-run.mjs env-json --stack <n>` exposes an identical `devAdmin` block for PowerShell consumers. `source` has five values: `env` (OS env, explicit override) / `file` (`.local/dev/admin-password`, the truth) / `env-file` (the `.env` chain; the `via` suffix names the file; only when no file exists) / `generated` (generated and persisted this run — appears in `start` logs only) / `missing` (none of the three; the live view in `status`, and the **next start will generate and persist one**). `upsert`/`bootSource` report the **previous `start`'s** result (`ok`/`failed`/`skipped`/`not-run`, plus a reason; `bootSource` = the layer that start actually used), while `source` is the **live view** (which layer a new start would use now) — two different time bases, so the line appends `bootSource=…(上次起栈 <time>)` when they disagree. `status` itself never upserts (a read command must not have side effects). **None of these readings carry the value, its length, or a hash.**
- **The `.env` chain is seed-only (B′)**: once a checkout has a persisted file, **editing `.env.local` no longer takes effect** — check `source` in `status` (`file` = the file is live; `env-file` = no file yet, running off the seed). That is how "one checkout, one persisted source" is enforced; to change the password use `mise run reset-admin`, not `.env.local`. **Repair/rotation**: a successful `mise run reset-admin` (it passes `-WriteBack`) writes the **same** value back to `.local/dev/admin-password` (printing `written=<relative path>`, never the value), so the database and the file stop drifting. **Calling `scripts/reset-admin.ps1` directly does not write back by default** — `start`'s boot upsert also goes through that wrapper, so a default-on write-back would rewrite the persisted file on every boot, which is a different semantic and stays off.
- **Irreversible cleanup and reset boundaries**: `mise run dev:reset` is a dry-run by default (confirm backups and data scope before a real reset, and state the target stack and database identity before dropping a database); **`mise run clean` deletes permanently and does not go to the recycle bin** — confirm no build or service still uses the artifacts first; the `reset-admin` temporary password **must not** be written into scripts, source, or logs, and its persistent location is the gitignored `.local/dev/admin-password` (once a persisted file exists, editing `.env.local` no longer takes effect).

### First login: where the password comes from (bare CP boots, D-1753 ②)

The account `admin@xihe.local` exists but you do not know its password? Pick the branch that matches how the stack was started:

- **Stacks started via `dev:stack` / `dev-stack.mjs start`**: the single-source chain (B′) decides the password and upserts it into the database (§4 "Dev admin password auto-injection"). Read the gitignored `.local/dev/admin-password` (0600); to see which layer is live, check the `dev-admin … source=…` line in `status` (`file` = the persisted file is in effect; `env`/`env-file` = the value from that channel).
- **A bare CP boot** (`mvn spring-boot:run` / `dev:host`, with `XIHE_SEED_ADMIN=true` but no `XIHE_DEV_ADMIN_PASSWORD`): `DataSeeder` takes the random-generation branch, and **since D-1753 ② (task-62) no channel discloses that value** — the WARN in `cp.out.log` only points at the remedy, never prints the value, and this class writes no persistent file. **You must run `mise run reset-admin` to set a known password before you can log in** (it resolves the single-source chain and writes the same value back to `.local/dev/admin-password`). This is the accepted cost of "logs are a permanent-retention surface, so no value ever lands there" — **not a malfunction**. (The Chinese-side §2 carries a superseded "printed once at creation" quote; the English side never made that claim.)
- **The account row does not exist** (`reset-admin` exits 3): create it first — restart CP once with `XIHE_SEED_ADMIN=true` plus `XIHE_DEV_ADMIN_PASSWORD` (the Chinese-side §2 "first-run account creation" section owns that path) — then return to the two branches above. `reset-admin` only UPDATEs; it never self-creates the account (BL-523).

Channel discipline is unchanged: the value travels only through env (`XIHE_RESET_ADMIN_PASSWORD`) or stdin; the `-Password` argv entry point has been removed (D-1753 ③ — passing it is rejected by parameter binding), and no log or script may ever contain the value itself.

### springdoc debug surfaces (`/v3/api-docs`, `swagger-ui/**`) — OFF by default (task-244 / PLAN-0763 D-800)

`docs/api/openapi.yaml` is the single SSOT for the API wire contract; the CP's `/v3/api-docs` and Swagger UI are **debug/reconciliation artifacts** only. They are therefore **off by default** (`application.properties`: `springdoc.api-docs.enabled` / `springdoc.swagger-ui.enabled` = `${XIHE_SPRINGDOC_ENABLED:false}`), so packaged and production-facing deployments no longer expose the full route index anonymously.

- **Enabling locally (one line)**:
  - PowerShell: `$env:XIHE_SPRINGDOC_ENABLED='true'; mise run dev:host`
  - POSIX shell: `XIHE_SPRINGDOC_ENABLED=true mise run dev:host`
- **Profiles that enable it automatically**: `dev` / `e2e` / `test` (`application-{dev,e2e}.properties`, `src/test/resources/application-test.properties`). `dev:host` runs the **default profile**, so it needs the env var above or an explicit `--spring.profiles.active=dev`.
- **Why it can never substitute for the contract (architecture reason)**: springdoc is generated by runtime reflection — it reads the code, it is not an input to the contract. Measured: it **under-reports 15 routes** versus the live `RequestMappingHandlerMapping` and **does not include `/internal/**` at all** (64 of the 84 yaml-only paths are `/internal/`). "The endpoint is / is not in springdoc" therefore must never be used to judge contract completeness; parity is owned by `RouteContractParityTest`. **Where the architecture rationale lives**: in the Chinese original [`DEV-014`](../zh-Hans/DEV-014-control-plane-architecture.md) (springdoc section), which this page links to **by policy** — architecture guides are maintained as Chinese originals and English pages link to them (`en/INDEX.md`).
- **What "off" looks like**: `GET /v3/api-docs` and `/swagger-ui.html` return **404** (no handler). The three `permitAll` entries in `SecurityConfig` only matter when the surface is explicitly enabled — they are **not** a standing anonymous hole.
- **Both states measured (task-194, 2026-11-11; both columns measured, not inferred)**: a standalone CP on the default profile (`XIHE_CP_PORT=18081`, throwaway database, `stack-1` untouched), same jar, only one env differs:
  | Path | OFF (default profile) | `XIHE_SPRINGDOC_ENABLED=true` |
  | --- | --- | --- |
  | `/v3/api-docs` | **404** (RFC 9457 `not_found` body) | **200** (`{"openapi":"3.1.0"…}`) |
  | `/v3/api-docs.yaml` | **404** | **200** (YAML) |
  | `/swagger-ui/index.html` | **404** | **200** (Swagger UI) |
  | `/swagger-ui.html` | **404** | **302** → `/swagger-ui/index.html` |
  | `/actuator/health` | **200** `UP` | **200** `UP` |
  The OFF-state 404 is a **real 404 (no handler)**, not a 500 or an empty JSON body — that is the line between "the surface is absent" and "it exists but errors".
  `[source]` One correction made along the way: `/v3/api-docs.yaml` used to answer 401 in both states because `SecurityConfig`'s `permitAll("/v3/api-docs/**")` does not cover the `.yaml` suffix (`/**` needs a following segment); task-194 adds `/v3/api-docs.yaml` explicitly to permitAll and to `UiStaticServingFilter`'s bypass list.
- **Never use it as the contract or as a denominator**: it **under-reports** routes compared with the live `RequestMappingHandlerMapping` and does not include `/internal/**`; reconciliation always goes through `RouteContractParityTest` (live mapping).

## 5. Test entry points

**Test landscape**

| Module | Framework | Test Count | Run Command |
|--------|-----------|------------|-------------|
| **UI Unit** | Vitest + @vue/test-utils | 206 | `cd packages/ui && pnpm vitest run` |
| **UI E2E (Mock)** | Playwright + page.route() | 78 | `cd packages/ui && npx playwright test e2e/mock/` |
| **UI E2E (Real)** | Playwright + real CP | 132 | `cd packages/ui && npx playwright test e2e/real/` (host lane: `mise run test:e2e:host`; the compose lane is frozen) |
| **CP** | JUnit 5 + Mockito + Testcontainers | 3701 | `cd packages/control-plane && mvn test` |
| **Agent Unit** | pytest + pytest-asyncio | 150 | `cd packages/agent && uv run pytest tests/unit/ -v` |
| **Agent Integration** | pytest + httpx | — | `cd packages/agent && uv run pytest tests/integration/ -v` (requires a host CP — `XIHE_CP_PORT`, stack-1 default 12631; the compose lane is frozen) |
| **Runtime** | cargo test | 176 | `cd packages/runtime && cargo test` |
| **Cross-module E2E** | pytest + httpx | 30 | `uv run --directory packages/agent pytest tests/ -v` |

> **Counting basis (measured 2026-11-07)** — each "Test Count" cell uses exactly one of the three
> definitions below; the units are **not** interchangeable, so do not compare the numbers across rows:
>
> - **Spec files** — `UI E2E (Mock)` / `UI E2E (Real)`: number of `packages/ui/e2e/<lane>/**/*.spec.ts`
>   files (a file may hold many cases). Reproduce: `find packages/ui/e2e/real -name '*.spec.ts' | wc -l`
>   ⇒ 132; same for `e2e/mock` ⇒ 78. The same lanes contain 342 / 269 `test()` cases — a different unit,
>   deliberately not used here.
> - **Surefire cases** — `CP`: sum of `tests=` in `packages/control-plane/target/surefire-reports/*.xml`
>   from one full `mvn test`, i.e. the tail line `Tests run: 3701, Failures: 1, Errors: 0, Skipped: 2`
>   (merge tree `918e175a`, 2026-11-07, ~14 min). Count is *cases executed*, not "green cases": the single
>   failure is `MessagePaginationContractTest`, a **test-side flakiness** — the entity's `@PrePersist`
>   (`Message.java:107-109`) unconditionally overwrites the fixture `createdAt` set at `saveMessage:309`, so
>   ordering falls back to wall-clock microseconds and the string comparison in `assertAscending:355-364`
>   inverts (`.319Z` vs `.319999Z`); 7 of 8 repeat runs are green, so it is not a regression — tracked as
>   `BL-475`. The two previously registered baseline entries
>   (`ContextProjectionServiceTest.legacyHashOnlyTombstoneStillReplays` / `CpArchitectureTest`) are green now,
>   so `scripts/cp-known-baseline.json` currently lists no entries.
>   (The `test:cp:baseline` gate is BL-368 — that ID names the *gate*, not this failure.)
> - **pytest collection** — `Cross-module E2E`: collection count of the `integration`-marked cross-module
>   tests: `uv run --directory packages/agent python -m pytest --collect-only -q -m integration` ⇒ 30
>   collected. Context: the whole suite collects 1522, and the default `addopts = -m "not integration"`
>   deselects 30 (⇒ 1492 collected) — the 30 counted here are exactly those deselected items.
>
> `UI Unit`, `Agent Unit` and `Runtime` still carry older counts (206 / 150 / 176) that were **not**
> re-measured in this batch; treat them as indicative until they get the same treatment.

- **DEV-only preview page**: with the UI dev server running, open `/preview.html` (Vite multi-entry; not a product route or build entry). Its **Modal + Popover** block is the manual regression surface for overlay stacking — BaseModal backdrop vs Popover/Select z-index (PLAN-0714 / BL-518). The page calls no `/api/v1/**`; everything is mock data.

**Test directory naming convention**

Test directories are named by **test pattern**, not by functional module:

| Directory | Pattern | External Dependencies | Use Case |
|-----------|---------|----------------------|----------|
| `e2e/mock/` | 🔶 Mock | None | Quick verification of UI rendering and interaction logic |
| `e2e/real/` | 🔵 Real | Host stack (compose lane frozen) | End-to-end flows, visual regression |

> Visual regression baselines (`*-snapshots/`) are tracked directly by git, updated via `--update-snapshots` and committed. Failed test artifacts are in `test-results/` (gitignored).
| `tests/unit/` | ⚪ Unit | None | Pure logic, algorithms, component rendering |
| `tests/integration/` | 🔵 Real | Corresponding backend services | Cross-module communication, real database |

Rules:
- **Mock Tests**: Do not depend on external services; all APIs intercepted via `page.route()` or Mock objects
- **Real Tests**: Depend on the declared real backend; readiness is checked before the test with a bounded probe, and unreachable required dependencies fail the test rather than being skipped
- **No Mixed Placement**: Same directory should not contain both Mock and Real tests (`e2e/` split into mock/ and real/ for this purpose)

**Total: 756+ tests**

**Running tests**

```bash
# All quality gates via keep-going aggregator (task-176): gate cluster parallel (every gate always runs and reports its exit) then test serial tail; any red => non-zero but never 5s abort. Gates: check:mise-env + check:openapi(:lint) + check:api-docs + check:plan-anchors + check:runtime:ignored + check:commit-msg + lint + typecheck + build + e2e fixtures + lint:links, then test; no Docker step
mise run validate

# Incremental UI unit entry (task-176): related specs from git diff (changed-spec + colocated + TS-API reverse import graph; config/hub => full). Report-only, NOT in validate; full suite stays for milestones. Flags: --print-only / --full / --base / --threshold
mise run test:ui:changed

# validate + test:runtime + test:integration (no E2E; the compose E2E lane is frozen)
mise run validate:full

# Host E2E parameter semantics (`--batch` or positional args, `--llm-mode` rejected when it conflicts with the
# batch declaration, the two retry knobs, `--only`/`--check-cli`) live in DEV-020 section 3, "host runner CLI
# semantics (PLAN-0664)".

# TypeScript gates: UI vue-tsc + e2e spec typecheck (D-727; every verify window, ~20-40 s)
mise run check:types

# Individual module runs
cd packages/ui && pnpm vitest run --reporter=verbose
cd packages/agent && uv run pytest tests/ -v
cd packages/runtime && cargo test
cd packages/control-plane && mvn test
```

**CP parallel builds (task-8, 2026-11-04)**: two lanes inside the **same checkout** do **not** need another worktree - give each one its own output directory: `mvn -o -q "-Dxihe.target.dir=<absolute path>" test-compile` (the same applies to `test -Dtest=...`, whose surefire reports also land there; for example `H:/zeotmp/cp-build-a`, and a cross-volume `C:/xihe-cp-build-a` is faster).

The UI `pnpm run lint` gate runs `oxfmt --check .` followed by `oxlint .`. Oxlint enables the `typescript`, `import`, `unicorn`, and `oxc` plugins; the Vitest plugin is scoped to `src/**/__tests__/**`, `src/**/*.spec.ts`, and `src/**/*.test.ts`, where `require-mock-type-parameters` and `require-to-throw-message` are blocking and other Vitest rules remain off. The Vue plugin and template lint are outside this gate; SFC/TypeScript type checking is handled by `pnpm run typecheck` (`vue-tsc --noEmit`); `mise run check:types` additionally runs `typecheck:e2e` for the e2e specs (~20-40 s, required in every verify window, D-727; `validate`'s typecheck covers UI only). Vue template lint is a **known limitation** (only `<script>` is linted today): we wait for native oxlint support, tracking the oxc language-plugins umbrella #23207 / Phase-1 #24597 and the compatibility page; revisit when oxlint is upgraded or a real template structural defect (`v-for` missing key, duplicate attributes, etc.) appears; see PLAN-0479 decision #4. Oxfmt is pinned at 0.68.0; `.oxfmtrc.jsonc` explicitly sets `tabWidth: 4` and `printWidth: 100`, ignores Markdown and `AGENTS.md`, and leaves `proseWrap` unset to preserve the pre-config zero-drift behavior. Other style warnings remain visible but are not fatal, so a successful lint does not mean zero warnings. The full UI formatter migration completed in its dedicated wave (419 historical files normalized) and the format check is now wired into `lint`. CP's `mise run lint:cp` blocks **every** Checkstyle rule at error severity (baseline 0 violations after the rule/convention alignment wave; see PLAN-0458 evidence) — it must never be weakened back to warning or globally suppressed. **Since task-583 (2026-11-14) the same rule set is pinned to Maven's `validate` phase** (`packages/control-plane/pom.xml`, execution `checkstyle-check-early`): the earlier execution declared no explicit `<phase>` and `checkstyle:check` defaults to `verify`, so daily `mvn -o test -Dtest=X` / `mvn -o -q test-compile` never reached it and the gate never ran (measured: one deliberately unused import - the same command exited 0 in 15.4 s before and turned red in 2.7 s after, naming `file:line`). Measured cost 2.2 s; skip explicitly with `-Dcheckstyle.skip=true`. **Since task-595 (2026-11-14) `lint:cp` writes its own output directory `target-lint/`** (`-Dxihe.build.suffix=-lint`, covered by `.gitignore`'s `**/target-*/`): inside `mise run validate`, `lint:cp` and `test:cp` run their `mvn` **in parallel** (mise `depends` parallelism - measured the two sub-tasks starting and ending in the same millisecond, 2.93 s vs 4.5 s serial), so a shared directory would have both writers racing on `checkstyle-cachefile`/`checkstyle-checker.xml`/`checkstyle-result.xml`, violating "one output directory has exactly one writer"; after the split, `target/` is no longer touched by the lint task (measured: those three files' mtime unchanged). Agent's `mise run lint:agent` runs mypy as a real blocking gate over `src/` (the global `ignore_errors` switch was removed; currently 0 errors) — type errors must be fixed, never masked by global or module-wide ignores (PLAN-0459).

**Two lint regimens are not the same gate (BL-630, 2026-11-15)**: package-level `pnpm run lint` (cwd `packages/ui`) covers **only the UI package** (measured 3.4 s / 1338 files / 13199 warnings / 0 errors), while repo-root `scripts/**` (209 files) is covered by `mise run lint:scripts` (measured 23 ms, 0-error baseline), a member of the `mise run lint` aggregate. **Run `mise run lint` before wrapping up** (or at least `mise run lint:scripts`); package-level lint alone misses the root scripts — that is how the gate stayed red from 2026-11-13 to 11-15 unnoticed. Note `oxlint` discovers configuration by **cwd**, not by target file: running root scripts from `packages/ui` fails with `options.typeAware is only supported in the root config` — do not read that as “there is no gate”.

**Config-schema artifact drift gate (task-101, 2026-11-15)**: `mise run check:config-schema` (= `node packages/ui/scripts/gen-config-schema.mjs --check && node packages/ui/scripts/gen-mock-schema-catalog.mjs --check`, measured 124 ms combined) is wired into `mise run lint` via `lint.depends` in `mise.toml`. It fails (**exit 1**) when a generated artifact (`src/lib/configSchemaCatalog.ts`, `src/preview/mock/data/schema-catalog.ts`) disagrees with CP `config-schemas/*.json`, and it **names the drifted artifact**. Why it exists (D-1452 "missing coverage"): both generators already supported `--check`, but neither `mise.toml` nor `packages/ui/package.json` had an entry (grep: 0 hits), so drift was only visible by running the full `test:unit` — measured case: `31e4509ea` (02:48) changed `config-schemas/agent-runtime.json` without regenerating, leaving `configSchemaCatalog.spec` (3 cases) and `schemaCatalog.spec` (1 case) red from 02:48 to 05:35. **Covered**: artifact ↔ schema consistency (text comparison per artifact). **Not covered**: (1) `mockValues` value coverage (that is the `task-127` placeholder gate); (2) it does **not** name which schema field changed — only the drifted artifact and the regeneration command (locate it by re-running the generator and reading the diff). `gen-mock-schema-catalog.mjs` is marked DEPRECATED (`task-137-rev2`), but its output `schema-catalog.ts` is **still guarded by `schemaCatalog.spec`**, so it stays wired until retirement.

**E2E in-page bypass gate (PLAN-0687, report-only)**: `mise run check:e2e-bypass` scans `packages/ui/e2e/real/**` for `page.evaluate(...)` blocks that call `fetch(` — a browser-side call to a backend API can bypass the product UI under test. Every hit must carry a `// fixture-only: <reason>` or `// read-only: <reason>` annotation (the two allowed channels from PLAN-0644 §4.3) or be registered in `config/e2e-inpage-bypass-allowlist.json`; the gate is report-only by default and never fails on existing hits (pass `--enforce` explicitly) and is not wired into `validate`. Product behaviour exercised through in-page fetch must be fixed by driving the UI, not by annotating it away; the mock lane is out of scope. Self-test: `node --test scripts/__tests__/check-e2e-inpage-bypass.test.mjs`. See PLAN-0687 for the criteria and rulings.

**E2E static hygiene gates (task-252 + task-66)**: `mise run lint:e2e` runs `node scripts/check-e2e-timeouts.mjs` (timeout budget) **and** `node scripts/check-e2e-block-comments.mjs` (block comments that close early; measured 84 ms over 304 `.ts` files). The second gate comes from the task-62 incident: a glob path written inside a block comment contains "star immediately followed by slash", which **closes the comment early** — the tail becomes real code, typically an unterminated template string (`SyntaxError: Unterminated string constant`), so **the whole lane fails to load** (`playwright test --list` reports 0, then `No tests found`). That is not one red test, it is the suite not running at all. Two criteria: (1) a block comment whose body ends with a star; (2) EOF still inside a comment or string. The same text inside a line comment is **safe and ignored** (the first implementation used `ts.createScanner` and produced 4 false positives on clean files). The gate deliberately **does not depend on typescript**: it runs with the repo root as cwd, where typescript is only installed under `packages/ui`, so importing it would turn a static hygiene gate into a gate that only runs where the UI dependency tree exists. Mutant fixtures: `scripts/fixtures/e2e-block-comments/`; self-test: `scripts/check-e2e-block-comments.test.mjs` (wired into `mise run test:cli`).

**i18n gate (task-96, 2026-11-10)**: `mise run lint:i18n` (= `node scripts/i18n-scan.mjs`, wired into `mise run lint`) is **read-only** and checks three things: (1) the zh-CN/en-US key-set difference, (2) whether a key's `{placeholder}` set matches across locales, and (3) whether every static `t("…")` reference in the UI sources resolves on both sides. **Silent with exit 0 when clean**; exit 1 with one line per finding (category 3 names `file:line`); exit 2 when the script or repository structure itself is broken (a broken scanner is not a product defect). `-- --json` emits a structured report, `-- --root <dir>` scans another root (used by the unit-test fixtures). Why it exists: on 2026-11-10 it caught `ApprovalModal.vue` using `chat.approvalResolvedElsewhereDraftKept` while the key lives under `workspace.*` — **users saw a bare key**, and neither types, unit tests, nor rendering complained. Self-test: `node --test scripts/i18n-scan.test.mjs` (negative fixtures: missing key, placeholder drift, unresolved reference, broken structure).

**UI copy-judgment fast lane (task-172)**: `mise run check:ui-copy` (= `node scripts/check-ui-copy.mjs`, wired into `mise run lint`) runs the UI i18n judgment cluster (terminology / locale / settingsCopyRules / usageCopyRules — 4 files / 42 cases, measured ~4.75 s with the ~1.3 s vitest environment floor) at high frequency instead of waiting for the **604 s** full unit suite. Report-only by default (failures print but exit 0; a wrapper crash exits 2 and never looks green — no `|| true`); `check:ui-copy:enforce` blocks manually and is not wired — promote after two consecutive clean windows. Two more report-only members joined `mise run lint` in the same batch: `check:i18n-fixture-copies` (task-318 fixture-copy ratchet; 5 files currently beyond baseline) and `check:dev-i18n-drift` (task-316 zh/en DEV drift; the task existed but had no aggregate executor). Why it exists: the terminology violation stayed red for 22 hours — its only executor was the 604 s full suite, and validate's parallel depends aborts on first failure, so unrelated reds cut it off (measured three times on 2026-11-17, task-101/174/172). The `check:config-schema` gate (task-101) was wired the same way for the same reason.

**Env-var registration gate (task-131 → task-273 fail-closed → task-313 wiring)**: `mise run check:mise-env` (= `node scripts/check-mise-env.mjs`) scans `${XIHE_*}` usage in `packages/**/*.properties`; a variable that is neither registered in `AGENTS.md` / `xc-cross-cutting-checklist` §env 变量登记 nor in the built-in whitelist is **a WARN and exit 1** (fail-closed; a crash also stays non-zero — it may never die green). **Since task-313 (2026-11-12) it is the first entry of `validate.depends`** — milliseconds (measured: 26 files / 52 variables), so the cheapest failure comes first; before that it was already fail-closed but had **zero automatic executors**. Self-test: `node scripts/check-mise-env.mjs --selftest`.

**OpenAPI spec-level lint (task-133 → task-313 wiring)**: `mise run check:openapi:lint` (redocly) checks `$ref` resolution, `operationId` uniqueness and unused components; **wired into the `validate` gate cluster since task-313 (2026-11-12)**, right after `check:openapi` (**since task-176 the gate list lives in `scripts/validate-run.mjs` `GATES`, not in mise `depends`**). **The only gate criterion is errors (baseline 0)**: redocly exits on errors and the command sets no `--max-warnings`, so the measured **126 warnings do not block** (existing warnings remain tracked by task-245). Before 2026-11-19 four `nullable` errors in `DelegateSpawnSession` made this gate exit 1 permanently, i.e. `mise run validate` was red on `develop`; task-60 cleared them and fixed the four doc sites. Keep the four contract axes apart and never merge them: `check:openapi` (syntax + frozen slice) / `check:openapi:lint` (spec self-consistency) / `check:api-docs` (doc ↔ contract) / `RouteContractParityTest` (contract ↔ code).

**Doc gates (D-1062 10b)**: `mise run check:docs-gates` aggregates `check:docs-index` + `check:doc-bytes` + `check:md-tables` (all three run, exit non-zero if any fails, report-only). **Its executor is question ⑧ of the monitor protocol §2.1** (run manually while polling; a non-zero result is only recorded as which leg is red, how many, and owner + next action — it **never blocks polling**); it is **deliberately not wired into `validate`** (slow and dependent on other repositories' state; wiring it in would drag down every commit).

**Dialog shape gate (task-120/194, report-only)**: `mise run check:dialog-shape` (= `node packages/ui/scripts/check-dialog-shape.mjs`) statically scans dialog/sheet content-panel constraints (R1 requires `overflow-y-auto`; `max-h` alone is insufficient). **Its first line always prints "shape only does not prove reachability"** — a shape gate does not judge primary-action reachability; the real reachability criterion is `dialog-reachability-sweep.mjs` in the same directory (an **on-demand instrument**, needs the mock server + chrome-beta, registered in `gate-owner-registry.json` **D bucket**, not wired into mise/validate). **Standalone, deliberately not wired into `validate`/`lint` aggregates** (avoids the task-74 validate window cost); always exit 0, only an explicit `--enforce` blocks (revisit wiring into the ratchet after two consecutive windows with findings=0).

**DEV zh/en drift check (task-316)**: `mise run check:dev-i18n-drift` (= `node scripts/check-dev-i18n-drift.mjs`) has exactly two reliable criteria: (1) the per-document id-set **symmetric difference** for `PLAN-` / `D-` / `task-` between zh-Hans and en, and (2) **registration lookup** for those ids (`PLAN-` in `plans/`, **including `archive/`, counting both files and directories**; `D-` in the decision ledger plus its archive volumes, matched by occurrence rather than by `###` heading — many ledger rulings are list items). **The script prints its own blind spots** (negative statements / runtime task cards / relative child routes / component names and testids are not covered); **report-only, never wired into `validate`** (a red gate that gets bypassed is no gate at all, D-1046). Self-test: `-- --selftest` (9 cases).

**Four-gate wiring batch (task-923, 2026-11-24)**: four gates that were **delivered but had no executor** are wired into the `mise run lint` aggregate (`LINT_GATES` in `scripts/lint-run.mjs`, 32 → 36) in one batch. **Neither the criteria nor the baselines were touched**; all four are registered in the A bucket of `internal/A03-xihe/scripts/gate-owner-registry.json` (A 9 → 13, total 31 → 35):

- `mise run check:spawn-hide` (= `node ../internal/A03-xihe/scripts/spawn-hide-lint.mjs`, delivered by task-890): every child-process site must suppress a new console window — Node `windowsHide: true`, Rust `creation_flags(CREATE_NO_WINDOW)` / `JOB_CREATION_FLAGS` / `hide_console_window`, PowerShell `-WindowStyle Hidden` (the `&` call operator inherits the current console and is not counted). The baseline `internal/A03-xihe/scripts/spawn-hide-baseline.txt` **only shrinks**: an unregistered site ⇒ `E_SPAWN_HIDE_NEW` exit 1; a fixed site still listed ⇒ WARN plus `--write-baseline`; a structural failure (not a git work tree / missing or corrupt baseline / zero scanned files) ⇒ exit 2 — **"nothing scanned" is never treated as safe**. The only fix is to add the flag; **raising the baseline to pass is forbidden**. Self-test: `node internal/A03-xihe/scripts/spawn-hide-lint.test.mjs` (11 cases). Reading at wiring (main checkout): `scanned(node/rust/ps)=175/13/0 findings=258 baseline=255 new=5 stale=2` ⇒ **exit 1**; the five sites are named (`check-commit-msg.mjs:107/114/351`, `check-commit-msg.test.mjs:181`, `packages/ui/scripts/check-form-validation.mjs:57`) and all are real spawns missing the flag — not a registration gap ⇒ the flags belong to the follow-up cards of task-877 / task-927, this card does not reach outside its write scopes and the gate is not relaxed. This card fixed only the site it introduced: `scripts/lint-run.mjs` now passes `windowsHide: true` (once wired, the lint aggregator is one of its own checked sites — by default it flashes a console on every `mise run lint`); the two now-stale baseline entries (`scripts/lint-run.mjs:239`, `check-commit-msg.mjs:214`) are shrunk by task-890, because `spawn-hide-baseline.txt` is outside these write scopes and `--write-baseline` was not run.
- `mise run check:e2e-evidence-path` (= `node ../internal/A03-xihe/scripts/e2e-evidence-path-lint.mjs`, delivered by task-892): screenshot / write targets must not depend on a machine path or on cwd, judged **only at write-argument positions** (never "a drive letter appears somewhere in a string") — `E_EVIDENCE_MACHINE_ABSOLUTE` / `E_EVIDENCE_CWD_DEPENDENT` (a relative literal resolving to a repo path that is not gitignored) / `E_EVIDENCE_NOT_PERSISTED` (landing in an ignored path or outside the repo root) / `E_STRAY_EVIDENCE_DIR` (the `packages/ui/internal/` residue directory). The baseline `internal/A03-xihe/scripts/e2e-evidence-path-baseline.txt` only shrinks; usage or git failures ⇒ exit 2 (cannot judge ≠ pass). Self-test: `node internal/A03-xihe/scripts/e2e-evidence-path-lint.test.mjs` (8 cases). Reading at wiring: `scanned 399 files / 39 write sites ⇒ hits 23 (baseline 23 / new 0)` ⇒ exit 0 (~1.0 s).
- `mise run check:doc-count-claims` (= `node ../internal/A03-xihe/scripts/check-doc-count-claims.mjs`, delivered by task-898): pins the **unit**, not just the digits — counts `register(...)` calls in `ResourceNamespaces.java` to get N, then requires the zh/en DEV-038 §1 row to declare "N registered namespaces" and §5 to declare "N namespaces + the bare form, K rows", with the first §5 table carrying exactly K body rows. Anchors are stable phrases on the count sentences (never full-text NER): a missing anchor ⇒ exit 2 (parse failure), a mismatch — including a unit-less legacy phrase such as "5 shapes" — ⇒ exit 1. Reading at wiring: `namespaces=5 / count-claims OK` ⇒ exit 0 (~65 ms).
- `mise run check:form-validation` (= `node packages/ui/scripts/check-form-validation.mjs`, delivered by task-927): a controlled input inside a form container (`Input` / `Textarea` / `Select` bound with `v-model`) must be wired to the shared validator `packages/ui/src/lib/formValidation` (user ruling 2026-11-23: **every form input must validate immediately**, not only after submit); an unwired site is red. The stock baseline `internal/A03-xihe/evidence/2026-11-24-form-validation/baseline.json` only shrinks and `--write-baseline` **refuses to grow**; a disappeared baseline entry prints NOTE and is never silently rewritten. Reading at wiring: `files=224 controlled=110 violations=110 baseline=110` ⇒ exit 0 (~0.45 s). The same file is wired into `pnpm run lint` in the same batch (`--gate form-validation=…`, plus the standalone `pnpm run gate:form-validation`) ⇒ both the package-level and the `mise run lint` paths have an executor. **Do not add it to** `packages/ui/docs/lint-rule-registry.md`: that file is the oxlint off-rule register, and a gate name there drifts against `check-lint-rule-registry.mjs` (measured: still 0).

  ⚠️ The first three gate bodies live in **one** (`internal/A03-xihe/scripts/`) and their `run` lines use the existing `node ../internal/...` mount (same as `check:readme-symlinks` / `check:env-file-hygiene` / `check:dsd-reconcile`): correct in the main checkout, but inside an **A03 worktree slot** `<slot>/../internal` does not exist ⇒ the gate fails with MODULE_NOT_FOUND there — the same shape as `check:branch-scope` once did (its fix: locate the main checkout through `git rev-parse --git-common-dir`, see `scripts/run-branch-scope.mjs`). Making these three slot-safe needs that thin wrapper, in a separate card.

**File-panel IA gate (body delivered by task-939, executor registered by task-945, wired into the aggregate by task-951)**: `mise run check:filetree-ia` (= `node packages/ui/scripts/check-filetree-ia.mjs`) statically pins the files panel's **position contract** (component tests cannot catch "the block sits in the wrong container"): FT1 the files tab must not bring back the git-state block (`workspace-git-readface*` / `useWorkspaceGitReadState` / `getWorkspaceGitStatus`; the pending reading belongs to the Changes dock panel's pending tab), FT2 no nested-repo declare cards above the tree (`nested-repos-panel` / `nested-repo-row`), FT3 tree expansion must use `aria-expanded` and never fall back to `▼`/`▶` glyphs, FT4 the declare affordance must live inside the tree row, FT5 internal terms (Declare as root / Nested repo / …) must be zero on both locales and the owned keys must exist on both sides. `--selftest` replays eight counter-examples and each must FAIL; `--ax <workspaceUrl>` adds the real-browser reading (tree visible height >= 60% of the panel plus FT3/FT5 DOM evidence; the password is read only from `XIHE_ADMIN_PASSWORD_FILE` or `.local/dev/admin-password` and never printed). Reading at registration (2026-11-24, main checkout): static gate `[filetree-ia] PASS (FT1-FT5)` exit 0, selftest 8/8 exit 0, ~0.6 s. **Executor status (three executors since task-951)**: the standalone mise task, the `mise run lint` aggregate member (`LINT_GATES` in `scripts/lint-run.mjs` — **`--list` = 37** after wiring), and the package-level `pnpm run lint` (`--gate filetree-ia=…`, plus the standalone `pnpm run gate:filetree-ia`). **Neither the criteria nor the baselines changed**; the owner row stays in the A bucket of `internal/A03-xihe/scripts/gate-owner-registry.json`. Reading at wiring (main checkout, 2026-11-24, real `mise run lint`): `[check:filetree-ia] PASS exit=0 198ms` (the same gate takes 116 ms inside the package-level `pnpm run lint`). The counter-example points the gate's own `--root <dir>` at a seeded fixture (FT1/FT2/FT4 hit; gate body and business components untouched) ⇒ single gate exit 1; feeding the same invocation through the production aggregation code (`buildMiseArgs` / `parseTaskExits` / `aggregateExit`) names `FAIL check:filetree-ia exit=1` and the aggregate is **exit 1** while the sibling gate still runs; the repo files' sha256 are unchanged afterwards.

**CP integration test modes**

CP integration tests support two modes:

- **Local Development** (default): `AbstractH2Test` + H2 in-memory database, zero configuration, no Docker needed
- **Docker Environment**: `AbstractIntegrationTest` + Testcontainers + PostgreSQL 17

**Cross-module E2E tests**

```bash
# Prereq: host stack up in another terminal — `mise run dev:host`
# (Host stack / H2 is the current path. Full Docker Compose is frozen since 2026-10-07 — historical reference only.)

# Cross-module tests (run within Agent)
cd packages/agent
uv run --with httpx pytest tests/ -v -m integration

# Includes:
# - test_e2e_stack.py: Health check / auth chain / chat flow / module communication (16 tests)
# - test_mcp_chain.py: CP→Runtime MCP proxy chain (8 tests)
# - test_full_chat_flow.py: Register → login → chat → SSE (6 tests)
```

**MSW mock tests (UI)**

UI API integration tests use MSW (Mock Service Worker) to intercept HTTP requests. Handlers are defined in `packages/ui/src/mocks/handlers.ts`, covering auth/session/health check scenarios. MSW does not intercept EventSource (SSE); SSE tests are verified through fetch-based approach.

**Agent integration tests**

Agent integration tests (`packages/agent/tests/test_agent_cp_integration.py`) require a running CP. Read its port from `XIHE_CP_PORT` (stack-1 default `12631`; the `8080` in "Service ports" under §3 "Compose lane reference" is the container-internal port, not the host port).

```bash
# Method 1: Docker Compose (historical — compose lane frozen since 2026-10-07; not for acceptance)
docker compose up -d --build   # [frozen — historical reference only, do not run]
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

### CP GraalVM Native Image (experimental, Windows x64)

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

## 6. Rust build cache strategy

- **Configurable build-output root (task-80, 2026-11-08; supersedes "Rust build output must stay on H:")**: Rust build output no longer has to live on the H: volume. `XH_CARGO_TARGET_ROOT` (the machine value lives in the gitignored `mise.local.toml` — on one dev box that reads e.g. `G:\zeolib\cargo-target`; no machine path is committed) relocates the whole cargo target family; the primary checkout gets `<root>/{main,stack-N,e2e}`, a linked worktree gets `<root>/<worktree-dir>/…` (so two lanes running the same stack id do not each overwrite the other's exe — the BL-221 failure mode). Precedence: `CARGO_TARGET_DIR` (`worktree-env.ps1` / manual) > `XH_CARGO_TARGET_ROOT` > old derivation `<one>/.tmp/cargo-target`; **unset ⇒ byte-for-byte the pre-080 behavior** (regression asserted in `scripts/lib/stack-cargo-target.test.mjs`). A relative or non-existent root makes the scripts **fail fast** instead of silently building on the old volume. To change the drive use `mise.local.toml` (gitignored, outranks `mise.toml`; exporting the variable in a shell does **not** win under `mise run` — measured 2026-11-08, mise `[env]` overrides the parent environment). **Scope:** mise cargo tasks that run through `scripts/cargo-run.mjs` land on `<root>`; **bare `cargo` that bypasses the wrapper, plus the IDE/rust-analyzer, still write the H: volume per `.cargo/config.toml`** (`target-dir = "../.tmp/cargo-target/main"` is deliberately kept; see below). **Net effect: the dev stacks, E2E, and wrapper-backed mise tasks no longer add H: usage; bare `cargo` and the IDE still do.**
>
> **Wrapper (task-80 batch 2, 2026-11-08):** every `mise.toml` task that called cargo directly (`build:runtime` / `test:runtime` / `test:runtime:lib` / `test:runtime:lib:gate` / `test:runtime:lib:ignored:isolated|functional` / `lint:runtime` / `clean:runtime-sweep`) now calls `node scripts/cargo-run.mjs <cargo args…>`. Three hard rules keep it transparent: ① `spawnSync('cargo', args, { stdio: 'inherit' })` — cargo's stdout/stderr is never captured or rewritten; ② the exit code is passed through verbatim (`process.exit(status)`, signal-kill → 1); ③ it injects `<root>/[<worktree-dir>/]main` only when `XH_CARGO_TARGET_ROOT` is set and `CARGO_TARGET_DIR` is not, and the key comes from `scripts/lib/stack-cargo-target.mjs` (no second derivation) — with the variable unset the behavior is byte-identical to bare cargo. `cargo fetch` stays bare (writes `CARGO_HOME`, not the target dir). **Evidence:** `mise run test:runtime:lib` cold-built in 65.4 s into `<root>/plan-0631-t32/main` (3364 files / 1.33 GB; measured against the then-current machine root) while `.worktrees\.tmp\cargo-target` kept its old mtime; with `XH_CARGO_TARGET_ROOT=''` the same task's `cargo metadata` still reports the old H: path (nothing injected).
- **Default: one `CARGO_TARGET_DIR` per worktree (PLAN-0596).** Inside the ONE workspace, the ONE-side worktree convention externalizes it under `one/.tmp/cargo-target/<name>` (and `UV_PROJECT_ENVIRONMENT` under `one/.tmp/venvs/<name>`); a standalone clone keeps the in-tree default. Do not point several worktrees at the same target: concurrent builds serialize on the target lock, and on Windows a running service holds the exe, so the other worktree's build fails.
- **Measured (2026-10-31 scratch):** two checkouts with identical source/profile shared one target: second cold build 48.9s → **0.3s**, disk 2×2.606GB → **2.606GB**. The benefit only applies when source/toolchain/profile match; real parallel branches differ, so the default stays isolated (user acceptance would be required to change it).
- **Sweep scope:** `mise run clean:runtime-sweep` only touches the single target resolved by the current `cargo metadata` (under `mise run` = the wrapper-injected `<root>/[<worktree-dir>/]main`; in a plain shell = in-tree or the external dir from the ONE-side convention); it never scans other projects under `.local/cargo-target`. `--maxsize 12GB` is interpreted as MiB (≈11.18 GiB).
- **Permanent delete:** `mise run clean` runs `rm -rf logs packages/*/target packages/*/dist packages/*/coverage` with **no recycle bin and no prompt**; stop builds/services and confirm those are rebuildable artifacts first. Treat caches as "delete and rebuild", not cross-drive backup.

## 7. Module version bump (PLAN-0534)

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

## 8. Commit messages, the worktree pool, and development data (task-93)

Policy criteria stay in `AGENTS.md`; this section keeps the measurable readings and the boundaries for when detail is needed.

### 8.1 Commit-message gate

- The gate rules and the flip measurement live in §3 "Mode D" (last bullet) and `scripts/check-commit-msg.mjs`; this section adds the **first-line bans**: no emoji, no trailing period, and do not start with "update/modify/adjust/optimize/handle/improve/tidy" — say what changed. Put the body after a blank line.
- Suggested body sections `Why:` / `What:` / `Verify:` / `Risk:`; describe why and how it was verified, do not repeat the diff.
- **Validate the branch itself before merging**: `node scripts/check-commit-msg.mjs --range develop..<branch> --enforce`. The gate only reads history on develop, so over-wide or unreferenced commits inside a branch surface after the merge (this happened once in 2026-11-06 and was explicitly exempted through `scripts/commit-msg-allowlist.json`). The allowlist only accepts committed facts already on develop that cannot be rewritten; every entry needs a reason and bulk back-filling is forbidden.
- Historical commits are exempt by default via `--since 1dd57056`.

### 8.2 Worktree pool: local measurement and incident

- **Measured on this machine (2026-11-05)**: `git worktree add` on the H: volume takes **470 seconds** and can leave **0 MB half-finished directories** when the checkout never completes; **34** worktrees were created that day and **14** of them were empty leftovers.
- ⇒ Isolated PLAN execution in A03 always reuses an existing pool slot (the order between "resident module-branch slot" and "task slot" is owned by the `worktree-lifecycle` skill); a new worktree is allowed **only when the whole pool is busy and the user explicitly authorises it**, and it **must be registered in the pool table** (`.local/xh-d28/worktree-pool.md`) in the same batch.
- **Do not** substitute the Kilo / Agent Manager worktree mode (a different mechanism; corrected again by the user on 2026-10-14).

### 8.3 Development-data policy (D-215)

- **Criterion**: XH is not released, so development data in local/isolated stacks is disposable ⇒ a schema change may **drop and rebuild the database** (`mise run dev:reset` or delete the DB and re-run Flyway) with **no backfill script, no dual read/write, no grey-release switch, and no "old and new snapshots side by side" compatibility branch**, and "row-count comparison" is not an acceptance criterion.
- **Three boundaries**: ① development data only (lane / isolated stack / dev stack); ② user-visible release artifacts, backups, `.local/evidence/` evidence, and repository history are excluded; ③ before dropping a database you must state the **target stack and database identity** (so another lane is never wiped by mistake), and an irreversible action must be preceded by a line saying which databases will be dropped.

