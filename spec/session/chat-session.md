# Chat Session 生命周期

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Profile：`lifecycle`  
> Owner：CP Session owner  
> 消费者：UI、Agent、Context、Operation、Workspace  
> 来源：PLAN-0387、PLAN-0348、PLAN-0660、PLAN-0689、PLAN-0665、D-1846、DEV-017  
> 更新日期：2026-11-19

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
   > **task-65 supersede（2026-11-15，D-1438 ②）**：上面「只接受 AGENT / 人类 `400`」是 M1 的历史口径，
   > 已作废。现行规则：本 Session 的**任意未停用参与者**都是合法投递目标（判据见上文「投递语义」第 1–3 条：
   > 参与者 + 未 disabled + 属于本 Session，**不是** speak-as）；HUMAN 目标 MUST 以
   > `202 + notifiedTargets[]`（`reason="notify"`）收口、MUST NOT 产生 run。
   > 原文按 `D-1442` 保留、不再作为现行判据。
2. **第一个目标承载提交**：集合首个目标 MUST 拥有本次 `user_submission` run（`runId` = `runIds[0]`）；
   其余目标 MUST 作为派生 run 派发，其 wake 审计 `triggerSource="to"`；MUST NOT 为未选中主体
   虚构 PRIMARY run。
   > **task-87 supersede（2026-11-15）**：「集合首个目标」MUST 读作**请求序中第一个 AGENT 目标**
   > （HUMAN 目标只通知、不承载提交 run）；集合内只有 HUMAN 目标时无人作答，run MUST 以
   > `terminalOutcome=suppressed_no_responder` 终结并在 202 回报 `notifiedTargets[]`，
   > MUST NOT 回落 PRIMARY 代答。
3. **origin 不得当分组依据**：派生 run 的 `origin` MUST 取**该 run 载体的既有分类**（2026-11-05 真栈实测：
   wake 载体为 `scheduled`；用户提交为 `user_submission`），`parent_run_id` MUST 保持 NULL（委派链语义不得复用）。
   MUST NOT 新增 origin 枚举或列；读侧 MUST 按 `runId` / 消息的 durable `delivery` / `trigger_source` 归组，
   **不得**按 `origin` 推断「同一消息」。
4. **单一入口**：单目标与多目标 MUST 走同一个 `TargetedWake` 入口，只差目标集合大小（禁止两条路径）。
5. **显式 TO 优先于 @ 抑制**：带 `toParticipantIds` 的提交 MUST NOT 被 `@` 抑制成
   `suppressed_no_responder`；`@` 与 TO 命中同一参与者时 MUST 由 **TO 路径唯一建 run**（mention 轮跳过 TO 目标），一条消息不得为其开两个 run。
5b. **运行时失败不得静默**（2026-11-05 真栈实锤）：目标在**运行时**派发失败（DB 约束、网络、Agent 不可用）MUST 部分成功并
   在 202 响应回报 `failedTargets:[{participantId,reason}]`，且 `runIds.length + failedTargets.length + deferredTargets.length`
   MUST 等于请求目标数；失败 MUST 以 ERROR 级 `event=to_target_dispatch_failed` 留痕（可 grep 计数）。**前置校验失败**
   （目标不存在/无权限/已停用/非 AGENT）则 MUST 整条拒绝（400/403），两类情形不得混用同一处理。
   > **task-53/task-60 supersede（2026-11-15）**：现行不变量是**五个桶** ——
   > `runIds + failedTargets + deferredTargets + notifiedTargets + suppressedTargets == 请求目标数`
   > （`notifiedTargets` = 已通知的 HUMAN 目标、无 run；`suppressedTargets` = 按策略刻意不唤醒，
   > `detail` 是机器 token）。且「前置校验失败」不再包含「非 AGENT」：`task-65` 起人类目标是合法目标。
5c. **deferred 是排队，不是失败**（BL-283，Lead 2026-11-05 裁定）：目标因 Session 并发满
   （`maxConcurrentRunsPerSession`）被顺延入 follow-up 队列时 MUST 在 202 响应回报
   `deferredTargets:[{participantId,reason:"deferred"}]`（**MUST NOT** 计入 `failedTargets`），
   且唤醒 MUST 以**返回值**（`deferred`）结束而非抛异常 —— 准入拒绝若以异常穿过 REQUIRED 事务边界，
   会把调用方共享事务标成 rollback-only，导致 deferred 入队与 `wake_dispatch` 审计一起回滚
   （`UnexpectedRollbackException`）。审计 MUST 保留 `outcome=deferred`，INFO 级 `event=to_target_deferred` 留痕。
6. **幂等身份含集合**：排序后的 TO 集合与 `asParticipantId` MUST 进入 `Idempotency-Key` 的
   request hash（同内容不同收件人 MUST NOT 判为重复）；`cc` 仍不入哈希（notify-only）。

### 点名解析：代码段内的 `@` 不是投递意图（task-21，2026-11-19）

> 来源：task-21 真机读数（2026-11-19）。同一份 `MentionParser.parse` 同时供两条路径：assistant 正文的**开链入口**（`WakeChainService`）与消息 `delivery.unresolved` 的**投影**（`ChatSubmissionService`）。agent 回复会贴代码，代码里的 `@click="toTop"` 曾同时被投影成红色「未识别」chip，并且——若代码里恰好写的是真实成员名——会真的开出一条 mention chain。

1. **代码即非发言**：解析前 MUST 先按 Markdown 屏蔽代码区——fenced code block（连续三个及以上反引号或波浪号，行首至多 3 个空格缩进，可带 info string）与行内 code span（反引号 run 长度 N 需由同长度 N 闭合）。代码区内的 `@` MUST NOT 解析为 mention、MUST NOT 计入 `unresolvedTokens`、MUST NOT 参与 `@all` 判定、MUST NOT 开 wake chain。
2. **单一解析入口不变**：开链与投递投影 MUST 继续共用同一份解析结果；MUST NOT 为实现「忽略代码」再写第二份解析/投影实现（理由同 `ChatControllerTest` 的投影 javadoc：第二份实现等于允许两条路径对「什么算未送达」各说各话）。
3. **不扩契约**：`messages.delivery.unresolved` 键、`wake_dispatch` 信封与 `reason` 词表 MUST 保持不变；本条款只收窄「什么算一次点名」，不新增字段、事件名或路由。
4. **已知不覆盖（不得假称已覆盖）**：①缩进 4 空格的代码块；②HTML `<code>` / `<pre>`；③表格单元格里的行内代码。围栏未闭合时 MUST 按 CommonMark 语义「直到内容结尾都是代码」处理。上述三类区域内的 `@` 仍按正文解析。
5. **验收证据**：`MentionParserTest`（围栏内 `@click`、行内 code span、围栏内真实成员名、未闭合围栏、波浪号围栏、孤立反引号）、`WakeChainServiceTest#fencedCodeBlockNamingARealParticipantWakesNobody`（不唤醒）、`ChatSubmissionServiceIntegrationTest#fencedCodeNamingARealMemberNeitherProjectsNorWakes`（`delivery` 无 `unresolved` 且 durable `wake_dispatch` 计数为 0）。

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
   按 `chat_runs.agent_principal_id` → 参与者行（`participantIdForPrincipal`）落值；run 无主体或映射不到
   ⇒ MUST 保持 NULL（MUST NOT 回落会话级字段，MUST NOT 猜 PRIMARY —— 错误归属比没有归属更糟）。
   （PLAN-0689：`sessions.agent_principal_id` 已删，原「会话级主体」回落链移除。）
3. **用户消息 v1 不归属**：composer 的 `asParticipantId` 是**目标身份**（默认 PRIMARY 是 AGENT），
   MUST NOT 当作作者写入；human 作者归属属 BL-277（需拆 author/target 或加 wire 字段）。
4. **老数据语义**：V121 之前的消息 MUST 保持 NULL、**不回填**；读面 MUST 省略该字段（而非发 null），
   UI MUST 在字段缺失或花名册无该行时**不渲染**徽标（MUST NOT 显示"未知"、MUST NOT 上屏裸 UUID）。
5. **归属与 run 一致**：assistant 消息的 `participant_id` MUST 等于该 run 的 responding participant
   （单测 + 真栈断言；run responder principal 与 participant 行 MUST 同一行）。
6. **契约面**：OpenAPI `SessionMessage.participantId` 可空；fork/复制消息 MUST NOT 复制归属
   （子会话花名册未复制，父 id 会悬空/撞 FK）。

## 派生态 anchor 消息投影（task-1 / D-1846）

> 用户 2026-11-18 裁定：「我认为应该是最开始的时间戳那儿作为状态 link 的消息组件，然后干完活儿回复，就自然会在最新的消息」。
> 设计草案见 [`derived-state-anchor.md`](./derived-state-anchor.md)（v1）；本节点是**落地契约**，实施卡 = task-1。
> UI 实现：`packages/ui/src/features/workspace/chat/derivedAnchors.ts`（投影）、`components/RunAnchorItem.vue`（呈现）、
> `composables/useDerivedAnchors.ts`（读投影接线）、`sessionRoute.ts`（三处入口共用的会话路由形态）。

### A1. 数据来源：投影，不新增事件 / 路由 / 状态词

anchor 是**呈现层投影**，MUST 由既有读面合成；MUST NOT 新增 SSE 事件名、durable 记录、API 路由或 run 状态词
（与 §投递语义 7「不扩契约」同口径）：

| 来源（既有读面） | 提供 |
|---|---|
| `GET /sessions/{id}/derived-state` → `activeChildren[]` / `terminalNotices[]` | `runId`、`childSessionId`、状态、`terminalAt`、`name` |
| `GET /sessions`（`SessionSummary`：`kind=SPAWN` / `spawnedFromSessionId` / `spawnedAt`） | 时间锚 `startedAt`、子会话标题、`agentPrincipalId` |
| `GET /workspaces/{id}/agents`（既有名册） | `agentPrincipalId → name`（主体显示名；不可得时退化为 run 短码，MUST NOT 上屏 UUID） |

`startedAt` MUST 取子会话的 `spawnedAt`（缺失回落 `createdAt`）；MUST NOT 取「当前时间」或「最新消息时间」。

### A2. 时间锚不可变、状态就地更新（用户核心要求）

1. anchor 身份 MUST 是 (`runId` ∨ `childSessionId`) 复合键；状态变化 MUST 是**同一 anchor 的重绘**，
   MUST NOT 追加第二条 anchor。
2. 状态刷新 MUST 复用既有事件链（SSE `derived_state_changed` / `spawn_agent` 工具调用 ⇒ 父会话 derived-state
   重读）；MUST NOT 为 anchor 新增轮询或定时器。
3. 子 run 的终态回复 MUST 仍走既有 terminal 消息路径（assistant 消息），因此自然落在流末尾 ——
   anchor 不承担「回复」职能。
4. 刷新页面/重进会话后 anchor MUST 仍落在同一位置：位置只由 durable `startedAt` 决定，MUST NOT 依赖前端内存。

### A3. 状态语义单解析器（N10）

1. derived-state 的**两套词表**（`activeChildren[].status` 7 值、`terminalNotices[].state` 5 值）MUST 先归一到
   `ChatRunResponse.status` 的 12 值冻结词表（`runStateView.ts#runStatusOfDerivedChild`），再由同模块取
   tier / label；组件 MUST NOT 自写 `status === "..."` 判定。
2. 映射是**函数**、不是新增词表：`terminalNotices.state` 的 `success`/`error` MUST 映射为 `succeeded`/`failed`，
   `partial`/`ambiguous`/`cancelled` 同名；7 个 active 值本身已是 wire 状态，MUST 原样使用。
3. 缺失/未知状态 MUST 呈现为「无状态」（不显示 label、不猜 `running`），与「不可见 ≠ 无变化」同源。

### A4. 呈现与排序

1. anchor MUST 与消息共用同一条时间线，按 `startedAt` 插入；MUST NOT 单开区块、MUST NOT 恒定置顶/置底。
2. 插入点 MUST 落在 run 分组边界（不得把某个 run 的组头与其消息切开）。
3. 同一时刻多条 anchor MUST 可区分主体：**主体显示名**优先，名称不可得时用 run 短码；MUST NOT 只靠时间戳区分。
4. 状态文案 MUST 复用既有 i18n key（`chat.derivedStateStatus.*` / `chat.derivedStateOutcome.*` /
   `chat.runState.*`）；耗时 MUST 复用 `runView.ts#formatRunDuration` —— **在途不显示耗时**
   （该模块既有裁定：不引入每秒定时器重渲染）。
5. 数量上限 MUST 显式：默认 24（`DelegationPolicyValidator` 8×3 最坏情况）；超限 MUST 显式告知
   （保留最近 N 条），MUST NOT 静默丢弃。

### A5. 点击导航

1. 点击 anchor MUST 切到该 anchor 所属**子会话**：`Session.id == childSessionId`，路由形态 = 既有
   `{ name: "workspace-chat", params: { sessionId } }`（与 steer 深链同一入口）。
2. **与 DAG 面板的关系（决议，替代草案 O2）**：两者**并存、职责分开** —— anchor 是时间线视角，DAG 是结构视角；
   DAG 节点 MUST 同样可点击，跳转语义与 anchor 一致。MUST NOT 把 DAG 降级为 anchor 的补充视图，
   MUST NOT 让 anchor 复刻树形（同层两个视角，无环）。
3. 目标会话不可达（已删/跨工作区）时 MUST NOT 伪造成功：沿用既有导航错误处置，不静默。

### A6. 边界（不做什么）

- **不覆盖同会话 run**：TO fan-out 产生的多个 run 与单 run 都在同一会话内，对话流的 run 头
  （`RunGroupHeader`）已经「锚在该 run 起点 + 就地更新状态」；再给它们各加一条 anchor 等于同一事实两套机制。
  ⇒ anchor 只覆盖**本线程看不见的派生 run（`kind=SPAWN` 子会话）**。该口径解决草案 O1。
  可执行判据（N1 的现行形态）：同会话 fan-out 两主体 ⇒ 两个 run 头各自锚在自己 run 的起点；子会话
  ⇒ 一条 anchor 锚在子会话 `spawnedAt`，两者都 MUST NOT 挂到流末尾。
- 不新增 SSE 事件名、durable 事件、API 路由、run 状态词、图库依赖。
- 不属于 MVP⑤ 收口判定：MVP⑤ 已三面全绿收口，本节点是独立增量。

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

## 读面可见性（PLAN-0668）

> 本计划把"谁能读会话"从两套漂移的判定收敛为一个 primitive（`SessionReadAccess`）。
> 以下为**断言**；实现与真栈证据见 PLAN-0668 `design.md` §D1–D5 与 `evidence/m3-read-face.md`。

1. **内容读面 = owner ∨ 受邀 HUMAN**：`GET /sessions/{id}`、`GET /sessions/{id}/messages`、
   `GET /sessions/{id}/derived-state`、`GET /sessions`（列表）MUST 仅对 **Session owner** 或
   **未 disabled 的 HUMAN participant** 可见。
2. **管理者不获得内容读**：`MANAGE_WORKSPACE_AGENTS`（workspace scope）与
   `MANAGE_WORKSPACE_MEMBERS`（instance scope）MUST NOT 单独构成内容读授权；管理者保留既有
   **名册**读面（owner ∨ 受邀 ∨ manager）。
3. **错误形状按面冻结**：内容读面不可见 MUST `404 SESSION_NOT_FOUND`（不区分"不存在/无权"，
   防存在性 oracle）；名册不可见 MUST `403 SESSION_ACCESS_DENIED`；跨 Workspace MUST 404；
   未认证 MUST 401；workspace 非成员 MUST 403 `WORKSPACE_FORBIDDEN`。
4. **写面不随读面放宽**：`requireCurrent` / `requireOwned` MUST 保持 owner-only；会话写路径
   （dispatch、fork、delegation、MCP、scheduled 等）不得因读面放宽而接受受邀参与者。
5. **投影契约**：列表投影 MUST 使用 `SessionSummary`（`required` 含
   `kind/spawnedFromSessionId/spawnedAt`）；单会话 `Session` MUST 声明同一 lineage（optional）。
   UI 投影 MUST 保留 OpenAPI `required` 字段；列表缺字段逐行丢弃 + WARN，单条读抛 typed error。
## 承接与验证

- Session 固定 Workspace 与跨 Session 延续：PLAN-0348。条款 1–2（固定绑定、不 rebind）已负向验证：CP 跨 Workspace 作用域拒绝（404）+ Agent 跨 workspace `fail-closed`；跨 Session 延续入口**未实施**（退 backlog）。证据见 PLAN-0348 `evidence/`。
- 投递语义（人=通知 / 通知≠发言权 / 单参与者失败不中断整轮）：PLAN-0660（「投递语义」节条款 1–7）。验收：单测 `WakeDispatchServiceTest`/`WakeFanOutServiceTest`、真栈 `R1-b`/`R1-c`、`V1`–`V7`；证据见该 PLAN `evidence/m1-notify-decoupled.md`、`m2-transaction-and-trace.md`、`m3-gate.md`、`m4-real-stack.md`。
- Agent principal Workspace scope：PLAN-0374。
- 当前实现对账：PLAN-0387 `evidence/current-state.md`。
- 真实 delete/recovery/SSE 验证：PLAN-0387 V7，尚未完成。

### 消息读面分页（PLAN-0670 M2，proposed）

1. `GET /api/v1/sessions/{sessionId}/messages` MUST 支持游标分页：`?limit=`（默认 50，上限 200；
   超上限截断到 200 并在响应回显实际值，**不得**静默返回全集）与 `?before=`（**不透明**游标，客户端 MUST NOT 解析）。
2. 游标 MUST 基于复合 `(created_at, id)`：单时间戳键在批量写入同毫秒时会跳过或重复消息。
   返回消息 MUST 按 `(created_at, id)` 正序；`nextCursor` 取本次窗口**最旧**一条的边界。
3. 响应 MUST 提供 `truncated`（还有更旧消息）与 `nextCursor`（无更旧时**省略**，不得为空串）；
   旧客户端（不带 `limit`/`before`）MUST 保持既有"返回全部可见消息的数组"契约不变。
4. 分页 MUST **在可见性过滤之后**计数（内部 wake 消息、branch path 之外的消息不占页大小），
   且 MUST 使用游标而非 OFFSET（深分页禁止）。
