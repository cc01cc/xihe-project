# Chat Session 生命周期

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Profile：`lifecycle`  
> Owner：CP Session owner  
> 消费者：UI、Agent、Context、Operation、Workspace  
> 来源：PLAN-0387、PLAN-0348、PLAN-0660、DEV-017  
> 更新日期：2026-11-04

## 领域边界

Workspace 是独立资源。Session 可以绑定一个 Workspace，但 Workspace 不依赖 Session；没有 Session 时仍可创建、导入、浏览和编辑 Workspace。

Session 负责连续对话上下文、消息、附件引用、模型绑定和 Chat SSE 订阅；它不拥有 Runtime Sandbox 或 Runtime MCP 进程。

## 状态

| 状态 | 说明 | 权威 |
|---|---|---|
| `active` | 可创建 ChatRun、订阅 Chat SSE | CP Session |
| `archived` | 不作为当前交互 Session，但服务端数据按保留策略处理 | CP Session |
| `deleted` | 删除 API 成功后的终态；删除前必须处理非终态 run | CP Session + cancellation |

## 规范条款

1. Session MUST 最多绑定一个 Workspace；Session 生命周期内不得 rebind 到另一个 Workspace。
2. Workspace 切换 MUST 通过选择已有 Session 或创建新 Session 表达，不把 Workspace 切换写成 Session rebind。
3. Session API、消息和附件的 canonical source 是 CP；UI local store 只能作为 UI 本地视图（非权威）。
4. Session 删除前 MUST 通过 CP 取消/收口非终态 ChatRun，并在有界等待后完成删除；不能只删除 UI 状态。
5. Chat SSE 按 `sessionId` 订阅；Workspace SSE 按 `workspaceId` 订阅，两者不能互充。

## 投递语义（投递 = 通知 / 唤醒）

> 来源：PLAN-0660。本节点冻结「一次 @/cc 投递成立」的判据与失败收口；实施与验收证据见该 PLAN。

1. **人=通知**：`HUMAN` 参与者被投递时 MUST 只产生 durable `wake_dispatch`（`outcome=notify`）与 `readCursor.mentionCount` 推进；MUST NOT 产生 ChatRun、MUST NOT 指定 responder。
2. **通知判据**：投递成立的条件 MUST 是「对象为该 Session 的参与者 + 未 disabled + 属于本 Session（`participant.sessionId == sessionId`）」；MUST NOT 把「能否以该主体发言」（speak-as，D23-08）当作通知判据——对另一个人类该问题恒为否。
3. **通知不授予发言权**：通知路径 MUST NOT 调用 speak-as、MUST NOT 写 `chat_runs.agent_principal_id`、MUST NOT 依赖能力原子或角色名判据（受众 = 显式寻址的名册成员，不是可见性决策）。
4. **AGENT 唤醒仍需授权**：唤醒 `AGENT` 参与者会写 `chat_runs.agent_principal_id`，MUST 保持 D23-08 代发言授权（caller = Session owner）。授权拒绝 MUST 以**判定结果**跨调用边界（不得以异常跨越事务边界），拒绝行 `outcome=refused` MUST 随正常提交落地。
5. **单参与者失败不中断整轮**：任一收件人失败（授权拒绝或运行时异常）MUST 只终结该收件人（`refused` / `dropped` 可查）；同轮其它收件人与 cc 观察者 MUST 仍被投递；轮次汇总 MUST 满足 `enqueued == started + deferred + dropped`。
6. **失败不静默**：每次投递 MUST 以 `started`/`deferred`/`dropped`/`notify`/`refused`/`skipped_*` 之一收口并留可查留痕；不得因事务回滚而只剩日志行。
7. **不扩契约**：本节点不新增事件名、计数维度或 API 路由；新增语义 MUST 复用既有 `wake_dispatch` 信封的 `outcome` / `reason` 字段。

## 恢复与失败

- Chat SSE 断线由 UI transport 按 session generation 和 `Last-Event-ID` 恢复；恢复不创建新的 Session。
- Session 查询失败、Workspace context 缺失或授权失败 MUST 显式返回错误；UI 不得伪造默认 Session。
- Session 与 Workspace 的授权边界来自 Security/CP；本文件不定义 role/scope。

## 承接与验证

- Session 固定 Workspace 与跨 Session 延续：PLAN-0348。条款 1–2（固定绑定、不 rebind）已负向验证：CP 跨 Workspace 作用域拒绝（404）+ Agent 跨 workspace `fail-closed`；跨 Session 延续入口**未实施**（退 backlog）。证据见 PLAN-0348 `evidence/`。
- 投递语义（人=通知 / 通知≠发言权 / 单参与者失败不中断整轮）：PLAN-0660（「投递语义」节条款 1–7）。验收：单测 `WakeDispatchServiceTest`/`WakeFanOutServiceTest`、真栈 `R1-b`/`R1-c`、`V1`–`V7`；证据见该 PLAN `evidence/m1-notify-decoupled.md`、`m2-transaction-and-trace.md`、`m3-gate.md`、`m4-real-stack.md`。
- Agent principal Workspace scope：PLAN-0374。
- 当前实现对账：PLAN-0387 `evidence/current-state.md`。
- 真实 delete/recovery/SSE 验证：PLAN-0387 V7，尚未完成。
