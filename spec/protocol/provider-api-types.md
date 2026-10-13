# XH Provider API Types and Connection Identity

> Contract status: `proposed`; implementation status: `partial`; Profile: `protocol`.
> Canonical owner: CP Provider owner; active writer: PLAN-0439 (handoff from completed PLAN-0438); checked 2026-10-12.
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
- One-use internal leases may return a credential only to authorized Agent request memory. Opaque leases and decrypted grants are not logged or forwarded to the browser.

## Phase Ownership

- PLAN-0438 owns Registry/Catalog/Connection persistence and multi-key CRUD/discovery. Its completed baseline assigns Type server-side; PLAN-0439 extends the mutation contract.
- PLAN-0439 extends generic Type selection, connection overlay and Session binding; only its Chat templates/selectors/senders require `operation=chat`.
- PLAN-0485 adds the dedicated Embedding Type and per-request profile/lease/RAG storage consumer. PLAN-0416 consumes that profile for ChatRun retrieval; neither replaces the canonical Registry.
- PLAN-0438 handed this file to PLAN-0439 after merge 692b89fb. PLAN-0485 and PLAN-0416 consume it until their sequential handoff; only the active owner edits its sections. Authentication/authorization remains owned by Security; HTTP fields/errors remain in OpenAPI/inventory.

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
