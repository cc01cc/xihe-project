---
title: DEV-019 - 数据库设计
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 19
status: active
created: 2026-09-07
updated: 2026-10-08
description: XH PostgreSQL 全量表结构速查：业务表按域分组、ER 关系、字段约束与索引、当前 V1~V56 升级迁移对照（PLAN-280 rebaseline 后）与本地查看方法
tags:
  - postgres
  - flyway
  - schema
---

# DEV-019: 数据库设计

> 读者：新加入 XH 的后端 / 全栈开发者。内容：当前最终库表一览（结论先行），细节按域查表。Schema Source of Truth 是 `packages/control-plane/src/main/resources/db/migration` 的 V1~V56 Flyway 升级链；已删除的 Ledger 只留在历史迁移记录，JPA Entity 仅镜像当前 schema。前置阅读：[DEV-001](DEV-001-system-architecture.md)（四模块与 PG 定位）、[DEV-014](DEV-014-control-plane-architecture.md)（CP 通道）、[DEV-017](DEV-017-session-architecture.md)（会话语义）、[DEV-003](DEV-003-config-management.md)（Config 三层）。

## 1. 结论与使用规则

| 结论 | 内容 |
|------|------|
| 数据库 | PostgreSQL 17 + pgvector，Docker 镜像 `pgvector/pgvector:pg17`，dev 端口 `12634`，库名/用户名 `xihe` |
| 表数量 | 44 张业务表 + `flyway_schema_history`（Flyway 自维护） + 1 个只读 Audit view (`v_audit_entries`)，按 V56 fresh schema 盘点 |
| 权威顺序 | Flyway SQL > JPA Entity > 本文档；`ddl-auto=validate`（PLAN-280），Flyway 是唯一 schema manager |
| 主键风格 | 全部 PostgreSQL 原生 `UUID`（PLAN-280）；Java 侧 @Id 为 `UUID` 类型，FK 列为 `String` + `UuidStringConverter` |
| 时间风格 | 当前 Flyway 链的时间列均为带时区类型：`TIMESTAMPTZ`（V21/V23 以等价的 `TIMESTAMP WITH TIME ZONE` 书写），默认值按各迁移定义；不存在裸 `TIMESTAMP` |
| 删除语义 | `workspaces.deleted_at` 软删 + 部分唯一索引；`messages/context_*` 随 `sessions` 级联删；`files.message_id` 置空 |
| 扩展 | `V1` 内 `CREATE EXTENSION IF NOT EXISTS vector`（幂等）；`document_chunks` 由 Agent 侧 langchain_postgres 自建自管，不在 Flyway 链内 |
| 表格式约定 | 每张表：字段表（一行一字段，`约束` 列只放单列约束）+ 表下索引注释（`CREATE INDEX` 与跨列唯一约束） |

关键入口：

| 入口 | 路径 |
|------|------|
| Compose PG 定义 | `docker-compose.yml`（`postgres` 服务，`./postgres-init:/docker-entrypoint-initdb.d:ro`） |
| 扩展初始化 | `postgres-init/01-enable-pgvector.sql` |
| 连接配置 | `packages/control-plane/src/main/resources/application.properties:12-24`（`datasource.url`、`flyway.locations=classpath:db/migration`） |
| 迁移链 | `packages/control-plane/src/main/resources/db/migration/V1__init_schema.sql` 至 V56（当前 active upgrade chain；V56 removes retired Ledger tables） |
| Entity 镜像 | `packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/entity/` 与 `context/entity/`（按当前源码为准） |
| Seed | `packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/config/DataSeeder.java`（仅 seed `admin@xihe.local`，密码随机不落日志） |

> **PLAN-280 rebaseline（2026-09-07）**：`V1__init_schema.sql` 是当前链的 schema 基线；V2–V56 在 active classpath 按顺序用于既有库升级。V56 是当前 schema 终点：移除 Operation Ledger tables 与 Workspace Job transition anchor。V49–V56 已按唯一连续版本整合 Follow-up、MCP、Approval、ChatRun、Workspace Job、Audit 与 Ledger retirement。统一原生 UUID、带时区时间类型、显式命名约束与 ON DELETE、`ddl-auto=validate`。更早的历史 V1~V22+U6 编号仍仅作 Git 历史溯源。`spring-boot-flyway` 模块缺失曾导致 Flyway 自动配置从未生效（schema 实际由 Hibernate 建），已在本轮修复。
>
> **版本标注约定**：§2/§3 各表括注与附录 A「旧链首次迁移」列的 `V<n>` 若注明“旧链”，仅用于迁移溯源；active 链统一以 §4 和 Flyway history（V1~V56）为准。逐表变更见 §4。

## 2. ER 关系（分域 erDiagram）

> 按域拆成 6 张 `erDiagram`（单图塞全部表会挤成一团）。基数记法：`||--o{` 1 对 0..N，`||--|{` 1 对 1..N，`}o--||` N..0 对 1。无边实体（独立/弱关联表）单独标注。跨域关系在所属域内展示（如 `sessions → context_events` 属配置域视角）。

### 2.1 身份协作（主链）

```mermaid
%%{init: {'theme': 'neutral'}}%%
erDiagram
    users ||--o{ workspaces : owns
    users ||--o{ workspace_users : "joins (m2m)"
    workspaces ||--o{ workspace_users : "has (m2m)"
    workspaces ||--o{ sessions : contains
    users ||--o{ sessions : creates
    sessions ||--o{ messages : contains
    sessions ||--o{ chat_runs : runs
    sessions ||--o{ session_follow_up_items : queues
    chat_runs ||--o{ messages : produces
    chat_runs ||--o{ approval_requests : requires
```

- `users → workspaces`：`owner_id` FK + 部分唯一（活跃期每 owner 一个 workspace）
- `workspace_users`：联合 PK `(workspace_id, user_id)`，多对多关联表
- `chat_runs → messages`：经 `user_message_id`/`assistant_message_id` 逻辑关联（无 FK 约束）
- `chat_runs → approval_requests`：`run_id` FK
- `sessions → session_follow_up_items`：`ON DELETE CASCADE`（Session 删除零孤儿）；item 对 child Run/Message 为 `SET NULL`（PLAN-0442，见 §3.2）

### 2.2 Workspace 执行

```mermaid
%%{init: {'theme': 'neutral'}}%%
erDiagram
    workspaces ||--o{ workspace_execution_specs : "revisions by generation"
    workspaces ||--o{ run_checkpoints : "owns slices"
```

- `workspace_execution_specs.workspace_id` FK CASCADE；联合唯一 `(workspace_id, generation)`，每代一条规格快照

### 2.3 MCP 与 Provider

```mermaid
%%{init: {'theme': 'neutral'}}%%
erDiagram
    workspaces ||--o{ mcp_servers : registers
    mcp_servers ||--o{ mcp_tool_aliases : exposes
    mcp_servers ||--o{ oauth_credentials : authorizes
    provider_connections ||--o{ provider_credential_leases : "leases credentials"
```

- `mcp_servers` 归属 `workspaces`（`workspace_id` FK，跨域引用身份协作域）
- `mcp_tool_aliases`：联合 PK `(workspace_id, issued_name)`；`server_id` 为逻辑外键（无 FK 约束）
- `oauth_credentials`：唯一 `(user_id, workspace_id, server_id)`，三向绑定
- `provider_credential_leases.provider_connection_id` FK CASCADE；租约发 Agent 一次性使用
- `provider_connection_audit`：无边实体，`provider_connection_id` 可空（删连接留痕），见 §3.4

### 2.4 配置与 RAG / 上下文

```mermaid
%%{init: {'theme': 'neutral'}}%%
erDiagram
    config ||--o{ config_audit : audited
    sessions ||--o{ context_events : "appends (es)"
    sessions ||--|| context_projections : materializes
```

- `config_audit.config_id` FK config **ON DELETE SET NULL**（V12 起审计行不随配置删除丢失，决策 #30）；按 `(layer, domain, config_key [+ user_id/workspace_id])` 定位历史配置行（`environment` 为历史快照列）
- `context_events`：UNIQUE `(session_id, sequence)`，Event Sourcing 只追加
- `context_projections`：UNIQUE `session_id`，单会话单读模型，可由事件重放重建
- `context_source_hashes` / `document_chunks`：无边实体（前者按 `(workspace_id, source_key)` 去重，后者无 FK 独立生命周期），见 §3.5

### 2.5 文件审计

```mermaid
%%{init: {'theme': 'neutral'}}%%
erDiagram
    users ||--o{ files : uploads
    workspaces |o--o{ files : "scopes (nullable)"
    sessions ||--o{ files : attaches
    messages |o--o{ files : "references (set null)"
```

- `files.user_id` FK NOT NULL；`workspace_id` FK 可空；`session_id` FK CASCADE；`message_id` FK SET NULL
- `audit_logs`：无边实体，`user_id`/`workspace_id` 均可空 FK，业务审计与 `audit.log` 文件互补，见 §3.6

### 2.6 全局视角（单图总览，弱化布局质量换全貌）

```mermaid
%%{init: {'theme': 'neutral'}}%%
erDiagram
    users ||--o{ workspaces : owns
    users ||--o{ sessions : creates
    workspaces ||--o{ sessions : contains
    sessions ||--o{ messages : contains
    sessions ||--o{ chat_runs : runs
    chat_runs ||--o{ messages : produces
    workspaces ||--o{ workspace_execution_specs : revisions
    workspaces ||--o{ run_checkpoints : owns
    workspaces ||--o{ mcp_servers : registers
    mcp_servers ||--o{ oauth_credentials : authorizes
    provider_connections ||--o{ provider_credential_leases : leases
    config ||--o{ config_audit : audited
    sessions ||--o{ context_events : appends
    sessions ||--|| context_projections : materializes
    sessions ||--o{ files : attaches
    mcp_invocations ||--o{ mcp_attempts : attempts
    mcp_invocations ||--o{ mcp_dispatch_history : history
    approval_requests |o--o{ mcp_invocations : "optional approval (set null)"
    workspaces ||--o{ workspace_jobs : jobs
    sessions |o--o{ workspace_jobs : "session scope (cascade)"
    chat_runs |o--o{ workspace_jobs : "run scope (set null)"
    workspace_jobs ||--o{ workspace_job_history : transitions
```

代码锚点：实体 = 表名；关系名 = 外键语义（括注为特殊语义：m2m 关联表、无 FK 约束的逻辑外键、nullable、ES 只追加）；无边实体清单见各域小节。字段/索引细节见 §3，DDL 见 §4 迁移对照，Entity 见附录 A。

### 2.7 域持久化与任务连续性

```mermaid
%%{init: {'theme': 'neutral'}}%%
erDiagram
    mcp_invocations ||--o{ mcp_attempts : "attempts (cascade)"
    mcp_invocations ||--o{ mcp_dispatch_history : "history (cascade)"
    approval_requests |o--o{ mcp_invocations : "optional approval (set null)"
    workspaces ||--o{ workspace_jobs : "jobs (cascade)"
    sessions |o--o{ workspace_jobs : "session scope (cascade)"
    chat_runs |o--o{ workspace_jobs : "run scope (set null)"
    workspace_jobs ||--o{ workspace_job_history : "transitions (cascade)"
    chat_runs ||--o{ task_plans : "plans (cascade)"
    workspaces ||--o{ task_plans : "plans (cascade)"
    task_plans ||--o{ task_items : "steps (cascade)"
```

- V56 后按域存储：MCP invocation、attempt 与 dispatch history 由 MCP execution domain 持有；Job 状态与 transition history 由 Workspace Job domain 持有。`approval_request_id` 是可空硬 FK，删除审批时 `SET NULL`，不级联删除 invocation。
- `task_plans`/`task_items` 为 run 任务连续性（`V6`，见 §3.8）；`task_plans.session_id` 无 FK，仅 run/workspace 建 FK。

## 3. 按域表详情

### 3.1 身份（users）

**users**（`V1`，Entity `entity/User.java`）：唯一登录主体，`role` 仅 `USER/ADMIN`。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK | UUID 字符串 |
| email | VARCHAR(255) | NOT NULL UNIQUE | 登录键，`DataSeeder` seed `admin@xihe.local` |
| password_hash | VARCHAR(255) | NOT NULL | BCrypt，不存明文 |
| role | VARCHAR(20) | NOT NULL DEFAULT 'USER' | `USER` / `ADMIN` |
| name | VARCHAR(100) | nullable | 展示用 |
| avatar | VARCHAR(512) | nullable | 展示用 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | 无自动更新触发器，靠 JPA 维护 |

> 索引：`idx_users_email (email)`

### 3.2 协作（workspaces / workspace_users / sessions / messages / chat_runs / run_checkpoints / approval_requests / session_follow_up_items）

**workspaces**（`V1` + `V2/V11/V14`，Entity `entity/Workspace.java`）：`owner_id` 拥有者，`deleted_at` 软删后同 owner 可重建。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK | — |
| name | VARCHAR(255) | NOT NULL | — |
| description | TEXT | nullable | — |
| owner_id | VARCHAR(36) | NOT NULL FK `users(id)` | 拥有者 |
| storage_backend | VARCHAR(32) | DEFAULT 'host_directory'（`V11`） | 当前 v1 仅 `host_directory` |
| storage_ref | VARCHAR(64) | nullable（`V11`） | `host_directory` 根下 `workspaceId` 派生（历史 `storage_path` 已随 `V32` 删除） |
| generation | INT | DEFAULT 0（`V11`） | 当前执行代数，与 `workspace_execution_specs.generation` 对齐 |
| sandbox_spec_hash | VARCHAR(64) | nullable（`V11`） | 当前生效规格哈希 |
| sandbox_spec | JSONB | nullable（`V11`） | 当前生效规格快照 |
| deleted_at | TIMESTAMPTZ | nullable（`V14`） | 软删标记，删后不阻塞同 owner 新建 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |

> 索引：
> - `idx_workspaces_owner_id (owner_id)`
> - `idx_workspaces_owner_active (owner_id, created_at) WHERE deleted_at IS NULL` — 部分索引，活跃 workspace 查询（`V14`）
> - 唯一约束 `uq_workspaces_active_owner (owner_id) WHERE deleted_at IS NULL` — 部分唯一，软删后同 owner 可重建（`V14`）

**workspace_users**（`V1` + `V14` 加复合索引，Entity `entity/WorkspaceUser.java`）：多对多成员。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| workspace_id | VARCHAR(36) | NOT NULL FK `workspaces(id)`，联合 PK | 归属 |
| user_id | VARCHAR(36) | NOT NULL FK `users(id)`，联合 PK | 成员 |
| role | VARCHAR(20) | NOT NULL DEFAULT 'MEMBER' | 成员角色 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | 加入时间 |

> 索引：
> - `idx_workspace_users_user_id (user_id)`
> - `idx_workspace_users_user_workspace (user_id, workspace_id)` — 双向查（`V14`）

**sessions**（`V1` + `V14/V19/V24/V37/V40/V48`，Entity `entity/Session.java`）：服务端 canonical 会话，含单父 Session/run provenance 与派生 kind，详见 [DEV-017](DEV-017-session-architecture.md)。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK | 会话键，SSE `sessionId` 即此 |
| workspace_id | VARCHAR(36) | NOT NULL FK `workspaces(id)` | 归属 |
| user_id | VARCHAR(36) | NOT NULL FK `users(id)` | 归属 |
| title | VARCHAR(255) | nullable | 列表展示 |
| model_provider | VARCHAR(50) | nullable | canonical pair 前半 |
| model_name | VARCHAR(100) | nullable | canonical pair 后半，普通 chat `toolMode=none` |
| archived | BOOLEAN | NOT NULL DEFAULT FALSE | 归档非删除 |
| provider_connection_id | VARCHAR(36) | nullable，无 FK（`V19`） | 逻辑绑定，不做外键避免跨域耦合 |
| connection_revision | BIGINT | nullable（`V19`） | 绑定时的连接版本 |
| approval_mode | VARCHAR(16) | nullable，`ck_sessions_approval_mode`（`V24`） | 会话审批模式 `manual`/`auto`；NULL = 继承 workspace 的 `approval-policy.mode`（PLAN-0337） |
| spawned_from_session_id | UUID | nullable（`V37`） | 父 Session；spawn/fork 的单父来源，不做 FK 级联 |
| spawned_from_run_id | UUID | nullable（`V37`） | 父 ChatRun；停止传播与 lineage 查询来源 |
| spawned_at | TIMESTAMPTZ | nullable（`V37`） | 派生创建时间 |
| kind | VARCHAR(16) | nullable，`ck_sessions_kind` + `ck_sessions_provenance_shape`（`V40`） | root 四字段全 NULL；派生 Session 四字段全 NOT NULL，`spawn`/`fork` |
| context_template_layer | VARCHAR(16) | NOT NULL DEFAULT 'instance'，`ck_sessions_context_template_layer`（`V48`） | PLAN-0414：钉住的上下文模板来源层 `instance`/`user`/`workspace`（显式层，非 merged） |
| context_template_id | UUID | NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'（`V48`） | PLAN-0414：上下文模板稳定 ID；修订在其配置层内追加不可变 |
| context_template_version | INTEGER | NOT NULL DEFAULT 1，`ck_sessions_context_template_version > 0`（`V48`） | PLAN-0414：Session 钉住的不可变修订；显式切换只影响后续 Run |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |

> 索引：
> - `idx_sessions_workspace_id (workspace_id)`
> - `idx_sessions_user_id (user_id)`
> - `idx_sessions_archived (archived)`
> - `idx_sessions_workspace_user_active (workspace_id, user_id, archived, created_at DESC)` — 会话列表复合索引（`V14`）
> - `idx_sessions_provider_connection (provider_connection_id)`（`V19`）
> - `idx_sessions_spawned_from_session (spawned_from_session_id) WHERE spawned_from_session_id IS NOT NULL`（`V37`）
> - `idx_sessions_spawned_from_run (spawned_from_run_id) WHERE spawned_from_run_id IS NOT NULL`（`V37`）

**messages**（`V1` + `V6/V14/V16`，Entity `entity/Message.java`）：`session_id` 级联删（`V14` 重建 FK 加 `ON DELETE CASCADE`）。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK | — |
| session_id | VARCHAR(36) | NOT NULL FK `sessions(id) ON DELETE CASCADE` | 删会话清消息 |
| role | VARCHAR(20) | NOT NULL | `user/assistant/system/tool` 等，见 `MessageRole` |
| content | TEXT | NOT NULL | 正文 |
| attachments | JSONB | nullable（`V6`） | 内联附件摘要，canonical 附件在 `files` |
| run_id | VARCHAR(36) | nullable FK `chat_runs(id)`（`V16`） | 归属轮次，见 §3.2 `chat_runs` |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | 排序键 |

> 索引：
> - `idx_messages_session_id (session_id)`
> - `idx_messages_run_id (run_id)`（`V16`）

**chat_runs**（`V16` + `V19/V22/V39/V48`，Entity `entity/ChatRun.java`）：一次用户提交或 CP 内部 spawn 派生执行（PLAN-247/0407），同幂等键不重复起 Agent。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK | — |
| session_id | VARCHAR(36) | NOT NULL FK `sessions(id)` | 归属 |
| user_id | VARCHAR(36) | NOT NULL FK `users(id)` | 归属 |
| workspace_id | VARCHAR(36) | NOT NULL FK `workspaces(id)` | 归属 |
| idempotency_key | VARCHAR(128) | NOT NULL | 幂等键，见下方唯一约束 |
| request_hash | VARCHAR(64) | NOT NULL | 请求 payload 哈希，同 key 比对 |
| origin | VARCHAR(24) | NOT NULL，`ck_chat_runs_origin`（`V39`） | `user_submission` / `spawn`；历史行回填为 user_submission；公开 POST 只允许前者 |
| provider | VARCHAR(50) | nullable | 全链路透传 |
| model | VARCHAR(100) | nullable | 全链路透传 |
| tool_mode | VARCHAR(20) | NOT NULL DEFAULT 'none' | 普通 chat `none`，workspace 操作 `workspace` |
| context_template_snapshot | JSONB | NOT NULL DEFAULT '{}'，`ck_chat_runs_context_template_snapshot_object`（`V48`） | PLAN-0414：admission 时从 Session 钉住的模板修订复制的原子快照；在途 Run 永不随模板编辑漂移 |
| user_message_id | VARCHAR(36) | nullable，无 FK | 逻辑关联，避免循环 FK |
| assistant_message_id | VARCHAR(36) | nullable，无 FK | 逻辑关联，避免循环 FK |
| status | VARCHAR(24) | NOT NULL | 运行态 |
| terminal_outcome | VARCHAR(24) | nullable | `success/error/partial/ambiguous` 终态 |
| error_code | VARCHAR(64) | nullable | 给 UI 分支 |
| error_detail | TEXT | nullable | 脱敏后写 |
| token_count | INTEGER | NOT NULL DEFAULT 0 | 计量 |
| assistant_chars | INTEGER | NOT NULL DEFAULT 0 | 计量 |
| provider_connection_id | VARCHAR(36) | nullable，无 FK（`V19`） | 本轮实际用的连接 |
| connection_revision | BIGINT | nullable（`V19`） | 连接版本快照 |
| lease_owner | VARCHAR(80) | nullable（`V22`） | 单并发租约持有者，防双发 |
| lease_expires_at | TIMESTAMPTZ | nullable（`V22`） | 租约过期时间 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | — |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | — |

> 索引：
> - `idx_chat_runs_session_created (session_id, created_at)`
> - `idx_chat_runs_provider_connection (provider_connection_id, connection_revision)`（`V19`）
> - `idx_chat_runs_active_lease (session_id, status, lease_expires_at)` — 活跃租约判定（`V22`）
> - 唯一约束 `(user_id, session_id, idempotency_key)` — 同 key 不重复起 run，同 key 不同 payload 报冲突
> - 部分唯一 `uq_chat_runs_spawn_event_idempotency (user_id, idempotency_key) WHERE origin='spawn'`（`V39`）— 同父 durable event 即使重试使用不同 child Session 也只落一个 spawn ChatRun

**grants**（`V38`，Entity `entity/AuthorizationGrant.java`）：主体授权的可升级存储；多态 principal 引用不设跨域 FK。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK | — |
| granter_type / granter_id | VARCHAR(24) / UUID | nullable，成对检查 `ck_grants_granter_ref` | 授权来源 principal；系统 seed 可为空 |
| subject_type / subject_id | VARCHAR(24) / UUID | NOT NULL | 实际接收权限的 principal（user/agent） |
| permissions | JSONB atom array | NOT NULL | canonical `[{actionClass, resource?}]`；省略 resource 等于 `*`；未列即 deny，无 effect/priority 字段 |
| source | VARCHAR(16) | NOT NULL，`ck_grants_source` | `default/spawn/direct/template` |
| role_name / template_name | TEXT | nullable | 来源名称快照 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | 创建时间 |
| read_state | VARCHAR(16) | NOT NULL DEFAULT `unread`，`ck_grants_read_state` | `unread/read` 收件状态 |

> 索引：`idx_grants_subject(subject_type, subject_id)`；`uq_grants_default_subject(subject_type, subject_id) WHERE source='default'` — 每主体一份默认权限集；spawn/direct/template 同主体允许多条。

**run_checkpoints**（PLAN-0339 T0.4 / V27 重建，workspace 切片记录）：每行代表一个 workspace 时间线切片，不再代表某个 Run 的区间。0339 上线时先物理清空旧记录行，再按以下切片语义重建；不转换、不回填旧格式数据。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK | CP 切片记录行键 |
| workspace_id | VARCHAR(36) | NOT NULL FK `workspaces(id) ON DELETE CASCADE` | workspace 归属 |
| slice_ref | TEXT | nullable（有效切片唯一；降级捕获可为空） | Runtime 影子 Git `refs/xihe/slices/<capturedAt>-<hash>` |
| captured_at | TIMESTAMPTZ | nullable（降级捕获可为空） | 切片捕获时刻；按此排序 |
| source_run_id | VARCHAR(36) | nullable | 产生该切片的 Run；C0 可空 |
| source_session_id | VARCHAR(36) | nullable | 来源会话；C0/异常补拍可空 |
| predecessor_ref | TEXT | nullable | 捕获时链尾前驱，缺失时不回填全量差异 |
| changed_files | JSONB | NOT NULL DEFAULT '[]' | 相对前一切片的 `[{status, path}]`，不做来源归因 |
| changed_count | INTEGER | NOT NULL DEFAULT 0 | 完整变更数量，不受 UI 列表截断影响 |
| opaque_nested_repos | JSONB | NOT NULL DEFAULT '[]' | 不透明 gitlink 路径清单，内容不参与恢复 |
| state | VARCHAR(24) | NOT NULL CHECK `captured/abnormal-captured/degraded/expired` | 捕获状态；`degraded` 仅表示捕获失败 |
| unrollable_reason | VARCHAR(64) | nullable | 当前仅 `UNAVAILABLE` |
| revert_state | VARCHAR(16) | NOT NULL DEFAULT 'none' | `none/rolled_back/partial/failed` |
| revert_ref | TEXT | nullable | 本次恢复目标切片 ref |
| revert_summary | JSONB | nullable | 脱敏后的计数、逐路径结果、安全原因 |
| reverted_at | TIMESTAMPTZ | nullable | 最近一次接受的恢复时间 |
| revert_attempt_count | INTEGER | NOT NULL DEFAULT 0 | 恢复尝试次数 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | 记录创建时间 |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | 记录更新时间 |

> 索引与约束：`idx_run_checkpoints_workspace_captured (workspace_id, captured_at DESC)`；有效 `slice_ref` 在 workspace 内唯一。公共列表只返回非 `expired` 行；清理流程先成功删除 Runtime shadow Git，再删除该 workspace 的切片记录行。

**approval_requests**（基线 `V1` 内建，`V7` 加 `grant_consumed_at`，`V9` 加 `arguments_hash`，`V25` 加 `origin`；Entity `entity/ChatApproval.java`）：工具高危操作人审。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| request_id | VARCHAR(36) | PK | 请求键 |
| run_id | VARCHAR(36) | NOT NULL FK `chat_runs(id)` | 归属轮次 |
| session_id | VARCHAR(36) | NOT NULL FK `sessions(id)` | 归属 |
| user_id | VARCHAR(36) | NOT NULL FK `users(id)` | 归属 |
| workspace_id | VARCHAR(36) | NOT NULL FK `workspaces(id)` | 归属 |
| tool | VARCHAR(80) | NOT NULL | 待审批工具 |
| action | VARCHAR(512) | NOT NULL | 待审批动作 |
| details | TEXT | nullable | 动作详情 |
| state | VARCHAR(24) | NOT NULL | `pending/approved/rejected/expired` 等 |
| approved | BOOLEAN | nullable | 空表未决 |
| expires_at | TIMESTAMPTZ | NOT NULL | 超时自动过期 |
| decided_at | TIMESTAMPTZ | nullable | 决策时间 |
| dispatch_error_code | VARCHAR(64) | nullable | 下发失败码 |
| grant_consumed_at | TIMESTAMPTZ | nullable | grant 单次消费时间（`V7`） |
| arguments_hash | VARCHAR(96) | nullable | canonical arguments SHA-256（`V9`，PLAN-292 M1 grant 哈希匹配；存量行为 NULL 走 legacy 比对） |
| origin | VARCHAR(16) | nullable，`ck_approval_requests_origin`（`V25`） | 创建来源：`cp_gate`（CP 闸门判定后创建）/ `agent_relay`（Agent 中继的模型显式 `request_approval`）；NULL = 本列引入前的历史行。用于审计/统计区分两条创建路径（PLAN-0337） |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | — |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | — |

> 索引：
> - `idx_approval_requests_session_state (session_id, user_id, workspace_id, state, created_at)`
> - `idx_approval_requests_run_state (run_id, state)`

**session_follow_up_items**（`V49`，Entity `entity/SessionFollowUpItem.java`；PLAN-0442）：CP-owned per-Session durable Follow-up FIFO——admission 前入队 payload 的唯一事实源；child Run 创建后 item 只作队列投影，执行事实仍归 ChatRun。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK | — |
| session_id | UUID | NOT NULL FK `sessions(id)` `ON DELETE CASCADE` | 归属 Session；Session 删除零孤儿 |
| queue_sequence | BIGINT | NOT NULL，`ck_..._queue_sequence > 0`，`(session_id, queue_sequence)` 唯一 | Session 内 FIFO 序号 |
| idempotency_key | VARCHAR(128) | NOT NULL，`(session_id, idempotency_key)` 唯一 | 入队幂等键（Header `Idempotency-Key`；同键同 hash 幂等命中） |
| request_hash | VARCHAR(64) | NOT NULL | 规范化请求 hash，同键异 payload 冲突检测 |
| content | TEXT | nullable | 入队正文；admission 转交 child user Message 后清空 |
| attachment_refs | JSONB | NOT NULL DEFAULT `[]`，`ck_..._attachment_refs_array` | File UUID 数组；admission 重验所有权 |
| branch_id | UUID | NOT NULL | 入队时钉住的逻辑分支；admission 只重验存在性/可见性，不切换分支 |
| tool_mode | VARCHAR(20) | NOT NULL DEFAULT `none`，`ck_..._tool_mode` | `none` / `workspace` |
| tool_timeouts | JSONB | NOT NULL DEFAULT `{}`，`ck_..._tool_timeouts_object` | per-tool 覆盖超时 |
| provider / model | VARCHAR(50/100) | `ck_..._provider_model_pair` 成对 NULL | per-入队覆盖，成对出现 |
| status | VARCHAR(16) | NOT NULL DEFAULT `queued`，`ck_..._status` 五态 | `queued/paused/admitted/completed/withdrawn`；仅 `FollowUpQueueService` 写 |
| pause_reason | VARCHAR(64) | nullable | `parent_cancelled/child_cancelled/child_ambiguous/child_missing/attachment_unavailable/branch_unavailable/session_binding_stale/continued_after_terminal` 等 |
| anchor_run_id | UUID | FK `chat_runs(id)` `ON DELETE SET NULL` | 资格锚（terminal gate）；anchor 行删除置空 → admission 视为 stale 并暂停 |
| pause_run_id | UUID | FK `chat_runs(id)` `ON DELETE SET NULL` | 触发暂停的 Run |
| child_run_id | UUID | FK `chat_runs(id)` `ON DELETE SET NULL`，`uq_..._child_run_id` 部分唯一 | admission 后的 child Run（每 Session 至多一个 active child）；`SET NULL` 即 admitted-without-child 可达态，启动恢复暂停为 `child_missing` |
| child_message_id | UUID | FK `messages(id)` `ON DELETE SET NULL` | child user Message 回链 |
| created_at / updated_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | — |
| admitted_at / completed_at / withdrawn_at | TIMESTAMPTZ | nullable | 生命周期时间戳 |

> 索引：`uq_session_follow_up_items_child_run_id`（child 单飞，部分唯一）；`idx_session_follow_up_items_session_active_sequence (session_id, queue_sequence) WHERE status IN ('queued','paused','admitted')`（活跃队列扫描）。
>
> 语义注记：硬上限 5 统计全部未结束项（queued/paused/admitted），完成/撤回后释放；QueueItem 状态转换与 child ChatRun/Message 在同一事务原子写入，执行事实归 ChatRun；claim/withdraw 以 Session 行锁 + item 行锁串行（并发至多一方成功）。API 与状态机见 [`spec/session/chat-run-operation.md`](../../../spec/session/chat-run-operation.md) §Follow-up 队列 与 DEV-017 §1.3。

### 3.3 Workspace 执行（workspace_execution_specs）

**workspace_execution_specs**（`V1` 内建；旧链溯源：旧 V11 建 `workspace_assignments`、旧 V12 加唯一、旧 V13 重命名；Entity `entity/WorkspaceExecutionSpec.java`）：期望执行规格（非调度绑定，旧 V13 注释原名误导已纠正）。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK DEFAULT `gen_random_uuid()` | 内部分配键 |
| workspace_id | VARCHAR(36) | NOT NULL FK `workspaces(id) ON DELETE CASCADE` | 删 workspace 清规格 |
| generation | INT | NOT NULL | 单调递增，Runtime 按 `workspaceId` 懒加载对应用代 |
| sandbox_spec_hash | VARCHAR(64) | NOT NULL | 规格哈希，`workspaces` 镜像当前代 |
| sandbox_spec | JSONB | NOT NULL | 规格内容，`workspaces` 镜像当前代 |
| storage_backend | VARCHAR(32) | NOT NULL DEFAULT 'host_directory' | 与 `workspaces` 同义，历史行保留当时值 |
| storage_ref | VARCHAR(64) | NOT NULL | 与 `workspaces` 同义，历史行保留当时值 |
| actor | VARCHAR(255) | nullable | 谁创建此代 |
| reason | VARCHAR(512) | nullable | 因何创建此代 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | 代创建时间即版本序 |

> 索引：
> - `idx_workspace_execution_specs_workspace_generation (workspace_id, generation)`
> - 唯一约束 `uq_workspace_execution_specs_workspace_generation (workspace_id, generation)` — 同代唯一

### 3.4 MCP 与 Provider（mcp_remote_servers / mcp_stdio_servers / mcp_tool_aliases / oauth_credentials / provider_connections / provider_credential_leases / provider_connection_audit）

**mcp_remote_servers**（`V1` 以 `mcp_servers` 建表，`V12` 改名并同步约束/索引名；Entity `entity/McpServer.java` 类名保留，决策 #38②）：workspace 下 **remote** server 注册（HTTP + OAuth/no-auth）。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK | — |
| workspace_id | VARCHAR(36) | NOT NULL FK `workspaces(id)` | 归属 |
| name | VARCHAR(255) | NOT NULL | `serverId` 路由键见 DEV-030 附录 |
| endpoint | VARCHAR(512) | NOT NULL | 服务端点 |
| enabled | BOOLEAN | NOT NULL DEFAULT TRUE | 禁用即摘流 |
| auth_mode | VARCHAR(16) | NOT NULL DEFAULT 'oauth'（旧链 V15） | `oauth` / `no-auth`（公开免 broker） |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |

> 索引：`idx_mcp_remote_servers_workspace_id (workspace_id)`（V12 改名）

**mcp_stdio_servers**（`V12` 新建，Entity `entity/McpStdioServer.java`）：workspace 下 **stdio** server（Claude Desktop 形态配置），自 config 域 `mcp` 迁出（决策 #27）。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK DEFAULT `gen_random_uuid()` | — |
| workspace_id | UUID | NOT NULL FK `workspaces(id) ON DELETE CASCADE` | 归属 |
| name | VARCHAR(255) | NOT NULL，`uq_mcp_stdio_servers_workspace_name (workspace_id, name)` | 配置键/serverId |
| config | JSONB | NOT NULL，`ck_mcp_stdio_servers_config` 要求 object | 单 server 配置（command/args/env 等） |
| enabled | BOOLEAN | NOT NULL DEFAULT TRUE | 禁用即摘流 |
| created_at / updated_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | — |

> 索引：`idx_mcp_stdio_servers_workspace (workspace_id)`；Runtime 经 `GET /internal/v1/workspaces/{wsId}/stdio-servers` 每 30s diff 同步

**mcp_tool_aliases**（`V1`；旧链 V15 溯源，Entity `entity/McpToolAlias.java`）：sticky 工具别名，冲突仅新者加前缀、永不晋升。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| workspace_id | VARCHAR(36) | NOT NULL FK `workspaces(id)`，联合 PK | 归属 |
| issued_name | VARCHAR(255) | NOT NULL，联合 PK | 下发名 |
| server_id | VARCHAR(36) | NOT NULL | 真实后端 server |
| backend_name | VARCHAR(255) | NOT NULL | 真实后端工具名 |
| generation | BIGINT | NOT NULL DEFAULT 0 | 每次 `tools/list` 合并递增，审计回放用 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |

> 索引：`idx_mcp_tool_aliases_server (workspace_id, server_id)`

**oauth_credentials**（`V9`，Entity `entity/OAuthCredential.java`）：CP token broker 持久化的加密 refresh token。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK | — |
| user_id | VARCHAR(36) | NOT NULL FK `users(id)` | 归属 |
| workspace_id | VARCHAR(36) | NOT NULL FK `workspaces(id)` | 归属 |
| server_id | VARCHAR(36) | NOT NULL FK `mcp_servers(id)` | 归属 |
| client_id | VARCHAR(255) | NOT NULL | OAuth client |
| token_endpoint | VARCHAR(512) | NOT NULL | token 端点 |
| redirect_uri | VARCHAR(512) | NOT NULL | 回跳地址 |
| scope | VARCHAR(1024) | NOT NULL | 授权范围 |
| refresh_token_ciphertext | TEXT | NOT NULL | 信封加密密文 |
| encryption_key_version | VARCHAR(32) | NOT NULL | 密钥版本，用于轮转 |
| status | VARCHAR(32) | NOT NULL DEFAULT 'AUTHORIZED' | 授权态 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |

> 索引：
> - `idx_oauth_credentials_workspace (workspace_id)`
> - `idx_oauth_credentials_server (server_id)`
> - 唯一约束 `(user_id, workspace_id, server_id)` — 单用户单空间单服单凭证

**provider_connections**（`V18`，Entity `entity/ProviderConnection.java`）：LLM Provider 连接（PLAN-261）。归属现为**两级** `USER / WORKSPACE`；`SYSTEM` 归属已退役（PLAN-0364 M2：不再创建/可见/可选），但 **CHECK 保留 `SYSTEM` 值不收紧**——为将来 `AGENT` 等主体类型留扩展位（BL-18，DEV-032 §1.1；BL-18 已于 2026-09-23 G2 冻结入 PLAN-0407 承接，执行中）。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK | — |
| owner_type | VARCHAR(16) | NOT NULL CHECK `SYSTEM/WORKSPACE/USER`（现用 `USER/WORKSPACE`；CHECK 不收紧以保留扩展位） | 作用域 |
| owner_id | VARCHAR(64) | NOT NULL | 作用域 ID |
| provider_id | VARCHAR(128) | NOT NULL | 如 `openai/deepseek` |
| label | VARCHAR(128) | NOT NULL | 展示名 |
| base_url | VARCHAR(2048) | nullable | 自建网关覆盖 |
| credential_ciphertext | TEXT | nullable | 信封加密，独立 key |
| encryption_key_version | VARCHAR(32) | NOT NULL | 密钥版本 |
| enabled | BOOLEAN | NOT NULL DEFAULT TRUE | 启用开关 |
| status | VARCHAR(32) | NOT NULL DEFAULT 'UNVERIFIED' CHECK `UNVERIFIED/VERIFYING/READY/INVALID_CREDENTIALS/UNREACHABLE/DISABLED` | 可用态 |
| model_discovery | VARCHAR(32) | NOT NULL DEFAULT 'remote-models' CHECK `remote-models/litellm-catalog/curated/manual` | 模型来源 |
| manual_models | JSONB | nullable | 手工模型清单 |
| revision | BIGINT | NOT NULL DEFAULT 1 | 每次改连接 +1，`sessions/chat_runs` 存快照比对 |
| last_verified_at | TIMESTAMPTZ | nullable | 连通性验证时间 |
| last_error_code | VARCHAR(64) | nullable | 最近错误码 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |

> 索引：
> - `idx_provider_connections_owner (owner_type, owner_id, enabled)`
> - `idx_provider_connections_provider_status (provider_id, status, enabled)`
> - 唯一约束 `(owner_type, owner_id, provider_id)` — 同 scope 同 provider 一条

**provider_credential_leases**（`V18`，Entity `entity/ProviderCredentialLease.java`）：发给 Agent 的一次性短期凭证租约。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK | — |
| lease_hash | VARCHAR(128) | NOT NULL UNIQUE | Agent 兑换键 |
| provider_connection_id | VARCHAR(36) | NOT NULL FK `provider_connections(id) ON DELETE CASCADE` | 删连接清租约 |
| user_id | VARCHAR(36) | NOT NULL | 发放对象 |
| workspace_id | VARCHAR(36) | nullable | 绑定空间 |
| session_id | VARCHAR(36) | nullable | 绑定会话 |
| run_id | VARCHAR(36) | nullable | 绑定轮次 |
| provider_id | VARCHAR(128) | NOT NULL | 本次允许的 provider |
| model | VARCHAR(255) | NOT NULL | 本次允许的模型 |
| expires_at | TIMESTAMPTZ | NOT NULL | 过期时间 |
| redeemed_at | TIMESTAMPTZ | nullable | 兑换时间 |
| revoked_at | TIMESTAMPTZ | nullable | 吊销时间 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |

> 索引：
> - `idx_provider_credential_leases_expiry (expires_at)` — 过期扫描
> - `idx_provider_credential_leases_binding (provider_connection_id, user_id, run_id)` — 绑定查询

**provider_connection_audit**（`V20`，Entity `entity/ProviderConnectionAudit.java`）：只追加审计，`provider_connection_id` 可空（删连接后仍留痕）。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK | — |
| provider_connection_id | VARCHAR(36) | nullable，无 FK | 故意不级联 |
| owner_type | VARCHAR(16) | NOT NULL | 冗余当时归属 |
| owner_id | VARCHAR(64) | NOT NULL | 冗余当时归属 |
| provider_id | VARCHAR(128) | NOT NULL | 冗余当时归属 |
| action | VARCHAR(32) | NOT NULL | 动作 |
| changed_by | VARCHAR(64) | NOT NULL | 操作人 |
| from_status | VARCHAR(32) | nullable | 状态变迁 |
| to_status | VARCHAR(32) | nullable | 状态变迁 |
| credential_present | BOOLEAN | NOT NULL DEFAULT FALSE | 是否含凭证 |
| credential_last4 | VARCHAR(4) | nullable | 只存后四位，禁存明文 |
| connection_revision | BIGINT | NOT NULL | 当时 revision |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | 时间序 |

> 索引：
> - `idx_provider_connection_audit_connection (provider_connection_id, created_at)`
> - `idx_provider_connection_audit_owner (owner_type, owner_id, created_at)`

### 3.5 配置与 RAG（config / config_audit / document_chunks / context_events / context_projections / context_source_hashes）

**config**（`V1` 建表，`V12` 三层化 + 删列，`V13` 旧键清理；Entity `entity/ConfigEntity.java`）：三层配置 canonical 存储（`instance / workspace / user`，解析链 `workspace > user > instance > 代码默认`），语义与域集见 [DEV-003](DEV-003-config-management.md) §1。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | BIGSERIAL | PK | 自增主键 |
| layer | VARCHAR(16) | NOT NULL，`ck_config_layer` | `instance` / `workspace` / `user`（V12 前为 SYSTEM/ADMIN/USER，`admin` 已规范化为 `instance`） |
| user_id | UUID | nullable FK `users(id) ON DELETE CASCADE`，`ck_config_scope_binding` | `layer=user` 必填（V12 加） |
| workspace_id | UUID | nullable FK `workspaces(id) ON DELETE CASCADE`，`ck_config_scope_binding` | `layer=workspace` 必填（V12 加） |
| domain | VARCHAR(32) | NOT NULL | 九域：`llm-provider`/`context-policy`/`embedding`/`rag`/`agent-runtime`/`agent-profile`/`user-preference`/`logging`/`approval-policy`（后者 V24 起，仅 workspace 层，PLAN-0337） |
| config_key | VARCHAR(64) | NOT NULL | 配置键 |
| config_value | TEXT | nullable | 值（结构化值为 JSON 文本）；**一切凭证键禁写**——`rejectProviderSecrets` 对 `*ApiKey`/secret/password/token 返回 403，凭证只归 `provider_connections`/env 兜底（决策 #21/#37） |
| updated_by | VARCHAR(64) | nullable | 修改人 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW()（V8 补齐） | — |
| updated_at | TIMESTAMPTZ | DEFAULT NOW() | 修改时间 |

> 已删列（V12）：`environment`（层内去环境维）、`mcp_config`（迁 `mcp_stdio_servers`）、`is_set`；`idx_config_lookup` 已由 V8 删除。
>
> 索引与约束：
> - `uq_config_instance_scope (domain, config_key) WHERE layer = 'instance'` — 部分唯一
> - `uq_config_workspace_scope (workspace_id, domain, config_key) WHERE layer = 'workspace'` — 部分唯一
> - `uq_config_user_scope (user_id, domain, config_key) WHERE layer = 'user'` — 部分唯一
> - `ck_config_scope_binding`：instance 无标识列 / user 仅 user_id / workspace 仅 workspace_id
>
> V13 清理：非八域行（`infrastructure`/`workspace-config`/`mcp` 等）、各域已迁移/废弃键（全部 `*ApiKey`、`contextPolicy`、`user-preference.{defaultModel,maxTokens,temperature}`、logging 非五级键）直接删除，不做搬移（决策 #39）。

**config_audit**（`V1` 建表；密钥脱敏为旧链 V17 溯源；Entity `entity/ConfigAuditEntity.java`）：配置变更审计。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | BIGSERIAL | PK | — |
| config_id | BIGINT | nullable FK `config(id) ON DELETE SET NULL`（V12 起，审计不随配置删除丢失，决策 #30） | 关联配置行 |
| environment | VARCHAR(32) | nullable | 历史快照列（V12 后不再写入） |
| layer | VARCHAR(16) | nullable | 当时值 |
| domain | VARCHAR(32) | nullable | 当时值 |
| config_key | VARCHAR(64) | nullable | 当时值 |
| old_value | TEXT | nullable | 旧链 V17 起 `llm-provider` 域含 `apikey/secret/password/token` 的历史值改写为 `missing` 或 `present:legacy:<md5>` |
| new_value | TEXT | nullable | 同上，禁明文留痕 |
| changed_by | VARCHAR(64) | nullable | 修改人 |
| changed_at | TIMESTAMPTZ | DEFAULT NOW() | 修改时间 |

> 索引：`idx_config_audit_config_id (config_id)`

**document_chunks**（`V3`）：RAG 向量表，无 FK，独立生命周期。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK | chunk 键 |
| page_content | TEXT | NOT NULL | 切片正文 |
| embedding | vector(1536) | NOT NULL | `text-embedding-3-small` 维度 |
| cmetadata | JSONB | nullable | 来源元数据 |
| document_id | VARCHAR(36) | nullable | 来源文档 |
| chunk_index | INT | nullable | 切片序号 |
| created_at | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP | — |

> 索引：
> - `idx_chunks_embedding` — `ivfflat (embedding vector_cosine_ops) WITH (lists=100)`，余弦检索
> - `idx_chunks_document_id (document_id)`

**context_events**（`V7` + `V14` 级联，Entity `context/entity/ContextEvent.java`）：Agent Event Sourcing 事件表，只追加；见 [DEV-013](DEV-013-agent-architecture.md) 与 [DEV-017](DEV-017-session-architecture.md)。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK DEFAULT `gen_random_uuid()` | — |
| session_id | VARCHAR(36) | NOT NULL FK `sessions(id) ON DELETE CASCADE` | 归属会话 |
| workspace_id | VARCHAR(36) | NOT NULL | 冗余归属 |
| user_id | VARCHAR(36) | NOT NULL | 冗余归属 |
| event_type | VARCHAR(50) | NOT NULL | 事件类型 |
| sequence | BIGINT | NOT NULL | 单会话单调序号 |
| payload | JSONB | NOT NULL DEFAULT '{}' | 事件内容 |
| correlation_id | VARCHAR(36) | nullable | 关联链 |
| causation_id | VARCHAR(36) | nullable | 因果链 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |

> 索引：
> - `idx_context_events_session_id (session_id)`
> - `idx_context_events_session_sequence (session_id, sequence)`
> - `idx_context_events_workspace_id (workspace_id)`
> - `idx_context_events_event_type (event_type)`
> - 唯一约束 `(session_id, sequence)` — 单会话内序号唯一

**context_projections**（`V7` + `V14` 级联，Entity `context/entity/ContextProjection.java`）：事件物化视图，重放 `context_events` 可重建。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK DEFAULT `gen_random_uuid()` | — |
| session_id | VARCHAR(36) | NOT NULL UNIQUE FK `sessions(id) ON DELETE CASCADE` | 单会话单读模型 |
| workspace_id | VARCHAR(36) | NOT NULL | 冗余归属 |
| user_id | VARCHAR(36) | NOT NULL | 冗余归属 |
| projection_type | VARCHAR(50) | NOT NULL DEFAULT 'agent_context' | 读模型类型（列名保留） |
| latest_sequence | BIGINT | NOT NULL DEFAULT 0 | 已物化到的事件序号 |
| payload | JSONB | NOT NULL DEFAULT '{}' | 读模型内容 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |

> 索引：
> - `idx_context_projections_session_id (session_id)`
> - `idx_context_projections_workspace_id (workspace_id)`

**context_source_hashes**（`V8`，Entity `context/entity/ContextSourceHash.java`）：增量源哈希去重。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK DEFAULT `gen_random_uuid()` | — |
| workspace_id | VARCHAR(36) | NOT NULL | 归属 |
| source_key | VARCHAR(255) | NOT NULL | 源标识 |
| hash | VARCHAR(64) | NOT NULL | 内容哈希 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |

> 索引：
> - `idx_context_source_hashes_workspace_id (workspace_id)`
> - `idx_context_source_hashes_source_key (source_key)`
> - 唯一约束 `(workspace_id, source_key)` — 同源一行

### 3.6 文件审计（files / audit_logs）

**files**（`V1` + `V6`，Entity `entity/File.java`）：附件 canonical，物理路径 `{attachments-base-path}/{sessionId}/{fileId}`，见 [DEV-014 §5](DEV-014-control-plane-architecture.md)。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK | `fileId` 即文件名键 |
| user_id | VARCHAR(36) | NOT NULL FK `users(id)` | 上传者 |
| workspace_id | VARCHAR(36) | nullable FK `workspaces(id)` | 空 = 会话级附件 |
| filename | VARCHAR(255) | NOT NULL | 原始文件名 |
| mime_type | VARCHAR(127) | nullable | MIME 类型 |
| size_bytes | BIGINT | NOT NULL DEFAULT 0 | 白名单校验 + 500MB 上限在 Controller 层 |
| storage_path | VARCHAR(512) | NOT NULL | 物理路径 |
| session_id | VARCHAR(36) | nullable FK `sessions(id) ON DELETE CASCADE`（`V6`） | 删会话清附件 |
| message_id | VARCHAR(36) | nullable FK `messages(id) ON DELETE SET NULL`（`V6`） | 删消息保留文件行 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | orphan 清理 24h 窗口基准 |

> 索引：
> - `idx_files_user_id (user_id)`
> - `idx_files_workspace_id (workspace_id)`
> - `idx_files_session_id (session_id)`（`V6`）
> - `idx_files_message_id (message_id)`（`V6`）

**audit_logs**（`V1`）：业务审计（MCP 工具调用另写 `audit.log` 文件，见 DEV-014 §5，两者互补）。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK | — |
| user_id | VARCHAR(36) | nullable FK `users(id)` | 系统动作可空 |
| workspace_id | VARCHAR(36) | nullable FK `workspaces(id)` | 系统动作可空 |
| action | VARCHAR(100) | NOT NULL | 动作 |
| resource_type | VARCHAR(50) | nullable | 资源类型 |
| resource_id | VARCHAR(36) | nullable | 资源 ID |
| details | TEXT | nullable | 脱敏后 JSON |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT CURRENT_TIMESTAMP | — |

> 索引：
> - `idx_audit_logs_user_id (user_id)`
> - `idx_audit_logs_workspace_id (workspace_id)`
> - `idx_audit_logs_action (action)`

### 3.7 操作账本（历史 schema，V56 已退役）

> **状态（PLAN-0467）**：以下六表字段/关系仅为 V1–V55 的升级历史，不是当前 schema。V56 已删除 `ledger_operations`、`operation_items`、`operation_attempts`、`operation_events`、`operation_extensions` 与 `diagnostic_artifacts`；Flyway 历史迁移仍保留以支持既有库升级。不可按本节重建或新增运行时引用。
>
> 切换点的完整 V55 快照及恢复演练见 workspace 根 `plans/PLAN-0467-xh-ledger-retirement/evidence/snapshot-restore.md`；V56 升级演练与 Workspace Job 行保留证据见 `evidence/migration-rehearsal.md`。

| 旧表（V56 已删除） | 现行事实源 / 处置 |
|---|---|
| `ledger_operations` | 不再设跨域根行；ChatRun 由 `chat_runs`/`chat_run_history` 持有，工具调用由 `mcp_invocations` 持有，Workspace Job 由 `workspace_jobs` 持有。无历史回填。 |
| `operation_items` | 依事实归属到 ChatRun、MCP invocation、Workspace Job 或 `run_checkpoints`；V56 同批删除其 `workspace_jobs.operation_item_id` transition anchor。 |
| `operation_attempts` / `operation_events` | MCP 调用阶段与执行事实归 `mcp_attempts` / `mcp_dispatch_history`；审批归 `approval_requests` / `approval_history`；Job 状态变化归 `workspace_job_history`。 |
| `operation_extensions` / `diagnostic_artifacts` | 不做跨域回填；按 owner 生命周期随对应 Session/Workspace 事实处理。受保护工件仍由其 domain-owned storage reference 管理。 |

当前 schema 以本文件 §3.2–§3.6、§3.8–§3.9、`docs/api/openapi.yaml`、`docs/api/inventory.md` 与 V56 migration 为准。
### 3.8 任务连续性（task_plans / task_items）

**task_plans**（`V6`，Entity `entity/TaskPlan.java`）：一次 run 的目标导向计划（PLAN-276 M1）。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK DEFAULT `gen_random_uuid()` | — |
| run_id | UUID | NOT NULL FK `chat_runs(id) ON DELETE CASCADE` | 归属轮次 |
| session_id | UUID | NOT NULL，无 FK | 归属会话（逻辑关联） |
| workspace_id | UUID | NOT NULL FK `workspaces(id) ON DELETE CASCADE` | 归属 |
| goal | TEXT | nullable | 目标描述 |
| current_item_id | UUID | nullable，无 FK | 当前项指针 |
| state | VARCHAR(32) | NOT NULL DEFAULT 'active'，`ck_task_plans_state` | `active/completed/cancelled` |
| created_at / updated_at | TIMESTAMPTZ | NOT NULL DEFAULT `now()` | — |

> 索引：`idx_task_plans_run (run_id)`；`idx_task_plans_session (session_id)`

**task_items**（`V6`，Entity `entity/TaskItem.java`）：计划内步骤。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK DEFAULT `gen_random_uuid()` | — |
| task_plan_id | UUID | NOT NULL FK `task_plans(id) ON DELETE CASCADE` | 归属计划 |
| title | TEXT | NOT NULL | 步骤标题 |
| status | VARCHAR(32) | NOT NULL DEFAULT 'pending'，`ck_task_items_status` | `pending/in_progress/completed/blocked/cancelled` |
| depends_on | UUID | nullable，无 FK | 依赖步骤（逻辑关联） |
| evidence | TEXT | nullable | 完成证据 |
| position | INTEGER | NOT NULL DEFAULT 0 | 排序 |
| created_at / updated_at | TIMESTAMPTZ | NOT NULL DEFAULT `now()` | — |

> 索引：`idx_task_items_plan (task_plan_id)`；`idx_task_items_status (status)`

### 3.9 Workspace Job（workspace_jobs / workspace_job_history）

**workspace_jobs**（`V53`，Entity `entity/WorkspaceJob.java`）：Workspace Job 领域表（PLAN-0465 T1.1，PLAN-0462 decision #5/#7）。`id` 即 domain `jobId`（wire 唯一身份）；`state` JSONB 保存 Job state，`status`/`scope` 为同步查询列。V56 已移除只供迁移期双写的 `operation_item_id` anchor；不回填 Ledger 历史（decision #9）。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK | domain `jobId` |
| workspace_id | UUID | NOT NULL FK `workspaces(id) ON DELETE CASCADE` | 归属 |
| user_id | UUID | NOT NULL FK `users(id)` | 启动者（幂等键成员） |
| session_id | UUID | nullable FK `sessions(id) ON DELETE CASCADE` | session-less Job 为 NULL |
| run_id | UUID | nullable FK `chat_runs(id) ON DELETE SET NULL` | run-scope 归属/收口键 |
| tool_call_id | UUID | nullable | MCP 工具调用关联（decision #5 provenance） |
| source | VARCHAR(32) | NOT NULL，`ui/agent/runtime/system/mcp` | — |
| scope | VARCHAR(16) | NOT NULL，`ck_workspace_jobs_scope` | `run/session/workspace`（存活边界） |
| idempotency_key | VARCHAR(128) | nullable | V36 语义迁入 |
| input_hash | VARCHAR(64) | nullable | 同 key 异 hash → 409 |
| status | VARCHAR(24) | NOT NULL，`ck_workspace_jobs_status` | `pending/running/succeeded/cancelled/timeout/orphaned/interrupted` |
| state | JSONB | NOT NULL | Job state payload；其中历史键 `jobId` 表示 Runtime backend handle，不是 `workspace_jobs.id` |
| cancel_reason / error_code | VARCHAR(64) | nullable | 冻结词汇见 DEV-014 §9 |
| runtime_job_id | VARCHAR(128) | nullable | Runtime backend handle（`state->>'jobId'` 的索引列镜像，output/status/cancel 目标） |
| started_at / ended_at | TIMESTAMPTZ | nullable | `state` 时间列镜像 |
| created_at / updated_at | TIMESTAMPTZ | NOT NULL DEFAULT `now()` | 时间索引面 |

> 索引/唯一：`uq_workspace_jobs_session_idempotency (user_id, session_id, idempotency_key) WHERE session_id IS NOT NULL AND idempotency_key IS NOT NULL`；`uq_workspace_jobs_workspace_idempotency (user_id, workspace_id, idempotency_key) WHERE session_id IS NULL AND idempotency_key IS NOT NULL`（V36 语义）；`idx_workspace_jobs_workspace_created_at (workspace_id, created_at DESC)`（list + 0466 审计 VIEW 分页）；`idx_workspace_jobs_created_at (created_at)`（对账 sweep）；`idx_workspace_jobs_run_id` / `idx_workspace_jobs_session_id`（scope 收口等值探针）。

**workspace_job_history**（`V54`，Entity `entity/WorkspaceJobHistory.java`）：单 Job append-only transition history（PLAN-0465 T1.3，PLAN-0462 decision #8）。只插入不更新；`sequence` 在 `workspace_jobs` 行锁内 max+1 分配；`job_id` FK `ON DELETE CASCADE`。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|---|
| id | UUID | PK | — |
| job_id | UUID | NOT NULL FK `workspace_jobs(id) ON DELETE CASCADE` | 归属 Job |
| sequence | BIGINT | NOT NULL，`UNIQUE (job_id, sequence)` | per-job 单调序号 |
| event_type | VARCHAR(24) | NOT NULL，`ck_workspace_job_history_event` | `start/running/settle/cancel/orphaned/interrupted` |
| from_status / to_status | VARCHAR(24) | from nullable、to NOT NULL | 状态迁移两端 |
| cancel_reason / error_code | VARCHAR(64) | nullable | 与行镜像 |
| payload | TEXT | nullable | 安全字段（ids/flags），不落命令/env/secret |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT `now()` | — |

> 索引：`uq_workspace_job_history_job_sequence (job_id, sequence)`；`idx_workspace_job_history_job_created (job_id, created_at)`。

## 4. 迁移对照（当前 active 升级链 V1~V56）

> PLAN-280 destructive rebaseline 取代了当时的历史链（旧 V2~V22/U6 移出 active classpath，仅 Git 历史可追溯）；V15 起的 V15~V41 均为当前 active 链的 post-rebaseline migrations。本节保留历史编号解释，不把两套编号混用；表内 V2/V3/V4/V30 的旧名属于历史迁移文件名与原表名（V33 改名后保留）。

| 版本 | 文件 | 变更 | 影响表 |
|------|------|------|--------|
| V1 | `V1__init_schema.sql` | 全量基线：21 表（原生 UUID 主键、`TIMESTAMPTZ`、显式命名 FK/CHECK/UNIQUE/索引与 `ON DELETE`） | 全部表（含 `approval_requests/chat_runs/sessions/messages/files/mcp_servers/audit_logs` 等） |
| V2 | `V2__session_operation_ledger.sql` | Session Operation Ledger 6 表（审计根表名历史为 `session_operations`，V33 改名） | `ledger_operations/operation_items/operation_attempts/operation_events/operation_extensions/diagnostic_artifacts` |
| V3 | `V3__runtime_jobs.sql` | Runtime 后台任务 durable registry（**V14 退役删除**） | `runtime_jobs` |
| V4 | `V4__workspace_snapshots.sql` | Workspace snapshot 双表（**V28 退役删除**） | `workspace_snapshots/workspace_snapshot_files` |
| V5 | `V5__approval_snapshot_policy.sql` | 审批绑定 snapshot/policyClass（**V28 退役删除**） | `approval_requests.snapshot_id/policy_class` |
| V6 | `V6__task_continuity.sql` | 任务连续性 | `task_plans/task_items` |
| V7 | `V7__approval_grant_consumption.sql` | grant 单次消费 | `approval_requests.grant_consumed_at` |
| V8 | `V8__schema_gate_fixes.sql` | schema 门禁修正（FK `ON DELETE NO ACTION` 显式化、去冗余索引、`config.created_at`） | 多表 |
| V9 | `V9__approval_arguments_hash.sql` | grant 哈希匹配列（PLAN-292 M1） | `approval_requests.arguments_hash` |
| V10 | `V10__llm_usage_item_kind.sql` | LLM usage item kind | `operation_items.kind`/相关约束 |
| V11 | `V11__mcp_server_tool_timeout.sql` | remote MCP 工具超时列 | `mcp_servers.tool_timeout_seconds` |
| V12 | `V12__config_tiers_and_mcp_split.sql` | config 三层化（instance/workspace/user + scope 约束/部分唯一索引、删 `environment`/`mcp_config`/`is_set`）+ MCP 分载体（新建 `mcp_stdio_servers`、`mcp_servers` → `mcp_remote_servers`）+ `config_audit.config_id` SET NULL（PLAN-0307 决策 #27/#30/#37） | `config/config_audit/mcp_stdio_servers/mcp_remote_servers` |
| V13 | `V13__config_legacy_key_cleanup.sql` | 旧域键清理：裁撤域整体删除 + 各域废弃键删除（不搬移，决策 #39） | `config` |
| V14 | `V14__ledger_channel_identity.sql` | 通道事实行身份（唯一键含 `source`）+ drop 悬空 `runtime_jobs`（PLAN-0326 决策 #4/#9） | `operation_items`/`runtime_jobs` |
| V15 | `V15__policy_rules_and_tool_faces.sql` | 建立持久化策略规则与工具面分类表及约束 | `policy_rules/tool_faces` |
| V16 | `V16__approval_decision_kind_and_pending_index.sql` | 审批决定类型与 pending 查询索引 | `approval_requests` |
| V17 | `V17__approval_policy_snapshot.sql` | 审批策略快照字段 | `approval_requests` |
| V18 | `V18__approval_mode_at_grant.sql` | grant 决策时的 mode 快照 | `approval_requests` |
| V19 | `V19__operation_policy_summary.sql` | 操作账本安全策略摘要 | `operation_items` |
| V20 | `V20__approval_grant_reuse.sql` | grant reuse 绑定、范围与消费约束 | `approval_requests` |
| V21 | `V21__policy_revision_counter.sql` | 持久化单调策略 revision counter | `policy_revision` |
| V22 | `V22__run_checkpoints.sql` | Run checkpoint CP 切片记录、状态与账本 kind 约束扩展 | `run_checkpoints/operation_items` |
| V23 | `V23__run_checkpoint_revert.sql` | checkpoint revert 状态、引用、摘要与尝试计数 | `run_checkpoints` |
| V24 | `V24__session_approval_mode.sql` | 会话审批模式落库（`manual`/`auto`；NULL = 继承 workspace；PLAN-0337） | `sessions.approval_mode` |
| V25 | `V25__approval_request_origin.sql` | 审批 durable 来源标识（`cp_gate`/`agent_relay`；NULL = 历史行；PLAN-0337） | `approval_requests.origin` |
| V26 | `V26__run_checkpoint_slice_state_vocabulary.sql` | checkpoint 切片状态词表（`captured`/`abnormal-captured`）；切片表重建归 PLAN-0339 | `run_checkpoints` |
| V27 | `V27__run_checkpoints_workspace_slices.sql` | 物理清空旧记录行并重建 workspace slice rows、来源/前驱/嵌套仓库与 revert bookkeeping | `run_checkpoints` |
| V28 | `V28__legacy_snapshot_retirement.sql` | Legacy snapshot 退役：删 `idx_approval_requests_snapshot`、`approval_requests.snapshot_id/policy_class`、`workspace_snapshot_files`、`workspace_snapshots`（PLAN-0357；实测空表，纯清理，不触碰切片表/shadow Git） | `approval_requests/workspace_snapshots/workspace_snapshot_files` |
| V29 | `V29__clear_context_source_hashes.sql` | 清空遗留单键源哈希（L1 状态改走事件读模型；仅数据清空，无 schema 变更；PLAN-0340 决策 #10） | `context_source_hashes` |
| V30 | `V30__session_operation_chat_session_check.sql` | 直接 ADD CHECK（免存量）：`kind='chat' ⇒ session_id IS NOT NULL`（PLAN-0351 DDL-3；表名后随 V33 改名） | `ledger_operations`（`ck_ledger_operations_chat_session`） |
| V31 | `V31__ledger_fk_child_indexes.sql` | 补 FK 子列索引：`chat_runs.workspace_id`、`operation_events.item_id/attempt_id`（PLAN-0351 DDL-5） | `chat_runs/operation_events` |
| V32 | `V32__drop_dead_json_columns.sql` | 删死列：`workspaces.settings/storage_path`、`users.settings`、`messages.metadata`、`mcp_remote_servers.auth_config`（PLAN-0351 DDL-9/10；JSON 新列一律 JSONB） | `workspaces/users/messages/mcp_remote_servers` |
| V33 | `V33__rename_session_operations_to_ledger_operations.sql` | `session_operations` RENAME `ledger_operations` + 14 项跟随改名（PK ×1、FK ×4、CHECK ×5、唯一索引 ×2、普通索引 ×2；PLAN-0351 DDL-12） | `ledger_operations` 及其约束/索引 |
| V34 | `V34__operation_extensions_cascade.sql` | `operation_extensions` 两目标 FK `SET NULL` → `CASCADE`（CHECK 保留；PLAN-0367 DDL-13） | `operation_extensions` |
| V35 | `V35__workspace_imports.sql` | Workspace 导入 durable 记录表（状态 `queued/running/completed/cancelled/failed`、`(owner_id, idempotency_key)` 唯一、workspace+created 索引与 active 部分索引；PLAN-0376） | `workspace_imports` |
| V36 | `V36__workspace_job_idempotency.sql` | 历史 Ledger 上为 session-less Job root 增部分唯一索引；V53 将幂等约束迁至 `workspace_jobs`，V56 随 Ledger 表退役 | historical `ledger_operations` |
| V37 | `V37__session_provenance.sql` | `sessions` 增 nullable `spawned_from_session_id/spawned_from_run_id/spawned_at` 与两条非空部分查找索引（PLAN-0407 T1.1） | `sessions` |
| V38 | `V38__authorization_grants.sql` | 新增 grants 主体权限表、source/read_state CHECK、subject 查找索引与每主体一份 default grant 部分唯一索引（PLAN-0407 T1.2） | `grants` |
| V39 | `V39__chat_run_origin.sql` | `chat_runs.origin` 回填旧行为 `user_submission`，约束 `user_submission/spawn`；新增 spawn-only `(user_id,idempotency_key)` 部分唯一索引，保证父 durable event 全局幂等（PLAN-0407 T1.4） | `chat_runs` |
| V40 | `V40__session_derivation_kind.sql` | `sessions.kind` 区分 `spawn/fork`；root provenance 全 NULL、派生四元组全 NOT NULL 的 CHECK；既有 V37 provenance 行在无 fork creator 的前置阶段回填为 spawn（PLAN-0407 T2.2） | `sessions` |
| V41 | `V41__default_grant_bootstrap.sql` | 对既有 users 与 root Agent Sessions 补 source=default grant（USER/ADMIN 矩阵），自动默认 read_state=read，并为回填 grant 写 audit row（PLAN-0407 T2.4） | `grants` |
| V48 | `V48__context_template_session_binding.sql` | **纯 schema（不含数据清理）**：`sessions` 增 `context_template_layer/id/version` 三列（NOT NULL DEFAULT 钉内置模板）与 CHECK（PLAN-0414 T1.1/T1.3），`chat_runs` 增 `context_template_snapshot` JSONB 对象 DEFAULT（T1.4 admission 原子快照）；存量清库是迁移前置运维动作 `dev:reset`（用户 2026-10-03 裁定「先清库，迁移里不该清」，V14 dev-state 可弃先例），迁移不携带 DELETE/拦截 | `sessions/chat_runs` |
| V49 | `V49__session_follow_up_items.sql` | 新增 per-Session durable Follow-up FIFO 表：五态/工具模式/JSON 形态 CHECK、`(session_id, queue_sequence)` 与 `(session_id, idempotency_key)` 双唯一、`child_run_id` 部分唯一（active child 单飞）、四条 FK（session CASCADE；anchor/pause/child_run/child_message SET NULL）与活跃队列部分索引；无历史回填，既有 Session 起始空队列（PLAN-0442 T1.1） | `session_follow_up_items` |
| V50 | `V50__mcp_execution_domain.sql` | MCP invocation、attempt 与 dispatch history 的执行域事实表（PLAN-0463）；`approval_request_id` 为 nullable FK，`ON DELETE SET NULL` | `mcp_invocations/mcp_attempts/mcp_dispatch_history` |
| V51 | `V51__approval_history.sql` | Approval 决策 append-only history；保留与 MCP invocation 的 nullable `ON DELETE SET NULL` 关联 | `approval_history` |
| V52 | `V52__chat_run_history_and_waiting_link.sql` | ChatRun 状态流转 history 与 child-run waiting link（PLAN-0464）；旧 Run 不回填 waiting link | `chat_run_history/chat_runs` |
| V53 | `V53__workspace_jobs.sql` | Workspace Job 领域表（PLAN-0465 T1.1 / PLAN-0462 decision #5/#7）：domain `jobId` PK、V36 幂等唯一索引迁入、暂存的 `operation_item_id` dual-write anchor（由 V56 删除）、`status/scope` 查询列与时间索引；不回填旧行（decision #9） | `workspace_jobs` |
| V54 | `V54__workspace_job_history.sql` | 单 Job append-only transition history（PLAN-0465 T1.3 / decision #8）：六事件 `start/running/settle/cancel/orphaned/interrupted`，per-job `sequence` 唯一，FK 级联 | `workspace_job_history` |
| V55 | `V55__audit_entries_view.sql` | 四域 Audit read-only view，不回填或改写 owner tables | `v_audit_entries` |
| V56 | `V56__retire_operation_ledger.sql` | 先从 `workspace_jobs` 删除 `operation_item_id` FK/index/column，再按 FK 依赖次序删除六张 Ledger 历史表；V55 pre-DROP snapshot hash 与恢复演练见 `plans/PLAN-0467-xh-ledger-retirement/evidence/` | `workspace_jobs` / retired Ledger tables |

## 5. 本地查看与运维

| 场景 | 命令 / 位置 |
|------|-------------|
| 起 PG | `mise run dev:host`（先等 `pg_isready -U xihe -d xihe` healthy 再起 CP，见 `docker-compose.yml`） |
| 直连 | `psql postgresql://xihe@localhost:12634/xihe`（密码走 `.env.dev`，默认 trust） |
| 看迁移水位 | `SELECT version, script, success FROM flyway_schema_history ORDER BY installed_rank;` |
| 看向量扩展 | `SELECT * FROM pg_extension WHERE extname='vector';` |
| 看 RAG 维度 | `SELECT atttypmod FROM pg_attribute WHERE attrelid='document_chunks'::regclass AND attname='embedding';`（预期 1536） |
| 看当前代 | `SELECT id, generation, storage_ref, sandbox_spec_hash FROM workspaces;` + `SELECT workspace_id, generation, actor, reason FROM workspace_execution_specs ORDER BY generation DESC LIMIT 20;` |
| 看轮次 | `SELECT id, session_id, status, terminal_outcome, error_code FROM chat_runs ORDER BY created_at DESC LIMIT 20;` |
| 重置 admin | `mise run reset-admin`（`scripts/reset-admin.ps1 -Password <pw>`，免重启，不删数据） |
| 重建 dev 库 | `mise run dev:reset`（默认 dry-run，显式 `-Reset` 才执行，先备份） |

> **当前链备注**：V21 的 `policy_revision` 是审批 grant 失效判断的 durable counter；V22/V23/V26 是 checkpoint 切片语义落地前的历史增量；V27 按 PLAN-0339 物理清空旧 `run_checkpoints` 行并重建 workspace slices；V28 按 PLAN-0357 删除 V4/V5 legacy snapshot 对象；V29 清空遗留单键源哈希；V30–V34 是 Ledger schema 历史增量，相关表于 V56 退役；V35–V41 落地 Workspace import、Session provenance/kind、authorization grants、ChatRun origin/幂等约束与 default grant backfill；V48 落地 Context Template binding；V49–V56 依次落地 Follow-up Queue、MCP invocation、Approval history、ChatRun history/waiting link、Workspace Job/history、Audit view 与 Ledger retirement。具体历史变化以迁移 SQL 和 plan evidence 为准，禁止手工 DROP/回滚 active 链。

## 附录 A：表—Entity—迁移三向对照

> 「active 首次迁移」指当前 V1~V56 链中的出处；rebaseline 前的旧链编号仅作溯源备注，编号与 active 链不通用（见 §1 版本标注约定）。

| 表 | Entity | active 首次迁移 |
|----|--------|-----------------|
| users | `entity/User.java` + `UserRole.java` | V1 |
| workspaces | `entity/Workspace.java` | V1 |
| workspace_users | `entity/WorkspaceUser.java` + `WorkspaceUserId.java` | V1 |
| sessions | `entity/Session.java` | V1 |
| messages | `entity/Message.java` + `MessageRole.java` | V1 |
| files | `entity/File.java` | V1 |
| chat_runs | `entity/ChatRun.java` | V1 |
| session_follow_up_items | `entity/SessionFollowUpItem.java` | V49 |
| grants | `entity/AuthorizationGrant.java` | V38 |
| run_checkpoints | `entity/RunCheckpoint.java` | V27（V22/V23/V26 仅为历史增量） |
| approval_requests | `entity/ChatApproval.java` | V1 |
| provider_connections | `entity/ProviderConnection.java` | V1 |
| provider_credential_leases | `entity/ProviderCredentialLease.java` | V1 |
| provider_connection_audit | `entity/ProviderConnectionAudit.java` | V1 |
| mcp_remote_servers | `entity/McpServer.java`（类名保留，决策 #38②） | V1（V12 由 `mcp_servers` 改名） |
| mcp_tool_aliases | `entity/McpToolAlias.java` | V1 |
| oauth_credentials | `entity/OAuthCredential.java` | V1 |
| workspace_execution_specs | `entity/WorkspaceExecutionSpec.java` | V1（旧链 V11 建 / 旧 V13 更名） |
| context_events | `context/entity/ContextEvent.java` | V1 |
| context_projections | `context/entity/ContextProjection.java` | V1 |
| context_source_hashes | `context/entity/ContextSourceHash.java` | V1 |
| config | `entity/ConfigEntity.java` | V1（V12 三层化 / V13 键清理） |
| config_audit | `entity/ConfigAuditEntity.java` | V1（V12 审计解耦） |
| audit_logs | `entity/AuditLog.java` | V1 |
| policy_rules | `entity/PolicyRuleEntity.java` | V15 |
| tool_faces | `entity/ToolFaceEntity.java` | V15 |
| policy_revision | `entity/PolicyRevisionEntity.java` | V21 |
| ledger_operations | 无当前 Entity（V56 删除） | V2/V33 历史，V56 DROP |
| operation_items | 无当前 Entity（V56 删除） | V2 历史，V56 DROP |
| operation_attempts | 无当前 Entity（V56 删除） | V2 历史，V56 DROP |
| operation_events | 无当前 Entity（V56 删除） | V2 历史，V56 DROP |
| operation_extensions | 无当前 Entity（V56 删除） | V2/V34 历史，V56 DROP |
| diagnostic_artifacts | 无当前 Entity（V56 删除） | V2 历史，V56 DROP |
| task_plans | `entity/TaskPlan.java` | V6 |
| task_items | `entity/TaskItem.java` | V6 |
| mcp_stdio_servers | `entity/McpStdioServer.java` | V12（自 config 域 `mcp` 迁出） |
| document_chunks | 无独立 Entity（Agent RAG 直读） | 不在 Flyway 链（langchain 自建自管） |

## 附录 B：删除与脱敏约定

| 约定 | 内容 |
|------|------|
| 删除生命周期 | SessionService 硬删 Session 时删除 Session-owned `messages/context_events/context_projections/files`、ChatRun 及 MCP invocation histories；Workspace 软删不级联删除 Job/数据；Job/session/run 硬 FK 按各自生命周期处理 |
| FK 级联 | `mcp_invocations` → `mcp_attempts/mcp_dispatch_history`；`workspace_jobs` → `workspace_job_history`；`provider_connections` → `provider_credential_leases`；`task_plans` → `task_items` |
| 置空 | `messages` 删后 `files.message_id` 置空，文件行保留待 orphan 清理；删除 `approval_requests` 时 `mcp_invocations.approval_request_id` 由 V51 `ON DELETE SET NULL` |
| 软删 | 仅 `workspaces.deleted_at`，查询须带 `WHERE deleted_at IS NULL`，唯一约束用部分索引实现 |
| 只追加 | `context_events/provider_connection_audit/mcp_dispatch_history/approval_history/workspace_job_history` 由 service append-only 写入（各 owner 删除时按生命周期处理）；`context_projections` 是唯一可重建的物化 |
| 脱敏 | `oauth_credentials.refresh_token_ciphertext` / `provider_connections.credential_ciphertext` 信封加密；`config_audit` 历史密钥已改写；`audit_logs.details` / `chat_runs.error_detail` 写前脱敏 |
