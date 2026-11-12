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

### 2.2. Install Dependencies

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

# mock-lane S1 smoke (29 spec files; measured 106 passed / 1 flaky / 2 skipped, 95 s wall, --workers=4,
# headless). No backend needed. XIHE_UI_PORT is REQUIRED: playwright.config.ts defaults to 12630, which
# sits inside the verification-window forbidden range 12630-12633, so unset or in-range exits 2.
mise run test:mock:smoke
# test:mock (full mock lane, same config, all spec files) ALREADY EXISTS and was NOT measured in this
# round — TODO: record wall time / test counts / red count from a real run before quoting numbers.
mise run test:mock

# read-only ledger (BL/PLAN) validation, run from the ONE workspace root; report-only (not part of `validate`)
mise run ledger:validate

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

### 2.4. Runtime Modes

CP (Control Plane) supports two runtime modes:

#### Mode A: Docker Compose Full Stack (one-shot baseline — frozen since 2026-10-07; NOT the daily path)

```bash
# [frozen 2026-10-07 — do not run; daily work uses `mise run dev:host`, isolated E2E uses `mise run test:e2e:host`]
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

**Note**: Under WSL2 mirror network mode, host connections to Docker PostgreSQL may fail password authentication. This is because the `bridge` network's port mapping causes NAT translation of the connection source address, and the `127.0.0.1/32 trust` rule in `pg_hba.conf` doesn't match. If you encounter this issue, use **Option B1 (H2)** or reach PostgreSQL on the host directly (`mise run dev:host` keeps only PostgreSQL in a container, so the host-side port is the one that matters). **Mode A (Full Docker Compose) is frozen since 2026-10-07** and stays historical reference only.

`.env.dev` file records two database configurations (PostgreSQL is default, H2 is commented out). Uncomment to switch.

**Startup order (PLAN-0632 T4.4)**: in `dev:host`, cp/runtime/ui still start in parallel, but the **Agent waits for CP readiness first** — `dev:host:wait-for-cp` polls `/actuator/health` until 200 (**budget is path-layered**: reuse-of-built-classes **60 s**; rebuild path (stale/missing/dirty ⇒ this start runs `clean compile` first) defaults to **240 s**; override both paths with `XIHE_WAIT_FOR_CP_TIMEOUT`, the rebuild path only with `XIHE_WAIT_FOR_CP_REBUILD_TIMEOUT`); on timeout it **fails loudly and prints the CP log path** instead of starting the Agent into `degraded` (the old behaviour burned ~2.8 s of startup config sync for nothing). Starting the Agent on its own still works via `mise run dev:host:start:agent` (it carries the wait).

#### Parallel host stacks (PLAN-0533)

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
- **Commit-message gate (2026-11-06)**: `mise run check:commit-msg` **now blocks** and is a dependency of `mise run validate` (D-216 measured at the flip, 2026-11-06 02:02: 32 commits since `a632de77`, 0 violations). Rules: first line `<type>(<scope>): <summary>`; **summary display width ≤72 columns (CJK counts as 2, ≈36 Han chars), merge ≤100**; non-merge commits must reference `PLAN-####`/`BL-###`/`D-###`. Shell script `scripts/check-commit-msg.mjs` (`--file` for hooks, `--range` for review, `--stats` for the window, `--report-only` for the old never-fails audit; blocking is the default) — the `mise` task runs `--enforce` and gates `validate`; enable a local hook with `git config core.hooksPath scripts/hooks`. The flip to blocking is decided by **commit count** (D-213: **≥30 commits** since `a632de77`, 12 h cap, whichever first; violation rate ≤10% with zero over-wide merges). Two different numbers by nature: 30 is the criterion threshold, 32 is the sample measured at the flip.

#### Detached full-stack supervisor (PLAN-0603)

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
- **Dev admin password auto-injection (D-766)**: `start` resolves, persists and injects the dev admin password itself, then upserts it into the database once the four services are ready; source precedence, skip conditions and the log contract are in §4.11 "Dev admin password auto-injection".

#### Packaged product (PLAN-0632, `pkg:launcher` / `pkg:installer`)

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

#### Rust build cache and worktree isolation (PLAN-0596)

- **Configurable build-output root (task-80, 2026-11-08; supersedes "Rust build output must stay on H:")**: Rust build output no longer has to live on the H: volume. `XH_CARGO_TARGET_ROOT` (the machine value lives in the gitignored `mise.local.toml` — on one dev box that reads e.g. `G:\zeolib\cargo-target`; no machine path is committed) relocates the whole cargo target family; the primary checkout gets `<root>/{main,stack-N,e2e}`, a linked worktree gets `<root>/<worktree-dir>/…` (so two lanes running the same stack id do not each overwrite the other's exe — the BL-221 failure mode). Precedence: `CARGO_TARGET_DIR` (`worktree-env.ps1` / manual) > `XH_CARGO_TARGET_ROOT` > old derivation `<one>/.tmp/cargo-target`; **unset ⇒ byte-for-byte the pre-080 behavior** (regression asserted in `scripts/lib/stack-cargo-target.test.mjs`). A relative or non-existent root makes the scripts **fail fast** instead of silently building on the old volume. To change the drive use `mise.local.toml` (gitignored, outranks `mise.toml`; exporting the variable in a shell does **not** win under `mise run` — measured 2026-11-08, mise `[env]` overrides the parent environment). **Scope:** mise cargo tasks that run through `scripts/cargo-run.mjs` land on `<root>`; **bare `cargo` that bypasses the wrapper, plus the IDE/rust-analyzer, still write the H: volume per `.cargo/config.toml`** (`target-dir = "../.tmp/cargo-target/main"` is deliberately kept; see below). **Net effect: the dev stacks, E2E, and wrapper-backed mise tasks no longer add H: usage; bare `cargo` and the IDE still do.**
>
> **Wrapper (task-80 batch 2, 2026-11-08):** every `mise.toml` task that called cargo directly (`build:runtime` / `test:runtime` / `test:runtime:lib` / `test:runtime:lib:gate` / `test:runtime:lib:ignored:isolated|functional` / `lint:runtime` / `clean:runtime-sweep`) now calls `node scripts/cargo-run.mjs <cargo args…>`. Three hard rules keep it transparent: ① `spawnSync('cargo', args, { stdio: 'inherit' })` — cargo's stdout/stderr is never captured or rewritten; ② the exit code is passed through verbatim (`process.exit(status)`, signal-kill → 1); ③ it injects `<root>/[<worktree-dir>/]main` only when `XH_CARGO_TARGET_ROOT` is set and `CARGO_TARGET_DIR` is not, and the key comes from `scripts/lib/stack-cargo-target.mjs` (no second derivation) — with the variable unset the behavior is byte-identical to bare cargo. `cargo fetch` stays bare (writes `CARGO_HOME`, not the target dir). **Evidence:** `mise run test:runtime:lib` cold-built in 65.4 s into `<root>/plan-0631-t32/main` (3364 files / 1.33 GB; measured against the then-current machine root) while `.worktrees\.tmp\cargo-target` kept its old mtime; with `XH_CARGO_TARGET_ROOT=''` the same task's `cargo metadata` still reports the old H: path (nothing injected).
- **Default: one `CARGO_TARGET_DIR` per worktree.** Inside the ONE workspace, the ONE-side worktree convention externalizes it under `one/.tmp/cargo-target/<name>` (and `UV_PROJECT_ENVIRONMENT` under `one/.tmp/venvs/<name>`); a standalone clone keeps the in-tree default. Do not point several worktrees at the same target: concurrent builds serialize on the target lock, and on Windows a running service holds the exe, so the other worktree's build fails.
- **Measured (2026-10-31 scratch):** two checkouts with identical source/profile shared one target: second cold build 48.9s → **0.3s**, disk 2×2.606GB → **2.606GB**. The benefit only applies when source/toolchain/profile match; real parallel branches differ, so the default stays isolated (user acceptance would be required to change it).
- **Sweep scope:** `mise run clean:runtime-sweep` only touches the single target resolved by the current `cargo metadata` (under `mise run` = the wrapper-injected `<root>/[<worktree-dir>/]main`; in a plain shell = in-tree or the external dir from the ONE-side convention); it never scans other projects under `.local/cargo-target`. `--maxsize 12GB` is interpreted as MiB (≈11.18 GiB).
- **Permanent delete:** `mise run clean` runs `rm -rf logs packages/*/target packages/*/dist packages/*/coverage` with **no recycle bin and no prompt**; stop builds/services and confirm those are rebuildable artifacts first. Treat caches as "delete and rebuild", not cross-drive backup.

### 2.5. Configuration Management (PLAN-042)

#### Architecture Overview

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
- **Runtime target guard**: before starting services, `dev:host` runs `mise run check:runtime-target`; the watch level only prints, while the FORCE line (≥20 GB, or H: free <5 GB) blocks startup. The script also prints one line `default-stack runtime binary: … classification=present|migrated-away|unverifiable` (JSON field `runtimeBinary`): **a missing binary is a legal post-migration state** (`migrated-away` = a root is configured but that root has no `main/debug/xihe-runtime.exe` yet, back on the next build/restart; `unverifiable` = no root configured and no binary at any known root). It is **informational only and never changes `verdict` or the exit code** — the check must not report a failure for something that was legitimately moved away.
- **LLM readiness prerequisite**: without an imported `llm-provider` profile the Agent reports `llmReady=missing_credentials` and `POST /api/v1/chat` returns 503 `LLM_NOT_CONFIGURED`; `POST /api/v1/config/import?layer=instance` accepts **plain JSON only** (strip the line comments from `config.import.local.jsonc`, or just use the CLI above).
- **Scripted path, three points**: a new session already owns a root branch (`POST /sessions/{id}/branches` is fork semantics requiring `sourceBranchId` + `anchorMessageId` — reuse the root branch instead); `POST /api/v1/chat` requires an active SSE subscription for the session first (otherwise 409 `SSE_SUBSCRIPTION_REQUIRED`); Bearer tokens live only 900s, so keep the `reset-admin` → `login` token in a temp file and refresh it per batch (never in the repo).

The CLI is an operator entry point. It calls CP's authenticated HTTP API for Provider Connections; Agent execution continues to use its own lease/protocol path. The real E2E key is injected directly into the isolated Agent process and does not test a Provider Connection lease.

`--api-key-env` reads a variable already present in the CLI process. An interactive terminal prompts without echo when needed; non-interactive tasks must inject the environment variable. The CLI entry point **fills missing keys** from the `.env` → `.env.$XIHE_ENV` → `.env.local` chain (PLAN-0547 `loadEnvFileChain`; an existing OS env value is never overwritten by a file); secrets are still read only from env or a TTY, never from argv, logs, or reports.

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

Agent integration tests (`packages/agent/tests/test_agent_cp_integration.py`) require a running CP. Read its port from `XIHE_CP_PORT` (stack-1 default `12631`; the `8080` in "Service ports" under §5.1 is the container-internal port, not the host port).

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
>   (`Message.java:98-100`) unconditionally overwrites the fixture `createdAt` set at `saveMessage:309`, so
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

### 4.2. Test Directory Naming Convention

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

### 4.3. Running Tests

```bash
# All quality gates (check:openapi + check:api-docs + check:commit-msg + lint + typecheck + build + test + e2e fixture self-tests + lint:links; no Docker step)
mise run validate

# validate + test:runtime + test:integration (no E2E; the compose E2E lane is frozen)
mise run validate:full

# TypeScript gates: UI vue-tsc + e2e spec typecheck (D-727; every verify window, ~20-40 s)
mise run check:types

# Individual module runs
cd packages/ui && pnpm vitest run --reporter=verbose
cd packages/agent && uv run pytest tests/ -v
cd packages/runtime && cargo test
cd packages/control-plane && mvn test
```

The UI `pnpm run lint` gate runs `oxfmt --check .` followed by `oxlint .`. Oxlint enables the `typescript`, `import`, `unicorn`, and `oxc` plugins; the Vitest plugin is scoped to `src/**/__tests__/**`, `src/**/*.spec.ts`, and `src/**/*.test.ts`, where `require-mock-type-parameters` and `require-to-throw-message` are blocking and other Vitest rules remain off. The Vue plugin and template lint are outside this gate; SFC/TypeScript type checking is handled by `pnpm run typecheck` (`vue-tsc --noEmit`); `mise run check:types` additionally runs `typecheck:e2e` for the e2e specs (~20-40 s, required in every verify window, D-727; `validate`'s typecheck covers UI only). Vue template lint is a **known limitation** (only `<script>` is linted today): we wait for native oxlint support, tracking the oxc language-plugins umbrella #23207 / Phase-1 #24597 and the compatibility page; revisit when oxlint is upgraded or a real template structural defect (`v-for` missing key, duplicate attributes, etc.) appears; see PLAN-0479 decision #4. Oxfmt is pinned at 0.68.0; `.oxfmtrc.jsonc` explicitly sets `tabWidth: 4` and `printWidth: 100`, ignores Markdown and `AGENTS.md`, and leaves `proseWrap` unset to preserve the pre-config zero-drift behavior. Other style warnings remain visible but are not fatal, so a successful lint does not mean zero warnings. The full UI formatter migration completed in its dedicated wave (419 historical files normalized) and the format check is now wired into `lint`. CP's `mise run lint:cp` blocks **every** Checkstyle rule at error severity (baseline 0 violations after the rule/convention alignment wave; see PLAN-0458 evidence) — it must never be weakened back to warning or globally suppressed. Agent's `mise run lint:agent` runs mypy as a real blocking gate over `src/` (the global `ignore_errors` switch was removed; currently 0 errors) — type errors must be fixed, never masked by global or module-wide ignores (PLAN-0459).

**E2E in-page bypass gate (PLAN-0687, report-only)**: `mise run check:e2e-bypass` scans `packages/ui/e2e/real/**` for `page.evaluate(...)` blocks that call `fetch(` — a browser-side call to a backend API can bypass the product UI under test. Every hit must carry a `// fixture-only: <reason>` or `// read-only: <reason>` annotation (the two allowed channels from PLAN-0644 §4.3) or be registered in `config/e2e-inpage-bypass-allowlist.json`; the gate is report-only by default and never fails on existing hits (pass `--enforce` explicitly) and is not wired into `validate`. Product behaviour exercised through in-page fetch must be fixed by driving the UI, not by annotating it away; the mock lane is out of scope. Self-test: `node --test scripts/__tests__/check-e2e-inpage-bypass.test.mjs`. See PLAN-0687 for the criteria and rulings.

**i18n gate (task-96, 2026-11-10)**: `mise run lint:i18n` (= `node scripts/i18n-scan.mjs`, wired into `mise run lint`) is **read-only** and checks three things: (1) the zh-CN/en-US key-set difference, (2) whether a key's `{placeholder}` set matches across locales, and (3) whether every static `t("…")` reference in the UI sources resolves on both sides. **Silent with exit 0 when clean**; exit 1 with one line per finding (category 3 names `file:line`); exit 2 when the script or repository structure itself is broken (a broken scanner is not a product defect). `-- --json` emits a structured report, `-- --root <dir>` scans another root (used by the unit-test fixtures). Why it exists: on 2026-11-10 it caught `ApprovalModal.vue` using `chat.approvalResolvedElsewhereDraftKept` while the key lives under `workspace.*` — **users saw a bare key**, and neither types, unit tests, nor rendering complained. Self-test: `node --test scripts/i18n-scan.test.mjs` (negative fixtures: missing key, placeholder drift, unresolved reference, broken structure).

### 4.4. CP Integration Test Modes

CP integration tests support two modes:

- **Local Development** (default): `AbstractH2Test` + H2 in-memory database, zero configuration, no Docker needed
- **Docker Environment**: `AbstractIntegrationTest` + Testcontainers + PostgreSQL 17

### 4.5. Cross-module E2E Tests

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

### 4.6. MSW Mock Tests (UI)

UI API integration tests use MSW (Mock Service Worker) to intercept HTTP requests. Handlers are defined in `packages/ui/src/mocks/handlers.ts`, covering auth/session/health check scenarios. MSW does not intercept EventSource (SSE); SSE tests are verified through fetch-based approach.

### 4.7. One-shot stack verification (`mise run xihe -- verify`, PLAN-0574)

The manual v1 chain (login → session + root branch → SSE → model list → chat) also runs as one CLI command (implementation: `scripts/xihe-cli/verify.mjs`):

```bash
XIHE_VERIFY_PASSWORD=<admin password> mise run xihe -- verify \
  --stack 2 --email admin@xihe.local --workspace <wsId> --yes
```

- **Explicit target**: `--stack`, `--email` and `--workspace` are all required and missing values fail (exit 2). The CLI never falls back to the workspace from the login response (since 0614 login only returns the account's **first active** workspace, which may be null for a new account); `--yes` only confirms the execution prompt and never replaces a target flag. Without `--yes` a TTY confirmation is required.
- **Credentials**: the password comes from `XIHE_VERIFY_PASSWORD`, falling back to `XIHE_DEV_ADMIN_PASSWORD` (OS env > `.env` chain); a TTY prompt is used without echo. No password exits 2 and the token is never echoed. Generate a password with `mise run reset-admin`; it resolves the target stack as `-StackId` > `XIHE_STACK_ID` and the target database as `--url` > `XIHE_CP_DATASOURCE_URL` > `localhost:$XIHE_PG_PORT/$POSTGRES_DB` (default `12634/xihe_1`, matching the post-0533 `xihe_<n>` naming) and prints the target it used. For a stack started by `dev-stack`, the password is also persisted at `.local/dev/admin-password` (D-766, see §4.11), so no reset is required first.
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

### 4.10. `dev-stack` status and lease contract (PLAN-0694)

Since PLAN-0694 `node scripts/dev-stack.mjs` (verbs are documented in §2.4 "Detached full-stack supervisor") records **who started a stack** in a lease, and `status` cross-checks **every** lease field against a fact that is independent of the lease itself. The direction of trust is one-way: **facts beat intent** — what the lease claims does not matter until pids, ports and the heartbeat verify it ("a field nobody checks is a comment").

- **Lease location and shape**: `.xihe-stacks/<n>/lease.json` (atomic write: tmp + rename; `version: 2`). Fields = `instanceId`/`projectRoot`/`stackId`/`ports`/`pids{svc:{launcher,listener}}`/`cpVersion`/`startedAt`/`heartbeatAt`, plus `releaseFailed{at,services,reason}` when a stop was partial. `ports` covers **only the four supervised services** (CP/Agent/Runtime/UI).
- **Exit codes**: `0` = healthy / a verification window may open (`status` passed every check; `status --all` found no non-healthy stack; `gc` found no candidates); `1` = hard problem (some stack is non-healthy, `gc` has candidates, or `stop` left residual ports/pid records); `2` = argument or environment error (unknown verb, **unknown option also exits 2**, invalid/unregistered `--stack`, derivation failure). Always parse stdout of `status --json` first and read the exit code second — `1` does not mean the tool is broken.
- **`ok = factsOk && checks.allOk`**: `factsOk` = the pid records' processes are alive + all four service ports listen + PG listens; `checks` cross-checks each field — pid liveness (`launcher-dead`/`listener-dead`), port actually listening (`port-not-listening`), heartbeat freshness (`lease-expired`), `instanceId` match (`instance-mismatch`), `cpVersion` match (`cp-version-mismatch`), pid drift (`pid-drift`), declared port match (`port-declared-mismatch`) and more. Mismatches land in `mismatch[]`; a field that **is declared but cannot be verified right now** lands in `unverifiable` (also blocks `healthy`); only an **undeclared** field is `skipped` (non-blocking). No field ever passes just because the lease says so.
- **`heartbeatAt` = the time of the most recent successful verification**: `status` refreshes it when every check is green (`--json` reports `leaseRenewed` so the refresh is observable); it is **not** a self-reported uptime. `gc` is strictly read-only and never refreshes the heartbeat. An expired heartbeat only downgrades `healthy` to `stale`; it never promotes a stack to `ghost`.
- **PG is not in the lease `ports`**: PG is a compose resident service that the supervisor does not own the lifecycle of, so declaring it would create a field that can never verify. PG facts stay in `status.pg` (`{port, listening}`).
- **Migrating pre-upgrade stacks (not a fault)**: stacks started before this change have no lease ⇒ the first `status` / `status --all` reports `verdict: ghost` (reasons include `lease-missing`) and exits `1`. Fix it by either `node scripts/dev-stack.mjs acquire --stack <n>` (adopts the stack and writes the lease from current facts — it does **not create** pid records, it only reuses existing ones, so `ok` can stay `false` even when `verdict` is `healthy` because pid records are the factual substantiation layer) or restarting that stack once.
- **Cross-checkout ghosts**: the port space is global while the lease space is per checkout ⇒ **a live stack started by another checkout also looks like a ghost here**. `gc --dry-run` candidates therefore carry `serving` (does the service still answer on that port) and `ownTrace` (does this checkout have a lease/pid trace) to disambiguate, and you must **not** `stop` based on them alone: confirm ownership first (run `stop` in the checkout that owns it, or `acquire` it here). `gc` never kills anything and offers no `--apply` (`--dry-run` is accepted and behaviour is always dry-run).

### 4.11. Dev admin password auto-injection (D-766, `dev-stack` starts)

Since D-766, `node scripts/dev-stack.mjs start` (runtime mode "Detached full-stack supervisor" in §2.4, or `mise run dev:stack`) **decides** the dev admin password itself and injects it into the child environment, so a manual `mise run reset-admin` is no longer a prerequisite (implementation: `scripts/lib/dev-admin-password.mjs`; **zero product-surface change** — CP still only reads `XIHE_DEV_ADMIN_PASSWORD`, PLAN-0547).

- **Source precedence** (high → low — the **B′ four-layer order**, user ruling 2026-11-11; isomorphic to Spring Boot / AWS CLI / Ansible / Docker Compose: explicit override > persisted file (truth) > packaged default): ① an explicit OS env `XIHE_DEV_ADMIN_PASSWORD` (caller/CI; **never persisted**); ② the value already persisted in `.local/dev/admin-password` (directory `0700` / file `0600`; `.local/` is gitignored) — **the persisted single source of truth**; ③ the machine's `.env` chain (`.env` → `.env.$XIHE_ENV` → `.env.local`, same semantics as CP's `DotenvLoader`, fill-gaps only) — **seed only for the first time**, not consulted when ② exists; ④ when none of the above applies, generate 24 bytes of base64url (32 chars) and persist it to ②'s path, reused stably across restarts. Blank/whitespace-only values always count as unconfigured (the empty placeholder in `.env.example` is not an empty password).
- **Injection point**: `start` writes the value into the supervisor's child env (`childEnv.XIHE_DEV_ADMIN_PASSWORD`) *before* spawning anything ⇒ CP's `DataSeeder` seeds `admin@xihe.local` with exactly that password on an **empty** database.
- **Upsert timing**: after all four services pass `waitReady` and the lease flips to `started`, it reuses the existing `scripts/reset-admin.ps1` (internally `ResetAdmin.java`) for an **UPDATE only** — `DataSeeder` **creates but never updates**, so an **existing** database only picks up the same password through this step. No new SQL. **Since BL-523 that entry point no longer self-creates the account**: when the `admin@xihe.local` row is missing it fails explicitly (exit 3) and points at `mise run dev:reset` or a stack restart so `DataSeeder` creates it (the old INSERT branch wrote `users.role`, which V89 dropped, so it always raised a SQL error; a self-created row would also lack the instance owner / SUPER_ADMIN binding).
- **Skip conditions** (each prints the reason): non-Windows (`reset-admin.ps1` is Windows-only; the hint is to run `mise run reset-admin` manually); stack not ready.
- **Failures never block the start**: a failed upsert is a WARN plus a repair command (`mise run reset-admin`, or just re-run `start`); a failed **password resolve/persist** degrades the same way — WARN plus skipped injection (neither `XIHE_DEV_ADMIN_PASSWORD` nor the upsert) — and `start` keeps going. Its exit code still depends only on the four ports becoming ready, never on a pre-spawn password read/write failure.
- **Logs never contain the value**: only `source`/`file`/`persisted` (with `value=not-logged`; since PLAN-0770 **not even `length`** — length is a derived quantity); the password reaches the entry point through the child env, **not the command line**. The reset-admin leg uses **`XIHE_RESET_ADMIN_PASSWORD`** (BL-523: inside the entry point the precedence is `stdin > env > --password`, the last one kept but deprecated with a WARN; use `--password-stdin` when you need deterministic piped input); the `-Password` parameter is merely converted to env by the wrapper, so **no plaintext ever appears in argv**. The full conclusion and options are logged in the internal note `internal/A03-xihe/docs/BL-523-reset-admin-insert-broken.md` (cross-repo path).- **The first upsert may occupy one build slot**: if `packages/control-plane/target/reset-admin-classpath.txt` is missing or older than `pom.xml`, that upsert first runs `mvn dependency:build-classpath` — **not a compile**, but it does enter Maven, so **do not misreport it as build contention**; the cache is generated once and reused afterwards.
- **Relationship to older statements**: runtime mode A (`mise run dev:host`) does **not** take this path, so for it the "random password is not printed ⇒ scripts cannot log in" conclusion still holds (see the supersede note in the Chinese-side Mode B section); the English section carries no such claim to supersede.
- **How to check which layer a given stack is actually using (PLAN-0770 INV-3)**: `node scripts/dev-stack.mjs status --stack <n>` now prints one extra non-secret line —
  ```
  dev-admin user=admin@xihe.local source=file stack=stack-2 db=xihe_2 hasFile=true persisted=.local/dev/admin-password upsert=ok
  ```
  `--json` carries the same fields in a `devAdmin` block (`{user, source, envFile, stack, database, persistedPath, hasFile, wouldGenerate, upsert, upsertAt, upsertReason, bootSource, bootAt}`), and `node scripts/stack-run.mjs env-json --stack <n>` exposes an identical `devAdmin` block for PowerShell consumers. `source` has five values: `env` (OS env, explicit override) / `file` (`.local/dev/admin-password`, the truth) / `env-file` (the `.env` chain; the `via` suffix names the file; only when no file exists) / `generated` (generated and persisted this run — appears in `start` logs only) / `missing` (none of the three; the live view in `status`, and the **next start will generate and persist one**). `upsert`/`bootSource` report the **previous `start`'s** result (`ok`/`failed`/`skipped`/`not-run`, plus a reason; `bootSource` = the layer that start actually used), while `source` is the **live view** (which layer a new start would use now) — two different time bases, so the line appends `bootSource=…(上次起栈 <time>)` when they disagree. `status` itself never upserts (a read command must not have side effects). **None of these readings carry the value, its length, or a hash.**
- **The `.env` chain is seed-only (B′)**: once a checkout has a persisted file, **editing `.env.local` no longer takes effect** — check `source` in `status` (`file` = the file is live; `env-file` = no file yet, running off the seed). That is how "one checkout, one persisted source" is enforced; to change the password use `mise run reset-admin`, not `.env.local`. **Repair/rotation**: a successful `mise run reset-admin` (it passes `-WriteBack`) writes the **same** value back to `.local/dev/admin-password` (printing `written=<relative path>`, never the value), so the database and the file stop drifting. **Calling `scripts/reset-admin.ps1` directly does not write back by default** — `start`'s boot upsert also goes through that wrapper, so a default-on write-back would rewrite the persisted file on every boot, which is a different semantic and stays off.

## 5. Deployment

### 5.1. Docker Compose (frozen 2026-10-07 — one-shot baseline, historical reference only)

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

### 6.4 springdoc debug surfaces (`/v3/api-docs`, `/swagger-ui/**`) — OFF by default (task-244 / PLAN-0763 D-800)

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
