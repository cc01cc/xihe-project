# XH Operation Ledger

> 契约状态：`proposed`；实现状态：`partial`；Profile：`data`；Owner：CP durable-record owner；来源：PLAN-0385；更新：2026-09-20。

## 1. 对象边界

| 对象 | 作用 | 事实源 |
|---|---|---|
| Operation | 一次跨模块可追踪的根操作 | CP durable ledger |
| OperationItem | 一个 tool/chat/approval 等事实单元 | CP durable ledger |
| Attempt | 某一 item 的一次执行尝试 | CP durable ledger |
| OperationEvent | append-only 状态/事实事件 | CP durable ledger |
| Extension | 类型化附加事实，如 usage/job/policy | CP durable ledger + schema |
| Tool pair | Agent/MCP 两侧同一 tool call 的只读配对投影 | CP projection |

## 2. 关联键与来源

- `operationId` 是根操作键；`operationItemId` 是 item 的 canonical durable 键。
- `toolCallId` 是跨 Agent/MCP channel 的关联键；同一事实的各层必须复用，禁止从 event id、run id 或展示名称重新派生。
- item 的 `source`（例如 `agent`/`mcp`）描述通道事实，不等于 actor 身份。
- 原始 prompt、tool arguments、文件内容和 token 不进入普通 ledger summary；安全投影只暴露必要字段。

## 3. 幂等与终态

| 操作 | 约束 |
|---|---|
| start Operation | idempotency key 重放返回既有 operation，不重复创建 |
| append item | 以 canonical toolCallId/业务键防重复；sequence 由 durable ledger 分配 |
| start/finish attempt | request/attempt 级幂等；同终态重放可返回既有结果，异终态冲突 |
| append event | append-only；历史事件不可因后续状态改写 |
| cancel/late termination | 结算路径拥有终态；迟到副作用只追加 late event，不抢写已结算终态 |
| lock timeout | bounded lock wait 显式 503 `OPERATION_LOCK_TIMEOUT`，不得无限等待 |

Operation 状态、item 状态、attempt 状态和 approval 状态必须分别定义合法转换；不能用一个 aggregate status 代替局部事实。

## 4. 消费者与验证

- public operation projection：用户拥有的脱敏列表/trace；跨用户不存在资源泄露。
- internal trace：CP、Agent、Runtime 调试和对账；artifact 内容仍需单独读取。
- UI audit view：消费安全 projection、tool pairs、policy summary，不重新推导状态。
- 测试事实源包括 OperationService integration tests、CP routes、AgentEvent/SSE mapping、UI operations tests 和 Runtime late-termination integration。

完整字段、DB schema、错误响应和 route 以 OpenAPI/Flyway/代码为准；本文只冻结对象边界、来源、关联键和终态规则。
