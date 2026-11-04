---
title: DEV-017 - Session Architecture
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
status: active
sidebar_order: 17
created: 2026-09-03
updated: 2026-11-05
---

# DEV-017: Session Architecture

> For front-end and session-logic developers: one page on state ownership, sync mechanics, and embedding conventions. UI implementation details live in DEV-010.
>
> Chat and Workspace can collaborate within one work surface, but the domain dependency direction is that Workspace exists independently while a Session optionally binds to a Workspace. Boundary with DEV-010 is "Session domain vs UI implementation": state ownership, sync mechanics, and embedding conventions live here; the route table, component tree, and transport implementation live in DEV-010.

### SPEC pointer

The target-state lifecycle boundaries for Session, ChatRun, MCP invocation, and Runtime MCP session live in the root-level SPECs:

- [`spec/session/chat-session.md`](../../../spec/session/chat-session.md)
- [`spec/session/chat-run-operation.md`](../../../spec/session/chat-run-operation.md) (the Operation part was superseded by PLAN-0467; the historical model is background for migrations only)
- [`spec/session/mcp-session.md`](../../../spec/session/mcp-session.md)
- [`spec/session/branch-context-isolation.md`](../../../spec/session/branch-context-isolation.md) (branch visibility and cursor within one Session; PLAN-0410)
- [`spec/session/fork-and-branch-actions.md`](../../../spec/session/fork-and-branch-actions.md) (cross-Session fork, child seed, and idempotent recovery; PLAN-0409)
- [`spec/session/derived-collaboration-inbox.md`](../../../spec/session/derived-collaboration-inbox.md) (parent Inbox terminal-notice lifecycle; PLAN-0408)

These documents neither merge the three lifecycles nor change this DEV document and the CP/Runtime code as the current source of truth.

## 1. Session domain model

A Session is one coherent user work context, independent of views:

| Ownership | Convention |
|---|---|
| Session/Message | CP's server API is the canonical source; nothing is stored in localStorage and historical values are never restored |
| Derivation source (PLAN-0407 M2 / PLAN-0630) | V37 persists `spawned_from_session_id/run_id/spawned_at`; V40 uses `kind=spawn/fork` to distinguish permission lineage. Root has all-empty provenance; spawn converges permissions/stops along the parent Agent Session, fork keeps the source link but acts as an independent permission root; **a child does not become an independent root when its parent is deleted** — a missing spawn-chain ancestor always fails closed (`ancestor_missing`, PLAN-0630 D30-08) to avoid silently inflating budgets. PLAN-0407 T2.10 wires the CP-owned logical MCP `spawn_agent` caller with its own grant/approval, waiting link, and child dispatch; the Agent never calls `/internal/v1/agents/spawn` directly. PLAN-0630 delegation edges keep using those existing columns (no synonym columns, D30-01); wake edges additionally land in `chat_runs.parent_run_id` (V105), and delegation depth / wake depth are computed inside one `DelegationChainWalker` pass without persistence |
| Fork context seed (PLAN-0409/0410) | The `session.forked` child root event carries the seed messages before the selected branch/terminal anchor plus an optional SUM; the child EventStore sequence is a child-local cursor and parent source fields are lineage only, never child authorization; Workspace L1 refreshes before the child Run |
| Derived collaboration notices (PLAN-0408) | Child terminal notices written into the parent Inbox are the durable source; a parent ChatRun may claim them in its create transaction; the UI restores from the derived-state API and treats SSE only as a refresh hint; deleting a parent never cascades to children |
| Delegation projection (UI, PLAN-0655/0659) | The session tree and delegation DAG consume only existing projections: `kind=SPAWN` + `spawnedFromSessionId` from the `sessions` list (the list projection must pass `kind`/`spawnedFromSessionId`/`spawnedAt` through `normalizeSession`; `d880d705` fixed a regression that dropped them), the parent session's derived state (child node status), and the root session's delegation usage (budget/depth). No new persistence surface and no wire change; node caps/truncation/orphans/cycles are made explicit in the UI (DEV-010 §4.2) |
| Message delivery semantics (UI, PLAN-0659) | `Message.delivery` is a **local view of composer send state** (TO/CC have no durable carrier — **BL-239**): it is lost after a session reload, and `@` is rebuilt from the body + roster; never persisted to localStorage, never on the wire |
| Message | Belongs to a Session, indexed by `sessionId` in `useChatStore`; its lifecycle (created/streaming/done) goes through the chat store |
| Attachment | Session-scoped; persisted in the backend's Session-specific space (stored by fileId under `{base}/{sessionId}/`), while `Message.attachments` stores metadata; workspaces treat attachments as read-only (the files themselves are writable through the workspace store, see DEV-010 §5) |
| File | Physical files belong to Runtime; a Session keeps references via `fileContext` (workspaceFiles/activeFilePath) |
| Context | `SessionContext{agents, ragContext?, mcpContext?, fileContext?}`; RAG/MCP configuration sources are `configStore` |

Workspace is an independent resource that can be created, imported, browsed, and edited without any Session. A Session may bind one Workspace at creation time; the Session's `fileContext` only references files of that Workspace and never determines the Workspace lifecycle in reverse.

Chat uses `sessionId`, Workspace uses `workspaceId`; neither may stand in for the other (PLAN-222).

State machine: Active (interactive) → Archived (front end stops loading; data is retained/cleaned per the server contract) → deleted (server API).

Deletion uses a durable intent fence (V47 `sessions.delete_requested_at`, PLAN-0409 design #22): the first DELETE segment records the delete intent in the same transaction as the short-lock `copying` precheck, and the later cancel/job-close side effects run outside the lock; while the intent is recorded, fork claims and mutation surfaces (`lockCurrentForMutation`, including the message-delete entry) return `409 SESSION_DELETING` until the row is physically deleted. The intent is irreversible (no undo); after an interruption a retried DELETE resumes from that point (re-entrant) and there is no automatic sweeper; read paths such as list/get/read-messages are unaffected.

The canonical model binding for a Session is `modelProvider + modelName`; `modelId` is no longer written or inferred by the UI. On refresh the pair is rehydrated from the server, and no locally valid binding is created while the provider/model catalog is unavailable.

ChatRun links to Messages via `runId`; server-returned `runStatus`, `terminalOutcome`, `errorCode`, and `partial` must not be treated on refresh as an ordinary successful assistant; `ambiguous` requires human confirmation and a retry with a new idempotency key.

### 1.1 Agent principal binding (PLAN-0374)

- `sessions.agent_principal_id` and `agent_permissions_snapshot` are the only source of Agent identity and instance capabilities; interactive `POST /api/v1/sessions` must explicitly carry `agentPrincipalId`, and Chat admission only accepts already-bound Sessions — there is no lazy create.
- `sessions.context_template_layer/id/version` (V48, PLAN-0414) is the Session-level pinned binding of the context template: resolved or explicitly selected at creation, and `PATCH /api/v1/sessions/{sessionId}/context-template` only affects subsequent Runs; model/Agent field updates must not disturb that binding; at admission the whole revision is copied into `chat_runs.context_template_snapshot` (in-flight runs are unchanged). Configuration domains and resolution precedence are in [DEV-014 §8f](DEV-014-control-plane-architecture.md).
- A principal-null empty Session (attachment placeholder / imported history) must explicitly submit a principal on its first Chat: when there is no ChatRun, message, user-direct MCP invocation, or tool ContextEvent, the row CAS binds it in the same transaction as the ChatRun/Message; missing principal → 403, different principal → 409.
- `user_id` only expresses owner/visibility and never participates in Agent authorization; when the binding is missing/revoked, Agent actions fail closed while historical Sessions remain. Contract: [`spec/agent/principal-workspace-binding.md`](../../../spec/agent/principal-workspace-binding.md); wire is per OpenAPI.

### 1.2 Session branches (PLAN-0410 / V43)

- Each Session has exactly one root `session_branches` row (partial unique); non-root branches carry `parent_branch_id` + `fork_point_message_id/run_id/sequence` (same Session, same parent branch guaranteed by the anchor composite FK). `messages`/`chat_runs`/`context_projections.branch_id NOT NULL`, `context_events.branch_id NULL`; the read-model unique key is `(session_id, projection_type, branch_id)`.
- CP freezes branchId when each ChatRun/Message is created, and a Run's branch is immutable; the visible set = Session/global events ∪ each ancestor segment up to the child's `fork_point_sequence` ∪ the current branch (the cursor remains the Session-global sequence; no per-branch counters are introduced).
- An anchor must belong to a terminal Run: a `'USER'` anchor takes that Run's unique `prompt.admitted` sequence, and an `'ASSISTANT'` anchor takes the Run's maximum correlated sequence; non-anchorable cases (legacy without correlation/cursor) always fail closed with 409 rather than guessing from wall clocks.
- Same-Session **concurrency limit** (PLAN-0645 M0/M1): `409 CHAT_IN_PROGRESS` is returned only when non-terminal runs reach `maxConcurrentRunsPerSession` (default 2); runs may be concurrent within the cap, and setting the key back to `1` rolls back to the original single-flight behavior; the public `GET/POST /api/v1/sessions/{sessionId}/branches`, `GET /messages?branchId=`, `ChatRequest.branchId`, manual compact `branchId`, and `409 BRANCH_LOCK` belong to **PLAN-0409**. UI path selection is per Session; the server still resolves visibility per V43/0410 and never trusts client-side parent/anchor inference. Contract: [`spec/session/branch-context-isolation.md`](../../../spec/session/branch-context-isolation.md); internal API in DEV-014 §8d.

### 1.3 Session Follow-up queue (PLAN-0442 / V49)

- The queue is a Session-level CP-owned durable projection (V49 `session_follow_up_items`; FIFO hard cap 5 counting all unfinished queued/paused/admitted items), and item rows are the single source of truth; the enqueue API returning 202 only means durable enqueue — a child Run is admitted after the parent Run reaches a terminal state.
- While the queue is non-empty, an ordinary `POST /api/v1/chat` always returns `409 FOLLOW_UP_QUEUE_NOT_EMPTY`; queuing during a Run must go through the UI's explicit Queue action, so `CHAT_IN_PROGRESS` is no longer the only exit. During a Session's delete intent, both queue mutations and ordinary Chat return `409 SESSION_DELETING`.
- At most one active child per Session: admission and the QueueItem state transition are atomic in one transaction; parent/child Run terminals advance in the same settlement transaction (succeeded/partial/failed → the next item continues automatically; cancelled/ambiguous → the whole queue is `paused`); already-admitted cancelled/ambiguous children are not replayed, and `continue` only admits items after them.
- Before admission, attachment ownership, branch visibility, and the binding are re-validated; a failure means `paused` (fail closed); on startup CP restores paused admitted-without-child items and wakes the queued head (idempotent). API/OpenAPI in DEV-014 and `docs/api/openapi.yaml`; UI panel in [DEV-010](DEV-010-ui-architecture.md).

## 2. Store responsibility boundaries (option B: shared + view separation)

- **useSessionStore** (`stores/session.ts`, cross-feature): `sessions`, `currentSessionId`, `searchQuery`, attachment local view, `fileContext`; exclusively owns UI-side Session create/delete/rename and the current selection; `setFileContext`/`setSessionAgents`/`setRAGContext`/`setMCPContext`. CP still owns the canonical Session/Message/ChatRun lifecycle and durable records.
- **useChatStore** (`features/workspace/chat/stores/chat.ts`, Workspace Chat UI view layer): `messages` grouped by Session, branch list/selected branch, and `streamingMessageId`; `getMessages/addMessage/addMarker`; the branch selector is UI path state, not authorization truth; the streaming trio `createStreamingMessage` / `replaceStreamingParts` (full MessagePart[] replacement, PLAN-230) / `finalizeStreaming`; it stores no Session metadata and no Agent/RAG/MCP configuration, and does not own the CP durable lifecycle.
- **useWorkspaceStore** (`features/workspace/stores/workspace.ts`, Workspace feature view layer): `fileTree`, `expandedPaths`, `openFiles`, `activeFilePath`, `uploadQueue`; may optionally write the current Session's file context back via `syncActiveFileToSession()`; stores no Session metadata. Without a current Session, Workspace file operations and Workspace event subscriptions still work and must not fake a Session. File mutations (`renameNode/moveNode/duplicateNode/createDirectory`) return `Promise<boolean>` and callers branch toasts on the result (no fake success, PLAN-262 M1/B-2); `refreshAfterMutation` preserves expansion; uploads dispatch by MIME (text via `write_file` MCP / binary via `POST /api/v1/files/upload`, PLAN-262 M0/B-3). v1 has no import entry.

## 3. Cross-store sync

- **Read**: view components and both view stores read `useSessionStore` directly (`currentSessionId`, `currentSessionAttachments`, `currentSessionFileContext`) without caching copies (no multiple sources of truth).
- **Write**: Session create/delete/rename only through the session store; the attachment upload entry is `InputArea` (`uploadAttachments` → backend), and `sessionStore.addAttachment` only maintains an in-memory local view (not authoritative); `ChatPanel.handleSend` only sends the message + passes fileIds through; file context only via `syncActiveFileToSession`; Agent/RAG/MCP context via dedicated session-store methods.
- **No event bus**: Pinia reactivity is the sync mechanism; read directly.

## 4. View embedding and switching conventions

- `ChatPanel` (`features/workspace/chat/components/ChatPanel.vue`) is the embedded conversation component for Workspace Chat (message list + input + SSEStream, with no full-screen layout header); the full-screen `ChatView` is removed, and other features never embed Chat UI directly.
- Switching convention: Workspace is the default entry; the Sidebar "New Chat" creates a Session in the current Workspace through the Agent principal picker; Workspace routes may exist without a Session, and once selected the route is `/workspace/:workspaceId/chat/:sessionId`. The WorkspaceToolbar session dropdown keeps the Workspace route when switching Sessions, never mistaking a Workspace switch for a Session switch.
- Message history is always read via `chatStore.getMessages(sessionId)` for cross-view consistency; attachments are shared via `currentSessionAttachments`.
- Route table and component layering are in DEV-010 §1-2; the SSE transport layer is DEV-010 §4.

### 4.1 Workspace-level event subscription

- Workspace file/state events are subscribed per `workspaceId`, independent of `sessionId`.
- Chat SSE keeps carrying ChatRuns per Session; Workspace SSE only carries state and file-change summaries.
- File contents, directory trees, and large payloads keep using HTTP; lost events are compensated by sequence gaps and the Workspace snapshot.
- Detailed transport layering and the Runtime WebSocket control plane are in PLAN-0350 / BL-43.

## 5. Development conventions and extensions

- New views should prefer reading `useSessionStore` and never manipulate the chat store's Session state directly; file-context writes always go through `syncActiveFileToSession`.
- Future extensions (draggable right-panel width, a unified `/session/:id` route evaluation, file drag-and-drop into chat, side-by-side Sessions) require separate PLANs.
- **Checkpoint slice invariant (PLAN-0653 P3)**: the rollback handle is always a `sliceRef` (`refs/xihe/slices/<epoch>-<40hex>`) that carries no file content; in self mode the store is the read/write main path and the shadow is only a best-effort fallback backup; Session/ChatRun semantics are unaware of the storage mode (storage details in `DEV-015` §6.1).

## 6. Session multi-type test matrix (PLAN-0658)

The session surface involves **multiple principals (human/Agent), multiple accounts, multiple roles, delivery, and failure semantics**, and unit tests cannot prove "the combination still works". This section is the **single entry** to that matrix: what to run, what to look at, how to judge, and which gaps are tracked as `fixme`.

### 6.1 Channels and files

| Channel | Files | Stack | Notes |
|---|---|---|---|
| mock interaction matrix (M1–M8) | `packages/ui/e2e/mock/session-matrix-*.spec.ts` | UI dev server only | Interaction affordances + wire shape; **cannot** serve as real-path evidence |
| real data-plane matrix (R1–R3, R5–R9) | `packages/ui/e2e/real/session-matrix-*.spec.ts` | Isolated stack (`e2e-host`, 27xxx range) | Real CP/Agent/Runtime + isolated PG + fake LLM |
| headed walkthrough (R4 and other interactive keys) | `packages/ui/e2e/headed/session-participants.spec.ts` | Isolated stack + `--first-run=local --bootstrap-user=register` | Chrome Beta headed, single window, serial |

Running the whole real matrix once (`session-matrix` batch, 8 specs):

```powershell
node scripts/e2e-host.mjs --persistent --batch=session-matrix
$env:XIHE_E2E_EXTERNAL_SERVER='1'; node scripts/e2e-host.mjs --batch=session-matrix --retries=0
node scripts/e2e-host.mjs --teardown
```

Single-spec iteration (since PLAN-0664): do **not** write `--batch=session-matrix <spec>` — the batch's 8 specs and positional args are a **union**, so everything runs; narrow with `--only=<full path|basename|unique substring>` (e.g. `--batch=session-matrix --only=session-matrix-multi-account`), or check the plan with `--check-cli` first.

**Mandatory discipline**: running a real spec must pass `--batch=<name>` (or `--llm-mode=success`). A bare run injects the default llm-mode into the instance's `llm-provider` config, leaving the stack at `llmReady=model_unavailable`, where `POST /chat` returns 503 forever and never self-heals (teardown and restart only).

### 6.2 Matrix and criteria (measured 2026-11-04)

| # | Dimension / criterion | Assertion surface | File | Result |
|---|---|---|---|---|
| R1 | Multiple human accounts (two accounts seeing each other / bystander / external account) | wire + durable + UI | `session-matrix-multi-account.spec.ts` | 3 pass + **3 fixme** (BL-237 ×2, BL-238 ×1) |
| R2 | Send and principal identity (selfOwned / default attribution / `as` / privilege escalation / disabled / send→badge) | wire + durable + UI | `session-matrix-to.spec.ts` | 6 pass |
| R3 | Three-role session visibility (OWNER / EDITOR / VIEWER) | wire + UI | `session-matrix-roles.spec.ts` | 4 pass |
| R4 | `@` mention candidate keyboard (↑↓ / Enter / Tab / Esc + real-stack send) | UI + wire | `headed/session-participants.spec.ts` (`R4@host`) | 1 pass (headed) |
| R5 | Candidate/member-row filtering after a principal is disabled | UI | `session-matrix-disabled.spec.ts` | 3 pass |
| R6 | Concurrent queuing (durable queue + idempotent replay + drain) | durable | `session-matrix-concurrency.spec.ts` | 2 pass |
| R7 | Failure terminals (`ambiguous` + stable `errorCode` + attempts rows + no body output) | durable | `session-matrix-failures.spec.ts` | 3 pass |
| R8 | Refresh recovery (BL-228 guard: exactly one message, run terminal, cc draft does not revive) | durable + UI | `session-matrix-refresh.spec.ts` | 2 pass + 1 fixme (BL-237) |
| R9 | reasoning three segments with the same value (durable + UI collapse + same after refresh) | durable + UI | `session-matrix-reasoning.spec.ts` | 3 pass + 1 fixme (BL-197 ①, see 6.4) |

Whole-batch baseline (e2e-host clean DB, after merging `develop`): **26 passed / 4 skipped / 0 failed**; the same batch on the persistent stack-2 (`xihe_2` with historical data) matched group by group ⇒ the matrix **does not depend on a clean DB**.

### 6.3 Rendering-contract assertions (shared with PLAN-0659; real segment backfilled)

Identity always comes from `data-*` (`participantId` / `runId` / `depth`) — **never from copy short codes and never relying on the clock**.

| Assertion | Real segment | Status |
|---|---|---|
| `data-process-kind` of `process-row` | 1/1 | ✅ |
| A single-principal thread does **not** render `process-row-actor` | 1/1 | ✅ (**but see 6.5: tautologically true, not positive evidence**) |
| A single-run session has **no** `run-header` | 1/1 | ✅ |
| `message-delivery-to` = `Send→<display name>` | 1/1 | ✅ (R2-6, real composer send) |
| `message-delivery-mention` / `-cc` (R1) | 0 | ⏸ unreachable: R1 sends via API and TO/CC have no durable carrier (BL-239) |
| Mixed-principal `process-row-actor` **positive case** | 0/1 | ⏸ **does not hold**: `SessionMessage` lacks `participantId` (BL-197 ①) ⇒ tracked as `fixme` |
| `delegation-node` / `delegation-edge` | — | N/A (this matrix does not trigger delegation) |

### 6.4 Tracked product gaps (they do not disappear because the matrix is green)

| Gap | Symptom | Handling in the matrix |
|---|---|---|
| BL-237 | Session read surfaces are owner-only (`SessionService.requireCurrent`), so invited human participants cannot read | R1-a2 / R1-e / R8-3 `fixme` |
| BL-238 | wake is authorized as the owner → human participants are always `refused`, and the inner transaction is rollback-only | R1-b `fixme` (BL-214 `mention_count=0` is its symptom, not a separate defect) |
| BL-239 | TO/CC are a composer-local send-state view with no durable carrier ⇒ delivery badges disappear after refresh | Delivery-badge assertions run only right after sending; R8-2 verifies in reverse that they do not revive after refresh |
| BL-197 ① | `SessionMessage` has no `participantId` ⇒ historical threads cannot derive actor attribution | R9-4 positive case is a `fixme`; removing `.fixme` once the field lands is the acceptance |

### 6.5 Judgement discipline: when a negative case passes, ask "is it tautologically true?"

**The lesson from this measurement**: R9-2's negative case (a single-principal thread emits no `process-row-actor`) was always green — but while `SessionMessage` lacked `participantId` it was **tautologically true** (no thread could render a badge), so its green did **not** prove the "single principal does not flash identity" capability. Only the mixed-principal **positive case** (R9-4) exposed the gap.

Therefore: **a passing negative case must be able to point at where the positive capability was proven**, otherwise record it as "unverified"; for attribution/role assertions, write the positive and negative cases together and run them together.

## Appendix: RFC-001 historical design (retired)

RFC-001 (produced by PLAN-029, deprecated after being superseded by PLAN-222) defined the first domain model and state diagram of the unified Session; its core conclusions (server-side canonical source, Session-scoped attachments, fileContext references) are merged into the body above, and the old three-field `modelId` binding was replaced by the canonical `modelProvider + modelName` pair. The original text is in git history.
