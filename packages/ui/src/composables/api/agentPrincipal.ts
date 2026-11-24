/* task-1032：自 composables/api.ts 拆出的 agentPrincipal 段（逐字节搬运）。 */
import { logger } from "../../lib/logger";
import { request } from "./_core";
import { asRecord } from "./_normalize";
import type { AgentModelRef } from "./_types";
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
export interface AgentPrincipalOption {
    principalId: string;
    name: string;
}
export interface WorkspaceAgentMemoryInput {
    content: string;
    pinned: boolean;
}
export type WorkspaceAgentMemoryStatus = "active" | "retired" | "all";
export interface AgentPrincipalCreateInput {
    name: string;
    templateId?: string;
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
    defaultModelProvider?: string | null;
    defaultModelName?: string | null;
    allowedModels?: AgentModelRef[] | null;
}
export interface AgentPrincipalSummary {
    principalId: string;
    name: string;
    templateId: string | null;
    templateName: string | null;
    createdAt: string;
    disabled: boolean;
    defaultModelProvider?: string | null;
    defaultModelName?: string | null;
    /**
     * task-191：契约 `AgentPrincipalView` 本就携带（列表投影 required），旧解析器损耗丢弃。
     * `null` = 不限制可用模型集。
     */
    allowedModels?: AgentModelRef[] | null;
    /** 同上：V96 hook 订阅文档；`null` = 无订阅。 */
    hooks?: Record<string, unknown> | null;
    /** 同上：D29-21 记忆策略文档；`null` = 无策略（记忆关）。 */
    contextPolicy?: Record<string, unknown> | null;
    /** 同上：V100 委派预算 {maxCount,maxDepth}；`null` = 代码默认（8/3）。 */
    delegationPolicy?: Record<string, unknown> | null;
    /** 同上：V170 归属门（本面恒 USER，实例档行不从此面到达）。 */
    ownership?: "USER" | "INSTANCE";
}
export function parseAgentPrincipalSummaryRow(
    row: Record<string, unknown>,
): AgentPrincipalSummary | null {
    const principalId = typeof row.principalId === "string" ? row.principalId : "";
    const name = typeof row.name === "string" ? row.name : "";
    if (!principalId || !name) return null;
    return {
        principalId,
        name,
        templateId: typeof row.templateId === "string" ? row.templateId : null,
        templateName: typeof row.templateName === "string" ? row.templateName : null,
        createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
        disabled: typeof row.disabledAt === "string" && row.disabledAt.length > 0,
        defaultModelProvider:
            typeof row.defaultModelProvider === "string" ? row.defaultModelProvider : null,
        defaultModelName: typeof row.defaultModelName === "string" ? row.defaultModelName : null,
        // task-191：列表视图本就携带的文档字段（fail-closed 解析：非对象/畸形一律 null，
        // 与 getWorkspaceAgents 的 hooks 口径一致，不让单行畸形污染整列）。
        allowedModels: parseAgentModelRefs(row.allowedModels),
        hooks: isPlainRecord(row.hooks) ? row.hooks : null,
        contextPolicy: isPlainRecord(row.contextPolicy) ? row.contextPolicy : null,
        delegationPolicy: isPlainRecord(row.delegationPolicy) ? row.delegationPolicy : null,
        ownership: row.ownership === "INSTANCE" ? "INSTANCE" : "USER",
    };
}
export interface AgentPrincipalUpdateBody {
    hooks?: Record<string, unknown> | null;
    contextPolicy?: Record<string, unknown> | null;
    delegationPolicy?: Record<string, unknown> | null;
    defaultModelProvider?: string | null;
    defaultModelName?: string | null;
    allowedModels?: AgentModelRef[] | null;
    /** task-974 / R35: the persona; absent keeps it, null clears it. */
    systemPrompt?: string | null;
}
export interface AgentPrincipalUpdateView {
    principalId: string;
    defaultModelProvider: string | null;
    defaultModelName: string | null;
    allowedModels: AgentModelRef[] | null;
    hooks: Record<string, unknown> | null;
    contextPolicy: Record<string, unknown> | null;
    delegationPolicy: Record<string, unknown> | null;
    systemPrompt: string | null;
}
export function parseAgentModelRefs(raw: unknown): AgentModelRef[] | null {
    if (!Array.isArray(raw)) return null;
    const refs: AgentModelRef[] = [];
    for (const entry of raw) {
        if (!isPlainRecord(entry)) return null;
        const provider = entry.provider;
        const model = entry.model;
        if (typeof provider !== "string" || typeof model !== "string") return null;
        refs.push({ provider, model });
    }
    return refs;
}
export function isPlainRecord(raw: unknown): raw is Record<string, unknown> {
    return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
export interface AgentTemplateSummary {
    id: string;
    name: string;
    description?: string;
    systemPrompt: string;
    toolMode: "none" | "workspace";
    provider?: string;
    model?: string;
    /** task-901：CP 模板下发只写 `presetId`（`roleId` 是已退役键），UI 不得再读旧键。 */
    presetId?: string;
}
export interface AgentTemplateLayerResponse {
    layer: "instance" | "user" | "workspace";
    workspaceId: string | null;
    templates: AgentTemplateSummary[];
}
export function normalizeWorkspaceAgentMemory(value: unknown): WorkspaceAgentMemory | null {
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
        logger.warn("[agents] memory row malformed; skipped");
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

export const agentPrincipalApi = {
    async listAgentPrincipals(): Promise<AgentPrincipalOption[]> {
        const raw = await request<{ principals?: Array<Record<string, unknown>> }>(
            "/agent-principals",
        );
        if (!Array.isArray(raw.principals)) {
            logger.warn("[bindings] agent principal envelope malformed; treated as empty");
            return [];
        }
        return raw.principals.flatMap((row) => {
            const principalId = typeof row.principalId === "string" ? row.principalId : "";
            const name = typeof row.name === "string" ? row.name : "";
            if (!principalId || !name) return [];
            return [{ principalId, name }];
        });
    },
    async listMyAgentPrincipals(): Promise<AgentPrincipalSummary[]> {
        const raw = await request<{ principals?: Array<Record<string, unknown>> }>(
            "/agent-principals",
        );
        if (!Array.isArray(raw.principals)) {
            logger.warn("[agent-principals] agent principal envelope malformed; treated as empty");
            return [];
        }
        // task-195：行解析与单条读面共用 parseAgentPrincipalSummaryRow —— 两处各写一份，
        // 迟早会有一边漏字段而没人发现。
        return raw.principals.flatMap((row) => {
            const parsed = parseAgentPrincipalSummaryRow(row);
            return parsed ? [parsed] : [];
        });
    },
    async getAgentPrincipal(principalId: string): Promise<AgentPrincipalSummary> {
        const row = await request<Record<string, unknown>>(
            `/agent-principals/${encodeURIComponent(principalId)}`,
        );
        const parsed = parseAgentPrincipalSummaryRow(row);
        if (parsed === null) {
            throw new Error(
                "[agent-principals] single read returned a row without principalId/name",
            );
        }
        return parsed;
    },
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
            logger.warn("[agents] memory envelope malformed; treated as empty");
            return [];
        }
        return raw.memories
            .map(normalizeWorkspaceAgentMemory)
            .filter((row): row is WorkspaceAgentMemory => row !== null);
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
    async updateAgentPrincipal(
        principalId: string,
        body: AgentPrincipalUpdateBody,
    ): Promise<AgentPrincipalUpdateView> {
        const payload: Record<string, unknown> = {};
        if (body.hooks !== undefined) payload.hooks = body.hooks;
        if (body.contextPolicy !== undefined) payload.contextPolicy = body.contextPolicy;
        if (body.delegationPolicy !== undefined) payload.delegationPolicy = body.delegationPolicy;
        if (body.defaultModelProvider !== undefined) {
            payload.defaultModelProvider = body.defaultModelProvider;
        }
        if (body.defaultModelName !== undefined) payload.defaultModelName = body.defaultModelName;
        if (body.allowedModels !== undefined) payload.allowedModels = body.allowedModels;
        return request<AgentPrincipalUpdateView>(
            `/agent-principals/${encodeURIComponent(principalId)}`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            },
        );
    },
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
    getAgentTemplates(
        layer: AgentTemplateLayerResponse["layer"],
        workspaceId?: string,
    ): Promise<AgentTemplateLayerResponse> {
        const query = new URLSearchParams({ layer });
        if (layer === "workspace" && workspaceId) query.set("workspaceId", workspaceId);
        return request<AgentTemplateLayerResponse>(`/agent-templates?${query.toString()}`);
    },
    createAgentPrincipal(input: AgentPrincipalCreateInput): Promise<AgentPrincipalCreateResponse> {
        const body: Record<string, unknown> = { name: input.name };
        if (input.templateId) body.templateId = input.templateId;
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
    createOwnAgentPrincipal(
        input: AgentPrincipalCreateInput,
    ): Promise<AgentPrincipalCreateResponse> {
        const body: Record<string, unknown> = { name: input.name };
        if (input.templateId) body.templateId = input.templateId;
        if (input.defaultModelProvider) body.defaultModelProvider = input.defaultModelProvider;
        if (input.defaultModelName) body.defaultModelName = input.defaultModelName;
        if (input.allowedModels && input.allowedModels.length > 0) {
            body.allowedModels = input.allowedModels;
        }
        return request<AgentPrincipalCreateResponse>("/agent-principals", {
            method: "POST",
            // Matrix U1 — see the method docs: a blank explicit header is the "no workspace
            // context" marker; it is not a workspace id and must never become one.
            headers: { "X-Workspace-Id": "" },
            body: JSON.stringify(body),
        });
    },
    disableAgentPrincipal(principalId: string): Promise<void> {
        return request<void>(`/agent-principals/${encodeURIComponent(principalId)}/disable`, {
            method: "POST",
        });
    },
};
