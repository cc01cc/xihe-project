import type {
    ApprovalDecision,
    ApprovalDecisionKind,
    ApprovalGuardAdvisor,
    ApprovalHooksSection,
    ApprovalPolicy,
    ApprovalPolicyEffect,
    ApprovalPolicyMode,
    ApprovalPolicyShape,
    ApprovalPolicySourceLayer,
    ApprovalRequest,
    AuditEntry,
    AuditEntryDetail,
    AuditEntryType,
    AuditListFilters,
    AuditListResponse,
    AuditTimelineEvent,
    AuditAttemptView,
    CheckpointCleanupResult,
    CheckpointNestedRepoAffected,
    CheckpointPreview,
    CheckpointPreviewAction,
    CheckpointPreviewCounts,
    CheckpointPreviewEntry,
    CheckpointPreviewEntryState,
    CheckpointRetention,
    CheckpointResult,
    CheckpointResultCounts,
    CheckpointResultEntry,
    CredentialBindPayload,
    CredentialBindResult,
    CredentialCreateRequest,
    CredentialDeleteReport,
    CredentialEventsResponse,
    CredentialListResponse,
    CredentialOwnerType,
    CredentialReferencesResponse,
    CredentialReplaceRequest,
    CredentialRevealResponse,
    CredentialSummary,
    SafePolicySummaryView,
    PolicyDomainView,
    PolicyModeUpdateResponse,
    PolicyRuleLayer,
    PolicyRuleView,
    PolicyToolFaceQueryScope,
    PolicyToolFaceView,
    PendingApprovalSummary,
    RunTraceCompleteness,
    RunTraceEvent,
    RunTraceEventKind,
    RunTraceEventStatus,
    RunTraceProvenance,
    RunTraceResponse,
    RunTraceSourceName,
    RunTraceSourceStatus,
    RunTraceUsage,
    RunTransportAttemptsResponse,
    SessionDerivedStateResponse,
    SessionRunsResponse,
    SessionMonitorResponse,
    SessionPolicyMode,
    SessionPolicyModeState,
    WorkspaceGitStatus,
    WorkspaceCheckpoint,
    WorkspaceCheckpointChangedFile,
    WorkspaceCheckpointEvent,
    WorkspaceCheckpointRevertCounts,
    WorkspaceCheckpointRevertState,
    WorkspaceCheckpointRevertView,
    WorkspaceEvent,
    WorkspaceEnvironment,
    WorkspaceReleaseOperation,
    WorkspaceJob,
    WorkspaceJobStartRequest,
    WorkspaceExecutionMode,
    WorkspaceStorageMode,
    WorkspaceCapabilityPreflight,
    WorkspaceDirectAttachExecutionMode,
    ScheduledTask,
    ScheduledTaskCreateRequest,
    ScheduledTaskDisposeResult,
    ScheduledTaskListPage,
} from "../types";
import type {
    ParticipantRespondPolicy as RespondPolicy,
    ParticipantWakePolicy as WakePolicy,
    SessionParticipantCapabilities,
    SessionParticipantListResponse,
    SessionParticipantView,
} from "../types/participant";
import { clearTabWorkspace, readTabWorkspaceId } from "../lib/workspaceContext";

const API_BASE = "/api/v1";

export interface ProblemDetails {
    type?: string;
    title?: string;
    status: number;
    code: string;
    detail?: string;
    requestId: string;
    /** PLAN-0555: field-level validation/conflict target (for example `label`). */
    field?: string;
    runId?: string;
    provider?: string;
    model?: string;
    retryable?: boolean;
    outcome?: string;
    /** PLAN-0622 Resource Governor：429 时 CP 给出的建议等待秒数（header `Retry-After` 同源）。 */
    retryAfterSeconds?: number;
    /** 资源种类：CONNECTION / MODEL / FILE_WRITE / PROCESS / JOB / MCP —— 用于更准确的话术。 */
    resourceKind?: string;
}

export interface ApiWorkspaceRoot {
    id: string;
    alias: string | null;
    position: number;
    /** PLAN-0641 B12: workspace-relative POSIX path (nullable — primary root / no host visibility). */
    path?: string | null;
}

/** PLAN-0641 F4: one discovery entry of the nested-repos read face. */
export type ApiNestedRepoKind = "nested" | "gitdir" | "submodule" | "bare" | "symlink";

export interface ApiNestedRepoItem {
    /** Workspace-relative POSIX path (B12: display it whole — rootId is the key, not the name). */
    path: string;
    type: ApiNestedRepoKind;
    declared: boolean;
}

export interface ApiNestedReposView {
    workspaceId: string;
    cachedAt: string;
    items: ApiNestedRepoItem[];
}

export interface ApiWorkspace {
    id: string;
    name: string;
    description?: string | null;
    /** CP workspace owner (used to gate owner-only actions such as tool classification). */
    ownerId?: string;
    storageBackend?: string;
    storageRef?: string;
    storageMode?: WorkspaceStorageMode;
    hostPath?: string | null;
    /** PLAN-0639 M1: ordered root projection [{id, alias, position}]. */
    roots?: ApiWorkspaceRoot[];
    executionMode?: WorkspaceExecutionMode;
    workspaceRole?: "OWNER" | "EDITOR" | "VIEWER" | null;
    canWrite?: boolean;
    createdAt?: string;
    updatedAt?: string;
}

/**
 * PLAN-0610 W3-2b decision #22: capability projection carried by `/auth/me` and the auth responses
 * (`CapabilitiesView` on the wire). The retired `role` string is never read by the UI again.
 */
export interface ApiUserCapabilities {
    isInstanceAdmin: boolean;
    isInstanceSuper: boolean;
    workspaceAdminOf: string[];
}

/** `/auth/me`, the login/register/local-login `user` object. */
export interface ApiAuthUser {
    id: string;
    email: string;
    username?: string;
    name?: string;
    workspaceId?: string | null;
    capabilities?: ApiUserCapabilities;
}

/** PLAN-0565: member view from /workspaces/{id}/members (spec §2; role is canonical). */
export interface ApiWorkspaceMember {
    userId: string;
    username: string;
    email: string;
    name: string | null;
    role: "OWNER" | "EDITOR" | "VIEWER";
    createdAt: string;
}

export type MemberAssignableRole = "EDITOR" | "VIEWER";

/**
 * PLAN-0610 W3-2a: the role/binding administration surface (`/api/v1/roles`, `/api/v1/bindings`).
 *
 * <p>`scopeClass` is the atom's SSOT classification: `instance` atoms are only meaningful on an
 * instance binding, `both` atoms work on either scope. The UI groups the catalog by it and never
 * keeps its own vocabulary copy.</p>
 */
export type ApiAtomScopeClass = "instance" | "both";

export interface ApiRoleAtom {
    name: string;
    scopeClass: ApiAtomScopeClass;
    capability: boolean;
    resource: string;
    /**
     * 服务端按 `?locale` 解析好的显示标签（PLAN-0651 D51-37）。UI 不自建原子词表，
     * 只渲染这个字段；缺省时回退到 `name`（服务端保证非空）。
     */
    displayName?: string;
}

export interface ApiRoleCatalog {
    atoms: ApiRoleAtom[];
    scopes: string[];
}

/** 当前 locale（`<html lang>` 由 `applyLocale` 写入，是 UI 侧唯一 SSOT），用于服务端解析标签。 */
function catalogLocale(): string {
    const lang = typeof document === "undefined" ? "" : document.documentElement.lang;
    return (lang ?? "").toLowerCase().startsWith("en") ? "en-US" : "zh-CN";
}

export interface ApiRole {
    id: string;
    name: string;
    displayName: string;
    description: string | null;
    system: boolean;
    atoms: ApiRoleAtom[];
    bindingCount: number;
}

/** `POST /roles` and `PATCH /roles/{id}` body (PATCH: null = unchanged, system roles: display only). */
export interface ApiRoleWrite {
    name?: string | null;
    displayName?: string | null;
    description?: string | null;
    atoms?: string[] | null;
}

export type ApiBindingScope = "instance" | "workspace";

export interface ApiBindingRow {
    id: string;
    subjectType: string;
    subjectId: string;
    roleId: string;
    roleName: string;
    grantedBy: string | null;
    grantedAt: string | null;
}

export interface ApiBindingSet {
    scopeType: string;
    scopeId: string | null;
    bindings: ApiBindingRow[];
}

export interface ApiBindingInput {
    subjectType?: string;
    subjectId: string;
    roleId: string;
}

/** `GET /api/v1/users` row (admin directory; the `role` string is gone since W3-2b). */
export interface ApiAdminUser {
    id: string;
    email: string;
    username?: string;
    name?: string;
    capabilities?: ApiUserCapabilities;
    status?: string;
}

export interface ApiSession {
    id: string;
    title: string;
    workspaceId?: string;
    agentPrincipalId?: string | null;
    createdAt?: string;
    updatedAt?: string;
    /** OpenAPI `Session.required`: archived is contract-required (PLAN-0668 M2). */
    archived?: boolean;
    /** PLAN-0655 T1.5: delegation projection — `SPAWN` = delegated child session. */
    kind?: string | null;
    spawnedFromSessionId?: string | null;
    /** PLAN-0668 D3: optional lineage (exists on the wire/DB, not required by UI). */
    spawnedFromRunId?: string | null;
    spawnedAt?: string | null;
    modelProvider?: string;
    modelName?: string;
    providerConnectionId?: string;
    connectionRevision?: number;
    contextTemplateLayer?: "instance" | "user" | "workspace" | null;
    contextTemplateId?: string | null;
    contextTemplateVersion?: number | null;
}

export interface SessionBindingPatch {
    title?: string;
    modelProvider?: string;
    modelName?: string;
    providerConnectionId?: string;
    connectionRevision?: number;
    contextTemplateLayer?: "instance" | "user" | "workspace";
    contextTemplateId?: string;
    contextTemplateVersion?: number;
    confirmedTypeChange?: boolean;
}

export interface ApiSessionBranch {
    branchId: string;
    parentBranchId: string | null;
    forkPointMessageId: string | null;
    forkPointRunId: string | null;
    createdAt: string;
}

/**
 * PLAN-0635 M3: one row of `GET /api/v1/sessions/{sessionId}/commands`.
 *
 * `reason` is deliberately a plain `string`: availability is decided by CP and a new reason value
 * must not break an older UI. The known values are mapped to localized copy (with a fallback key)
 * in `features/workspace/chat/composables/useSessionCommands.ts`.
 */
export interface SessionCommandView {
    name: string;
    source: "builtin";
    available: boolean;
    reason: string | null;
}

export interface SessionCommandListResponse {
    commands: SessionCommandView[];
}

/** PLAN-0635 M3: `POST /sessions/{sessionId}/compact` response (manual compaction event). */
export interface SessionCompactResponse {
    sequence: number;
    eventType: string;
    createdAt: string;
}

export interface ApiFollowUpAttachment {
    id: string;
    name: string;
    type: string | null;
    size: number;
    url?: string | null;
}

export interface ApiFollowUpItem {
    queueItemId: string;
    queueSequence: number;
    status: "queued" | "paused" | "admitted" | "completed" | "withdrawn";
    content: string | null;
    attachments: ApiFollowUpAttachment[];
    branchId: string;
    anchorRunId: string | null;
    pauseReason: string | null;
    childRunId: string | null;
    childMessageId: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ApiFollowUpQueueSnapshot {
    sessionId: string;
    queueState: "empty" | "queued" | "paused";
    outstandingCount: number;
    capacityLimit: number;
    pauseReason: string | null;
    items: ApiFollowUpItem[];
}

export interface ApiFollowUpCreateRequest {
    content: string;
    attachments?: string[];
    branchId: string;
    toolMode?: "none" | "workspace";
    toolTimeouts?: Record<string, number>;
    provider?: string;
    model?: string;
}

export interface ChatRunGuidanceCreateResult {
    id: string;
    runId: string;
    sessionId: string;
    sequence: number;
    status: string;
    createdAt: string;
}

export interface ChatRunGuidanceItem {
    id: string;
    sequence: number;
    sourceKind: string;
    status: string;
    createdAt: string;
    consumedAt: string | null;
    terminalExpiredAt: string | null;
    authorPrincipalId: string;
    content: string;
}

export interface ChatRunGuidanceSnapshot {
    items: ChatRunGuidanceItem[];
    latestSequence: number;
}

function normalizeGuidanceItem(payload: unknown): ChatRunGuidanceItem | null {
    const record = asRecord(payload);
    if (!record || typeof record.id !== "string" || typeof record.sequence !== "number") {
        return null;
    }
    return {
        id: record.id,
        sequence: record.sequence,
        sourceKind: typeof record.sourceKind === "string" ? record.sourceKind : "user",
        status: typeof record.status === "string" ? record.status : "pending",
        createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
        consumedAt: typeof record.consumedAt === "string" ? record.consumedAt : null,
        terminalExpiredAt:
            typeof record.terminalExpiredAt === "string" ? record.terminalExpiredAt : null,
        authorPrincipalId:
            typeof record.authorPrincipalId === "string" ? record.authorPrincipalId : "",
        content: typeof record.content === "string" ? record.content : "",
    };
}

function normalizeGuidanceSnapshot(payload: unknown): ChatRunGuidanceSnapshot {
    const record = asRecord(payload);
    const rawItems = record && Array.isArray(record.items) ? record.items : [];
    const items = rawItems
        .map((item) => normalizeGuidanceItem(item))
        .filter((item): item is ChatRunGuidanceItem => item !== null);
    items.sort((a, b) => a.sequence - b.sequence);
    return {
        items,
        latestSequence:
            record && typeof record.latestSequence === "number" ? record.latestSequence : 0,
    };
}

function normalizeGuidanceCreateResult(
    payload: unknown,
    runId: string,
): ChatRunGuidanceCreateResult {
    const record = asRecord(payload);
    if (!record || typeof record.id !== "string") {
        throw new Error("Invalid guidance create response: missing id");
    }
    return {
        id: record.id,
        runId: typeof record.runId === "string" ? record.runId : runId,
        sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
        sequence: typeof record.sequence === "number" ? record.sequence : 0,
        status: typeof record.status === "string" ? record.status : "pending",
        createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    };
}

export interface SessionBranchCreateResponse {
    branchId: string;
    parentBranchId: string;
    forkPointMessageId: string;
}

export interface SessionResponse extends ApiSession {
    /** Normalized Session always carries the contract-required boolean (D4 fail-closed). */
    archived: boolean;
    workspace?: ApiWorkspace;
}

export interface SessionListResponse {
    sessions: SessionResponse[];
    workspace?: ApiWorkspace;
}

/**
 * PLAN-0622 冻结契约：agent 主体三档共享范围。
 * - `PERSONAL`：属于某个用户的私有 agent（创建需 `CREATE_OWN_AGENT`）；
 * - `WORKSPACE`：工作区共享（创建/绑定需 `MANAGE_WORKSPACE_AGENTS`）；
 * - `INSTANCE`：实例通用（创建需 `CREATE_ACCOUNT`，仅 ADMIN）。
 */
export type AgentPrincipalScope = "PERSONAL" | "WORKSPACE" | "INSTANCE";

/** 列表行上的来源标签：这条绑定是"本工作区/个人/实例"的 agent。 */
export type WorkspaceAgentSource = "workspace" | "personal" | "instance";

/**
 * PLAN-0625 M2（D25-09/14）：agent 主体的 hook 订阅（V96 `agent_principals.hooks`）。
 *
 * **wire 形状（单一事实源：CP `HookAdvisorRegistry`）**：
 * `{"advisors":[{"kind":"<开放串>","on":["approval.ask"]}]}` —— 动作类在**每个 advisor 的 `on`** 里，
 * 顶层没有 `on` 字段（Gap：UI 曾经读顶层 `on`，因此订阅行永远只有 kind）。
 * `null` = 无订阅。kind 之外的 config 字段 UI 只读透传，不解释（D25-10 插件缝）。
 */
export interface AgentPrincipalHookAdvisor {
    kind: string;
    /** 该 advisor 订阅的动作类（CP 精确等值匹配；白名单今天只有 `approval.ask`）。 */
    on: string[];
}

export interface AgentPrincipalHooks {
    advisors: AgentPrincipalHookAdvisor[];
}
/** agent 只声明模型**意图**（provider + model），不绑死具体连接（凭证运行时解析）。 */
export interface AgentModelRef {
    provider: string;
    model: string;
}

/**
 * PLAN-0655 (contract 8a546e3f): read-only delegation budget view of the Session's delegation
 * root. Resolved at the same evaluation point as the budget gate — never a second reader.
 */
export interface DelegationUsageView {
    rootSessionId: string;
    usedSessions: number;
    maxCount: number;
    currentDepth: number;
    maxDepth: number;
    principalId: string | null;
    principalName: string | null;
    policySource: "subject" | "code-defaults";
    /** `maxCount = 0` — the root's delegation policy disables delegation (ruling A1). */
    disabled: boolean;
}

/** 201 answer of POST /sessions/{id}/delegation-spawn. */
export interface DelegationSpawnResult {
    childSessionId: string;
    childRunId?: string | null;
    rootSessionId: string;
    chainDepth: number;
    budget: DelegationUsageView;
}

/** 202 answer — a pending ChatApproval; re-post with the same Idempotency-Key plus its grant header. */
export interface DelegationSpawnAccepted {
    approvalRequestId: string;
    statusUrl: string;
    retryHeader: "X-Xihe-Approval-Request-Id";
}

export interface WorkspaceAgentBinding {
    principalId: string;
    name: string;
    templateId: string | null;
    templateName: string | null;
    createdAt: string;
    /** PLAN-0622（CP `13e54cad`）：`permissions` 已改名 `permissionsSnapshot`，且 `source` 必填。 */
    permissionsSnapshot: Array<{ actionClass: string; resource?: string }>;
    source: WorkspaceAgentSource;
    /**
     * PLAN-0622 D26（CP `4dbd3e92`）：该行是否已绑定到本工作区。列表是"三类并集"，
     * 未绑定的 PERSONAL/INSTANCE 也会出现，但它们**不能**用来建会话（CP 403 not bound）。
     */
    bound: boolean;
    /** PLAN-0622 D27（CP `f6d66e0d`）：该主体是否已被禁用；禁用后不能建会话（409）。 */
    disabled: boolean;
    scope?: AgentPrincipalScope;
    ownerUserId?: string | null;
    defaultModelProvider?: string | null;
    defaultModelName?: string | null;
    /** `null`/缺省 = 不限制可用模型集。 */
    allowedModels?: AgentModelRef[] | null;
    /** PLAN-0625 M3（V96）：hook 订阅；`null`/缺省 = 无订阅（不渲染订阅行）。 */
    hooks?: AgentPrincipalHooks | null;
    /**
     * 主体 `contextPolicy`（CP `AgentPrincipalView`）。UI 只为「启用记忆」开关读写它的
     * `memory.enabled`：PATCH 是**整对象替换**，所以必须与这里的现值合并后再发。
     */
    contextPolicy?: Record<string, unknown> | null;
}

/**
 * 主体记忆（`GET /api/v1/workspaces/{ws}/agents/{pid}/memories`）。
 *
 * 用户裁定（2026-11-03）：CP 正在迁移**删除 `type` 列**，UI 不再有 profile/fact 分类；
 * 条目只呈现内容 / 置顶 / 更新时间 / 来源。`origin`（`manual|run`）由 CP 补进 view 后才出现，
 * **字段缺即不渲染**（不回落到默认值、不猜）。
 */
export type WorkspaceAgentMemoryType = "profile" | "fact";

export interface WorkspaceAgentMemory {
    id: string;
    pinned: boolean;
    /** ISO-8601 instant（CP 写入时的时间戳，UI 只负责本地化显示）。 */
    updatedAt: string;
    /** 已归一化的存储文本；UI 只做展示截断/滚动，不改写内容。 */
    content: string;
    /**
     * 来源：`manual`（用户手动维护）/ `run`（运行过程产生）。
     * CP 尚未透出时缺省；未知取值同样不渲染（fail-closed，不猜）。
     */
    origin?: WorkspaceAgentMemoryOrigin;
}

export type WorkspaceAgentMemoryOrigin = "manual" | "run";

/**
 * PLAN-0667 M3：agent 主体的**角色绑定**（`GET /api/v1/agent-principals/{id}/roles`）。
 *
 * 契约（Lead 2026-11-05 冻结，camelCase，信封 `{items:[…]}`）：
 * - `isSystem` 决定 🔒 与「无解绑按钮」（种子绑定由 CP 409 ROLE_BINDING_EXCEEDS_CAP | ROLE_BINDING_IMMUTABLE 兜底）；
 * - `atomSummary` = **字符串标签数组（≤3）**，`atomCount` = 总数，`atomsTruncated` 表示被截断；
 *   UI 只渲染「摘要 + 总数」，**不展开全集**（D5(b)）。
 */
export interface AgentRoleBinding {
    bindingId: string;
    roleId: string;
    name: string;
    displayName?: string | null;
    scopeType: string;
    scopeId?: string | null;
    scopeName?: string | null;
    isSystem: boolean;
    /** 绑定的授予者（wire 已有；UI 只展示短 ID，不请求用户资料）。 */
    grantedBy?: string | null;
    atomSummary: string[];
    atomCount: number;
    atomsTruncated: boolean;
}

/** PLAN-0667 M3：agent 主体的**技能绑定**（`GET /api/v1/agent-principals/{id}/skills`，v1 principal 级）。 */
export interface AgentSkillBinding {
    bindingId: string;
    skillId: string;
    name: string;
    description?: string | null;
    sourceType?: string | null;
    sourceName?: string | null;
    tokenEstimate?: number | null;
}

/** 可绑定技能（`GET /api/v1/skills` 的 `items[]` 投影，仅取 UI 需要的最小字段）。 */
export interface AgentSkillSummary {
    skillId: string;
    name: string;
    definitionScope?: { type: string; workspaceId?: string | null } | null;
}

/**
 * 记忆写入入参（`{content, pinned}`；`type` 随 CP 删列一并去掉）。
 *
 * 写成功与否**不看响应体**：成功后调用方重新 GET 列表（权威源是 CP 的读取面），
 * 因此 CP 若换返回体信封，UI 不会因解析失败而误报成功/失败。
 */
export interface WorkspaceAgentMemoryInput {
    content: string;
    pinned: boolean;
}

/** 归档视图过滤（`?status=`）：`active` 默认，`retired` 已归档，`all` 两者。 */
export type WorkspaceAgentMemoryStatus = "active" | "retired" | "all";

export interface AgentPrincipalCreateInput {
    name: string;
    templateId?: string;
    scope?: AgentPrincipalScope;
    defaultModelProvider?: string;
    defaultModelName?: string;
    /** `undefined` = 不限制；空数组也按"不限制"处理，避免误锁死。 */
    allowedModels?: AgentModelRef[];
}

export interface AgentPrincipalCreateResponse {
    principalId: string;
    templateId: string | null;
    templateName: string | null;
    createdAt: string;
    scope?: AgentPrincipalScope;
    ownerUserId?: string | null;
    defaultModelProvider?: string | null;
    defaultModelName?: string | null;
    allowedModels?: AgentModelRef[] | null;
}

export interface AgentTemplateSummary {
    id: string;
    name: string;
    description?: string;
    systemPrompt: string;
    toolMode: "none" | "workspace";
    provider?: string;
    model?: string;
    roleId?: string;
}

export interface AgentTemplateLayerResponse {
    layer: "instance" | "user" | "workspace";
    workspaceId: string | null;
    templates: AgentTemplateSummary[];
}

export interface WorkspaceAgentPermission {
    actionClass: string;
    resource?: string;
}

/** CP 的 `GET /api/v1/me/permissions` 投影（PLAN-0621 F-01：前端唯一的权威能力来源）。 */
export interface SelfPermissionsView {
    userId: string;
    instanceCapabilities: string[];
    instancePermissions: Array<{ actionClass: string; resource: string }>;
    workspaces?: Array<{
        workspaceId: string;
        workspaceRole?: string;
        workspaceAdmin?: boolean;
        permissions?: Array<{ actionClass: string; resource: string }>;
    }>;
}

export interface WorkspaceAgentCapResponse {
    principalId: string;
    workspaceId: string;
    permissions: WorkspaceAgentPermission[];
}

export interface ChatApprovalDecisionResponse {
    status: "accepted" | "already_decided";
    requestId: string;
    approved: boolean;
    decision?: ApprovalDecisionKind;
    propagated?: number;
    modeAtGrant?: ApprovalPolicyMode;
    rule?: {
        layer: "session" | "workspace" | "user";
        actionClass: string;
        resource: string;
        effect: "allow" | "deny";
    };
}

type JsonRecord = Record<string, unknown>;

const approvalPolicyEffects = ["allow", "ask", "deny"] as const,
    approvalPolicySourceLayers = [
        "builtin",
        "instance",
        "user",
        "workspace",
        "session",
        "per_call",
    ] as const,
    approvalPolicyModes = ["manual", "auto"] as const,
    approvalPolicyShapes = ["structured", "interpreter", "opaque"] as const,
    policyRuleLayers = ["instance", "user", "workspace"] as const,
    policyToolFaceScopes = ["builtin", "instance", "workspace"] as const;

function isEnumValue<T extends string>(value: unknown, values: readonly T[]): value is T {
    return typeof value === "string" && values.includes(value as T);
}

function asRecord(value: unknown): JsonRecord | null {
    return typeof value === "object" && value !== null ? (value as JsonRecord) : null;
}

/**
 * PLAN-0625 M3：principal hooks 订阅的 fail-closed 解析（**唯一**归一处：组件不得再解析形状）。
 * wire 形状：`null` = 无订阅；对象含 `advisors[]`，每项 `{kind, on}` —— 动作类在 **advisor 的 `on`**
 * 里（不是顶层）。畸形 → 告警并视为无订阅（只读展示不渲染猜测的形状）。
 */
function normalizePrincipalHooks(value: unknown): AgentPrincipalHooks | null {
    if (value === null || value === undefined) return null;
    // Gap I 的旧 CP 投影把 hooks 降级成 `[]`：语义就是“无订阅”，不告警也不渲染。
    if (Array.isArray(value) && value.length === 0) return null;
    const record = asRecord(value);
    if (!record || Array.isArray(record) || !Array.isArray(record.advisors)) {
        console.warn("[agents] principal hooks malformed; treated as no subscriptions");
        return null;
    }
    const advisors: AgentPrincipalHookAdvisor[] = [];
    for (const entry of record.advisors) {
        const advisor = asRecord(entry);
        if (!advisor || typeof advisor.kind !== "string" || advisor.kind === "") {
            console.warn("[agents] principal hooks advisor malformed; treated as no subscriptions");
            return null;
        }
        const on = advisor.on;
        if (
            on !== undefined &&
            (!Array.isArray(on) || on.some((item) => typeof item !== "string"))
        ) {
            console.warn(
                "[agents] principal hooks advisor 'on' malformed; treated as no subscriptions",
            );
            return null;
        }
        advisors.push({ kind: advisor.kind, on: on === undefined ? [] : [...(on as string[])] });
    }
    return { advisors };
}
/**
 * 记忆行严格解析（与 hooks 同一条 fail-closed 纪律），但**不再要求 `type`**：
 * CP 正在删该列，仍要求它就是"契约前进了而 UI 没跟上"。
 * `origin` 只在取值受支持时保留，未知/缺失一律不渲染。
 */
function normalizeWorkspaceAgentMemory(value: unknown): WorkspaceAgentMemory | null {
    const record = asRecord(value);
    if (
        !record ||
        typeof record.id !== "string" ||
        record.id === "" ||
        typeof record.pinned !== "boolean" ||
        typeof record.updatedAt !== "string" ||
        record.updatedAt === "" ||
        typeof record.content !== "string"
    ) {
        console.warn("[agents] memory row malformed; skipped");
        return null;
    }
    const origin =
        record.origin === "manual" || record.origin === "run" ? record.origin : undefined;
    return {
        id: record.id,
        pinned: record.pinned,
        updatedAt: record.updatedAt,
        content: record.content,
        ...(origin ? { origin } : {}),
    };
}
/**
 * PLAN-0625 G：policySummary 的 versioned `hooks` 段（守卫/顾问建议）。
 * 严格带版本（D23-25 同源）：`version === 1` 才读；无 version / 未知版本 / 形状不符
 * ⇒ **整段丢弃** + console.warn（fail-closed：宁可少显示，不显示猜测的形状）。
 */
function normalizeApprovalHooks(value: unknown): ApprovalHooksSection | undefined {
    const record = asRecord(value);
    if (!record) return undefined;
    if (record.version !== 1) {
        // 未知版本 = 契约前进了而 UI 没跟上：显式告警，不渲染猜测的形状。
        console.warn(`[approval] unknown policySummary hooks version: ${String(record.version)}`);
        return undefined;
    }
    if (!Array.isArray(record.advisors)) {
        console.warn("[approval] policySummary hooks section malformed: advisors missing");
        return undefined;
    }
    const advisors: ApprovalGuardAdvisor[] = [];
    for (const entry of record.advisors) {
        const advisor = asRecord(entry);
        if (
            !advisor ||
            typeof advisor.kind !== "string" ||
            advisor.kind === "" ||
            !(advisor.verdict === "approve" || advisor.verdict === "deny") ||
            typeof advisor.reason !== "string" ||
            typeof advisor.at !== "string" ||
            advisor.at === ""
        ) {
            console.warn("[approval] policySummary hooks advisor malformed; dropping the section");
            return undefined;
        }
        advisors.push({
            kind: advisor.kind,
            verdict: advisor.verdict,
            reason: advisor.reason,
            at: advisor.at,
        });
    }
    return { version: 1, advisors };
}
function normalizeApprovalPolicy(value: unknown): ApprovalPolicy | undefined {
    const record = asRecord(value);
    if (
        !record ||
        !isEnumValue(record.effect, approvalPolicyEffects) ||
        !isEnumValue(record.sourceLayer, approvalPolicySourceLayers) ||
        typeof record.reason !== "string" ||
        typeof record.actionClass !== "string" ||
        !isEnumValue(record.shape, approvalPolicyShapes) ||
        !(record.matchedRule === null || typeof record.matchedRule === "string") ||
        !(record.mode === null || isEnumValue(record.mode, approvalPolicyModes)) ||
        !(
            record.modeAtGrant === undefined ||
            record.modeAtGrant === null ||
            isEnumValue(record.modeAtGrant, approvalPolicyModes)
        )
    ) {
        return undefined;
    }

    return {
        effect: record.effect as ApprovalPolicyEffect,
        sourceLayer: record.sourceLayer as ApprovalPolicySourceLayer,
        matchedRule: record.matchedRule as string | null,
        reason: record.reason,
        mode: record.mode as ApprovalPolicyMode,
        ...(record.modeAtGrant !== undefined
            ? { modeAtGrant: record.modeAtGrant as ApprovalPolicyMode }
            : {}),
        actionClass: record.actionClass,
        shape: record.shape as ApprovalPolicyShape,
        ...(normalizeApprovalHooks(record.hooks)
            ? { hooks: normalizeApprovalHooks(record.hooks)! }
            : {}),
    };
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

const runTraceSources = [
        "chat_run",
        "context_event",
        "provider_attempt",
        "mcp_invocation",
        "runtime_job",
    ] as const,
    runTraceSourceStatuses = ["complete", "unavailable", "not_applicable", "unknown"] as const,
    runTraceCompletenessValues = ["complete", "partial", "unknown"] as const,
    runTraceEventKinds = [
        "run.lifecycle",
        "input.admitted",
        "context.source",
        "agent.tool",
        "provider.attempt",
        "mcp.invocation",
        "runtime.job",
        "usage.recorded",
    ] as const,
    runTraceEventStatuses = [
        "created",
        "queued",
        "running",
        "awaiting_approval",
        "completed",
        "failed",
        "cancelled",
        "admitted",
        "resolved",
        "missing",
        "rejected",
        "stale",
        "started",
        "succeeded",
        "pending",
        "ambiguous",
        "recorded",
        "estimated",
        "unknown",
    ] as const,
    runTraceReferenceNames = [
        "contextEventId",
        "attemptId",
        "toolCallId",
        "mcpInvocationId",
        "runtimeJobId",
    ] as const;

const runTraceStatusesByKind: Record<RunTraceEventKind, readonly RunTraceEventStatus[]> = {
    "run.lifecycle": [
        "created",
        "queued",
        "running",
        "awaiting_approval",
        "completed",
        "failed",
        "cancelled",
        "unknown",
    ],
    "context.source": ["resolved", "missing", "rejected", "stale", "unknown"],
    "input.admitted": ["admitted"],
    "agent.tool": ["started", "succeeded", "failed", "unknown"],
    "provider.attempt": ["started", "succeeded", "failed", "unknown"],
    "mcp.invocation": ["started", "succeeded", "failed", "pending", "ambiguous", "unknown"],
    "runtime.job": ["queued", "running", "completed", "failed", "cancelled", "unknown"],
    "usage.recorded": ["recorded", "estimated", "unknown"],
};

function nullableCount(value: unknown): number | null {
    return typeof value === "number" &&
        Number.isInteger(value) &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? value
        : null;
}

function safeTraceIdentifier(value: unknown): string | null {
    return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value)
        ? value
        : null;
}

function safeProviderModelId(value: unknown): string | null {
    return typeof value === "string" &&
        value.length > 0 &&
        value.length <= 128 &&
        /^[A-Za-z0-9_.:/-]+$/.test(value)
        ? value
        : null;
}

function normalizeRunTraceUsage(value: unknown): RunTraceUsage | null {
    if (value === null || value === undefined) return null;
    const record = asRecord(value);
    if (!record) return null;
    return {
        inputTokens: nullableCount(record.inputTokens),
        outputTokens: nullableCount(record.outputTokens),
        totalTokens: nullableCount(record.totalTokens),
    };
}

function normalizeRunTraceEvent(value: unknown): RunTraceEvent {
    const record = asRecord(value);
    const eventId = record ? safeTraceIdentifier(record.eventId) : null;
    if (
        !record ||
        eventId === null ||
        !isNonEmptyString(record.occurredAt) ||
        !isEnumValue(record.source, runTraceSources) ||
        !isEnumValue(record.kind, runTraceEventKinds)
    ) {
        throw new Error("Invalid run trace event");
    }

    const status = record.status;
    if (
        status !== null &&
        (!isEnumValue(status, runTraceEventStatuses) ||
            !runTraceStatusesByKind[record.kind].includes(status))
    ) {
        throw new Error("Invalid run trace status");
    }

    const rawReferences = asRecord(record.references),
        references: RunTraceEvent["references"] = {};
    if (rawReferences) {
        for (const name of runTraceReferenceNames) {
            const reference = safeTraceIdentifier(rawReferences[name]);
            if (reference !== null) references[name] = reference;
        }
    }

    const rawToolName = record.toolName,
        toolName =
            typeof rawToolName === "string" &&
            rawToolName.length <= 128 &&
            /^[A-Za-z0-9_.:-]+$/.test(rawToolName)
                ? rawToolName
                : null,
        rawErrorCode = record.errorCode,
        errorCode = safeTraceIdentifier(rawErrorCode);

    if (record.kind === "input.admitted") {
        const referenceNames = rawReferences ? Object.keys(rawReferences) : [];
        if (
            record.source !== "context_event" ||
            status !== "admitted" ||
            referenceNames.length !== 1 ||
            referenceNames[0] !== "contextEventId" ||
            references.contextEventId === undefined ||
            eventId !== `context_event:${references.contextEventId}` ||
            record.durationMs !== null ||
            record.toolName !== null ||
            record.providerId !== null ||
            record.modelId !== null ||
            record.errorCode !== null ||
            record.usage !== null
        ) {
            throw new Error("Invalid input admission event");
        }
    }

    return {
        eventId,
        occurredAt: record.occurredAt,
        source: record.source,
        kind: record.kind,
        status: status as RunTraceEventStatus | null,
        durationMs: nullableCount(record.durationMs),
        toolName,
        providerId: safeProviderModelId(record.providerId),
        modelId: safeProviderModelId(record.modelId),
        errorCode,
        usage: normalizeRunTraceUsage(record.usage),
        references,
    };
}

function safeUuid(value: unknown): string | null {
    return typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        ? value.toLowerCase()
        : null;
}

function positiveCount(value: unknown): number | null {
    const parsed = nullableCount(value);
    return parsed !== null && parsed > 0 ? parsed : null;
}

function normalizeRunTraceProvenance(value: unknown): RunTraceProvenance {
    const record = asRecord(value);
    if (!record || !isEnumValue(record.status, runTraceCompletenessValues)) {
        throw new Error("Invalid run trace provenance");
    }

    const providerConnectionId = safeUuid(record.providerConnectionId),
        connectionRevision = nullableCount(record.connectionRevision),
        apiTypeId = safeTraceIdentifier(record.apiTypeId),
        apiTypeVersion = positiveCount(record.apiTypeVersion),
        contextTemplateLayer = isEnumValue(record.contextTemplateLayer, [
            "instance",
            "user",
            "workspace",
        ] as const)
            ? record.contextTemplateLayer
            : null,
        contextTemplateId = safeUuid(record.contextTemplateId),
        contextTemplateVersion = positiveCount(record.contextTemplateVersion);

    const values = [
        providerConnectionId,
        connectionRevision,
        apiTypeId,
        apiTypeVersion,
        contextTemplateLayer,
        contextTemplateId,
        contextTemplateVersion,
    ];
    const present = values.filter((item) => item !== null).length,
        expectedStatus =
            present === 0 ? "unknown" : present === values.length ? "complete" : "partial";
    if (record.status !== expectedStatus) {
        throw new Error("Invalid run trace provenance status");
    }

    return {
        status: expectedStatus,
        providerConnectionId,
        connectionRevision,
        apiTypeId,
        apiTypeVersion,
        contextTemplateLayer,
        contextTemplateId,
        contextTemplateVersion,
    };
}

function normalizeRunTraceResponse(value: unknown): RunTraceResponse {
    const record = asRecord(value);
    if (
        !record ||
        !isNonEmptyString(record.runId) ||
        !isNonEmptyString(record.asOf) ||
        !isEnumValue(record.completeness, runTraceCompletenessValues) ||
        !asRecord(record.provenance) ||
        !Array.isArray(record.sources) ||
        !Array.isArray(record.events) ||
        !(
            record.nextCursor === null ||
            (typeof record.nextCursor === "string" && record.nextCursor.length <= 1024)
        )
    ) {
        throw new Error("Invalid run trace response");
    }

    const sources = record.sources.map((value) => {
        const source = asRecord(value);
        if (
            !source ||
            !isEnumValue(source.source, runTraceSources) ||
            !isEnumValue(source.status, runTraceSourceStatuses)
        ) {
            throw new Error("Invalid run trace source");
        }
        return {
            source: source.source as RunTraceSourceName,
            status: source.status as RunTraceSourceStatus,
        };
    });

    return {
        runId: record.runId,
        asOf: record.asOf,
        completeness: record.completeness as RunTraceCompleteness,
        provenance: normalizeRunTraceProvenance(record.provenance),
        sources,
        events: record.events.map(normalizeRunTraceEvent),
        nextCursor: record.nextCursor,
    };
}

/**
 * Strict normalizer for the optional safe policy summary projection.
 * Returns `undefined` when the projection is absent or malformed so the view can show the
 * explicit no-verdict state; it never fabricates defaults (e.g. `mode: 'manual'`) and
 * ignores unknown keys. `reused` (T1.7) is optional and nullable: a legacy snapshot without
 * the key stays keyless, and a non-boolean value makes the whole projection unreadable.
 */
export function normalizeSafePolicySummary(value: unknown): SafePolicySummaryView | undefined {
    const record = asRecord(value);
    if (
        !record ||
        !isEnumValue(record.effect, approvalPolicyEffects) ||
        !isEnumValue(record.sourceLayer, approvalPolicySourceLayers) ||
        !isNonEmptyString(record.reason) ||
        !isNonEmptyString(record.actionClass) ||
        !isEnumValue(record.shape, approvalPolicyShapes) ||
        !(record.matchedRule === null || isNonEmptyString(record.matchedRule)) ||
        !(record.mode === null || isEnumValue(record.mode, approvalPolicyModes)) ||
        !(record.allowedBy === null || isNonEmptyString(record.allowedBy)) ||
        !(
            record.reused === undefined ||
            record.reused === null ||
            typeof record.reused === "boolean"
        )
    ) {
        return undefined;
    }

    return {
        effect: record.effect,
        sourceLayer: record.sourceLayer,
        matchedRule: record.matchedRule,
        reason: record.reason,
        mode: record.mode,
        allowedBy: record.allowedBy,
        actionClass: record.actionClass,
        shape: record.shape,
        ...(record.reused !== undefined ? { reused: record.reused } : {}),
    };
}

/**
 * PLAN-0466 T2.1: normalize an audit detail body — safe `policy` verdicts only
 * plus array-shaped
 * timeline/attempts; anything malformed is dropped rather than guessed at.
 */
function normalizeAuditDetail(value: unknown): AuditEntryDetail {
    const record = asRecord(value),
        entry = asRecord(record?.entry);
    if (!record || !entry) {
        return value as AuditEntryDetail;
    }
    const { policy, ...rest } = entry,
        normalizedPolicy = normalizeSafePolicySummary(policy);
    return {
        ...record,
        entry: normalizedPolicy ? { ...rest, policy: normalizedPolicy } : rest,
        timeline: normalizeAuditTimeline(record.timeline),
        attempts: normalizeAuditAttempts(record.attempts),
    } as unknown as AuditEntryDetail;
}

function normalizeAuditTimeline(timeline: unknown): AuditTimelineEvent[] {
    if (!Array.isArray(timeline)) {
        return [];
    }
    return timeline.filter((event): event is AuditTimelineEvent => {
        const record = asRecord(event);
        return record !== null && typeof record.eventType === "string";
    });
}

function normalizeAuditAttempts(attempts: unknown): AuditAttemptView[] {
    if (!Array.isArray(attempts)) {
        return [];
    }
    return attempts.filter((attempt): attempt is AuditAttemptView => {
        const record = asRecord(attempt);
        return record !== null && typeof record.id === "string" && typeof record.stage === "string";
    });
}

/** PLAN-0466 T2.1: keeps well-formed entries only (mirrors normalizeOperationList). */
function normalizeAuditList(value: unknown): AuditListResponse {
    const record = asRecord(value);
    if (!record) {
        return value as AuditListResponse;
    }
    const entries = Array.isArray(record.entries)
        ? record.entries.filter((item): item is AuditEntry => {
              const entryRecord = asRecord(item);
              return (
                  entryRecord !== null &&
                  typeof entryRecord.id === "string" &&
                  typeof entryRecord.type === "string"
              );
          })
        : [];
    return { ...record, entries } as unknown as AuditListResponse;
}

const approvalStates = [
    "pending",
    "dispatching",
    "approved",
    "rejected",
    "expired",
    "dispatch_unknown",
] as const;

const approvalRequestOrigins = ["cp_gate", "agent_relay"] as const;

function hasField(record: JsonRecord, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

/** Normalize approval payloads from SSE/recovery without inventing policy evidence. */
export function normalizeApprovalRequest(
    value: unknown,
    fallbackSessionId = "",
): ApprovalRequest | null {
    const record = asRecord(value);
    if (!record) return null;
    if (
        fallbackSessionId &&
        typeof record.sessionId === "string" &&
        record.sessionId.length > 0 &&
        record.sessionId !== fallbackSessionId
    )
        return null;
    const requestId = typeof record.requestId === "string" ? record.requestId : "",
        sessionId =
            typeof record.sessionId === "string" && record.sessionId.length > 0
                ? record.sessionId
                : fallbackSessionId;
    if (!requestId || !sessionId) return null;

    const state =
        record.state === undefined
            ? undefined
            : isEnumValue(record.state, approvalStates)
              ? record.state
              : null;
    if (state === null) return null;
    for (const key of ["argumentsHash"]) {
        if (hasField(record, key) && record[key] !== null && typeof record[key] !== "string")
            return null;
    }
    // PLAN-0371: origin is display-only provenance. Unknown values are dropped instead of
    // rejecting the whole request; an explicit null (pre-V25 legacy row) is preserved so the
    // UI can stay quiet without inventing an origin.
    const origin =
        record.origin === null
            ? null
            : isEnumValue(record.origin, approvalRequestOrigins)
              ? record.origin
              : undefined;
    if (
        record.modeAtGrant !== undefined &&
        record.modeAtGrant !== null &&
        !isEnumValue(record.modeAtGrant, approvalPolicyModes)
    )
        return null;
    const policy = record.policy === undefined ? undefined : normalizeApprovalPolicy(record.policy);

    return {
        requestId,
        runId: typeof record.runId === "string" ? record.runId : "",
        sessionId,
        workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : undefined,
        tool: typeof record.tool === "string" ? record.tool : "request_approval",
        action: typeof record.action === "string" ? record.action : "",
        details: typeof record.details === "string" ? record.details : "",
        ...(hasField(record, "argumentsHash")
            ? { argumentsHash: record.argumentsHash as string | null }
            : {}),
        expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : undefined,
        ...(typeof record.replayed === "boolean" ? { replayed: record.replayed } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(origin !== undefined ? { origin } : {}),
        ...(record.modeAtGrant !== undefined
            ? { modeAtGrant: record.modeAtGrant as ApprovalPolicyMode }
            : {}),
        ...(policy ? { policy } : {}),
    };
}

// ── PLAN-0339: workspace checkpoint slice normalizers ────────────────────────
// Unknown states and malformed records are discarded. Only canonical slice fields
// are accepted, so the UI cannot silently infer a restore target.

const workspaceCheckpointStates = ["captured", "abnormal-captured", "degraded", "expired"] as const,
    workspaceCheckpointRevertStates = ["none", "rolled_back", "partial", "failed"] as const,
    checkpointPreviewActions = ["restore", "delete"] as const,
    checkpointPreviewEntryStates = ["execute", "noop", "type_conflict"] as const,
    checkpointResultOutcomes = ["restored", "deleted", "failed", "suspect"] as const;

function asNonNegativeInteger(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function asNullableNonEmptyString(value: unknown): string | null {
    return isNonEmptyString(value) ? value : null;
}

function normalizeWorkspaceCheckpointRevertView(
    value: unknown,
): WorkspaceCheckpointRevertView | null {
    const record = asRecord(value);
    if (!record) return null;
    if (!isEnumValue(record.state, workspaceCheckpointRevertStates)) return null;
    const state: WorkspaceCheckpointRevertState = record.state,
        countsRecord = asRecord(record.counts),
        counts: WorkspaceCheckpointRevertCounts = {};
    if (countsRecord) {
        for (const key of ["restored", "deleted", "failed"] as const) {
            const parsed = asNonNegativeInteger(countsRecord[key]);
            if (parsed !== null) counts[key] = parsed;
        }
    }
    return {
        state,
        at: asNullableNonEmptyString(record.at),
        counts: Object.keys(counts).length > 0 ? counts : null,
        ref: asNullableNonEmptyString(record.ref),
        ...(asNonNegativeInteger(record.attemptCount) !== null
            ? { attemptCount: asNonNegativeInteger(record.attemptCount) as number }
            : {}),
    };
}

function normalizeWorkspaceCheckpointChangedFiles(
    value: unknown,
): WorkspaceCheckpointChangedFile[] {
    if (!Array.isArray(value)) return [];
    const files: WorkspaceCheckpointChangedFile[] = [];
    for (const raw of value) {
        const record = asRecord(raw);
        if (!record || !isNonEmptyString(record.path)) continue;
        files.push({
            path: record.path,
            status: typeof record.status === "string" ? record.status : "",
        });
    }
    return files;
}

function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => isNonEmptyString(item));
}

function nullableString(record: JsonRecord, key: string): string | null {
    return record[key] === null || record[key] === undefined
        ? null
        : asNullableNonEmptyString(record[key]);
}

function normalizeWorkspaceCheckpoint(value: unknown): WorkspaceCheckpoint | null {
    const record = asRecord(value);
    if (!record) return null;
    if (!isNonEmptyString(record.id) || !isEnumValue(record.state, workspaceCheckpointStates))
        return null;
    const sliceRef =
        record.sliceRef === null || record.sliceRef === undefined
            ? null
            : asNullableNonEmptyString(record.sliceRef);
    if (record.sliceRef !== null && record.sliceRef !== undefined && sliceRef === null) return null;
    const capturedAt = nullableString(record, "capturedAt"),
        sourceRunId = nullableString(record, "sourceRunId"),
        sourceSessionId = nullableString(record, "sourceSessionId"),
        predecessorRef = nullableString(record, "predecessorRef"),
        changedFiles = normalizeWorkspaceCheckpointChangedFiles(record.changedFiles),
        changedCount = asNonNegativeInteger(record.changedCount) ?? changedFiles.length,
        revert =
            record.revert === null || record.revert === undefined
                ? null
                : normalizeWorkspaceCheckpointRevertView(record.revert);
    if (record.revert !== null && record.revert !== undefined && !revert) return null;

    return {
        id: record.id,
        sliceRef,
        capturedAt,
        sourceRunId,
        sourceSessionId,
        predecessorRef,
        state: record.state,
        changedCount,
        changedFiles,
        opaqueNestedRepos: normalizeStringList(record.opaqueNestedRepos),
        unrollableReason: nullableString(record, "unrollableReason"),
        truncated: record.truncated === true,
        revert,
    };
}

/** Normalize the workspace list; expired rows are intentionally absent from the timeline. */
export function normalizeWorkspaceCheckpoints(value: unknown): WorkspaceCheckpoint[] {
    if (!Array.isArray(value)) return [];
    return value
        .map(normalizeWorkspaceCheckpoint)
        .filter(
            (checkpoint): checkpoint is WorkspaceCheckpoint =>
                checkpoint !== null && checkpoint.state !== "expired",
        )
        .sort((left, right) => (right.capturedAt ?? "").localeCompare(left.capturedAt ?? ""));
}

/** SSE checkpoint lifecycle annotation; drops events of another session when one is known. */
export function normalizeWorkspaceCheckpointEvent(
    value: unknown,
    fallbackSessionId = "",
): WorkspaceCheckpointEvent | null {
    const record = asRecord(value);
    if (!record) return null;
    if (
        fallbackSessionId &&
        isNonEmptyString(record.sessionId) &&
        record.sessionId !== fallbackSessionId
    )
        return null;
    const runId = isNonEmptyString(record.runId) ? record.runId : "",
        sessionId = isNonEmptyString(record.sessionId) ? record.sessionId : fallbackSessionId;
    if (!runId || !sessionId) return null;
    if (!isEnumValue(record.state, workspaceCheckpointStates)) return null;

    const revert =
        record.revert === undefined || record.revert === null
            ? null
            : normalizeWorkspaceCheckpointRevertView(record.revert);
    if (record.revert !== undefined && record.revert !== null && !revert) return null;
    return {
        runId,
        sessionId,
        state: record.state,
        changedCount: asNonNegativeInteger(record.changedCount) ?? 0,
        ...(record.sliceRef === null || isNonEmptyString(record.sliceRef)
            ? { sliceRef: record.sliceRef as string | null | undefined }
            : {}),
        ...(record.capturedAt === null || isNonEmptyString(record.capturedAt)
            ? { capturedAt: record.capturedAt as string | null | undefined }
            : {}),
        ...(isNonEmptyString(record.unrollableReason)
            ? { unrollableReason: record.unrollableReason }
            : {}),
        ...(revert ? { revert } : {}),
    };
}

function normalizeCheckpointPreviewCounts(value: unknown): CheckpointPreviewCounts | null {
    const record = asRecord(value);
    if (!record) return null;
    const restore = asNonNegativeInteger(record.restore),
        deleted = asNonNegativeInteger(record.delete),
        typeConflict = asNonNegativeInteger(record.typeConflict);
    if (restore === null || deleted === null || typeConflict === null) return null;
    return { restore, delete: deleted, typeConflict };
}

function normalizeCheckpointNestedRepoAffected(
    value: unknown,
): CheckpointNestedRepoAffected | null {
    const record = asRecord(value);
    if (!record || !isNonEmptyString(record.repoPath)) return null;
    return {
        repoPath: record.repoPath,
        kind: typeof record.kind === "string" ? record.kind : "",
        dirty: record.dirty === true,
        headMoved: record.headMoved === true,
    };
}

function normalizeCheckpointPreviewEntry(value: unknown): CheckpointPreviewEntry | null {
    const record = asRecord(value);
    if (!record || !isNonEmptyString(record.path)) return null;
    if (
        !isEnumValue(record.action, checkpointPreviewActions) ||
        !isEnumValue(record.state, checkpointPreviewEntryStates)
    )
        return null;
    return {
        path: record.path,
        action: record.action as CheckpointPreviewAction,
        state: record.state as CheckpointPreviewEntryState,
        ...(isNonEmptyString(record.reason) ? { reason: record.reason } : {}),
    };
}

/** `POST .../checkpoints/revert/preview`; `null` when the payload is unusable. */
export function normalizeCheckpointPreview(value: unknown): CheckpointPreview | null {
    const record = asRecord(value);
    if (!record || !isNonEmptyString(record.sliceRef)) return null;
    const counts = normalizeCheckpointPreviewCounts(record.counts);
    if (!counts) return null;
    const entries: CheckpointPreviewEntry[] = [];
    if (Array.isArray(record.entries)) {
        for (const raw of record.entries) {
            const entry = normalizeCheckpointPreviewEntry(raw);
            if (entry) entries.push(entry);
        }
    }
    const opaqueNestedRepos = Array.isArray(record.opaqueNestedRepos)
        ? record.opaqueNestedRepos.filter(isNonEmptyString)
        : [];
    const nestedRepoAffected: CheckpointNestedRepoAffected[] = [];
    if (Array.isArray(record.nestedRepoAffected)) {
        for (const raw of record.nestedRepoAffected) {
            const nested = normalizeCheckpointNestedRepoAffected(raw);
            if (nested) nestedRepoAffected.push(nested);
        }
    }
    return {
        sliceRef: record.sliceRef,
        counts,
        entries,
        truncated: record.truncated === true,
        opaqueNestedRepos,
        nestedRepoAffected,
    };
}

function normalizeCheckpointResultCounts(value: unknown): CheckpointResultCounts | null {
    const record = asRecord(value);
    if (!record) return null;
    const restored = asNonNegativeInteger(record.restored),
        deleted = asNonNegativeInteger(record.deleted),
        failed = asNonNegativeInteger(record.failed);
    if (restored === null || deleted === null || failed === null) {
        return null;
    }
    return { restored, deleted, failed };
}

function normalizeCheckpointResultEntry(value: unknown): CheckpointResultEntry | null {
    const record = asRecord(value);
    if (!record || !isNonEmptyString(record.path)) return null;
    if (!isEnumValue(record.outcome, checkpointResultOutcomes)) return null;
    return {
        path: record.path,
        outcome: record.outcome,
        ...(isNonEmptyString(record.reason) ? { reason: record.reason } : {}),
    };
}

/** `POST .../checkpoints/revert`; `null` when the payload is unusable. */
export function normalizeCheckpointResult(value: unknown): CheckpointResult | null {
    const record = asRecord(value);
    if (!record || !isNonEmptyString(record.sliceRef)) return null;
    const counts = normalizeCheckpointResultCounts(record.counts);
    if (!counts) return null;
    const entries: CheckpointResultEntry[] = [];
    if (Array.isArray(record.entries)) {
        for (const raw of record.entries) {
            const entry = normalizeCheckpointResultEntry(raw);
            if (entry) entries.push(entry);
        }
    }
    return {
        sliceRef: record.sliceRef,
        counts,
        entries,
        durationMs: asNonNegativeInteger(record.durationMs) ?? 0,
        suspects: normalizeStringList(record.suspects),
    };
}

export function normalizeCheckpointCleanupResult(value: unknown): CheckpointCleanupResult | null {
    const record = asRecord(value);
    if (!record || typeof record.removed !== "boolean") return null;
    return { removed: record.removed };
}

/** `GET /workspaces/{id}/git-status` (dual-diff "待提交" side). */
export function normalizeWorkspaceGitStatus(value: unknown): WorkspaceGitStatus {
    const record = asRecord(value),
        entries: WorkspaceGitStatus["entries"] = [];
    if (record && Array.isArray(record.entries)) {
        for (const raw of record.entries) {
            const entry = asRecord(raw);
            if (!entry || !isNonEmptyString(entry.path)) continue;
            entries.push({
                status: typeof entry.status === "string" ? entry.status : "",
                path: entry.path,
            });
        }
    }
    return { isRepository: record?.isRepository === true, entries };
}

/** `GET .../checkpoints/retention`; malformed payloads throw for the caller to surface. */
export function normalizeCheckpointRetention(value: unknown): CheckpointRetention {
    const record = asRecord(value),
        maxRuns = record ? asNonNegativeInteger(record.maxRuns) : null,
        ttlDays = record ? asNonNegativeInteger(record.ttlDays) : null,
        currentRuns = record ? asNonNegativeInteger(record.currentRuns) : null,
        currentRefs = record ? asNonNegativeInteger(record.currentRefs) : null;
    if (
        !record ||
        maxRuns === null ||
        ttlDays === null ||
        currentRuns === null ||
        currentRefs === null
    ) {
        throw new Error("Invalid checkpoint retention response");
    }
    return {
        maxRuns,
        ttlDays,
        unsealedNeverDeleted: record.unsealedNeverDeleted === true,
        currentRuns,
        currentRefs,
    };
}

function normalizePendingApprovalSummary(value: unknown): PendingApprovalSummary | null {
    const record = asRecord(value),
        count = record?.count;
    if (
        !record ||
        typeof record.sessionId !== "string" ||
        typeof record.workspaceId !== "string" ||
        !Number.isInteger(count) ||
        (count as number) < 0 ||
        (typeof record.oldestRequestedAt !== "string" && count !== 0)
    ) {
        return null;
    }
    return {
        sessionId: record.sessionId,
        workspaceId: record.workspaceId,
        count: count as number,
        oldestRequestedAt:
            typeof record.oldestRequestedAt === "string" ? record.oldestRequestedAt : "",
    };
}

function normalizePolicyModeState(
    value: unknown,
    fallbackSessionId: string,
): SessionPolicyModeState {
    const record = asRecord(value);
    if (
        !record ||
        typeof record.sessionId !== "string" ||
        record.sessionId !== fallbackSessionId ||
        !isEnumValue(record.mode, approvalPolicyModes)
    ) {
        throw new Error("Invalid policy mode response");
    }
    if (
        record.sessionRules !== undefined &&
        (!Number.isInteger(record.sessionRules) || (record.sessionRules as number) < 0)
    ) {
        throw new Error("Invalid policy mode response");
    }
    return {
        sessionId: record.sessionId,
        mode: record.mode as SessionPolicyMode,
        ...(record.sessionRules === undefined
            ? {}
            : { sessionRules: record.sessionRules as number }),
    };
}

function normalizePolicyModeUpdateResponse(
    value: unknown,
    fallbackSessionId: string,
): PolicyModeUpdateResponse {
    const state = normalizePolicyModeState(value, fallbackSessionId),
        record = asRecord(value);
    if (!record || record.scope !== "session") {
        throw new Error("Invalid policy mode update response");
    }
    return {
        sessionId: state.sessionId,
        mode: state.mode,
        scope: "session",
    };
}

function normalizePolicyDomainView(value: unknown): PolicyDomainView {
    const record = asRecord(value);
    if (
        !record ||
        typeof record.actionClass !== "string" ||
        record.actionClass.length === 0 ||
        !isEnumValue(record.effectiveLayer, approvalPolicySourceLayers) ||
        !Array.isArray(record.configuredLayers) ||
        !record.configuredLayers.every((layer) => isEnumValue(layer, policyRuleLayers))
    ) {
        throw new Error("Invalid policy domains response");
    }
    const countsRecord = asRecord(record.ruleCounts);
    if (!countsRecord) throw new Error("Invalid policy domains response");
    const ruleCounts: Partial<Record<PolicyRuleLayer, number>> = {};
    for (const [layer, count] of Object.entries(countsRecord)) {
        if (
            !isEnumValue(layer, policyRuleLayers) ||
            !Number.isInteger(count) ||
            (count as number) < 0
        ) {
            throw new Error("Invalid policy domains response");
        }
        ruleCounts[layer] = count as number;
    }
    return {
        actionClass: record.actionClass,
        effectiveLayer: record.effectiveLayer as ApprovalPolicySourceLayer,
        configuredLayers: [...record.configuredLayers] as PolicyRuleLayer[],
        ruleCounts,
    };
}

function normalizePolicyRuleView(value: unknown): PolicyRuleView {
    const record = asRecord(value);
    if (
        !record ||
        typeof record.id !== "string" ||
        record.id.length === 0 ||
        !isEnumValue(record.layer, policyRuleLayers) ||
        !(record.ownerId === null || typeof record.ownerId === "string") ||
        typeof record.actionClass !== "string" ||
        record.actionClass.length === 0 ||
        typeof record.resource !== "string" ||
        !isEnumValue(record.effect, approvalPolicyEffects) ||
        !Number.isInteger(record.priority) ||
        typeof record.locked !== "boolean" ||
        typeof record.effective !== "boolean" ||
        !(
            record.conflict === null ||
            record.conflict === undefined ||
            typeof record.conflict === "string"
        )
    ) {
        throw new Error("Invalid policy rules response");
    }
    return {
        id: record.id,
        layer: record.layer as PolicyRuleLayer,
        ownerId: (record.ownerId as string | null) ?? null,
        actionClass: record.actionClass,
        resource: record.resource,
        effect: record.effect as ApprovalPolicyEffect,
        priority: record.priority as number,
        locked: record.locked,
        effective: record.effective,
        conflict: typeof record.conflict === "string" ? record.conflict : null,
    };
}

function normalizePolicyToolFace(value: unknown): PolicyToolFaceView {
    const record = asRecord(value);
    if (
        !record ||
        !(record.id === null || typeof record.id === "string") ||
        !isEnumValue(record.scope, policyToolFaceScopes) ||
        !(record.ownerId === null || typeof record.ownerId === "string") ||
        typeof record.tool !== "string" ||
        record.tool.length === 0 ||
        typeof record.actionClass !== "string" ||
        record.actionClass.length === 0 ||
        !isEnumValue(record.shape, approvalPolicyShapes)
    ) {
        throw new Error("Invalid policy tool-faces response");
    }
    return {
        id: (record.id as string | null) ?? null,
        scope: record.scope,
        ownerId: (record.ownerId as string | null) ?? null,
        tool: record.tool,
        actionClass: record.actionClass,
        shape: record.shape as ApprovalPolicyShape,
    };
}

function normalizePolicyArray<T>(
    payload: unknown,
    normalize: (value: unknown) => T,
    label: string,
): T[] {
    if (!Array.isArray(payload)) throw new Error(`Invalid ${label} response: expected an array`);
    return payload.map(normalize);
}

function normalizeWorkspace(value: unknown): ApiWorkspace | undefined {
    const record = asRecord(value);
    if (!record || typeof record.id !== "string" || typeof record.name !== "string")
        return undefined;
    return {
        id: record.id,
        name: record.name,
        description:
            typeof record.description === "string"
                ? record.description
                : record.description === null
                  ? null
                  : undefined,
        ownerId: typeof record.ownerId === "string" ? record.ownerId : undefined,
        storageBackend:
            typeof record.storageBackend === "string" ? record.storageBackend : undefined,
        storageRef: typeof record.storageRef === "string" ? record.storageRef : undefined,
        storageMode: isEnumValue(record.storageMode, ["managed_import", "direct_attach"] as const)
            ? record.storageMode
            : undefined,
        hostPath:
            typeof record.hostPath === "string"
                ? record.hostPath
                : record.hostPath === null
                  ? null
                  : undefined,
        executionMode: isEnumValue(record.executionMode, [
            "docker",
            "windows-mxc",
            "windows-host",
        ] as const)
            ? record.executionMode
            : undefined,
        workspaceRole: isEnumValue(record.workspaceRole, ["OWNER", "EDITOR", "VIEWER"] as const)
            ? record.workspaceRole
            : null,
        canWrite: typeof record.canWrite === "boolean" ? record.canWrite : undefined,
        createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
    };
}

export class ApiError extends Error {
    public readonly problem: ProblemDetails;
    public readonly retryAfterSeconds?: number;

    constructor(problem: ProblemDetails, retryAfterSeconds?: number) {
        super(problem.detail || problem.code || `API error ${problem.status}`);
        this.name = "ApiError";
        this.problem = problem;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

/** Stable Problem codes returned by the Workspace Job start route. */
export const WORKSPACE_JOB_ERROR_CODES = [
    "IDEMPOTENCY_KEY_REQUIRED",
    "WORKSPACE_NOT_FOUND",
    "JOB_IDEMPOTENCY_CONFLICT",
    "JOB_BACKEND_LAUNCH_PENDING",
    "RUNTIME_UNAVAILABLE",
    "PATH_OUT_OF_SCOPE",
    "CAPABILITY_UNAVAILABLE",
    "PROCESS_TIMEOUT",
    "PROCESS_CANCELLED",
    "UNMAPPED_ERROR",
] as const;

export type WorkspaceJobErrorCode = (typeof WORKSPACE_JOB_ERROR_CODES)[number];

const WORKSPACE_JOB_ERROR_REASONS: Record<WorkspaceJobErrorCode, string> = {
    IDEMPOTENCY_KEY_REQUIRED: "缺少 Idempotency-Key，无法安全启动 Job",
    WORKSPACE_NOT_FOUND: "工作区不存在或无权访问",
    JOB_IDEMPOTENCY_CONFLICT: "幂等键冲突：相同键对应了不同的启动参数",
    JOB_BACKEND_LAUNCH_PENDING: "当前执行后端尚未提供 Job 启动器，暂不可用",
    RUNTIME_UNAVAILABLE: "Runtime 暂不可达，请确认服务已启动后重试",
    PATH_OUT_OF_SCOPE: "路径超出工作区范围，操作已拒绝",
    CAPABILITY_UNAVAILABLE: "执行能力当前不可用，请检查 Runtime 或后端状态",
    PROCESS_TIMEOUT: "进程执行超时，任务已终止",
    PROCESS_CANCELLED: "进程已取消",
    UNMAPPED_ERROR: "执行失败，后端未映射具体错误",
};

function isWorkspaceJobErrorCode(code: string | null | undefined): code is WorkspaceJobErrorCode {
    return (
        typeof code === "string" && (WORKSPACE_JOB_ERROR_CODES as readonly string[]).includes(code)
    );
}

/**
 * Human-readable reason for a Workspace Job start failure. Recognized stable codes map to fixed
 * copy; anything else falls back to the server detail or the raw error message.
 */
export function workspaceJobErrorReason(error: unknown): string {
    if (error instanceof ApiError) {
        if (isWorkspaceJobErrorCode(error.problem.code)) {
            return WORKSPACE_JOB_ERROR_REASONS[error.problem.code];
        }
        return error.problem.detail || error.message;
    }
    return error instanceof Error ? error.message : String(error);
}

/** Stable Problem codes returned by the Workspace capability preflight route. */
export const WORKSPACE_PREFLIGHT_ERROR_CODES = [
    "INVALID_STORAGE_MODE",
    "INVALID_EXECUTION_MODE",
    "INVALID_HOST_PATH",
    "RUNTIME_UNAVAILABLE",
] as const;

export type WorkspacePreflightErrorCode = (typeof WORKSPACE_PREFLIGHT_ERROR_CODES)[number];

/**
 * Stable Problem code carried by a failed execution-mode switch (`PATCH .../execution-mode`).
 * `WORKSPACE_BUSY` means an active Job must be stopped first; probe codes mean the target
 * backend could not be validated (the UI must not silently fall back).
 */
export const EXECUTION_MODE_SWITCH_PROBE_CODES = [
    "DIRECT_ATTACH_UNAVAILABLE",
    "DIRECT_ATTACH_PROBE_FAILED",
    "RUNTIME_UNAVAILABLE",
] as const;

export function isExecutionModeSwitchProbeFailure(code: string | null | undefined): boolean {
    return (
        typeof code === "string" &&
        (EXECUTION_MODE_SWITCH_PROBE_CODES as readonly string[]).includes(code)
    );
}

/**
 * PLAN-0668 D4: a wire row that is missing a contract-required field is not a usable session
 * projection. The list face drops the row with a WARN; single-item faces throw this typed error
 * instead of silently serving a half-shaped Session to the conversation tree.
 */
export class InvalidSessionProjectionError extends Error {
    readonly field: string;

    constructor(field: string, detail: string) {
        super(`Invalid session projection: missing/invalid required field '${field}' (${detail})`);
        this.name = "InvalidSessionProjectionError";
        this.field = field;
    }
}

/** OpenAPI `Session.required` names that `normalizeSession` cannot synthesize. */
function requireSessionField(
    record: Record<string, unknown>,
    field: string,
    kind: "string",
): string;
function requireSessionField(
    record: Record<string, unknown>,
    field: string,
    kind: "boolean",
): boolean;
function requireSessionField(
    record: Record<string, unknown>,
    field: string,
    kind: "string" | "boolean",
): string | boolean {
    const value = record[field];
    if (kind === "boolean" ? typeof value !== "boolean" : typeof value !== "string") {
        throw new InvalidSessionProjectionError(field, `expected ${kind}`);
    }
    return value as string | boolean;
}

function normalizeSession(value: unknown): SessionResponse {
    const root = asRecord(value),
        record = asRecord(root?.session) ?? root;
    if (!record) {
        throw new InvalidSessionProjectionError("id", "expected object with id");
    }
    const id = requireSessionField(record, "id", "string"),
        archived = requireSessionField(record, "archived", "boolean");
    const workspace = normalizeWorkspace(root?.workspace) ?? normalizeWorkspace(record.workspace);
    const workspaceId =
        typeof record.workspaceId === "string" && record.workspaceId.length > 0
            ? record.workspaceId
            : workspace?.id;
    if (!workspaceId) {
        throw new InvalidSessionProjectionError(
            "workspaceId",
            "expected string (no workspace fallback either)",
        );
    }
    return {
        id,
        archived,
        title:
            typeof record.title === "string" && record.title.length > 0 ? record.title : "Untitled",
        workspaceId,
        agentPrincipalId:
            typeof record.agentPrincipalId === "string" ? record.agentPrincipalId : null,
        // PLAN-0655 T1.5 / PLAN-0659 T1.4：委派 lineage 必须在 list 投影里透传。
        // OpenAPI 的 Session 契约（`required: [kind, spawnedFromSessionId, spawnedFromRunId,
        // spawnedAt]`）与 `stores/session.ts#toSession` 都消费这三个字段；此前 normalize 把
        // 它们丢了 ⇒ 会话树的父子嵌套与「委派」徽标在真实链路上永远看不到（单测直接塞
        // store 状态，故一直没暴露）。这是投影层缺陷，不是夹具问题。
        // Contract/CP wire uses lowercase `spawn` / `fork` (Session.KIND_* and the OpenAPI
        // SessionSummary enum), while every UI consumer (session tree, badge, DAG) keys on the
        // canonical uppercase form. Normalize here so a real list response actually nests children.
        // M3 real stack 2026-11-05: before this, GET /sessions emitted `spawn` and the tree/badge
        // silently treated the child as a root session.
        kind: typeof record.kind === "string" ? record.kind.toUpperCase() : null,
        spawnedFromSessionId:
            typeof record.spawnedFromSessionId === "string" ? record.spawnedFromSessionId : null,
        spawnedFromRunId:
            typeof record.spawnedFromRunId === "string" ? record.spawnedFromRunId : null,
        spawnedAt: typeof record.spawnedAt === "string" ? record.spawnedAt : null,
        createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
        modelProvider: typeof record.modelProvider === "string" ? record.modelProvider : undefined,
        modelName: typeof record.modelName === "string" ? record.modelName : undefined,
        providerConnectionId:
            typeof record.providerConnectionId === "string"
                ? record.providerConnectionId
                : undefined,
        connectionRevision:
            typeof record.connectionRevision === "number" ? record.connectionRevision : undefined,
        contextTemplateLayer:
            record.contextTemplateLayer === "instance" ||
            record.contextTemplateLayer === "user" ||
            record.contextTemplateLayer === "workspace"
                ? record.contextTemplateLayer
                : null,
        contextTemplateId:
            typeof record.contextTemplateId === "string" ? record.contextTemplateId : null,
        contextTemplateVersion:
            typeof record.contextTemplateVersion === "number"
                ? record.contextTemplateVersion
                : null,
        workspace,
    };
}

function normalizeWorkspaceResponse(value: unknown): ApiWorkspace {
    const root = asRecord(value),
        workspace = normalizeWorkspace(root?.workspace) ?? normalizeWorkspace(root);
    if (!workspace) throw new Error("Invalid workspace response: missing id or name");
    return workspace;
}

const workspaceEventKinds = [
    "workspace_status",
    "file_changed",
    "snapshot_required",
    "workspace_event_error",
    "scheduled_tasks_changed",
    "heartbeat",
] as const;

/** Normalize the Workspace SSE envelope without accepting host paths or stale foreign IDs. */
export function normalizeWorkspaceEvent(
    value: unknown,
    fallbackWorkspaceId: string,
    fallbackKind?: string,
): WorkspaceEvent | null {
    const record = asRecord(value);
    if (
        !record ||
        typeof record.workspaceId !== "string" ||
        record.workspaceId !== fallbackWorkspaceId
    ) {
        return null;
    }
    const kind = typeof record.kind === "string" ? record.kind : fallbackKind;
    if (!kind || !workspaceEventKinds.includes(kind as (typeof workspaceEventKinds)[number])) {
        return null;
    }
    const sequence = asNonNegativeInteger(record.sequence),
        source =
            typeof record.source === "string"
                ? record.source
                : kind === "heartbeat"
                  ? "control-plane"
                  : "";
    if (sequence === null || source.length === 0) return null;
    const path = typeof record.path === "string" ? record.path : undefined;
    if (
        path !== undefined &&
        (path.length === 0 ||
            path.startsWith("/") ||
            path.includes("\\") ||
            path.includes(":") ||
            path.split("/").includes(".."))
    ) {
        return null;
    }
    return {
        workspaceId: fallbackWorkspaceId,
        sequence,
        kind: kind as WorkspaceEvent["kind"],
        path,
        changeType: typeof record.changeType === "string" ? record.changeType : undefined,
        source,
        reason: typeof record.reason === "string" ? record.reason : undefined,
        status: typeof record.status === "string" ? record.status : undefined,
        // PLAN-0639 M2: root attribution rides the event envelope (D39-6); absent on
        // legacy single-root events, where the primary root is implied.
        rootId:
            typeof record.rootId === "string" && record.rootId.length > 0
                ? record.rootId
                : undefined,
    };
}

function endpoint(path: string): string {
    return path.startsWith("/api/v1/") || path.startsWith("/internal/v1/")
        ? path
        : `${API_BASE}${path}`;
}

export function apiAuthHeaders(
    headers?: HeadersInit,
    includeContentType = true,
): Record<string, string> {
    const result: Record<string, string> = {};
    if (headers instanceof Headers)
        headers.forEach((value, key) => {
            result[key] = value;
        });
    else if (Array.isArray(headers))
        headers.forEach(([key, value]) => {
            result[key] = value;
        });
    else Object.assign(result, headers ?? {});
    const token = localStorage.getItem("xihe-token");
    if (token) result.Authorization = `Bearer ${token}`;
    // PLAN-0559: every workspace-scoped request carries the tab workspace. An
    // explicit caller header wins (case-insensitive) over this default.
    const hasWorkspaceHeader = Object.keys(result).some(
        (key) => key.toLowerCase() === "x-workspace-id",
    );
    if (!hasWorkspaceHeader) {
        const workspaceId = readTabWorkspaceId();
        if (workspaceId) result["X-Workspace-Id"] = workspaceId;
    }
    if (includeContentType && !result["Content-Type"]) result["Content-Type"] = "application/json";
    return result;
}

export async function apiErrorFromResponse(res: Response): Promise<never> {
    let problem: Partial<ProblemDetails> = {};
    try {
        problem = (await res.json()) as Partial<ProblemDetails>;
    } catch {
        /* non-JSON upstream error */
    }
    const retryAfterHeader = res.headers?.get?.("Retry-After");
    const retryAfterHeaderSeconds =
        retryAfterHeader && /^[0-9]+$/.test(retryAfterHeader)
            ? Number(retryAfterHeader)
            : undefined;
    // PLAN-0622 D14：`retryAfterSeconds` / `resourceKind` 是 429 契约字段，必须穿过 ApiError
    // 才能到 UI（否则 MessageItem 只能兜底成「资源」，用户不知道是连接不够还是模型不够）。
    // body 优先（header 只有秒数、没有 kind），header 只作为秒数的回退。
    const retryAfterSeconds = problem.retryAfterSeconds ?? retryAfterHeaderSeconds;
    throw new ApiError(
        {
            type: problem.type,
            title: problem.title,
            status: problem.status ?? res.status,
            code: problem.code ?? "API_ERROR",
            detail: problem.detail || `API error ${problem.status ?? res.status}`,
            requestId: problem.requestId || res.headers?.get("X-Request-Id") || "unknown",
            runId: problem.runId,
            provider: problem.provider,
            model: problem.model,
            retryable: problem.retryable,
            outcome: problem.outcome,
            retryAfterSeconds,
            resourceKind: problem.resourceKind,
        },
        retryAfterSeconds,
    );
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * PLAN-0546: single-flight silent refresh. Concurrent 401s await the same promise.
 * The promise never rejects (network errors normalize to false); callers treat false
 * as "session dead" and go through forceLogout. Tokens are written to localStorage
 * before resolving so the replayed request's apiAuthHeaders picks up the new token.
 */
function ensureRefreshed(): Promise<boolean> {
    if (refreshInFlight) return refreshInFlight;
    const attempt = (async () => {
        try {
            const rt = localStorage.getItem("xihe-refresh-token");
            if (!rt) return false;
            const workspaceId = readTabWorkspaceId();
            const res = await fetch(endpoint("/auth/refresh"), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
                },
                body: JSON.stringify({ refreshToken: rt }),
            });
            if (!res.ok) return false;
            const data = (await res.json()) as { accessToken?: string; refreshToken?: string };
            if (!data.accessToken || !data.refreshToken) return false;
            localStorage.setItem("xihe-token", data.accessToken);
            localStorage.setItem("xihe-refresh-token", data.refreshToken);
            authSyncCallbacks.forEach((cb) => cb(data.accessToken as string));
            return true;
        } catch {
            return false;
        }
    })();
    // .finally() callback always runs in a microtask (after the assignment above), so the
    // settled promise can never be written back into refreshInFlight.
    refreshInFlight = attempt;
    void attempt.finally(() => {
        refreshInFlight = null;
    });
    return attempt;
}

const authSyncCallbacks = new Set<(accessToken: string) => void>();

/** auth store registers to keep its in-memory token ref in sync after a silent refresh. */
export function onAuthTokensRefreshed(cb: (accessToken: string) => void): void {
    authSyncCallbacks.add(cb);
}

type ForceLogoutFn = () => void;
let forceLogoutImpl: ForceLogoutFn | null = null;

type WorkspaceContextRequiredFn = () => void;
let workspaceContextRequiredImpl: WorkspaceContextRequiredFn | null = null;

/**
 * BL-181: CP answers `409 WORKSPACE_CONTEXT_REQUIRED` when the caller is authenticated but has no
 * workspace context (blank start with no workspace yet, or several workspaces and none named). That
 * is recoverable, not a session expiry: the app registers "go to the workspace picker" here so the
 * response never reaches the 401 path (which refreshes and then force-logs-out the user).
 */
export function registerWorkspaceContextRequired(fn: WorkspaceContextRequiredFn): void {
    workspaceContextRequiredImpl = fn;
}

/** Reads `code` from a problem+json body without consuming the response. */
async function readProblemCode(res: Response): Promise<string> {
    try {
        const body = (await res.clone().json()) as { code?: unknown };
        return typeof body.code === "string" ? body.code : "";
    } catch {
        return "";
    }
}

/** auth store injects the SPA-route logout to avoid an api -> router import cycle. */
export function registerForceLogout(fn: ForceLogoutFn): void {
    forceLogoutImpl = fn;
}

function forceLogout(): void {
    localStorage.removeItem("xihe-token");
    localStorage.removeItem("xihe-refresh-token");
    localStorage.removeItem("xihe-user");
    clearTabWorkspace();
    if (forceLogoutImpl) {
        forceLogoutImpl();
        return;
    }
    // Fallback when the auth store has not registered yet (e.g. tests): keep the old
    // hard-navigation semantics so the session is still visibly terminated.
    if (!["/login", "/register"].includes(window.location.pathname))
        window.location.href = "/login";
}

async function checkedFetch(path: string, options?: RequestInit): Promise<Response> {
    const hasBody = options?.body !== undefined && options.body !== null,
        includeContentType = hasBody && !(options?.body instanceof FormData),
        res = await fetch(endpoint(path), {
            ...options,
            headers: apiAuthHeaders(options?.headers, includeContentType),
        }),
        isAuthEndpoint =
            path === "/auth/login" ||
            path === "/auth/register" ||
            path === "/auth/bootstrap-status" ||
            path === "/auth/local-login" ||
            path === "/auth/local-password-reset",
        // PLAN-0498 T3.1: a wrong reveal step-up password is a 401 domain outcome,
        // not session expiry — it must stay inline in the reveal dialog.
        isStepUpEndpoint = /^\/credentials\/[^/]+\/reveal$/.test(path);
    if (res.status === 401 && !isAuthEndpoint && !isStepUpEndpoint) {
        // PLAN-0546: silent refresh with single-flight, then one replay. Logout only when
        // the refresh itself fails or the replayed request is still 401 (no second refresh).
        const refreshed = await ensureRefreshed();
        if (refreshed) {
            const replay = await fetch(endpoint(path), {
                ...options,
                headers: apiAuthHeaders(options?.headers, includeContentType),
            });
            if (replay.status === 401) {
                forceLogout();
                throw new ApiError({
                    status: 401,
                    code: "AUTHORIZATION_REQUIRED",
                    detail: "Session expired",
                    requestId: replay.headers?.get("X-Request-Id") || "unknown",
                });
            }
            if (!replay.ok) return apiErrorFromResponse(replay);
            return replay;
        }
        forceLogout();
        throw new ApiError({
            status: 401,
            code: "AUTHORIZATION_REQUIRED",
            detail: "Session expired",
            requestId: res.headers?.get("X-Request-Id") || "unknown",
        });
    }
    if (res.status === 409 && (await readProblemCode(res)) === "WORKSPACE_CONTEXT_REQUIRED") {
        // BL-181: recoverable — hand off to the picker; never the 401 logout path.
        workspaceContextRequiredImpl?.();
    }
    if (!res.ok) return apiErrorFromResponse(res);
    return res;
}

/**
 * PLAN-0623 U2：解析 `capabilities` 块（`view`/`manage`/`mention`）。
 *
 * 缺失或类型不对一律 **fail-closed**（`manage`/`mention` = false），因为这三个键决定按钮
 * 是否可点：宁可少给入口，也不能在本该没有权限时给出可点按钮。
 * `view` 缺失时按 true？—— 不：缺失说明响应不合契约，读取也应当停下来，所以同样按 false，
 * 由面板显示"不可查看"状态并带诊断信息。
 */
function parseParticipantCapabilities(
    record: Record<string, unknown>,
): SessionParticipantCapabilities {
    const raw = record.capabilities;
    if (!raw || typeof raw !== "object") {
        return { view: false, manage: false, mention: false, speakAs: false };
    }
    const caps = raw as Record<string, unknown>;
    const flag = (key: string): boolean => caps[key] === true;
    return {
        view: flag("view"),
        manage: flag("manage"),
        mention: flag("mention"),
        speakAs: flag("speakAs"),
    };
}

export async function apiRaw(path: string, options?: RequestInit): Promise<Response> {
    return checkedFetch(path, options);
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await checkedFetch(path, options);
    if (res.status === 204) return undefined as T;
    return res.json();
}

export async function apiPost<T = unknown>(
    path: string,
    body?: BodyInit | null,
    headers?: Record<string, string>,
): Promise<T> {
    const requestHeaders = apiAuthHeaders(headers);
    if (body instanceof FormData) delete requestHeaders["Content-Type"];
    const res = await checkedFetch(path, {
        method: "POST",
        headers: requestHeaders,
        body,
    });
    if (res.status === 204) return undefined as T;
    return res.json();
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
    const res = await checkedFetch(path, {
        headers: apiAuthHeaders(undefined, false),
    });
    if (res.status === 204) return undefined as T;
    return res.json();
}

export async function apiDelete(path: string): Promise<void> {
    await checkedFetch(path, {
        method: "DELETE",
        headers: apiAuthHeaders(undefined, false),
    });
}

export function workspaceHeaders(workspaceId: string | null | undefined): Record<string, string> {
    if (!workspaceId || workspaceId.trim().length === 0) {
        throw new ApiError({
            status: 400,
            code: "WORKSPACE_CONTEXT_REQUIRED",
            detail: "Workspace context is required",
            requestId: "client",
        });
    }
    return { "X-Workspace-Id": workspaceId };
}

function runtimeMcpHeaders(workspaceId: string): Record<string, string> {
    return {
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        ...workspaceHeaders(workspaceId),
    };
}

async function callRuntimeTool<T>(
    tool: string,
    args: Record<string, unknown>,
    workspaceId: string,
): Promise<T> {
    const res = await checkedFetch("/mcp", {
            method: "POST",
            headers: runtimeMcpHeaders(workspaceId),
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "tools/call",
                id: Date.now(),
                params: { name: tool, arguments: args },
            }),
        }),
        text = await res.text(),
        jsonLine = text.startsWith("data:")
            ? text
                  .split("\n")
                  .find((line) => line.startsWith("data:"))!
                  .slice(5)
                  .trim()
            : text,
        body = JSON.parse(jsonLine);
    if (body.error) {
        throw new ApiError({
            status: 502,
            code: "MCP_TOOL_ERROR",
            detail: body.error.message || "MCP tool call failed",
            requestId: res.headers.get("X-Request-Id") || "unknown",
        });
    }
    const result = body.result;
    if (result?.isError) {
        throw new ApiError({
            status: 502,
            code: "MCP_TOOL_ERROR",
            detail: result.content?.[0]?.text || "MCP tool error",
            requestId: res.headers.get("X-Request-Id") || "unknown",
        });
    }
    if (result?.structuredContent !== undefined) return result.structuredContent as T;
    const textContent = result?.content?.[0]?.text;
    if (typeof textContent === "string") {
        try {
            return JSON.parse(textContent) as T;
        } catch {
            return textContent as T;
        }
    }
    return result as T;
}

export interface VersionModule {
    version: string | null;
    commit: string | null;
    framework?: string | null;
}

export interface VersionInfo {
    stackId: string;
    releaseChannel: "stable" | "beta" | "dev";
    startedAt: string;
    commit: string | null;
    modules: {
        cp: VersionModule;
        agent: VersionModule;
        runtime: VersionModule;
    };
}

function revertExecuteBody(
    sliceRef: string,
    acknowledgeTypeChanges: string[],
    acknowledgeNestedRepos: string[],
    force: boolean,
): Record<string, unknown> {
    const body: Record<string, unknown> = { sliceRef, acknowledgeTypeChanges };
    if (acknowledgeNestedRepos.length > 0) {
        body.acknowledgeNestedRepos = acknowledgeNestedRepos;
    }
    if (force) body.force = true;
    return body;
}

export type ApiSessionMessage = {
    id: string;
    sessionId: string;
    role: string;
    content: string;
    createdAt: string;
    /** PLAN-0669 M1：历史消息的主体归属（可选；缺失 = 未知，不渲染徽标）。 */
    participantId?: string | null;
    runId?: string;
    runStatus?: string;
    terminalOutcome?: string;
    errorCode?: string;
    /** CP `MessageReadService` field name for the terminal error text. */
    errorDetail?: string;
    error?: string;
    retryable?: boolean;
    /**
     * PLAN-0665 M2 / V120: durable delivery audience written on the user Message.
     * `{to:[participantId],cc:[participantId]}`; `null` when the message had neither
     * (never an empty object), so the read side falls back to local composer state.
     */
    delivery?: { to?: string[]; cc?: string[] } | null;
    attachments?: Array<{ fileId: string; name: string; type: string; size: number }>;
    /** PLAN-0572: persisted per-Run tool cards (V83 snapshot). */
    toolCalls?: Array<{
        id: string;
        name: string;
        arguments: string;
        status: "running" | "completed" | "failed" | "pending" | "cancelled";
        startedAt: string;
        completedAt?: string;
        result?: string;
        truncated?: boolean;
        /** PLAN-0649: CP refusal code; the durable body stays a placeholder. */
        refusalCode?: string;
    }>;
    toolCallsTruncated?: boolean;
    toolCallsTotal?: number;
    jobSummary?: Array<{
        jobId: string;
        workspaceId: string;
        toolCallId?: string;
        toolName?: string;
        status: string;
        scope?: string;
        startedAt?: string | null;
        endedAt?: string | null;
    }>;
};

export const api = {
    // PLAN-0565 ruling #7: identifier is email (contains '@') or username.
    login(identifier: string, password: string) {
        return request<{
            accessToken: string;
            refreshToken: string;
            user: ApiAuthUser;
            // PLAN-0614: CP returns null when the account has no workspace (registration no longer creates one).

            workspaceId?: string | null;
            workspace?: ApiWorkspace | null;
        }>("/auth/login", {
            method: "POST",
            body: JSON.stringify({ identifier, password }),
        });
    },
    register(email: string, password: string, name: string, username?: string) {
        // PLAN-0526: local mode may omit the password (server generates one).
        // PLAN-0565 ruling #7: optional username; blank derives one from email.
        const body: Record<string, string | undefined> = {
            email,
            password: password || undefined,
            name,
            username: username || undefined,
        };
        return request<{
            accessToken: string;
            refreshToken: string;
            user: ApiAuthUser;
            // PLAN-0614: CP returns null when the account has no workspace (registration no longer creates one).

            workspaceId?: string | null;
            workspace?: ApiWorkspace | null;
        }>("/auth/register", {
            method: "POST",
            body: JSON.stringify(body),
        });
    },
    /** PLAN-0610 W3-2b: the caller's own projection (capabilities replace the retired role). */
    me() {
        return request<ApiAuthUser>("/auth/me");
    },
    // PLAN-0526: loopback-only local mode entry.
    bootstrapStatus() {
        return request<{ initialized: boolean; localMode: boolean }>("/auth/bootstrap-status");
    },
    localLogin() {
        return request<{
            accessToken: string;
            refreshToken: string;
            user: ApiAuthUser;
            // PLAN-0614: CP returns null when the account has no workspace (registration no longer creates one).

            workspaceId?: string | null;
            workspace?: ApiWorkspace | null;
        }>("/auth/local-login", { method: "POST" });
    },
    localPasswordReset(newPassword: string) {
        return request<void>("/auth/local-password-reset", {
            method: "POST",
            body: JSON.stringify({ newPassword }),
        });
    },
    async getSessions(): Promise<SessionListResponse> {
        const payload = await request<unknown>("/sessions"),
            root = asRecord(payload),
            rawSessions = Array.isArray(root?.sessions)
                ? root.sessions
                : Array.isArray(payload)
                  ? payload
                  : null;
        if (!rawSessions) throw new Error("Invalid sessions response: missing sessions");
        // D4 list policy: one malformed row is dropped and named in a WARN; the rest of the list
        // (and the session tree) still renders. Single-item faces below keep throwing.
        const sessions: SessionResponse[] = [];
        for (const raw of rawSessions) {
            try {
                sessions.push(normalizeSession(raw));
            } catch (error) {
                const field =
                    error instanceof InvalidSessionProjectionError ? error.field : "unknown";
                const rowId =
                    asRecord(asRecord(raw)?.session)?.id ?? asRecord(raw)?.id ?? "<unknown>";
                console.warn("[sessions] dropping malformed row", {
                    field,
                    rowId,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return {
            sessions,
            workspace: normalizeWorkspace(root?.workspace),
        };
    },
    async getSession(id: string): Promise<SessionResponse> {
        return normalizeSession(await request<unknown>(`/sessions/${encodeURIComponent(id)}`));
    },
    async forkSession(
        sessionId: string,
        body: { sourceBranchId: string; anchorMessageId: string },
        idempotencyKey: string,
    ): Promise<SessionResponse> {
        return normalizeSession(
            await request<unknown>(`/sessions/${encodeURIComponent(sessionId)}/fork`, {
                method: "POST",
                headers: { "Idempotency-Key": idempotencyKey },
                body: JSON.stringify(body),
            }),
        );
    },
    getSessionDerivedState(sessionId: string): Promise<SessionDerivedStateResponse> {
        return request<SessionDerivedStateResponse>(
            `/sessions/${encodeURIComponent(sessionId)}/derived-state`,
        );
    },
    /**
     * PLAN-0635 M3: server-owned command registry. The server decides availability
     * (`available` + `reason`); the UI only renders it and merges the local table.
     */
    async listSessionCommands(
        sessionId: string,
        options: { signal?: AbortSignal } = {},
    ): Promise<SessionCommandListResponse> {
        const payload = await request<unknown>(
            `/sessions/${encodeURIComponent(sessionId)}/commands`,
            { signal: options.signal },
        );
        const root = asRecord(payload);
        if (!root || !Array.isArray(root.commands)) {
            throw new Error(
                "listSessionCommands: unexpected payload (expected an object with a commands array)",
            );
        }
        return { commands: root.commands as SessionCommandView[] };
    },
    /**
     * PLAN-0635 M3: `/export` artifact (`text/markdown` + `Content-Disposition`). Returns the raw
     * response because the caller needs both the blob body and the filename header.
     */
    exportSession(sessionId: string, branchId: string): Promise<Response> {
        return apiRaw(
            `/sessions/${encodeURIComponent(sessionId)}/export?branchId=${encodeURIComponent(branchId)}`,
        );
    },
    /** PLAN-0635 M3: `/compact` reuses the existing manual-compaction endpoint (branch-scoped). */
    compactSession(sessionId: string, branchId: string): Promise<SessionCompactResponse> {
        return request<SessionCompactResponse>(
            `/sessions/${encodeURIComponent(sessionId)}/compact`,
            { method: "POST", body: JSON.stringify({ branchId }) },
        );
    },
    /**
     * PLAN-0464 T2.1: runs of one session with status + spawn waiting link.
     * The child ChatRun row carries `waitingOnRunId`/`waitingToolCallId`.
     */
    listSessionRuns(
        sessionId: string,
        options: { page?: number; size?: number } = {},
    ): Promise<SessionRunsResponse> {
        const params = new URLSearchParams();
        params.set("page", String(options.page ?? 0));
        params.set("size", String(options.size ?? 100));
        return request<SessionRunsResponse>(
            `/chat/sessions/${encodeURIComponent(sessionId)}/runs?${params.toString()}`,
        );
    },
    /** PLAN-0507: read-only Session monitor aggregate (activity/history/readiness). */
    getSessionMonitor(sessionId: string): Promise<SessionMonitorResponse> {
        return request<SessionMonitorResponse>(
            `/chat/sessions/${encodeURIComponent(sessionId)}/monitor`,
        );
    },
    /** PLAN-0508: per-run durable transport attempts (read projection, seq order). */
    getRunAttempts(runId: string): Promise<RunTransportAttemptsResponse> {
        return request<RunTransportAttemptsResponse>(
            `/chat/runs/${encodeURIComponent(runId)}/attempts`,
        );
    },
    /** PLAN-0509: safe, cursor-paged per-Run trace projection. */
    async getRunTrace(
        runId: string,
        options: { cursor?: string; limit?: number } = {},
    ): Promise<RunTraceResponse> {
        const params = new URLSearchParams();
        if (options.cursor !== undefined) params.set("cursor", options.cursor);
        if (options.limit !== undefined) params.set("limit", String(options.limit));
        const query = params.toString();
        const payload = await request<unknown>(
            `/chat/runs/${encodeURIComponent(runId)}/trace${query ? `?${query}` : ""}`,
        );
        return normalizeRunTraceResponse(payload);
    },
    /** PLAN-0340 U1: source summary metadata only (no body). */
    getContextSources(sessionId: string) {
        return request<{
            sourceKey: string;
            status: string;
            hashPrefix: string;
            envBranch?: string;
            envHead?: string;
        }>(`/context/${encodeURIComponent(sessionId)}/sources`);
    },
    async createSession(agentPrincipalId: string, title?: string): Promise<SessionResponse> {
        const body = title === undefined ? { agentPrincipalId } : { title, agentPrincipalId };
        // PLAN-0608 (C′): address the workspace in the PATH. The tab header alone is
        // not enough — after login the tab may hold the *fallback* workspace, which
        // silently created sessions in the wrong tenant (review P0-1). With no
        // selection yet, keep the legacy route so CP answers WORKSPACE_CONTEXT_REQUIRED
        // and the UI can offer the picker.
        const workspaceId = readTabWorkspaceId();
        const path = workspaceId
            ? `/workspaces/${encodeURIComponent(workspaceId)}/sessions`
            : "/sessions";
        return normalizeSession(
            await request<unknown>(path, {
                method: "POST",
                body: JSON.stringify(body),
            }),
        );
    },
    /**
     * PLAN-0622（CP `13e54cad` 冻结）：响应信封是 `{agents:[…]}`，item 里 `permissionsSnapshot`
     * 取代旧的 `permissions`。**只认这一种形状**（不写双形状兼容），解包后才交给调用方。
     */
    /**
     * PLAN-0623 D23-25：会话参与者列表。**严格信封** —— 只认 `{participants:[…]}`。
     *
     * 不做双形状兼容（`Array.isArray(x) ? x : x.participants`）：那会让"契约破了"表现为
     * "能跑"，把问题推到以后。形状不符就抛错，并把**实际收到的顶层键**写进信息，
     * 便于区分"契约变了"（收到 `["items"]`）和"网络/网关问题"（收到 HTML 之类）。
     *
     * `{participants: []}` 是**合法**的（确实没有参与者），与"形状错误"是两件事。
     */
    async getSessionParticipants(sessionId: string): Promise<SessionParticipantListResponse> {
        const raw = await request<unknown>(
            `/sessions/${encodeURIComponent(sessionId)}/participants`,
        );
        if (Array.isArray(raw)) {
            throw new Error(
                `getSessionParticipants: unexpected payload (received a bare array of length ${raw.length}; ` +
                    `expected an object with a "participants" array)`,
            );
        }
        if (!raw || typeof raw !== "object") {
            throw new Error(
                `getSessionParticipants: unexpected payload (received ${raw === null ? "null" : typeof raw}; ` +
                    `expected an object with a "participants" array)`,
            );
        }
        const record = raw as Record<string, unknown>;
        if (!("participants" in record)) {
            const keys = Object.keys(record);
            throw new Error(
                `getSessionParticipants: unexpected payload (received keys: [${keys
                    .map((key) => JSON.stringify(key))
                    .join(", ")}]; expected a "participants" array)`,
            );
        }
        const participants = record.participants;
        if (!Array.isArray(participants)) {
            // 键在、但类型错：与"键缺失"分开报，便于一眼定位是契约变更还是网关返回异常。
            throw new Error(
                `getSessionParticipants: "participants" is not an array (received ${participants === null ? "null" : typeof participants})`,
            );
        }
        return {
            participants: participants as SessionParticipantView[],
            capabilities: parseParticipantCapabilities(record),
        };
    },
    /**
     * PLAN-0623 D23-26：移除 = **soft disable**（CP 只置 `disabled_at`，行与游标保留）。
     * 因此调用方在 204 之后必须重新拉列表，行仍会在（带 disabled 徽标），而不是消失。
     */
    /**
     * PLAN-0623 改策略：`PATCH …/participants/{id}`，**只带变更字段**。
     *
     * 已知错误码（CP 契约）：`PARTICIPANT_PRIMARY_IMMUTABLE`（PRIMARY 不可改/不可移除）。
     * 其它 4xx 由调用方按 `ApiError.problem.code` 映射，不直显英文 detail。
     */
    async updateSessionParticipant(
        sessionId: string,
        participantId: string,
        body: { wakePolicy?: WakePolicy; respondPolicy?: RespondPolicy },
    ): Promise<void> {
        await request<void>(
            `/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(participantId)}`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            },
        );
    },
    async removeSessionParticipant(sessionId: string, participantId: string): Promise<void> {
        await request<void>(
            `/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(participantId)}`,
            { method: "DELETE" },
        );
    },
    /** PLAN-0655: the budget view used by the delegation dialog's read-only row. */
    async delegationUsage(sessionId: string): Promise<DelegationUsageView> {
        return request<DelegationUsageView>(
            `/sessions/${encodeURIComponent(sessionId)}/delegation-usage`,
        );
    },
    /**
     * PLAN-0655: human delegation. Resolves to `DelegationSpawnAccepted` (202, pending approval —
     * re-post with the same Idempotency-Key plus the returned retryHeader) or `DelegationSpawnResult`
     * (201). Idempotency-Key is mandatory: the CP replays the same key instead of spending the
     * budget (or a granted approval) twice.
     */
    async delegationSpawn(
        sessionId: string,
        input: { agentPrincipalId: string; task: string },
        idempotencyKey: string,
        approvalRequestId?: string,
    ): Promise<DelegationSpawnResult | DelegationSpawnAccepted> {
        const headers: Record<string, string> = { "Idempotency-Key": idempotencyKey };
        if (approvalRequestId) {
            headers["X-Xihe-Approval-Request-Id"] = approvalRequestId;
        }
        return request<DelegationSpawnResult | DelegationSpawnAccepted>(
            `/sessions/${encodeURIComponent(sessionId)}/delegation-spawn`,
            { method: "POST", headers, body: JSON.stringify(input) },
        );
    },
    async getWorkspaceAgents(workspaceId: string): Promise<WorkspaceAgentBinding[]> {
        const raw = await request<{ agents: Array<Record<string, unknown>> }>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents`,
        );
        // hooks 经 fail-closed 解析（V96：null=无订阅；畸形=视为无订阅 + warn）。
        //
        // `permissionsSnapshot` 在 `WorkspaceAgentView` 里是 required，但**单行**畸形不能让
        // 整张列表失去更新：面板的能力列表读 `.length`，一旦是 undefined，渲染函数抛错 ⇒ Vue
        // 放弃本次更新，DOM 停在上一个「正在加载智能体…」帧，加载结束也永远看不出来。这里把
        // 缺字段降级为「没有冻结上限」并留 warn，让加载终态与失败原因都能被用户看到。
        return raw.agents.map((agent) => {
            const snapshot = agent.permissionsSnapshot;
            if (!Array.isArray(snapshot)) {
                console.warn("[agents] permissionsSnapshot missing; treated as empty");
            }
            return {
                ...(agent as unknown as WorkspaceAgentBinding),
                permissionsSnapshot: Array.isArray(snapshot)
                    ? (snapshot as WorkspaceAgentBinding["permissionsSnapshot"])
                    : [],
                hooks: normalizePrincipalHooks(agent.hooks),
                // 「启用记忆」开关要读现值并整对象回写，故这里原样保留 CP 的 contextPolicy。
                contextPolicy: asRecord(agent.contextPolicy) ?? null,
            } as WorkspaceAgentBinding;
        });
    },
    /**
     * PLAN-0629 M1-4 C：只读记忆列表。信封是 `{memories:[…]}`（与 `{agents:[…]}` 同风格），
     * 不把裸数组当契约。`status='active'` 过滤、软删排除、pinned/profile 排序都在 CP；
     * UI 不重排、不补字段。可见性门与 agents 列表一致（不可见与不存在同为 404）。
     */
    /**
     * 记忆列表。信封是 `{memories:[…]}`（与 `{agents:[…]}` 同风格），不把裸数组当契约。
     *
     * `status` 只在调用方显式要归档视图时透传（CP 本轮新增 `?status=active|retired|all`）；
     * 不传时**完全保持原请求**（无该参数 = 兼容未升级的 CP，读到的就是 active 列表）。
     */
    async getWorkspaceAgentMemories(
        workspaceId: string,
        principalId: string,
        status?: WorkspaceAgentMemoryStatus,
    ): Promise<WorkspaceAgentMemory[]> {
        const query = status ? `?status=${encodeURIComponent(status)}` : "";
        const raw = await request<{ memories?: Array<Record<string, unknown>> }>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}/memories${query}`,
        );
        if (!Array.isArray(raw?.memories)) {
            console.warn("[agents] memory envelope malformed; treated as empty");
            return [];
        }
        return raw.memories
            .map(normalizeWorkspaceAgentMemory)
            .filter((row): row is WorkspaceAgentMemory => row !== null);
    },
    /**
     * 记忆写入三条（PLAN-0629 M1-5 UI 侧）。
     *
     * 契约来源：CP `WorkspaceAgentController` 的 memories 子资源，**写入路由与请求体以 CP lane
     * 定稿为准**；本实现按 `{content, type, pinned}` 处理，三处需要跟 CP 对齐的只有下面的
     * `method` 与路径段：
     * - 新增 `POST   /workspaces/{ws}/agents/{pid}/memories`（body: WorkspaceAgentMemoryInput）
     * - 更新 `PATCH  /workspaces/{ws}/agents/{pid}/memories/{memoryId}`（body 同上字段子集）
     * - 删除 `DELETE /workspaces/{ws}/agents/{pid}/memories/{memoryId}`
     *
     * 返回 `void`：调用方成功后重读列表（见 `WorkspaceAgentMemoryInput` 的说明），
     * 因此 CP 的 201/200 返回体形状不构成契约耦合。
     */
    /**
     * PLAN-0667 M3：agent 主体角色绑定列表（**信封 `{items:[…]}`**，Lead 2026-11-05 冻结）。
     *
     * D5(b)：只消费 CP 给的摘要（`atomSummary` ≤3 + `atomCount`），不请求、不展开全集；
     * `isSystem` 缺失按 `false`（fail-closed：不把未知当只读，但解绑仍由 CP 409 兜底）。
     */
    async getAgentRoles(workspaceId: string, principalId: string): Promise<AgentRoleBinding[]> {
        const raw = await request<{
            items?: Array<Record<string, unknown>>;
            bindings?: Array<Record<string, unknown>>;
        }>(
            `/agent-principals/${encodeURIComponent(principalId)}/roles?workspaceId=${encodeURIComponent(workspaceId)}&locale=${encodeURIComponent(catalogLocale())}`,
        );
        // 实际 CP wire（2026-11-05 联调实测）用 `{bindings:[…]}`；冻结稿写的是 `{items:[…]}`。
        // 两种信封都接受，字段同时兼容 roleName/roleDisplayName 与 name/displayName。
        const rows = raw?.items ?? raw?.bindings;
        if (!Array.isArray(rows)) {
            console.warn("[agents] role envelope malformed; treated as empty");
            return [];
        }
        return rows.flatMap((row) => {
            const bindingId = typeof row.bindingId === "string" ? row.bindingId : "";
            const roleId = typeof row.roleId === "string" ? row.roleId : "";
            const name =
                typeof row.roleName === "string"
                    ? row.roleName
                    : typeof row.name === "string"
                      ? row.name
                      : "";
            if (!bindingId || !roleId || !name) return [];
            const rawAtoms = Array.isArray(row.atoms)
                ? row.atoms
                : Array.isArray(row.atomSummary)
                  ? row.atomSummary
                  : [];
            const atoms = rawAtoms.filter((atom): atom is string => typeof atom === "string");
            // D5(b)：UI 只展示前 3 个 + 总数，不铺全集。
            const atomSummary = atoms.slice(0, 3);
            const atomCount =
                typeof row.atomCount === "number" && Number.isFinite(row.atomCount)
                    ? row.atomCount
                    : atoms.length;
            return [
                {
                    bindingId,
                    roleId,
                    name,
                    displayName:
                        typeof row.roleDisplayName === "string"
                            ? row.roleDisplayName
                            : typeof row.displayName === "string"
                              ? row.displayName
                              : null,
                    scopeType: typeof row.scopeType === "string" ? row.scopeType : "",
                    scopeId: typeof row.scopeId === "string" ? row.scopeId : null,
                    scopeName: typeof row.scopeName === "string" ? row.scopeName : null,
                    isSystem: row.isSystem === true,
                    grantedBy: typeof row.grantedBy === "string" ? row.grantedBy : null,
                    atomSummary,
                    atomCount,
                    atomsTruncated: row.atomsTruncated === true || atomCount > atomSummary.length,
                },
            ];
        });
    },
    /** 绑定角色（body `{roleId}`；`workspaceId` 是授权上下文，2026-11-05 联调实测必需）。 */
    async bindAgentRole(workspaceId: string, principalId: string, roleId: string): Promise<void> {
        await request<void>(
            `/agent-principals/${encodeURIComponent(principalId)}/roles?workspaceId=${encodeURIComponent(workspaceId)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ roleId }),
            },
        );
    },
    async unbindAgentRole(
        workspaceId: string,
        principalId: string,
        bindingId: string,
    ): Promise<void> {
        await request<void>(
            `/agent-principals/${encodeURIComponent(principalId)}/roles/${encodeURIComponent(bindingId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
            { method: "DELETE" },
        );
    },
    /** PLAN-0667 M3：agent 主体技能绑定列表（信封 `{items:[…]}`，CP M2 待合入；两种信封都接受）。 */
    async getAgentSkills(workspaceId: string, principalId: string): Promise<AgentSkillBinding[]> {
        const raw = await request<{
            items?: Array<Record<string, unknown>>;
            bindings?: Array<Record<string, unknown>>;
        }>(
            `/agent-principals/${encodeURIComponent(principalId)}/skills?workspaceId=${encodeURIComponent(workspaceId)}`,
        );
        const rows = raw?.items ?? raw?.bindings;
        if (!Array.isArray(rows)) {
            console.warn("[agents] skill envelope malformed; treated as empty");
            return [];
        }
        return rows.flatMap((row) => {
            const bindingId = typeof row.bindingId === "string" ? row.bindingId : "";
            const skillId = typeof row.skillId === "string" ? row.skillId : "";
            const name = typeof row.name === "string" ? row.name : "";
            if (!bindingId || !skillId || !name) return [];
            return [
                {
                    bindingId,
                    skillId,
                    name,
                    description: typeof row.description === "string" ? row.description : null,
                    sourceType: typeof row.sourceType === "string" ? row.sourceType : null,
                    sourceName: typeof row.sourceName === "string" ? row.sourceName : null,
                    tokenEstimate:
                        typeof row.tokenEstimate === "number" && Number.isFinite(row.tokenEstimate)
                            ? row.tokenEstimate
                            : null,
                },
            ];
        });
    },
    /** 绑定技能（body `{skillId}`）。 */
    async bindAgentSkill(workspaceId: string, principalId: string, skillId: string): Promise<void> {
        await request<void>(
            `/agent-principals/${encodeURIComponent(principalId)}/skills?workspaceId=${encodeURIComponent(workspaceId)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ skillId }),
            },
        );
    },
    async unbindAgentSkill(
        workspaceId: string,
        principalId: string,
        bindingId: string,
    ): Promise<void> {
        await request<void>(
            `/agent-principals/${encodeURIComponent(principalId)}/skills/${encodeURIComponent(bindingId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
            { method: "DELETE" },
        );
    },
    /**
     * 可绑定技能候选（复用 CP 既有 `GET /api/v1/skills` → `{items:[…]}`，不新增契约）。
     * 只取 UI 需要的最小字段；缺字段的行丢弃（fail-closed）。
     */
    async getSkills(): Promise<AgentSkillSummary[]> {
        const raw = await request<{ items?: Array<Record<string, unknown>> }>("/skills");
        if (!Array.isArray(raw?.items)) return [];
        return raw.items.flatMap((row) => {
            const skillId = typeof row.skillId === "string" ? row.skillId : "";
            const name = typeof row.name === "string" ? row.name : "";
            if (!skillId || !name) return [];
            const scope = row.definitionScope as
                | { type?: unknown; workspaceId?: unknown }
                | undefined;
            return [
                {
                    skillId,
                    name,
                    definitionScope:
                        scope && typeof scope.type === "string"
                            ? {
                                  type: scope.type,
                                  workspaceId:
                                      typeof scope.workspaceId === "string"
                                          ? scope.workspaceId
                                          : null,
                              }
                            : null,
                },
            ];
        });
    },
    async createAgentMemory(
        workspaceId: string,
        principalId: string,
        input: WorkspaceAgentMemoryInput,
    ): Promise<void> {
        await request<void>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}/memories`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(input),
            },
        );
    },
    async updateAgentMemory(
        workspaceId: string,
        principalId: string,
        memoryId: string,
        input: WorkspaceAgentMemoryInput,
    ): Promise<void> {
        await request<void>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}/memories/${encodeURIComponent(memoryId)}`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(input),
            },
        );
    },
    async deleteAgentMemory(
        workspaceId: string,
        principalId: string,
        memoryId: string,
    ): Promise<void> {
        await request<void>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}/memories/${encodeURIComponent(memoryId)}`,
            { method: "DELETE" },
        );
    },
    /**
     * 主体级能力开关（目前只用于「启用记忆」）。`PATCH /api/v1/agent-principals/{id}`
     * 的 `contextPolicy` 是**整对象替换**（CP 侧 `PATCH_BODY_KEYS` 只认
     * `hooks`/`contextPolicy`/`delegationPolicy`，且 null 表示清空），
     * 因此调用方必须传入合并后的完整对象，不能只发 `{memory}`。
     */
    async updateAgentPrincipalContextPolicy(
        principalId: string,
        contextPolicy: Record<string, unknown> | null,
    ): Promise<void> {
        await request<void>(`/agent-principals/${encodeURIComponent(principalId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contextPolicy }),
        });
    },
    /**
     * PLAN-0621 F-01：`GET /api/v1/me/permissions` 是 CP 的**权威能力投影**
     * （`CapabilityProjectionService.SelfPermissions`）。UI 用它判断"能否创建 Agent principal"，
     * 而不是从 `isInstanceAdmin` 之类的粗略标志猜——授权来自角色绑定里的原子，不是角色名。
     */
    getSelfPermissions(): Promise<SelfPermissionsView> {
        return request<SelfPermissionsView>("/me/permissions");
    },
    /**
     * PLAN-0610 W3-2a: the access-role definition surface. The atom vocabulary is **not** in the UI —
     * `rolesCatalog()` is the only source, so a new atom appears without a front-end change.
     */
    rolesCatalog(): Promise<ApiRoleCatalog> {
        // D51-37: the CP resolves the label server-side from an explicit locale; the UI keeps no
        // atom vocabulary. `<html lang>` is the locale SSOT written by applyLocale().
        return request<ApiRoleCatalog>(
            `/roles/catalog?locale=${encodeURIComponent(catalogLocale())}`,
        );
    },
    listRoles(workspaceId?: string): Promise<ApiRole[]> {
        // PLAN-0667 M3：候选角色按 workspace 授权上下文过滤（Lead 2026-11-05 冻结：不新增候选端点）。
        const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
        return request<ApiRole[]>(`/roles${query}`);
    },
    createRole(input: ApiRoleWrite): Promise<ApiRole> {
        return request<ApiRole>("/roles", { method: "POST", body: JSON.stringify(input) });
    },
    updateRole(roleId: string, input: ApiRoleWrite): Promise<ApiRole> {
        return request<ApiRole>(`/roles/${encodeURIComponent(roleId)}`, {
            method: "PATCH",
            body: JSON.stringify(input),
        });
    },
    async deleteRole(roleId: string): Promise<void> {
        await request<void>(`/roles/${encodeURIComponent(roleId)}`, { method: "DELETE" });
    },
    /** `GET /bindings`: one scope's complete user binding set (no capability echo on the wire). */
    getBindings(scope: ApiBindingScope, scopeId?: string | null): Promise<ApiBindingSet> {
        const query = new URLSearchParams({ scope });
        if (scope === "workspace" && scopeId) query.set("scopeId", scopeId);
        return request<ApiBindingSet>(`/bindings?${query.toString()}`);
    },
    /** `PUT /bindings`: full replacement — the body is the desired end state, not a delta. */
    replaceBindings(
        scope: ApiBindingScope,
        scopeId: string | null | undefined,
        bindings: ApiBindingInput[],
    ): Promise<ApiBindingSet> {
        const query = new URLSearchParams({ scope });
        if (scope === "workspace" && scopeId) query.set("scopeId", scopeId);
        return request<ApiBindingSet>(`/bindings?${query.toString()}`, {
            method: "PUT",
            body: JSON.stringify({ bindings }),
        });
    },
    /** Admin user directory (`cap:instance:admin`); used to resolve binding subjects. */
    async listAdminUsers(query: string): Promise<ApiAdminUser[]> {
        const params = new URLSearchParams({ size: "50" });
        if (query.trim()) params.set("q", query.trim());
        const body = await request<{ items?: ApiAdminUser[] }>(`/users?${params.toString()}`);
        return Array.isArray(body?.items) ? body.items : [];
    },
    getAgentTemplates(
        layer: AgentTemplateLayerResponse["layer"],
        workspaceId?: string,
    ): Promise<AgentTemplateLayerResponse> {
        const query = new URLSearchParams({ layer });
        if (layer === "workspace" && workspaceId) query.set("workspaceId", workspaceId);
        return request<AgentTemplateLayerResponse>(`/agent-templates?${query.toString()}`);
    },
    /**
     * PLAN-0622 冻结契约 body：`{name, templateId?, scope?, defaultModelProvider?,
     * defaultModelName?, allowedModels?}`。只发传进来的字段——`undefined` 表示"不设置"，
     * 由 CP 决定默认（不要把空字符串/空数组硬塞进去）。
     */
    createAgentPrincipal(input: AgentPrincipalCreateInput): Promise<AgentPrincipalCreateResponse> {
        const body: Record<string, unknown> = { name: input.name };
        if (input.templateId) body.templateId = input.templateId;
        if (input.scope) body.scope = input.scope;
        if (input.defaultModelProvider) body.defaultModelProvider = input.defaultModelProvider;
        if (input.defaultModelName) body.defaultModelName = input.defaultModelName;
        if (input.allowedModels && input.allowedModels.length > 0) {
            body.allowedModels = input.allowedModels;
        }
        return request<AgentPrincipalCreateResponse>("/agent-principals", {
            method: "POST",
            body: JSON.stringify(body),
        });
    },
    /** PLAN-0622：禁用 agent 主体（`204`）。禁用后新会话不可选。 */
    disableAgentPrincipal(principalId: string): Promise<void> {
        return request<void>(`/agent-principals/${encodeURIComponent(principalId)}/disable`, {
            method: "POST",
        });
    },
    updateWorkspaceAgentCap(
        workspaceId: string,
        principalId: string,
        permissions: WorkspaceAgentPermission[],
    ): Promise<WorkspaceAgentCapResponse> {
        return request<WorkspaceAgentCapResponse>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}`,
            { method: "PUT", body: JSON.stringify({ permissions }) },
        );
    },
    deleteWorkspaceAgent(workspaceId: string, principalId: string): Promise<void> {
        return request<void>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}`,
            { method: "DELETE" },
        );
    },
    async updateSession(id: string, patch: SessionBindingPatch): Promise<SessionResponse> {
        return normalizeSession(
            await request<unknown>(`/sessions/${encodeURIComponent(id)}`, {
                method: "PATCH",
                body: JSON.stringify(patch),
            }),
        );
    },
    /**
     * C1（2026-11-04 用户裁定）：把裸会话按默认绑定重绑（CP `POST /sessions/{id}/bind-defaults`，
     * task-24）。幂等：已绑定的会话原样返回；无可用默认 ⇒ 400 `PROVIDER_REQUIRED`。
     * 发送前守卫用它做「自动绑定」，不静默失败。
     */
    async bindSessionDefaults(sessionId: string): Promise<SessionResponse> {
        return normalizeSession(
            await request<unknown>(`/sessions/${encodeURIComponent(sessionId)}/bind-defaults`, {
                method: "POST",
            }),
        );
    },
    deleteSession(id: string) {
        return apiDelete(`/sessions/${encodeURIComponent(id)}`);
    },
    getSessionBranches(sessionId: string) {
        return request<{ sessionId: string; items: ApiSessionBranch[] }>(
            `/sessions/${encodeURIComponent(sessionId)}/branches`,
        );
    },
    createSessionBranch(
        sessionId: string,
        body: { sourceBranchId: string; anchorMessageId: string },
        idempotencyKey: string,
    ) {
        return request<SessionBranchCreateResponse>(
            `/sessions/${encodeURIComponent(sessionId)}/branches`,
            {
                method: "POST",
                headers: { "Idempotency-Key": idempotencyKey },
                body: JSON.stringify(body),
            },
        );
    },
    getChatRunGuidance(runId: string): Promise<ChatRunGuidanceSnapshot> {
        return request<unknown>(`/chat/runs/${encodeURIComponent(runId)}/guidance`).then(
            normalizeGuidanceSnapshot,
        );
    },
    async submitChatRunGuidance(
        runId: string,
        content: string,
        idempotencyKey: string,
    ): Promise<ChatRunGuidanceCreateResult> {
        const payload = await request<unknown>(`/chat/runs/${encodeURIComponent(runId)}/guidance`, {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey },
            body: JSON.stringify({ content }),
        });
        return normalizeGuidanceCreateResult(payload, runId);
    },
    getFollowUpQueue(sessionId: string): Promise<ApiFollowUpQueueSnapshot> {
        return request<ApiFollowUpQueueSnapshot>(
            `/sessions/${encodeURIComponent(sessionId)}/follow-ups`,
        );
    },
    enqueueFollowUp(
        sessionId: string,
        body: ApiFollowUpCreateRequest,
        idempotencyKey: string,
    ): Promise<ApiFollowUpQueueSnapshot> {
        return request<ApiFollowUpQueueSnapshot>(
            `/sessions/${encodeURIComponent(sessionId)}/follow-ups`,
            {
                method: "POST",
                headers: { "Idempotency-Key": idempotencyKey },
                body: JSON.stringify(body),
            },
        );
    },
    withdrawFollowUp(sessionId: string, itemId: string): Promise<ApiFollowUpQueueSnapshot> {
        return request<ApiFollowUpQueueSnapshot>(
            `/sessions/${encodeURIComponent(sessionId)}/follow-ups/${encodeURIComponent(itemId)}`,
            { method: "DELETE" },
        );
    },
    continueFollowUpQueue(sessionId: string): Promise<ApiFollowUpQueueSnapshot> {
        return request<ApiFollowUpQueueSnapshot>(
            `/sessions/${encodeURIComponent(sessionId)}/follow-ups/continue`,
            { method: "POST" },
        );
    },
    getMessages(
        sessionId: string,
        branchId: string,
        options: { limit?: number; before?: string } = {},
    ) {
        // PLAN-0670 M2d.1（Lead 2026-11-05 裁定 a）：分页参数**可选**；CP 未支持时忽略未知
        // query（继续返回全量数组），调用方据此自动退化 —— 行为与改造前逐字节一致。
        // 只有响应带 `nextCursor`/`truncated` 时 UI 才显示「加载更早」入口（不硬编码假设）。
        const query = new URLSearchParams({ branchId });
        if (options.limit !== undefined) query.set("limit", String(options.limit));
        if (options.before) query.set("before", options.before);
        return request<
            | ApiSessionMessage[]
            | {
                  messages?: ApiSessionMessage[];
                  items?: ApiSessionMessage[];
                  nextCursor?: string | null;
                  truncated?: boolean;
              }
        >(`/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`);
    },
    /**
     * PLAN-0465 T2.1：durable job 输出续看（canonical 路径
     * `GET /api/v1/workspaces/{workspaceId}/jobs/{jobId}/output` with byte offsets
     * and Workspace access.
     */
    getJobOutput(
        workspaceId: string,
        jobId: string,
        options?: { stream?: "stdout" | "stderr"; offset?: number; limit?: number },
    ): Promise<{
        jobId: string;
        runtimeJobId?: string;
        stream: string;
        offset: number;
        nextOffset: number;
        sizeBytes: number;
        truncated: boolean;
        data: string;
        jobStatus: string;
    }> {
        const params = new URLSearchParams();
        if (options?.stream) params.set("stream", options.stream);
        if (options?.offset !== undefined) params.set("offset", String(options.offset));
        if (options?.limit !== undefined) params.set("limit", String(options.limit));
        const query = params.toString();
        return request(
            `/workspaces/${encodeURIComponent(workspaceId)}/jobs/${encodeURIComponent(jobId)}/output${query ? `?${query}` : ""}`,
        );
    },
    deleteMessage(sessionId: string, messageId: string) {
        return apiDelete(
            `/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
        );
    },
    /** PLAN-0366：stdio 服务器配置名单（name → config；公开响应不暴露 enabled）。 */
    getStdioServers(wsId: string) {
        return request<{
            generation?: number;
            hash?: string;
            servers?: Record<string, unknown>;
        }>(`/workspaces/${encodeURIComponent(wsId)}/stdio-servers`);
    },
    /** PLAN-0366：stdio MCP 会话状态快照（CP 显式映射 camelCase；state 为小写字面量）。 */
    getMcpServerStatus(wsId: string) {
        return request<{
            servers: Array<{
                serverId: string;
                state: string;
                attempt: number;
                lastError: string | null;
                sinceMs: number;
                epoch: number;
            }>;
            count: number;
        }>(`/workspaces/${encodeURIComponent(wsId)}/mcp/servers`);
    },
    /**
     * PLAN-0465 T2.1：取消 durable job（canonical 路径 `POST
     * /api/v1/workspaces/{workspaceId}/jobs/{jobId}/cancel`，**Workspace access**
     * ——按控制器实际行为，非 owner-only；幂等；不改 run/对话终态）。
     * 响应 `jobId` = domain 身份（decision #7，无 `itemId`）。
     */
    cancelJob(workspaceId: string, jobId: string) {
        return apiPost<{ jobId: string; status: string; changed: boolean }>(
            `/workspaces/${encodeURIComponent(workspaceId)}/jobs/${encodeURIComponent(jobId)}/cancel`,
        );
    },
    decideChatApproval(
        requestId: string,
        decision: ApprovalDecision | boolean,
    ): Promise<ChatApprovalDecisionResponse> {
        return request<ChatApprovalDecisionResponse>(
            `/chat/approvals/${encodeURIComponent(requestId)}/decision`,
            {
                method: "POST",
                body: JSON.stringify(
                    typeof decision === "boolean" ? { approved: decision } : decision,
                ),
            },
        );
    },
    async getPendingApprovals(signal?: AbortSignal): Promise<PendingApprovalSummary[]> {
        const controller = new AbortController(),
            timeout = setTimeout(() => controller.abort(), 5000),
            abortFromCaller = () => controller.abort();
        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener("abort", abortFromCaller, { once: true });
        }
        try {
            const payload = await request<unknown>("/approvals/pending", {
                signal: controller.signal,
            });
            if (!Array.isArray(payload))
                throw new Error("Invalid pending approvals response: expected an array");
            const summaries = payload.map(normalizePendingApprovalSummary);
            if (summaries.some((summary): summary is null => summary === null)) {
                throw new Error("Invalid pending approvals response: malformed summary");
            }
            return summaries.filter(
                (summary): summary is PendingApprovalSummary => summary !== null,
            );
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abortFromCaller);
        }
    },
    async getPolicyMode(sessionId: string): Promise<SessionPolicyModeState> {
        const query = new URLSearchParams({ sessionId }).toString();
        return normalizePolicyModeState(await request<unknown>(`/policy/mode?${query}`), sessionId);
    },
    async setPolicyMode(
        sessionId: string,
        mode: SessionPolicyMode,
    ): Promise<PolicyModeUpdateResponse> {
        return normalizePolicyModeUpdateResponse(
            await request<unknown>("/policy/mode", {
                method: "POST",
                body: JSON.stringify({ sessionId, mode }),
            }),
            sessionId,
        );
    },
    /** PLAN-0328 M1: per-domain effective layer and per-layer rule counts. */
    async listPolicyDomains(): Promise<PolicyDomainView[]> {
        return normalizePolicyArray(
            await request<unknown>("/policy/domains"),
            normalizePolicyDomainView,
            "policy domains",
        );
    },
    /** Rules of one persisted layer, including the server's `effective` flag and `conflict` note. */
    async listPolicyRules(layer: PolicyRuleLayer): Promise<PolicyRuleView[]> {
        const query = new URLSearchParams({ layer }).toString();
        return normalizePolicyArray(
            await request<unknown>(`/policy/rules?${query}`),
            normalizePolicyRuleView,
            "policy rules",
        );
    },
    async createPolicyRule(input: {
        layer: PolicyRuleLayer;
        actionClass: string;
        resource: string;
        effect: ApprovalPolicyEffect;
        priority?: number;
        locked?: boolean;
    }): Promise<PolicyRuleView> {
        const body: Record<string, unknown> = {
            layer: input.layer,
            actionClass: input.actionClass,
            resource: input.resource,
            effect: input.effect,
        };
        if (input.priority !== undefined) body.priority = input.priority;
        if (input.locked !== undefined) body.locked = input.locked;
        return normalizePolicyRuleView(
            await request<unknown>("/policy/rules", {
                method: "POST",
                body: JSON.stringify(body),
            }),
        );
    },
    deletePolicyRule(id: string, layer: PolicyRuleLayer) {
        const query = new URLSearchParams({ layer }).toString();
        return apiDelete(`/policy/rules/${encodeURIComponent(id)}?${query}`);
    },
    /** Static conflict view for one layer: the subset of rules carrying a `conflict` note. */
    async listPolicyRuleConflicts(layer: PolicyRuleLayer): Promise<PolicyRuleView[]> {
        const query = new URLSearchParams({ layer }).toString();
        return normalizePolicyArray(
            await request<unknown>(`/policy/rules/conflicts?${query}`),
            normalizePolicyRuleView,
            "policy rule conflicts",
        );
    },
    /**
     * Effective tool-face catalog. `builtin` is response metadata only: persisted instance rows
     * override built-ins and workspace rows override both for a workspace request.
     */
    async listPolicyToolFaces(scope: PolicyToolFaceQueryScope): Promise<PolicyToolFaceView[]> {
        const query = new URLSearchParams({ scope }).toString();
        return normalizePolicyArray(
            await request<unknown>(`/policy/tool-faces?${query}`),
            normalizePolicyToolFace,
            "policy tool-faces",
        );
    },
    /** Explicit classification (workspace OWNER/ADMIN, or instance ADMIN). Never automatic. */
    async upsertPolicyToolFace(input: {
        scope: PolicyToolFaceQueryScope;
        tool: string;
        actionClass: string;
        shape: ApprovalPolicyShape;
    }): Promise<PolicyToolFaceView> {
        return normalizePolicyToolFace(
            await request<unknown>("/policy/tool-faces", {
                method: "POST",
                body: JSON.stringify({
                    scope: input.scope,
                    tool: input.tool,
                    actionClass: input.actionClass,
                    shape: input.shape,
                }),
            }),
        );
    },
    getHealth() {
        return request<{ status: string }>("/health");
    },
    getVersionInfo() {
        return request<VersionInfo>("/version");
    },
    getServiceStatus() {
        return request<{
            status: string;
            timestamp: number;
            services: Array<{
                name: string;
                key: string;
                status: string;
                responseMs?: number;
                error?: string;
                version?: string;
                database?: string;
                size?: string;
                connections?: number;
                url?: string;
                details?: string;
            }>;
        }>("/status");
    },
    /**
     * PLAN-0466 T2.1: one page of `GET /api/v1/audit/entries` — the four-domain
     * audit view (chat_run | workspace_job | mcp_invocation | approval), user tier.
     */
    async listAuditEntries(filters: AuditListFilters = {}): Promise<AuditListResponse> {
        const params = new URLSearchParams();
        if (filters.sessionId) params.set("sessionId", filters.sessionId);
        if (filters.workspaceId) params.set("workspaceId", filters.workspaceId);
        if (filters.type) params.set("type", filters.type);
        if (filters.status) params.set("status", filters.status);
        if (filters.page !== undefined) params.set("page", String(filters.page));
        if (filters.size !== undefined) params.set("size", String(filters.size));
        const query = params.toString();
        return normalizeAuditList(
            await request<unknown>(`/audit/entries${query ? `?${query}` : ""}`),
        );
    },
    /** PLAN-0466 T2.1: one entry + that domain's history timeline (`GET /api/v1/audit/entries/{type}/{id}`). */
    async getAuditEntry(type: AuditEntryType, id: string): Promise<AuditEntryDetail> {
        return normalizeAuditDetail(
            await request<unknown>(
                `/audit/entries/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
            ),
        );
    },
    /**
     * PLAN-0639 M2: `rootId` scopes the listing to one declared root of a multi-root
     * workspace (design §5 candidate ①). Omitting it keeps the legacy primary-root
     * behavior; the argument is forwarded as a tool argument for the Runtime to honor.
     */
    async listDirectory(path: string, workspaceId: string, rootId?: string) {
        const raw = await callRuntimeTool<{
                entries?: Array<{
                    name: string;
                    path: string;
                    is_dir?: boolean;
                    type?: string;
                    size?: number;
                    modified?: string;
                }>;
            }>("list_directory", rootId ? { path, rootId } : { path }, workspaceId),
            entries = (raw?.entries ?? []).map((e) => ({
                name: e.name,
                path: e.path,
                type: e.type ?? (e.is_dir ? "directory" : "file"),
                size: e.size,
                modified: e.modified,
            }));
        return { entries };
    },
    // PLAN-0639 M2: every file operation accepts an optional `rootId` that scopes the
    // path to one declared root of a multi-root workspace; omitted = primary root
    // (legacy behavior). The Runtime resolves the root, the UI never builds absolute
    // host paths (design §5, D39-5 hard boundary).
    async readFile(path: string, workspaceId: string, rootId?: string) {
        const content = await callRuntimeTool<string>(
            "read_file",
            rootId ? { path, rootId } : { path },
            workspaceId,
        );
        return { content: typeof content === "string" ? content : String(content) };
    },
    // PLAN-292 T6: binary-safe read — the tool returns {content, total_lines,
    // is_binary} where content is base64 when is_binary is true.
    async readFileRange(
        path: string,
        workspaceId: string,
        offset?: number,
        limit?: number,
        rootId?: string,
    ) {
        const args: Record<string, unknown> = rootId ? { path, rootId } : { path };
        if (offset !== undefined) args.offset = offset;
        if (limit !== undefined) args.limit = limit;
        return callRuntimeTool<{ content: string; total_lines: number; is_binary: boolean }>(
            "read_file_range",
            args,
            workspaceId,
        );
    },
    async writeFile(path: string, content: string, workspaceId: string, rootId?: string) {
        await callRuntimeTool<string>(
            "write_file",
            rootId ? { path, content, rootId } : { path, content },
            workspaceId,
        );
        return { success: true };
    },
    async deleteFile(path: string, workspaceId: string, rootId?: string) {
        await callRuntimeTool<string>(
            "delete_file",
            rootId ? { path, rootId } : { path },
            workspaceId,
        );
        return { success: true };
    },
    async moveFile(from: string, to: string, workspaceId: string, rootId?: string) {
        await callRuntimeTool<string>(
            "move_file",
            rootId ? { from, to, rootId } : { from, to },
            workspaceId,
        );
        return { success: true };
    },
    async copyFile(from: string, to: string, workspaceId: string, rootId?: string) {
        await callRuntimeTool<string>(
            "copy_file",
            rootId ? { from, to, rootId } : { from, to },
            workspaceId,
        );
        return { success: true };
    },
    async createDirectory(path: string, workspaceId: string, rootId?: string) {
        await callRuntimeTool<string>("mkdir", rootId ? { path, rootId } : { path }, workspaceId);
        return { success: true };
    },
    getMcpConfig(wsId: string) {
        return request<{ mcpServers?: string | Record<string, unknown> }>(
            `/workspaces/${encodeURIComponent(wsId)}/mcp-config`,
            {
                headers: workspaceHeaders(wsId),
            },
        );
    },
    async getCurrentWorkspace(): Promise<ApiWorkspace> {
        return normalizeWorkspaceResponse(await request<unknown>("/workspaces/current"));
    },
    async listWorkspaces(): Promise<ApiWorkspace[]> {
        const response = await request<unknown[]>("/workspaces");
        return Array.isArray(response) ? response.map(normalizeWorkspaceResponse) : [];
    },
    async getWorkspace(wsId: string): Promise<ApiWorkspace> {
        return normalizeWorkspaceResponse(
            await request<unknown>(`/workspaces/${encodeURIComponent(wsId)}`, {
                headers: workspaceHeaders(wsId),
            }),
        );
    },
    async listImportSources(path: string): Promise<{
        path: string;
        entries: Array<{ name: string; kind: string; readable: boolean; size: number }>;
    }> {
        return request(`/workspaces/import-sources?path=${encodeURIComponent(path)}`);
    },
    /**
     * PLAN-0384 T1.3: Runtime-backed direct-attach capability preflight. A reachable Runtime
     * always answers 200 (including `available:false` with a stable `reason`); an unreachable
     * Runtime or invalid JSON is a 502 `RUNTIME_UNAVAILABLE` rejection.
     */
    preflightDirectAttach(input: {
        hostPath: string;
        executionMode: WorkspaceDirectAttachExecutionMode;
    }): Promise<WorkspaceCapabilityPreflight> {
        return request<WorkspaceCapabilityPreflight>("/workspaces/capabilities/preflight", {
            method: "POST",
            body: JSON.stringify({
                storageMode: "direct_attach",
                hostPath: input.hostPath,
                executionMode: input.executionMode,
            }),
        });
    },
    async startWorkspaceImport(
        workspaceId: string,
        input: {
            sourcePath: string;
            excludeRules?: string[];
            idempotencyKey: string;
        },
    ): Promise<Record<string, unknown>> {
        return request(`/workspaces/${encodeURIComponent(workspaceId)}/imports`, {
            method: "POST",
            headers: workspaceHeaders(workspaceId),
            body: JSON.stringify(input),
        });
    },
    async getWorkspaceImport(importId: string): Promise<Record<string, unknown>> {
        return request(`/workspace-imports/${encodeURIComponent(importId)}`);
    },
    /** PLAN-0384 V5: durable import records for a workspace, used to recover an in-flight import. */
    async listWorkspaceImports(workspaceId: string): Promise<Array<Record<string, unknown>>> {
        const result = await request<unknown>(
            `/workspaces/${encodeURIComponent(workspaceId)}/imports`,
            {
                headers: workspaceHeaders(workspaceId),
            },
        );
        return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
    },
    async cancelWorkspaceImport(importId: string): Promise<Record<string, unknown>> {
        return request(`/workspace-imports/${encodeURIComponent(importId)}/cancel`, {
            method: "POST",
        });
    },
    async createWorkspace(input: {
        name?: string;
        description?: string | null;
        profile?: "strict" | "coding" | "isolated";
        storageMode?: WorkspaceStorageMode;
        hostPath?: string;
        roots?: { path: string; alias?: string | null }[];
        executionMode?: WorkspaceExecutionMode;
        idempotencyKey?: string;
    }): Promise<ApiWorkspace> {
        const body: Record<string, unknown> = {};
        if (input.name !== undefined) body.name = input.name;
        if (input.description !== undefined) body.description = input.description;
        if (input.profile !== undefined) body.profile = input.profile;
        if (input.storageMode !== undefined) body.storageMode = input.storageMode;
        if (input.hostPath !== undefined) body.hostPath = input.hostPath;
        // PLAN-0639 M1: multi-root creation.  Mutually exclusive with hostPath.
        if (input.roots !== undefined) body.roots = input.roots;
        if (input.executionMode !== undefined) body.executionMode = input.executionMode;
        // image is server-allowlisted (v1: xihe/workspace:latest); UI keeps it read-only.
        return normalizeWorkspaceResponse(
            await request<unknown>("/workspaces", {
                method: "POST",
                headers: {
                    "Idempotency-Key": input.idempotencyKey ?? globalThis.crypto.randomUUID(),
                },
                body: JSON.stringify(body),
            }),
        );
    },

    /** PLAN-0639 M1: add a root to an existing workspace. */
    async addWorkspaceRoot(
        wsId: string,
        input: { path: string; alias?: string | null },
    ): Promise<{ id: string; alias: string | null; position: number }> {
        return request(`/workspaces/${encodeURIComponent(wsId)}/roots`, {
            method: "POST",
            headers: workspaceHeaders(wsId),
            body: JSON.stringify(input),
        });
    },

    /** PLAN-0641 T2.5: undeclared nested git repositories (TTL-cached CP read face). */
    async listWorkspaceNestedRepos(wsId: string): Promise<ApiNestedRepoItem[]> {
        const view = await request<ApiNestedReposView>(
            `/workspaces/${encodeURIComponent(wsId)}/nested-repos`,
            { method: "GET", headers: workspaceHeaders(wsId) },
        );
        return Array.isArray(view.items) ? view.items : [];
    },

    /** PLAN-0639 M1: patch a root's alias or position. */
    async patchWorkspaceRoot(
        wsId: string,
        rootId: string,
        input: { alias?: string | null; position?: number },
    ): Promise<{ id: string; alias: string | null; position: number }> {
        return request(
            `/workspaces/${encodeURIComponent(wsId)}/roots/${encodeURIComponent(rootId)}`,
            {
                method: "PATCH",
                headers: workspaceHeaders(wsId),
                body: JSON.stringify(input),
            },
        );
    },

    /** PLAN-0639 M1: soft-delete a root. */
    async deleteWorkspaceRoot(wsId: string, rootId: string): Promise<void> {
        return request<void>(
            `/workspaces/${encodeURIComponent(wsId)}/roots/${encodeURIComponent(rootId)}`,
            {
                method: "DELETE",
                headers: workspaceHeaders(wsId),
            },
        );
    },
    async updateWorkspace(
        wsId: string,
        patch: { name?: string; description?: string | null },
    ): Promise<ApiWorkspace> {
        return normalizeWorkspaceResponse(
            await request<unknown>(`/workspaces/${encodeURIComponent(wsId)}`, {
                method: "PATCH",
                headers: workspaceHeaders(wsId),
                body: JSON.stringify(patch),
            }),
        );
    },
    deleteWorkspace(wsId: string) {
        return request<void>(`/workspaces/${encodeURIComponent(wsId)}`, {
            method: "DELETE",
            headers: workspaceHeaders(wsId),
        });
    },
    async listWorkspaceMembers(wsId: string): Promise<ApiWorkspaceMember[]> {
        const response = await request<unknown[]>(
            `/workspaces/${encodeURIComponent(wsId)}/members`,
            { headers: workspaceHeaders(wsId) },
        );
        return Array.isArray(response) ? (response as ApiWorkspaceMember[]) : [];
    },
    async addWorkspaceMember(
        wsId: string,
        input: { username: string; role: MemberAssignableRole },
    ): Promise<ApiWorkspaceMember> {
        return await request<ApiWorkspaceMember>(
            `/workspaces/${encodeURIComponent(wsId)}/members`,
            {
                method: "POST",
                headers: workspaceHeaders(wsId),
                body: JSON.stringify(input),
            },
        );
    },
    async updateWorkspaceMemberRole(
        wsId: string,
        userId: string,
        role: MemberAssignableRole,
    ): Promise<ApiWorkspaceMember> {
        return await request<ApiWorkspaceMember>(
            `/workspaces/${encodeURIComponent(wsId)}/members/${encodeURIComponent(userId)}`,
            {
                method: "PATCH",
                headers: workspaceHeaders(wsId),
                body: JSON.stringify({ role }),
            },
        );
    },
    removeWorkspaceMember(wsId: string, userId: string) {
        return request<void>(
            `/workspaces/${encodeURIComponent(wsId)}/members/${encodeURIComponent(userId)}`,
            {
                method: "DELETE",
                headers: workspaceHeaders(wsId),
            },
        );
    },
    getWorkspaceEnvironment(wsId: string) {
        return request<WorkspaceEnvironment>(
            `/workspaces/${encodeURIComponent(wsId)}/environment`,
            {
                headers: workspaceHeaders(wsId),
            },
        );
    },
    getWorkspaceJobs(wsId: string) {
        return request<WorkspaceJob[]>(`/workspaces/${encodeURIComponent(wsId)}/jobs`, {
            headers: workspaceHeaders(wsId),
        });
    },
    // PLAN-0489 T2.1: workspace scheduled tasks (openapi scheduled-tasks 5 routes).
    listScheduledTasks(
        wsId: string,
        options: { page?: number; size?: number } = {},
    ): Promise<ScheduledTaskListPage> {
        const params = new URLSearchParams();
        if (options.page !== undefined) params.set("page", String(options.page));
        if (options.size !== undefined) params.set("size", String(options.size));
        const query = params.toString();
        return request<ScheduledTaskListPage>(
            `/workspaces/${encodeURIComponent(wsId)}/scheduled-tasks${query ? `?${query}` : ""}`,
            { headers: workspaceHeaders(wsId) },
        );
    },
    createScheduledTask(wsId: string, body: ScheduledTaskCreateRequest): Promise<ScheduledTask> {
        return request<ScheduledTask>(`/workspaces/${encodeURIComponent(wsId)}/scheduled-tasks`, {
            method: "POST",
            headers: workspaceHeaders(wsId),
            body: JSON.stringify(body),
        });
    },
    getScheduledTask(wsId: string, taskId: string): Promise<ScheduledTask> {
        return request<ScheduledTask>(
            `/workspaces/${encodeURIComponent(wsId)}/scheduled-tasks/${encodeURIComponent(taskId)}`,
            { headers: workspaceHeaders(wsId) },
        );
    },
    /** scheduled→cancelled; missed/expired use removeScheduledTask (409 points there). */
    deleteScheduledTask(wsId: string, taskId: string): Promise<ScheduledTaskDisposeResult> {
        return request<ScheduledTaskDisposeResult>(
            `/workspaces/${encodeURIComponent(wsId)}/scheduled-tasks/${encodeURIComponent(taskId)}`,
            { method: "DELETE", headers: workspaceHeaders(wsId) },
        );
    },
    /** One-shot manual rerun of a missed/expired task; returns the refreshed task view. */
    rerunScheduledTask(wsId: string, taskId: string): Promise<ScheduledTask> {
        return request<ScheduledTask>(
            `/workspaces/${encodeURIComponent(wsId)}/scheduled-tasks/${encodeURIComponent(taskId)}/rerun`,
            { method: "POST", headers: workspaceHeaders(wsId) },
        );
    },
    /** missed/expired→cancelled, idempotent (`200 {changed:false}` when already cancelled). */
    removeScheduledTask(wsId: string, taskId: string): Promise<ScheduledTaskDisposeResult> {
        return request<ScheduledTaskDisposeResult>(
            `/workspaces/${encodeURIComponent(wsId)}/scheduled-tasks/${encodeURIComponent(taskId)}/remove`,
            { method: "POST", headers: workspaceHeaders(wsId) },
        );
    },
    postponeScheduledTask(wsId: string, taskId: string, at: string): Promise<ScheduledTask> {
        return request<ScheduledTask>(
            `/workspaces/${encodeURIComponent(wsId)}/scheduled-tasks/${encodeURIComponent(taskId)}/postpone`,
            {
                method: "POST",
                headers: workspaceHeaders(wsId),
                body: JSON.stringify({ at }),
            },
        );
    },
    /**
     * Start a Workspace Job (202 new / 200 idempotent replay). The `Idempotency-Key` header is
     * required by the server; the same key replays the existing projection instead of launching
     * a second process.
     */
    startWorkspaceJob(
        wsId: string,
        body: WorkspaceJobStartRequest,
        idempotencyKey: string,
    ): Promise<WorkspaceJob> {
        return request<WorkspaceJob>(`/workspaces/${encodeURIComponent(wsId)}/jobs`, {
            method: "POST",
            headers: {
                ...workspaceHeaders(wsId),
                "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify(body),
        });
    },
    updateWorkspaceExecutionMode(wsId: string, executionMode: WorkspaceExecutionMode) {
        return request<{
            workspaceId: string;
            storageMode: WorkspaceStorageMode;
            executionMode: WorkspaceExecutionMode;
            status: string;
        }>(`/workspaces/${encodeURIComponent(wsId)}/execution-mode`, {
            method: "PATCH",
            headers: workspaceHeaders(wsId),
            body: JSON.stringify({ executionMode }),
        });
    },
    /** M4: trigger async materialization (202). Poll getWorkspaceEnvironment for progress. */
    materializeWorkspace(wsId: string) {
        return request<{ status: string }>(`/workspaces/${encodeURIComponent(wsId)}/materialize`, {
            method: "POST",
            headers: workspaceHeaders(wsId),
        });
    },
    /**
     * PLAN-0391: release the workspace runtime (202 accepted / 200 idempotent replay).
     * `Idempotency-Key` is required by the server; 409 WORKSPACE_BUSY when a Job is
     * active or another release is in flight.
     */
    releaseWorkspaceRuntime(wsId: string, idempotencyKey: string) {
        return request<WorkspaceReleaseOperation>(
            `/workspaces/${encodeURIComponent(wsId)}/runtime/release`,
            {
                method: "POST",
                headers: {
                    ...workspaceHeaders(wsId),
                    "Idempotency-Key": idempotencyKey,
                },
            },
        );
    },
    saveMcpConfig(wsId: string, mcpServers: string) {
        return request<{ status: string }>(`/workspaces/${encodeURIComponent(wsId)}/mcp-config`, {
            method: "PUT",
            headers: workspaceHeaders(wsId),
            body: JSON.stringify({ mcpServers }),
        });
    },
    startOAuthSession(body: {
        workspaceId: string;
        serverId: string;
        remoteEndpoint: string;
        clientId: string;
        authorizationEndpoint: string;
        tokenEndpoint: string;
        redirectUri: string;
        scope: string;
    }) {
        return request<{ state: string; authorizationUrl: string; expiresAtMillis: number }>(
            "/oauth/sessions",
            {
                method: "POST",
                body: JSON.stringify(body),
            },
        );
    },
    completeOAuthSession(state: string, code: string) {
        const params = new URLSearchParams({ state, code });
        return request<{ status: string }>(`/oauth/callback?${params.toString()}`);
    },
    cancelChatRun(
        runId: string,
        reason = "user_requested",
    ): Promise<{ status: string; runId: string }> {
        return apiPost(
            `/chat/runs/${encodeURIComponent(runId)}/cancel`,
            JSON.stringify({ reason }),
        );
    },
    // PLAN-292 M3 (C2): run status recovery for reconnected/refreshed clients.
    async getChatRunStatus(runId: string): Promise<{
        runId: string;
        sessionId: string;
        origin: "user_submission" | "spawn";
        status: string;
        terminalOutcome?: string | null;
        // PLAN-0493 T3.1: terminal cause fact (e.g. RUN_NO_PROGRESS).
        errorCode?: string | null;
        leaseExpired: boolean;
        pendingApprovals: ApprovalRequest[];
    }> {
        const payload = await request<unknown>(`/chat/runs/${encodeURIComponent(runId)}`, {
                method: "GET",
            }),
            record = asRecord(payload);
        if (!record || typeof record.sessionId !== "string") {
            throw new Error("Invalid chat run response: missing sessionId");
        }
        if (record.origin !== "user_submission" && record.origin !== "spawn") {
            throw new Error("Invalid chat run response: missing origin");
        }
        const rawApprovals = Array.isArray(record.pendingApprovals) ? record.pendingApprovals : [],
            pendingApprovals = rawApprovals
                .map((approval) => normalizeApprovalRequest(approval, record.sessionId as string))
                .map((approval) =>
                    approval ? { ...approval, runId: approval.runId || runId } : null,
                )
                .filter((approval): approval is ApprovalRequest => approval !== null);
        return {
            runId: typeof record.runId === "string" ? record.runId : runId,
            sessionId: record.sessionId,
            origin: record.origin,
            status: typeof record.status === "string" ? record.status : "unknown",
            terminalOutcome:
                typeof record.terminalOutcome === "string" || record.terminalOutcome === null
                    ? record.terminalOutcome
                    : undefined,
            errorCode:
                typeof record.errorCode === "string" || record.errorCode === null
                    ? record.errorCode
                    : undefined,
            leaseExpired: record.leaseExpired === true,
            pendingApprovals,
        };
    },
    /** Workspace checkpoint timeline; expired rows are removed by the normalizer. */
    async listWorkspaceCheckpoints(workspaceId: string): Promise<WorkspaceCheckpoint[]> {
        const payload = await request<unknown>(
            `/workspaces/${encodeURIComponent(workspaceId)}/checkpoints`,
            { headers: workspaceHeaders(workspaceId) },
        );
        if (!Array.isArray(payload)) throw new Error("Invalid workspace checkpoints response");
        return normalizeWorkspaceCheckpoints(payload);
    },
    /** Dry-run restore plan for one workspace slice. */
    async previewWorkspaceCheckpointRevert(
        workspaceId: string,
        sliceRef: string,
    ): Promise<CheckpointPreview> {
        const payload = await request<unknown>(
                `/workspaces/${encodeURIComponent(workspaceId)}/checkpoints/revert/preview`,
                {
                    method: "POST",
                    headers: workspaceHeaders(workspaceId),
                    body: JSON.stringify({ sliceRef }),
                },
            ),
            preview = normalizeCheckpointPreview(payload);
        if (!preview) throw new Error("Invalid checkpoint preview response");
        return preview;
    },
    /**
     * PLAN-0641 M3 T4.2: force overrides the dirty-nested-repo gate; every head-drifted repo must be
     * listed in acknowledgeNestedRepos (ruling (a)). Absent keys keep the pre-M3 wire shape so a
     * caller with nothing to acknowledge sends exactly the old body.
     */
    async executeWorkspaceCheckpointRevert(
        workspaceId: string,
        sliceRef: string,
        acknowledgeTypeChanges: string[] = [],
        acknowledgeNestedRepos: string[] = [],
        force = false,
    ): Promise<CheckpointResult> {
        const payload = await request<unknown>(
                `/workspaces/${encodeURIComponent(workspaceId)}/checkpoints/revert`,
                {
                    method: "POST",
                    headers: workspaceHeaders(workspaceId),
                    body: JSON.stringify(
                        revertExecuteBody(
                            sliceRef,
                            acknowledgeTypeChanges,
                            acknowledgeNestedRepos,
                            force,
                        ),
                    ),
                },
            ),
            result = normalizeCheckpointResult(payload);
        if (!result) throw new Error("Invalid checkpoint result response");
        return result;
    },
    /** One plain-text file (≤ 1MiB) of a workspace slice tree. */
    async getWorkspaceCheckpointBlob(
        workspaceId: string,
        sliceRef: string,
        path: string,
    ): Promise<string> {
        const params = new URLSearchParams({ sliceRef, path }),
            res = await apiRaw(
                `/workspaces/${encodeURIComponent(workspaceId)}/checkpoints/blob?${params.toString()}`,
                { headers: workspaceHeaders(workspaceId) },
            );
        return res.text();
    },
    /** User-repository git status (dual-diff "待提交" side; independent of the shadow diff). */
    async getWorkspaceGitStatus(workspaceId: string): Promise<WorkspaceGitStatus> {
        return normalizeWorkspaceGitStatus(
            await request<unknown>(`/workspaces/${encodeURIComponent(workspaceId)}/git-status`, {
                headers: workspaceHeaders(workspaceId),
            }),
        );
    },
    /** Informational retention view (fixed N=50 / TTL 30d constants + current counts). */
    async getWorkspaceCheckpointRetention(workspaceId: string): Promise<CheckpointRetention> {
        return normalizeCheckpointRetention(
            await request<unknown>(
                `/workspaces/${encodeURIComponent(workspaceId)}/checkpoints/retention`,
                { headers: workspaceHeaders(workspaceId) },
            ),
        );
    },
    /** Explicit workspace shadow cleanup; caller must have shown a second confirmation. */
    async cleanupWorkspaceCheckpoints(workspaceId: string): Promise<CheckpointCleanupResult> {
        const result = normalizeCheckpointCleanupResult(
            await request<unknown>(
                `/workspaces/${encodeURIComponent(workspaceId)}/checkpoints/cleanup`,
                {
                    method: "POST",
                    headers: workspaceHeaders(workspaceId),
                    body: JSON.stringify({ acknowledge: true }),
                },
            ),
        );
        if (!result) throw new Error("Invalid checkpoint cleanup response");
        return result;
    },
    /** PLAN-0498 T1.1: owner-scoped credential metadata (never ciphertext/suffixes). */
    async listCredentials(
        params: { ownerType?: CredentialOwnerType; ownerId?: string } = {},
    ): Promise<CredentialListResponse> {
        const query = new URLSearchParams();
        if (params.ownerType) query.set("ownerType", params.ownerType);
        if (params.ownerId) query.set("ownerId", params.ownerId);
        const suffix = query.toString() ? `?${query.toString()}` : "";
        return request<CredentialListResponse>(`/credentials${suffix}`);
    },
    /** PLAN-0498 T1.2: register a credential (encrypted at rest, plaintext is never echoed). */
    async createCredential(payload: CredentialCreateRequest): Promise<CredentialSummary> {
        return request<CredentialSummary>("/credentials", {
            method: "POST",
            body: JSON.stringify(payload),
        });
    },
    /** PLAN-0498 T1.3: replace the stored secret in place (revision +1, id preserved). */
    async replaceCredential(
        credentialId: string,
        payload: CredentialReplaceRequest,
    ): Promise<CredentialSummary> {
        return request<CredentialSummary>(
            `/credentials/${encodeURIComponent(credentialId)}/replace`,
            {
                method: "POST",
                body: JSON.stringify(payload),
            },
        );
    },
    /** PLAN-0498 T1.3: soft-delete; the report lists referring grants/caps for the warning. */
    async deleteCredential(credentialId: string): Promise<CredentialDeleteReport> {
        return request<CredentialDeleteReport>(`/credentials/${encodeURIComponent(credentialId)}`, {
            method: "DELETE",
        });
    },
    /** PLAN-0498 T3.2 (M1 delete confirmation): exact references for one credential. */
    async getCredentialReferences(credentialId: string): Promise<CredentialReferencesResponse> {
        return request<CredentialReferencesResponse>(
            `/credentials/${encodeURIComponent(credentialId)}/references`,
        );
    },
    /** PLAN-0498 T2.1: read-only pre-check of candidate role atoms against the caller's grants. */
    async precheckCredentialAtoms(
        permissions: Array<{ actionClass: string; resource?: string }>,
    ): Promise<{ uncovered: string[] }> {
        return request<{ uncovered: string[] }>("/credentials/precheck", {
            method: "POST",
            body: JSON.stringify({ permissions }),
        });
    },
    /** PLAN-0498 T2.2: bind the credential to Agent principals (all-or-nothing). */
    async bindCredential(
        credentialId: string,
        payload: CredentialBindPayload,
    ): Promise<CredentialBindResult> {
        return request<CredentialBindResult>(
            `/credentials/${encodeURIComponent(credentialId)}/bindings`,
            {
                method: "POST",
                body: JSON.stringify(payload),
            },
        );
    },
    /** PLAN-0498 T2.2: remove the credential_use atoms added by the binding. */
    async unbindCredential(
        credentialId: string,
        payload: CredentialBindPayload,
    ): Promise<CredentialBindResult> {
        return request<CredentialBindResult>(
            `/credentials/${encodeURIComponent(credentialId)}/bindings`,
            {
                method: "DELETE",
                body: JSON.stringify(payload),
            },
        );
    },
    /** PLAN-0498 T3.1: one-shot reveal (step-up password; 5 failures / 15 min → 429; no-store). */
    async revealCredential(
        credentialId: string,
        password: string,
    ): Promise<CredentialRevealResponse> {
        return request<CredentialRevealResponse>(
            `/credentials/${encodeURIComponent(credentialId)}/reveal`,
            {
                method: "POST",
                body: JSON.stringify({ password }),
            },
        );
    },
    /** PLAN-0498 T3.2: owner-visible audit trail (never a value; newest first). */
    async getCredentialEvents(
        credentialId: string,
        limit = 200,
    ): Promise<CredentialEventsResponse> {
        return request<CredentialEventsResponse>(
            `/credentials/${encodeURIComponent(credentialId)}/events?limit=${limit}`,
        );
    },
};
