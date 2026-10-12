# XH Embedding Provider Contract

> Contract status: `proposed`; implementation status: `partial`; Profile: `protocol`.
> Canonical owner: CP Provider owner; active writer: PLAN-0485; checked 2026-10-12.
> Consumers: CP Embedding/RAG proxy, Agent RAG routes, UI KnowledgeBase/EmbeddingSettings, downstream PLAN-0416.

This file freezes the embedding profile resolution and the RAG proxy wire that PLAN-0485 implements and PLAN-0416 consumes. Wire truth stays in `docs/api/openapi.yaml` / `docs/api/inventory.md`; this file records the contract shape and its invariants.

## API Type and Connection

- One API Type pair carries `operation=embedding`: `dashscope-multimodal-embedding@1`, pinned to host `dashscope.aliyuncs.com` by the type contract (CP rejects a custom host for this type) and `modelDiscovery=manual`.
- The model identity is fixed for V1: `tongyi-embedding-vision-flash-2026-03-06`, dimension `768`. CP serves this contract; clients must not re-declare it.
- Connection identity, ownership and credential rules follow `provider-api-types.md` (one immutable `connectionKey` per owner/provider; credentials encrypted, write-only, never in the profile).

## Profile Resolution

- Layer value: the `embedding` config domain stores the whole-unit profile `{"profile":"<json {providerId, connectionKey, model}>"}`; fields never merge across layers and a partial profile is rejected (400). Absent or empty PUT clears the layer so resolution inherits.
- Resolution order: `workspace` → `user` → `instance` (each whole-unit); the resolved connection must be READY, enabled and embedding-typed, visible to the caller.
- `GET /api/v1/config/embedding/effective` is a read-only view: `{contract{modelId, dimension}, profile, profileScope, resolved, code?}`. A missing profile or a conflicting connection returns `resolved:null` with a stable `code` instead of failing. A client-supplied `workspaceId` must pass the caller's membership check.
- `POST /api/v1/config/embedding/test` takes an empty body, resolves the authenticated caller's profile, issues a one-use lease and probes through the Agent; the response is sanitized (`status/model/dimension/requestId`; no credential or vector).

## Public RAG Routes (CP)

CP derives owner and profile from the authenticated context; clients never send profile or credential.

| Route | Method | Request | Notes |
|---|---|---|---|
| `/api/v1/rag/stats` | `GET` | none | Partition-scoped counts; returns `{embeddingProfile, totalDocuments, documents (bounded)}` |
| `/api/v1/rag/ingest` | `POST` | multipart `file`, optional `chunkSize`/`chunkOverlap` | Single-transaction ingest into the caller's partition |
| `/api/v1/rag/search` | `POST` | JSON `{query, topK?, minScore?}` | Partition-scoped retrieval; negative lookups never cross scopes |
| `/api/v1/rag/documents/{docId}` | `DELETE` | none | Partition-scoped delete; an unknown or foreign docId returns `404 RAG_DOCUMENT_NOT_FOUND` |

Missing/ambiguous profile returns `409 EMBEDDING_PROFILE_REQUIRED` (or the stable conflict code); Agent failures map to sanitized `502` problems with the request id.

## Internal RAG Routes (Agent)

CP calls these with `Authorization: Bearer` service auth, the non-secret `embeddingProfile` and a one-use `embeddingCredentialLease` (same issue/redeem channel as chat credentials).

| Route | Method | Body |
|---|---|---|
| `/internal/v1/agent/rag/stats` | `POST` | `{embeddingProfile}` |
| `/internal/v1/agent/rag/ingest` | `POST` | multipart `file`, `chunkSize`, `chunkOverlap`, `embeddingProfile`, `embeddingCredentialLease` |
| `/internal/v1/agent/rag/search` | `POST` | `{query, topK, minScore, embeddingProfile, embeddingCredentialLease}` |
| `/internal/v1/agent/rag/documents/{doc_id}/delete` | `POST` | `{embeddingProfile}` |
| `/internal/v1/agent/rag/embedding/test` | `POST` | `{embeddingProfile, embeddingCredentialLease, requestId?}` |

Errors are sanitized RFC 9457 problems with stable codes (`EMBEDDING_PROFILE_*`, `EMBEDDING_PROVIDER_*`); leases are single-use and already-redeemed grants are rejected.

## Partitioning

- Every stored row is keyed by the full identity tuple `(workspaceId, connectionOwnerType, connectionOwnerId, providerConnectionId, apiTypeId, apiTypeVersion, modelId, dimension)`; the fresh store is fixed at 768 dimensions.
- Retrieval pushes the tuple filter to PostgreSQL (WHERE before ORDER BY/LIMIT); an owner or connection outside the resolved tuple is never visible, and legacy rows without a complete tuple are not adopted by any scope.
- Re-ingest under a changed profile/connection writes a new partition; the previous partition stays addressable only for its own tuple.

## Credential Boundary

- Leases carry hashed tokens plus the bound user/workspace/connection/provider/model/revision; redemption re-validates that binding and returns the decrypted credential to Agent request memory only.
- No credential, credential fragment, vector payload or provider payload appears in responses, logs or durable records.
