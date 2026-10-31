# XH 授权模型

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：Security/CP；来源：PLAN-0386；PLAN-0407 T2.8 按其 spec §9 根级写回（policy/rules 裁决 → 查表语义）；更新：2026-09-27。
> 消费者：CP 授权/policy、Workspace API、MCP 工具调用门、UI 授权结果

## 1. 决策输入

授权决策至少包含：`principal`、platform/workspace role、authorization scope、resource、action/actionClass、resource condition、workspace membership、policy layer 和 policy revision。

## 2. 当前评估链

CP 当前按以下顺序评估（PLAN-0407 T2.8 之后）：

1. 认证上下文和 Workspace access；
2. Tool face/action class；
3. built-in hard guard（`HardGuard` L0，任何模式/规则不可覆盖）；
4. **grants 一跳查表**：单主体有效 grants（default/direct/spawn/template）union → 驱动链 path intersection；命中该 actionClass/resource → 过，未命中 → deny（制度拒，且**不进入 approval、不建 pending approval**）。policy rules 分层裁决（RulePlan 求值产 `ALLOW/DENY/ASK`）已退役 [d18]；
5. **approval-policy `askActionClasses[]` 要问清单**：actionClass 在册且 `mode=manual` → `ASK` 进入审批；在册且 `mode=auto` → 放行并记 `allowed_by`；不在册 → 授权过后直过 [d19]。缺配置回退代码默认清单，显式空数组 = 什么都不问；
6. audit：grant 决策与 `policy_verdict`（effect / source layer / reason / `allowed_by`）按既有审计通道记录。

`/api/v1/policy/rules` CRUD（list/create/conflicts/delete）已随裁决引擎退役（0407 T2.8）；`PolicyRuleService` 仅保留审批复用存储的写入路径（层级归属、locked 仅 deny/ask、逐写 `policy_revision` 失效等约束仍在该路径执行）与 `/api/v1/policy/domains` 词表字典。具体 route/字段以 OpenAPI/inventory 为准。

## 3. 规则

- Authorization 对缺少身份、缺少 scope、未知 action class 和未知 resource 的情况 **MUST** fail-closed。
- 未分类工具 **MUST NOT** 继承 allow 或自动复用。
- Policy verdict **MUST** 携带足以审计和重新评估的 source layer 与 reason；规则裁决退役后 `matchedRule` 恒为空。
- `ALLOW` 不等于 approval；approval 和 capability check 必须保持独立 gate。
- Policy rule 存储写入（审批复用路径）**MUST** 执行层级归属、locked deny/ask 约束、scope 唯一性和 revision 失效规则。
- **grant 写入只有唯一受审计管理面**（PLAN-0585）：`GET/PATCH /api/v1/principal-grants/{username}`，仅 instance ADMIN 可调用、按 username 精确寻址、差集 `{add, remove}` 写入目标 USER 的 `source='direct'` 行；**MUST NOT** 改 `source='default'` 默认集，**MUST NOT** 恢复 `/api/v1/policy/rules` 或通用 grants CRUD，也**MUST NOT** 把 opt-in action 放进注册默认集。
- 可经该写面授予的 action **MUST** 限于 `CREATE_ACCOUNT`（resource 恒 `*`）与 `MANAGE_WORKSPACE_AGENTS`（resource **MUST** 是具体 workspace UUID，禁 `*`）；其余 action（含 `CREATE_TEMPLATE`）一律 fail-closed，默认 deny 与三者独立性不变。

## 4. 实例所有权与 last-admin 不变式（PLAN-0580）

实例角色只有 `ADMIN` 与 `USER` 两种，"实例所有权"是**单例指针**而不是第三种角色（能力集合与所有权基数不混用）。

| # | 不变式 | 判据 |
|---|---|---|
| I1 | `instance_owner.owner_user_id` 非空时**MUST** 指向一个 `role=ADMIN` 的用户 | 转移校验目标角色；读取路径不产生中间态 |
| I2 | 任意时刻实例 `ADMIN` 计数 **MUST ≥ 1** | 降级前在实例级锁内复检计数；并发双降级只允许一个成功 |
| I3 | owner **MUST NOT** 被降级/禁用/软删/删除；所有权只能经 `PUT /api/v1/instance/owner` 转移 | 守卫优先级：owner 保护先于 last-admin |
| I4 | 角色变更、default 权限集重算、`users.token_version + 1` **MUST** 在同一事务提交 | 提交后旧 access token 下一次请求即 401 |
| I5 | 转移 **MUST** 由当前 owner 发起并通过口令复核，且写 durable 审计 | 失败时 owner 与审计零变化 |

- **实例级写互斥**：所有会改变 owner 或角色的写路径 **MUST** 先取 `instance_owner` 单例行的 `FOR UPDATE`（锁序 `instance_owner` → 目标 `users` 行），并在首语句执行 `dbLockTimeout.apply()`；锁等待超过 `cp.lock-timeout-ms` **MUST** 以 `503 OPERATION_LOCK_TIMEOUT` 显式失败（可重试），**MUST NOT** 与 409 状态冲突混用。
- **default 权限集随角色同步的边界**：`subject_type="user"` 的 `source='default'` 行 **MUST** 在同一事务内按新角色重写；`subject_type="agent"` 的默认集是**已创建 Session 的快照**，角色变更后 **MUST 保持不变**（显式接受项，与"绑定只影响新 Session"同模型）。
- **不新增角色、不新增公开错误码**：last-admin/owner 保护复用既有 409 语义（`LAST_ADMIN` / `INSTANCE_OWNER_PROTECTED`），**MUST NOT** 引入 `SUPER_ADMIN` 或第三角色。

### 4.1 access token epoch（`tv`）

- access token **MUST** 携带 epoch claim `tv`，其值等于签发时刻的 `users.token_version`；唯一生产签发点是 `AuthService.issueTokens`。
- 每个需要认证的请求 **MUST** 用签名校验后的 `sub` 按主键读一次用户行并比对 `tv`（无缓存）。**MUST NOT** 仅凭签名有效期放行。
- **三态 fail-closed**：① `sub` 不是 UUID；② 用户行不存在；③ `tv` 缺失或与行值不匹配 —— 三者 **MUST** 一律按"未认证"处理（外部表现为 401 `AUTHORIZATION_REQUIRED`），**MUST NOT** 抛出异常导致 500。
- 认证过滤链与租户上下文拦截器 **MUST** 使用**同一份** epoch 判定：撤销后的 token 既不得建立 `Authentication`，也 **MUST NOT** 写入 `TenantContext.userId`/`userRole`（含 `isTenantExempt` 路径）。
- **服务间凭证不进入用户租户语义**：`InternalTokenFilter` 的 `cp.agent-api-token` 是共享密钥、不是用户 access token，**MUST NOT** 因此写入用户租户上下文（`TenantContext.userId` 恒为 null）。
