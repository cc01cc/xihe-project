import type {
    ApprovalDecision,
    ApprovalDecisionKind,
    ApprovalPolicy,
    ApprovalPolicyEffect,
    ApprovalPolicyMode,
    ApprovalPolicyShape,
    ApprovalPolicySourceLayer,
    ApprovalRequest,
    CheckpointCleanupResult,
    CheckpointPreview,
    CheckpointPreviewAction,
    CheckpointPreviewCounts,
    CheckpointPreviewEntry,
    CheckpointPreviewEntryState,
    CheckpointRetention,
    CheckpointResult,
    CheckpointResultCounts,
    CheckpointResultEntry,
    OperationItemView,
    OperationListResponse,
    OperationPolicyView,
    OperationTrace,
    OperationStatus,
    PolicyDomainView,
    PolicyModeUpdateResponse,
    PolicyRuleLayer,
    PolicyRuleView,
    PolicyToolFaceQueryScope,
    PolicyToolFaceView,
    PendingApprovalSummary,
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
    WorkspaceJob,
    WorkspaceJobStartRequest,
    WorkspaceExecutionMode,
    WorkspaceStorageMode,
    WorkspaceCapabilityPreflight,
    WorkspaceDirectAttachExecutionMode,
} from "../types";

const API_BASE = "/api/v1";

export interface ProblemDetails {
    type?: string;
    title?: string;
    status: number;
    code: string;
    detail?: string;
    requestId: string;
    runId?: string;
    provider?: string;
    model?: string;
    retryable?: boolean;
    outcome?: string;
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
    executionMode?: WorkspaceExecutionMode;
    createdAt?: string;
    updatedAt?: string;
}

export interface ApiSession {
    id: string;
    title: string;
    workspaceId?: string;
    createdAt?: string;
    updatedAt?: string;
    modelProvider?: string;
    modelName?: string;
    providerConnectionId?: string;
    connectionRevision?: number;
}

export interface SessionResponse extends ApiSession {
    workspace?: ApiWorkspace;
}

export interface SessionListResponse {
    sessions: SessionResponse[];
    workspace?: ApiWorkspace;
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

const approvalPolicyEffects = ["allow", "ask", "deny"] as const;
const approvalPolicySourceLayers = [
    "builtin",
    "instance",
    "user",
    "workspace",
    "session",
    "per_call",
] as const;
const approvalPolicyModes = ["manual", "auto"] as const;
const approvalPolicyShapes = ["structured", "interpreter", "opaque"] as const;
const policyRuleLayers = ["instance", "user", "workspace"] as const;
const policyToolFaceScopes = ["builtin", "instance", "workspace"] as const;

function isEnumValue<T extends string>(value: unknown, values: readonly T[]): value is T {
    return typeof value === "string" && values.includes(value as T);
}

function asRecord(value: unknown): JsonRecord | null {
    return typeof value === "object" && value !== null ? (value as JsonRecord) : null;
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
    };
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

/**
 * Strict normalizer for the optional operation item `policy` projection (PLAN-0328 T1.15).
 * Returns `undefined` when the projection is absent or malformed so the view can show the
 * explicit no-verdict state; it never fabricates defaults (e.g. `mode: 'manual'`) and
 * ignores unknown keys. `reused` (T1.7) is optional and nullable: a legacy snapshot without
 * the key stays keyless, and a non-boolean value makes the whole projection unreadable.
 */
export function normalizeOperationPolicy(value: unknown): OperationPolicyView | undefined {
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

function normalizeOperationItem(value: unknown): OperationItemView | null {
    const record = asRecord(value);
    if (!record || !isNonEmptyString(record.id)) return null;
    const { policy: rawPolicy, ...rest } = record;
    const policy = normalizeOperationPolicy(rawPolicy);
    return (policy ? { ...rest, policy } : rest) as unknown as OperationItemView;
}

function normalizeOperationTrace(value: unknown): OperationTrace {
    const record = asRecord(value);
    if (!record || !Array.isArray(record.items)) return value as OperationTrace;
    return {
        ...record,
        items: record.items
            .map(normalizeOperationItem)
            .filter((item): item is OperationItemView => item !== null),
    } as unknown as OperationTrace;
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
    const requestId = typeof record.requestId === "string" ? record.requestId : "";
    const sessionId =
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
        operationId: typeof record.operationId === "string" ? record.operationId : undefined,
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

const workspaceCheckpointStates = ["captured", "abnormal-captured", "degraded", "expired"] as const;
const workspaceCheckpointRevertStates = ["none", "rolled_back", "partial", "failed"] as const;
const checkpointPreviewActions = ["restore", "delete"] as const;
const checkpointPreviewEntryStates = ["execute", "noop", "type_conflict"] as const;
const checkpointResultOutcomes = ["restored", "deleted", "failed", "suspect"] as const;

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
    const state: WorkspaceCheckpointRevertState = record.state;
    const countsRecord = asRecord(record.counts);
    const counts: WorkspaceCheckpointRevertCounts = {};
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
    const capturedAt = nullableString(record, "capturedAt");
    const sourceRunId = nullableString(record, "sourceRunId");
    const sourceSessionId = nullableString(record, "sourceSessionId");
    const predecessorRef = nullableString(record, "predecessorRef");
    const changedFiles = normalizeWorkspaceCheckpointChangedFiles(record.changedFiles);
    const changedCount = asNonNegativeInteger(record.changedCount) ?? changedFiles.length;
    const revert =
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
    const runId = isNonEmptyString(record.runId) ? record.runId : "";
    const sessionId = isNonEmptyString(record.sessionId) ? record.sessionId : fallbackSessionId;
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
    const restore = asNonNegativeInteger(record.restore);
    const deleted = asNonNegativeInteger(record.delete);
    const typeConflict = asNonNegativeInteger(record.typeConflict);
    if (restore === null || deleted === null || typeConflict === null) return null;
    return { restore, delete: deleted, typeConflict };
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
    return {
        sliceRef: record.sliceRef,
        counts,
        entries,
        truncated: record.truncated === true,
        opaqueNestedRepos,
    };
}

function normalizeCheckpointResultCounts(value: unknown): CheckpointResultCounts | null {
    const record = asRecord(value);
    if (!record) return null;
    const restored = asNonNegativeInteger(record.restored);
    const deleted = asNonNegativeInteger(record.deleted);
    const failed = asNonNegativeInteger(record.failed);
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
    const record = asRecord(value);
    const entries: WorkspaceGitStatus["entries"] = [];
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
    const record = asRecord(value);
    const maxRuns = record ? asNonNegativeInteger(record.maxRuns) : null;
    const ttlDays = record ? asNonNegativeInteger(record.ttlDays) : null;
    const currentRuns = record ? asNonNegativeInteger(record.currentRuns) : null;
    const currentRefs = record ? asNonNegativeInteger(record.currentRefs) : null;
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
    const record = asRecord(value);
    const count = record?.count;
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
    const state = normalizePolicyModeState(value, fallbackSessionId);
    const record = asRecord(value);
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
        executionMode: isEnumValue(
            record.executionMode,
            ["docker", "windows-mxc", "windows-host"] as const,
        )
            ? record.executionMode
            : undefined,
        createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
    };
}

export class ApiError extends Error {
    constructor(public readonly problem: ProblemDetails) {
        super(problem.detail || problem.code || `API error ${problem.status}`);
        this.name = "ApiError";
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
    return typeof code === "string" && (WORKSPACE_JOB_ERROR_CODES as readonly string[]).includes(code);
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
    return typeof code === "string"
        && (EXECUTION_MODE_SWITCH_PROBE_CODES as readonly string[]).includes(code);
}

function normalizeSession(value: unknown): SessionResponse {
    const root = asRecord(value);
    const record = asRecord(root?.session) ?? root;
    if (!record || typeof record.id !== "string") {
        throw new Error("Invalid session response: missing id");
    }
    const workspace = normalizeWorkspace(root?.workspace) ?? normalizeWorkspace(record.workspace);
    return {
        id: record.id,
        title:
            typeof record.title === "string" && record.title.length > 0 ? record.title : "Untitled",
        workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : workspace?.id,
        createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
        modelProvider: typeof record.modelProvider === "string" ? record.modelProvider : undefined,
        modelName: typeof record.modelName === "string" ? record.modelName : undefined,
        workspace,
    };
}

function normalizeWorkspaceResponse(value: unknown): ApiWorkspace {
    const root = asRecord(value);
    const workspace = normalizeWorkspace(root?.workspace) ?? normalizeWorkspace(root);
    if (!workspace) throw new Error("Invalid workspace response: missing id or name");
    return workspace;
}

const workspaceEventKinds = [
    "workspace_status",
    "file_changed",
    "snapshot_required",
    "workspace_event_error",
    "heartbeat",
] as const;

/** Normalize the Workspace SSE envelope without accepting host paths or stale foreign IDs. */
export function normalizeWorkspaceEvent(
    value: unknown,
    fallbackWorkspaceId: string,
    fallbackKind?: string,
): WorkspaceEvent | null {
    const record = asRecord(value);
    if (!record || typeof record.workspaceId !== "string" || record.workspaceId !== fallbackWorkspaceId) {
        return null;
    }
    const kind = typeof record.kind === "string" ? record.kind : fallbackKind;
    if (!kind || !workspaceEventKinds.includes(kind as (typeof workspaceEventKinds)[number])) {
        return null;
    }
    const sequence = asNonNegativeInteger(record.sequence);
    const source = typeof record.source === "string"
        ? record.source
        : kind === "heartbeat"
            ? "control-plane"
            : "";
    if (sequence === null || source.length === 0) return null;
    const path = typeof record.path === "string" ? record.path : undefined;
    if (
        path !== undefined &&
        (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes(":") || path.split("/").includes(".."))
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
    throw new ApiError({
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
    });
}

async function checkedFetch(path: string, options?: RequestInit): Promise<Response> {
    const hasBody = options?.body !== undefined && options.body !== null;
    const includeContentType = hasBody && !(options?.body instanceof FormData);
    const res = await fetch(endpoint(path), {
        ...options,
        headers: apiAuthHeaders(options?.headers, includeContentType),
    });
    const isAuthEndpoint = path === "/auth/login" || path === "/auth/register";
    if (res.status === 401 && !isAuthEndpoint) {
        localStorage.removeItem("xihe-token");
        localStorage.removeItem("xihe-user");
        if (!["/login", "/register"].includes(window.location.pathname))
            window.location.href = "/login";
        throw new ApiError({
            status: 401,
            code: "AUTHORIZATION_REQUIRED",
            detail: "Session expired",
            requestId: res.headers?.get("X-Request-Id") || "unknown",
        });
    }
    if (!res.ok) return apiErrorFromResponse(res);
    return res;
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
    });
    const text = await res.text();
    const jsonLine = text.startsWith("data:")
        ? text
              .split("\n")
              .find((line) => line.startsWith("data:"))!
              .slice(5)
              .trim()
        : text;
    const body = JSON.parse(jsonLine);
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

export const api = {
    login(email: string, password: string) {
        return request<{
            accessToken: string;
            user: { id: string; email: string; workspaceId?: string };
            workspaceId?: string;
            workspace?: ApiWorkspace;
        }>("/auth/login", {
            method: "POST",
            body: JSON.stringify({ email, password }),
        });
    },
    register(email: string, password: string, name: string) {
        return request<{
            accessToken: string;
            user: { id: string; email: string; workspaceId?: string };
            workspaceId?: string;
            workspace?: ApiWorkspace;
        }>("/auth/register", {
            method: "POST",
            body: JSON.stringify({ email, password, name }),
        });
    },
    async getSessions(): Promise<SessionListResponse> {
        const payload = await request<unknown>("/sessions");
        const root = asRecord(payload);
        const rawSessions = Array.isArray(root?.sessions)
            ? root.sessions
            : Array.isArray(payload)
              ? payload
              : null;
        if (!rawSessions) throw new Error("Invalid sessions response: missing sessions");
        return {
            sessions: rawSessions.map(normalizeSession),
            workspace: normalizeWorkspace(root?.workspace),
        };
    },
    async getSession(id: string): Promise<SessionResponse> {
        return normalizeSession(await request<unknown>(`/sessions/${encodeURIComponent(id)}`));
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
    async createSession(title?: string): Promise<SessionResponse> {
        const body = title === undefined ? {} : { title };
        return normalizeSession(
            await request<unknown>("/sessions", {
                method: "POST",
                body: JSON.stringify(body),
            }),
        );
    },
    async updateSession(
        id: string,
        patch: {
            title?: string;
            modelProvider?: string;
            modelName?: string;
            providerConnectionId?: string;
        },
    ): Promise<SessionResponse> {
        return normalizeSession(
            await request<unknown>(`/sessions/${encodeURIComponent(id)}`, {
                method: "PATCH",
                body: JSON.stringify(patch),
            }),
        );
    },
    deleteSession(id: string) {
        return apiDelete(`/sessions/${encodeURIComponent(id)}`);
    },
    getMessages(sessionId: string) {
        return request<
            Array<{
                id: string;
                sessionId: string;
                role: string;
                content: string;
                createdAt: string;
                runId?: string;
                runStatus?: string;
                terminalOutcome?: string;
                errorCode?: string;
                error?: string;
                retryable?: boolean;
                attachments?: Array<{ fileId: string; name: string; type: string; size: number }>;
                jobSummary?: Array<{
                    itemId: string;
                    toolCallId?: string;
                    toolName?: string;
                    jobId?: string;
                    status: string;
                    scope?: string;
                    startedAt?: string | null;
                    endedAt?: string | null;
                }>;
            }>
        >(`/sessions/${encodeURIComponent(sessionId)}/messages`);
    },
    getJobOutput(
        itemId: string,
        options?: { stream?: "stdout" | "stderr"; offset?: number; limit?: number },
    ): Promise<{
        jobId: string;
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
            `/operations/items/${encodeURIComponent(itemId)}/job-output${query ? `?${query}` : ""}`,
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
    /** PLAN-0366：取消单个 durable job（owner-only；幂等；不改 run/对话终态）。 */
    cancelJob(itemId: string) {
        return apiPost<{ itemId: string; jobId: string; status: string; changed: boolean }>(
            `/operations/items/${encodeURIComponent(itemId)}/cancel`,
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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const abortFromCaller = () => controller.abort();
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
    listOperations(
        filters: {
            sessionId?: string;
            workspaceId?: string;
            status?: OperationStatus | string;
            page?: number;
            size?: number;
        } = {},
    ): Promise<OperationListResponse> {
        const params = new URLSearchParams();
        if (filters.sessionId) params.set("sessionId", filters.sessionId);
        if (filters.workspaceId) params.set("workspaceId", filters.workspaceId);
        if (filters.status) params.set("status", filters.status);
        if (filters.page !== undefined) params.set("page", String(filters.page));
        if (filters.size !== undefined) params.set("size", String(filters.size));
        const query = params.toString();
        return request<OperationListResponse>(`/operations${query ? `?${query}` : ""}`);
    },
    async getOperationTrace(operationId: string): Promise<OperationTrace> {
        return normalizeOperationTrace(
            await request<unknown>(`/operations/${encodeURIComponent(operationId)}`),
        );
    },
    async listDirectory(path: string, workspaceId: string) {
        const raw = await callRuntimeTool<{
            entries?: Array<{
                name: string;
                path: string;
                is_dir?: boolean;
                type?: string;
                size?: number;
                modified?: string;
            }>;
        }>("list_directory", { path }, workspaceId);
        const entries = (raw?.entries ?? []).map((e) => ({
            name: e.name,
            path: e.path,
            type: e.type ?? (e.is_dir ? "directory" : "file"),
            size: e.size,
            modified: e.modified,
        }));
        return { entries };
    },
    async readFile(path: string, workspaceId: string) {
        const content = await callRuntimeTool<string>("read_file", { path }, workspaceId);
        return { content: typeof content === "string" ? content : String(content) };
    },
    // PLAN-292 T6: binary-safe read — the tool returns {content, total_lines,
    // is_binary} where content is base64 when is_binary is true.
    async readFileRange(path: string, workspaceId: string, offset?: number, limit?: number) {
        const args: Record<string, unknown> = { path };
        if (offset !== undefined) args.offset = offset;
        if (limit !== undefined) args.limit = limit;
        return callRuntimeTool<{ content: string; total_lines: number; is_binary: boolean }>(
            "read_file_range",
            args,
            workspaceId,
        );
    },
    async writeFile(path: string, content: string, workspaceId: string) {
        await callRuntimeTool<string>("write_file", { path, content }, workspaceId);
        return { success: true };
    },
    async deleteFile(path: string, workspaceId: string) {
        await callRuntimeTool<string>("delete_file", { path }, workspaceId);
        return { success: true };
    },
    async moveFile(from: string, to: string, workspaceId: string) {
        await callRuntimeTool<string>("move_file", { from, to }, workspaceId);
        return { success: true };
    },
    async copyFile(from: string, to: string, workspaceId: string) {
        await callRuntimeTool<string>("copy_file", { from, to }, workspaceId);
        return { success: true };
    },
    async createDirectory(path: string, workspaceId: string) {
        await callRuntimeTool<string>("mkdir", { path }, workspaceId);
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
    async startWorkspaceImport(workspaceId: string, input: {
        sourcePath: string;
        excludeRules?: string[];
        idempotencyKey: string;
    }): Promise<Record<string, unknown>> {
        return request(`/workspaces/${encodeURIComponent(workspaceId)}/imports`, {
            method: 'POST',
            headers: workspaceHeaders(workspaceId),
            body: JSON.stringify(input),
        });
    },
    async getWorkspaceImport(importId: string): Promise<Record<string, unknown>> {
        return request(`/workspace-imports/${encodeURIComponent(importId)}`);
    },
    /** PLAN-0384 V5: durable import records for a workspace, used to recover an in-flight import. */
    async listWorkspaceImports(workspaceId: string): Promise<Array<Record<string, unknown>>> {
        const result = await request<unknown>(`/workspaces/${encodeURIComponent(workspaceId)}/imports`, {
            headers: workspaceHeaders(workspaceId),
        });
        return Array.isArray(result) ? result as Array<Record<string, unknown>> : [];
    },
    async cancelWorkspaceImport(importId: string): Promise<Record<string, unknown>> {
        return request(`/workspace-imports/${encodeURIComponent(importId)}/cancel`, { method: 'POST' });
    },
    async createWorkspace(input: {
        name?: string;
        description?: string | null;
        profile?: "strict" | "coding" | "isolated";
        storageMode?: WorkspaceStorageMode;
        hostPath?: string;
        executionMode?: WorkspaceExecutionMode;
        idempotencyKey?: string;
    }): Promise<ApiWorkspace> {
        const body: Record<string, unknown> = {};
        if (input.name !== undefined) body.name = input.name;
        if (input.description !== undefined) body.description = input.description;
        if (input.profile !== undefined) body.profile = input.profile;
        if (input.storageMode !== undefined) body.storageMode = input.storageMode;
        if (input.hostPath !== undefined) body.hostPath = input.hostPath;
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
    getWorkspaceEnvironment(wsId: string) {
        return request<WorkspaceEnvironment>(`/workspaces/${encodeURIComponent(wsId)}/environment`, {
            headers: workspaceHeaders(wsId),
        });
    },
    getWorkspaceJobs(wsId: string) {
        return request<WorkspaceJob[]>(`/workspaces/${encodeURIComponent(wsId)}/jobs`, {
            headers: workspaceHeaders(wsId),
        });
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
        leaseExpired: boolean;
        pendingApprovals: ApprovalRequest[];
    }> {
        const payload = await request<unknown>(`/chat/runs/${encodeURIComponent(runId)}`, {
            method: "GET",
        });
        const record = asRecord(payload);
        if (!record || typeof record.sessionId !== "string") {
            throw new Error("Invalid chat run response: missing sessionId");
        }
        if (record.origin !== "user_submission" && record.origin !== "spawn") {
            throw new Error("Invalid chat run response: missing origin");
        }
        const rawApprovals = Array.isArray(record.pendingApprovals) ? record.pendingApprovals : [];
        const pendingApprovals = rawApprovals
            .map((approval) => normalizeApprovalRequest(approval, record.sessionId as string))
            .map((approval) => (approval ? { ...approval, runId: approval.runId || runId } : null))
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
        );
        const preview = normalizeCheckpointPreview(payload);
        if (!preview) throw new Error("Invalid checkpoint preview response");
        return preview;
    },
    /** Execute a workspace restore after explicit type-change confirmations. */
    async executeWorkspaceCheckpointRevert(
        workspaceId: string,
        sliceRef: string,
        acknowledgeTypeChanges: string[] = [],
    ): Promise<CheckpointResult> {
        const payload = await request<unknown>(
            `/workspaces/${encodeURIComponent(workspaceId)}/checkpoints/revert`,
            {
                method: "POST",
                headers: workspaceHeaders(workspaceId),
                body: JSON.stringify({ sliceRef, acknowledgeTypeChanges }),
            },
        );
        const result = normalizeCheckpointResult(payload);
        if (!result) throw new Error("Invalid checkpoint result response");
        return result;
    },
    /** One plain-text file (≤ 1MiB) of a workspace slice tree. */
    async getWorkspaceCheckpointBlob(
        workspaceId: string,
        sliceRef: string,
        path: string,
    ): Promise<string> {
        const params = new URLSearchParams({ sliceRef, path });
        const res = await apiRaw(
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
};
