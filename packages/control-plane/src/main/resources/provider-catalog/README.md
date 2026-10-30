# Provider catalog — capability data & evidence pointers

This directory holds the classpath provider catalog (`providers.json`) consumed by
`ProviderCatalogService` and served as `GET /api/v1/provider-catalog`
(`catalogRevision = v2`).

**`providers.json` is strict JSON.** It carries no comments and no `_comment`
fields; this README is the only annotation channel. Do not add schema fields just
to attach an explanation — the runtime schema is contract-tested.

## Tool capability semantics (PLAN-0591)

- `supportedApiTypes[].capability.tools` is the **single** decision source for tool
  dispatch. Missing value ⇒ unsupported (runtime WARN with providerId/apiTypeId).
- Provider-level `supports.tools` is an any-route rollup; `supports.toolsPartial`
  is `any && !all` (mixed state) and is display-only.
- A Type declared unsupported must fail closed **before** provider dispatch:
  non-empty rendered `tools` ⇒ stable `LLM_TOOL_ROUTE_UNSUPPORTED`, zero provider
  HTTP, zero transport attempt, zero `tools/call`. Empty `tools` is unaffected.
- Mixed-state example (pinned by `ProviderCatalogControllerTest#exposesV2RevisionAndPerApiTypeCapability`):
  `xiaomi` = `mimo-responses@1:false` + `openai-chat-completions@1:true`
  ⇒ `supports.tools = true`, `supports.toolsPartial = true`.

## Maintenance contract (PLAN-0591 T4.3 decision C)

Whoever edits capability data owns it. Every change to `capability.tools`,
`supports.tools`, `supports.toolsPartial` or `catalogRevision` must come with an
evidence pointer recorded in the table below; a change without one is not
mergeable, and vendor marketing or model names are never evidence.

| provider / apiType | `capability.tools` | Evidence pointer | Evidence state |
|---|---|---|---|
| `xiaomi` / `mimo-responses@1` | `false` | ① BL-148 real-call evidence: `plans/PLAN-0564-.../evidence/bl148-real-lane-fixture.md` §4.4 ② PLAN-0591 M3 zero-egress evidence: `plans/PLAN-0591-XH-provider-tool-capability/evidence/m3-e2e-verification.md` §4 (stub hits = 0, agent `transport_attempt`/`STAGE_ATTEMPT_STARTED`/`tools/call` = 0, no assistant content, no host file) | confirmed (H3 contract violation fixed; H1/H2 model behaviour still open) |
| `xiaomi` / `openai-chat-completions@1` | `true` | PLAN-0372 D5-B frozen evidence: `packages/ui/e2e/real/real-tool-roundtrip.spec.ts` (write_file round-trip over the OpenAI-compatible MiMo connection) | confirmed (0372, 2026-09-19) |
| single-apiType providers | inherited from provider-level `supports.tools` | `plans/PLAN-0591-XH-provider-tool-capability/evidence/m0-capability-matrix.md` (per-provider initial values) | provisional (`待定`) — no apiType-level evidence yet |
| `dashscope-qwen` / `dashscope-multimodal-embedding@1` | `false` | non-chat route by definition (`operation=embedding`); see `spec/protocol/provider-api-types.md` | confirmed |

## Review / flip triggers

Any of: vendor or model documentation claims tool support; a new apiType or
version is registered; tool-related provider-400 reports arrive; the quarterly
review is due.

Before flipping an entry to `true`:

1. Run the E2/E3 experiments from `plans/PLAN-0591-XH-provider-tool-capability/evidence/m0-hypotheses.md`
   so "provider ignored tools" is separated from "model chose not to call".
2. Any real provider call is capped at **one**, requires written user approval, no
   retry, and must not be used to decide H1/H2.
3. Flip as a **data-only** change plus an updated pointer row in this README and a
   `catalogRevision` semantics review — never mixed with logic changes.

Model-level capability (one model of a Type lacking tools) is explicitly out of
scope: it falls back to provider 400 → `LLM_REQUEST_REJECTED`, tracked separately.
