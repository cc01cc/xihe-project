# Agent Context 与 Tool 边界

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Profile：`protocol`  
> Owner：CP Context/Projection + Agent Context consumer  
> 消费者：Agent、CP、Runtime、UI  
> 来源：PLAN-0387、PLAN-0381、PLAN-0382、DEV-013  
> 更新日期：2026-09-20

## 范围

本文冻结 Agent 对 Context snapshot、source、tool call/result 和 artifact 的消费边界；不冻结 PLAN-0381/0382 尚未接受的完整字段、版本和迁移契约。

## 事实源

| 内容 | canonical owner | Agent 允许的行为 |
|---|---|---|
| Event Store / durable event | CP | 通过既有接口读取，不直接写数据库 |
| Context projection / snapshot | CP | 只读加载 `AgentContext` |
| source/env provenance | Runtime 产生事实，CP 投影 | 只消费最终来源和状态，不自行生成 env 事实 |
| tool call/result pairing | Agent/CP Ledger | 使用既有 `toolCallId`，不得另造关联键 |
| artifact/output bound | Runtime/CP 既有 output/artifact contract | 只消费 preview/ref/status，遵守 TTL 和访问边界 |

## 规范条款

1. Context snapshot MUST 与 Chat Session/Workspace binding 一致；Agent 不得把另一个 Session 的 snapshot 合入当前 run。
2. Tool call/result MUST 以同一 `toolCallId` 配对；未匹配结果不得被合成为成功调用。
3. 大输出进入模型上下文前 MUST 有界，并显式区分完整、`truncated`、`expired`、`unavailable` 或错误状态；完整内容通过既有 artifact/output ref 按需读取。
4. source/env 失败 MUST 保留失败状态和来源，不得静默用未知旧值覆盖。
5. tool result 中的原始 secret、Bearer、凭据和未脱敏 arguments MUST 不进入模型历史、UI projection 或 audit log。
6. Context、diagnostic、checkpoint 和 approval 是不同域；工具结果可引用它们，但不得把它们合并为一个通用 payload。

## 未冻结边界

PLAN-0381 负责 tool-call/result durable message shape、projection round-trip、artifact TTL 状态；PLAN-0382 负责 snapshot/env/source 字段、最终 Runtime provenance 和 failure semantics。两者完成前，本文件不晋升为 `active`，也不新增 wire/schema 字段。

## 当前实现差距

- `AgentContext.apply_event()` 已处理 `context.prune` 与 `context.env_updated`，但 Python `EventType` literal 尚未覆盖它们。
- CP Event Store 接收自由字符串 `eventType`，机器校验与 Agent 类型声明尚未形成闭环。
- 当前 tool/output 真实字段由 Agent adapter、CP relay、Operation Ledger 和 Runtime artifact contract 分散拥有。

## 验证映射

- 当前对账：PLAN-0387 `evidence/current-state.md`。
- 未冻结承接：PLAN-0387 `evidence/context-boundary.md`。
- round-trip、artifact TTL 和真实输出边界：PLAN-0381/0382 后续验收；0387 V7 不提前宣称通过。
