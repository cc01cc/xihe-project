/* task-1032：自 composables/api.ts 拆出的 agentSessions 段（逐字节搬运）。 */
import { request } from "./_core";
import { asRecord, isEnumValue } from "./_normalize";
export interface DelegateSpawnSession {
    id: string;
    parentSessionId: string | null;
    /** 1 = 直接从普通会话委派；2 = 从第 1 层子会话再委派（整锥深度）。 */
    depth: number;
    direct: boolean;
    /** 调用者能否读这个会话（owner 或受邀 HUMAN）；false ⇒ title 必为 null。 */
    readable: boolean;
    title: string | null;
    archived: boolean;
    /** 最新非终态 Run 的状态；null = 当前没有在跑的 run。 */
    runStatus: string | null;
    active: boolean;
    spawnedAt: string | null;
}
export interface DelegateSpawnSessions {
    workspaceId: string;
    principalId: string;
    depth: "all" | "direct";
    includeArchived: boolean;
    /** 同一 cohort、同一次遍历算出的两个口径；**永远以它为准**渲染数字。 */
    counts: { all: number; direct: number };
    sessions: DelegateSpawnSession[];
    /** true = 行被 limit 截断（counts 仍是全量）。 */
    truncated: boolean;
    limit: number;
}
export type AgentPrincipalSessionRole = "PRIMARY" | "MEMBER" | "GUARD";
export type AgentPrincipalSessionKind = "spawn" | "fork" | null;
export interface AgentPrincipalSessionRow {
    id: string;
    title: string | null;
    /** 调用者能否读这个会话（owner 或启用的 HUMAN 参与者）；不可读的行仍计入 `counts`。 */
    readable: boolean;
    archived: boolean;
    /** 主体在该会话里的角色（`session_participants.role`）。 */
    role: AgentPrincipalSessionRole;
    kind: AgentPrincipalSessionKind;
    spawnedFromSessionId: string | null;
    spawnedAt: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface AgentPrincipalSessionsCounts {
    all: number;
    primary: number;
    member: number;
    guard: number;
}
export interface AgentPrincipalSessionsResponse {
    workspaceId: string;
    principalId: string;
    includeArchived: boolean;
    counts: AgentPrincipalSessionsCounts;
    sessions: AgentPrincipalSessionRow[];
    /** true = 行被 `limit` 截断；`counts` 仍是全量。 */
    truncated: boolean;
    limit: number;
}

export const agentSessionsApi = {
    async listWorkspaceAgentSpawnSessions(
        workspaceId: string,
        principalId: string,
        options: { depth?: "all" | "direct"; includeArchived?: boolean } = {},
    ): Promise<DelegateSpawnSessions> {
        const query = new URLSearchParams();
        if (options.depth) query.set("depth", options.depth);
        if (options.includeArchived === true) query.set("includeArchived", "true");
        const suffix = query.toString();
        const raw = await request<unknown>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}/spawn-sessions${suffix ? `?${suffix}` : ""}`,
        );
        const record = asRecord(raw);
        const counts = asRecord(record?.counts);
        const countOf = (value: unknown): number | null =>
            typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
        const all = countOf(counts?.all);
        const direct = countOf(counts?.direct);
        const rawSessions = record?.sessions;
        if (
            !record ||
            typeof record.workspaceId !== "string" ||
            typeof record.principalId !== "string" ||
            !isEnumValue(record.depth, ["all", "direct"] as const) ||
            typeof record.includeArchived !== "boolean" ||
            all === null ||
            direct === null ||
            !Array.isArray(rawSessions) ||
            typeof record.truncated !== "boolean" ||
            typeof record.limit !== "number"
        ) {
            throw new Error("spawn-sessions response is malformed (DelegateSpawnSessionsResponse)");
        }
        const optionalString = (value: unknown): string | null =>
            typeof value === "string" ? value : null;
        const sessions: DelegateSpawnSession[] = rawSessions.map((item) => {
            const row = asRecord(item);
            if (
                !row ||
                typeof row.id !== "string" ||
                typeof row.depth !== "number" ||
                typeof row.direct !== "boolean" ||
                typeof row.readable !== "boolean" ||
                typeof row.archived !== "boolean" ||
                typeof row.active !== "boolean"
            ) {
                throw new Error("spawn-sessions row is malformed (DelegateSpawnSession)");
            }
            return {
                id: row.id,
                parentSessionId: optionalString(row.parentSessionId),
                depth: row.depth,
                direct: row.direct,
                readable: row.readable,
                title: optionalString(row.title),
                archived: row.archived,
                runStatus: optionalString(row.runStatus),
                active: row.active,
                spawnedAt: optionalString(row.spawnedAt),
            };
        });
        return {
            workspaceId: record.workspaceId,
            principalId: record.principalId,
            depth: record.depth,
            includeArchived: record.includeArchived,
            counts: { all, direct },
            sessions,
            truncated: record.truncated,
            limit: record.limit,
        };
    },
    async listAgentPrincipalSessions(
        principalId: string,
        workspaceId: string,
        options: { includeArchived?: boolean; limit?: number } = {},
    ): Promise<AgentPrincipalSessionsResponse> {
        const query = new URLSearchParams({ workspaceId });
        if (options.includeArchived === true) query.set("includeArchived", "true");
        if (options.limit !== undefined) query.set("limit", String(options.limit));
        const raw = await request<unknown>(
            `/agent-principals/${encodeURIComponent(principalId)}/sessions?${query.toString()}`,
        );
        const record = asRecord(raw);
        const counts = asRecord(record?.counts);
        const countOf = (value: unknown): number | null =>
            typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
        const all = countOf(counts?.all);
        const primary = countOf(counts?.primary);
        const member = countOf(counts?.member);
        const guard = countOf(counts?.guard);
        const rawSessions = record?.sessions;
        if (
            !record ||
            typeof record.workspaceId !== "string" ||
            typeof record.principalId !== "string" ||
            typeof record.includeArchived !== "boolean" ||
            all === null ||
            primary === null ||
            member === null ||
            guard === null ||
            !Array.isArray(rawSessions) ||
            typeof record.truncated !== "boolean" ||
            typeof record.limit !== "number"
        ) {
            throw new Error(
                "agent-principal sessions response is malformed (PrincipalSessionListResponse)",
            );
        }
        const roleOf = (value: unknown): AgentPrincipalSessionRole | null =>
            isEnumValue(value, ["PRIMARY", "MEMBER", "GUARD"] as const) ? value : null;
        const kindOf = (value: unknown): AgentPrincipalSessionKind | undefined =>
            value === null
                ? null
                : isEnumValue(value, ["spawn", "fork"] as const)
                  ? value
                  : undefined;
        const sessions: AgentPrincipalSessionRow[] = rawSessions.map((item) => {
            const row = asRecord(item);
            const role = roleOf(row?.role);
            const kind = kindOf(row?.kind);
            if (
                !row ||
                typeof row.id !== "string" ||
                !(row.title === null || typeof row.title === "string") ||
                typeof row.readable !== "boolean" ||
                typeof row.archived !== "boolean" ||
                role === null ||
                kind === undefined ||
                !(
                    row.spawnedFromSessionId === null ||
                    typeof row.spawnedFromSessionId === "string"
                ) ||
                !(row.spawnedAt === null || typeof row.spawnedAt === "string") ||
                typeof row.createdAt !== "string" ||
                typeof row.updatedAt !== "string"
            ) {
                throw new Error("agent-principal sessions row is malformed (PrincipalSessionRow)");
            }
            return {
                id: row.id,
                title: row.title,
                readable: row.readable,
                archived: row.archived,
                role,
                kind,
                spawnedFromSessionId: row.spawnedFromSessionId,
                spawnedAt: row.spawnedAt,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            };
        });
        return {
            workspaceId: record.workspaceId,
            principalId: record.principalId,
            includeArchived: record.includeArchived,
            counts: { all, primary, member, guard },
            sessions,
            truncated: record.truncated,
            limit: record.limit,
        };
    },
};
