---
title: DEV-034 - Contract Map for the Four Spec Surfaces
category: dev-guide
sidebar_order: 34
lang: en
sidebar_group: "Developer Guide"
status: active
created: 2026-11-10
updated: 2026-11-10
description: Pointer page for cross-module work — where the single authority lives for HTTP routes, SSE event streams, MCP, and persistence, plus the known gap in event payload shapes and the code coordinates to extract them from
tags:
  - contract
  - map
  - sse
---

# DEV-034: Contract Map for the Four Spec Surfaces

> **Purpose**: before starting cross-module work, confirm in one page *where the authoritative body lives* for each contract surface. **This page only points; it never restates the body.** If this page and the authority disagree, **the authority wins** and this page gets fixed.
>
> **What it is not**: not a fifth spec, not a field manual. Field-level content is **forbidden** here (see §6). Scope is limited to the four cross-boundary contract surfaces between CP / Agent / Runtime / UI.

## 1. The four at a glance

| # | Surface | Single authority | Derived / supporting | Status |
|---|---|---|---|---|
| ① | HTTP routes and request/response schemas | [`docs/api/openapi.yaml`](../../api/openapi.yaml) | [`docs/api/inventory.md`](../../api/inventory.md) (route inventory and semantic baseline) | **Complete** |
| ② | Event stream SSE / AgentEvent | **no single schema body** | [`spec/protocol/event-stream.md`](../../../spec/protocol/event-stream.md) (lifecycle and ownership, `proposed`·`partial`) + OpenAPI descriptions + code | **Gap**: see §3 |
| ③ | MCP tool surface | `docs/api/mcp-tools.md` (**in progress**, research-2) | [DEV-016](DEV-016-mcp-architecture.md) | **In progress** |
| ④ | Persistence (schema / migrations) | [`packages/control-plane/src/main/resources/db/migration/`](../../../packages/control-plane/src/main/resources/db/migration/) | [DEV-019 (zh)](../zh-Hans/DEV-019-database-schema.md) (schema quick reference) | **Complete** |

> Status meanings: **Complete** = a single authority exists and compliance can be judged from it; **In progress** = the authoritative file does not exist yet and a supporting surface stands in; **Gap** = no body exists that can freeze payloads, so code is the only source.

## 2. ① HTTP routes

- **Body**: `docs/api/openapi.yaml` — routes, request bodies, response schemas, `ProblemDetails` errors, and auth declarations all live here. Drift is caught by `mise run check:openapi` (already a dependency of `test:cp` and `validate`).
- **Supporting**: `docs/api/inventory.md` is the **implementation baseline** (PLAN-222/230): the normalised route inventory plus cross-surface semantics (the `X-Workspace-Id` gate, error codes, role projection). It is **not** the schema body — field-level judgement always goes back to OpenAPI.
- **Common misuse**: treating inventory prose as the contract for field assertions. The fields are not there. Conversely, inventory's semantic paragraphs (e.g. which gate a missing header falls back to) are not fully in OpenAPI either — **they complement each other; neither substitutes for the other**.

## 3. ② Event stream SSE / AgentEvent — the one row that matters most

**Conclusion: payload shapes have no single body.** This is not "nobody wrote it" — the document that exists **explicitly excludes the wire schema**, so there is no frozen table to cite.

### 3.1 What already exists (do not duplicate)

| Surface | Coordinate | What it covers |
|---|---|---|
| Lifecycle and ownership | `spec/protocol/event-stream.md` (`proposed`·`partial`; `:8`, `:45`) | One emitter per session, generation increments, `done` ends a run only, `heartbeat` never enters UI, the event ownership table, the closed user-channel event set |
| Envelope-level prose | OpenAPI `GET /api/v1/events` → `chatEvents` `description` (`openapi.yaml:2315-2330`) | Event **ordering** and the field strings of **some** events: `derived_state_changed`, `run_checkpoint`, `transport_progress`, `participantId`, `runId` |
| User channel example | OpenAPI `/api/v1/user-events` (`openapi.yaml:2286`, example at `:2303`) | `text/event-stream` + `schema: {type: string}` + an `event:/data:` sample (a **sample**, not a schema) |
| Workspace channel | OpenAPI `/api/v1/workspaces/{workspaceId}/events` (`:2399`) | Same — sample level |

`spec/protocol/event-stream.md:8` states: "full event payload follows OpenAPI/code types; this document freezes lifecycle and ownership"; `:45`: "the event wire schema is not copied in this document." ⇒ **It is not the payload body; citing it for field assertions is a misreading.**

### 3.2 What is missing

A document that **freezes, field by field**, the six session events `token` / `tool_call` / `tool_result` / `approval_request` / `error` / `done`. It **does not exist**. Consequence: adding or changing an event means reading code, and a cross-module event change must be aligned manually across three sides (§3.3).

> Writing that body is **a separate card's job** — this page only records the gap and the extraction coordinates. **Do not invent an event spec inside a contract map**, or the map starts hiding a second body and the two will drift.

### 3.3 Extraction coordinates (by surface — the only option while the body is missing)

| Surface | Coordinate | Note |
|---|---|---|
| Wire type | `packages/agent/src/xihe_agent/interfaces/agent_runner.py:23` | `class AgentEvent` — the real event type |
| Producer mapping | `packages/agent/src/xihe_agent/adapters/sse_adapter.py` | Framework events → `AgentEvent`; `SUPPRESSED_HUMAN_WAIT_TOOLS` decides which tools emit **no** `tool_call`/`tool_result` |
| CP relay / emit | `.../cp/chat/SseEmitterManager.java`, `.../cp/event/WorkspaceEventManager.java`, `.../cp/event/UserChannelSseManager.java` | One dispatch point per channel |
| UI consumer | `packages/ui/src/features/workspace/chat/composables/useStreamParser.ts` | Parses those envelopes into message parts |

**⚠️ Same name, different thing (easiest trap)**: `packages/agent/src/xihe_agent/interfaces/event.py` is **not** the SSE event type — it holds **context event-sourcing domain events** (`EventType = session.created / prompt.admitted / llm.token / ...`) persisted into the CP Event Store and projected into `AgentContext`. The two "events" are not interchangeable.

**⚠️ Two counter-intuitive facts** (from `spec/protocol/event-stream.md`, saving a debugging round):

1. `session_question_asked` is **not** a session SSE event (`:17`): it exists only on the CP ↔ Agent internal stream; CP persists a durable row plus a user-channel hint and does **not** forward it to `GET /api/v1/events`. Looking for it in the session stream will always fail.
2. `heartbeat` is a transport event and **must not** enter a UI MessagePart (`:13`).

## 4. ③ MCP tool surface

- **Body (in progress)**: `docs/api/mcp-tools.md` — as of 2026-11-10 this file **does not exist yet** (being built by research-2). Once it lands it is the single authority.
- **Current stand-in**: [DEV-016](DEV-016-mcp-architecture.md) (MCP architecture and boundaries) plus the `/api/v1/mcp/*` paths in OpenAPI. They cover different things: DEV-016 covers **protocol and trust boundaries** (why there is no `mcp-session-id`, who owns OAuth); OpenAPI covers **wire**. The tool **inventory** and per-tool input semantics have no authority until mcp-tools.md lands.
- **When it lands**: point the first column of §1 at it and flip the status to "Complete".

## 5. ④ Persistence

- **Body**: `packages/control-plane/src/main/resources/db/migration/` — the Flyway migration directory **is** the schema source of truth ([DEV-019 (zh)](../zh-Hans/DEV-019-database-schema.md) `:19` says so explicitly). Currently `V1..V150`, 142 scripts (verified 2026-11-10).
- **Supporting**: DEV-019 is a **domain-grouped schema quick reference** (conclusions first, constraints, indexes, local inspection). Good for "what columns does this table have", not for "what did a given migration change".
- **Known drift**: DEV-019's migration table covers up to `V75` plus `V133/V134` rows; later migrations (e.g. `V148__plan0750_create_own_agent_atom.sql`, `V150__message_reasoning.sql`) exist **only in the directory** and are not listed row by row ⇒ for "when was this schema introduced", use **the migration filename and the directory**.

## 6. Maintenance rules

1. **Change the authority first, then one line here**: any contract surface added or renamed updates both in the same batch; touching one side guarantees drift.
2. **No field-level content on this page**: only "coordinate + one line on what it covers". If you want a field table, that is the missing body (a new card), not the map.
3. **Links must really exist**: confirm a file exists before linking it; `mise run lint:links` catches broken links (③'s mcp-tools.md is in progress, so this page names the path without an inline link).
4. **Flip status when a gap closes**: the "Gap / In progress" markers in §1 are **todos**; when fixed, flip to "Complete" and add the link in the same batch — do not leave the map stale.
5. **Do not casually add a fifth class**: adding one (e.g. a gRPC/WebSocket-only surface) requires first confirming it does not overlap the existing four.

## 7. Relationship to other documents

- [DEV-001](DEV-001-system-architecture.md): global architecture and module boundaries (this page refines its **contract entry point** and does not repeat the architecture narrative).
- [DEV-030](DEV-030-documentation-layout-and-frontmatter.md): document ownership and frontmatter rules (this page follows it).
- `spec/README.md`: project-level SPEC entry (this page does not replace SPEC; it states which SPEC/body owns which contract class).
- [DEV-018 (zh)](../zh-Hans/DEV-018-known-issues.md): Known Issues entry; the missing payload body in ② is **not** registered there (that is a defect ledger — this is a documentation gap), and §3.2 here is its registration point.
