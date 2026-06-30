---
title: REF-001 - MCP Session-id Signing Rules
category: dev-guide
lang: en
sidebar_group: "Reference"
sidebar_order: 51
description: MCP session-id must use HMAC signing. Plaintext or Base64-only encoding is prohibited. Applies to all scenarios where workspace identity is transmitted via MCP protocol.
---

# MCP Session-id Signing Rule

## Problem

In MCP communication, session-id is used to identify workspace identity. An unsigned session-id (e.g., only Base64-encoded `ws_id:user_id:timestamp`) can be tampered with by a man-in-the-middle or malicious tool call, leading to cross-workspace data leakage.

```java
// ❌ Prohibited — Base64 encoding only, no tamper protection
String payload = wsId + ":" + rawSessionId + ":" + timestamp;
return Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes());

// ✅ Required — HMAC-SHA256 signing
String payload = wsId + ":" + rawSessionId + ":" + timestamp;
byte[] signature = mac.doFinal(payload.getBytes());
String sigB64 = Base64.getUrlEncoder().withoutPadding().encodeToString(signature);
String payloadB64 = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes());
return payloadB64 + "." + sigB64;
```

## Hard Constraints

### R1: session-id must contain HMAC signature

```typescript
// ❌ Prohibited
sessionId: base64(ws_id + ":" + user_id + ":" + timestamp)

// ✅ Required
sessionId: base64(payload) + "." + base64(HMAC-SHA256(payload))
```

### R2: Server must verify signature

Verify each time a session-id is received:
1. Check format: `payload.signature` two parts
2. Calculate `HMAC-SHA256(payload)` with the same key and compare with `signature`
3. Only trust workspace identity from session-id when they match

### R3: Key security

- HMAC key must not be hardcoded in client code
- Production keys injected via environment variables or key management service
- Development/testing environments can use fixed placeholder keys

## Verification Method

```bash
# Scan: Check for Base64-only session-id implementations
grep -rn "Base64.*encodeToString.*payload" packages/ --include="*.java" | grep -v "Mac\|hmac\|Hmac"
```

## Audit Checklist

```
□ Every MCP session-id issuance point uses HMAC-SHA256 signing
□ Every session-id verification point checks HMAC signature integrity
□ No Base64-only session-id construction logic
□ Signing key configured via environment variable, not hardcoded
□ Requests with tampered payloads are rejected (returns null or 403)
```
