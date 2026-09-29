# Session Fork 与 Branch Actions

> 契约状态：`active`  
> 实现状态：`partial`  
> Profile：`protocol`  
> Owner：CP Session owner（PLAN-0409）  
> 消费者：CP Session/Chat API、UI、PLAN-0410 Context projection、Agent Context  
> 来源：PLAN-0409  
> 更新日期：2026-09-29

## 范围

本规范定义跨 Session fork、同 Session branch actions、消息/附件复制、幂等与失败恢复。分支 path、Run cursor、ContextEvent/EventStore 投影与 Agent context 消费由 [Session 分支上下文隔离](branch-context-isolation.md)（PLAN-0410）唯一拥有；本规范定义其 fork 消费方式，不重复实现 branch resolver 或 Agent context filter。

## Fork 身份与 anchor

- Fork 创建新的 child Session。Child 与 source 使用同一 stable AgentPrincipal UUID，但创建独立 child permission snapshot/root，取 fork 时主体和 Workspace binding 当前可授予的权限；不复用 parent permission snapshot，不继承 parent dynamic spawn chain。`Session.user_id` 仅负责 owner/visibility。
- Child `kind=fork` 的 source Session/Run 字段仅作 lineage。Child 已发布后，其 Chat/Agent policy path 只依赖自身 stable principal 与 permission snapshot；删除 parent Session/Run 不得使 child 失效。
- `POST /api/v1/sessions/{sourceSessionId}/fork` 必须携带 `Idempotency-Key`，body 显式包含 `sourceBranchId`、`anchorMessageId`。CP 验证 owner、Workspace、branch path membership、message/run 归属与 terminal 状态。
- Source Session 的其他 active Run 不阻止对更早 terminal anchor 的 fork；锚点及 seed 严格截止该 anchor cursor，不能包含后来写入。active Run 本身不能作为 anchor。
- Request claim 短暂锁 source Session 以串行化 anchor snapshot 与 source deletion；它释放 Session lock 后才开始复制 bytes。Parent deletion 在存在 `copying` fork request 时返回 retryable `409 FORK_REQUEST_IN_PROGRESS`；request 不在 copying 后，parent 可独立删除。
- 新建成功返回 `201 Created`、`Location: /api/v1/sessions/{childSessionId}` 和 Child Session view；completed same-key replay 返回 `200 OK`、相同 Location/body。错误使用 RFC 9457 Problem Details。

## Child Context Seed

Child 通过现有 `session.forked` Session/global root event 接收 PLAN-0410 生成的 anchor-bounded projection seed，不新增 EventType 或第二套 EventStore：

```json
{
  "source_session_id": "<lineage UUID>",
  "anchor_message_id": "<lineage UUID>",
  "summary_seed": {
    "messages": [
      { "role": "human", "content": "..." },
      { "role": "tool", "content": "..." },
      { "role": "ai", "content": "..." }
    ],
    "summary": "...",
    "summaryHash": "...",
    "contextEpoch": "<new child-owned UUID>"
  }
}
```

- Event row retains the 0410 Session/global envelope: `branch_id=NULL`, `correlation_id=NULL`; its child-assigned Session sequence is the child compaction cursor.
- `messages` is the CP projection visible on the requested source branch through the terminal anchor cursor. It is required whether or not a summary exists. `summary` and `summaryHash` appear together only when the anchor-bounded projection has SUM state. `contextEpoch` is always new and child-owned.
- Source Session and anchor message IDs are lineage only. Do not copy source sequence/cursor, branch ID, source Run/correlation, usage/provider accounting, runtime state, parent L1, or audit/execution rows into child context. L1/environment context is rebuilt for the child by the existing pre-run refresh.
- Source branch filtering and anchor sequence cutoff apply before selecting messages or summary. A later compaction after the anchor cannot enter the seed. CP and Agent apply the event to equivalent `messages`/SUM projections; later child compaction uses the child event sequence as `up_to_sequence`.

## Copy and Publication

- Copy source path messages through anchor; copy attachment bytes into the child Session namespace and create independent File rows/IDs/URLs. Child `Message.run_id` may retain a source Run UUID only as internal lineage while that Run exists; Session deletion explicitly sets such child references to NULL, and Message API/UI only exposes Run status when the Run belongs to the same Message Session.
- Do not copy ChatRun, operation, ledger, tool audit or runtime execution events. The existing child `session.forked` seed is the only new root event for projected conversation memory.
- The child is externally visible only after the final database transaction commits its Session, root branch, permission snapshot, provenance, messages, File rows, seed event and `completed` fork-request state together.
- Fork and every physical attachment-delete path use per-File row locks in stable File-ID order. Fork does not hold a source Session lock through byte copying. Cleanup uses strict namespace deletion and verifies absence; best-effort log-and-continue deletion is not sufficient for fork recovery.

## Idempotency and Recovery

- `Idempotency-Key` is required and limited to 128 characters; missing/blank returns `400 IDEMPOTENCY_KEY_REQUIRED`, malformed branch/anchor fields return `400 INVALID_REQUEST`.
- Same source Session + same `Idempotency-Key` identifies one logical fork request. Store a canonical request hash over source branch, anchor message and effective options. Same key/hash replays the same child; same key/different hash returns `409 IDEMPOTENCY_KEY_CONFLICT` with no side effects.
- V46 `session_fork_requests` is the sole durable idempotency/recovery record: child Session UUID primary key, source Session UUID, key, canonical hash, state (`copying`, `cleanup_pending`, `retryable`, `completed`), relative child cleanup namespace, timestamps and optional sanitized error code. Add a unique constraint on `(source_session_id,idempotency_key)`. It has no cascading FK to source or child Session; pending rows never expire.
- Commit the `copying` request row before the first filesystem write. The request-row lock serializes same-key work; a concurrent duplicate that cannot acquire the row receives retryable `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` without a child identifier.
- The final transaction publishes all child database rows and `completed` state atomically. On failure, rollback child rows and strictly clean the reserved child namespace. Verified cleanup changes state to `retryable`; failed cleanup persists `cleanup_pending`, keeps the child unavailable, and returns retryable `503 FORK_CLEANUP_PENDING` without a child identifier.
- A startup/periodic recovery scan uses the same request table and `FOR UPDATE SKIP LOCKED` to clean abandoned `copying` or `cleanup_pending` namespaces. It only cleans and verifies absence; it never automatically replays the fork. A same-key/hash retry after cleanup reuses the reserved child Session UUID; a completed request returns the same child.
- When storage remains unavailable, retain the durable `cleanup_pending` record and do not publish the child. Physical zero-residue is asserted after recovery succeeds, not while cleanup is impossible.

## In-Session Branch Actions

- Rewind/edit/path selection remain within the same Session and preserve original path rows. Branch path reads, anchor mapping and Context projection use PLAN-0410 services.
- Mutating an in-session branch while a Run is active returns `409 BRANCH_LOCK`; normal Session single-flight behavior remains `409 CHAT_IN_PROGRESS`.
- Every public action enforces Bearer authentication, Session owner/Workspace visibility and RFC 9457 Problem Details; browser clients cannot synthesize branch membership or child context.
