/* task-1032：自 composables/api.ts 拆出的 agentSkill 段（逐字节搬运）。 */
import { logger } from "../../lib/logger";
import { request } from "./_core";
export function skillsScopeQuery(workspaceId: string | null | undefined): string {
    return workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
}
export interface AgentSkillBinding {
    bindingId: string;
    skillId: string;
    name: string;
    description?: string | null;
    /**
     * Definition home, independent of the binding scope: `workspace` = a workspace-private
     * definition, `instance` = the instance library. It is NEVER the V156 user/personal layer
     * (A2/D-1019) — this face refuses a user-scope definition with 404 SKILL_NOT_FOUND, so `user`
     * can never appear here. The old literal `personal` meant "instance library" and was renamed
     * to `instance` (2026-11-12, openapi x-breaking-note) because it collided with that new layer.
     */
    sourceType?: string | null;
    sourceName?: string | null;
    /** PLAN-0680: binding activation scope, server-derived from the workspace context. */
    scopeType: "instance" | "workspace";
    scopeId: string | null;
    scopeName: string | null;
    tokenEstimate?: number | null;
}
export interface AgentSkillSummary {
    skillId: string;
    name: string;
    definitionScope?: { type: string; workspaceId?: string | null } | null;
}
export interface SkillDefinitionSummary {
    skillId: string;
    name: string;
    definitionScope: { type: string; workspaceId?: string | null } | null;
    description: string;
    /** `codePointCount/2` 的估算值（服务端算，UI 只读；**不是**精确 token 数）。 */
    bodyTokensEst: number;
    /** `bodyTokensEst` 超过阈值：服务端只**标记**，从不拒绝/截断（D28-15）。 */
    oversize: boolean;
    trusted: boolean;
    sourcePath: string;
    contentHash: string;
    version: number;
    attachments: Array<{ path: string; sizeBytes: number; sha256: string; kind?: string }>;
    updatedAt: string | null;
}
export interface SkillDefinitionDetail extends SkillDefinitionSummary {
    body: string | null;
}
export interface SkillImportItemPayload {
    name: string;
    description: string;
    body: string;
    sourcePath: string;
    attachments?: Array<{ path: string; sizeBytes: number; sha256: string; kind?: string }>;
    /** D28-09 rule 1：**只有实例管理员**能置 true，否则整条被拒（`SKILL_TRUSTED_FORBIDDEN`）。 */
    trusted?: boolean;
}
export type SkillDefinitionScopePayload =
    | { type: "instance" }
    | { type: "workspace"; workspaceId: string }
    | { type: "user" };
export interface SkillImportRequestPayload {
    definitionScope: SkillDefinitionScopePayload;
    skills: SkillImportItemPayload[];
}
export interface SkillImportResultRow {
    skillId: string;
    name: string;
    action: "created" | "updated" | "unchanged";
    version: number;
    bodyTokensEst: number;
    oversize: boolean;
}
export interface SkillImportRejectionRow {
    sourcePath: string | null;
    code: string;
    detail?: string | null;
}
export interface SkillImportSummaryRow {
    created: number;
    updated: number;
    unchanged: number;
    rejected: number;
    oversize: number;
}
export interface SkillImportResultPayload {
    results: SkillImportResultRow[];
    rejected: SkillImportRejectionRow[];
    summary: SkillImportSummaryRow;
}
export function parseSkillSummaries(
    raw: { items?: Array<Record<string, unknown>> } | null | undefined,
): AgentSkillSummary[] {
    if (!Array.isArray(raw?.items)) return [];
    const seen = new Set<string>();
    return raw.items.flatMap((row) => {
        const skillId = typeof row.skillId === "string" ? row.skillId : "";
        const name = typeof row.name === "string" ? row.name : "";
        if (!skillId || !name) return [];
        const scope = row.definitionScope as { type?: unknown; workspaceId?: unknown } | undefined;
        const definitionScope =
            scope && typeof scope.type === "string"
                ? {
                      type: scope.type,
                      workspaceId: typeof scope.workspaceId === "string" ? scope.workspaceId : null,
                  }
                : null;
        const key = `${skillId}:${definitionScope?.type ?? ""}:${definitionScope?.workspaceId ?? ""}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ skillId, name, definitionScope }];
    });
}
export function parseSkillDefinition(row: Record<string, unknown>): SkillDefinitionSummary | null {
    const skillId = typeof row.skillId === "string" ? row.skillId : "";
    const name = typeof row.name === "string" ? row.name : "";
    if (!skillId || !name) return null;
    const scope = row.definitionScope as { type?: unknown; workspaceId?: unknown } | undefined;
    const definitionScope =
        scope && typeof scope.type === "string"
            ? {
                  type: scope.type,
                  workspaceId: typeof scope.workspaceId === "string" ? scope.workspaceId : null,
              }
            : null;
    const attachments = Array.isArray(row.attachments)
        ? (row.attachments as Array<Record<string, unknown>>).flatMap((a) =>
              typeof a.path === "string"
                  ? [
                        {
                            path: a.path,
                            sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : 0,
                            sha256: typeof a.sha256 === "string" ? a.sha256 : "",
                            kind: typeof a.kind === "string" ? a.kind : undefined,
                        },
                    ]
                  : [],
          )
        : [];
    return {
        skillId,
        name,
        definitionScope,
        description: typeof row.description === "string" ? row.description : "",
        bodyTokensEst: typeof row.bodyTokensEst === "number" ? row.bodyTokensEst : 0,
        oversize: row.oversize === true,
        trusted: row.trusted === true,
        sourcePath: typeof row.sourcePath === "string" ? row.sourcePath : "",
        contentHash: typeof row.contentHash === "string" ? row.contentHash : "",
        version: typeof row.version === "number" ? row.version : 0,
        attachments,
        updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    };
}
export function parseSkillDefinitions(
    raw: { items?: Array<Record<string, unknown>> } | null | undefined,
): SkillDefinitionSummary[] {
    if (!Array.isArray(raw?.items)) return [];
    return raw.items.flatMap((row) => {
        const parsed = parseSkillDefinition(row);
        return parsed ? [parsed] : [];
    });
}
export function parseSkillDefinitionDetail(
    raw: Record<string, unknown> | null | undefined,
): SkillDefinitionDetail | null {
    if (!raw) return null;
    const base = parseSkillDefinition(raw);
    if (!base) return null;
    return { ...base, body: typeof raw.body === "string" ? raw.body : null };
}
export function parseSkillImportResponse(
    raw: Record<string, unknown> | null | undefined,
): SkillImportResultPayload {
    const num = (value: unknown): number =>
        typeof value === "number" && Number.isFinite(value) ? value : 0;
    const summaryRaw = (raw?.summary ?? {}) as Record<string, unknown>;
    const results: SkillImportResultRow[] = Array.isArray(raw?.results)
        ? raw.results.flatMap((entry) => {
              const row = entry as Record<string, unknown>;
              if (typeof row?.skillId !== "string" || typeof row?.name !== "string") return [];
              const action =
                  row.action === "created" || row.action === "updated" ? row.action : "unchanged";
              return [
                  {
                      skillId: row.skillId,
                      name: row.name,
                      action,
                      version: num(row.version),
                      bodyTokensEst: num(row.bodyTokensEst),
                      oversize: row.oversize === true,
                  },
              ];
          })
        : [];
    const rejected: SkillImportRejectionRow[] = Array.isArray(raw?.rejected)
        ? raw.rejected.flatMap((entry) => {
              const row = entry as Record<string, unknown>;
              if (typeof row?.code !== "string") return [];
              return [
                  {
                      sourcePath: typeof row.sourcePath === "string" ? row.sourcePath : null,
                      code: row.code,
                      detail: typeof row.detail === "string" ? row.detail : null,
                  },
              ];
          })
        : [];
    return {
        results,
        rejected,
        summary: {
            created: num(summaryRaw.created),
            updated: num(summaryRaw.updated),
            unchanged: num(summaryRaw.unchanged),
            rejected: num(summaryRaw.rejected),
            oversize: num(summaryRaw.oversize),
        },
    };
}

export const agentSkillApi = {
    async getAgentSkills(
        workspaceId: string | null | undefined,
        principalId: string,
    ): Promise<AgentSkillBinding[]> {
        const raw = await request<{
            items?: Array<Record<string, unknown>>;
            bindings?: Array<Record<string, unknown>>;
        }>(
            `/agent-principals/${encodeURIComponent(principalId)}/skills${skillsScopeQuery(workspaceId)}`,
        );
        const rows = raw?.items ?? raw?.bindings;
        if (!Array.isArray(rows)) {
            logger.warn("[agents] skill envelope malformed; treated as empty");
            return [];
        }
        return rows.flatMap((row) => {
            const bindingId = typeof row.bindingId === "string" ? row.bindingId : "";
            const skillId = typeof row.skillId === "string" ? row.skillId : "";
            const name = typeof row.name === "string" ? row.name : "";
            // scopeType is required by the PLAN-0680 wire contract: a row without a valid
            // axis cannot be rendered as either tier, so drop it instead of guessing instance.
            const scopeType =
                row.scopeType === "instance" || row.scopeType === "workspace"
                    ? row.scopeType
                    : null;
            if (!bindingId || !skillId || !name || !scopeType) return [];
            return [
                {
                    bindingId,
                    skillId,
                    name,
                    description: typeof row.description === "string" ? row.description : null,
                    sourceType: typeof row.sourceType === "string" ? row.sourceType : null,
                    sourceName: typeof row.sourceName === "string" ? row.sourceName : null,
                    scopeType,
                    scopeId: typeof row.scopeId === "string" ? row.scopeId : null,
                    scopeName: typeof row.scopeName === "string" ? row.scopeName : null,
                    tokenEstimate:
                        typeof row.tokenEstimate === "number" && Number.isFinite(row.tokenEstimate)
                            ? row.tokenEstimate
                            : null,
                },
            ];
        });
    },
    async bindAgentSkill(
        workspaceId: string | null | undefined,
        principalId: string,
        skillId: string,
    ): Promise<void> {
        await request<void>(
            `/agent-principals/${encodeURIComponent(principalId)}/skills${skillsScopeQuery(workspaceId)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ skillId }),
            },
        );
    },
    async unbindAgentSkill(
        workspaceId: string | null | undefined,
        principalId: string,
        bindingId: string,
    ): Promise<void> {
        await request<void>(
            `/agent-principals/${encodeURIComponent(principalId)}/skills/${encodeURIComponent(bindingId)}${skillsScopeQuery(workspaceId)}`,
            { method: "DELETE" },
        );
    },
    async getSkills(): Promise<AgentSkillSummary[]> {
        const raw = await request<{ items?: Array<Record<string, unknown>> }>("/skills");
        return parseSkillSummaries(raw);
    },
    async getWorkspaceSkills(workspaceId: string): Promise<AgentSkillSummary[]> {
        const raw = await request<{ items?: Array<Record<string, unknown>> }>(
            `/skills?definitionScope=workspace&workspaceId=${encodeURIComponent(workspaceId)}`,
        );
        return parseSkillSummaries(raw);
    },
    async listSkillDefinitions(
        definitionScope: "instance" | "user" = "instance",
    ): Promise<SkillDefinitionSummary[]> {
        const query = definitionScope === "user" ? "?definitionScope=user" : "";
        const raw = await request<{ items?: Array<Record<string, unknown>> }>(`/skills${query}`);
        return parseSkillDefinitions(raw);
    },
    async listPersonalSkills(): Promise<SkillDefinitionSummary[]> {
        return this.listSkillDefinitions("user");
    },
    async getSkillDefinition(
        skillId: string,
        includeBody = false,
    ): Promise<SkillDefinitionDetail | null> {
        const suffix = includeBody ? "?includeBody=true" : "";
        const raw = await request<Record<string, unknown>>(
            `/skills/${encodeURIComponent(skillId)}${suffix}`,
        );
        const detail = parseSkillDefinitionDetail(raw);
        return detail;
    },
    async importSkillDefinitions(
        payload: SkillImportRequestPayload,
    ): Promise<SkillImportResultPayload> {
        const raw = await request<Record<string, unknown>>("/skills/import", {
            method: "POST",
            body: JSON.stringify(payload),
        });
        return parseSkillImportResponse(raw);
    },
};
