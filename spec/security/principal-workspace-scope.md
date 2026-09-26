# XH Principal、Workspace Scope 与资源归属

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：Security + Workspace；来源：PLAN-0386/DEV-032/PLAN-0407（授权模型条款回写自 PLAN-0407 spec/authorization-and-derivation.md）；更新：2026-09-27。

## 1. 术语

- `principal`：执行决策的主体，目标类型包括 `human`、`agent`、`service` 和平台触发的 `system`。
- `platform role`：JWT/Spring Security 平台角色，例如 `USER`、`ADMIN`、`INTERNAL_SERVICE`。
- `workspace role`：主体在 Workspace membership 中的角色；不得用裸 `role` 替代。
- `resource owner`：资源归属 `(owner_type, owner_id)`；不等于 workspace role owner。
- `execution lease holder`：当前执行租约持有者；不等于资源归属或成员角色。
- `scope`：必须带领域限定，例如 authorization scope、OAuth provider scope、tool resource scope。
- `grant`：主体级权限记录（`grants` 表）；permission 原子为 `{actionClass, resource?}`，`resource` 缺省 `*`，**不含 `effect` 字段——未列出即 deny**（PLAN-0407 spec/authorization-and-derivation.md §2.1/§3.1 [d27]）。
- `ask list`：approval-policy 域的「要问 actionClass 清单」`askActionClasses[]`；ask 是审批流程规定，不是授权资格（PLAN-0407 spec §2 [d19]）。

## 2. 当前模型与目标模型分离

CP 当前仍使用 User JWT 作为 API caller 身份；Agent runtime 已有 stable `AgentPrincipal` 与 Workspace binding（V42），Session/Run 由 CP 根据绑定派生。授权仍是 partial：Agent principal grants、Workspace binding cap 与 Session/spawn ancestor snapshot 必须在 CP 串联求交，Agent 不能从 `user_id` 或 `toolMode` 推导额外能力。本 SPEC 的 proposed 规则不能单独启用未实现路由或授权。

## 3. 规则

- Workspace access **MUST** 经过 CP membership/access check；unknown 和 foreign resource 使用统一安全错误边界。
- Agent-specific scope **MUST** 由 Security/CP 授权后绑定和传播；Agent **MUST NOT** 自行扩大 scope。
- `SPAWN_AGENT` 是创建派生 runtime Session 的独立 actionClass；Workspace toolMode 或 binding 本身不授予 spawn。必须存在显式 Agent principal grant，并与当前 binding cap 和 parent Session/spawn ancestor snapshots 求交；该 action 不进入任何默认 grant 集。grant 通过后才按现有 policy/approval mode 判定，grant 缺失必须先拒绝且不得创建 approval。
- 所有资源归属、成员角色、执行租约和 OAuth/provider scope **MUST** 使用域限定术语。
- 任何 target principal/schema 迁移必须另立 PLAN，完成字段矩阵、round-trip、兼容和回滚证据。
- **三道串联（fail-closed）**：道1 授权 = 一跳查表（`GrantAuthorizationService`：交集后的当前权限集含该 actionClass → 过，不含 → deny，制度拒）；道2 capability = 后端包络能否物理执行，不满足即物理拒且**不触发审批**；道3 approval = 触发源之一为 approval-policy 的 ask list（`askActionClasses[]`）。Gate order **G4** = HardGuard L0 → grant 查表 → approval，**grant deny 不得到达 approval，也不得创建 pending approval**；`userDirectMutation` 只评估已认证 human User 的 grant，Agent tool authorization 不自动并入 `sessions.user_id`（PLAN-0407 spec/authorization-and-derivation.md §2/§4.2 [d16][d18][d19]）。既有 `hasRole` 守卫 v1 保留为安全网，与查表并存且两轨不得互相矛盾 [d18]；role 权限再大不得越过 capability 包络 [d16]。
- **grant 模型**：单主体当前权限集 = 该主体 `default|spawn|direct|template` grant permission atoms 的 **union**（G1；`source` 只作溯源，不形成优先级）；操作授权 = 请求的每个 action/resource atom 在驱动链上**每个**主体 set 中均有匹配（G2，subject union 后 path intersection）。仅工具调用边界重算（I4），评估内不重读，评估异常 = fail-closed 拒绝；空集合、词表外 actionClass、坏 JSON 一律 deny（PLAN-0407 spec §3.1/§4.2 [d27][d10]）。
- **注册默认最小集（I-V）**：公共注册 = 系统基线铸造，新注册 USER 的 `source=default` 权限集 = **USER 最小集（read/write/delete/exec/network，`credential` 不在 USER 默认集）+ 仅本人资源**；仅本人资源由 subject 隔离、workspace 成员隔离与 HardGuard L0 路径校验共同收口，不靠 default atom 写 resource 模式。铸造物权限 ⊆ 铸造者当前权限集，公共注册是唯一例外（PLAN-0407 spec §4.1/§4.2 [d15]；断言 `GrantDefaultBootstrapIntegrationTest`）。
- **policy rules 裁决退役**：退役 = rules 裁决路径（规则求值产 allow/ask/deny 的授权用途）与 `/api/v1/policy/rules` CRUD；**保留** = HardGuard L0（代码内置、任何模式/规则不可覆盖：路径逃逸 / 关键路径删除 / 凭据嗅探）、`policy_rules` 表与 `PolicyRuleService` 的审批复用存储和 `policy_revision` 失效源（含审批存储侧 `ApprovalGrantWriter.RulePlan`）、`/api/v1/policy/domains` 词表与 ToolFace 分类；rules 中的 ask 语义迁入 `askActionClasses[]`，allow/deny 归查表自然取代；permission-rules UI 页退役归 PLAN-0374 T3.4（PLAN-0407 spec §9 [d18][d19][d21]）。行为翻转：原「无规则默认 ASK」→ 无权限集命中 = **拒不弹**，词表外 actionClass 同拒 [d21]。

## 4. 分级查询（Tier-1 / Tier-2）

- Tier-1 状态元数据：沿 provenance **单向向下** + 同 workspace **免 grant**，返回形状 `{sessionId, runId, state, at}`，**无内容字段**；反向、链外、跨 workspace 与 dangling/cyclic provenance 一律 403。
- Tier-2 内容访问：先适用同一链规则，再经唯一评估内核 `GrantAuthorizationService.allows` 判定；无显式 grant 即 403；workspace 文件内容仍走既有 workspace 文件通道。
- 内部路由 `GET /internal/v1/queries/tier1/status` 与 `GET /internal/v1/queries/tier2/access`（service Bearer）。评估内核唯一，PLAN-0408 消费本 API，不建第二套（PLAN-0407 spec/authorization-and-derivation.md §5 [d2]）。
