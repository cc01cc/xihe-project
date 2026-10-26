# XH 身份认证

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：Security/CP；来源：PLAN-0386、PLAN-0526、PLAN-0537；更新：2026-10-19。
> 消费者：CP API、UI 登录客户端、Agent/Runtime 内部服务客户端

## 1. 当前实现

- 用户注册、登录和 refresh 由 `AuthService` 实现。
- 公开 API 使用 Bearer JWT；当前 JWT 携带用户 id、邮箱、平台角色和 Workspace id。
- 公开 `/api/v1/**` 接受 `USER`/`ADMIN`；内部 `/internal/v1/**` 使用 `INTERNAL_SERVICE` 服务认证。
- OAuth Authorization Code + PKCE 和 provider access token 与 XH 平台 JWT 分开。
- 内部服务 token 由单一环境变量解析：`XIHE_AGENT_API_TOKEN` 优先，`XIHE_CP_API_TOKEN` 回退，缺省为 dev 占位；CP（`cp.agent-api-token`）、Agent（`verify_api_token` / `verify_service_token`）与 Runtime（`has_runtime_service_auth`）共用同一顺序。
- 四条模块间链路（CP↔Agent、Agent↔CP、CP↔Runtime、Runtime↔CP Channel WS）均使用该共享 Bearer token；链路与密钥矩阵以 PLAN-0537 `spec/auth-matrix.md` 与 `DEV-024` 为准。
- MCP 逻辑入口无协议会话：CP **MUST NOT** 签发或回传 `mcp-session-id`，入站携带该头 **MUST** 返回 403 `MCP_SESSION_INVALID`（PLAN-0537）。

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

## 5 登录暴力破解防护（PLAN-0558）

- `POST /api/v1/auth/login` **MUST** 在凭证校验前按「规范化账号（trim + lowercase）」与「解析后的客户端 IP」双维度做失败计数；达到阈值 **MUST** 返回 429 `AUTH_RATE_LIMITED` 与整数 `Retry-After`，并 **MUST NOT** 执行密码哈希。
- 未知账号 **MUST** 与存在账号使用同一计数、同一 429/401 形态和同一 detail；未知账号 **MUST** 执行一次 dummy BCrypt，避免时序枚举。
- 默认阈值：账号 5 次失败 / 900 秒窗口 / 900 秒锁定；IP 20 次 / 900 秒 / 900 秒；全局 BCrypt 并发默认 4。全部由 `cp.auth.login.*` 部署 env 覆盖；0 表示关闭对应维度。
- 计数状态 **MUST** 为 CP 进程内有界表；表满 **MUST NOT** 淘汰锁定或失败中的记录。v1 为单实例语义：多 CP 实例各自计数，重启清空计数与锁定。
- `X-Forwarded-For` **MUST** 默认忽略；仅当 socket `remoteAddr` 命中 `cp.auth.login.trusted-proxies`（IP/CIDR）时，按右向左取第一个非可信 IP；IPv6 默认按 /64 聚合。反代 **MUST** 覆盖而非追加客户端提供的 XFF。
- 锁定 **MUST NOT** 撤销既有 access/refresh token；`/refresh` v1 不限流。账号锁定 **MUST** 自动过期；本地模式（`XIHE_LOCAL_MODE` 生效）下 `/login`、`/local-login`、`/local-password-reset` 不受登录锁定影响。
- `/register` **MUST** 按客户端 IP 做请求限流（默认 30 次 / 3600 秒），并默认豁免回环地址（`cp.auth.login.register.exempt-loopback=true`），避免 host E2E 自锁。
- 失败 **MUST** 写 AUDIT JSONL；锁定/解锁 **MUST** 写 durable `audit_logs`，仅含掩码邮箱、IP、reason 与 requestId，**MUST NOT** 含密码、哈希或 token。

- 部署 env：`XIHE_CP_AUTH_LOGIN_ACCOUNT_{MAX_FAILURES,WINDOW_SECONDS,LOCK_SECONDS}`、`XIHE_CP_AUTH_LOGIN_ACCOUNT_MAX_CONCURRENT`、`XIHE_CP_AUTH_LOGIN_IP_{MAX_FAILURES,WINDOW_SECONDS,LOCK_SECONDS}`、`XIHE_CP_AUTH_LOGIN_GLOBAL_MAX_CONCURRENT`、`XIHE_CP_AUTH_LOGIN_MAX_TRACKED_KEYS`、`XIHE_CP_AUTH_LOGIN_CLEANUP_INTERVAL_MS`、`XIHE_CP_AUTH_TRUSTED_PROXIES`、`XIHE_CP_AUTH_LOGIN_IPV6_PREFIX_LENGTH`、`XIHE_CP_AUTH_LOGIN_REGISTER_{MAX_ATTEMPTS,WINDOW_SECONDS,LOCK_SECONDS}`、`XIHE_CP_AUTH_LOGIN_REGISTER_EXEMPT_LOOPBACK`。默认值以 `application.properties` 为准。
