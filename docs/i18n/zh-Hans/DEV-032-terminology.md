---
title: DEV-032 - 术语规范（一词多义与多词一义）
category: dev-guide
sidebar_order: 32
lang: zh-Hans
sidebar_group: "开发指南"
status: active
created: 2026-09-16
updated: 2026-10-25
---

# DEV-032: 术语规范（一词多义与多词一义）

> **定位**：XH 文档与未实施 PLAN 的**用词 SSOT**。解决两类问题：① 同一裸词多义 → **分义正名**；② 同一概念多词 → **单正名 + 别名表**。
> **适用**：`plans/PLAN-*-XH-*`（草稿与未开工包优先；已完成包仅在被再次编辑时对齐）、`A03-xihe/docs/`、根级 `spec/`（PLAN-0426 扩展）、项目 `AGENTS.md` 叙述。归档与 review 历史记录**不回写**。
> **不适用**：OpenAPI 路径字面、已合并且行为锁死的代码标识符（改名走独立 PLAN）。

## 0. 总规则

1. **裸词禁止歧义**：下列「一词多义」表中的词，**禁止无前缀单独使用**指向非正名义项。
2. **一概念一正名**：叙述与新任务标题用**正名**；别名可括注一次，不得当第二正名扩散。
3. **ID 不改**：`M-2`/`M-3`/`CTX-1`/`P0-5` 等 backlog ID 保留；ID 旁可附正名。
4. **中英成对**：中文行话与英文正名成对出现一次（见 §2），避免只写「收口」不说明 seam。
5. 新 PLAN README 建议加一行：`> 术语按 DEV-032。`

## 1. 一词多义 → 分义正名

| 冲突裸词 | 义项 | **正名（必须用这个）** | 禁止写法 | 备注 |
|---|---|---|---|---|
| **owner** | A. workspace **权限角色**（成员 owner/admin） | `workspace 角色 owner` 或 `角色=owner` | 裸 `owner` 指操作锁持有者 | 与 RBAC 一致 |
| | B. 生命周期 **工作区操作锁持有者** | **`workspace operation lock holder`**（中文：**工作区生命周期操作锁持有者**） | 裸 `owner`、`active owner` 无操作锁上下文；`execution lease holder`（旧名） | PLAN-0474；Runtime materialization 与显式删除的进程内互斥 |
| | C. **资源归属**（连接、工作区、会话挂在谁名下） | **`资源归属 owner`**（英文：*resource owner*；字段写 `owner_type` / `owner_id`） | 用裸 `owner` 指归属；把归属与「workspace 角色 owner」混用 | 连接归属 ≠ 成员角色；目标态 `owner_type` 可含 `AGENT`（见 §1.1） |
| | D. **实例所有权**（这台实例归哪个 ADMIN 管，单例可转移） | **`实例 owner`**（英文：*instance owner*；表 `instance_owner`、字段 `owner_user_id`） | 裸 `owner`；`超级管理员` / `SUPER_ADMIN`（不存在此角色） | PLAN-0580；能力集合与所有权基数分开：owner **不是**第三种平台角色，仍是 `ADMIN` |
| **tv** | access token epoch（签发时抄下的 `users.token_version`） | **`token 代次`**（英文：*access-token epoch*；claim 名固定 `tv`） | 与 JWT `iat`/`exp` 混用；把 `token_version` 说成「密码版本」 | PLAN-0580 §4.1；角色变更使其 +1，旧 token 下一次请求即 401 |
| **role** | A. 平台身份 | **`平台角色`**（*platform role*，值 `ADMIN` / `USER`，来自 JWT `role` claim） | 裸 `role` 指 workspace 角色 | 判定入口 `@PreAuthorize`；见 §1.1 |
| | B. workspace 内身份 | **`workspace 角色`**（值 `OWNER` / `MEMBER`；`ADMIN` / `VIEWER` 为悬空枚举值，未落库） | 裸 `role` 指平台角色 | 见 §1.1 与 backlog「身份与权限模型」 |
| **L1 / L2 / L3** | 上下文注入槽 L0–L3 | **`context L1`**（中文：**上下文 L1 槽**） | 裸 `L1` | 0340 模型 |
| | 诊断分层 L0/L1/L2 | **`diagnostic L0` / `diagnostic L1` / `diagnostic L2`**（中文：**诊断 L0/L1/L2**） | 裸 `L1` | 0342；L1 工具族后置 |
| | checkpoint 恢复层 L1/L2/L3 | **`checkpoint L1`** 等（中文：**检查点 L1 层**） | 裸 `L1` | 0338 |
| **resume** | A. 会话 / ChatRun 恢复 | **`run resume`**（中文：**run 恢复**） | 裸 `resume` 指 unpause | 既有 chat 语义 |
| | B. 工作区从 `paused` 回到可用 | **`unpause`**（中文：**解除暂停**） | 裸 `resume` 指 workspace；`恢复消费者` 作唯一正名 | 见 §2 unpause 路径 |
| **scope** | A. Job 的存活边界 | **`job scope`**（值 `run/session/workspace`） | 裸 `scope` 指策略层 | 0390；canonical identity is domain `jobId` (`workspace_jobs.id`), backend handle is `runtimeJobId` |
| | B. 策略/工具面的作用层 | **`policy scope`**（`instance/workspace/user`；tool-face 另有 `builtin`） | 裸 `scope` 指 Job | 0328 |
| **账本 / ledger** | A. 已退役的 Operation Ledger（`ledger_operations` 系，V56 退役） | **`Operation Ledger（已退役）`**（中文：**操作账本（已退役）**） | 裸「账本 / ledger」指现行机制；把退役谱系写成现行事实 | PLAN-0464/0467/0486 | 
| | B. 现行 `DiagnosticsLedger`（进程内诊断项跨反馈轮去重） | **`DiagnosticsLedger`**（中文：**诊断去重账本**）；引用其约定时写明「进程内、非权威、淘汰只损失检测」 | 把 `DiagnosticsLedger` 表述为 durable 账本或权威记录 | PLAN-0342 | 
| | C. 泛指任何新的运行态记录结构 | **禁止**：先过概念膨胀门（既有概念/原生机制能否表达）再命名；观察窗口等新结构的正名为 **`observation window`（观察窗口）** | 用「账本 / ledger」命名新结构（如 PLAN-0493 观察窗口） | PLAN-0493 T4.2 正名 |
| **interrupted** | Job 因 Runtime 重启或派发未确认落定的终态 | **`job interrupted`** | 与 run `ambiguous` 混用；称「已恢复/已重放」 | 0390；不自动重放 |
| **runtimeBootId** | Runtime 单进程 boot 标识 | **`runtimeBootId`** | 当作业务 identity | 0390；变化即把未确认 Job 判 `interrupted` |
| **job** | 现行后台任务 | **`durable job`**（中文：**持久后台任务**） | 混指已删表 | 0344 |
| | 历史表 | **`runtime_jobs`（历史，已删除）** | 当作现行 job | 0326 已删 |
| **snapshot** | 现行写前恢复点 | **`checkpoint`**（中文：**检查点**） | 活动文档用 `snapshot` 表恢复点 | 0356/0357 已切换 |
| | 遗留机制 | **`legacy snapshot`**（仅历史/退役叙述） | 与 checkpoint 混用 | 0357 |
| **收敛 vs 收口** | 多路径 → 单一权威状态/写路径 | **收敛（converge）** | 用「收口」指状态机双路径合并 | Registry/状态机 |
| | 散入口 → 唯一 seam 出口 | **收口（route-to-seam）** | 用「收敛」指 REST 改走 executor | REST 文件面 |
| **projection / 投影** | A. CP durable 权威记录 | **`<域> durable 记录`**（Job durable 记录（Job 事实源）、checkpoint 切片记录） | 用 projection/投影指称 A；把 B 称为事实源 | 0426；不可重建，删除即失真 |
| | B. CP 可重建读模型 | **`Context projection`**（首现注：CP 由 `context_events` 重建、非事实源、不触发执行） | 裸「投影/projection」；`ContextProjectionService`/`context_projections` 表列为标识符不改 | 0426；`checkpoint projection` 退役 → checkpoint 切片记录 |
| | C. API 响应数据形状 | **`<对象> 响应`／`<对象> 响应视图`** | `<对象> projection` | 0426 |
| | D. UI 本地展示状态 | **`UI 本地视图`**（非权威） | UI projection、内存投影、store projection | 0426 |
| | E. 状态/字段转换 | **`状态映射`／`字段映射`** | 投影折回、能力投影、路由投影、投影状态 | 0426 |
| | F1. 长度/时间截断呈现 | **`有界预览`** | 有界原文投影 | 0426 |
| | F2. 权限/字段裁剪呈现 | **`安全摘要`** | 安全投影、redacted projection | 0426；F1 与 F2 可叠加，非互斥 |
| **凭据 / credential** | A. provider 连接或 MCP OAuth 自带的密文材料 | `provider 凭据` / `OAuth 凭据` | 裸「凭据」指 B | 随连接 CRUD；`provider-api-types.md` §Credential Boundary |
| | B. 凭据管理器登记的独立对象（`credentials` 表） | **`credential 对象`（凭据对象）** | 与 A 混用；笼统写「用户的凭据」 | 0495；owner 两级（USER/WORKSPACE）、lease/reveal 单通道交付；`spec/security/credential-management.md` |
| **轮换 / rotation** | A. MCP session-id 签名密钥更替 | `签名密钥轮换`（MCP session-id） | 裸「轮换」指 B | DEV-016 |
| | B. credential 域主密钥更替（key ring） | **`credential 主密钥轮换`（key ring rotation）** | 与 A 混用 | 0495；两阶段 + CAS + 按 key_version 列计数（退役校验） |
| **attempt** | A. MCP 执行域的工具尝试 | **`tool attempt`**（表 **`mcp_attempts`**，`V50__mcp_execution_domain.sql:46`；Java 侧 `McpAttemptRepository`） | 裸 `attempt` 指传输尝试；**不要把 `operation_attempts`（V2 跨模块旧账本）当工具尝试表**；也不存在 `agent_tool_attempts` 这个名字（2026-11-02 标识对账实测 0 命中） | 0464 执行域 |
| | B. provider HTTP 传输尝试（单次 LLM HTTP dispatch） | **`transport attempt`（传输尝试）**；表 `chat_run_transport_attempts`，正名事件 `transport_progress`/`transport_attempt` | 与 tool attempt 混用；称「请求记录/HTTP 调用记录」 | 0508；outcome `success/error/timeout/aborted/partial`；阶段 `attempt_started/first_chunk/streaming/attempt_finished` |

### 1.1 主体与角色（2026-09-17 增补）

XH 目标形态是**多主体协作**：Agent 是独立主体（有自己的账户与角色权限），与开发者**协作**，**不绑定某个 user**。**协作 ≠ 委托**——「Agent 代表某 user 执行」不是目标模型；若确需受托，另立显式 *delegation* 概念。

该段描述的是目标模型。当前 user-only schema 与独立 Agent principal 仍存在实现差距，认证、principal、授权、能力策略、审批和审计的统一契约见根级 `spec/security/`（PLAN-0386，当前为 proposed）。

| 术语 | 正名 | 取值 / 说明 | 禁止写法 |
|---|---|---|---|
| 主体 | **principal** | `human`（开发者/用户）、`agent`（独立账户与角色）、`service`（CP/Agent/Runtime 内部管道，非协作者）；`system` = 平台自身触发，非可登录主体 | 把 Agent 说成「代表 user 的 actor」；用 `user` 泛指 principal |
| 成员 | **membership** | `principal × workspace + 角色`；Agent 与开发者同为 workspace 成员。**实现层（2026-11-02 对账）**：没有独立成员表——载体是 `role_bindings`（`entity/AccessRoleBinding.java:13,25`，role × subject × scope，角色值 `WS_OWNER`/`WS_EDITOR`/`WS_VIEWER`）；`workspace_users` 已由 V89 删除，`policy/WorkspaceMembershipService.java:42,52` 只是角色投影 | 把成员表/字段永久写死为 `user_id`；也不要去找不存在的 `memberships` 表 |
| 角色 | **平台角色 / workspace 角色** | 见 §1 `role` 两义 | 裸 `role` 不带域 |
| 归属 | **资源归属 owner** | `(owner_type, owner_id)`；目标态可含 `AGENT` | 与「workspace 角色 owner」「工作区生命周期操作锁持有者」混用 |

历史形态（不阻碍目标，但新代码不得加深）：`sessions.user_id`、`workspace_users.user_id`、`provider_connections.owner_id` 均为 user-only 形态；`ledger_operations.actor_type`（表名历史形态 `session_operations`，V33 改名）已含 `agent`（`V2`），方向一致。

#### 1.1a 主体细分、会话成员与策略（PLAN-0622 增补）

> 本节**扩充**上面的「主体 / 成员」两行，不新立概念域。**英文/代码标识是下游代码与 CLI 的唯一取词来源**：中文只作正文叙述，不得在代码、CLI、字段名里另造译名。

| 术语（中文） | 英文 / 代码标识 | 一句话定义 | **反例：不要用它指什么** |
|---|---|---|---|
| **agent（智能体）** | `agent`（zh 正名：**智能体**；标识符与英文永不翻译） | XH 里承担工作 / 被授权的 software actor 总称；落到具体语境**必须**用下面的派生词，不裸用 | 中文禁止写成「代理」「AI 成员」「智能助手」——「代理」在 XH 指 HTTP 代理 / 委托义，混用即歧义；不要为 UI 另造同义词 |
| **智能体主体** | `agent principal`（表 `agent_principals`；CLI `xihe agent …`；body 字段 `agentPrincipalId`） | 独立的、可被授权的主体：有自己的 grants 与 cap，可绑到多个 Workspace、被多个 Session 使用，**不隶属某个 user**（`created_by_user_id` 只记铸造者） | 不要指「一次 spawn 出来的运行实例」、不要指「agent 模板（`agent-templates`）」、不要说成「代表某 user 的 actor」；也不要写成「Agent 账号 = user 账号的一种」（principal 类型是并列的 `agent`/`human`/`service`）；**主体被禁用/停用 ≠ 进程崩了**（见「智能体运行时」） |
| **智能体运行时** | `agent runtime`（Python 包 `packages/agent`；日志模块名 `moduleAgent`） | 跑编排 / 工具调用的**进程组件** | **与「智能体主体」是两个词**：主体被禁用、被移出会话、授权失败，运行时进程都照常活着；反过来进程在 ≠ 主体可用。不要说「Agent 挂了」指主体被禁；不要用「重启智能体」指重新启用主体 |
| **智能体管理** | `agent management`（UI 面 `agentManagement`，zh 文案「智能体管理」） | 管理某范围内 agent principal（创建/绑定/cap/禁用）的界面与 API 面 | 不是新能力：它是「智能体主体」的管理面；「管理」≠「代发」（管理权限是 `MANAGE_WORKSPACE_AGENTS`，代发是 `speakAs`，两者独立，D23-08） |
| **用户主体** | `human principal`（表 `users`；JWT `role=USER|ADMIN`；**代码侧无 `humanPrincipal` 类**——人类主体就是 JWT 认证的 `users` 行，主体类型由 `role_bindings.subject_type` 表达，见对账） | 有登录凭据的人类账号，是三类可授权主体之一 | 不要用它指「Workspace 成员」（那是 `membership`：principal × workspace）；不要以为 Agent 路径读 `user_id`（Agent 授权不看 `user_id`）；不要 grep 一个不存在的 `humanPrincipal` 类型 |
| **服务主体** | `service principal`（canonical 能力 **`CAP_INTERNAL_SERVICE`**，`policy/CapabilityAuthorities.java:42-44`；`ROLE_INTERNAL_SERVICE` 是 **legacy 别名** `LEGACY_ROLE_INTERNAL_SERVICE`，同文件 `:47`、`:18-22` 注明 "compatibility authorities only"；入口 `/internal/v1/**`） | CP/Agent/Runtime 之间的内部管道身份：不是协作者、不可登录、不产生用户可见行为 | 不要指「Agent 主体」（Agent 走 principal grants ∩ binding cap）；不要把 service token 当「超级 user」；不要用它承载任何用户语义；**不要把 `ROLE_INTERNAL_SERVICE` 当 canonical**（那只是兼容层，新代码判 `CAP_INTERNAL_SERVICE`） |
| **会话成员** | `session participant`（表 **`session_participants`**，`V92__session_participants.sql:50`；多态 `principalKind`(`HUMAN`/`AGENT`) + `principalId`，**无 FK**（沿用 `role_bindings` 先例） | 一个主体在某次会话里的参与关系：**同一 principal 可在不同会话有不同角色与策略**；一个会话可有多个 participant | 不要与 Workspace `membership`（principal × workspace）混用，也不要把「成员」当它的别名；**不要裸写 `participant`**（Mermaid 序列图关键字同名，属另一个语境）；不要指「Session owner」（`sessions.user_id` 只是归属/可见性） |
| **唤醒策略** | `wake policy`（字段 `wakePolicy`；枚举 **`ALL_MESSAGES`** / **`MENTION`**，默认 `MENTION`） | 该会话成员在**什么事件下被唤起**（每条消息 / 仅被 @ 时）；**看得见 ≠ 会被唤醒** | 不要用「可见性/权限」解释唤醒（那是 scope/membership/cap）；不要与**回应策略**互换；不要把它当「通知设置」；不要写 `ALL`/`EVERY` 等别名（枚举大小写与值固定） |
| **回应策略** | `respond policy`（字段 `respondPolicy`；枚举 **`ALWAYS`** / **`WHEN_MENTIONED`** / **`JUDGE`** / **`MUTED`**，默认 `WHEN_MENTIONED`；`JUDGE` 为 0624 预留、`MUTED` 是 0623 静音开关） | 被唤醒后**是否/如何发言**（总是答 / 被点名才答 / 静音），与能力上限独立 | 不要指「能不能看到消息」（那是唤醒/可见性）；不要当成 cap 的一部分（**cap 决定允许什么，policy 决定主动做什么**）；不要写成「人格/persona」；不要自造 MENTIONED_ONLY 之类的值（枚举只有那四个） |
| **守卫** | `guard agent`（代码标识以 CP 轨道定稿为准；本地写作 `guard_agent`） | **预制的 agent 主体**（system preset）：cap 只读、可发言，裁决**进入 approval 流程**，不是用户可编辑的人设 | 不要指既有的「路径守卫 / HardGuard L0 守卫条件 / 授权守卫」（§1 与 DEV-014 大量使用该义）；不要指 workspace 角色里的「守护者」；不要造「守护者 / 门卫 / 看门人」等同义词 |
| **主体共享范围** | `principal scope`（`agent_principals.scope`，值 **`PERSONAL` / `WORKSPACE` / `INSTANCE`**） | 描述**"这是谁的主体、给谁用"**的三档归属标注；**不是** principal 自带的授权范围（BL-29「绑定式 scope」） | 不要写成「principal 自带 scope/权限范围」——有效范围来自**绑定**（`workspace_agents`）∩ grants；不要与 authorization scope、OAuth/provider scope 混用；不要新增第四档或别名（如 `PRIVATE`/`GLOBAL`）；**UI 文案必须与连接 scope 区分**——现有 `scopeUserTitle: "Personal"` / `scopeWorkspaceTitle: "Workspace shared"`（`packages/ui/src/i18n/index.ts:3065-3068`）说的是**连接** scope，agent scope 若要上 UI 必须带 `agent` 限定（现写作「个人智能体 / 工作区智能体 / 实例智能体」，既满足限定又用正名），并另建 `agentScope*` 文案键与 testid，不得复用连接 scope 的键 |

| **主对话主体** | `PRIMARY participant`（`role=PRIMARY`；部分唯一索引 `uq_session_participants_primary`，每会话**唯一**） | 会话里默认的对话对象：随会话创建**自动播种**（含游标），**不可移除、不可转让** | 不要与 `membership` 的 OWNER 混用（D23-02 明确会话角色永不用 OWNER）；不要说「会话所有者」；不要说「可以把 PRIMARY 转让给另一个参与者」 |
| **普通成员 / 守卫** | `MEMBER` / `GUARD`（`role` 枚举，约束 `ck_session_participants_role`） | 0623 内两者**同面**：都可被 @、策略可改、可移除；GUARD 的**特有约束留 0625**（D23-24） | 不要在 0623 里声称 GUARD 有特殊权限或特殊能力；不要新增第四种会话角色（如 OWNER / OBSERVER） |
| **参与者游标** | `participant cursor`（表 `session_participant_cursors`；`lastReadEventSeq` / `mentionCount`） | 服务端持有的已读位置：**指针不是计数器**（计数可由 `context_events` 重算），客户端不累计；无游标行时 API 返回 `readCursor=null` | 不要把客户端本地已读当真相；不要用「未读条数」代替指针；不要在没有游标行时返回空对象（约定是 `null`） |
| **软停用** | `soft disable`（`disabledAt`；`DELETE` 或 `PATCH` `disabled=true`） | 移除参与者**只置停用**：行、游标、审计都保留，`GET` 仍返回（带 `disabledAt`）；**不是硬删除**（D23-26） | 不要说「删除参与者/硬删」；不要假设删除后行消失；不要把它与 Workspace 成员移除混为一谈（那是 `role_bindings`） |
| **显示名** | `displayName`（**读时派生、不落库**；无独立 `display_name` 列） | AGENT → `agent_principals.name`；HUMAN → 用户 `name` → `username` → `email` 本地部分；解析不出为 `null` ⇒ UI 显示「未知用户」 | **绝不要用 UUID 当人名**；不要把它当可编辑字段；不要回退到邮箱全串（只取本地部分） |
| **以某参与者身份发言** | `speakAs`（`capabilities`）/ `asParticipantId`（请求）/ `selfOwned`（每行投影） | **代发 ≠ 提及**：代发是以某参与者身份**发出消息**，提及只是把话题指向他（插入 `@名字`）；管理员可加人但**不可代发**（D23-08）；`speakAs` = 至少一行 `selfOwned=true`（同一判定，前端不得自行判定） | 不要把「代发」写成「提及/艾特/转发」；不要以为 `manage`（管理参与者）权限含代发；不要用「切换发言人」指代它（那是 UI 动作，不是授权概念） |
| **观察者视角** | observer view（`GET /api/v1/events` **未带** `asParticipantId`） | 收**全部**参与者的事件流；与之相对是「参与者视角」（只收该参与者） | 不要把多主体流当单主体渲染（D23-28）；不要把它当兼容层/降级路径（它是语义）；不要在观察者视角里伪造「当前发言人」 |
| **run 级归属** | run-level attribution（`chat_runs.agent_principal_id`） | 每条 run 记录**本次回应者**（不是会话级属性）；未带 `asParticipantId` ⇒ PRIMARY 的主体；两者皆无 ⇒ `null` | 不要与会话级 `sessions.agent_principal_id`（会话默认主体）混用；不要因 run 为空就回填成 PRIMARY |
| **参与者来源** | `participant source`（`source` ∈ `workspace` / `personal` / `instance`，**小写**） | 该参与者对应主体的归属来源，读时派生 | 不要与 agent 的 `scope`（**大写** `PERSONAL`/`WORKSPACE`/`INSTANCE`）混用或擅自统一大小写——两处是不同列、不同枚举，改名须 CP 裁定 |

不偏离约束与落地入口：workspace internal `xh-backlog-and-debt.md` 的 BL-18「身份与权限模型」（不入库分发）；2026-09-23 G2 已将 BL-18 冻结入 PLAN-0407 承接（执行中，未完成）。

### 1.2 工作区存储与 checkpoint（2026-10-25 增补）

| 裸词 | 义项 | **正名** | 禁止写法 |
|---|---|---|---|
| **root** | Runtime 进程的存储基目录 | **host root（宿主存储基目录）**；`XIHE_WORKSPACE_HOST_ROOT` 是历史名 | 裸 `root` 指某个 workspace 的目录 |
| | managed workspace 内容目录 | **workspace path**（`<hostRoot>/<storageRef>`） | 把 host root 说成 workspace path |
| | 一个 Workspace 的多个物理根 | **multi-root（多根，BL-94）** | 用“多建几个 Workspace”冒充多根 |
| **storage mode** | XH 管理的副本 | **`managed_import`**（**已冻结，解冻后恢复**：PLAN-0618 起不可用于新建/执行） | 说成“用户自选目录就地打开” |
| | 用户目录就地挂载 | **`direct_attach`** | 说成 host root 的子目录 |
| **reason** | Runtime capture 返回的原因 | **capture reason** | 裸 `reason` 与 gate/durable 混用 |
| | CP `unrollable_reason` 持久化值 | **durable reason** | 把 capture reason 直接当 durable |
| | CP gate（preview/revert/blob/status）判定原因 | **gate reason**（`EXPIRED`/`MISSING`/`DEGRADED`/`TOO_LARGE`） | 把 gate reason 塞进 capture 白名单 |
| **absolute path** | 配置源值 | **source path**（可相对，由 launcher 解析） | 声称配置文件必须写绝对路径 |
| | 注入 Runtime 的进程值 | **resolved host root（绝对）** | 把相对值当正常契约 |
## 2. 多词一义 → 正名与别名

### 2.1 仍存活、待统一（未实施/实施中 PLAN 按正名写）

| 概念 | **正名** | 别名 / 旧说法 | 归属与状态 |
|---|---|---|---|
| 确保执行环境就绪（契约动词） | **`ensure`** | `物化`、`provision`（0329 散文） | 0329/0345；**测试与不变式用 ensure** |
| 同一 workspace 异步就绪的 **HTTP 路径** | **`materialize`（API 名）** | 不可用 ensure 替换 **URL 路径字面** | CP `POST .../materialize`；叙述：「触发 ensure（API：materialize）」 |
| 同 workspace 并发 ensure 合并为一次 | **`ensure single-flight`** | **M-3**（ID）、物化并发去重、并发去重 | 0345；ID `M-3` 保留，正文首现写 `M-3（ensure single-flight）` |
| 裁剪窗口外旧工具输出 | **`prune`** | mask、遮蔽、工具结果截断、`HISTORY_TRUNCATION` 职责 | 0341 归一中；20 条=装配层熔断，不叫 prune |
| 溢出后的规则分节摘要 + 一次重跑 | **`compaction`（压缩）** | 自动摘要、收缩（广义可含 prune） | 0341；**收缩**= prune∪compaction 的总称时需写明 |
| 使 `paused` 回到可用的代码路径 | **`unpause 激活路径`** | 恢复消费者、resume 消费者、resume consumer | 0345 M-2；「有 unpause 激活路径」替代「有恢复消费者」作验收句 |
| 绕过 executor 直连磁盘 | **`executor-bypass`** | host FS 直连、裸 bypass | 0329 分类；叙述可用「executor-bypass（REST 直连 host FS）」 |
| 后台任务断线后续看 | **`durable job 续看`** | 输出持久化续看、job resume | 0344 |
| transport attempt 的有界阶段观测（`last_progress_stage/last_progress_elapsed_ms`） | **`阶段样本`（stage sample）** | 进度快照、latest progress、前溯 elapsed | 0508；静态 last-observed 展示，禁止任何时钟外推（跨进程墙钟纪律） |

### 2.2 已完成切换（活动文档只保留正名）

| 概念 | **正名** | 已废弃别名 | 依据 |
|---|---|---|---|
| 写前恢复点 | **checkpoint** | `revert_snapshot`、活动代码里的 snapshot 恢复点 | PLAN-0356 |
| 旧快照面 | **legacy snapshot**（仅退役叙述） | 与 checkpoint 混称 | PLAN-0357 |

### 2.3 易混但**不是**同义（禁止合并）

| 词 A | 词 B | 关系 |
|---|---|---|
| 单写者 ledger（0326） | ensure single-flight（M-3） | 账本单写 vs 实体只建一次 |
| ensure single-flight | chat `409 CHAT_IN_PROGRESS` | 沙盒就绪 vs 会话并发 run 上限（PLAN-0645 起为 `maxConcurrentRunsPerSession`，默认 2，cap 满才 409；设回 1 恢复单飞） |
| 工作区生命周期操作锁持有者 | **workspace operation lock holder** | `execution lease holder`（旧名）vs workspace 角色 owner；Runtime 互斥操作 vs RBAC 角色 |
| run resume | unpause | 会话恢复 vs 容器解除暂停 |
| **durable job 续看** | **Workspace `unpause` / `run resume`** | 读既有 Job 输出（`job-output`，只读游标）vs 重新激活执行；禁止把续看说成恢复/unpause |
| **job `interrupted`** | **run `ambiguous`** | Job 因 Runtime 重启判死且不重放 vs run 终态未定、待人工确认 |
| 收敛 | 收口 | 见 §1 两行 |

## 3. 推荐搭配（中英）

| 场景 | 推荐整句骨架 |
|---|---|
| 生命周期 | 「Runtime 经 **ensure** 保证执行环境就绪；CP 对外路径名 **materialize**。」 |
| 并发 | 「同 workspace **ensure single-flight（M-3）**，仅一次实体创建。」 |
| 操作锁 | 「ensure materialization 与显式删除共用 **workspace operation lock**；destroy 完成后操作锁守卫释放。」 |
| 暂停 | 「`paused` 须存在 **unpause 激活路径**，禁止无文档重建。」 |
| REST | 「REST 文件面 **收口到 executor**，消除 **executor-bypass**。」 |
| 上下文 | 「**context L1 槽** 注入；**diagnostic L1** 后置。」 |

## 4. 实施与追溯

| 阶段 | 动作 |
|---|---|
| 本文档发布（2026-09-16） | 未实施 XH PLAN README/spec 按 §1–§3 对齐；完成包不强制回写 |
| 2026-09-17 增补 | 新增 §1.1（principal / membership / 协作≠委托）、`owner` 第三义（资源归属）、`role` 分域；未实施 PLAN 与 docs 按新正名；实现归 backlog BL-18（原标注不实施；2026-09-23 G2 冻结入 PLAN-0407 承接，执行中） |
| 2026-09-21 增补 | 新增 `scope` / `interrupted` / `runtimeBootId` 分义；§2.3 明确 **durable job 续看 ≠ Workspace `unpause` / `run resume`**（0390） |
| 2026-09-30 增补（PLAN-0426） | 新增 `projection` 六义分义（A durable 记录 / B 可重建读模型 / C 响应视图 / D UI 本地视图 / E 映射 / F1 有界预览 / F2 安全摘要）；适用范围扩展至根级 `spec/`；裸 `projection`/「投影」叙述禁用，标识符与历史记录除外 |
| 2026-10-10（PLAN-0474） | 将 Runtime 概念正名为“工作区生命周期操作锁 / workspace operation lock”，更新 zh-Hans/en 与 proposed Security/Workspace glossary；不改变授权语义 |
| 2026-11-02 增补（PLAN-0622） | 新增 **§1.1a**：`agent principal` / `human principal` / `service principal` 三类主体细分、`session participant`（区别于 `membership`）、`wake policy` / `respond policy`（看得见 ≠ 会被唤醒）、`guard agent`（预制主体，与既有「路径守卫」义区分）、`principal scope` 三档（BL-29 绑定式 scope）；每条带反例。同步 `spec/agent/principal-workspace-binding.md`（scope 三档 + 三段授权）与 `spec/security/principal-workspace-scope.md`（`CREATE_OWN_AGENT` 原子） |
| 2026-11-02 对账修正（PLAN-0622 M0.3，依据 `evidence/m0-3-term-reconcile.md`） | `service principal` canonical 改 `CAP_INTERNAL_SERVICE`、`ROLE_INTERNAL_SERVICE` 标 legacy 别名；`membership` 补实现注记（`role_bindings` / `workspace_users` 已删 V89 / `WorkspaceMembershipService` 仅投影）；`human principal` 注明代码侧无 `humanPrincipal` 类；`principal scope` 反例补"UI 文案与连接 scope 区分"（`scopeUserTitle`/`scopeWorkspaceTitle` 已被连接 scope 占用） |
| 2026-11-02 补录（PLAN-0623） | §1.1a 补 0623 词条：`PRIMARY participant` / `MEMBER`·`GUARD` / `participant cursor` / `soft disable` / `displayName` / `speakAs`·`asParticipantId`·`selfOwned` / observer view / run-level attribution（`chat_runs.agent_principal_id`）/ `participant source`；并回填既有三行的代码标识（`session_participants` 表、`wakePolicy` 枚举 `ALL_MESSAGES`/`MENTION`、`respondPolicy` 枚举 `ALWAYS`/`WHEN_MENTIONED`/`JUDGE`/`MUTED`，均以 `V92__session_participants.sql` 为准）。**未新增**「提及/@」「群聊」「发言者」「成员」「软删」等同义新词（理由见 §1.1a 各反例） |
| 2026-11-02 正名（用户批准）：agent = 智能体 | §1.1a 顶部新增正名行 `agent = 智能体`（禁「代理」「AI 成员」）；「agent 主体」改「**智能体主体**」并补"主体停用 ≠ 进程崩"；新增「**智能体运行时**」（进程组件，与主体是两个词）与「**智能体管理**」（管理面，管理 ≠ 代发）；`principal scope` 反例的 UI 文案示例同步为「个人智能体 / 工作区智能体 / 实例智能体」；UI zh locale 描述性 "Agent" 全量 sweep 为「智能体」（`packages/ui/src/i18n/index.ts` zh 块 57 处；`AGENTS.md` 文件名、标识符、en 块不动） |
| 已完成 PLAN / archive / review | **不改**历史证据用词；再次编辑该文件时顺带对齐 |
| 代码标识符 | PLAN-0474 将 Runtime 内部 `ExecutionLease` 改为 `WorkspaceOperationLock`；不保留无已知消费者的兼容别名 |

## 5. 关联

- 契约层正名 `ensure`：DEV-031、PLAN-0329
- 工作区生命周期操作锁 / unpause：PLAN-0345 `spec/workspace-lifecycle.md`、PLAN-0474
- Job scope / interrupted / runtimeBootId：`spec/workspace/execution-job.md`、PLAN-0390
- 主体/成员/归属与 Agent 主体化：workspace internal `xh-backlog-and-debt.md` BL-18（不入库分发；承接 PLAN-0407，执行中）
- prune / compaction：PLAN-0341
- checkpoint 命名：PLAN-0356
- 文档布局：DEV-030
