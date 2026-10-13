# Agent Context 与 Tool 边界

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Profile：`protocol`  
> Owner：CP Context/Projection + Agent Context consumer  
> 消费者：Agent、CP、Runtime、UI  
> 来源：PLAN-0387、PLAN-0381、PLAN-0382、DEV-013  
> 更新日期：2026-10-08

## 范围

本文冻结 Agent 对 Context snapshot、source、tool call/result 和 artifact 的消费边界；不冻结 PLAN-0381/0382 尚未接受的完整字段、版本和迁移契约。

## 事实源

| 内容 | canonical owner | Agent 允许的行为 |
|---|---|---|
| Event Store / durable event | CP | 通过既有接口读取，不直接写数据库 |
| Context projection / snapshot | CP | 只读加载 `AgentContext` |
| source/env provenance | Runtime 产生事实，CP 投影 | 只消费最终来源和状态，不自行生成 env 事实 |
| tool call/result pairing | Agent callback + CP MCP invocation | 使用既有 `toolCallId`，不得另造关联键 |
| artifact/output bound | Runtime/CP 既有 output/artifact contract | 只消费 preview/ref/status，遵守 TTL 和访问边界 |

## 规范条款

1. Context snapshot MUST 与 Chat Session/Workspace binding 一致；Agent 不得把另一个 Session 的 snapshot 合入当前 run。
2. Tool call/result MUST 以同一 `toolCallId` 配对；未匹配结果不得被合成为成功调用。
3. 大输出进入模型上下文前 MUST 有界，并显式区分完整、`truncated`、`expired`、`unavailable` 或错误状态；完整内容通过既有 artifact/output ref 按需读取。
4. source/env 失败 MUST 保留失败状态和来源，不得静默用未知旧值覆盖。
5. tool result 中的原始 secret、Bearer、凭据和未脱敏 arguments MUST 不进入模型历史、UI projection 或 audit log。
6. Context、diagnostic、checkpoint 和 approval 是不同域；工具结果可引用它们，但不得把它们合并为一个通用 payload。

## PLAN-0416 已冻结的检索与指令边界

- `instructions` 只接受 CP 解析的授权非空 Agent baseline。缺失、空白或非字符串在租约兑换及 Chat provider dispatch 前以 `BASELINE_UNAUTHORIZED` 拒绝；不读取进程级默认指令。Summary、工具结果、文件和 RAG 文本不得代填 baseline。
- RAG 是每个 Run 的动态数据，使用 API-native 模板的只读字符串槽 `xh.rag_context`，不写入稳定 ContextEpoch，也不追加到 `instructions`。只有渲染前真实的未转义 token 才触发检索；转义 token 和无 token 请求不解析 embedding profile、不签发租约、不查询向量。
- CP 从 authenticated Workspace/owner 解析 0485 profile，向 Agent 传递非密 `embeddingProfile` 与独立、Run-bound 的 `embeddingCredentialLease`。Agent 兑换时携带该 Run 的 `runId`，构建 request-scoped adapter；只允许共享数据库连接池，不跨请求缓存凭据或 profile。
- 向量查询在 PostgreSQL 相似度排序和 topK 之前按完整 Workspace、owner、Connection、API Type/version、model、dimension tuple 过滤；不得使用应用层 post-filter 或 legacy 全局 collection 兜底。
- 未启用槽位为 `disabled`，成功零命中为 `empty` 并渲染空字符串。profile/租约不可用为 `unavailable`，实际 provider/DB 查询失败为 `failed`；后两者在 Chat dispatch 前失败，经既有 Run 事件呈现稳定错误码 `RAG_PROFILE_UNAVAILABLE`、`RAG_LEASE_*` 或 `RAG_QUERY_FAILED`。

## 未冻结边界

本文其他领域的状态不因 PLAN-0416 局部契约冻结而整体晋升；tool-call/result durable message shape、artifact TTL 及 Runtime source/env provenance 仍由各领域 canonical owner 管理。

## 当前实现差距

- `AgentContext.apply_event()` 与 Python `EventType` literal 均覆盖 `context.prune` 与 `context.env_updated`；CP Event Store 仍接收自由字符串，跨层机器校验 gap 见下一条。
- CP Event Store 接收自由字符串 `eventType`，机器校验与 Agent 类型声明尚未形成闭环。
- 当前 tool/output 真实字段由 Agent adapter、CP MCP invocation/Workspace Job projections 和 Runtime artifact contract 分域拥有。

## 验证映射

- 当前对账：PLAN-0387 `evidence/current-state.md`。
- 未冻结承接：PLAN-0387 `evidence/context-boundary.md`。
- round-trip、artifact TTL 和真实输出边界：PLAN-0381/0382 后续验收；0387 V7 不提前宣称通过。
