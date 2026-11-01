---
title: DEV-033 - First Run (Gold Path)
category: dev-guide
sidebar_order: 33
lang: en
sidebar_group: "Developer Guide"
status: active
created: 2026-11-01
updated: 2026-11-01
---

# DEV-033: First Run (Gold Path)

> **What this is**: the shortest verifiable path from a **blank instance** to the **first assistant reply**. Every command points at a concrete task in `mise.toml`; every "what success looks like" criterion points at a concrete assertion in `packages/ui/e2e/real/goldpath-first-run.spec.ts` (mapping in §5.2).
>
> **Evidence scope**: the **6-round matrix** in `plans/PLAN-0611-XH-first-run-goldpath/evidence/m1-m2.md` §8.8 (`goldpath` ×3 = 8 passed / 4 skipped; `goldpath-closed` ×3 = 4 passed / 8 skipped; 0 failed / 0 flaky). What that matrix does **not** cover is listed in §5.3; this document does not claim more than it.

## 1. Prerequisites

| Item | Requirement | Source |
|---|---|---|
| Toolchain | Node 24 / pnpm 10 / Python 3.14 / uv / Java 25 / Maven 3.9 / Rust 1.97.1, pinned by `mise install` | `mise.toml:23-30` (`[tools]`) |
| Docker | **PostgreSQL only**. Service containerisation and the `xihe/workspace` image build are frozen — do not `docker compose up` the whole stack | `mise.toml:1-16` (freeze note) |
| Directory | **Any directory** works (single clone); no longer "must live inside the `one/` workspace" | `mise run check:standalone` (`mise.toml:395`) verifies "no dependency on the one root" |
| Ports | stack-1: UI 12630 / CP 12631 / Agent 12632 / Runtime 12633 / PG 12634 | `scripts/lib/stack-ports.mjs:20` (port source of truth) |

Two operating modes, pick by purpose:

1. **Local mode (newcomer default)**: one `dev:host` stack with `XIHE_LOCAL_MODE=true`, empty database, drive §3/§4 in the browser.
2. **Isolated E2E stack (replaying the §5 matrix)**: `scripts/e2e-host.mjs` creates its own PG container and random ports (27xxx block) per round — see §5.4.

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

## 3. First run (local-mode onboarding)

**All three conditions are required**; otherwise CP refuses to start (`LocalModeService.java:49-64`):

1. `XIHE_LOCAL_MODE=true`
2. CP bound to loopback: `SERVER_ADDRESS=127.0.0.1`
3. `XIHE_ENV` is not `prod`

Steps:

1. Open `http://localhost:12630/workspace` → a blank instance redirects to `/onboarding?redirect=…`.
2. The form has only **email** and **name** — **no password field** (local mode is passwordless); the submit button stays disabled while empty.
3. Submit → `POST /api/v1/auth/register` returns **201** and lands on `/workspace/<uuid>`; `GET /api/v1/bootstrap-status` flips `initialized` from `false` to `true`.
4. In local mode that account holds instance-level `SUPER_ADMIN` (the 0610 access-role model), so **no self-grant step** is needed to manage Agents or settings.

> **localMode exempts the registration policy**: `AuthController.register` only calls `registrationPolicy.requireOpen()` when local mode is **off**. So "the first account can still register while `closed`" is by design, not a defect; the same exemption also lets a second account register on that instance (criterion and boundaries in §5.3).

## 4. First reply

1. **Create the workspace as `direct_attach`** (pick a host directory; execution `windows-host` or `windows-mxc`). Do not use the default `managed_import`: it pins the docker execution backend, which is treated as frozen/unavailable (`AGENTS.md`, 2026-10-31 ruling; boundary in §5.3 BL-171).
2. **Create an Agent and bind it**: workspace → "Agent management" → create (`201`) → bind to this workspace (`200`).
3. **Create a session**: "New chat" → pick the bound Agent → `201` → lands on `/workspace/<ws>/chat/<session>` with the composer visible.
4. **Send one message**: `POST /api/v1/chat` returns `200/202` plus a `runId`; an assistant bubble follows.
5. **Reload**: the messages are still there (persistence).

Models and connections:

- For a manual first run, either use a fake/local provider, or create a chat connection in settings first (`POST /api/v1/provider-connections` → `201`, then verify until `READY`).
- A session must pin "connection + request-template triple (`contextTemplateLayer/Id/Version`)". The **UI** sets it when creating a session; a **direct API** caller must send it, otherwise `409 API_TYPE_REBIND_REQUIRED`.

## 5. What success looks like

### 5.1 Seven visible criteria

| # | What you should see | How to confirm |
|---|---|---|
| C1 | First visit lands on `/onboarding` and the form has **no password input** | URL `…/onboarding?redirect=…`; heading "开始使用" (Getting started); only email/name inputs |
| C2 | After submit you are inside a **concrete workspace** and `initialized` became true | URL becomes `/workspace/<uuid>`; empty workspace shows "no files yet" |
| C3 | A brand-new browser context re-enters **without the login form** | No `/login` in the URL, no identifier/password inputs, yet the client holds a server-issued token |
| C4 | After logout, opening `/workspace` re-enters **passwordlessly** | No login form; lands on the workspace picker **or** a workspace view; `GET /auth/me` returns 200 |
| C5 | The first account is already top-privileged: **no grant step** before "Agent management" | Admin nav entry visible; permissions include `instance:super`; Agent-management dialog opens |
| C6 | Create Agent → bind → create session, and the **composer appears** | Agent create 201, bind 200; session 201 with `…/chat/<session>`; `chat-input` visible |
| C7 | One message yields an **assistant bubble that survives reload** | Left-aligned assistant message appears with non-empty text and no inline error block; after reload the message count is ≥2 |

### 5.2 Criterion → spec assertion mapping

| Criterion | Spec case (line) | Key assertions (line) |
|---|---|---|
| C1 | `G1-a` (`goldpath-first-run.spec.ts:432`) | `bootstrap.localMode===true` (:437), URL matches `/onboarding?redirect=` (:442), heading "开始使用" (:443), `#email`/`#name` visible (:446-447), `#password` count 0 (:448), submit disabled (:449) |
| C2 | `G1-b` (:452) | register **201** (:472), `initialized===true` (:473), `workspace-empty-state` visible (:479), token present (:480), `isInstanceSuper===true` (:484), `nav-rail-settings` visible (:487) |
| C3 | `G1-c` (:490) | `#identifier` count 0 (:503), token non-empty (:504) |
| C4 | `G1-d` (:510) | `#identifier` count 0 (:522), token non-empty (:563), `/auth/me` 200 (:565); landing recorded in the `goldpath-g1d-landing` annotation (picker item **or** workspace view, either is accepted) |
| C5 | `G2-b` (:630) | `isInstanceSuper` (:626/:638), permissions contain `instance:super` (:646), `nav-rail-admin` visible (:648), Agent-management dialog and grant-panel link visible (:655-658) |
| C6 | `G2-c` (:651) + `G2-d` (:689) | Agent 201 (:673), unbound list contains the id (:676), bind 200 (:685); session 201 (:710), URL `…/chat/<session>` (:711), `chat-input` visible (:714) |
| C7 | `G2-e` (:717) | chat 200/202 (:774) with non-empty `runId` (:775), assistant bubble visible (:780), non-empty text (:781-786), `message-error` count 0 (:787), message count ≥2 after reload (:789-795), session item visible (:796) |

Also covered, outside C1–C7: C8 a connection verifies `READY` and the fake model becomes selectable — `G3-a` (:811; 201 at :859, verify at :867, label visible at :873) and `G3-b` (:876; `model-item-*` visible at :890-893).

### 5.3 Known boundaries (read this before calling anything a regression)

1. **The two G4 cases are `test.fixme`, and the host lane does not even collect them**: `G4-a` (:902-915, BL-152 readable failure copy) and `G4-b` (:918-925, F-09 connection → Agent ready) live in the `@gap` describe (:901), while the host Playwright config is `grep: /@host/` (`packages/ui/e2e/playwright.config.ts:42`) ⇒ they are **neither passing nor skipped — they never enter the run list**. `--grep "@gap"` does not help (the config grep wins). Running them needs a config change or a separate lane (not in this batch). Source: `m1-m2.md` §8.8.
2. **localMode exempts the registration policy (the C5/G1-e reading)**: `G1-e` (:568) asserts `bootstrap-status.localMode===true` (:586) + a **second registration returning 201** (:598) plus an annotation — **not** "second registration 403". Rationale in §3; proving the strict 403 needs a **non-localMode** stack (not done in this batch).
3. **BL-169 (spec assumption was wrong, not a product defect)**: the local-mode passwordless re-entry branch writes the tab workspace context (`router/index.ts`), so C4 lands on a **workspace view** rather than the picker; the case therefore accepts "picker item **or** workspace view". Product behaviour awaits an A/B ruling and is unchanged here.
4. **BL-170 (fix present on the branch; B-class decision pending)**: the guard-written session used to skip Pinia ⇒ right after passwordless entry the first paint **lacks the admin entry** and config/session preload is skipped (a reload fixes it). This branch carries the fix (`adoptGuardSession()` in `stores/auth.ts`, the guard adopting the session in `router/index.ts`, and `App.vue` awaiting `router.isReady()`); it is a **product-code change** and needs the user's ruling before merge.
5. **BL-171 (product unchanged, lane worked around it)**: the auto-created default workspace is `managed_import` + docker backend ⇒ with the docker backend frozen/unavailable, "first reply" is structurally unreachable. The §5 matrix passes G2-e only because the case creates its own **`direct_attach`** workspace; the product default is untouched.
6. **BL-172 (fixed, with a regression guard)**: the workspace picker could hang on "loading" forever after a bounce (early-return path never resets loading + bounce did not clear the context ⇒ bounce loop). Fixed in `WorkspacePicker.vue` / `WorkspaceView.vue`, guarded by 2 unit tests (reverting the fix makes them fail).

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
| `--first-run=local` | empty DB + `XIHE_LOCAL_MODE=true` + `SERVER_ADDRESS=127.0.0.1`, **no seeded admin** | off |
| `--bootstrap-user=register\|none` | `register` = the runner registers the first account and imports the fake LLM profile with it; `none` = let the spec register | `none` |
| `--registration-policy=open\|closed` | injects `XIHE_AUTH_REGISTRATION_POLICY` (localMode still exempts the first account) | `open` |

The four batches (`scripts/e2e-batches.jsonc:144-175`):

| Batch | Contents | Why cases are skipped |
|---|---|---|
| `goldpath-first-run` | all of G1 (virgin DB) | none expected: the stack is empty, so G1-a..e run (the `closed` variant is `goldpath-closed`) |
| `goldpath` | G1-c/d + G2 + G3 (G4 fixmes are not collected) | G1-a/b/c skip because the runner already bootstrapped the account via `--bootstrap-user=register`; G1-e needs the closed policy |
| `goldpath-closed` | the G1-e reverse control | G2/G3 skip (they need the `--bootstrap-user=register` account lane); G1-c skips (needs virgin) |
| `goldpath-web` (optional, not in smoke) | single case via `--grep G2-e` (~1.5 min) | observe two rounds before deciding whether it joins `smoke` |

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `dev:host` fails to come up, ports busy | 12630-12634 occupied by another stack/process | `mise run dev:host:check` (`mise.toml:307`); or use another slot via `--stack 2` |
| CP exits at startup complaining localMode needs loopback | `XIHE_LOCAL_MODE=true` without `SERVER_ADDRESS=127.0.0.1` (or `XIHE_ENV=prod`) | satisfy all three conditions (§3) |
| Workspace operations report the backend unavailable | default `managed_import` (docker backend, frozen) | use `direct_attach` (§4 step 1) |
| Sending a message returns `503 LLM_NOT_CONFIGURED` | no usable model/connection (`missing_credentials`) | create a connection and verify to `READY`; this is exactly the G4-a status quo (BL-152), not a failure of this path |
| Sending returns `409 API_TYPE_REBIND_REQUIRED` | the session did not pin "connection + template triple" | create the session through the UI, or send the triple explicitly via API |
| `POST /local-login` returns 404 | non-loopback origin, or not a single-user instance (the gate fails closed with 404) | open via `127.0.0.1`/`localhost`; confirm the instance has exactly one login-capable account |
| After passwordless entry the admin entry is missing; a reload fixes it | BL-170 status quo | see §5.3 item 4 (fixed on this branch, pending ruling) |

## 7. How this relates to USER-001 / DEV-002

| Document | Owns | Deliberately not repeated here |
|---|---|---|
| **This one (DEV-033)** | the shortest blank-instance → first-reply path; the spec assertion behind each criterion; the first-run lane (runner flags / four batches) | module architecture, ops CLI, the full configuration surface |
| [USER-001](USER-001-user-guide.md) | day-to-day usage once you have an account (chat, multimodal, MCP tools, members, settings) | §1.4 keeps registration/login and points at this document for a blank-instance first run |
| [DEV-002](DEV-002-developer-guide.md) | the full environment setup, run modes A/B/C/D, full-stack debugging, test entry points | no duplicated first-run criteria; "Mode A" links here |

Terminology follows [DEV-032](DEV-032-terminology.md); this document introduces no new terms. "Local mode" is the code/env literal `localMode` (`XIHE_LOCAL_MODE`); "first run / gold path" names the blank-instance → first-reply path taken from the PLAN-0611 title, defined once here and not spread as a second name. Everything else (`bootstrap-status`, `SUPER_ADMIN`, `direct_attach`, `managed_import`) already exists in the repository vocabulary.
