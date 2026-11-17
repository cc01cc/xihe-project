# DSH 五面设计输入：goal / agent team / 任务面板 / 决策记录 / CLI → XH 映射

> 任务卡 task-183 · 2026-11-18 · scout-dsh-feat 产出，交 Lead 审。
> **定位：设计输入，不是实施契约。** 关键产品取舍（分期顺序、UI 形态、CLI 范围）留 Lead/用户裁定。
> 调研对象：DSH desktop 0.2.2-rc.3 实现 checkout（Electron 桌面壳 + 按包发布的实现产物）：
> `C:\Users\zeoneo\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\`
> （下文 `DSH:<pkg>/<file>:L<n>` 均指该根下 `@deepseek-ai\` 包内 `src` 源文件；每个包同时带 `lib/*.js` 编译产物、`README.md` 与 `docs/` 子系统文档）。
> 证据等级：**[源码]** = 读实现源码；**[实测]** = 本会话实际执行观察；**[文档]** = 包内 README/子系统文档；未运行行为一律写「需实测」。
> 全程只读，未改动 DSH checkout 任何文件。

## 0. 总览：DSH 的三层同构（先读这个）

DSH 每个功能面都按同一套三层展开，XH 映射时应逐层对号：

| 层 | DSH 载体 | XH 对应 | 复用度 |
| --- | --- | --- | --- |
| **域层（durable 事实）** | cordis Service + session event（append-only）+ session projection（事件折叠出只读投影） | CP durable 表 + AgentEvent + SSE（`spec/protocol/event-stream.md`） | 事件溯源思想可复用；落地面是 XH 自己的 CP DB |
| **工具层（模型面）** | `dsh-tool-*` 包注册 defineTool + system prompt section | XH agent 包工具注册（Python） | 形状可抄，实现自写 |
| **客户端层（UI 面）** | `dsh-client-ui-*` 包，从 projection 读、经 Remote API 写 | XH ui 包 Pinia store + SSE + REST | 形状可抄 |

两个贯穿性设计决定（五面通用）：

- **一切状态 = session log 事件 + projection 折叠**。goal、team task、todo、subagent catalog 全部如此；UI 读的是投影，写的是带 CAS revision 的 append。这使 resume/fork 后状态可精确重建。[源码]（各包 `projection.ts`）
- **写权限按「谁在哪个驱动轮里」授予**：工具执行时校验「精确 live agent + 当前发起者 + 开启中的 turn 内事件」，不是靠 prompt 自觉。[源码]（goal authority.ts 全套）

---

## 1. Goal（目标 / 续轮 / phase / round 上限 / 自动续跑）

### 1.1 机制 [源码]

**数据模型**（`dsh-goal/src/types.ts`）：

- `GoalRef { id, revision }`（L20）——CAS 身份；每次持久变更 revision+1。
- `GoalPhase = active | paused | blocked | complete`（L45）——**durable 生命周期**，持久在 session log。
- `GoalSnapshot`（L60）= ref + objective + phase + `blockedReason?{code,message}` + `maxGoalRounds`。
- `GoalView`（L90）= snapshot + `roundsStarted` + createdAt/updatedAt + `activation: armed|disarmed`（L72）。
- **关键二分**：durable phase（目标怎么了）与进程内 activation（续跑驱动是否可以开下一轮）分离，activation **永不持久化**。restart/resume 后 activation 一律 disarmed，等人显式 resume 才再武装——防止机器重启后无人监督的自动续跑。
- 投影：`goal` projection key（types.ts L129-136 注册进 SessionProjectionMap），`GoalProjection { goal, roundsStarted, createdAt, updatedAt } | null`。

**持久化与状态机**（`dsh-goal/src/index.ts`、`domain.ts`、`fold.ts`）：

- 每次变更加一条 `goal/change` session 事件（domain.ts L66 事件表），载荷 = **完整后置快照**或 clear 墓碑（domain.ts GoalSnapshotChangeMeta / GoalClearChangeMeta）。纯折叠函数 `applyGoalEvent`（fold.ts L313）重放出当前状态；首个非法事件写入 `failure` 而不是崩溃（index.ts L138 applyGoalProjection）。
- 操作七动词：create/edit/pause/resume/complete/block/clear（domain.ts L14）。
- 转移矩阵（index.ts GoalService）：
  - create：仅当无 goal 或当前 `complete`（complete 可被替换）；否则 GOAL_ALREADY_EXISTS。
  - resume：active+armed 不允许重复 resume；**roundsStarted ≥ maxGoalRounds 时拒绝 resume，要求先 edit 上限**（L365 区域，错误信息明确指出「increase maxGoalRounds before resuming」）。
  - complete：active/paused/blocked → complete，随后 disarm。
  - block：仅 active → blocked，reason 必须 `lower-kebab-case code` + 非空 message（driver 用 `round-limit` 等 code，模型用 `model-reported`）。
  - clear：写墓碑保留历史。
- 所有写入走 session.append 同步边界；activation 的挂起值通过 pendingActivation+offset 与 event.seq 对齐，避免回放竞态（index.ts commit L608 区域）。
- **round 计数来自消息归属**：admitted 的 user/message 带 `source.kind=goal, goalId, revision, round`（domain.ts L47 GoalMessageSource），只有这些事件推进 roundsStarted；折叠时校验 round 正数/连续/revision 匹配/cap 不超。

**自动续跑驱动**（`dsh-goal-round-driver/src/index.ts`，独立插件，可拆装）：

- **round 0**：goal 的 create/edit 变更本身作为一条 `round:0` goal-source 消息进历史（供模型读上下文），不推进计数。
- 每轮 = 一条普通 user message，内容由 `renderGoalRoundPrompt`（prompt.ts L12）渲染：`<goal_round> Objective… Round: n/max …` 块，经 `agent.followup()` 排进 agent inbox。**没有单独的「续跑通道」**——续跑就是排队的人类视角消息，天然享有同一 inbox/steer/abort 机制。
- RoundAttempt 状态机 queued → claimed → admitted（index.ts L30）：claim = inbox 领取，admit = session 事件落盘。
- 驱动条件（drive L146）：fiber active + agent idle + 无竞争排队 + **树内 subagent 全部完工**（waitForTreeWork）+ checkpoint flush 成功。任一失败就放弃本轮。
- 到 cap：自动 block（code `round-limit`，L184）。
- 防竞态重围栏（validReservation L372 + agent/pre-step 钩子 L387）：进入 step 前重新校验「仍是精确 live revision + armed + round = roundsStarted+1」，失败则拒收该轮、恢复其它被认领消息、重新调度。这是「一轮已排队但中间被人 pause/edit/抢占」的兜底。
- 人发起的 pause 若目标在跑：abort 当前 turn（keepInbox）；模型在自家轮内 pause 不中断（goal/changed 监听区分 initiator）。

**工具面**（`dsh-tool-goal/src/index.ts` + authority.ts + wrapup.ts）：

- 三工具：`get_goal`（L196）/ `create_goal`（L208）/ `update_goal`（L235，action = edit/pause/resume/complete/blocked）。
- **权威检查**（authority.ts）：create/edit/pause/resume 要求 `requireDirectHuman`（L99）——当前根 agent 的开启 turn 里必须存在 human source 的 user/message；complete/blocked 放宽为 `completionAuthority`（L110）= 直属人类输入 **或** 恰好是当前 goal 的 admitted round。subagent 会话一律无 goal 权威（L79 hasDirectHumanInput 排除 origin=subagent）。
- **blocked 节流**：goal-round 内报 blocked 需 ≥ N 轮（默认 3，index.ts L39 blockedAfterConsecutiveRounds），防止一轮受挫就弃跑。
- complete/blocked 后注入 `<goal_complete>/<goal_blocked>` wrap-up 上下文（wrapup.ts L17）：要求模型写收尾消息、只报告 session 内实际证实的内容、**禁止再调工具**。
- 模型可见政策文案（index.ts L115 guidance）即本会话 system prompt 里那段（resume/fork 后需人 resume、complete 判据等）。

**人机命令面**（`dsh-command-goal/src/index.ts`）：`/goal [<objective>|clear|edit <objective>|pause|resume]`（注册 L193，解析 L35）。纯文本结果，不暴露 CAS 细节；attachments 只跟 create/edit。

### 1.2 UX [源码]

- **GoalBar**（`dsh-client-ui-goal/src/client/GoalBar.tsx` GoalBar L43 / GoalDock L183）：输入框上方 dock 条——phase 标签 + 截断 objective + 图标动作（edit 内联、clear、pause/resume）。complete/无 goal 不渲染。mutation 走 refAtCallTime 的 CAS RPC（client/index.ts L102 区域），UI 不做 staleness fence，靠 revision 冲突报错兜底；防双击用 pendingRef。
- activation 是 process-local 的，单独走 `goal/activation-changed` 事件订阅（dock 注入 activation hook）；durable 投影 + live activation 合成显示。
- 有 goal 时用户还能以普通消息随时插话（steer），续跑轮在 inbox 里排队等 agent idle。

### 1.3 映射到 XH [源码·XH 侧]

- **可复用面**：
  - durable 事实落 CP：新表（如 `session_goals`）+ CAS revision 语义；XH 的 `chat_runs`/`SessionFollowUpItem` 已有 run 生命周期先例。
  - 续轮通道复用既有 ChatRun dispatch（CP 的 RunDispatchQueue / ChatRunDispatchQueueService）而不是发明第二条队列——goal round 本质就是一条带 goal source 的用户消息。
  - SSE 事件 `goal/changed` 对齐 XH 事件流契约（`spec/protocol/event-stream.md` §事件 ownership 表，须登记 producer=CP/Agent、消费者=UI）。
  - UI：GoalBar 形态落 `packages/ui`（新增 feature 模块；现有 features 只有 org-members/workspace，session 视图已有 chat 基建）。
  - agent 包：工具注册对应 Python 侧 tool registry；权威检查需要 agent 侧拿到「当前 turn 是否含 human 输入」——XH 的 SessionParticipant/participant cursor 结构已区分参与者，可作为 human 判据的原料（需实测确认 participant kind 字段）。
- **需自建（DSH 有而 XH 无）**：round-driver 的 pre-step fence（XH LangGraph runner 的等价物是 graph 入口处校验）；round-0 消息归属（XH 消息表需可空 source kind 字段）。
- **产品取舍留给 Lead**：XH 是否需要「resume 后默认 disarmed」？DSH 这么做是桌面常驻场景的安全选择；XH 若以 Web 会话为主，可讨论「resume 即 armed」+ 每轮间可选人工确认。

### 1.4 分期建议

- **S**：goal durable 模型 + 三工具 + UI 只读条（无续跑）。价值：让用户能命名长期目标、模型能引用；无自治风险。
- **M**：round-driver（自动续跑 + cap + block 节流 + 权威检查）+ pause/resume 全链。
- **L**：多 goal/跨 session goal、goal 模板、失败轮的自动诊断（DSH 也没有——这是超集想法，仅供讨论）。

### 1.5 被否决的更简方案（DSH 已证伪或明确不取）

- **定时器轮询续跑**（cron 式每 N 分钟推一轮）：DSH 用「事件驱动：agent idle + 树完工才排下一轮」，轮询会空转、且无法区分「真完成」与「暂时等待」。XH 若做续跑，应挂 ChatRun 终态事件而非定时器。
- **把 activation 持久化**：DSH 明确不持久化（resume 后默认停）。持久化会把「进程内调度权」变成跨进程事实，崩溃恢复后自动续跑失去人监督。
- **goal 状态字段直接 UPDATE 单行**（无事件日志）：DSH 用 append-only goal/change 事件，理由是 replay 可验证 + 投影失败可降级显示。XH 若只想 S 期落地，单行 CAS UPDATE 也可接受，但要接受失去历史审计（留 Lead 裁）。
- **模型可自由 pause/resume**：DSH 硬禁（模型不能 resume paused goal，authority 层抛错）；只允许人恢复。更简的「都允许」会把暂停语义变成模型可控的开关。

---

## 2. Agent Team（subagent / fork / 共享任务板 / send_message / owner 派工 / 写面隔离）

### 2.1 机制 [源码]

**subagent 基座**（`dsh-subagent` 包，Team 复用它）：

- **Provider 抽象**：spawn（in-process 全新上下文）/ fork（`dsh-subagent-fork-in-process/src/index.ts`：child 会话 seed = 父日志到最后一个 turn/end 的前缀，completedTurnPrefix L46；provider L60，`inheritsParentContext=true`）/ acp（跨进程）。tool-subagent 按 provider 能力（depthLimit/agentOptions/agentPreset）动态生成工具文案与校验。
- **深度预算**：`delegationDepthOf`（dsh-subagent/src/depth.ts L28）——session header 持久 delegationDepth，runtime 只能加深不能变浅（防 resume 后当顶层用）；本会话上限=1（maxDepth 配置，默认读 Host 设置 1）。
- **收尾交付**：child 结束后由 manager 把最终结果作为消息投回父 inbox（continuation-messages.ts：`agent-message`（relay）/ `subagent-settled`（notice）两类 durable source）。
- **send_message**（dsh-subagent/src/manager.ts sendMessage L567）：同树内任意成员互发；投递 = `deliverToMember(delivery:steer)`（L1166），目标是 **inbox 消息**（会中断/排在目标下一步），不是共享板通知。child 给父发的消息带 `omitClosingText` 抑制重复收尾文案。
- **wait_agent**（dsh-tool-subagent-control/src/wait-agent.ts waitForInput L26 / 注册 L91）：10s–1h，等待「下一步输入」，同一 tool call 内已上报过的消息不重复触发（防自旋）。

**共享任务板**（`dsh-agent-team` 包；服务 = `TeamService` ctx.agentTeams）：

- Team = **隐式**：TeamId 就是根 Session id（types.ts L34 区域），无独立实体；teammates = 根的 continuable subagent 目录。v2 时代 team/member、team/message 事件已是历史记录，成员与消息全走 subagent 基座（index.ts REMOVED_CONFIG_KEYS 证据）。
- **数据模型**（types.ts）：`TeamTaskSnapshot`（L64）= { id: `task-<n>`, revision, subject≤200, description≤16384, status: pending/in_progress/completed/deleted, ownerId?, ownerName?, blockedBy[], writeScopes[] }；`TeamTaskView`（L78）加派生 `ready` + `writeScopeWarnings[]`；`TeamProjection { enabled, tasks, failure? }`（L98）注册为 `agentTeam` projection（projection.ts L210，stateVersion 7）。
- **持久化**：任务全量快照存 **Team Lead 的 session log**（`team/task` 事件 L181）；折叠校验 revision 连续 + 依赖图无环（task-graph.ts assertTaskGraphCandidate）。写路径 = journal.transact（journal.ts L44，按 Lead 串行队列）+ appendAndFlush（L62，flush 失败抛 TEAM_TASK_PERSISTENCE_UNCONFIRMED，指示「先读后重试」）。
- **八动作 CAS**（task-board.ts TeamTaskBoard L29，update L117）：claim/release/edit/set_dependencies/complete/reopen/reassign/delete。授权矩阵：
  - owner 或 Lead：release/edit/set_dependencies/complete/reopen/delete；
  - claim：无主 + pending + ready（blockedBy 全 completed，task-view.ts L22）；已被占⇒TEAM_TASK_ALREADY_CLAIMED；
  - reassign：**仅 Lead**，目标必须是 continuable descendant（L188 + resolveAssignee 走 subagents.listDescendants）；
  - delete：有未删依赖者⇒TEAM_TASK_HAS_DEPENDENTS；deleted 是墓碑不是物理删。
- **写面隔离 = 建议性**（task-view.ts L12 scopesOverlap）：write_scopes 是 workspace 相对路径前缀（validation.ts L26 writeScope：禁绝对路径/盘符/..；统一斜杠去尾斜杠）；仅当与**其它 in_progress 任务**的前缀重叠时产生 warning（`write scopes overlap with task-x`）。**不锁文件、不拒写**——共享文件系统 + advisory scopes 是 DSH 的明确取舍。
- **工具面**（dsh-tool-agent-team/src/index.ts）：四工具 team_task_create/list/get/update（L118/144/185/201），带 `when: enabled` 条件注册——Team 模式关时工具对模型不可见（isEnabled 检查根 session 的 team/mode）。system prompt 注入 TEAM_POLICY 政策段（L27）。
- **读不写 Lead 日志**：team_task_list/get 标记 isConcurrencySafe（不 append）。

### 2.2 UX [源码]

- Team 开关在输入区模型选项里（TeamModeToggle，mount.ts selectTeamMode→remote.agentTeams.setEnabled）；关闭有确认弹层（TeamDisableConfirmation）。`team/mode` 事件持久选择。
- **任务面板** = subagent 面板 footer（mount.ts L68-69 slot `conversation.session.header.actions.subagent.footer`）：TeamBoard（TeamBoard.tsx L82）渲染非删除任务的行（TaskRow L40）：状态点（pending=灰、blocked=警告色、in_progress=进行、completed=勾）+ subject + 展开 description/owner；头部是进度统计（completed/active/pending 计数）。**只读**——面板不改任务，改任务全靠 agent 工具调用。
- 成员列表来自 subagentCatalog 投影；点开成员可看 lineage（SubagentHeaderLineage）与只读 composer。

### 2.3 映射到 XH [源码·XH 侧]

- **可复用面**：
  - **任务板落 CP 新表**（如 `team_tasks`），CAS revision + blockedBy JSON 数组 + write_scopes 数组；XH CP 已有成熟 JPA/Flyway 面。
  - **成员/收尾通道复用 ChatRun**：XH 的 `SessionParticipant` 实体 + `derived_state_changed` hint（event-stream.md §1）已经是「父会话感知子会话」的雏形——team 的「子完成→父 inbox」可以长在这上面，不必引入 DSH 的 manager 层复杂度。
  - UI：subagent 面板在 XH 是新面；TeamBoard 形态可直接借（Vue 化）。
- **需自建/裁决**：
  - XH agent 包目前**无 subagent 派生能力**（agent/src grep：无 subagent 概念，participant 仅 supervisor.py 一处）[源码]。团队基座 = 每个 teammate 一个 ChatRun？还是 LangGraph 内多 agent？**这是四包边界问题，须 Lead 拍板**；scout 意见：teammate=独立 ChatRun（与 DSH「teammate=subagent session」同构），任务板在 CP 层与 ChatRun 解耦。
  - 深度预算：XH 若允许 teammate 再派生，需要 delegation depth 的 durable 记录（可放 ChatRun 元数据）。
  - 写面隔离：DSH 是共享 FS + advisory scopes；XH runtime 有真实沙盒（workspace 隔离），**可以做得比 DSH 强**（scope 交接给 runtime 的沙盒授权），但 S 期建议先照抄 advisory（警告不拦截），避免 runtime 面扩权提前。
- **与 D-1812 的关系**：用户点名的「agent team」指的是 XH 产品功能；本节是设计输入。**A12 DSD 是 DSH 侧决策插件，不属于 XH team 功能**，见 §4。

### 2.4 分期建议

- **S**：任务板 durable + 四工具 + 只读面板（teammates 先用「人类在 UI 里开多会话」代位，或单 agent 自用任务清单）。复用 D-1129 后 XH 自身的 task+decision 工作流词汇（卡面/write_scopes/验收口径已在工作区规则里被验证）。
- **M**：teammate 派生（spawn 等价：独立 ChatRun、独立上下文）+ send_message + 收尾投递 + wait。
- **L**：fork（上下文继承）、树级深度预算、写面从 advisory 升级为 runtime 沙盒协同、跨 session 团队。

### 2.5 被否决的更简方案

- **独立 Team 成员实体 + 队列消息**（v1 遗迹）：DSH v2 已拆掉（REMOVED_CONFIG_KEYS：maxMembers/maxMessageBytes/disposalTimeoutMs 全删）——teammate=subagent、消息=inbox。XH 不应重造独立成员表。
- **写 scopes 做成硬锁**（flock/文件 ACL）：DSH 明确 advisory-only。硬锁要 runtime 深度参与且误伤大（同目录两任务本可并行）；advisory 警告 + 依赖图（blockedBy）承担大部分协调需求。
- **任务板消息广播**（每次变更 notify 所有成员）：DSH 靠「轮询工具读板」（team_task_list）+ 独立 send_message 点对点。广播会造成 inbox 噪音；DSH 政策文案明确「Task changes do not… add inbox messages」。
- **Lead 逐任务派工**（只允许 Lead 分配）：DSH 支持自取（claim ready 任务）+ Lead reassign 两轨。全 Lead 派工会把 Lead 变成调度瓶颈——与本工作区 subagent-orchestration 的实测经验一致。

---

## 3. 任务面板（task board UI 呈现）

### 3.1 机制 [源码]

DSH 没有独立的「任务面板」子系统——它由三个组件拼成：

- **数据**：`agentTeam` projection（§2）+ `subagentCatalog` projection（成员树）。
- **呈现**：TeamBoard（任务行列表 + 进度统计 + 失败横幅 `failure`）挂在会话头部 subagent 面板的 footer slot；TeamCommandRow 提供 team 开关入口。
- **同会话轻量任务**：另有 `todos` projection（dsh-tool-todo/src/types.ts L23 TodoItem：content + pending/in_progress/completed，**无 id、整表替换 last-write-wins**、summary 排除）+ todo/write 工具——这是「agent 自己的待办」，与 team 任务板是两套。
- 状态呈现映射：pending→灰点 / blocked（pending 且 !ready）→警告点 / in_progress→进行点 / completed→勾；owner 显示 ownerName ?? ownerId ?? unowned。删除的任务不渲染（tombstone 留在投影里）。
- projection failure 显示为错误横幅（StateDot error + message），保留最后有效任务列表（projection.ts teamProjectionView）。

### 3.2 UX [源码]

- 入口：会话头部 → subagent 面板（成员树在上，任务板在下）。任务行可展开看 description/owner。
- **面板纯只读**：任何变更（claim/complete）都由 agent 在对话里做，面板仅实时反映投影。这避免了「UI 直接改任务」带来的第二写路径与授权问题。
- 进度统计是纯前端派生（completed·active·pending 计数），不占持久化。

### 3.3 映射到 XH

- **可复用面**：XH ui 包已有 Pinia store 体系 + SSE 投影刷新模式（session store）；任务面板 = 新 feature 模块读 `team_tasks` 投影 API（CP 新增 GET /api/v1/team-tasks 或走 session 投影）。
- D-1129 后 XH 工作流已是 task+decision 主轴（卡面 = team_task_create 的 subject/description/write_scopes/验收口径）——**面板字段可直接对齐卡面词汇**，让「工作区编排规则」与「产品内 UI」同构。
- 与 §2 S 期绑定：面板是任务板的展示件，无独立后端需求。

### 3.4 分期建议

- **S**：只读面板（列表 + 状态点 + owner + 依赖提示），事件驱动刷新（复用 SSE）。
- **M**：行内筛选（status/owner/ready）+ 进度统计；若 Lead 决定允许人工改卡，加受控写路径（仍建议主走 agent 工具）。
- **L**：与 XH 自身任务面板（若产品化 D-1129 卡面）合并成一个通用卡面视图。

### 3.5 被否决的更简方案

- **UI 直接改任务**（点击 claim/complete）：DSH 刻意不做——单一写路径（agent 工具 + CAS）避免 UI/工具双写竞态。XH 若要 UI 可写，必须复用同一 CAS RPC，不能开第二条写通道（留 Lead 裁）。
- **轮询刷新**：DSH 全部走投影推送（activation/event 订阅）；XH 已有 SSE，照搬即可。
- **面板做编辑器**（拖拽排序、富文本）：DSH 面板是纯列表；编辑走 agent 对话。任务编辑器是另一档产品复杂度，不该绑在 v1。

---

## 4. 决策记录（decision CRUD/search/refs/supersede/void）

### 4.1 DSH 核心现状 [实测]

**DSH 核心没有内建 decision 域**。证据：全部 328 个 `dsh-*` 包名无 decision/journal 命名；SessionProjectionMap 声明点共 24 处（goal/agentTeam/todos/plan-mode/subagent/user-questions 等），无一为 decision [实测·本轮扫描]。决策记录在 DSH 里是**外置插件形态**（正是 A12 DSD，用户自己的项目）。这本身就是重要设计输入：**决策记录不必进核心域，插件/旁路存储即可成立**。

### 4.2 A12 DSD 已实现面 [源码·A12 仓]

（对照用，XH 产品化时应把 A12 当「已有一套参考实现」而非从零设计。）

- 存储外置：每 Profile 一个 SQLite DB（`databasePath` 显式配置，无默认回落、插件不建父目录、禁指向包内——契约 1.1-1.7，spec/decision-contract.md）。
- 域模型（packages/dsh-decision/src/domain/decision-contract.ts）：DecisionRecord = { decisionId（DSD 号）, revision, summary?, decision, rationale?, timeHorizon: long_term|temporary, decisionDate?, reviewDate?, status: effective|voided, voidReason?, voidedAt?, sourceReference?, createdAt, updatedAt }；七错误码 VALIDATION_FAILED/PROJECT_REQUIRED/DECISION_NOT_FOUND/REVISION_CONFLICT/DECISION_NOT_EDITABLE/DATABASE_BUSY/DATABASE_ERROR。
- 操作面（本会话 DSD 工具即活样例）：create（externalId 幂等去重）/create_batch（整批原子回滚）/get/search（literal|keywords、refs 反查、supersede 反查、withoutRefType）/update（CAS revision、refs 只增不删）/void（留档不删）。
- refs = 有向类型边（decision/task/plan/commit），禁 bl；replaces[] 表 supersede。
- **与本会话工具的对应**：scout 自己调用的 decision_* 工具就是这套契约的在线实例——字段、错误码、语义逐条一致。

### 4.3 DSH 侧最接近的参考面（对照） [源码]

- goal 的 phase/revision/CAS/墓碑模式（§1）——decision 的 effective/voided + revision 同构。
- team task 的 journal transact + flush 确认模式（§2）。
- A12 DSD 用外置 SQLite 而非 session log，因为决策是**跨 session、跨项目**资产（DSH session log 是单会话私有）。XH 若做产品内决策记录，事实源应在 **CP DB（跨 ChatRun/跨 Session 共享）**，不能放单会话历史。

### 4.4 映射到 XH

- **可复用面**：
  - A12 DSD 的域契约（状态/错误码/refs 语义/supersede/void）可直接作为 XH 决策记录的领域词汇——无需新造概念（膨胀门：能否用既有概念表达？能）。
  - CP 侧新表 `decisions` + `decision_refs`（或 JSON refs 列）；search 用 PG 全文/ILIKE（A12 用 SQLite LIKE，XH 有 pgvector/PG 生态）。
  - UI：决策列表 + 详情 + supersede 链可视化；SSE 不必需（低频写）。
- **裁决点**：决策记录的权限模型（谁能 create/void）、是否绑定 Session/Workspace/租户维度、externalId 幂等是否需要——A12 是单用户本地工具，XH 是多用户平台，这些要 Lead 定。
- **注意**：A12 DSD 是 DSH 生态的决策插件（给 DSH 用）；XH 产品化决策记录 ≠ 移植 A12 代码，而是**复用其契约词汇 + 在 XH 四包架构重新落地**。

### 4.5 分期建议

- **S**：CP durable CRUD + 模型工具（decision_create/get/search）+ 简单列表 UI；沿用 DSD 七错误码。
- **M**：refs/supersede/void 全套 + 反查（哪个 decision 被 task/plan 引用）+ update CAS。
- **L**：决策与 ChatRun/任务卡的双向溯源 UI、决策时间线、跨项目检索。

### 4.6 被否决的更简方案

- **决策存 session log**（像 goal 一样）：跨 session 不可检索，supersede/refs 需要全局 id 空间——DSH 自己都没这么做（外置插件 + 独立 DB）。XH 应放 CP DB。
- **软删/物理删**：DSD 用 voided 留档 + voidReason（墓碑），与 DSH goal clear 墓碑同构。物理删会破坏「引用它的 decision/task/plan」的完整性。
- **无 CAS 的自由 UPDATE**：DSD 强制 expectedRevision；并发场景（多 agent/多人）下必须。

---

## 5. CLI（命令形态 / 入口 / 与 WebUI 关系）

### 5.1 机制 [源码]

**入口链**：npm bin `dsh` → `dsh/lib/bin.js`（package.json bin）→ `src/bin.ts runCli`（bin.ts L26）→ `parseDshArgs`（args.ts L146）→ 按 mode 分派。

- **Launcher 只管「起哪棵插件树」，不管业务命令**。四个 mode：
  1. `profile`：`dsh [--profile] <name> [app-args…]`（ProfileInvocation args.ts L21）；`dsh web` = `dsh --profile web` 缩写；launcher flags（--profile/--patch/--from-default-profile/--dump-config*）之后的**全部参数原样交给 booted app**（含 -h）——「launcher flags come first; the first token this parser does not recognize starts the inner arguments」。desktop profile 由 Electron 独占，CLI 拒绝。
  2. `dump-config`/`dump-config-schema`：打印组合后的配置树/JSON Schema，不 boot。
  3. `plugin`：转发 pnpm 管理某 profile 的插件依赖。
- **Profile = 有序插件 bundle patch 层**，用户层可覆盖；**app 命令行由「注入的 app 插件」自解析**（dsh-cmdline 包提供 parseCmdline 底座）。
- **Headless one-shot**（`dsh-headless` 包，独立 profile）：`dsh --profile headless "task"` → 单 Agent、驱动到 quiescence、reasoning 流到 stderr、最终 assistant 文本到 stdout、`--json` 出 NDJSON 事件流（index.ts name L42；summarize L84 从 durable log 派生结果）。支持 --session-id 恢复（adoption 校验：subagent 会话拒收、preset 不符拒收、cwd 必须匹配）、--permission-mode/--approval-policy/--add-dir。**不是 WebUI 的客户端，是同一核心的另一种「壳」**。
- **Desktop/WebUI 关系**：桌面 = Electron 壳（`resources/app.asar` lib/main.js）启动**同一套 dsh runtime + web frontend**（web profile）；CLI 的 `dsh web` profile 与桌面跑的是同一 runtime 组合，仅宿主不同。[文档·package.json/包 README] 需实测两者并存时端口/数据目录约定。

### 5.2 UX [源码/文档]

- 心智模型：`dsh <profile> [args]` = 「用哪组插件能力去完成这件事」；web/tui/headless/rescue 是四种开箱 profile。
- 面向 agent 的 one-shot 形态（headless）与面向人的交互形态（web/tui）平级并列——CLI 不做「WebUI 的遥控器」，而是共享内核的独立入口。
- 配置可 dump（--dump-config）与 patch 叠加（--patch），命令行即可审计「会以什么配置启动」。

### 5.3 映射到 XH

- **现状**：XH 四包**无 npm bin**；已有 `scripts/xihe.mjs`（30+ 子命令的 dev/运维 CLI：auth/workspace/skill/credential/agent/scheduled-task/job/e2e 等，scripts/xihe-cli/*.mjs）[源码]——它是**开发运维面**，不是产品 CLI。
- **可复用面**：
  - xihe.mjs 的 HTTP 客户端基座（auth refresh、base URL 解析、token store）可直接被产品 CLI 复用或升级。
  - 产品 CLI 的自然形态（DSH 佐证）：`xihe chat "…"`（one-shot，对齐 headless）+ `xihe serve`（本地起 CP/Agent/Runtime 栈，对齐 web profile）+ `xihe session …`（会话管理，xihe.mjs 已有 chat-session.mjs 雏形）。
- **裁决点**：CLI 走「薄壳打 CP API」（无需本地 LLM 凭证，天然多用户）还是「完整 runtime 瘦身版」（本地自治）——DSH 两条都做了（headless=本地、web=同核）；XH agent 是 Python 服务，本地 one-shot 成本高，**薄壳优先**是 scout 意见，Lead 裁。
- Node 入口落点：新增 `packages/cli`（四包扩五包）或 scripts 升级——影响 workspace 结构与发布面，须 Lead/用户裁（AGENTS.md 说 A03 现有包 = agent/control-plane/runtime/ui，无 npm 子包）。

### 5.4 分期建议

- **S**：`xihe chat` one-shot（薄壳打 CP：POST chat + SSE 事件流到终端，输出最终文本）；复用 xihe.mjs 凭证基座。
- **M**：`xihe session/goal/task` 管理命令 + `--json` NDJSON 输出模式（headless 形态）+ 非交互脚本化（CI/定时任务）。
- **L**：`xihe serve` 本地栈托管 + profile/patch 配置体系（DSH 的 profile 层）+ tui 交互形态。

### 5.5 被否决的更简方案

- **CLI 直连 Agent 包**（绕过 CP）：破坏 XH 认证/审计/任务面统一；DSH headless 也要走完整 registry + 持久化 session，且 adoption 校验禁止直驱 subagent/preset 会话——「每种会话由其拥有者驱动」。
- **CLI 做 WebUI 的截屏/遥控器**：DSH 无此形态；CLI 与 WebUI 是同核双壳，不是主从。
- **无 session 概念的一次性调用**：headless 的 --session-id 恢复 + durable log summarize 表明「即使 one-shot 也要留 session 资产」，否则 goal/decision/审计全部失去挂靠点。

---

## 6. 面间关系与整体取舍提示（给 Lead 的一句话版）

1. **共享一条 durable 事件轴**：goal、team task、todo 在 DSH 全是 session 事件 + projection；XH 对应物 = ChatRun/Session durable 记录 + SSE 投影。先定「XH 投影层」的通用做法（每 session 一条事件流 + 折叠），再落五面，避免每面自造刷新机制。
2. **权威检查是产品差异点**：DSH 的 requireDirectHuman/completionAuthority 值得照抄到 XH 工具层——「模型不能自授权」，权限在调用现场验证。
3. **advisory 优先**：写面隔离（team scopes）与 goal 自治（disarmed on resume）都是「先建议、后收紧」；XH 初版照抄，等实测反馈再决定是否升硬约束。
4. **decision 走 CP DB 而非会话日志**：A12 DSD 的外置 DB 形态与契约词汇是现成输入。
5. **CLI 与 WebUI 同核双壳**：XH 的 CLI 应打 CP API（薄壳），one-shot 也留 durable session。
6. **A12 DSD ≠ XH 产品决策记录**：只复用契约，不复用「DSH 插件」这个宿主形态。

## 7. 待实测清单（本轮未运行的行为）

- Desktop 与 `dsh web` 并存时的端口/数据目录协商（本轮未启动两者）。
- fork seed 在 turn 进行中 fork 的实际行为（源码注释说 seed 止于最后一个 turn/end，未跑）。
- Team 模式关闭时历史任务在 UI 的可见性（源码显示 projection enabled=false 时 TeamBoard 整体不渲染，需实测确认预期）。
- headless --json 事件流的 NDJSON schema（json-stream.ts 未逐行读）。
- XH 侧：SessionParticipant 的 participant kind 字段可否承载「human 判据」（goal 权威检查的前提）。

## 8. 证据文件索引（file:line 速查）

| 断言 | 位置 |
| --- | --- |
| GoalRef/GoalPhase/GoalSnapshot/GoalView/activation | DSH:dsh-goal/src/types.ts:L20/L45/L60/L90/L72 |
| goal/change 事件表、GoalMessageSource round 归属 | DSH:dsh-goal/src/domain.ts:L66/L47/L14 |
| GoalService、defaultMaxGoalRounds=256、resume cap 校验、commit | DSH:dsh-goal/src/index.ts:L236/L240/L365 区域/L608 |
| 折叠函数 applyGoalEvent/foldGoal/goalChangeRef | DSH:dsh-goal/src/fold.ts:L313/L339/L260 |
| RoundAttempt 状态机、drive、round-limit block、pre-step fence | DSH:dsh-goal-round-driver/src/index.ts:L30/L146/L184/L372/L387 |
| 续跑轮 prompt 渲染 | DSH:dsh-goal-round-driver/src/prompt.ts:L12 |
| get_goal/create_goal/update_goal、blocked 节流默认 3 | DSH:dsh-tool-goal/src/index.ts:L196/L208/L235/L39 |
| requireDirectHuman/completionAuthority | DSH:dsh-tool-goal/src/authority.ts:L99/L110 |
| /goal 命令解析与注册 | DSH:dsh-command-goal/src/index.ts:L35/L193 |
| GoalBar/GoalDock UI | DSH:dsh-client-ui-goal/src/client/GoalBar.tsx:L43/L183 |
| TeamTaskSnapshot/TeamTaskView/TeamProjection/team/task 事件 | DSH:dsh-agent-team/src/types.ts:L64/L78/L98/L181 |
| TeamTaskBoard 八动作 CAS、claim/reassign/delete | DSH:dsh-agent-team/src/task-board.ts:L29/L117/L142/L188/L204 |
| scopesOverlap/taskReady/projectTaskView（advisory 警告） | DSH:dsh-agent-team/src/task-view.ts:L12/L22/L35 |
| journal transact/appendAndFlush | DSH:dsh-agent-team/src/journal.ts:L44/L62 |
| agentTeam projection stateVersion 7 | DSH:dsh-agent-team/src/projection.ts:L210/L212 |
| writeScope 校验 | DSH:dsh-agent-team/src/validation.ts:L26 |
| TEAM_POLICY、四 team_task_* 工具 | DSH:dsh-tool-agent-team/src/index.ts:L27/L118/L144/L185/L201 |
| TeamBoard/TaskRow UI、subagent footer slot | DSH:dsh-client-ui-agent-team/src/client/TeamBoard.tsx:L82/L40；mount.ts:L68 |
| fork seed = completed-turn prefix | DSH:dsh-subagent-fork-in-process/src/index.ts:L46/L60 |
| delegation depth 单调 | DSH:dsh-subagent/src/depth.ts:L28 |
| send_message/deliverToMember | DSH:dsh-subagent/src/manager.ts:L567/L1166 |
| wait_agent | DSH:dsh-tool-subagent-control/src/wait-agent.ts:L26/L91 |
| TodoItem 整表替换 | DSH:dsh-tool-todo/src/types.ts:L23 |
| runCli/parseDshArgs/ProfileInvocation | DSH:dsh/src/bin.ts:L26；dsh/src/args.ts:L146/L21 |
| headless runner/summarize | DSH:dsh-headless/src/index.ts:L42/L84 |
| headless 命令定义 | DSH:dsh-headless/src/startup.ts:L53 |
| A12 DSD 域契约/存储路径契约 | A12-DSH-decision/packages/dsh-decision/src/domain/decision-contract.ts；spec/decision-contract.md |
| XH 事件流/会话架构契约 | A03-xihe/spec/protocol/event-stream.md；spec/data/operation-ledger.md（superseded，历史参考） |
| XH 现有 dev CLI | A03-xihe/scripts/xihe.mjs；scripts/xihe-cli/*.mjs |
| DSH 无 decision 域 | 328 个 dsh-* 包名 + 24 处 SessionProjectionMap 声明扫描（本轮实测） |
