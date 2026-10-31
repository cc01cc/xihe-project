# XH Provider API Types and Connection Identity

> Contract status: `proposed`; implementation status: `partial`; Profile: `protocol`.
> Canonical owner: CP Provider owner; active writer: none — PLAN-0416 closed its dynamic retrieval slot sections on 2026-10-13 (sequential handoff from completed PLAN-0439); checked 2026-10-13.
> Consumers: CP Provider/Models/Lease, Agent model catalog, UI ProviderHub, downstream PLAN-0439/0485/0416.

## Registry

- Built-in API Types are keyed by immutable `apiTypeId + version` and carry `operation=chat|embedding` with method/path/request/response/stream metadata. Registry definitions are read-only, validated and immutable in memory.
- ProviderCatalog declares supported Type pairs and one default pair. A supported pair can override Provider-level Base URL/model discovery defaults. Defaults initialize configuration; they do not alone prove protocol compatibility or ban legitimate custom endpoints.
- Each ProviderConnection stores exactly one Type/version. Models inherit operation and Type; models do not override them.

## Connection Identity

- Owner scopes are USER and WORKSPACE for current public writes. The database identity is `(ownerType,ownerId,providerId,connectionKey)`; the concrete connection identity is its UUID.
- `connectionKey` is an immutable 1..64-character lowercase ASCII slug matching `[a-z0-9]+(?:-[a-z0-9]+)*`. Invalid/null writes return 400; duplicate scope/provider/key and rename return their stable 409 codes.
- Create requires a key. PATCH omission preserves it, the same value is accepted, and explicit null does not clear it.
- Model identity is `connectionId + modelId`. The public Models envelope stays `{models,providers,configRevision}`, with maps keyed by connectionId; providerId is grouping metadata, not a unique key or selectable connection identity.
- Descriptors and controlled grants propagate connection key, revision, Type/version and operation. UI sends the real providerId and concrete connectionId separately when binding a model.

## Credential Boundary

- Credentials are encrypted at rest and write-only on ordinary Connection APIs. Presence/status may be returned, but no suffix or derived credential fragment is returned or written to new audits.
- PLAN-0553: `provider_connections.credential_id` is an owner-neutral reference into the credential domain; the connection row has no ciphertext. Provider lease/verify/export read the token only through the credential domain, gated by `credential_use` (owner match or explicit grant) and fail-closed when the reference is missing or unusable.
- One-use internal leases may return a credential only to authorized Agent request memory. Opaque leases and decrypted grants are not logged or forwarded to the browser.
- Scope note (PLAN-0495, updated by PLAN-0553): the standalone credential manager (`spec/security/credential-management.md`) is now the SSOT for connection keys; MCP OAuth remains separate.

## Phase Ownership

- PLAN-0438 owns Registry/Catalog/Connection persistence and multi-key CRUD/discovery. Its completed baseline assigns Type server-side; PLAN-0439 extends the mutation contract.
- PLAN-0439 extends generic Type selection, connection overlay and Session binding; only its Chat templates/selectors/senders require `operation=chat`.
- PLAN-0485 adds the dedicated Embedding Type and per-request profile/lease/RAG storage consumer. PLAN-0416 consumes that profile for ChatRun retrieval; neither replaces the canonical Registry.
- PLAN-0438 handed this file to PLAN-0439 after merge 692b89fb. PLAN-0485 and PLAN-0416 consumed it until their sequential handoff; both are complete (2026-10-13), so the canonical owner has editing authority again. Authentication/authorization remains owned by Security; HTTP fields/errors remain in OpenAPI/inventory.

## Development Cutover and Evidence

- The 2026-10-11 user decision removes legacy compatibility obligations. Conflicting development Provider/lease/pin data may be reset by an explicit scoped manifest, after recoverable backup; unrelated data and production are not implicitly authorized reset targets.
- Existing Flyway history is never rewritten. Fresh install and reset-upgrade must reach the same schema. Passing unit tests alone does not establish backup recovery, concurrent HTTP conflicts or complete browser acceptance.
- PLAN-0438 baseline is merged at 692b89fb. PLAN-0439 implementation remains partial until template, Type mutation, Session binding, native wire and browser acceptance evidence closes its gates.

## API Request Template and Chat Admission

- Templates are immutable published versions scoped to instance, user or workspace, bound to one Type/version. Drafts retain raw JSON source, including invalid source; publication requires Type validation.
- Effective template resolution is Model override → Connection default → built-in Type template. Session creation and every model binding update resolve once and pin the selected version; metadata-only edits preserve the pin. The three pin fields are either all present or all NULL. NULL requires explicit rebind before Chat admission.
- Connection Type changes require impact inspection, explicit confirmation, a compatible default and revision CAS. Only incompatible overrides are cleared. Session binding writes and lease redemption serialize against Connection updates.
- Admission locks and rereads the Session before resolving its Connection and published template. The Run snapshots exact template source, identity, Type, Connection revision/key/scope. Missing pins, Type mismatch and non-chat operation fail closed.
- Template interpolation operates only on JSON string values, rejects duplicate keys, malformed xh tokens and key variables, and preserves other namespaces literally. Model and tools are registered read-only slots; credentials are supplied solely by ephemeral lease redemption. Conflicting literal runtime fields are rejected.
- A Run renders its authored base body once. Tool continuations copy that body and append only this Run’s native assistant/tool/reasoning records at the end of messages/input. History includes only earlier Runs; authored field and message order is preserved.
- Successful one-use redemption acquires the ephemeral grant. Already acquired grants may complete their Run after a Connection update; subsequent redemption must pass the revision check. Credentials and rendered bodies are not persisted or logged.
- Chat uses the selected Type’s direct sender/parser; it has no legacy provider or context-builder fallback and never automatically replays a failed HTTP step. Summary and discovery retain their separate boundaries.
- Cross-Run native history uses the existing `assistant.responded.payload.message` with the optional atomic `apiTypeId/apiTypeVersion/nativeRecords` triple. Native records exclude admitted user input and replace the same Run's projected ai/tool history using existing correlation/sequence. Replay (full/incremental), restart and fork preserve the carrier; prune/compaction remove it atomically with replaced history. Different Type carriers fail closed. Tool argument/result bounds remain in force; signatures/encrypted reasoning remain exact. Serialized Type/nativeRecords carrier must fit the resolved `context-policy.pruneWindowChars`; oversize fails safely before publication. No new table, sequence, credential or rendered-body persistence.

## Dynamic retrieval slot (PLAN-0416)

`xh.rag_context` is a read-only string. Only an unescaped token in the authored snapshot triggers retrieval; `$${xh.rag_context}` remains literal. CP publication and Agent dispatch enforce the same placement rules:

| Chat Type | Allowed data positions |
|---|---|
| `openai-chat-completions` | `messages[i].content` strings for `user`, `assistant`, or `tool` roles |
| `anthropic-messages` | `messages[i].content[j].text` in text blocks, or string `.content` in tool-result blocks, for `user` or `assistant` messages |
| `mimo-responses` | `input[i].content` strings |

Object keys, system/developer messages, top-level `system`/`instructions`, model and tools are forbidden positions. Retrieval data never replaces authorized Agent instructions or stable ContextEpoch. One Run obtains its own embedding grant, and each provider step renders the data slot from the original template before adding the native continuation. Empty successful retrieval renders `""`; unavailable/failed retrieval fails before Chat provider dispatch with a stable Run error.

## Tool capability per Type (PLAN-0591; T4.3 decision A+C, 2026-10-31)

- `supportedApiTypes[].capability.tools` in `provider-catalog/providers.json` is the single decision source for tool dispatch; a missing value means unsupported (runtime WARN). Provider-level `supports.tools` is an any-route rollup and `supports.toolsPartial` is `any && !all` (mixed state). Example: `xiaomi` = `mimo-responses@1:false` + `openai-chat-completions@1:true` → `supports.tools=true`, `toolsPartial=true`.
- **Catalog revision `v2`:** introducing per-API-Type capability bumps `GET /api/v1/provider-catalog` `catalogRevision` from `v1` to `v2`. `v2` adds `supportedApiTypes[].capability` (own schema `SupportedApiTypeEntry`; the shared `ApiTypePair` used by `defaultApiType` stays unchanged) plus provider-level `supports.toolsPartial`; no `v1` field changes meaning. Consumers MUST treat an unknown revision as newer-but-opaque and MUST NOT infer capability from `supports.tools` alone. Normative gate behaviour lives in `spec/capability-gate.md`.
- A Type declared unsupported must fail closed **before** the provider dispatch: non-empty rendered `tools` rejects with the stable `LLM_TOOL_ROUTE_UNSUPPORTED` terminal code, zero provider HTTP, zero transport attempt, zero `tools/call`; an empty `tools` request is unaffected.
- **Maintenance contract (decision C — data ownership + evidence pointers, no schema change):** whoever edits catalog capability data owns it; every change to `capability.tools` / `supports.tools` / `supports.toolsPartial` / `catalogRevision` must ship with an evidence pointer registered in `packages/control-plane/src/main/resources/provider-catalog/README.md` (the JSON stays strict JSON — never add comments or `_comment` fields to it). Current pointers: `xiaomi/mimo-responses@1=false` → BL-148 real-call evidence (`plans/PLAN-0564-.../evidence/bl148-real-lane-fixture.md` §4.4) + PLAN-0591 M3 zero-egress evidence (`plans/PLAN-0591-.../evidence/m3-e2e-verification.md` §4); `xiaomi/openai-chat-completions@1=true` → PLAN-0372 D5-B frozen evidence (`real-tool-roundtrip.spec.ts`).
- **Body semantics:** the rendered request body stays text-only until the renderer post-transform (PLAN-0605 §2a of `spec/capability-gate.md`): when CP dispatches `images[]` for the run and the Type is in the Agent's `VISION_RENDERERS`, only the current turn's last `user` message is rewritten into `text` + `image_url` parts; every other message and field is forwarded unchanged.- **Flip triggers:** vendor/model claims tool support, a new Type or version is registered, tool-related provider-400 reports appear, or the quarterly review is due. Evidence must first distinguish "provider ignored tools" from "model chose not to call" (PLAN-0591 `evidence/m0-hypotheses.md` E2/E3); any real call is capped at one, requires written user approval, no retry, and is not used to decide H1/H2. Only then may the entry flip to `true`, as a data-only change with updated evidence pointer and a `catalogRevision` semantics review — never mixed with logic changes. Model-level capability stays a provider-400 → `LLM_REQUEST_REJECTED` fallback and is a separate backlog item.

