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
