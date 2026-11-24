/* task-1032：自 composables/api.ts 拆出的 workspace 段（逐字节搬运）。 */
import type {
    WorkspaceEvent,
    WorkspaceEnvironment,
    WorkspaceReleaseOperation,
    WorkspaceJob,
    WorkspaceJobStartRequest,
    WorkspaceExecutionMode,
    WorkspaceStorageMode,
    WorkspaceCapabilityPreflight,
    WorkspaceDirectAttachExecutionMode,
} from "../../types";
import { request, apiPost, workspaceHeaders } from "./_core";
import { asRecord, asNonNegativeInteger, normalizeWorkspaceResponse } from "./_normalize";
import type { ApiWorkspace } from "./_types";
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
export interface ApiWorkspaceMember {
    userId: string;
    username: string;
    email: string;
    name: string | null;
    role: "OWNER" | "EDITOR" | "VIEWER";
    createdAt: string;
}
export type MemberAssignableRole = "EDITOR" | "VIEWER";
export interface MxcInstallSnapshot {
    state: "managed" | "system" | "missing";
    source: string;
    installDir: string;
    pinnedVersion: string;
    downloadSizeBytes: number;
    sha256: string;
    archiveName: string;
    sourceUrl: string;
    sourceConfigured: boolean;
    installSupported: boolean;
    checksumState: string;
    managedVersion: string | null;
    overridePresent: boolean;
    overrideExecutable: string | null;
    availableVersions: string[];
    reason?: string;
    detail?: string;
    maturity?: string;
    isolationDisclaimer?: string;
}
export const workspaceEventKinds = [
    "workspace_status",
    "file_changed",
    "snapshot_required",
    "workspace_event_error",
    "scheduled_tasks_changed",
    "plugin_binding",
    "heartbeat",
] as const;
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

export const workspaceApi = {
    getStdioServers(wsId: string) {
        return request<{
            generation?: number;
            hash?: string;
            servers?: Record<string, unknown>;
        }>(`/workspaces/${encodeURIComponent(wsId)}/stdio-servers`);
    },
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
    cancelJob(workspaceId: string, jobId: string) {
        return apiPost<{ jobId: string; status: string; changed: boolean }>(
            `/workspaces/${encodeURIComponent(workspaceId)}/jobs/${encodeURIComponent(jobId)}/cancel`,
        );
    },
    getMcpConfig(wsId: string) {
        // task-984: `canonicalIds` maps the raw mcp-config key to the canonical `mcp:` grant id.
        return request<{
            mcpServers?: string | Record<string, unknown>;
            canonicalIds?: Record<string, string>;
        }>(`/workspaces/${encodeURIComponent(wsId)}/mcp-config`, {
            headers: workspaceHeaders(wsId),
        });
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
    async listImportSourceRoots(): Promise<Array<{ path: string; label: string; kind: string }>> {
        return request("/workspaces/import-source-roots");
    },
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
    async getMxcInstallSnapshot(): Promise<MxcInstallSnapshot> {
        return request<MxcInstallSnapshot>("/workspaces/mxc-install");
    },
    async installManagedMxc(): Promise<MxcInstallSnapshot> {
        return request<MxcInstallSnapshot>("/workspaces/mxc-install", { method: "POST" });
    },
    async setMxcOverride(executablePath: string): Promise<MxcInstallSnapshot> {
        return request<MxcInstallSnapshot>("/workspaces/mxc-install/override", {
            method: "PUT",
            body: JSON.stringify({ executablePath }),
        });
    },
    async clearMxcOverride(): Promise<MxcInstallSnapshot> {
        return request<MxcInstallSnapshot>("/workspaces/mxc-install/override", {
            method: "DELETE",
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
    async listWorkspaceNestedRepos(wsId: string): Promise<ApiNestedRepoItem[]> {
        const view = await request<ApiNestedReposView>(
            `/workspaces/${encodeURIComponent(wsId)}/nested-repos`,
            { method: "GET", headers: workspaceHeaders(wsId) },
        );
        return Array.isArray(view.items) ? view.items : [];
    },
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
    materializeWorkspace(wsId: string) {
        return request<{ status: string }>(`/workspaces/${encodeURIComponent(wsId)}/materialize`, {
            method: "POST",
            headers: workspaceHeaders(wsId),
        });
    },
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
};
