# XH Principal、Workspace Scope 与资源归属

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：Security + Workspace；来源：PLAN-0386/DEV-032；更新：2026-09-20。

## 1. 术语

- `principal`：执行决策的主体，目标类型包括 `human`、`agent`、`service` 和平台触发的 `system`。
- `platform role`：JWT/Spring Security 平台角色，例如 `USER`、`ADMIN`、`INTERNAL_SERVICE`。
- `workspace role`：主体在 Workspace membership 中的角色；不得用裸 `role` 替代。
- `resource owner`：资源归属 `(owner_type, owner_id)`；不等于 workspace role owner。
- `execution lease holder`：当前执行租约持有者；不等于资源归属或成员角色。
- `scope`：必须带领域限定，例如 authorization scope、OAuth provider scope、tool resource scope。

## 2. 当前模型与目标模型分离

当前实现主要使用 `user_id`、User JWT 和 Workspace membership。Agent independent principal、`owner_type=AGENT` 和 delegation 仍是目标缺口，不能由本 SPEC 直接启用。

## 3. 规则

- Workspace access **MUST** 经过 CP membership/access check；unknown 和 foreign resource 使用统一安全错误边界。
- Agent-specific scope **MUST** 由 Security/CP 授权后绑定和传播；Agent **MUST NOT** 自行扩大 scope。
- 所有资源归属、成员角色、执行租约和 OAuth/provider scope **MUST** 使用域限定术语。
- 任何 target principal/schema 迁移必须另立 PLAN，完成字段矩阵、round-trip、兼容和回滚证据。
