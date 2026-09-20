# XH 身份认证

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：Security/CP；来源：PLAN-0386；更新：2026-09-20。

## 1. 当前实现

- 用户注册、登录和 refresh 由 `AuthService` 实现。
- 公开 API 使用 Bearer JWT；当前 JWT 携带用户 id、邮箱、平台角色和 Workspace id。
- 公开 `/api/v1/**` 接受 `USER`/`ADMIN`；内部 `/internal/v1/**` 使用 `INTERNAL_SERVICE` 服务认证。
- OAuth Authorization Code + PKCE 和 provider access token 与 XH 平台 JWT 分开。

## 2. 规则

- Authentication **MUST** 在授权或 Workspace 访问前确认 principal 身份。
- 用户 JWT、内部服务 token 和 provider access token **MUST NOT** 互换使用。
- access/refresh token 内容、Cookie、Authorization header 和 provider secret **MUST NOT** 进入普通日志或审计 payload。
- 无效或过期凭证 **MUST** fail-closed，并返回稳定的 Problem Details code 和 requestId。
- OAuth requested scope 与 provider 返回的 scope **MUST** 做相等或明确允许的收窄校验；不一致时必须重新认证。

## 3. 目标差距

DEV-032 提出 `human/agent/service/system` 四类 principal，以及独立的 Agent 身份。当前 CP 表结构和 `AuthService` 仍以 user 为中心。该目标目前仅为 proposed；在独立身份 PLAN 冻结 schema 和 delegation 语义前，不启用 Agent principal，也不执行迁移。
