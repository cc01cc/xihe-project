/* task-1032：自 composables/api.ts 拆出的 session 段（逐字节搬运）。 */
import type { SessionDerivedStateResponse } from "../../types";
import { logger } from "../../lib/logger";
import { request, apiRaw, apiDelete } from "./_core";
import {
    asRecord,
    normalizeSession,
    InvalidSessionProjectionError,
    normalizeWorkspace,
} from "./_normalize";
import type { SessionResponse, ApiWorkspace } from "./_types";
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
export interface SessionCommandView {
    name: string;
    source: "builtin";
    available: boolean;
    reason: string | null;
}
export interface SessionCommandListResponse {
    commands: SessionCommandView[];
}
export interface SessionCompactResponse {
    sequence: number;
    eventType: string;
    createdAt: string;
}
export interface ApiTeamTask {
    taskId: string;
    teamRootSessionId: string;
    taskNo: number;
    revision: number;
    subject: string;
    description: string | null;
    status: string;
    ready: boolean;
    ownerSessionId: string | null;
    ownerName: string | null;
    blockedBy: string[];
    writeScopeWarnings: string[];
    createdBySessionId: string;
    createdAt: string;
    updatedAt: string;
}
export interface SessionBranchCreateResponse {
    branchId: string;
    parentBranchId: string;
    forkPointMessageId: string;
}
export interface SessionListResponse {
    sessions: SessionResponse[];
    workspace?: ApiWorkspace;
}
export function normalizeSessionListPayload(payload: unknown): SessionListResponse {
    const root = asRecord(payload),
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
            sessions.push(normalizeSession(raw, { requireDetailFields: false }));
        } catch (error) {
            const field = error instanceof InvalidSessionProjectionError ? error.field : "unknown";
            const rowId = asRecord(asRecord(raw)?.session)?.id ?? asRecord(raw)?.id ?? "<unknown>";
            logger.warn("[sessions] dropping malformed row", {
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
}

export const sessionApi = {
    async getSessions(workspaceId?: string): Promise<SessionListResponse> {
        return normalizeSessionListPayload(
            await request<unknown>(
                "/sessions",
                workspaceId ? { headers: { "X-Workspace-Id": workspaceId } } : undefined,
            ),
        );
    },
    async getWorkspacelessSessions(): Promise<SessionListResponse> {
        return normalizeSessionListPayload(
            await request<unknown>("/sessions?scope=workspaceless", {
                headers: { "X-Workspace-Id": "" },
            }),
        );
    },
    async getSession(id: string): Promise<SessionResponse> {
        return normalizeSession(await request<unknown>(`/sessions/${encodeURIComponent(id)}`));
    },
    getSessionDerivedState(sessionId: string): Promise<SessionDerivedStateResponse> {
        return request<SessionDerivedStateResponse>(
            `/sessions/${encodeURIComponent(sessionId)}/derived-state`,
        );
    },
    async getSessionTeamTasks(sessionId: string): Promise<ApiTeamTask[]> {
        const payload = await request<unknown>(
            "/sessions/" + encodeURIComponent(sessionId) + "/team-tasks",
        );
        const root = asRecord(payload);
        if (!root || !Array.isArray(root.tasks)) {
            throw new Error(
                "getSessionTeamTasks: unexpected payload (expected an object with a tasks array)",
            );
        }
        return root.tasks as ApiTeamTask[];
    },
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
    exportSession(sessionId: string, branchId: string): Promise<Response> {
        return apiRaw(
            `/sessions/${encodeURIComponent(sessionId)}/export?branchId=${encodeURIComponent(branchId)}`,
        );
    },
    compactSession(sessionId: string, branchId: string): Promise<SessionCompactResponse> {
        return request<SessionCompactResponse>(
            `/sessions/${encodeURIComponent(sessionId)}/compact`,
            { method: "POST", body: JSON.stringify({ branchId }) },
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
};
