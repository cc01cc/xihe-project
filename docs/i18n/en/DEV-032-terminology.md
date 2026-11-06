---
title: DEV-032 - Terminology (Polysemy and Synonyms)
category: dev-guide
sidebar_order: 32
lang: en
sidebar_group: "Developer Guide"
status: active
created: 2026-09-16
updated: 2026-11-06
---

# DEV-032: Terminology (Polysemy and Synonyms)

> **Role**: SSOT for wording in XH docs and unstarted PLANs. Two problem classes: (1) **polysemy** → disambiguated canonical names; (2) **synonyms** → one canonical term plus aliases.
> **Scope**: `plans/PLAN-*-XH-*` (drafts first), `A03-xihe/docs/`, root-level `spec/` (extended by PLAN-0426), prose in project `AGENTS.md`. Completed packages and `review/` history are **not** rewritten unless the file is edited again.
> **Out of scope**: OpenAPI path literals and locked code identifiers (renames need their own PLAN, cf. PLAN-0356).

## 0. Rules

1. Never use a bare ambiguous token from §1 for a non-canonical sense.
2. One concept → one canonical term; aliases may appear once in parentheses.
3. Keep backlog IDs (`M-2`, `M-3`, `CTX-1`, …); pair ID with canonical name on first mention.
4. Chinese jargon pairs with English canonical once (§3).
5. Suggested README line: `> Terminology: DEV-032.`

## 1. Polysemy → distinct canonical names

| Bare token | Sense | **Canonical** | Do not | Notes |
|---|---|---|---|---|
| **owner** | RBAC role on workspace | `workspace role owner` | bare `owner` for operation-lock holder | |
| | Lifecycle operation-lock holder | **`workspace operation lock holder`** | bare `owner` / unqualified `active owner`; `execution lease holder` (retired name) | |
| **L1/L2/L3** | Context injection slots | **`context L1`** | bare `L1` | |
| | Diagnostics layers | **`diagnostic L0/L1/L2`** | bare `L1` | |
| | Checkpoint restore layers | **`checkpoint L1`** | bare `L1` | |
| **resume** | Session / ChatRun recovery | **`run resume`** | bare `resume` for unpause | |
| | Leave workspace `paused` | **`unpause`** | bare `resume` / sole name “recovery consumer” | |
| **scope** | Job lifetime boundary | **`job scope`** (`run/session/workspace`) | bare `scope` for the policy layer | |
| | Policy / tool-face layer | **`policy scope`** (`instance/workspace/user`; tool faces also `builtin`) | bare `scope` for a Job | |
| **interrupted** | Job terminal caused by Runtime restart or unconfirmed start | **`job interrupted`** | blend with run `ambiguous`; call it “recovered/replayed” | |
| **runtimeBootId** | Runtime per-process boot id | **`runtimeBootId`** | treat as a business identity | |
| **job** | Current background job | **`durable job`** | mix with deleted table | |
| | Historical table | **`runtime_jobs` (legacy, deleted)** | treat as live | |
| **snapshot** | Current pre-write restore point | **`checkpoint`** | active docs using `snapshot` for restore point | |
| | Retired mechanism | **`legacy snapshot`** | blend with checkpoint | |
| **收敛 / 收口** | Many paths → one authority | **converge** | use “close” for state-machine merge | |
| | Scattered entries → one seam | **route-to-seam** (“收口”) | use “converge” for REST→executor | |
| **projection** | A. CP durable authoritative record | **`<domain> durable record`** (Job durable record = Job source of truth; checkpoint slice record) | `projection` for sense A; call B a source of truth | 0426; not rebuildable |
| | B. CP rebuildable read model | **`Context projection`** (first use: rebuilt by CP from `context_events`; not a source of truth; never executes tools) | bare `projection`; `ContextProjectionService` / `context_projections` stay as identifiers | 0426; `checkpoint projection` retired → checkpoint slice record |
| | C. API response data shape | **`<object> response` / `<object> response view`** | `<object> projection` | 0426 |
| | D. UI local display state | **`UI local view`** (non-authoritative) | UI projection, store projection | 0426 |
| | E. State / field mapping | **`state mapping` / `field mapping`** | projection fold-back, capability projection | 0426 |
| | F1. Length/time-bounded presentation | **`bounded preview`** | verbatim projection | 0426 |
| | F2. Permission/field-redacted presentation | **`redacted summary`** | security projection | 0426; F1 and F2 may stack, not exclusive |
| **ChatRun** | Machine-readable execution entity: one execution | **`ChatRun` / `run`** (code/API/DB stay `run`; never renamed) | renaming `ChatRun`/`chat_runs` to `round`; bare `Run` in primary UI copy | **Why "run"**: `chat_runs` exists since the first migration (`V1__init_schema.sql`), the original design name; one execution spans multiple LLM calls, tool calls, messages, checkpoints, budget and lease, and can continue as a **child run** from an `ambiguous`/`CP_RESTARTED` source (`docs/api/openapi.yaml:1624 continueChatRun`); rename cost = 113 files for the table / 253 for the class / 82 event keys — only for a nicer name. User-facing wording: next row |
| **turn** | One complete user-perceived interaction (their message → a readable result) | **`turn`** (zh: 回合) | treating a run as a turn; coining another synonym; `Run` in primary UI narrative | **Why "turn"**: it is the unit users perceive, matching the existing “本轮” wording; **mapping and exceptions**: commonly **1 turn = 1 run**, while continuation / wake / follow-up / retry may span several runs; keep `Run #id` as a detail/hover footnote only |

### 1.1 Workspace storage and checkpoints (2026-10-25)

| Bare token | Sense | **Canonical** | Do not |
|---|---|---|---|
| **root** | Runtime process storage base | **host root**; `XIHE_WORKSPACE_HOST_ROOT` is a historical name | bare `root` for one workspace directory |
| | managed workspace content directory | **workspace path** (`<hostRoot>/<storageRef>`) | call host root a workspace path |
| | multiple physical roots in one Workspace | **multi-root (BL-94)** | fake it with multiple Workspaces |
| **storage mode** | XH-owned copy | **`managed_import`** | describe it as opening a user directory in place |
| | user directory mounted in place | **`direct_attach`** | call it a subdirectory of host root |
| **reason** | Runtime capture reason | **capture reason** | bare `reason` mixed with gate/durable |
| | CP `unrollable_reason` value | **durable reason** | treat capture reason as durable |
| | CP gate verdict reason | **gate reason** (`EXPIRED`/`MISSING`/`DEGRADED`/`TOO_LARGE`) | put gate reasons in the capture allowlist |
| **absolute path** | configured source value | **source path** (may be relative; launcher resolves) | require absolute paths in config files |
| | value injected into Runtime | **resolved host root (absolute)** | treat a relative value as a normal contract |
### 1.1a Principals, session participants and policies (2026-11-02; 0622 backfill + 0623)

> The Chinese edition grew this section in PLAN-0622 and this English edition had not been backfilled; the 0622 rows are added here together with the 0623 ones so both editions stay aligned. **English/code identifiers are the only source of vocabulary for code, CLI and field names** — do not coin a second translation.

| Term | English / code identifier | One-line definition | **Counter-example: do not use it for** |
|---|---|---|---|
| agent (zh: 智能体) | `agent` (never translated; zh canonical **智能体**) | Umbrella term for the software actor that does work / holds authority; in any specific context use one of the derived terms below, never bare | In Chinese never 「代理」 (means HTTP proxy / delegation here) or 「AI 成员」; do not coin UI synonyms |
| agent principal | `agent principal` (`agent_principals`; `agentPrincipalId`) | An independently authorizable subject with its own grants/cap; may be bound to many Workspaces and used by many Sessions; not owned by a user (`created_by_user_id` only records the creator) | a spawn instance; an `agent-templates` template; "an actor acting for a user"; "a user account of another kind"; **a disabled principal is not a crashed process** (see agent runtime) |
| agent runtime | `agent runtime` (Python package `packages/agent`; log module `moduleAgent`) | The **process component** running orchestration / tool calls | **Two words, two things**: a disabled/removed/unauthorized principal leaves the runtime process alive and well, and a live process does not make the principal usable. Never say "the agent is down" for a disabled principal; never "restart the agent" for re-enabling one |
| agent management | `agent management` (UI surface `agentManagement`, zh label 「智能体管理」) | The UI/API surface managing agent principals (create/bind/cap/disable) within a scope | Not a new capability: it is the management surface of agent principals; "manage" ≠ "speak as" (`MANAGE_WORKSPACE_AGENTS` vs `speakAs` are independent, D23-08) |
| human principal | `human principal` (`users`; JWT `role=USER\|ADMIN`; there is **no `humanPrincipal` class**) | A human account with login credentials; one of the three authorizable subject kinds | a Workspace member (that is `membership`); an Agent-path reader of `user_id` |
| service principal | `service principal` (capability **`CAP_INTERNAL_SERVICE`**; `ROLE_INTERNAL_SERVICE` is a legacy alias) | Internal pipeline identity between CP/Agent/Runtime: not a collaborator, cannot log in, produces no user-visible behavior | an agent principal; a "super user" token |
| session participant | `session participant` (table **`session_participants`**, `V92__session_participants.sql:50`; polymorphic `principalKind` (`HUMAN`/`AGENT`) + `principalId`, **no FK** — `role_bindings` precedent) | A subject's participation in one session: the same principal may hold different roles/policies per session; a session may have several participants | Workspace `membership`; bare `participant` (Mermaid keyword); "session owner" (`sessions.user_id` is ownership only) |
| wake policy | `wake policy` (`wakePolicy`; enum **`ALL_MESSAGES`** / **`MENTION`**, default `MENTION`) | Which events wake this participant (every message, or only on @); **visible ≠ woken** | visibility/permission; respond policy; notification settings |
| respond policy | `respond policy` (`respondPolicy`; enum **`ALWAYS`** / **`WHEN_MENTIONED`** / **`JUDGE`** / **`MUTED`**, default `WHEN_MENTIONED`; `JUDGE` reserved for 0624, `MUTED` is the 0623 mute switch) | Whether/how it answers once woken, independent of capability limits | visibility; part of cap ("cap decides what is allowed, policy decides what is volunteered"); personality |
| guard agent | guard agent (`guard_agent` in local drafts; final identifier pending CP) | A **preset** agent principal (system preset): read-only cap, may speak, verdicts go through approval; not an editable persona | path/HardGuard/authorization guards; a workspace role "guardian" |
| principal scope | `principal scope` (`agent_principals.scope`, values **`PERSONAL` / `WORKSPACE` / `INSTANCE`**) | Three-tier ownership/visibility label; **not** an authorization scope carried by the principal (BL-29 binding-style scope) | "the principal's own permission range" (effective range = binding ∩ grants); authorization/OAuth scopes; a fourth tier |
| PRIMARY participant | `PRIMARY participant` (`role=PRIMARY`; partial unique index `uq_session_participants_primary`, one per session) | The session's default conversation partner: seeded automatically with the session (cursor included); **cannot be removed or transferred** | `membership` OWNER (D23-02: session roles never use OWNER); "session owner"; "transfer PRIMARY to another participant" |
| member / guard | `MEMBER` / `GUARD` (`role` enum, constraint `ck_session_participants_role`) | In 0623 the two are **one surface**: mentionable, policy-editable, removable; GUARD-specific constraints belong to 0625 (D23-24) | claiming GUARD has extra powers in 0623; adding a fourth session role |
| participant cursor | `participant cursor` (`session_participant_cursors`; `lastReadEventSeq` / `mentionCount`) | Server-side read position: **a pointer, not a counter** (counts recompute from `context_events`); the client never accumulates; `readCursor=null` when no row exists | treating client-side read state as truth; "unread count" as the stored truth; `{}` instead of `null` |
| soft disable | `soft disable` (`disabledAt`; `DELETE` or `PATCH` `disabled=true`) | Removing a participant only **disables** it: row, cursor and audit stay, `GET` still returns it (with `disabledAt`); not a hard delete (D23-26) | "delete participant"/hard delete; assuming the row disappears; Workspace member removal (`role_bindings`) |
| display name | `displayName` (**derived at read time, never stored**; no `display_name` column) | AGENT → `agent_principals.name`; HUMAN → the account `username` (NOT NULL since V82; the **sole** display source after PLAN-0684/D-183 — the legacy `name` and the email are never projected); `null` when unresolvable ⇒ UI shows "unknown user" | using a UUID as a person name; an editable field; falling back to `name` or the email (single source: username, no fallback chain) |
| speak as | `speakAs` (`capabilities`) / `asParticipantId` (request) / `selfOwned` (per-row projection) | **Speaking as ≠ mentioning**: speaking as **sends a message as** that participant; mentioning only points the topic at them (`@name`). An admin may add participants but **not** speak as them (D23-08); `speakAs` = at least one row with `selfOwned=true` (same predicate; the UI must not decide itself) | "mention"/"@"; assuming `manage` implies speaking as; "switch speaker" as an authorization concept |
| observer view | observer view (`GET /api/v1/events` **without** `asParticipantId`) | Receives **all** participants' events; the opposite is the participant view (only that participant) | rendering a multi-subject stream as single-subject (D23-28); a compatibility layer; faking "current speaker" |
| run-level attribution | run-level attribution (`chat_runs.agent_principal_id`) | Each run records **who answered this run** (not a session-level property); without `asParticipantId` it is the PRIMARY subject; null when both are absent | the session-level `sessions.agent_principal_id` (session default subject); backfilling PRIMARY when the run value is null |
| participant source | `participant source` (`source` ∈ `workspace` / `personal` / `instance`, **lowercase**) | The ownership source of the participant's subject, derived at read time | agent `scope` (**uppercase** `PERSONAL`/`WORKSPACE`/`INSTANCE`); unifying the casing — different columns, different enums; renaming needs a CP ruling |

## 2. Synonyms → canonical + aliases

### 2.1 Still live (unstarted / in-flight PLANs use canonical)

| Concept | **Canonical** | Aliases | Where |
|---|---|---|---|
| Ensure execution environment ready (contract verb) | **`ensure`** | materialize (prose), provision | 0329/0345; tests use `ensure` |
| HTTP path for async ready | **`materialize` (API path)** | do not rename URL to `ensure` | prose: “trigger ensure (API: materialize)” |
| Merge concurrent ensure per workspace | **`ensure single-flight`** | **M-3** (ID), materialize dedupe | 0345; first mention `M-3 (ensure single-flight)` |
| Drop old tool outputs outside window | **`prune`** | mask, truncation as prune duty | 0341; 20-msg cap = assembly fuse, not prune |
| Rule-based summary + one rerun | **`compaction`** | auto-summary; “shrink” = prune∪compaction | 0341 |
| Code path leaving `paused` | **`unpause activation path`** | recovery consumer, resume consumer | 0345 M-2 |
| Bypass executor, hit host FS | **`executor-bypass`** | raw host FS direct | 0329 |
| Resume long-running job output | **`durable job continuation`** | job resume | 0344 |

### 2.2 Already migrated (active docs: canonical only)

| Concept | **Canonical** | Retired | PLAN |
|---|---|---|---|
| Pre-write restore point | **checkpoint** | `revert_snapshot`, active snapshot restore | 0356 |
| Old snapshot surface | **legacy snapshot** (retirement prose only) | blending with checkpoint | 0357 |

### 2.3 Confusable but **not** synonyms (do not merge)

| A | B |
|---|---|
| Ledger single-writer (0326) | ensure single-flight (M-3) |
| ensure single-flight | chat `409 CHAT_IN_PROGRESS` |
| workspace operation lock holder | workspace role owner; retired alias: `execution lease holder` |
| run resume | unpause |
| **durable job continuation** | **Workspace `unpause` / `run resume`** — reading existing Job output (`job-output`, read-only cursor) is not reactivating execution |
| **job `interrupted`** | **run `ambiguous`** — Job judged dead by a Runtime restart (never replayed) vs run terminal still undecided |
| converge | route-to-seam |

## 3. Recommended phrasings

- “Runtime **ensures** readiness; CP exposes **materialize**.”
- “**ensure single-flight (M-3)** → one entity creation.”
- “One **workspace operation lock** is shared by ensure materialization and explicit delete; its guard is released when the operation ends.”
- “`paused` requires an **unpause activation path**.”
- “REST file surface is **routed to the executor**; no **executor-bypass**.”
- “**context L1** injection; **diagnostic L1** deferred.”

## 4. Rollout

| Phase | Action |
|---|---|
| 2026-09-16 | Align unstarted XH PLAN README/spec to §1–§3 |
| 2026-09-21 | Add `scope` / `interrupted` / `runtimeBootId`; §2.3 separates **durable job continuation** from Workspace `unpause` / `run resume` (PLAN-0390) |
| 2026-09-30 (PLAN-0426) | Add `projection` six senses (A durable record / B read model / C response view / D UI local view / E mapping / F1 bounded preview / F2 redacted summary); scope extended to root-level `spec/`; bare `projection` banned in prose, identifiers and history excepted |
| 2026-10-10 (PLAN-0474) | Rename the Runtime concept to workspace operation lock in this glossary and the proposed Security/Workspace glossary; no authorization semantics change |
| 2026-11-02 (PLAN-0622 backfill) | Add §1.1a so the English edition matches the Chinese one: `agent principal` / `human principal` / `service principal`, `wake policy`, `respond policy`, guard agent, `principal scope` |
| 2026-11-02 (PLAN-0623) | Add §1.1a 0623 rows: `PRIMARY participant`, `MEMBER`/`GUARD`, `participant cursor`, soft disable, `displayName`, `speakAs`/`asParticipantId`/`selfOwned`, observer view, run-level attribution (`chat_runs.agent_principal_id`), `participant source` (lowercase enum, distinct from uppercase `scope`); enums per `V92__session_participants.sql`. No new synonyms for mention/group chat/speaker were coined |
| 2026-11-02 (zh canonical: agent = 智能体, user-approved) | Add the umbrella row (zh canonical **智能体**; ban 「代理」「AI 成员」), rename agent principal's zh label to 智能体主体 (a disabled principal ≠ a crashed process), and add **agent runtime** (process component) and **agent management** (manage ≠ speak as); zh UI locale sweep replaced descriptive "Agent" with 「智能体」 (57 sites in the zh block of `packages/ui/src/i18n/index.ts`; `AGENTS.md` file names, identifiers, keys and the en block untouched) |
| Completed / archive / review | No historical rewrite; align when file is edited |
| Code identifiers | PLAN-0474 renames the internal Runtime type `ExecutionLease` to `WorkspaceOperationLock`; no compatibility alias without an in-repo consumer |

## 5. Related

DEV-031 / PLAN-0329 (`ensure`); PLAN-0345 (workspace operation lock, unpause); PLAN-0341 (prune, compaction); PLAN-0356 (checkpoint); DEV-030 (doc layout); PLAN-0390 + `spec/workspace/execution-job.md` (`job scope` / `interrupted` / `runtimeBootId`).
