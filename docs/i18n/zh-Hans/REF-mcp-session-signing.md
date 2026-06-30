---
title: REF-001 - MCP Session-id 签名规则
category: dev-guide
lang: zh-Hans
sidebar_group: "参考"
sidebar_order: 51
description: MCP session-id 必须使用 HMAC 签名，禁止明文或仅 Base64 编码。适用于所有通过 MCP 协议传输 workspace 身份标识的场景。
---

# MCP Session-id Signing Rule

## 问题

MCP 通信中 session-id 用于标识 workspace 身份。未签名的 session-id（如仅 Base64 编码的 `ws_id:user_id:timestamp`）可被中间人或恶意工具调用篡改，导致跨 workspace 数据泄露。

```java
// ❌ 禁止 — 仅 Base64 编码，无防篡改
String payload = wsId + ":" + rawSessionId + ":" + timestamp;
return Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes());

// ✅ 必须 — HMAC-SHA256 签名
String payload = wsId + ":" + rawSessionId + ":" + timestamp;
byte[] signature = mac.doFinal(payload.getBytes());
String sigB64 = Base64.getUrlEncoder().withoutPadding().encodeToString(signature);
String payloadB64 = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes());
return payloadB64 + "." + sigB64;
```

## 硬约束

### R1: session-id 必须包含 HMAC 签名

```typescript
// ❌ 禁止
sessionId: base64(ws_id + ":" + user_id + ":" + timestamp)

// ✅ 必须
sessionId: base64(payload) + "." + base64(HMAC-SHA256(payload))
```

### R2: 服务端必须验签

每次收到 session-id 时验证：
1. 检查格式：`payload.signature` 两部分
2. 用相同密钥计算 `HMAC-SHA256(payload)` 并与 `signature` 对比
3. 只有匹配时才信任 session-id 中的 workspace 身份

### R3: 密钥安全

- HMAC 密钥不得硬编码在客户端代码中
- 生产环境密钥通过环境变量或密钥管理服务注入
- 开发/测试环境可使用固定占位密钥

## 验证方法

```bash
# 扫描：检查是否有仅 Base64 编码的 session-id 实现
grep -rn "Base64.*encodeToString.*payload" packages/ --include="*.java" | grep -v "Mac\|hmac\|Hmac"
```

## 审计清单

```
□ 每个 MCP session-id 签发点使用 HMAC-SHA256 签名
□ 每个 session-id 验签点检查 HMAC 签名完整性
□ 无仅 Base64 编码的 session-id 构造逻辑
□ 签名密钥通过环境变量配置，非硬编码
□ 篡改 payload 的请求被拒绝（返回 null 或 403）
```
