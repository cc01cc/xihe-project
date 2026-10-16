# XH 身份认证

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：Security/CP；来源：PLAN-0386、PLAN-0526；更新：2026-10-16。
> 消费者：CP API、UI 登录客户端、Agent/Runtime 内部服务客户端

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

## 4. 单机本地模式例外（PLAN-0526）

- `proposed`。单机单用户部署 **MAY** 启用 `XIHE_LOCAL_MODE`（bootstrap env，默认关闭），为登录入口提供显式的 fail-closed 例外。
- 例外只覆盖 `GET /api/v1/auth/bootstrap-status`、`POST /api/v1/auth/local-login`、`POST /api/v1/auth/local-password-reset` 与 register 的省密分支，并 **MUST** 同时满足：模式开启、CP 绑定回环地址、请求来源为回环地址、`Origin`（缺省时为 `Host`）为回环主机。任一不满足 **MUST** 以 404 拒绝且不签发 token；门禁在应用层实现，`SecurityConfig` 不因本例外放开新通配。
- `local-login`/`local-password-reset` **MUST** 仅对**唯一的可登录用户（任意角色，含 ADMIN）**签发；user 数不等于 1 **MUST** 409 拒绝（允许 ADMIN，PLAN-0526 决策 #9）。
- 本地模式 **MUST** 跳过默认 admin seed，使「0 用户」可达（引导）；本地模式注册的用户角色 **MUST** 为 `ADMIN`（决策 #10）。
- 本地模式 **MUST NOT** 改变既有 JWT/授权模型（仍走 `/api/v1/**` 的 `hasAnyRole` 与 grants）；`users.password_hash` 保持 `NOT NULL`，自动密码为真实存储值。
- `bootstrap-status` **MUST** 恒定 200 且只暴露 `initialized`/`localMode` 两个布尔，不参与 I1 门禁。
- 开启 `XIHE_LOCAL_MODE` 时 CP **MUST** 绑定回环地址，且 `XIHE_ENV=prod` 下 **MUST** 拒绝启动。
