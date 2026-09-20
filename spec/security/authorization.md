# XH 授权模型

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：Security/CP；来源：PLAN-0386；更新：2026-09-20。

## 1. 决策输入

授权决策至少包含：`principal`、platform/workspace role、authorization scope、resource、action/actionClass、resource condition、workspace membership、policy layer 和 policy revision。

## 2. 当前评估链

CP 当前按以下顺序评估：

1. 认证上下文和 Workspace access；
2. Tool face/action class；
3. built-in hard guard；
4. `instance`、`user`、`workspace` 分层 policy；
5. `ALLOW`、`DENY` 或 `ASK/REQUIRE_APPROVAL` verdict；
6. audit verdict、matched layer/rule 和 revision。

`PolicyRuleService` 的 instance 规则要求 ADMIN；user 规则属于本人；workspace 规则要求 workspace OWNER/ADMIN 或平台 ADMIN。具体 route/字段以 OpenAPI/inventory 为准。

## 3. 规则

- Authorization 对缺少身份、缺少 scope、未知 action class 和未知 resource 的情况 **MUST** fail-closed。
- 未分类工具 **MUST NOT** 继承 allow 或自动复用。
- Policy verdict **MUST** 携带足以审计和重新评估的 source layer/revision。
- `ALLOW` 不等于 approval；approval 和 capability check 必须保持独立 gate。
- Policy rule 写入 **MUST** 执行层级归属、locked deny/ask 约束、scope 唯一性和 revision 失效规则。
