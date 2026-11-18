# 共享任务板与 steer 通道（team-tasks / steers）

task-188 MVP⑤（D-1821）冻结的两张面：**读** = 任务板只读投影，**写** = steer 复用既有 Follow-up 队列。
本文件是这两张面的词汇与语义权威；`docs/api/openapi.yaml` 与 `docs/api/inventory.md` 同批登记，
路由的机器判据在 CP 侧（`RouteContractParityTest`）。

## 1 任务板读面（GET /api/v1/sessions/{sessionId}/team-tasks）

1. **板 = 树，不是会话**。板键是树根会话（`team_root_session_id`），每次读由
   `DelegationChainWalker.walkFromSession` 重算；行上存的是写时快照。同一棵树的任意会话 id 都能
   定位到同一块板。
2. **只读**。这条面**没有任何写路由**（D-1821 面板只读裁定）。claim / complete / reopen / move /
   reassign 全部走 agent 工具面（`team_task_*`，原子 `TEAM_TASK_MANAGE`，V172）与既有命令原语；
   驳回「UI 第二写入口」的理由与 R4 同源。
3. **可读者 = 树根会话的人类 owner**。树成员是 agent principal，它们用工具面，不用这张 HTTP 口；
   非 owner 回 `403 TEAM_TASK_FORBIDDEN`。理由：板会点名每个 teammate 的任务，读者面就等于全队工
   作明细。
4. **墓碑随行**。`status=deleted` 行照常出现在投影里，由客户端再挡一层并计数（layer-filter
   纪律：服务端过滤过、客户端再挡一层，挡了要说）。服务端不替客户端做「看不见」的决定。
5. **两个派生字段**（`ready` / `writeScopeWarnings`）由 CP 算，客户端不自己推：
   - `ready` = 不是终态（completed/deleted 则恒 false）且 `blockedBy` 里**没有未完成**的行；
   - `writeScopeWarnings` = 与本行 `writeScopes` 有路径前缀重叠的**非终态**行，文案带 `task-<n>`。
   `writeScopes` **原文不出服务端**（投影里只有派生 warning）——advisory 面的存储形态不是 wire 契约。
6. **无分页**（MVP 单投影全量，最多数百行）。加页是新增面，不是本批留白。

## 2 任务写面（agent 工具 `team_task_create` / `list` / `get` / `update`）

1. **一个原子四个面**：全部映射 `TEAM_TASK_MANAGE`（`ToolFaceRegistry`），**不进**
   `AGENT_FORBIDDEN_ATOMS`（teammate 是 agent principal，claim/complete 是它的本职，
   MANAGE_SKILL_LIBRARY N5-N9 先例）。
2. **advisory CAS**：每次变更带 `expectedRevision`，落库是 `WHERE revision = :expected` 的守卫更新；
   0 行受影响则 `409 TEAM_TASK_CONFLICT`（行是裁判，不信调用方的读快照）。`revision` 单调 +1。
3. **没有租约、没有过期**（bl-354：不做 leased claim 形状）。claim 只在「行未被占」时成立。
4. **行本地授权**（原子之外的第二层，都是关系判定，不做角色名特判）：
   - `claim`：行必须未被占；
   - `complete` / `reopen` / `move` / `update_details`：调用者会话**就是** owner；
   - `reassign`：只允许 creating session，且该会话仍须走回本板 root；目标须是**同树**会话
     （walker 复核），否则 `409 TEAM_TASK_INVALID_TARGET`。
5. **`blockedBy` 无环**：自指与传递闭包都拒（`409 TEAM_TASK_CYCLE`）；引用不存在的行
   `404 TEAM_TASK_NOT_FOUND`（不静默丢依赖）。
6. **deleted 是墓碑**：除 `reopen` 外一律不可变。板不物理删行。

## 3 steer 通道（POST /api/v1/sessions/{childSessionId}/steers）

1. **复用，不另建队列**（默认③）：steer 就是 child 会话 V49 队列里的一个普通 item，
   归因靠 V173 两列（`source_kind='agent_steer'` + `from_session_id` = 树根会话）。容量、准入、
   结算、重启恢复、唤醒事件全部沿用既有实现 —— 只有一个写点（task-128 §4 警告的正是「两处各造
   一半」）。
2. **非抢占**：在途 child run 让队首 ineligible（既有 `anchor_not_terminal`），所以 steer 在
   **下一个 admission 边界**送达。它是「迟一点送达的持久指令」，**不是中断信号**；按中断理解
   会等一个永不到来的 abort。
3. **归因必须在列，不能在 content**：admission 会 `setContent(null)`（FollowUpQueueService），
   把来源塞进正文等于重启/准入后必丢。这是本批的硬判据。
4. **`null` = 无归因**：`source_kind` 可空、无 DEFAULT、零回填；人类 follow-up 与所有存量行都是
   `NULL`。「无归因不渲染徽标」，客户端**不得**把 null 替换成 `human`（DEV-032）。
5. **CHECK 是蕴涵不是双条件**：`agent_steer` 必带 `from_session_id`；但 human 行**允许**带
   `from_session_id`（将来「人类向某会话提的请求」要能落，不该为此再开迁移）。
6. **授权 = 关系**：调用者须拥树**根**会话（人类 owner 通道，同 follow-up 租户闸）。
   不可达/跨租户则 `404 SESSION_NOT_FOUND`；可达但不是本树 Lead 则 `403 STEER_FORBIDDEN`。
   顺序是「先授权后队列形状」，否则错误码会变成「这个 child 忙不忙 / 满没满」的探针。
7. **`expectedRevision` = advisory-only**（D-1830）：随 item 持久化并回显（V173 专列
   `expected_revision`），**不作 CAS 闸门**。给队列加全局 revision 是新机制（膨胀门不过）；要防
   陈旧插话属独立裁定，不在本批默认内。**不许塞进 `tool_timeouts`**：那是「工具名 → 秒数」的表，
   admission 真会按工具名读它，把无关整数塞进去等于伪造一个叫 `expectedRevision` 的工具。
8. **幂等**：`Idempotency-Key` 必填 1..128；首次 `202`、同键同文 `200` 且**不重复写**（不重盖归
   因、不再记审计）。同键异文 `409 IDEMPOTENCY_KEY_REUSED`。
9. **不新增 SSE**（默认⑧）：child 视图靠既有 `derived_state_changed` hint 重读。

## 4 不扩契约

- 本文件冻结的两张面之外**不新增**事件名、队列、等待原语或写路由；需要新面先改本文件再落码。
- steer 与 G3-a 的等待可续跑**互不感知**：steer 不创造等待语义，admission 产物是普通 child run；
  该 run 若随后自己进入 ask_user 等待，走 G3-a 的 durable 答案信封（两层不交叉）。
- approval 的对称重放口**不在本批**，排 MVP⑤ 收口后单独小卡，语义须与 C5 显式重试对齐。

## 5 承接与验证

- 实现：task-188 S2（板/原子/迁移 V172）、S3（steer/归因迁移 V173）。
- 迁移号取号三查与登记见 `internal/A03-xihe/docs/migration-numbers.md` §0/§4。
- L0：`TeamTaskServiceTest` / `TeamTaskControllerTest` / `TeamTasksMigrationTest` /
  `SteerServiceTest` / `FollowUpItemSourceMigrationTest` + CP 四门
  （`RouteContractParityTest` / `DefaultSetAtomMatrixTest` / `PermissionAtomLabelsTest` /
  `DefaultSetMigrationParityTest`）。
- 真栈判据（重启后 steer 续跑、板 CAS 并发）按 task-128 §5 口径用真栈用例验；停栈期只列判据。