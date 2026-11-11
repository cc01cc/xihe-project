---
title: DEV-035 - API Design Standard
category: dev-guide
sidebar_order: 35
lang: en
sidebar_group: "Developer Guide"
status: active
created: 2026-11-11
updated: 2026-11-11
description: Design standard for the XH HTTP REST surface (public /api/v1 + service-to-service /internal/v1): routes, authentication, error contract, naming, idempotency, pagination, long-running operations, deprecation, and contract governance. DEV-034 owns the "contract map for the four spec surfaces"; this document owns the design rules for the HTTP-route surface among them.
tags:
  - api
  - contract
  - standard
---

# DEV-035 - API Design Standard

> **Three-state tags**: **[Landed]** = the current code already works this way, with file:line evidence (see 01-fragments-inventory.md);
> **[Industry guidance]** = new items drawn from RFC/Zalando/AIP/Microsoft; **[Ruling needed]** = conflicts with the current state or involves trade-offs, **ruled by the user**.

## 0. Positioning and scope

- In scope: the HTTP REST surface CP exposes (public + service-to-service), including the error contract, naming, idempotency, pagination, long-running operations, deprecation, and governance.
- Out of scope (pointed to the DEV-034 map): SSE event payload shapes (see xh-event-naming-audit / BL-303), the MCP protocol surface (docs/api/mcp-protocol-matrix.md), persistence/Flyway (packages/control-plane/AGENTS.md §migration discipline).
- Relationship to existing files: **converge, not rewrite**. The fragments are scattered across AGENTS.md / DEV-014 / inventory.md; this document is the single point of reference. Where older wording conflicts with this document, this document wins and the old wording is fixed in the same batch (handled at landing).

## 1. Routes and versioning

- **[Landed]** Public routes uniformly under /api/v1; service-to-service uniformly under /internal/v1; public tokens must not be reused as service authentication (sources A1/A2).
- **[Landed]** All path segments are kebab-case (272 paths in openapi, 0 violations); camelCase / snake_case segments are forbidden.
- **[Landed]** Route / OpenAPI / inventory / SSE / Flyway move in the same wave; inventory.md is the checklist (A3).
- **[Industry guidance]** Version evolution goes only through "change the contract in the same wave + UI/CP in the same batch"; do not introduce /v2. When compatibility must be broken in the future, stand up the deprecation process (§8) first, then fork v2. **Why**: the XH frontend ships from the same repo as the backend, so URI versioning costs more than it buys.

## 2. Authentication and tenancy

- **[Landed]** user / service both use Bearer; service-to-service calls must not carry user context (B1/B2).
- **[Landed]** X-Workspace-Id is the authoritative header; the exemption list for the four endpoint classes is fixed (auth/health/actuator/internal) (B2).
- **[Landed]** Error semantics: missing principal = 403; authenticated but missing workspace context = 409 WORKSPACE_CONTEXT_REQUIRED (B3).
- **[Industry guidance]** Credentials and sensitive parameters **must not appear in the query string** (put them in headers / body; the log egress already redacts, and query strings bypass it). No violation found in the current state; recorded as a forward rule.

## 3. Error contract

- **[Landed]** The only error format is RFC 9457 Problem Details (application/problem+json); the shape follows docs/api/problem-details.schema.json (C1/C2).
- **[Landed]** code pattern ^[A-Z][A-Z0-9_]+$, SNAKE_UPPER; requestId is required (C2).
- **[Industry guidance]** The type member is **always "about:blank"**; all finer-grained semantics go through code; do not stand up a site problem-type URI registry (YAGNI — a single app has no multi-service shared-type need). **Closes gap G6**.
- **[Industry guidance]** title uses the standard phrase for that status (RFC 9457 SHOULD); detail writes a human-readable fix hint; machine branching keys only on code + status. **Closes half of gap C5** (the instance member stays unused; the reason is stated explicitly in this document).
- **[Ruled · scheduling pending]** **Central error-code registry** (approved by the user, 2026-11-11): collect every code scattered across DEV-014/inventory prose (WORKSPACE_CONTEXT_REQUIRED, BRANCH_RUN_MISMATCH, FOLLOW_UP_QUEUE_NOT_EMPTY, BRANCH_LOCK, etc.) into the code table in this document's appendix, with openapi referencing per endpoint. The table is created at landing; switching DEV-014 to references is scheduled with the window.

## 4. Naming and data formats

- **[Landed]** First-party JSON is camelCase; protocol-defined JSON is passed through verbatim (D1).
- **[Landed]** Internal fields (pid/policyPath/mxcTier, etc.) must not leak to the public surface (A5).
- **[Industry guidance]** Times are always RFC 3339 / date-time (with Z suffix); ID-like fields are uuid format; URL fields are uri format (Zalando [168]). New fields follow this; the existing state is not touched.

## 5. Idempotency and retries

- **[Landed]** Write idempotency uses the Idempotency-Key header (17 sites today: jobs start / workspace creation / guidance) (E1).
- **[Industry guidance]** Three uniform rules: ① idempotency keys are MUST only for **write** endpoints; read endpoints must not require them; ② key collision with a different body = 409, same body = return the first result (current semantics kept, written down); ③ the key TTL (suggested 24h) is written into this document to prevent "same key reused months later" ambiguity.

## 6. Pagination and filtering

- **[Ruling needed]** **Uniform pagination parameters**. Four different names are mixed today: cursor×1 / limit×2 / page×1 / size×1 (G1).
  - Option A (aligned with AIP-158): page_size + page_token (opaque), optional skip. Friendly to offset semantics.
  - Option B (aligned with Zalando [159]): limit + cursor (opaque), forward-only. Simplest to implement.
  - **Ruling (user, 2026-11-11, relayed by Lead): Option B (limit + cursor)**. Renaming the existing 4 endpoints is a breaking batch; it is scheduled by window after DEV-035 lands, with UI/CLI/tests changed in the same wave.
- **[Industry guidance]** filter/sort/fields query parameters **stay closed for now** (YAGNI; the existing 24 parameters have no such need); when needed later, add them in a "collection-endpoint specific" section, not in the general standard.

## 7. Long-running operations (LRO)

- **[Landed]** Async submission returns 202 + runId/jobId (chat 202; 14 occurrences of 202 in openapi) (E2).
- **[Industry guidance]** Converge into one written rule: a POST that may run long ⇒ 202 + poll GET on the same resource until a terminal state; **do not** fake synchrony with 200 + an in-body status field. SSE notification is only a side-channel accelerator, not the state authority (consistent with the DEV-014 jobs section, written down).

## 8. Deprecation and evolution

- **[Industry guidance]** Three deprecation steps: ① mark deprecated: true in openapi; ② add Deprecation: @<http-date> and Sunset: <http-date> response headers (RFC 9745 semantics); ③ delete on expiry with consumers changed in the same wave. Zero occurrences in the current standard (G3).
- **[Industry guidance]** Revisions of this document itself go through "change in the same wave + ledger D-number", because this document is part of the contract (self-reference of the A3 rule).

## 9. Contract governance

- **[Landed]** openapi.yaml is the single SSOT, maintained by hand; when code diverges, fix the code (F1).
- **[Landed]** Runtime-native docs (/v3/api-docs, /openapi.json) are demoted to debug artifacts (F2).
- **[Landed]** Four gates: check:openapi / check:openapi:lint / check:api-docs / check-api-types-drift (F3).
- **[Industry guidance]** The new-endpoint checklist lands in this document's appendix (kebab path segments → openapi first → gates green → inventory registration → DEV number synced), turning A3's "same wave" from a slogan into steps.

## 10. Conflict list (**no self-decisions; ruled by the user**)

| # | Draft item | Conflicts with | Decision |
| --- | --- | --- | --- |
| 9-1 | §1 keep the /api/v1 prefix | Zalando [135] SHOULD not use /api | **Ruled 2026-11-11: keep as is** |
| 9-2 | §3 flat RFC 9457 shape | Microsoft ARM nested error / Google google.rpc.Status | **Ruled 2026-11-11: keep as is** (XH has fully implemented the flat shape, 7 controllers) |
| 9-3 | §6 uniform pagination parameters | the existing 4 endpoints' cursor/limit/page/size | **Ruled 2026-11-11: Option B** (limit + opaque cursor); the renaming breaking batch is scheduled after landing |
| 9-4 | §3 central error-code registry | codes scattered across DEV-014 / inventory prose (only 3 enumerated in openapi, dozens in reality) | **Ruled 2026-11-11: register**; the three follow-up changes (DEV-014 references this doc / openapi hangs code references / DEV-034 map linkage) are scheduled with the window |
| 9-5 | §8 Deprecation/Sunset headers | zero occurrences in the current standard | **Ruled 2026-11-11: keep as is (do not introduce)**; deprecation notices continue via the DEV-014/handoff-doc channel; reopen if external developers are ever onboarded |

## Appendix A · New-endpoint checklist (draft; takes effect at landing)

1. Path segments kebab-case, mounted under the correct tag; 2. openapi.yaml written first (SSOT first); 3. redocly lint + validate green;
4. Error responses reference the schema; 5. Registered in inventory.md; 6. DEV number (both languages) in the same batch; 7. UI four layers in the same wave (packages/ui/AGENTS.md:52); 8. e2e that needs in-page fetch gets an annotation.

## Appendix B · Evidence index

- Research evidence (task-126 three-piece set): `plans/PLAN-0763-XH-api-contract-docs/evidence/task-126-dev-035/` (fragments inventory / industry sources / recompute commands)
- Ruling batch: D-909 (2026-11-11)
