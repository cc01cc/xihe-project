/* task-1032：自 composables/api.ts 拆出的 misc 段（逐字节搬运）。 */
import type {
    AuditEntry,
    AuditEntryDetail,
    AuditEntryType,
    AuditListFilters,
    AuditListResponse,
    AuditTimelineEvent,
    AuditAttemptView,
    SafePolicySummaryView,
    ScheduledTask,
    ScheduledTaskCreateRequest,
    ScheduledTaskDisposeResult,
    ScheduledTaskListPage,
} from "../../types";
import { request, workspaceHeaders } from "./_core";
import {
    asRecord,
    isEnumValue,
    approvalPolicyEffects,
    approvalPolicySourceLayers,
    isNonEmptyString,
    approvalPolicyShapes,
    approvalPolicyModes,
} from "./_normalize";
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
export function normalizeAuditDetail(value: unknown): AuditEntryDetail {
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
export function normalizeAuditTimeline(timeline: unknown): AuditTimelineEvent[] {
    if (!Array.isArray(timeline)) {
        return [];
    }
    return timeline.filter((event): event is AuditTimelineEvent => {
        const record = asRecord(event);
        return record !== null && typeof record.eventType === "string";
    });
}
export function normalizeAuditAttempts(attempts: unknown): AuditAttemptView[] {
    if (!Array.isArray(attempts)) {
        return [];
    }
    return attempts.filter((attempt): attempt is AuditAttemptView => {
        const record = asRecord(attempt);
        return record !== null && typeof record.id === "string" && typeof record.stage === "string";
    });
}
export function normalizeAuditList(value: unknown): AuditListResponse {
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

export const miscApi = {
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
    async getAuditEntry(type: AuditEntryType, id: string): Promise<AuditEntryDetail> {
        return normalizeAuditDetail(
            await request<unknown>(
                `/audit/entries/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
            ),
        );
    },
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
    deleteScheduledTask(wsId: string, taskId: string): Promise<ScheduledTaskDisposeResult> {
        return request<ScheduledTaskDisposeResult>(
            `/workspaces/${encodeURIComponent(wsId)}/scheduled-tasks/${encodeURIComponent(taskId)}`,
            { method: "DELETE", headers: workspaceHeaders(wsId) },
        );
    },
    rerunScheduledTask(wsId: string, taskId: string): Promise<ScheduledTask> {
        return request<ScheduledTask>(
            `/workspaces/${encodeURIComponent(wsId)}/scheduled-tasks/${encodeURIComponent(taskId)}/rerun`,
            { method: "POST", headers: workspaceHeaders(wsId) },
        );
    },
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
};
