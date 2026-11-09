---
title: DEV-033 - First Run (Gold Path)
category: dev-guide
sidebar_order: 33
lang: en
sidebar_group: "Developer Guide"
status: active
created: 2026-11-01
updated: 2026-11-10
---

# DEV-033: First Run (Gold Path)

> **What this is**: the shortest verifiable path from a **blank instance** to the **first assistant reply**. Every command points at a concrete task in `mise.toml`; every "what success looks like" criterion points at a concrete assertion in `packages/ui/e2e/real/goldpath-first-run.spec.ts` (mapping in §5.2).
>
> **Evidence scope**: the **6-round fresh-stack matrix** in `plans/PLAN-0614-XH-first-run-blank-start/evidence/m3-goldpath.md` §3 (`goldpath` ×3 = 9 passed / 4 skipped; `goldpath-closed` ×3 = 5 passed / 8 skipped; 0 failed / 0 flaky / 0 did-not-run) **plus one independent Lead rerun** (`goldpath` = 9 passed / 4 skipped). Anything outside that matrix is listed in §5.3; this document claims nothing more.

## 1. Prerequisites

| Item | Requirement | Source |
|---|---|---|
| Toolchain | Node 24 / pnpm 10 / Python 3.14 / uv / Java 25 / Maven 3.9 / Rust 1.97.1, pinned by `mise install` | `mise.toml:23-30` (`[tools]`) |
| Docker | **PostgreSQL only**. Service containerisation and the `xihe/workspace` image build are frozen — do not `docker compose up` the whole stack | `mise.toml:1-16` (freeze note) |
| Directory | **Any directory** works (single clone); no longer "must live inside the `one/` workspace" | `mise run check:standalone` (`mise.toml:395`) verifies "no dependency on the one root" |
| Ports | stack-1: UI 12630 / CP 12631 / Agent 12632 / Runtime 12633 / PG 12634 | `scripts/lib/stack-ports.mjs:20` (port source of truth) |
| Workspace | **A fresh instance has no workspace at all**: neither register nor login creates one; the first step is the user creating one (§3 step 2 / §4 step 1) | `AuthController.withFirstWorkspace` (`AuthController.java:137,165,196-201`) |

Two operating modes, pick by purpose:

1. **Single dev stack + the seeded admin login (newcomer default)**: one `dev:host` (or `dev:stack`) stack; the first-run account is created by CP `DataSeeder` (`admin@xihe.local`) and you drive §3/§4 from its login. Password sources: see §3.
2. **Isolated E2E stack (replaying the §5 matrix)**: `scripts/e2e-host.mjs` creates its own PG container and random ports (27xxx block) per round — see §5.4.

> **Local mode (`XIHE_LOCAL_MODE`) is abandoned (option A, 2026-11-10)**: not a first-run path, and no enabling support is offered. It still appears in §3/§5 only because the §5 matrix runs `goldpath-first-run.spec.ts` on the `--first-run=local` lane — what is kept there is **regression evidence**. Historical design and residual risks live in the internal archive `internal/A03-xihe/docs/localmode-enablement.md` (`status: deprecated`).

## 2. Start

```powershell
mise install
mise run setup            # mise.toml:32 (UI/Agent/CP/Runtime dependencies)
mise run dev:host         # mise.toml:275 (PostgreSQL container first, then CP/Agent/Runtime/UI in parallel)
mise run dev:host:check   # mise.toml:307 (optional read-only preflight: tools, Docker, ports, host root)
```

- `dev:host` **does not import config and does not create a Provider Connection** (`mise.toml:280`). Use `mise run dev:host:import-config` (`mise.toml:290`) or `mise run dev:host:provider-init` (`mise.toml:296`) explicitly when needed.
- Stop: `mise run dev:host:stop` (`mise.toml:317`).
- Another port block (parallel stacks): `mise run dev:stack -- --stack 2` (`mise.toml:285`); slot table in DEV-002 "Mode D".

## 3. First run (sign in as the seeded dev admin → blank start)

**"Blank instance" means no workspace, not no account**: at startup, in **non**-local mode, `DataSeeder` creates `admin@xihe.local` and — in the same transaction — binds it as instance owner + `SUPER_ADMIN` (`DataSeeder.java:65-89`). So a first run needs neither registration nor the (abandoned) local mode.

Where the password comes from depends on how you started the stack:

| Start path | Password source |
|---|---|
| `mise run dev:stack` (mode A2, `scripts/dev-stack.mjs start`) | injected by D-766: (1) `XIHE_DEV_ADMIN_PASSWORD`, (2) a value already in the `.env` chain, (3) a persisted `.local/dev/admin-password`, (4) first run generates 24 bytes base64url and persists it to that path; logs print only `source`/`length`/`file`, **never the value** (`scripts/lib/dev-admin-password.mjs`; details in [DEV-002](DEV-002-developer-guide.md) §4 "dev admin password auto-injection") |
| `mise run dev:host` (mode A) | **not** covered by D-766: `DataSeeder` uses a random password it never prints ⇒ after the stack is up, run `mise run reset-admin` once (BL-523: password via stdin or `XIHE_RESET_ADMIN_PASSWORD`; it exits 3 when the account row is missing, pointing at `mise run dev:reset` or a restart so `DataSeeder` creates it) |

Steps:

1. Open `http://localhost:12630/login` and sign in as `admin@xihe.local` with the password from above (`POST /api/v1/auth/login` 200).
2. You land on `/workspace` in its **empty state**: a "create your first workspace" button, zero workspace entries, `GET /api/v1/workspaces` returns an **empty array**, `AuthResponse.workspaceId` is **`null`** (`AuthController.withFirstWorkspace`, the same path register and login use).
3. That account is instance owner + `SUPER_ADMIN` (`InstanceOwnershipService.ensureAssigned` / `GrantDefaultService.ensureInstanceSuperAdmin`, seeded at `DataSeeder.java:86-89`), so **no self-grant step** is needed to manage Agents or settings.

> **Registration is no longer the first-run path**: `/onboarding` still works outside local mode (the form carries a **password**; omitting it returns **400 `INVALID_REQUEST`**, `AuthController.java:113-119`), but **registration grants neither instance owner nor `SUPER_ADMIN`** — both seeds run only on the local-mode branch (`AuthController.java:126-136`, gated on `XIHE_LOCAL_MODE=true`, and local mode is abandoned). To make a registered account an instance admin, use the grant surface instead of turning local mode back on.

> **Local mode (`XIHE_LOCAL_MODE`) is abandoned (option A, 2026-11-10)**: it is no longer a recommended first-run path and no enabling support is offered. The original four-condition gate, single-user count, prod fail-fast and residual risks are all preserved in the internal archive `internal/A03-xihe/docs/localmode-enablement.md` (`status: deprecated`).

> **There is no "system-created workspace" any more**: register / login / `local-login` / `refresh` only *read* the account's first active workspace; they never create one (`AuthController.withFirstWorkspace`). Existing accounts are unaffected (their first workspace is still returned). This also removes the old **BL-171** defect (first run landing in a "chat always fails" default workspace) — the first step is now the user choosing a directory.

> **Local mode exempts the registration policy (historical)**: `AuthController.register` only calls `registrationPolicy.requireOpen()` when local mode is **off** (`AuthController.java:108-110`). So "the first account can still register while `closed`" is by design, not a defect; the same exemption also lets a second account register on that instance. **That exemption goes away with local mode** — it is only observable on the §5 E2E lane now (criterion and boundaries in §5.3 item 2).

## 4. From the empty state to the first reply

1. **Create the first workspace**: click "create your first workspace" (`workspace-picker-create`) in the empty state → the real creation dialog opens:
   - Pick storage mode **`direct_attach`** (`workspace-storage-direct`). `managed_import` uses the docker execution backend, which is frozen/unavailable and is rejected by CP (`409 BACKEND_DISABLED`, see [DEV-014 (zh)](../zh-Hans/DEV-014-control-plane-architecture.md) §8b).
   - Enter the **host directory** (`workspace-source-path`) → "read directory" (`workspace-source-read`) → confirm the browser (`workspace-source-browser`) → "use this directory" (`workspace-source-use`).
   - The execution mode comes from the **capability preflight**: use `windows-mxc` when available, otherwise `windows-host` (host execution requires acknowledging the risk).
2. **Submit** → `POST /api/v1/workspaces` **201** → the URL becomes `/workspace/<newId>` and the workspace view shows "no files yet" (`workspace-empty-state`).
3. **Create an Agent and bind it**: workspace → "Agent management" → create (`201`) → bind to this workspace (`200`).
4. **Create a session**: "New chat" → pick the bound Agent → `201` → lands on `/workspace/<ws>/chat/<session>` with the composer visible.
5. **Send one message**: `POST /api/v1/chat` returns `200/202` plus a `runId`; an assistant bubble follows.
6. **Reload**: the messages are still there (persistence).

Models and connections:

- For a manual first run, either use a fake/local provider, or create a chat connection in settings first (`POST /api/v1/provider-connections` → `201`, then verify until `READY`).
- A session must pin "connection + request-template triple (`contextTemplateLayer/Id/Version`)". The **UI** sets it when creating a session; a **direct API** caller must send it, otherwise `409 API_TYPE_REBIND_REQUIRED`.

## 5. What success looks like

### 5.1 Eight visible criteria

> **How to read this (since 2026-11-10)**: C1 / C4 / C5 are the criteria of the **E2E local-mode lane** (`--first-run=local`); they exist to keep the §5.2 spec assertions honest — local mode is **abandoned** and is no longer the first-run path (first run: §3). C2 / C3 / C6 / C7 / C8 are lane-independent: empty state, `direct_attach` workspace, instance-owner privileges, session, first reply.

| # | What you should see | How to confirm |
|---|---|---|
| C1 | First visit lands on `/onboarding` and the form has **no password input** | URL `…/onboarding?redirect=…`; heading "开始使用"; only email/name inputs; submit disabled |
| C2 | After submit you land on the **empty-state first screen** (no workspace at all) | A "create your first workspace" button is shown; workspace entry count is **0**; `initialized` became true |
| C3 | Clicking it **creates the first workspace and enters it** | The creation dialog appears (directory selectable, source path readable); after submit the URL becomes `/workspace/<uuid>` with "no files yet"; on mobile the same state shows after expanding the file tree |
| C4 | A brand-new browser context re-enters **without the login form** | No `/login`, no identifier/password inputs, yet the client holds a server-issued token |
| C5 | After logout, opening `/workspace` re-enters **passwordlessly** | No login form; lands on either a workspace view or the picker (both acceptable, see §5.3); `GET /auth/me` 200 |
| C6 | The first account is already top-privileged: **no grant step** before "Agent management" | Admin nav entry visible; permissions include `instance:super`; Agent-management dialog opens |
| C7 | Create Agent → bind → create session, and the **composer appears** | Agent create 201, bind 200; session 201 with `…/chat/<session>`; `chat-input` visible |
| C8 | One message yields an **assistant bubble that survives reload** | Left-aligned assistant message with non-empty text and no inline error block; after reload ≥2 messages and the session item is still there |

Also covered, outside C1–C8: C9 a connection verifies `READY` and the fake model becomes selectable.

### 5.2 Criterion → spec assertion mapping

| Criterion | Spec case (line) | Key assertions (line) |
|---|---|---|
| C1 | `G1-a` (`goldpath-first-run.spec.ts:492`) | `bootstrap.localMode===true` (:497), URL matches `/onboarding?redirect=` (:502), heading "开始使用" (:503), `#email`/`#name` visible (:506-507), `#password` count 0 (:508), submit disabled (:509) |
| C2 | `G1-b` (:515) | register **201** (:535), `initialized===true` (:536), **`workspace-picker-empty` visible** (:544), **`workspace-picker-create` visible** (:545), **`workspace-picker-item-*` count 0** (:547), token present (:548), `isInstanceSuper` (:555), `nav-rail-settings` visible (:558) |
| C3 | `G1-b2` (:561) | empty state visible (:573), create dialog visible (:577), `workspace-source-browser` visible (:586), preflight 200 (:599), backend available (:607), create 200/201 (:622), URL `/workspace/<id>` (:626), `workspace-empty-state` visible (:629), mobile tab same assertion (:639) |
| C4 | `G1-c` (:648) | `#identifier` count 0 (:662), token non-empty (:663) |
| C5 | `G1-d` (:669) | `#identifier` count 0 (:681), token non-empty (:719), `/auth/me` 200 (:721); landing recorded in the `goldpath-g1d-landing` annotation (any of the three states: empty / entries / workspace view) |
| C6 | `G2-b` (:786) | `isInstanceSuper` (:782/:794), permissions 200 (:800) containing `instance:super` (:802), `nav-rail-admin` visible (:804), Agent-management dialog (:814) and grant-panel link (:817) |
| C7 | `G2-c` (:807) + `G2-d` (:851) | Agent 201 (:832), principal id shape (:834), unbound list contains the id (:835), bind 200 (:844); session 201 (:873), URL `…/chat/<session>` (:874), `chat-input` visible (:877) |
| C8 | `G2-e` (:880) | chat 200/202 (:937) with non-empty `runId` (:938), assistant bubble visible (:943), non-empty text (:944-949), `message-error` count 0 (:950), ≥2 messages after reload (:955-961), session item visible (:962) |
| C9 (supplementary) | `G3-a` (:977) / `G3-b` (:1043) | connection 201 (:1026), verify succeeds (:1034), label visible (:1040); `model-item-*` visible (:1055-1058) |

**Criteria without test backing: 0.** The `409 API_TYPE_REBIND_REQUIRED` note in §4 and the 503/409/404 rows in §6 are **troubleshooting entries**, not "success criteria", so they need no assertion mapping (the 503 copy is exactly the G4-a fixme topic — see §5.3).

### 5.3 Known boundaries (read this before calling anything a regression)

1. **The two G4 cases are `test.fixme`, and the host lane does not even collect them**: `G4-a` (:1069-1082, BL-152 readable failure copy) and `G4-b` (:1085-1092, F-09 connection → Agent ready) live in the `@gap` describe (:1068), while the host Playwright config is `grep: /@host/` (`packages/ui/e2e/playwright.config.ts:42`) ⇒ they are **neither passing nor skipped — they never enter the run list**; `--grep "@gap"` is overridden by the config grep. Running them needs a config change or a separate lane (not in this batch).
2. **Local mode exempts the registration policy (the G1-e reading)**: `G1-e` (:724) asserts `bootstrap-status` 200 (:741) + `localMode=true` (:742) + a **second registration returning 201** (:754) — **not** "second registration 403". Rationale in §3; proving the strict 403 needs a **non-local-mode** stack (not done in this batch). (Added 2026-11-10: that exemption goes away with local mode and is only observable on the E2E lane.)
3. **BL-169 (ruled: the local-mode passwordless context write is intentional)**: on passwordless auto-login the guard writes the tab workspace context (`router/index.ts` → `resolveLocalModeLanding`), so C5 may land on a **workspace view** instead of the picker; the case therefore accepts any of the three states. The exception is documented in `packages/ui/AGENTS.md` (I6 exception, `ef73ae12`). (Added 2026-11-10: with local mode abandoned the exception loses its justification; it is recorded as a residual risk in `localmode-enablement.md` §3.6.)
4. **BL-170 (fixed, shipped with 0614 M2)**: the guard-written session used to skip Pinia ⇒ right after passwordless entry the first paint lacked the admin entry and config/session preload was skipped. Fixed by `stores/auth.ts#adoptGuardSession` (`:146`), the guard adopting that session, and `App.vue` awaiting `router.isReady()` (`39e6f093`). C6 depends on this fix.
5. **BL-171 (closed by PLAN-0614)**: the old behaviour created a `managed_import` + docker default workspace on registration; once the docker backend became frozen/unavailable, the first chat failed structurally. PLAN-0614's blank start **removes that path** (no auto-created workspace); the user's first step is choosing a `direct_attach` directory. This document no longer describes a "default workspace".
6. **BL-172 (fixed, with a regression guard)**: the workspace picker could hang on "loading" after a bounce (early return never reset loading + the bounce did not clear the context ⇒ bounce loop). Fixed in `WorkspacePicker.vue` (`clearTabWorkspace()` / loading reset) and `WorkspaceView.vue`, guarded by 2 unit tests.
7. **BL-174 (delete-authorization rule)**: `DELETE /api/v1/workspaces/{id}` is a **capability check** — `WS_OWNER` ∪ `cap:workspace:admin`; the **content atom `delete` is not a credential** (`WS_EDITOR` may delete files, but deleting the workspace returns 403 `WORKSPACE_FORBIDDEN`). Details in [DEV-014 (zh)](../zh-Hans/DEV-014-control-plane-architecture.md) §8b.

### 5.4 Replaying the matrix (E2E lane)

```powershell
# Fresh isolated stack per round; PG container + random ports, torn down afterwards
node scripts/e2e-host.mjs --batch=goldpath --retries=0
node scripts/e2e-host.mjs --batch=goldpath-closed --retries=0
# Equivalent mise entry (single spec / manual flags)
mise run test:e2e:host -- e2e/real/goldpath-first-run.spec.ts   # mise.toml:181
```

The runner's three gold-path flags (`scripts/e2e-host.mjs:438-440`; all **off** by default, so existing batches keep their behaviour):

| Flag | Semantics | Default |
|---|---|---|
| `--first-run=local` | empty DB + `XIHE_LOCAL_MODE=true` + `SERVER_ADDRESS=127.0.0.1`, **no seeded admin**. **Local mode is deprecated**: the flag survives only for e2e compatibility, and `local` is still the only value the runner accepts | off |
| `--bootstrap-user=register\|none` | `register` = the runner registers the first account and imports the fake LLM profile with it; `none` = let the spec register | `none` |
| `--registration-policy=open\|closed` | injects `XIHE_AUTH_REGISTRATION_POLICY` (local mode still exempts the first account) | `open` |

The four batches (`scripts/e2e-batches.jsonc:144-175`):

| Batch | Contents | Why cases are skipped |
|---|---|---|
| `goldpath-first-run` | all of G1 (virgin DB) | none expected: the stack is empty, so G1-a..e run (the `closed` variant is `goldpath-closed`) |
| `goldpath` | G1-b2 + G1-d + G2 + G3 (G4 fixmes not collected) | 4 skips: G1-a/G1-b/G1-c are virgin cases (the stack was bootstrapped by `--bootstrap-user=register`) + G1-e needs the closed policy. **9 cases run** |
| `goldpath-closed` | G1-a/G1-b/G1-b2/G1-d/G1-e | 8 skips: G1-c needs virgin + G2/G3 need the account lane. **5 cases run** |
| `goldpath-web` (optional, not in smoke) | single case via `--grep G2-e` (~1.5 min) | observe two rounds before deciding whether it joins `smoke` |

**Measured (raw output in `m3-goldpath.md` §3)**: `goldpath` ×3 = 9 passed / 4 skipped (22.9s / 22.9s / 24.9s), `goldpath-closed` ×3 = 5 passed / 8 skipped (9.2s / 8.8s / 11.2s); all exit 0, 0 failed / 0 flaky / 0 did-not-run, teardown left no residue; plus one independent Lead rerun of `goldpath` = 9 passed / 4 skipped. Nothing beyond that is claimed.

### 5.5 Screenshot references (7 shots, produced by the same assertions)

> The shots were taken on the **local-mode lane** (`--first-run=local`) in 2026-11: the email+name-only, password-less form in `01-onboarding.png` is that lane's shape. Local mode is abandoned; see the §5.1 note for how to read the criteria.

Screenshot directory (outside the A03 repo; open as needed): [t5.2-screenshots](../../../../plans/archive/PLAN-0611-XH-first-run-goldpath/evidence/t5.2-screenshots/)

| File | Criterion / case | What it shows |
|---|---|---|
| `01-onboarding.png` | C1 / `G1-a` | The `/onboarding` form: email + name only, submit disabled |
| `02-empty-picker.png` | C2 / `G1-b` | Empty-state first screen: "create your first workspace", zero entries |
| `03-create-workspace-dialog.png` | C3 / `G1-b2` | Creation dialog with the source path already read |
| `04-workspace-view.png` | C3 / `G1-b2` | Inside the new workspace, "no files yet" |
| `05-agent-session.png` | C7 / `G2-c` | Agent created + bound |
| `06-first-reply.png` | C8 / `G2-e` | The first assistant reply bubble |
| `07-mobile-workspace.png` | C3 mobile tab (390×844) | Same empty workspace after expanding the file tree |

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `dev:host` fails to come up, ports busy | 12630-12634 occupied by another stack/process | `mise run dev:host:check` (`mise.toml:307`); or use another slot via `--stack 2` |
| CP exits at startup complaining local mode needs loopback | `XIHE_LOCAL_MODE=true` without `SERVER_ADDRESS=127.0.0.1` (or `XIHE_ENV=prod`) | satisfy all three conditions (archive `localmode-enablement.md` §1). **Local mode is deprecated**: you only meet this on the §5 E2E lane or in the historical archive |
| After login you get a blank screen with no workspace | **Expected** (since 0614 no workspace is auto-created) | click "create your first workspace" (§4 step 1) |
| The creation dialog cannot read the directory | the path is not a Runtime-visible host directory, or the backend is unavailable | use a real host directory; call `POST /api/v1/workspaces/capabilities/preflight` first and read `reason` when `available=false` |
| Creating a workspace returns `409 BACKEND_DISABLED` | `managed_import` selected (docker backend frozen) | switch to `direct_attach` |
| Sending a message returns `503 LLM_NOT_CONFIGURED` | no usable model/connection (`missing_credentials`) | create a connection and verify to `READY`; this is exactly the G4-a status quo (BL-152), not a failure of this path |
| Sending returns `409 API_TYPE_REBIND_REQUIRED` | the session did not pin "connection + template triple" | create the session through the UI, or send the triple explicitly via API |
| `POST /local-login` returns 404 | non-loopback origin, or not a single-user instance (the gate fails closed with 404) | open via `127.0.0.1`/`localhost`; confirm the instance has exactly one login-capable account. **`/local-login` is deprecated with local mode** (kept in code for the E2E lane only); use `/login` for a first run |
| The workspace picker sits on "loading" forever | old BL-172 symptom (fixed) | upgrade to a build containing `39e6f093`; if it still reproduces, capture evidence per §5.3 item 6 |

## 7. How this relates to USER-001 / DEV-002

| Document | Owns | Deliberately not repeated here |
|---|---|---|
| **This one (DEV-033)** | blank instance → first workspace → first reply; the spec assertion behind each criterion; the first-run lane (runner flags / four batches / screenshots) | module architecture, ops CLI, the full configuration surface |
| [USER-001](USER-001-user-guide.md) | day-to-day usage once you have an account (chat, multimodal, MCP tools, members, settings) | §1.4 keeps registration/login and points at this document's "blank-instance first run" |
| [DEV-002](DEV-002-developer-guide.md) | the full environment setup, run modes A/B/C/D, full-stack debugging, test entry points | no duplicated first-run criteria; "Mode A" links here |

Terminology follows [DEV-032](DEV-032-terminology.md); this document introduces no new terms. "Local mode" is the code/env literal `localMode` (`XIHE_LOCAL_MODE`, **abandoned** as of 2026-11-10; this document only uses the term in the §5 E2E-lane context); "first run / gold path" names the blank-instance → first-reply path taken from the PLAN-0611 title, defined once here and not spread as a second name. Everything else (`bootstrap-status`, `SUPER_ADMIN`, `direct_attach`, `managed_import`; `workspace-picker-*` are test-id literals) already exists in the repository vocabulary.
