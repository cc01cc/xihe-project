/* task-1032：自 composables/api.ts 拆出的 preset 段（逐字节搬运）。 */
import { request } from "./_core";
import { catalogLocale } from "./_normalize";
export type ApiAtomScopeClass = "instance" | "both";
export interface ApiPresetAtom {
    name: string;
    scopeClass: ApiAtomScopeClass;
    capability: boolean;
    resource: string;
    /**
     * 服务端按 `?locale` 解析好的显示标签（PLAN-0651 D51-37）。UI 不自建原子词表，
     * 只渲染这个字段；缺省时回退到 `name`（服务端保证非空）。
     */
    displayName?: string;
    /**
     * task-415（RBAC P0-1）投影：该原子**永不可授予智能体主体**（CP
     * `PermissionAtomCatalog.agentPrincipalForbiddenAtoms()` 为 SSOT，openapi RoleAtom 已登记）。
     * UI 只消费这个标记，不本地重算词表。缺省视为 false —— 服务端对只持
     * `MANAGE_WORKSPACE_AGENTS` 的调用方本就会**整行剔除**含禁用原子的预设（listPresets 契约），
     * 只有持 `MANAGE_ROLES` 的全量视图才会把它们送过来。
     */
    agentPrincipalForbidden?: boolean;
}
export interface ApiPresetCatalog {
    atoms: ApiPresetAtom[];
    scopes: string[];
}
export interface ApiPreset {
    id: string;
    name: string;
    displayName: string;
    description: string | null;
    system: boolean;
    atoms: ApiPresetAtom[];
    bindingCount: number;
}
export interface ApiPresetAtomInput {
    actionClass: string;
    /** 留空/null 与不传等价 —— CP 按 canonical 落值。 */
    resource?: string | null;
}
export interface ApiPresetWrite {
    name?: string | null;
    displayName?: string | null;
    description?: string | null;
    /**
     * 混发合法：未收窄的原子仍送裸串（老客户端的字节不变），收窄的送对象。
     * 同一原子出现两次且 pattern 不同，CP 会 400 `INVALID_GRANT_RESOURCE`。
     */
    atoms?: Array<string | ApiPresetAtomInput> | null;
}
export type ApiBindingScope = "instance" | "workspace";
export interface ApiBindingRow {
    id: string;
    subjectType: string;
    subjectId: string;
    /** UI projection of wire `presetId` (task-843); see `ApiPresetBindingWireRow`. */
    roleId: string;
    roleName: string;
    grantedBy: string | null;
    grantedAt: string | null;
}
export interface ApiBindingSet {
    scopeType: string;
    scopeId: string | null;
    bindings: ApiBindingRow[];
}
export interface ApiBindingInput {
    subjectType?: string;
    subjectId: string;
    roleId: string;
}
export type ApiPresetGovernanceSubjectType = "user" | "agent_principal";
export interface ApiPresetGovernanceAtom {
    actionClass: string;
    resource: string;
}
export interface ApiPresetGovernanceMissingAtom extends ApiPresetGovernanceAtom {
    originPresetIds: string[];
}
export interface ApiPresetGovernanceExtraAtom extends ApiPresetGovernanceAtom {
    originPresetId: string | null;
}
export interface ApiPresetGovernanceScopeDiff {
    scopeType: "instance" | "workspace";
    scopeId: string | null;
    missing: ApiPresetGovernanceMissingAtom[];
    extra: ApiPresetGovernanceExtraAtom[];
    /** `origin_preset_id = NULL` 的本地行：任何重放都不删。 */
    localAdded: ApiPresetGovernanceAtom[];
    /** 「应有缺失，但同 scope 又有本地行」。 */
    overridden: ApiPresetGovernanceAtom[];
    inSync: boolean;
}
export interface ApiPresetGovernanceSummary {
    missing: number;
    extra: number;
    localAdded: number;
    overridden: number;
    /** `localAdded`/`overridden` 单独存在不算 changed —— 重放不会写它们。 */
    changed: boolean;
}
export interface ApiPresetGovernanceCompare {
    subjectType: ApiPresetGovernanceSubjectType;
    subjectId: string;
    scopes: ApiPresetGovernanceScopeDiff[];
    summary: ApiPresetGovernanceSummary;
}
export interface ApiPresetGovernanceRealignResult {
    created: number;
    deleted: number;
    changed: boolean;
    scopes: number;
    source: "assigned";
}
export interface ApiPresetBindingWireRow {
    id: string;
    subjectType: string;
    subjectId: string;
    presetId: string;
    roleName: string;
    grantedBy: string | null;
    grantedAt: string | null;
}
export interface ApiPresetBindingWireSet {
    scopeType: string;
    scopeId: string | null;
    bindings: ApiPresetBindingWireRow[];
}
export function toApiBindingSet(wire: ApiPresetBindingWireSet): ApiBindingSet {
    return {
        scopeType: wire.scopeType,
        scopeId: wire.scopeId,
        bindings: (wire.bindings ?? []).map((row) => ({
            id: row.id,
            subjectType: row.subjectType,
            subjectId: row.subjectId,
            roleId: row.presetId,
            roleName: row.roleName,
            grantedBy: row.grantedBy ?? null,
            grantedAt: row.grantedAt ?? null,
        })),
    };
}

export const presetApi = {
    presetsCatalog(): Promise<ApiPresetCatalog> {
        // D51-37: the CP resolves the label server-side from an explicit locale; the UI keeps no
        // atom vocabulary. `<html lang>` is the locale SSOT written by applyLocale().
        return request<ApiPresetCatalog>(
            `/presets/catalog?locale=${encodeURIComponent(catalogLocale())}`,
        );
    },
    listPresets(workspaceId?: string): Promise<ApiPreset[]> {
        // PLAN-0667 M3：候选预设按 workspace 授权上下文过滤（Lead 2026-11-05 冻结：不新增候选端点）。
        const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
        return request<ApiPreset[]>(`/presets${query}`);
    },
    createPreset(input: ApiPresetWrite): Promise<ApiPreset> {
        return request<ApiPreset>("/presets", { method: "POST", body: JSON.stringify(input) });
    },
    updatePreset(presetId: string, input: ApiPresetWrite): Promise<ApiPreset> {
        return request<ApiPreset>(`/presets/${encodeURIComponent(presetId)}`, {
            method: "PATCH",
            body: JSON.stringify(input),
        });
    },
    async deletePreset(presetId: string): Promise<void> {
        await request<void>(`/presets/${encodeURIComponent(presetId)}`, { method: "DELETE" });
    },
    async getBindings(scope: ApiBindingScope, scopeId?: string | null): Promise<ApiBindingSet> {
        const query = new URLSearchParams({ scope });
        if (scope === "workspace" && scopeId) query.set("scopeId", scopeId);
        const wire = await request<ApiPresetBindingWireSet>(`/bindings?${query.toString()}`);
        return toApiBindingSet(wire);
    },
    async replaceBindings(
        scope: ApiBindingScope,
        scopeId: string | null | undefined,
        bindings: ApiBindingInput[],
    ): Promise<ApiBindingSet> {
        const query = new URLSearchParams({ scope });
        if (scope === "workspace" && scopeId) query.set("scopeId", scopeId);
        const wire = await request<ApiPresetBindingWireSet>(`/bindings?${query.toString()}`, {
            method: "PUT",
            body: JSON.stringify({
                bindings: bindings.map((binding) => ({
                    ...(binding.subjectType ? { subjectType: binding.subjectType } : {}),
                    subjectId: binding.subjectId,
                    presetId: binding.roleId,
                })),
            }),
        });
        return toApiBindingSet(wire);
    },
    async comparePresetGovernance(
        subjectType: ApiPresetGovernanceSubjectType,
        subjectId: string,
        presetId?: string | null,
    ): Promise<ApiPresetGovernanceCompare> {
        const query = new URLSearchParams({ subjectType, subjectId });
        if (presetId) query.set("presetId", presetId);
        return request<ApiPresetGovernanceCompare>(
            `/presets/governance/compare?${query.toString()}`,
        );
    },
    async realignPresetGovernance(
        subjectType: ApiPresetGovernanceSubjectType,
        subjectId: string,
    ): Promise<ApiPresetGovernanceRealignResult> {
        return request<ApiPresetGovernanceRealignResult>("/presets/governance/realign", {
            method: "POST",
            body: JSON.stringify({ subjectType, subjectId }),
        });
    },
};
