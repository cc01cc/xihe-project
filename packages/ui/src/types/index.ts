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
    modelProvider?: string;
    modelName?: string;
    providerConnectionId?: string;
    connectionRevision?: number;
    context?: SessionContext;
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
    /** Operation ledger item id; resume key for the job-output endpoint. */
    itemId: string;
    toolCallId?: string;
    toolName?: string;
    jobId?: string;
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
    status: "running" | "completed" | "failed" | "pending";
    result?: string;
    error?: string;
    startedAt?: string;
    completedAt?: string;
    diagnostics?: DiagnosticsBundle;
    /** PLAN-0344: durable job archival summary restored from the messages DTO after refresh. */
    jobSummary?: JobSummary;
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

export interface ApprovalPolicy {
    effect: ApprovalPolicyEffect;
    sourceLayer: ApprovalPolicySourceLayer;
    matchedRule: string | null;
    reason: string;
    mode: ApprovalPolicyMode;
    modeAtGrant?: ApprovalPolicyMode;
    actionClass: string;
    shape: ApprovalPolicyShape;
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
    operationId?: string;
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
    marker?: "status" | "date" | "tool";
    status?: string;
    runId?: string;
    operationId?: string;
    runStatus?: ChatRunResponse["status"] | "interrupted";
    terminalOutcome?: "success" | "error" | "partial" | "ambiguous";
    errorCode?: string;
    error?: string;
    retryable?: boolean;
    /** PLAN-0341 U3 case B: prior attempt content kept but marked abandoned. */
    interrupted?: boolean;
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
    defaultModel: string;
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
    operationId?: string;
    messageId?: string;
    outcome?: "success" | "error" | "partial" | "ambiguous";
    errorCode?: string;
}

export type OperationStatus =
    | "accepted"
    | "running"
    | "waiting_for_approval"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "ambiguous";

export interface OperationSummary {
    id: string;
    sessionId?: string | null;
    workspaceId?: string | null;
    runId?: string | null;
    kind: string;
    source: string;
    actorType: string;
    status: OperationStatus | string;
    summary?: string | null;
    errorCode?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    createdAt?: string | null;
}

/**
 * Safe policy verdict snapshot carried by operation items (PLAN-0328 T1.15, spec ui-ux §3.5).
 * Exactly the server-projected fields; `matchedRule` / `mode` / `allowedBy` are nullable and
 * absent for legacy rows or non-MCP paths. The projection never contains raw arguments.
 *
 * `reused` is the T1.7 session-fingerprint annotation: `true` means this dispatch was authorized
 * by an exact session reuse (never a verdict effect of its own); `null` (or an absent key on
 * legacy V19 snapshots) means reuse was not applicable. The view must not infer reuse otherwise.
 */
export interface OperationPolicyView {
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

export interface OperationItemView {
    id: string;
    operationId: string;
    toolCallId?: string | null;
    sequence: number;
    kind: string;
    toolName?: string | null;
    source: string;
    policyDecision?: string | null;
    policy?: OperationPolicyView;
    approvalRequestId?: string | null;
    status: string;
    errorCode?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
}

export interface OperationAttemptView {
    id: string;
    itemId: string;
    stage: string;
    retryNo: number;
    parentAttemptId?: string | null;
    module: string;
    status: string;
    errorCode?: string | null;
    durationMs?: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
}

export interface OperationEventView {
    id: string;
    operationId: string;
    itemId?: string | null;
    attemptId?: string | null;
    sequence: number;
    eventType: string;
    state: string;
    actor: string;
    createdAt?: string | null;
}

export interface OperationListResponse {
    operations: OperationSummary[];
    page: number;
    size: number;
    totalElements: number;
    totalPages: number;
}

export interface OperationTrace {
    operation: OperationSummary;
    items: OperationItemView[];
    attempts: OperationAttemptView[];
    events: OperationEventView[];
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
export interface CheckpointPreview {
    sliceRef: string;
    counts: CheckpointPreviewCounts;
    entries: CheckpointPreviewEntry[];
    truncated: boolean;
    opaqueNestedRepos: string[];
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

export interface User {
    id: string;
    email: string;
    name?: string;
    workspaceId?: string;
    /** CP role name (`ADMIN` / `USER`); drives the instance settings entry (PLAN-0307 T2.17). */
    role?: string;
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
 * Every projection key is present; nullable value fields use `null` rather than omission.
 */
export interface WorkspaceJob {
    operationId: string;
    operationItemId: string;
    workspaceId: string;
    sessionId: string | null;
    runId: string | null;
    source: string;
    scope: WorkspaceJobScope;
    status: WorkspaceJobStatus;
    jobId: string | null;
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
    };
}

export type WorkspaceEventKind =
    | "workspace_status"
    | "file_changed"
    | "snapshot_required"
    | "workspace_event_error"
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

export interface ThemeContext {
    theme: Ref<"light" | "dark">;
    colorMode: Ref<"light" | "dark" | "system">;
    setColorMode: (mode: "light" | "dark" | "system") => void;
}

export const ThemeInjectionKey: InjectionKey<ThemeContext> = Symbol("theme");
