# XH Principal、Workspace Scope 与资源归属

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：Security + Workspace；来源：PLAN-0386/DEV-032/PLAN-0407；更新：2026-09-25。

## 1. 术语

- `principal`：执行决策的主体，目标类型包括 `human`、`agent`、`service` 和平台触发的 `system`。
- `platform role`：JWT/Spring Security 平台角色，例如 `USER`、`ADMIN`、`INTERNAL_SERVICE`。
- `workspace role`：主体在 Workspace membership 中的角色；不得用裸 `role` 替代。
- `resource owner`：资源归属 `(owner_type, owner_id)`；不等于 workspace role owner。
- `execution lease holder`：当前执行租约持有者；不等于资源归属或成员角色。
- `scope`：必须带领域限定，例如 authorization scope、OAuth provider scope、tool resource scope。

## 2. 当前模型与目标模型分离

CP 当前仍使用 User JWT 作为 API caller 身份；Agent runtime 已有 stable `AgentPrincipal` 与 Workspace binding（V42），Session/Run 由 CP 根据绑定派生。授权仍是 partial：Agent principal grants、Workspace binding cap 与 Session/spawn ancestor snapshot 必须在 CP 串联求交，Agent 不能从 `user_id` 或 `toolMode` 推导额外能力。本 SPEC 的 proposed 规则不能单独启用未实现路由或授权。

## 3. 规则

- Workspace access **MUST** 经过 CP membership/access check；unknown 和 foreign resource 使用统一安全错误边界。
- Agent-specific scope **MUST** 由 Security/CP 授权后绑定和传播；Agent **MUST NOT** 自行扩大 scope。
- `SPAWN_AGENT` 是创建派生 runtime Session 的独立 actionClass；Workspace toolMode 或 binding 本身不授予 spawn。必须存在显式 Agent principal grant，并与当前 binding cap 和 parent Session/spawn ancestor snapshots 求交；该 action 不进入任何默认 grant 集。grant 通过后才按现有 policy/approval mode 判定，grant 缺失必须先拒绝且不得创建 approval。
- 所有资源归属、成员角色、执行租约和 OAuth/provider scope **MUST** 使用域限定术语。
- 任何 target principal/schema 迁移必须另立 PLAN，完成字段矩阵、round-trip、兼容和回滚证据。
