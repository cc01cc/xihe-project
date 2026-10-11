# XH Provider API Types and Connection Identity

> Contract status: `proposed`; implementation status: `partial`; Profile: `protocol`.
> Canonical owner: CP Provider owner; active writer: PLAN-0438; checked 2026-10-11.
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

- PLAN-0438 owns Registry/Catalog/Connection persistence and multi-key CRUD/discovery. Its Type is server-assigned/read-only.
- PLAN-0439 extends generic Type selection, connection overlay and Session binding; only its Chat templates/selectors/senders require `operation=chat`.
- PLAN-0485 adds the dedicated Embedding Type and per-request profile/lease/RAG storage consumer. PLAN-0416 consumes that profile for ChatRun retrieval; neither replaces the canonical Registry.
- Only PLAN-0438 edits this file while active. Downstream additions require an explicit handoff and must not concurrently rewrite its sections. Authentication/authorization remains owned by Security; HTTP fields/errors remain in OpenAPI/inventory.

## Development Cutover and Evidence

- The 2026-10-11 user decision removes legacy compatibility obligations. Conflicting development Provider/lease/pin data may be reset by an explicit scoped manifest, after recoverable backup; unrelated data and production are not implicitly authorized reset targets.
- Existing Flyway history is never rewritten. Fresh install and reset-upgrade must reach the same schema. Passing unit tests alone does not establish backup recovery, concurrent HTTP conflicts or complete browser acceptance.
- Implementation is still partial: read-only Type rejection, real concurrent key conflict, complete master-detail/browser model selection and final truth audit remain acceptance gates until evidence closes them.
