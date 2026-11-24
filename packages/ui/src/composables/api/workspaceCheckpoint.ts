/* task-1032：自 composables/api.ts 拆出的 workspaceCheckpoint 段（逐字节搬运）。 */
import type {
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
    WorkspaceGitStatus,
    WorkspaceCheckpoint,
    WorkspaceCheckpointChangedFile,
    WorkspaceCheckpointEvent,
    WorkspaceCheckpointRevertCounts,
    WorkspaceCheckpointRevertState,
    WorkspaceCheckpointRevertView,
} from "../../types";
import { request, workspaceHeaders, apiRaw } from "./_core";
import { isNonEmptyString, asRecord, isEnumValue, asNonNegativeInteger } from "./_normalize";
import type { JsonRecord } from "./_normalize";
export const workspaceCheckpointStates = [
        "captured",
        "abnormal-captured",
        "degraded",
        "expired",
    ] as const,
    workspaceCheckpointRevertStates = ["none", "rolled_back", "partial", "failed"] as const,
    checkpointPreviewActions = ["restore", "delete"] as const,
    checkpointPreviewEntryStates = ["execute", "noop", "type_conflict"] as const,
    checkpointResultOutcomes = ["restored", "deleted", "failed", "suspect"] as const;
export function asNullableNonEmptyString(value: unknown): string | null {
    return isNonEmptyString(value) ? value : null;
}
export function normalizeWorkspaceCheckpointRevertView(
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
export function normalizeWorkspaceCheckpointChangedFiles(
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
export function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => isNonEmptyString(item));
}
export function nullableString(record: JsonRecord, key: string): string | null {
    return record[key] === null || record[key] === undefined
        ? null
        : asNullableNonEmptyString(record[key]);
}
export function normalizeWorkspaceCheckpoint(value: unknown): WorkspaceCheckpoint | null {
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
export function normalizeCheckpointPreviewCounts(value: unknown): CheckpointPreviewCounts | null {
    const record = asRecord(value);
    if (!record) return null;
    const restore = asNonNegativeInteger(record.restore),
        deleted = asNonNegativeInteger(record.delete),
        typeConflict = asNonNegativeInteger(record.typeConflict);
    if (restore === null || deleted === null || typeConflict === null) return null;
    return { restore, delete: deleted, typeConflict };
}
export function normalizeCheckpointNestedRepoAffected(
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
export function normalizeCheckpointPreviewEntry(value: unknown): CheckpointPreviewEntry | null {
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
export function normalizeCheckpointResultCounts(value: unknown): CheckpointResultCounts | null {
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
export function normalizeCheckpointResultEntry(value: unknown): CheckpointResultEntry | null {
    const record = asRecord(value);
    if (!record || !isNonEmptyString(record.path)) return null;
    if (!isEnumValue(record.outcome, checkpointResultOutcomes)) return null;
    return {
        path: record.path,
        outcome: record.outcome,
        ...(isNonEmptyString(record.reason) ? { reason: record.reason } : {}),
    };
}
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
export function revertExecuteBody(
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

export const workspaceCheckpointApi = {
    async listWorkspaceCheckpoints(workspaceId: string): Promise<WorkspaceCheckpoint[]> {
        const payload = await request<unknown>(
            `/workspaces/${encodeURIComponent(workspaceId)}/checkpoints`,
            { headers: workspaceHeaders(workspaceId) },
        );
        if (!Array.isArray(payload)) throw new Error("Invalid workspace checkpoints response");
        return normalizeWorkspaceCheckpoints(payload);
    },
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
    async getWorkspaceGitStatus(workspaceId: string): Promise<WorkspaceGitStatus> {
        return normalizeWorkspaceGitStatus(
            await request<unknown>(`/workspaces/${encodeURIComponent(workspaceId)}/git-status`, {
                headers: workspaceHeaders(workspaceId),
            }),
        );
    },
    async getWorkspaceCheckpointRetention(workspaceId: string): Promise<CheckpointRetention> {
        return normalizeCheckpointRetention(
            await request<unknown>(
                `/workspaces/${encodeURIComponent(workspaceId)}/checkpoints/retention`,
                { headers: workspaceHeaders(workspaceId) },
            ),
        );
    },
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
