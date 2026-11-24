/* task-1032：自 composables/api.ts 拆出的 _normalize 段（逐字节搬运）。 */
import type {
    ApprovalGuardAdvisor,
    ApprovalHooksSection,
    ApprovalPolicy,
    ApprovalPolicyEffect,
    ApprovalPolicyMode,
    ApprovalPolicyShape,
    ApprovalPolicySourceLayer,
    ApprovalRequest,
} from "../../types";
import { logger } from "../../lib/logger";
import type {
    AgentPrincipalHooks,
    AgentPrincipalHookAdvisor,
    ApiWorkspaceRoot,
    ApiWorkspace,
    WorkspaceMappingSurface,
    SessionResponse,
} from "./_types";
export function catalogLocale(): string {
    const lang = typeof document === "undefined" ? "" : document.documentElement.lang;
    return (lang ?? "").toLowerCase().startsWith("en") ? "en-US" : "zh-CN";
}
export type JsonRecord = Record<string, unknown>;
export const approvalPolicyEffects = ["allow", "ask", "deny"] as const,
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
export function isEnumValue<T extends string>(value: unknown, values: readonly T[]): value is T {
    return typeof value === "string" && values.includes(value as T);
}
export function asRecord(value: unknown): JsonRecord | null {
    return typeof value === "object" && value !== null ? (value as JsonRecord) : null;
}
export function normalizePrincipalHooks(value: unknown): AgentPrincipalHooks | null {
    if (value === null || value === undefined) return null;
    // Gap I 的旧 CP 投影把 hooks 降级成 `[]`：语义就是“无订阅”，不告警也不渲染。
    if (Array.isArray(value) && value.length === 0) return null;
    const record = asRecord(value);
    if (!record || Array.isArray(record) || !Array.isArray(record.advisors)) {
        logger.warn("[agents] principal hooks malformed; treated as no subscriptions");
        return null;
    }
    const advisors: AgentPrincipalHookAdvisor[] = [];
    for (const entry of record.advisors) {
        const advisor = asRecord(entry);
        if (!advisor || typeof advisor.kind !== "string" || advisor.kind === "") {
            logger.warn("[agents] principal hooks advisor malformed; treated as no subscriptions");
            return null;
        }
        const on = advisor.on;
        if (
            on !== undefined &&
            (!Array.isArray(on) || on.some((item) => typeof item !== "string"))
        ) {
            logger.warn(
                "[agents] principal hooks advisor 'on' malformed; treated as no subscriptions",
            );
            return null;
        }
        advisors.push({ kind: advisor.kind, on: on === undefined ? [] : [...(on as string[])] });
    }
    return { advisors };
}
export function normalizeApprovalHooks(value: unknown): ApprovalHooksSection | undefined {
    const record = asRecord(value);
    if (!record) return undefined;
    if (record.version !== 1) {
        // 未知版本 = 契约前进了而 UI 没跟上：显式告警，不渲染猜测的形状。
        logger.warn(`[approval] unknown policySummary hooks version: ${String(record.version)}`);
        return undefined;
    }
    if (!Array.isArray(record.advisors)) {
        logger.warn("[approval] policySummary hooks section malformed: advisors missing");
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
            logger.warn("[approval] policySummary hooks advisor malformed; dropping the section");
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
export function normalizeApprovalPolicy(value: unknown): ApprovalPolicy | undefined {
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
export function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}
export function nullableCount(value: unknown): number | null {
    return typeof value === "number" &&
        Number.isInteger(value) &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? value
        : null;
}
export const approvalStates = [
    "pending",
    "dispatching",
    "approved",
    "rejected",
    "expired",
    "dispatch_unknown",
] as const;
export const approvalRequestOrigins = ["cp_gate", "agent_relay"] as const;
export function hasField(record: JsonRecord, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}
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
export function asNonNegativeInteger(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
export function normalizeWorkspaceRoots(value: unknown): ApiWorkspaceRoot[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.flatMap((entry, index) => {
        const record = asRecord(entry);
        if (!record || typeof record.id !== "string") return [];
        return [
            {
                id: record.id,
                alias: typeof record.alias === "string" ? record.alias : null,
                position: typeof record.position === "number" ? record.position : index,
                ...(typeof record.path === "string"
                    ? { path: record.path }
                    : record.path === null
                      ? { path: null }
                      : {}),
            },
        ];
    });
}
export function normalizeWorkspace(value: unknown): ApiWorkspace | undefined {
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
        // task-44：roots 必须同批映射（否则多根在 UI 上恒不可见）。
        roots: normalizeWorkspaceRoots(record.roots),
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
    } satisfies WorkspaceMappingSurface;
}
export class InvalidSessionProjectionError extends Error {
    readonly field: string;

    constructor(field: string, detail: string) {
        super(`Invalid session projection: missing/invalid required field '${field}' (${detail})`);
        this.name = "InvalidSessionProjectionError";
        this.field = field;
    }
}
export function requireSessionField(
    record: Record<string, unknown>,
    field: string,
    kind: "string",
): string;
export function requireSessionField(
    record: Record<string, unknown>,
    field: string,
    kind: "boolean",
): boolean;
export function requireSessionField(
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
export function normalizeSession(
    value: unknown,
    options: { requireDetailFields?: boolean } = {},
): SessionResponse {
    const root = asRecord(value),
        record = asRecord(root?.session) ?? root;
    if (!record) {
        throw new InvalidSessionProjectionError("id", "expected object with id");
    }
    const detailContract = options.requireDetailFields !== false;
    const id = requireSessionField(record, "id", "string"),
        archived = typeof record.archived === "boolean" ? record.archived : undefined;
    if (detailContract && archived === undefined) {
        throw new InvalidSessionProjectionError("archived", "expected boolean");
    }
    const workspace = normalizeWorkspace(root?.workspace) ?? normalizeWorkspace(record.workspace);
    // task-373 / `D-1228`：独立会话的 `workspaceId` 是**显式 null**（CP 视图里键在、值为 null）。
    // 缺键或类型不对仍然 fail-closed —— 「没有工作区」与「投影坏了」是两件事，不能互相冒充。
    // 此前这里硬要求非空字符串 ⇒ 独立会话在**所有**读面上都被判坏行（列表丢弃、详情抛错），
    // 于是「无工作区会话能在界面上被找到」在投影层就不可能成立。
    const workspaceless = "workspaceId" in record && record.workspaceId === null;
    const workspaceId =
        typeof record.workspaceId === "string" && record.workspaceId.length > 0
            ? record.workspaceId
            : workspace?.id;
    if (!workspaceId && !workspaceless) {
        throw new InvalidSessionProjectionError(
            "workspaceId",
            "expected string or explicit null (no workspace fallback either)",
        );
    }
    return {
        id,
        ...(archived === undefined ? {} : { archived }),
        title:
            typeof record.title === "string" && record.title.length > 0 ? record.title : "Untitled",
        workspaceId: workspaceId ?? null,
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
export function normalizeWorkspaceResponse(value: unknown): ApiWorkspace {
    const root = asRecord(value),
        workspace = normalizeWorkspace(root?.workspace) ?? normalizeWorkspace(root);
    if (!workspace) throw new Error("Invalid workspace response: missing id or name");
    return workspace;
}
