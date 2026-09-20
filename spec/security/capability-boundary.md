# XH 执行能力边界

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：Runtime/Security；来源：PLAN-0386/DEV-031；更新：2026-09-20。

## 1. 独立决策层

Authorization 回答“这个 principal 是否可以请求该 action”；capability policy 回答“选定执行后端是否能在该能力包络内物理执行该 action”；approval 回答“这一次 operation 是否还需要额外放行”。

```text
authentication -> authorization -> capability policy -> approval gate -> execution -> audit
```

## 2. 规则

- backend-neutral capability 名称 **MUST NOT** 泄漏 Docker/MXC transport 细节。
- `declared` capability、`probed` capability 和 `reason` **MUST** 保持区分。
- capability 不支持、未知或探测失败 **MUST** fail-closed；unrestricted host execution 只能是用户显式选择的模式，不能静默 fallback。
- Windows MXC 的 maturity/experimental 状态 **MUST** 对 policy 和 UI consumer 可见。
- Approval **MUST NOT** 扩大已拒绝的 capability，也不能绕过 backend policy。
