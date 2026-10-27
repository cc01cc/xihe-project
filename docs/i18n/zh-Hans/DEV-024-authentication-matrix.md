---
title: DEV-024 - 模块认证与密钥矩阵
description: XH 各模块间的认证链路、共享服务 token 解析顺序、用户 JWT 与外部凭据边界，以及 MCP 逻辑入口的无会话规则。
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 24
status: active
created: 2026-10-19
updated: 2026-10-27
---

# DEV-024: 模块认证与密钥矩阵

> 读者：需要判断"某个请求由谁认证、用哪个密钥"的开发者与审查者。
> 内容：七条链路的凭据与校验位置、密钥清单、必须遵守的规则。
> 前置阅读：[DEV-014 CP 架构](DEV-014-control-plane-architecture.md)、[DEV-016 MCP 架构](DEV-016-mcp-architecture.md)。
> 目标态契约见 `spec/security/authentication.md`；本文是其面向开发者的展开。

## 1. 一句话结论

XH 有**两套**认证，不要混用：

- **对外**：用户 JWT（`XIHE_CP_JWT_SECRET` 签发），由浏览器携带 `Authorization: Bearer`。
- **对内**：一把**共享静态 token**（`XIHE_AGENT_API_TOKEN`，回退 `XIHE_CP_API_TOKEN`），四个服务方向全部用它。

此外 MCP 逻辑入口**没有协议会话**：CP 不签发也不接受 `mcp-session-id`。

### 1.1 工作区上下文（PLAN-0559）

- access token 是**用户级**的：新 token 不含 `workspace_id`；工作区由逐请求 `X-Workspace-Id` 决定。
- 解析优先级：`X-Workspace-Id` → 旧 token claim（过渡）→ 用户默认工作区；header 存在时绝不回落 claim。
- 逐请求校验 active + membership；角色矩阵 OWNER（读写+管理）/ EDITOR（读写）/ VIEWER（只读）。legacy `ADMIN`/`MEMBER` 映射为 EDITOR。
- 失败：非法 header `400 INVALID_WORKSPACE_ID`；非成员/已删 `403 WORKSPACE_FORBIDDEN`；VIEWER 写 `403 WORKSPACE_READ_ONLY`。
- refresh 不重绑工作区；可选 `X-Workspace-Id` 只回填响应 `workspaceId`。
- v1 无文件/目录锁；共享工作区以 fork/branch、先声明再改、checkpoint、避免 workspace 级 revert 协作。

## 2. 认证链路

| # | 链路 | 方向 | 凭据 | 校验位置 | 失败语义 |
|---|---|---|---|---|---|
| L1 | 浏览器/外部 → CP 公开 API | → CP | 用户 JWT | `JwtAuthenticationFilter` + `SecurityConfig` | 401 `AUTHORIZATION_REQUIRED` / 403 `FORBIDDEN` |
| L2 | CP → Agent 内部 API | CP → Agent | 共享服务 token | Python `api/shared.py` | 403 `Forbidden: invalid API token` |
| L3 | Agent → CP 内部 API | Agent → CP | 共享服务 token | `InternalTokenFilter` | 401 / 403 |
| L4 | CP → Runtime 内部 API | CP → Runtime | 共享服务 token | `has_runtime_service_auth` | 401 `AUTHORIZATION_REQUIRED` |
| L5 | Runtime → CP（Channel WS 升级） | Runtime → CP | 共享服务 token | `ChannelHandshakeInterceptor` | 握手拒绝 |
| L6 | Runtime → 上游远程 MCP server | Runtime → 外部 | 该 server 自己的 OAuth / 资源凭据 | `runtime/src/remote_mcp.rs` | 由上游决定 |
| L7 | 用户 → 第三方 OAuth provider | 浏览器 → 外部 | Authorization Code + PKCE | `OAuthController` / `OAuthTokenBroker` | 回调错误页 |

L1 与 L2–L5 是两套独立机制；L6/L7 是外部边界，不属平台认证。

## 3. 密钥与调用方

| 变量 | 持有者 | 校验者 | 作用域 | 必需性 |
|---|---|---|---|---|
| `XIHE_CP_JWT_SECRET` | CP | CP | 用户 access/refresh JWT | prod fail-fast（弱默认值被拒） |
| `XIHE_AGENT_API_TOKEN` | 部署注入 | CP、Agent | 内部服务 token（**优先**） | prod fail-fast |
| `XIHE_CP_API_TOKEN` | 部署注入 | CP、Agent、Runtime | 内部服务 token（**回退**） | prod fail-fast |
| `XIHE_CP_OAUTH_ENCRYPTION_KEY` | 部署注入 | CP | OAuth refresh token 加密 | prod 必需 |
| `XIHE_CP_PROVIDER_CREDENTIALS_KEY` | 部署注入 | CP | Provider API key 加密 | prod 必需 |
| `XIHE_CP_CREDENTIALS_KEY` / `_KEY_RING` | 部署注入 | CP | 用户级凭据加密 | prod 必需（二者之一） |

## 4. 必须遵守的规则

- **不得互换**：用户 JWT、内部服务 token、provider access token 三者互不通用。
- **单一解析顺序**：所有服务端读取内部 token 时走同一函数——`XIHE_AGENT_API_TOKEN` 优先，`XIHE_CP_API_TOKEN` 回退，缺省 dev 占位。禁止各模块自行拼顺序。
- **不落日志**：任何 token 不得进入普通日志、审计 payload 或文档示例。
- **MCP 入口无会话**：`/api/v1/mcp` 接受 `USER`/`ADMIN`/`INTERNAL_SERVICE`；携带 `mcp-session-id` 一律 403 `MCP_SESSION_INVALID`。
- **Runtime 边界分离**：L4/L5 的 `Authorization` 是 CP↔Runtime 服务认证；L6 的 `mcp-session-id` 是 Runtime 与上游 MCP server 的会话，同名不同义。
- **登录限流（PLAN-0558）**：`POST /api/v1/auth/login` 按账号 + 客户端 IP 双维度失败计数，达到阈值返回 429 `AUTH_RATE_LIMITED` + `Retry-After`；未知账号同形并执行 dummy BCrypt；`X-Forwarded-For` 默认忽略，仅 `cp.auth.login.trusted-proxies` 命中的来源才解析；本地模式与 `/refresh` 豁免，`/register` 按 IP 限流且默认豁免回环。

## 5. 排障入口

| 现象 | 先看 |
|---|---|
| 浏览器 401 | JWT 是否过期；`XIHE_CP_JWT_SECRET` 是否与签发方一致 |
| CP ↔ Agent 403 | 两端 `XIHE_AGENT_API_TOKEN` / `XIHE_CP_API_TOKEN` 是否同值 |
| CP → Runtime 401 | Runtime 只读 `XIHE_CP_API_TOKEN`；若只设了 `XIHE_AGENT_API_TOKEN` 则不一致 |
| MCP 403 `MCP_SESSION_INVALID` | 调用方擅自携带了 `mcp-session-id`；本平台已无会话语义 |
| 启动即失败 | 检查 `spec/config-env-target.md` §6 的危险默认清单 |

## 6. 历史变更

- PLAN-0308 M2（2026-09-13）：逻辑 MCP 改为无会话，CP 停止签发/回传/转发 `mcp-session-id`。
- PLAN-0407 T1.3（2026-09-24）：HMAC 签名密钥外置为必需环境变量。
- PLAN-0537（2026-10-19）：该密钥整体退役（签发端已不存在），入站携带改为显式 403；Agent 侧 token 解析统一。
