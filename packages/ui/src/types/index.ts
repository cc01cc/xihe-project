import type { InjectionKey, Ref } from "vue";

export interface SessionContext {
    agents: string[];
    ragContext?: RAGContext;
    mcpContext?: MCPContext;
    fileContext?: FileContext;
}

export interface RAGContext {
    knowledgeBaseIds?: string[];
    searchEnabled?: boolean;
}

export interface MCPContext {
    serverIds?: string[];
    toolFilter?: string[];
}

export interface FileContext {
    workspaceFiles?: string[];
    activeFilePath?: string;
}

export interface Session {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    workspaceId?: string;
    agentPrincipalId?: string | null;
    /** PLAN-0655 T1.5: `SPAWN` = a delegated child session (tree + badge + budget chip). */
    kind?: string | null;
    spawnedFromSessionId?: string | null;
    spawnedAt?: string | null;
    modelProvider?: string;
    modelName?: string;
    providerConnectionId?: string;
    connectionRevision?: number;
    contextTemplateLayer?: "instance" | "user" | "workspace" | null;
    contextTemplateId?: string | null;
    contextTemplateVersion?: number | null;
    context?: SessionContext;
}

export type SessionDerivedActiveStatus =
    | "accepted"
    | "queued"
    | "running"
    | "streaming"
    | "awaiting_approval"
    | "dispatching"
    | "cancelling";

export type SessionDerivedTerminalState =
    | "success"
    | "error"
    | "partial"
    | "ambiguous"
    | "cancelled";

export interface SessionDerivedActiveChild {
    childSessionId: string;
    runId: string;
    name: string | null;
    status: SessionDerivedActiveStatus;
}

export interface SessionDerivedTerminalNotice {
    childSessionId: string;
    runId: string;
    name: string | null;
    state: SessionDerivedTerminalState;
    terminalAt: string;
}

export interface SessionDerivedStateResponse {
    sessionId: string;
    activeChildren: SessionDerivedActiveChild[];
    terminalNotices: SessionDerivedTerminalNotice[];
}

/**
 * PLAN-0464 T2.1: ChatRun projection behind `GET /chat/sessions/{id}/runs`.
 * `waitingOnRunId`/`waitingToolCallId` is the spawn waiting link that moved off
 * the parent OperationItem onto the child run row.
 */
export interface SessionRunSummary {
    runId: string;
    sessionId: string;
    origin: string;
    status: string;
    terminalOutcome: string | null;
    errorCode: string | null;
    createdAt: string | null;
    terminalAt: string | null;
    waitingOnRunId: string | null;
    waitingToolCallId: string | null;
}

export interface SessionRunsResponse {
    sessionId: string;
    page: number;
    size: number;
    runs: SessionRunSummary[];
}

/**
 * PLAN-0507: read-only Session monitor aggregate
 * (`GET /api/v1/chat/sessions/{id}/monitor`). `null` components are explicit
 * "unavailable" facts, never zero-filled placeholders.
 */
export interface SessionMonitorSession {
    id: string;
    title: string | null;
    agentPrincipalId: string | null;
    modelProvider: string | null;
    modelName: string | null;
    providerConnectionId: string | null;
    connectionRevision: number | null;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface SessionMonitorActivityItem {
    runId: string;
    origin: string;
    /** Effective status; `awaiting_approval` is synthesized by Control Plane. */
    status: string;
    createdAt: string | null;
    waitingOnRunId: string | null;
    waitingToolCallId: string | null;
    leaseExpired: boolean;
}

export interface SessionMonitorHistoryItem {
    runId: string;
    origin: string;
    terminalOutcome: string | null;
    errorCode: string | null;
    createdAt: string | null;
    terminalAt: string | null;
}

export interface SessionMonitorHistory {
    windowSize: number;
    counts: Record<string, number>;
    recent: SessionMonitorHistoryItem[];
}

export interface SessionMonitorConnectionFact {
    status: import("./providerConnection").ProviderConnectionStatus;
    lastErrorCode: string | null;
    lastVerifiedAt: string | null;
}

export interface SessionMonitorAgentFact {
    status: string;
    llmReady: string;
    verifiedAt: string | null;
    configRevision: string;
}

export interface SessionMonitorLastObservedRun {
    runId: string;
    terminalOutcome: string | null;
    errorCode: string | null;
    terminalAt: string | null;
}

export interface SessionMonitorReadiness {
    connection: SessionMonitorConnectionFact | null;
    agent: SessionMonitorAgentFact;
    lastObservedRun: SessionMonitorLastObservedRun | null;
}

export interface SessionMonitorResponse {
    generatedAt: string;
    session: SessionMonitorSession;
    activity: SessionMonitorActivityItem[];
    history: SessionMonitorHistory;
    readiness: SessionMonitorReadiness;
    /**
     * PLAN-0508: transport attempt counts over ALL retained rows of this
     * session (running included); independent of the `history.counts`
     * 20-terminal-run window.
     */
    transport: ChatTransportAggregate;
}

/**
 * PLAN-0508: durable provider HTTP transport attempt — read projection of the
 * V68 lifecycle row. Provider/model/connection identity is projected from the
 * ChatRun snapshot; `uploadBytes/downloadBytes` are fixed `null` (v1 unknown).
 */
export interface ChatTransportAttempt {
    attemptId: string;
    seq: number;
    status: "running" | "terminal";
    outcome: string | null;
    provider: string | null;
    model: string | null;
    connectionId: string | null;
    connectionRevision: number | null;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    errorCode: string | number | null;
    firstChunkMs: number | null;
    chunkCount: number | null;
    uploadBytes: number | null;
    downloadBytes: number | null;
    lastProgressStage: string | null;
    lastProgressElapsedMs: number | null;
}

/** PLAN-0508: attempt counts (failed = error/timeout; partial = aborted/partial). */
export interface ChatTransportAggregate {
    attemptCount: number;
    failedCount: number;
    partialCount: number;
}

export interface RunTransportAttemptsResponse {
    runId: string;
    attempts: ChatTransportAttempt[];
    aggregate: ChatTransportAggregate;
}

/** PLAN-0509: safe per-Run trace projection; event payloads are never included. */
export type RunTraceCompleteness = "complete" | "partial" | "unknown";

export type RunTraceSourceName =
    | "chat_run"
    | "context_event"
    | "provider_attempt"
    | "mcp_invocation"
    | "runtime_job";

export type RunTraceSourceStatus = "complete" | "unavailable" | "not_applicable" | "unknown";

export type RunTraceEventKind =
    | "run.lifecycle"
    | "input.admitted"
    | "context.source"
    | "agent.tool"
    | "provider.attempt"
    | "mcp.invocation"
    | "runtime.job"
    | "usage.recorded";

export type RunTraceEventStatus =
    | "created"
    | "queued"
    | "running"
    | "awaiting_approval"
    | "completed"
    | "failed"
    | "cancelled"
    | "admitted"
    | "resolved"
    | "missing"
    | "rejected"
    | "stale"
    | "started"
    | "succeeded"
    | "pending"
    | "ambiguous"
    | "recorded"
    | "estimated"
    | "unknown";

export type RunTraceReferenceName =
    | "contextEventId"
    | "attemptId"
    | "toolCallId"
    | "mcpInvocationId"
    | "runtimeJobId";

export interface RunTraceUsage {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
}

export type RunTraceProvenanceStatus = "complete" | "partial" | "unknown";

export interface RunTraceProvenance {
    status: RunTraceProvenanceStatus;
    providerConnectionId: string | null;
    connectionRevision: number | null;
    apiTypeId: string | null;
    apiTypeVersion: number | null;
    contextTemplateLayer: "instance" | "user" | "workspace" | null;
    contextTemplateId: string | null;
    contextTemplateVersion: number | null;
}

export interface RunTraceSource {
    source: RunTraceSourceName;
    status: RunTraceSourceStatus;
}

export interface RunTraceEvent {
    eventId: string;
    occurredAt: string;
    source: RunTraceSourceName;
    kind: RunTraceEventKind;
    status: RunTraceEventStatus | null;
    durationMs: number | null;
    toolName: string | null;
    providerId: string | null;
    modelId: string | null;
    errorCode: string | null;
    usage: RunTraceUsage | null;
    references: Partial<Record<RunTraceReferenceName, string>>;
}

export interface RunTraceResponse {
    runId: string;
    asOf: string;
    completeness: RunTraceCompleteness;
    provenance: RunTraceProvenance;
    sources: RunTraceSource[];
    events: RunTraceEvent[];
    nextCursor: string | null;
}

/** UI join of the PLAN-0464 waiting link and the derived child projection. */
export interface ToolCallWaitingOn {
    childRunId: string;
    name: string | null;
    status: SessionDerivedActiveStatus;
}

export type DiagnosticSeverity = "error" | "warning" | "note";
export type DiagnosticConfidence = "high" | "low";

/**
 * PLAN-0342 T1.5: structured diagnostic item carried by `tool_result` events.
 * `file`/`line`/`column`/`kind` are nullable — the parser degrades to raw
 * output (`confidence: "low"`) when it cannot anchor a location.
 */
export interface Diagnostic {
    file: string | null;
    line: number | null;
    column: number | null;
    severity: DiagnosticSeverity;
    kind: string | null;
    message: string;
    confidence: DiagnosticConfidence;
}

/** Diagnostics bundle attached to a `tool_result` payload (`items` is the Top-N slice of `total`). */
export interface DiagnosticsBundle {
    items: Diagnostic[];
    total: number;
    confidence: DiagnosticConfidence;
}

export interface JobSummary {
    /** PLAN-0465 decision #7：domain jobId（`workspace_jobs.id`）——续看/取消唯一键。 */
    jobId: string;
    /** 所属 Workspace（canonical output/cancel 路径的 `{workspaceId}` 段）。 */
    workspaceId: string;
    toolCallId?: string;
    toolName?: string;
    status: string;
    scope?: string;
    startedAt?: string | null;
    endedAt?: string | null;
}
export interface ToolCall {
    id: string;
    /** Agent tool-run id; `tool_call` and `tool_result` share it even when `toolCallId` differs (PLAN-0342 review fix). */
    runId?: string;
    name: string;
    arguments: string;
    status: "running" | "completed" | "failed" | "pending" | "cancelled";
    result?: string;
    error?: string;
    startedAt?: string;
    completedAt?: string;
    diagnostics?: DiagnosticsBundle;
    /** PLAN-0572: persisted snapshot marker for bounded arguments. */
    truncated?: boolean;
    /** UI-only projection from the parent ChatRun waiting link + derived-state API. */
    waitingOn?: ToolCallWaitingOn | null;
    /** PLAN-0344: durable job archival summary restored from the messages DTO after refresh. */
    jobSummary?: JobSummary;
    /**
     * PLAN-0649: CP's refusal/short-circuit code (`DELEGATION_LIMIT_EXCEEDED`, …).
     *
     * Present ⇒ the call was refused by policy/budget instead of executed. The tool
     * result body stays withheld on every surface, so this code (plus the localized
     * copy it maps to) is the only reason the user can see. Judge refusals by this
     * field, **not** by `status`: a non-CP tool error can still be `completed` in the
     * durable snapshot.
     */
    refusalCode?: string;
}

export type ApprovalPolicyEffect = "allow" | "ask" | "deny";
export type ApprovalPolicySourceLayer =
    | "builtin"
    | "instance"
    | "user"
    | "workspace"
    | "session"
    | "per_call";
export type ApprovalPolicyMode = "manual" | "auto" | null;
export type SessionPolicyMode = Exclude<ApprovalPolicyMode, null>;
export type ApprovalPolicyShape = "structured" | "interpreter" | "opaque";

/**
 * PLAN-0625 G/D25-10：policySummary 的 versioned `hooks` 段（顾问建议，含守卫）。
 * 顾问是**建议**不是裁决（D25-04"守卫不执行"）：verdict 只有 approve/deny 两种措辞，
 * UI 不得把它渲染成最终拒绝。
 */
export interface ApprovalGuardAdvisor {
    kind: string;
    verdict: "approve" | "deny";
    reason: string;
    at: string;
}

export interface ApprovalHooksSection {
    version: number;
    advisors: ApprovalGuardAdvisor[];
}

export interface ApprovalPolicy {
    effect: ApprovalPolicyEffect;
    sourceLayer: ApprovalPolicySourceLayer;
    matchedRule: string | null;
    reason: string;
    mode: ApprovalPolicyMode;
    modeAtGrant?: ApprovalPolicyMode;
    actionClass: string;
    shape: ApprovalPolicyShape;
    /** versioned hooks 段；version≠1 或形状不符时**整段缺失**（fail-closed，不猜）。 */
    hooks?: ApprovalHooksSection;
}

export type ApprovalRequestState =
    | "pending"
    | "dispatching"
    | "approved"
    | "rejected"
    | "expired"
    | "dispatch_unknown";

/** Durable creation provenance (PLAN-0371 / V25); null for rows predating V25. */
export type ApprovalRequestOrigin = "cp_gate" | "agent_relay";

export interface ApprovalRequest {
    requestId: string;
    runId: string;
    sessionId: string;
    workspaceId?: string;
    tool: string;
    action: string;
    details: string;
    argumentsHash?: string | null;
    expiresAt?: string;
    replayed?: boolean;
    state?: ApprovalRequestState;
    origin?: ApprovalRequestOrigin | null;
    modeAtGrant?: ApprovalPolicyMode;
    policy?: ApprovalPolicy;
}

export type ApprovalDecisionKind = "once" | "session" | "saved" | "reject" | "reject_always";

export interface ApprovalRuleSpec {
    resource?: string;
}

export interface ApprovalDecision {
    decision: ApprovalDecisionKind;
    feedback?: string;
    layer?: "workspace" | "user";
    rule?: ApprovalRuleSpec;
}

/**
 * Decision envelope emitted by the approval modal: the decision plus the `requestId` it was
 * composed for. The classify-and-allow write can resolve after the pending request changed, so
 * the caller must verify the envelope still matches the actionable request before deciding; the
 * `requestId` is dropped again before the API payload is built.
 */
export interface ApprovalDecisionEnvelope extends ApprovalDecision {
    requestId: string;
}

export interface PendingApprovalSummary {
    sessionId: string;
    workspaceId: string;
    count: number;
    oldestRequestedAt: string;
}

export interface SessionPolicyModeState {
    sessionId: string;
    mode: SessionPolicyMode;
    sessionRules?: number;
}

export interface PolicyModeUpdateResponse {
    sessionId: string;
    mode: SessionPolicyMode;
    scope: "session";
}

/** Persisted policy layers (PLAN-0328 decision #53); `builtin` never holds persisted rules. */
export type PolicyRuleLayer = "instance" | "user" | "workspace";

/** Response scope of a tool-face row; `builtin` is catalog metadata, never a write scope. */
export type PolicyToolFaceScope = "builtin" | "instance" | "workspace";

/** Effective catalog scope accepted by `GET /api/v1/policy/tool-faces`. */
export type PolicyToolFaceQueryScope = "instance" | "workspace";

/**
 * `DomainView` from the CP policy admin API (PLAN-0328 M1).
 *
 * `effectiveLayer` is the highest configured layer for the domain (`builtin` when no persisted
 * layer configures it); `ruleCounts` only lists layers that hold at least one rule.
 */
export interface PolicyDomainView {
    actionClass: string;
    effectiveLayer: ApprovalPolicySourceLayer;
    configuredLayers: PolicyRuleLayer[];
    ruleCounts: Partial<Record<PolicyRuleLayer, number>>;
}

/**
 * `RuleView` from the CP policy admin API (PLAN-0328 M1).
 *
 * `effective` means this rule's layer is the domain's effective layer — it does NOT mean the
 * rule matched at runtime. `conflict` carries the server's static conflict note (for example an
 * allow shadowed by a more specific deny) and is null when the row has none.
 */
export interface PolicyRuleView {
    id: string;
    layer: PolicyRuleLayer;
    ownerId: string | null;
    actionClass: string;
    resource: string;
    effect: ApprovalPolicyEffect;
    priority: number;
    locked: boolean;
    effective: boolean;
    conflict: string | null;
}

/**
 * `FaceView` from the CP policy admin API (PLAN-0328 M1).
 *
 * Built-in catalog rows use `id: null`, `scope: 'builtin'` and `ownerId: null`. Persisted
 * instance/workspace rows override built-ins for the same tool; an unclassified third-party tool
 * is absent until its first approval request.
 */
export interface PolicyToolFaceView {
    id: string | null;
    scope: PolicyToolFaceScope;
    ownerId: string | null;
    tool: string;
    actionClass: string;
    shape: ApprovalPolicyShape;
}

export interface AttachmentFile {
    id: string;
    name: string;
    type: string;
    size: number;
    url: string;
    state: "idle" | "uploading" | "processing" | "error" | "done";
    fileId?: string;
}

export type MessagePart =
    | { type: "text"; content: string }
    | { type: "reasoning"; content: string }
    | { type: "citation"; index: number }
    | {
          type: "artifact";
          identifier: string;
          artifactType: string;
          title: string;
          content: string;
      };

/**
 * PLAN-0665 M2 / V120：一条消息的**投递语义**。
 *
 * 两代形状共存（兼容期）：
 *  - **durable**（`messages.delivery` jsonb，跨刷新仍在）：`{ to: string[], cc: string[] }`，
 *    只含 participantId，名字走花名册解析；@ 不在此列（正文重建）。无 TO 无 CC ⇒ 字段为 null。
 *  - **legacy 本地发送态**（V120 之前乐观消息）：`toParticipantId`/`ccParticipantIds`；
 *    仅在 durable 缺失时作为回落，`resolveDelivery` 负责优先级。
 */
export interface MessageDelivery {
    /** V120 durable：显式 TO 集合（participantId）；若调用方只给 asParticipantId，CP 回落为该单值。 */
    to?: string[];
    /** V120 durable：抄送集合（participantId）。 */
    cc?: string[];
    /** @deprecated legacy 本地发送态：单值 TO；durable `to` 存在时不读它。 */
    toParticipantId?: string | null;
    /** @deprecated legacy 本地发送态：单值 cc 名单；durable `cc` 存在时不读它。 */
    ccParticipantIds?: string[];
}

export interface Message {
    id: string;
    sessionId: string;
    role: "user" | "assistant" | "system";
    /** @deprecated Use `parts` instead. Kept for backward compat with old data. */
    content: string;
    parts?: MessagePart[];
    timestamp: string;
    toolCalls?: ToolCall[];
    isStreaming?: boolean;
    attachments?: AttachmentFile[];
    branchId?: string;
    marker?: "status" | "date" | "tool";
    status?: string;
    runId?: string;
    runStatus?: ChatRunResponse["status"] | "interrupted";
    terminalOutcome?: "success" | "error" | "partial" | "ambiguous" | "cancelled";
    errorCode?: string;
    error?: string;
    retryable?: boolean;
    /** PLAN-0622 Resource Governor（429 RESOURCE_EXHAUSTED）：建议等待秒数与资源种类。 */
    retryAfterSeconds?: number;
    resourceKind?: string;
    /** PLAN-0341 U3 case B: prior attempt content kept but marked abandoned. */
    interrupted?: boolean;
    /**
     * PLAN-0631 D31-08: the session participant CP attributed this message to — the
     * SSE envelope's `participantId` for live runs (openapi.yaml:1374), or the
     * `asParticipantId` the caller asked to speak as. **Local view only**: the history
     * DTO carries no attribution yet (BL-197), so `undefined` means "unknown" and the
     * UI must not fill it in from `role` or the session's PRIMARY participant.
     */
    participantId?: string | null;
    /**
     * PLAN-0665 M2 / V120: 投递语义（TO/CC）。**durable**：历史 DTO 已带
     * `messages.delivery`，刷新后徽标仍在；V120 之前的乐观消息仍写 legacy 形状。
     * 读侧优先级由 `resolveDelivery` 统一：durable `to`/`cc` 优先，缺失才回落 legacy 单值。
     */
    delivery?: MessageDelivery;
}

export interface ProviderConfig {
    provider: string;
    apiKey: string;
    baseUrl?: string;
}

export interface ModelConfig {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
}

export interface ProviderInfo {
    id: string;
    name: string;
    defaultBaseUrl: string;
    description?: string;
}

export interface ThemeConfig {
    mode: "dark" | "light" | "system";
}

export interface MCPConfig {
    configJson: string;
}

export interface SessionModelBinding {
    provider: string;
    model: string;
    connectionId?: string;
    connectionRevision?: number;
}

export interface ModelFavorite {
    provider: string;
    model: string;
}

export type Language = "zh-CN" | "en-US";

export type SSEEventType =
    | "token"
    | "tool_call"
    | "tool_result"
    | "derived_state_changed"
    | "approval_request"
    | "status"
    | "error"
    | "done";

export interface SSEEvent {
    type: SSEEventType;
    data: Record<string, unknown>;
}

export interface ChatRunResponse {
    origin: "user_submission";
    status:
        | "queued"
        | "accepted"
        | "dispatching"
        | "running"
        | "streaming"
        | "awaiting_approval"
        | "cancelling"
        | "succeeded"
        | "failed"
        | "partial"
        | "ambiguous"
        | "cancelled";
    sessionId: string;
    runId: string;
    messageId?: string;
    outcome?: "success" | "error" | "partial" | "ambiguous";
    errorCode?: string;
    /**
     * PLAN-0631 D31-04: why a run is parked instead of dispatched. CP answers
     * `202 {status:"queued", reason:"agent_down"}` when the Agent is down but the
     * LLM is ready (ChatController `persistRunStatus(chatRun,"queued")` path); the
     * Run is then held for transport recovery and **nothing is executing**.
     * Wire field: `docs/api/openapi.yaml` → `ChatRunResponse.reason`.
     */
    reason?: string;
}

/**
 * Safe policy verdict snapshot carried by MCP invocation/audit detail.
 * Exactly the server-projected fields; `matchedRule` / `mode` / `allowedBy` are nullable and
 * absent for legacy rows or non-MCP paths. The projection never contains raw arguments.
 *
 * `reused` is the T1.7 session-fingerprint annotation: `true` means this dispatch was authorized
 * by an exact session reuse (never a verdict effect of its own); `null` (or an absent key on
 * legacy V19 snapshots) means reuse was not applicable. The view must not infer reuse otherwise.
 */
export interface SafePolicySummaryView {
    effect: ApprovalPolicyEffect;
    sourceLayer: ApprovalPolicySourceLayer;
    matchedRule: string | null;
    reason: string;
    mode: ApprovalPolicyMode;
    allowedBy: string | null;
    actionClass: string;
    shape: ApprovalPolicyShape;
    reused?: boolean | null;
}

/**
 * PLAN-0466: the audit read model — one row of the CP `v_audit_entries` view.
 *
 * The user tier never carries `userId` / `idempotencyKey` / `requestId` /
 * `runtimeJobId` / raw arguments; those exist only on the internal service surface.
 */
export type AuditEntryType = "chat_run" | "workspace_job" | "mcp_invocation" | "approval";

export interface AuditEntry {
    /** Four-domain type tag of the entry. */
    type: AuditEntryType;
    /** Domain primary key (chat_runs.id / workspace_jobs.id / mcp_invocations.id / approval_requests.request_id). */
    id: string;
    sessionId?: string | null;
    workspaceId?: string | null;
    runId?: string | null;
    /** Native domain status/state vocabulary (displayed as recorded). */
    status: string;
    /** Non-sensitive list title: chat_run → model, mcp_invocation/approval → tool name. */
    summary?: string | null;
    source?: string | null;
    errorCode?: string | null;
    scope?: string | null;
    cancelReason?: string | null;
    toolCallId?: string | null;
    approvalRequestId?: string | null;
    terminalOutcome?: string | null;
    createdAt?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    /** Safe verdict snapshot on mcp_invocation/approval details; absent when unreadable. */
    policy?: SafePolicySummaryView;
    approved?: boolean | null;
    decisionKind?: string | null;
}

/** One row of the four append-only history tables; `payload` text is never projected. */
export interface AuditTimelineEvent {
    sequence: number;
    eventType: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    actorType?: string | null;
    terminalOutcome?: string | null;
    cancelReason?: string | null;
    errorCode?: string | null;
    attemptId?: string | null;
    approved?: boolean | null;
    decisionKind?: string | null;
    createdAt?: string | null;
}

/** User-tier mcp attempt view (no httpStatus, no resultRef). */
export interface AuditAttemptView {
    id: string;
    invocationId?: string | null;
    stage: string;
    retryNo?: number | null;
    module?: string | null;
    status: string;
    errorCode?: string | null;
    durationMs?: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
}

/** Owner-facing detail: entry + that domain's history timeline (+ attempts for mcp). */
export interface AuditEntryDetail {
    entry: AuditEntry;
    timeline: AuditTimelineEvent[];
    attempts: AuditAttemptView[];
}

export interface AuditListResponse {
    entries: AuditEntry[];
    page: number;
    size: number;
    totalElements: number;
    totalPages: number;
}

/** Query parameters of `GET /api/v1/audit/entries`. */
export interface AuditListFilters {
    sessionId?: string;
    workspaceId?: string;
    type?: AuditEntryType | "";
    status?: string;
    page?: number;
    size?: number;
}

export interface AgentState {
    status: "idle" | "thinking" | "executing" | "awaiting_approval" | "error";
    currentToolCall: ToolCall | null;
    pendingApprovals: ApprovalRequest[];
}

export interface ChatSessionRunState {
    runId?: string;
    status: AgentState["status"];
}

// ── PLAN-0343: run-terminal usage snapshot (single event, before done) ───────
// cost=null + costSource="unmapped" means the model has no pricing entry; the
// UI renders an explicit "unmapped" marker instead of a fabricated zero.
export interface ChatRunUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedInputTokens?: number;
    source?: "real" | "estimated" | "fallback";
    model?: string;
    cost?: number | null;
    costCurrency?: string;
    costSource?: "price_table" | "provider_reported" | "unmapped";
    costNote?: string | null;
}

// ── PLAN-0339: workspace checkpoint slices ───────────────────────────────────
// The workspace owns one append-only slice timeline. A Run is only source metadata;
// restore operations always target an opaque `sliceRef`.
// Timeline rows are refreshed after restore so the visible state stays durable.

export type WorkspaceCheckpointState = "captured" | "abnormal-captured" | "degraded" | "expired";
export type WorkspaceCheckpointRevertState = "none" | "rolled_back" | "partial" | "failed";

export interface WorkspaceCheckpointChangedFile {
    status: string;
    path: string;
}

export interface WorkspaceCheckpointRevertCounts {
    restored?: number;
    deleted?: number;
    failed?: number;
}

export interface WorkspaceCheckpointRevertView {
    state: WorkspaceCheckpointRevertState;
    at: string | null;
    counts: WorkspaceCheckpointRevertCounts | null;
    ref: string | null;
    attemptCount?: number;
}

/** Item returned by `GET /api/v1/workspaces/{workspaceId}/checkpoints`. */
export interface WorkspaceCheckpoint {
    id: string;
    sliceRef: string | null;
    capturedAt: string | null;
    sourceRunId: string | null;
    sourceSessionId: string | null;
    predecessorRef: string | null;
    state: WorkspaceCheckpointState;
    changedCount: number;
    /** The list may be capped; `changedCount` remains the complete count. */
    changedFiles: WorkspaceCheckpointChangedFile[];
    opaqueNestedRepos: string[];
    unrollableReason: string | null;
    truncated: boolean;
    revert: WorkspaceCheckpointRevertView | null;
}

/** SSE lifecycle annotation used to refresh the workspace slice timeline. */
export interface WorkspaceCheckpointEvent {
    runId: string;
    sessionId: string;
    state: WorkspaceCheckpointState;
    changedCount: number;
    sliceRef?: string | null;
    capturedAt?: string | null;
    unrollableReason?: string;
    revert?: WorkspaceCheckpointRevertView | null;
}

export type CheckpointPreviewAction = "restore" | "delete";
export type CheckpointPreviewEntryState = "execute" | "noop" | "type_conflict";

export interface CheckpointPreviewEntry {
    path: string;
    action: CheckpointPreviewAction;
    state: CheckpointPreviewEntryState;
    reason?: string;
}

export interface CheckpointPreviewCounts {
    restore: number;
    delete: number;
    typeConflict: number;
}

/** `POST .../checkpoints/revert/preview` response. */
/** PLAN-0641 M3 (T4.3): one undeclared nested repository touched by a restore. */
export interface CheckpointNestedRepoAffected {
    /** Workspace-relative POSIX path of the repository root. */
    repoPath: string;
    kind: string;
    /** Uncommitted changes in the repo; a restore needs `force` to overwrite them. */
    dirty: boolean;
    /** Clean repo whose restored content differs from its current HEAD tree. */
    headMoved: boolean;
}

export interface CheckpointPreview {
    sliceRef: string;
    counts: CheckpointPreviewCounts;
    entries: CheckpointPreviewEntry[];
    truncated: boolean;
    opaqueNestedRepos: string[];
    /** PLAN-0641 M3 (T4.3): cross-root impact of this restore plan. */
    nestedRepoAffected?: CheckpointNestedRepoAffected[];
}

export type CheckpointResultOutcome = "restored" | "deleted" | "failed" | "suspect";

export interface CheckpointResultEntry {
    path: string;
    outcome: CheckpointResultOutcome;
    reason?: string;
}

export interface CheckpointResultCounts {
    restored: number;
    deleted: number;
    failed: number;
}

/** `POST .../checkpoints/revert` response. */
export interface CheckpointResult {
    sliceRef: string;
    counts: CheckpointResultCounts;
    entries: CheckpointResultEntry[];
    durationMs: number;
    suspects: string[];
}

/** Type-change paths explicitly confirmed by the user before restore. */
export interface CheckpointRestoreConfirmation {
    acknowledgeTypeChanges: string[];
}

export interface CheckpointCleanupResult {
    removed: boolean;
}

export interface WorkspaceGitStatusEntry {
    status: string;
    path: string;
}

/** `GET /api/v1/workspaces/{id}/git-status` (dual-diff "待提交" side). */
export interface WorkspaceGitStatus {
    isRepository: boolean;
    entries: WorkspaceGitStatusEntry[];
}

/** `GET .../checkpoints/retention` response (decision #10 constants + counts). */
export interface CheckpointRetention {
    maxRuns: number;
    ttlDays: number;
    unsealedNeverDeleted: boolean;
    currentRuns: number;
    currentRefs: number;
}

export type LangChainEventType =
    | "on_chat_model_start"
    | "on_chat_model_stream"
    | "on_llm_end"
    | "on_tool_start"
    | "on_tool_end"
    | "on_tool_error"
    | "on_chain_start"
    | "on_chain_end";

export interface LangChainEvent {
    event: LangChainEventType;
    name?: string;
    data?: Record<string, unknown>;
    run_id?: string;
}

/**
 * PLAN-0610 W3-2b decision #22: the wire no longer carries a `role` string. `/auth/me`, the login /
 * register / local-login responses and `GET /api/v1/me/permissions` all use this projection, so the
 * UI decides "who may administer" from capabilities instead of comparing role names.
 */
export interface UserCapabilities {
    /** `cap:instance:admin` — instance administration (settings, instance config layers, ...). */
    isInstanceAdmin: boolean;
    /** `cap:instance:super` — the full-permission system role (implies {@link isInstanceAdmin}). */
    isInstanceSuper: boolean;
    /** Workspace ids the subject administers (`workspace:admin` bindings, stable sorted). */
    workspaceAdminOf: string[];
}

export const EMPTY_USER_CAPABILITIES: UserCapabilities = {
    isInstanceAdmin: false,
    isInstanceSuper: false,
    workspaceAdminOf: [],
};

export interface User {
    id: string;
    email: string;
    /** PLAN-0581: stable handle shown by the admin surface. */
    username?: string;
    name?: string;
    /** PLAN-0614：账号可能没有任何工作区（注册不再自动创建），此时为 null。 */
    workspaceId?: string | null;
    /** PLAN-0610: capability projection; absent on a cached pre-upgrade user until refreshed. */
    capabilities?: UserCapabilities;
}

export interface FileNode {
    name: string;
    path: string;
    type: "file" | "directory";
    mimeType?: string;
    size?: number;
    modified?: string;
    children?: FileNode[];
}

export type WorkspaceStorageMode = "managed_import" | "direct_attach";
export type WorkspaceExecutionMode = "docker" | "windows-mxc" | "windows-host";

/** Execution modes a direct-attach binding can preflight (Docker is postponed). */
export type WorkspaceDirectAttachExecutionMode = "windows-mxc" | "windows-host";

/** Backend maturity vocabulary reported by Runtime capability snapshots. */
export type WorkspaceBackendMaturity = "stable" | "preview" | "experimental";

/**
 * `POST /api/v1/workspaces/capabilities/preflight` result (PLAN-0384).
 * A reachable Runtime always answers `available` (possibly `false` with a `reason`);
 * an unreachable Runtime is a `502 RUNTIME_UNAVAILABLE` instead of a body.
 */
export interface WorkspaceCapabilityPreflight {
    contractVersion: string;
    backendKind: string;
    backendRevision: string;
    maturity: WorkspaceBackendMaturity;
    executionMode: WorkspaceDirectAttachExecutionMode;
    available: boolean;
    reason?: string | null;
    diagnostics?: Record<string, unknown>;
    checkedAt: string;
}

/** Durable job lifecycle scope (`spec/execution-job-contract.md` §Scope 收口). */
export type WorkspaceJobScope = "run" | "session" | "workspace";

/** Execution backend identity; legacy/MCP-projected archives may carry `null`. */
export type WorkspaceJobBackendKind = "docker" | "windows-mxc" | "windows-host";

export type WorkspaceJobStatus =
    | "pending"
    | "running"
    | "succeeded"
    | "cancelled"
    | "timeout"
    | "orphaned"
    | "interrupted";

/** Frozen cancel vocabulary; `null` while a job has not been cancelled. */
export type WorkspaceJobCancelReason =
    | "user_cancel"
    | "scope_run_end"
    | "scope_session_stop"
    | "workspace_destroy"
    | "runtime_restart"
    | "destroy_orphan"
    | "job_missing";

export type WorkspaceJobCleanupStatus = "not_started" | "running" | "completed" | "failed";

/**
 * Workspace Job projection (`GET/POST /api/v1/workspaces/{workspaceId}/jobs`).
 * PLAN-0465 decision #7：身份字段是 domain `jobId`（`workspace_jobs.id`），
 * `runtimeJobId` 是 Runtime backend handle（诊断/输出目录操作用）；
 * The Job contract uses the domain jobId only; no Ledger identifiers are exposed.
 * Every projection key is present; nullable value fields use `null` rather than omission.
 */
export interface WorkspaceJob {
    jobId: string;
    runtimeJobId: string | null;
    workspaceId: string;
    sessionId: string | null;
    runId: string | null;
    source: string;
    scope: WorkspaceJobScope;
    status: WorkspaceJobStatus;
    startedAt: string | null;
    endedAt: string | null;
    exitCode: number | null;
    timeoutSecs: number | null;
    cancelReason: WorkspaceJobCancelReason | null;
    backendKind: WorkspaceJobBackendKind | null;
    executionMode: WorkspaceExecutionMode | null;
    actorType: string | null;
    createdAt: string | null;
    cleanupStatus: WorkspaceJobCleanupStatus | null;
    errorCode: string | null;
}

/** Body of `POST /api/v1/workspaces/{workspaceId}/jobs` (wire camelCase). */
export interface WorkspaceJobStartRequest {
    command: string;
    args: string[];
    cwd?: string;
    timeoutSecs?: number;
    scope?: WorkspaceJobScope;
    sessionId?: string;
    runId?: string;
    source?: string;
    env?: Record<string, string>;
}

export interface WorkspaceEnvironment {
    workspaceId: string;
    status: string;
    storageBackend: string;
    storageRef: string;
    storageMode: WorkspaceStorageMode;
    hostPath: string | null;
    executionMode: WorkspaceExecutionMode;
    capability?: {
        contractVersion: string;
        backendKind: string;
        backendRevision: string;
        maturity: "stable" | "experimental";
        executionMode: WorkspaceExecutionMode;
        available: boolean;
        reason?: string;
        diagnostics?: Record<string, unknown>;
    };
    /**
     * PLAN-0396：Job 可用性来自 Runtime capabilities（单一事实源）。字段缺省表示
     * CP 未上报（旧版本/探测未接入），UI 按「能力未知」禁用启动。
     */
    jobCapability?: {
        backendKind: string;
        backendRevision?: string;
        maturity?: string;
        executionMode?: WorkspaceExecutionMode;
        canStart?: boolean;
        canCancel?: boolean;
        canStreamOutput?: boolean;
        canIsolateFilesystem?: boolean;
        available?: boolean;
        unavailableReason?: string | null;
        checkedAt?: string;
    };
    executionSpec?: {
        status: string;
        generation: number;
        sandboxSpecHash: string;
    };
    assignment?: {
        status: string;
        generation: number;
        sandboxSpecHash: string;
    };
    runtime: {
        status: string;
        deviceId: string;
        lastHeartbeatAt: string;
        materializationState?: string;
        lastError?: string;
        /** PLAN-0391: non-terminal Job count (explains 409 WORKSPACE_BUSY). */
        activeJobCount?: number;
        /** PLAN-0391: id of the most recent release operation (or null). */
        releaseOperationId?: string | null;
        /** PLAN-0391: release/unavailable reason. */
        reason?: string | null;
    };
}

/** PLAN-0391: durable "release execution resources" operation. */
export interface WorkspaceReleaseOperation {
    releaseOperationId: string;
    workspaceId: string;
    status: "accepted" | "running" | "completed" | "failed" | "interrupted";
    reason: string | null;
    errorCode: string | null;
    createdAt: string | null;
    endedAt: string | null;
}

export type WorkspaceEventKind =
    | "workspace_status"
    | "file_changed"
    | "snapshot_required"
    | "workspace_event_error"
    | "scheduled_tasks_changed"
    | "heartbeat";

export interface WorkspaceEvent {
    workspaceId: string;
    sequence: number;
    kind: WorkspaceEventKind;
    path?: string;
    changeType?: string;
    source: string;
    reason?: string;
    status?: string;
    /**
     * PLAN-0639 M2: the declared root that owns `path` (Runtime event attribution,
     * design D39-6). Absent on legacy single-root events; the primary root
     * (root[0].id == workspace.id) is implied then.
     */
    rootId?: string;
}

export interface OpenFile {
    path: string;
    name: string;
    content: string;
    originalContent: string;
    language: string;
    modified: boolean;
    loading: boolean;
    truncated?: boolean;
    chunks?: string[];
    chunkIndex?: number;
    externalChange?: {
        sequence: number;
        changeType: string;
    };
}

export interface UploadItem {
    file: File;
    name: string;
    size: number;
    status: "pending" | "uploading" | "done" | "error" | "cancelled";
    targetPath: string;
    error?: string;
}

export type ViewMode = "single" | "scrollable" | "dual";

/** PLAN-0489 T2.1: scheduled-task read DTO (openapi `ScheduledTask`, 17 camelCase fields). */
export type ScheduledTaskStatus =
    | "scheduled"
    | "firing"
    | "missed"
    | "expired"
    | "cancelled"
    | "completed";

export type ScheduledTaskTriggerKind = "delay_once" | "cron";

export type ScheduledTaskTargetKind = "session_wakeup" | "job_dispatch";

export type ScheduledTaskMissedReason = "target_gone" | "dispatch_failed" | "overdue_grace";

export interface ScheduledTaskCreatedBy {
    name: string | null;
    type: "human" | "agent";
}

export interface ScheduledTask {
    id: string;
    triggerKind: ScheduledTaskTriggerKind;
    cronExpr: string | null;
    timezone: string;
    targetKind: ScheduledTaskTargetKind;
    targetSessionId: string | null;
    /** Truncated to 120 characters in list items; the detail route returns the full text. */
    prompt: string | null;
    status: ScheduledTaskStatus;
    nextFireAt: string | null;
    expiresAt: string | null;
    missedCount: number;
    lastMissedAt: string | null;
    missedReason: ScheduledTaskMissedReason | null;
    lastRunId: string | null;
    createdBy: ScheduledTaskCreatedBy;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface ScheduledTaskCreateRequest {
    triggerKind: ScheduledTaskTriggerKind;
    cronExpr?: string;
    timezone?: string;
    targetKind: ScheduledTaskTargetKind;
    targetSessionId?: string;
    prompt?: string;
    payload?: { command: string; args?: string[]; cwd?: string; timeoutSecs?: number };
    /** delay_once only: future ISO-8601 UTC instant within the 7d TTL. */
    at?: string;
}

export interface ScheduledTaskListPage {
    workspaceId: string;
    page: number;
    size: number;
    tasks: ScheduledTask[];
}

export interface ScheduledTaskDisposeResult {
    taskId: string;
    status: ScheduledTaskStatus;
    /** false when the task was already cancelled (idempotent remove/delete). */
    changed: boolean;
    task: ScheduledTask;
}

export interface ThemeContext {
    theme: Ref<"light" | "dark">;
    colorMode: Ref<"light" | "dark" | "system">;
    setColorMode: (mode: "light" | "dark" | "system") => void;
}

export const ThemeInjectionKey: InjectionKey<ThemeContext> = Symbol("theme");

// ---- PLAN-0498 credential manager (consumes the PLAN-0496/0497 API surface) ----

export type CredentialKind = "token" | "key_pair";
export type CredentialDeliveryTier = "lease" | "reveal";
export type CredentialOwnerType = "USER" | "WORKSPACE";
export type CredentialStatus = "active" | "disabled";

/** Sanitized credential metadata — never carries ciphertext, suffixes or values. */
export interface CredentialSummary {
    id: string;
    label: string;
    kind: CredentialKind;
    deliveryTier: CredentialDeliveryTier;
    ownerType: CredentialOwnerType;
    ownerId: string;
    status: CredentialStatus;
    fingerprint: string;
    revision: number;
    createdAt?: string | null;
    replacedAt?: string | null;
    referenceCount: number;
}

export interface CredentialListResponse {
    credentials: CredentialSummary[];
    count: number;
}

export interface CredentialCreateRequest {
    ownerType?: CredentialOwnerType;
    ownerId?: string;
    label: string;
    kind: CredentialKind;
    deliveryTier: CredentialDeliveryTier;
    token?: string;
    accessKey?: string;
    secretKey?: string;
}

export interface CredentialReplaceRequest {
    token?: string;
    accessKey?: string;
    secretKey?: string;
}

export interface CredentialReference {
    source: "grant" | "workspace_cap";
    subjectType: string;
    subjectId: string;
    actionClass: string;
    resource: string;
}

export interface CredentialReferencesResponse {
    references: CredentialReference[];
}

export interface CredentialDeleteReport {
    id: string;
    deleted: boolean;
    references: CredentialReference[];
}

export interface CredentialBindPayload {
    workspaceId: string;
    agentPrincipalIds: string[];
}

export interface CredentialBindResult {
    credentialId: string;
    agentPrincipalIds: string[];
    bound: boolean;
}

export interface CredentialRevealResponse {
    credentialId: string;
    revision: number;
    /** The plaintext for this response only; the UI never persists it. */
    value: string;
}

export interface CredentialEventView {
    id: string;
    eventType: string;
    actor: string;
    createdAt: string;
}

export interface CredentialEventsResponse {
    events: CredentialEventView[];
}
