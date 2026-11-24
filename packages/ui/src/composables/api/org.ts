/* task-1032：自 composables/api.ts 拆出的 org 段（逐字节搬运）。 */
import { request, apiGet } from "./_core";
import type { ApiUserCapabilities } from "./_types";
export interface ApiOrgUnitNode {
    id: string;
    name: string;
    parentId: string | null;
    depth: number;
    hasChildren: boolean;
}
export interface ApiOrgUnitMember {
    memberKind: "human" | "agent_principal";
    memberId: string;
    orgUnitId: string;
    displayName: string | null;
}
export interface ApiOrgUnitMemberCandidate {
    memberKind: "human" | "agent_principal";
    memberId: string;
    displayName: string;
}
export interface ApiOrgUnitCreated {
    id: string;
    path: string;
}
export interface ApiOrgUnitMemberMoveResult {
    memberId: string;
    fromOrgUnitId: string | null;
    toOrgUnitId: string;
    affectedWorkspaceIds: string[];
    auditEvent: string;
}
export interface ApiOrgUnitRoleBindingList {
    /**
     * UI projection of wire `presetIds` (task-843): the HTTP contract speaks grant presets, the
     * component-facing name stays `roleIds` so the org-members panel keeps one vocabulary.
     */
    roleIds: string[];
}
export interface ApiAdminUser {
    id: string;
    email: string;
    username?: string;
    name?: string;
    capabilities?: ApiUserCapabilities;
    status?: string;
}

export const orgApi = {
    async listAdminUsers(query: string): Promise<ApiAdminUser[]> {
        const params = new URLSearchParams({ size: "50" });
        if (query.trim()) params.set("q", query.trim());
        const body = await request<{ items?: ApiAdminUser[] }>(`/users?${params.toString()}`);
        return Array.isArray(body?.items) ? body.items : [];
    },
    async listOrgUnits(params: { parentId?: string; q?: string } = {}): Promise<ApiOrgUnitNode[]> {
        const search = new URLSearchParams();
        if (params.parentId) search.set("parentId", params.parentId);
        if (params.q) search.set("q", params.q);
        const suffix = search.size > 0 ? `?${search.toString()}` : "";
        const data = await apiGet<{ nodes: ApiOrgUnitNode[] }>(`/org-units${suffix}`);
        return data.nodes;
    },
    async listOrgUnitMembers(
        unitId: string,
        opts: { includeDescendants?: boolean } = {},
    ): Promise<ApiOrgUnitMember[]> {
        const suffix = opts.includeDescendants ? "?includeDescendants=true" : "";
        const data = await apiGet<{ members: ApiOrgUnitMember[] }>(
            `/org-units/${encodeURIComponent(unitId)}/members${suffix}`,
        );
        return data.members;
    },
    async listOrgUnitMemberCandidates(
        unitId: string,
        opts: { memberKind: ApiOrgUnitMember["memberKind"]; q?: string },
    ): Promise<ApiOrgUnitMemberCandidate[]> {
        const search = new URLSearchParams({ memberKind: opts.memberKind });
        if (opts.q && opts.q.trim()) search.set("q", opts.q.trim());
        const data = await apiGet<{ candidates: ApiOrgUnitMemberCandidate[] }>(
            `/org-units/${encodeURIComponent(unitId)}/member-candidates?${search.toString()}`,
        );
        return data.candidates;
    },
    createOrgUnit(input: { name: string; parentId: string | null }): Promise<ApiOrgUnitCreated> {
        return request<ApiOrgUnitCreated>("/org-units", {
            method: "POST",
            body: JSON.stringify(input),
        });
    },
    renameOrgUnit(unitId: string, name: string): Promise<ApiOrgUnitNode> {
        return request<ApiOrgUnitNode>(`/org-units/${encodeURIComponent(unitId)}`, {
            method: "PATCH",
            body: JSON.stringify({ name }),
        });
    },
    moveOrgUnit(unitId: string, parentId: string | null): Promise<ApiOrgUnitNode> {
        return request<ApiOrgUnitNode>(`/org-units/${encodeURIComponent(unitId)}/parent`, {
            method: "PUT",
            body: JSON.stringify({ parentId }),
        });
    },
    placeOrgUnitMember(
        unitId: string,
        memberId: string,
        memberKind: ApiOrgUnitMember["memberKind"],
        opts: { confirmAffected?: boolean } = {},
    ): Promise<ApiOrgUnitMemberMoveResult> {
        return request<ApiOrgUnitMemberMoveResult>(
            `/org-units/${encodeURIComponent(unitId)}/members/${encodeURIComponent(memberId)}?memberKind=${encodeURIComponent(memberKind)}`,
            {
                method: "PUT",
                body: JSON.stringify({ confirmAffected: opts.confirmAffected === true }),
            },
        );
    },
    removeOrgUnitMember(
        unitId: string,
        memberId: string,
        memberKind: ApiOrgUnitMember["memberKind"],
    ): Promise<void> {
        return request<void>(
            `/org-units/${encodeURIComponent(unitId)}/members/${encodeURIComponent(memberId)}?memberKind=${encodeURIComponent(memberKind)}`,
            { method: "DELETE" },
        );
    },
    async replaceOrgUnitRoleBindings(
        unitId: string,
        roleIds: string[],
    ): Promise<ApiOrgUnitRoleBindingList> {
        const wire = await request<{ presetIds?: string[] }>(
            `/org-units/${encodeURIComponent(unitId)}/preset-bindings`,
            { method: "PUT", body: JSON.stringify({ presetIds: roleIds }) },
        );
        return { roleIds: Array.isArray(wire?.presetIds) ? wire.presetIds : [] };
    },
};
