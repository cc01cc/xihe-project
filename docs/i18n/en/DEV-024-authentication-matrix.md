---
title: DEV-024 - Module Authentication and Key Matrix
description: Authentication paths between XH modules, the shared service-token resolution order, the user JWT and external credential boundaries, plus the sessionless MCP logical endpoint.
category: dev-guide
lang: en
sidebar_group: "Developer Guide"
sidebar_order: 24
status: active
created: 2026-10-19
updated: 2026-10-27
---

# DEV-024: Module Authentication and Key Matrix

> Audience: developers and reviewers who need to know "who authenticates this request, with which key".
> Contents: credentials and verification points for seven paths, the key list, and the hard rules.
> Prerequisite reading: [DEV-014 CP Architecture](DEV-014-control-plane-architecture.md), [DEV-016 MCP Architecture](DEV-016-mcp-architecture.md).
> The target contract lives in `spec/security/authentication.md`; this page is the developer-facing expansion.

## 1. Summary

XH uses **two** authentication mechanisms. Do not mix them:

- **External**: user JWT signed with `XIHE_CP_JWT_SECRET`, carried by the browser as `Authorization: Bearer`.
- **Internal**: one **shared static token** (`XIHE_AGENT_API_TOKEN`, falling back to `XIHE_CP_API_TOKEN`) used in all four service directions.

The MCP logical endpoint has **no protocol session**: CP neither issues nor accepts `mcp-session-id`.

### 1.1 Workspace context (PLAN-0559)

- Access tokens are **user-level**: new tokens carry no `workspace_id`; the workspace comes from `X-Workspace-Id` on each request.
- Resolution: `X-Workspace-Id` -> legacy token claim (transition) -> caller default workspace. A present header never falls back to the claim.
- Every request checks active + membership. Roles: OWNER (read/write/manage), EDITOR (read/write), VIEWER (read-only); legacy `ADMIN`/`MEMBER` map to EDITOR.
- Errors: malformed header `400 INVALID_WORKSPACE_ID`; non-member/deleted `403 WORKSPACE_FORBIDDEN`; VIEWER write `403 WORKSPACE_READ_ONLY`.
- Refresh never rebinds a workspace; the optional `X-Workspace-Id` only echoes `workspaceId`.
- v1 has no file/directory locks; shared workspaces rely on fork/branch, declare-before-edit, checkpoints, and avoiding workspace-wide revert.

## 2. Authentication paths

| # | Path | Direction | Credential | Verification point | Failure |
|---|---|---|---|---|---|
| L1 | Browser/external → CP public API | → CP | User JWT | `JwtAuthenticationFilter` + `SecurityConfig` | 401 `AUTHORIZATION_REQUIRED` / 403 `FORBIDDEN` |
| L2 | CP → Agent internal API | CP → Agent | Shared service token | Python `api/shared.py` | 403 `Forbidden: invalid API token` |
| L3 | Agent → CP internal API | Agent → CP | Shared service token | `InternalTokenFilter` | 401 / 403 |
| L4 | CP → Runtime internal API | CP → Runtime | Shared service token | `has_runtime_service_auth` | 401 `AUTHORIZATION_REQUIRED` |
| L5 | Runtime → CP (Channel WS upgrade) | Runtime → CP | Shared service token | `ChannelHandshakeInterceptor` | Handshake rejected |
| L6 | Runtime → upstream remote MCP server | Runtime → external | That server's own OAuth / resource credential | `runtime/src/remote_mcp.rs` | Decided upstream |
| L7 | User → third-party OAuth provider | Browser → external | Authorization Code + PKCE | `OAuthController` / `OAuthTokenBroker` | Callback error page |

L1 and L2–L5 are independent mechanisms; L6/L7 are external boundaries, not platform auth.

## 3. Keys and callers

| Variable | Holder | Verifier | Scope | Requirement |
|---|---|---|---|---|
| `XIHE_CP_JWT_SECRET` | CP | CP | User access/refresh JWT | prod fail-fast on weak default |
| `XIHE_AGENT_API_TOKEN` | deploy injection | CP, Agent | Internal service token (**preferred**) | prod fail-fast |
| `XIHE_CP_API_TOKEN` | deploy injection | CP, Agent, Runtime | Internal service token (**fallback**) | prod fail-fast |
| `XIHE_CP_OAUTH_ENCRYPTION_KEY` | deploy injection | CP | OAuth refresh token encryption | required in prod |
| `XIHE_CP_PROVIDER_CREDENTIALS_KEY` | deploy injection | CP | Provider API key encryption | required in prod |
| `XIHE_CP_CREDENTIALS_KEY` / `_KEY_RING` | deploy injection | CP | User-level credential encryption | required in prod (one of them) |

## 4. Hard rules

- **No substitution**: user JWT, internal service token, and provider access token are not interchangeable.
- **Single resolution order**: every server-side reader uses the same function — `XIHE_AGENT_API_TOKEN` first, `XIHE_CP_API_TOKEN` as fallback, then the dev placeholder. No module may roll its own order.
- **Never logged**: no token may appear in ordinary logs, audit payloads, or documentation examples.
- **Sessionless MCP**: `/api/v1/mcp` accepts `USER`/`ADMIN`/`INTERNAL_SERVICE`; any `mcp-session-id` returns 403 `MCP_SESSION_INVALID`.
- **Separate Runtime boundaries**: the `Authorization` header in L4/L5 is CP↔Runtime service auth; `mcp-session-id` in L6 is a Runtime ↔ upstream MCP session — same name, different meaning.
- **Login throttling (PLAN-0558)**: `POST /api/v1/auth/login` counts credential failures per account and per client IP, returning 429 `AUTH_RATE_LIMITED` + `Retry-After` at the threshold. Unknown accounts share the same shape and run a dummy BCrypt. `X-Forwarded-For` is ignored unless the source is covered by `cp.auth.login.trusted-proxies`; local mode and `/refresh` are exempt, while `/register` is IP-limited with loopback exempt by default.

## 5. Troubleshooting

| Symptom | Check first |
|---|---|
| Browser 401 | JWT expiry; whether `XIHE_CP_JWT_SECRET` matches the issuer |
| CP ↔ Agent 403 | Whether both sides use the same `XIHE_AGENT_API_TOKEN` / `XIHE_CP_API_TOKEN` |
| CP → Runtime 401 | Runtime only reads `XIHE_CP_API_TOKEN`; setting only `XIHE_AGENT_API_TOKEN` breaks parity |
| MCP 403 `MCP_SESSION_INVALID` | The caller sent `mcp-session-id`; the platform has no session semantics |
| Startup failure | Review the dangerous-default list in `spec/config-env-target.md` §6 |

## 6. History

- PLAN-0308 M2 (2026-09-13): logical MCP became sessionless; CP stopped issuing, echoing, and forwarding `mcp-session-id`.
- PLAN-0407 T1.3 (2026-09-24): the HMAC signing key was externalized into a required environment variable.
- PLAN-0537 (2026-10-19): that key was retired entirely (the issuing side no longer exists); inbound headers now fail closed with 403; Agent-side token resolution was unified.
