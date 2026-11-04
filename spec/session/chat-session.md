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

### 显式 TO 多目标（fan-out，PLAN-0665）

> 来源：PLAN-0665 M1。语义 = 「这条消息由**被点名的这些主体**各自回应」（TO 从单值扩到集合）。

1. **目标集合 = AGENT 参与者**：`toParticipantIds` MUST 只接受本 Session 的 **AGENT** 参与者；
   人类目标 MUST 以 `400 INVALID_REQUEST` 显式拒绝（人类作答受 BL-238 wake 授权缺陷阻塞，另立计划）。
2. **第一个目标承载提交**：集合首个目标 MUST 拥有本次 `user_submission` run（`runId` = `runIds[0]`）；
   其余目标 MUST 作为派生 run 派发，其 wake 审计 `triggerSource="to"`；MUST NOT 为未选中主体
   虚构 PRIMARY run。
3. **origin 不得当分组依据**：派生 run 的 `origin` 仍为 `user_submission`、`parent_run_id` MUST 保持
   NULL（委派链语义不得复用）。MUST NOT 新增 origin 枚举或列；读侧 MUST 按 `runId` / 消息的
   durable `delivery` 归组，**不得**按 `origin` 推断「同一消息」。
4. **单一入口**：单目标与多目标 MUST 走同一个 `TargetedWake` 入口，只差目标集合大小（禁止两条路径）。
5. **显式 TO 优先于 @ 抑制**：带 `toParticipantIds` 的提交 MUST NOT 被 `@` 抑制成
   `suppressed_no_responder`；`@` 与 TO 命中同一参与者时 MUST 去重（一条消息不为其开两个 run）。
6. **幂等身份含集合**：排序后的 TO 集合与 `asParticipantId` MUST 进入 `Idempotency-Key` 的
   request hash（同内容不同收件人 MUST NOT 判为重复）；`cc` 仍不入哈希（notify-only）。

### 投递语义的持久载体（PLAN-0665 D3 / V120）

1. composer 的 TO / CC 受众 MUST 落 `messages.delivery`（JSONB，可空）——`{"to":[...],"cc":[...]}`，
   只存 participantId；`@` 仍由正文 + 花名册重建，不重复存。
2. 读取面 MUST 在消息 DTO 中回传 `delivery`；缺字段（V120 之前的消息、内部 wake 提示）MUST 视为
   「无投递记录」，不得伪造默认受众。
3. 本载体 MUST 终结 BL-239（刷新后 TO/CC 不再丢失），UI 不得再以「本地发送态」作为唯一来源。

### 消息主体归属的持久载体（PLAN-0669 D1/D2 / V121）

1. **归属 = 谁说的，且只存 id**：`messages.participant_id`（UUID，可空，`ON DELETE SET NULL`）MUST 存
   **会话参与者 id**（`session_participants.id`），MUST NOT 存名字（重命名不得留下陈旧文案）。
2. **写入方唯一**：assistant 消息 MUST 在单一写入点（`ChatSubmissionService.persistAssistantResponse`）
   按回退链 `chat_runs.agent_principal_id → sessions.agent_principal_id → 参与者行` 落值；仍解析不到
   ⇒ MUST 保持 NULL（MUST NOT 猜 PRIMARY —— 错误归属比没有归属更糟）。
3. **用户消息 v1 不归属**：composer 的 `asParticipantId` 是**目标身份**（默认 PRIMARY 是 AGENT），
   MUST NOT 当作作者写入；human 作者归属属 BL-277（需拆 author/target 或加 wire 字段）。
4. **老数据语义**：V121 之前的消息 MUST 保持 NULL、**不回填**；读面 MUST 省略该字段（而非发 null），
   UI MUST 在字段缺失或花名册无该行时**不渲染**徽标（MUST NOT 显示"未知"、MUST NOT 上屏裸 UUID）。
5. **归属与 run 一致**：assistant 消息的 `participant_id` MUST 等于该 run 的 responding participant
   （单测 + 真栈断言；run responder principal 与 participant 行 MUST 同一行）。
6. **契约面**：OpenAPI `SessionMessage.participantId` 可空；fork/复制消息 MUST NOT 复制归属
   （子会话花名册未复制，父 id 会悬空/撞 FK）。

## 恢复与失败

- Chat SSE 断线由 UI transport 按 session generation 和 `Last-Event-ID` 恢复；恢复不创建新的 Session。
- Session 查询失败、Workspace context 缺失或授权失败 MUST 显式返回错误；UI 不得伪造默认 Session。
- Session 与 Workspace 的授权边界来自 Security/CP；本文件不定义 role/scope。

## 可观测性：上下文指纹

> PLAN-0666（BL-269）。目的：回答"同 session 内模型输出变化时，是拼接侧变了还是模型侧变了、具体哪一层变了"。
> 指纹是既有上下文源的**摘要**，不是新一套上下文模型。以下两条为**断言**（不变量），实现与测试必须可反驳。

### A1【断言】两级模型：落库文档 × 读侧信封

| 层级 | 字段 | 允许值 |
|---|---|---|
| **落库文档**（`chat_runs.context_fingerprint`） | `status` | `ok` / `disabled` / `error` —— **恰好这三种** |
| **读侧信封** | `available` + `reason` | `available=false` ⇒ `reason ∈ {pre_plan, not_dispatched}` |

- `not_dispatched` 是**读侧合成态，不落库**；若将来要把"提交后未下发"写成落库态，**需另立决策**（不得悄悄加第五种 `status`）。
- **"完全没有文档"绝不允许被映射成 `disabled` 或 `error`**：历史行（`pre_plan`）与"提交了没发出去"（`not_dispatched`）都不是"关闭"也不是"出错"。
- `disabled` 是唯一 `enabled=false` 的落库态；`error` 保持 `enabled=true`（fail-open 不等于关闭）。

### A2【断言】不可见 ≠ 无变化

- 层不可见（`unavailable`，如 `tools=agent_side`）时 diff 只能报 `unavailable`，**绝不降级为 `unchanged`**；任一侧文档状态非 `ok` 时整体 diff 为 `unavailable + sides[side,status/reason]`。
- 理由：把"没数据"读成"没变化"会让人得出与事实相反的结论——宁可不给结论，也不给假结论。

### 记录与层

- **记录时点**：每次 run **首次下发前**（`dispatchAttempt = 1`）；overflow 重发**不覆盖**（SQL 层 `context_fingerprint IS NULL` 守卫）；"只记首次下发"必须写进 OpenAPI 与本节。
- **层（固定顺序）**：`template` / `skills` / `history` / `memory` / `userInput` / `attachments` / `config` / `tools` / `outbound`。每层只含 `hash/count/bytes`；`tools` 由 Agent/MCP 侧解析，CP 不可见 ⇒ 恒 `{"unavailable":"agent_side"}`，不得用 `toolMode` 等相似字段填充。
- **确定性**：sha256 over 显式 canonical JSON（对象键 UTF-8 字节序递归排序、数组语义序、数字规范化、排除时间戳/runId/attemptId/token）；验收含真实 `context_projections` 快照在两个独立进程计算相等。
- **隐私**：只含 hash/计数/字节与闭集枚举，不含内容片段；敏感工作区用工作区开关（`context-policy.defaults.fingerprintEnabled=false`）关闭。
- **与 Run Trace 的关系**：trace 是事件时间线（cursor/asOf 分页），指纹是下发上下文快照摘要（一列、无分页）；互补不合并。

## 承接与验证

- Session 固定 Workspace 与跨 Session 延续：PLAN-0348。条款 1–2（固定绑定、不 rebind）已负向验证：CP 跨 Workspace 作用域拒绝（404）+ Agent 跨 workspace `fail-closed`；跨 Session 延续入口**未实施**（退 backlog）。证据见 PLAN-0348 `evidence/`。
- 投递语义（人=通知 / 通知≠发言权 / 单参与者失败不中断整轮）：PLAN-0660（「投递语义」节条款 1–7）。验收：单测 `WakeDispatchServiceTest`/`WakeFanOutServiceTest`、真栈 `R1-b`/`R1-c`、`V1`–`V7`；证据见该 PLAN `evidence/m1-notify-decoupled.md`、`m2-transaction-and-trace.md`、`m3-gate.md`、`m4-real-stack.md`。
- Agent principal Workspace scope：PLAN-0374。
- 当前实现对账：PLAN-0387 `evidence/current-state.md`。
- 真实 delete/recovery/SSE 验证：PLAN-0387 V7，尚未完成。
