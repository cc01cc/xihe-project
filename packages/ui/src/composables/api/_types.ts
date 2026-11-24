/* task-1032：自 composables/api.ts 拆出的 _types 段（逐字节搬运）。 */
import type { WorkspaceExecutionMode, WorkspaceStorageMode } from "../../types";
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
export const WORKSPACE_WIRE_FIELDS = [
    "id",
    "name",
    "description",
    "ownerId",
    "storageBackend",
    "storageRef",
    "storageMode",
    "hostPath",
    "roots",
    "executionMode",
    "workspaceRole",
    "canWrite",
    "createdAt",
    "updatedAt",
] as const satisfies readonly (keyof ApiWorkspace)[];
export type UnlistedWorkspaceField = Exclude<
    keyof ApiWorkspace,
    (typeof WORKSPACE_WIRE_FIELDS)[number]
>;
export const _allWorkspaceFieldsListed: UnlistedWorkspaceField extends never ? true : never = true;
export type WorkspaceMappingSurface = { readonly [K in keyof ApiWorkspace]-?: unknown };
export interface ApiUserCapabilities {
    isInstanceAdmin: boolean;
    isInstanceSuper: boolean;
    workspaceAdminOf: string[];
}
export interface ApiSession {
    id: string;
    title: string;
    /** task-373 / `D-1228`：独立会话 = 显式 null（不是缺字段）。 */
    workspaceId?: string | null;
    /** PLAN-0689 D-54: response-only projection from the Session PRIMARY participant. UI never writes it. */
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
    /**
     * task-188 S3（MVP⑤）：steer 复用 V49 队列后的来源标注（cp-1 W0 对齐 ②）。
     * "agent_steer" = Lead 中途指挥插话（UI 渲染「来自 Lead」徽标）；缺省/human ⇒ 不渲染徽标。
     */
    sourceKind?: string | null;
    /** steer 来源会话（sourceKind === "agent_steer" 时非空）。 */
    fromSessionId?: string | null;
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
export interface SessionResponse extends ApiSession {
    /** Detail Session requires it; list SessionSummary does not (M2: both shapes share normalize). */
    archived?: boolean;
    workspace?: ApiWorkspace;
}
export interface AgentPrincipalHookAdvisor {
    kind: string;
    /** 该 advisor 订阅的动作类（CP 精确等值匹配；白名单今天只有 `approval.ask`）。 */
    on: string[];
}
export interface AgentPrincipalHooks {
    advisors: AgentPrincipalHookAdvisor[];
}
export interface AgentModelRef {
    provider: string;
    model: string;
}
export type WorkspaceAgentMemoryType = "profile" | "fact";
