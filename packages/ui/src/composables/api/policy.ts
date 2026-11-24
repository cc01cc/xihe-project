/* task-1032：自 composables/api.ts 拆出的 policy 段（逐字节搬运）。 */
import type {
    ApprovalPolicyEffect,
    ApprovalPolicyShape,
    ApprovalPolicySourceLayer,
    PolicyDomainView,
    PolicyModeUpdateResponse,
    PolicyRuleLayer,
    PolicyRuleView,
    PolicyToolFaceQueryScope,
    PolicyToolFaceView,
    SessionPolicyMode,
    SessionPolicyModeState,
    SessionTier,
    SessionTierDenyReason,
    SessionTierState,
} from "../../types";
import { request, apiDelete } from "./_core";
import {
    asRecord,
    isEnumValue,
    approvalPolicyModes,
    approvalPolicySourceLayers,
    policyRuleLayers,
    approvalPolicyEffects,
    policyToolFaceScopes,
    approvalPolicyShapes,
} from "./_normalize";
export interface PermissionAtomSourceView {
    source: string;
    roleName?: string | null;
    scopeType?: string | null;
    scopeId?: string | null;
    grantId?: string | null;
}
export interface PermissionAtomView {
    actionClass: string;
    resource: string;
    sources?: PermissionAtomSourceView[];
}
export interface SelfPermissionsView {
    userId: string;
    instanceCapabilities: string[];
    instancePermissions: PermissionAtomView[];
    workspaces?: Array<{
        workspaceId: string;
        workspaceRole?: string;
        workspaceAdmin?: boolean;
        permissions?: PermissionAtomView[];
    }>;
}
export interface AuthorizationExplainAtomView {
    level: string;
    levelLabel?: string | null;
    actionClass: string;
    resource: string;
    reason?: string | null;
}
export interface AuthorizationExplainGrantRefView {
    level: string;
    levelLabel?: string | null;
    actionClass: string;
    resource: string;
    grantId: string;
    grantSource: string;
}
export interface AuthorizationExplainLevelView {
    level: string;
    label?: string | null;
    atomCount: number;
    matched: number;
}
export interface AuthorizationExplainView {
    allowed: boolean;
    deepestMissingLevel?: string | null;
    missingAtom?: AuthorizationExplainAtomView | null;
    missingLevels?: AuthorizationExplainAtomView[];
    matchedGrantRefs?: AuthorizationExplainGrantRefView[];
    evaluatedLevels?: AuthorizationExplainLevelView[];
}
export const sessionTiers = ["view", "workspace", "full"] as const,
    sessionTierSources = ["session", "workspace", "none"] as const,
    sessionTierDenyReasons = ["viewer", "not-owner", "no-atom"] as const;
export function normalizeSessionTierState(value: unknown): SessionTierState {
    const record = asRecord(value);
    const workspaceTier = record?.workspaceTier ?? null;
    const denyReason = record?.denyReason ?? null;
    if (
        !record ||
        !isEnumValue(record.tier, sessionTiers) ||
        !isEnumValue(record.source, sessionTierSources) ||
        (workspaceTier !== null && !isEnumValue(workspaceTier, sessionTiers)) ||
        typeof record.canConfigure !== "boolean" ||
        (denyReason !== null && !isEnumValue(denyReason, sessionTierDenyReasons)) ||
        !Array.isArray(record.available) ||
        record.available.some((item: unknown) => !isEnumValue(item, sessionTiers))
    ) {
        throw new Error("Invalid session tier response");
    }
    return {
        tier: record.tier,
        source: record.source,
        workspaceTier: workspaceTier as SessionTier | null,
        canConfigure: record.canConfigure,
        denyReason: denyReason as SessionTierDenyReason | null,
        available: record.available as SessionTier[],
    };
}
export function normalizePolicyModeState(
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
export function normalizePolicyModeUpdateResponse(
    value: unknown,
    fallbackSessionId: string,
): PolicyModeUpdateResponse {
    const state = normalizePolicyModeState(value, fallbackSessionId),
        record = asRecord(value);
    if (!record || record.scope !== "session") {
        throw new Error("Invalid policy mode update response");
    }
    return {
        sessionId: state.sessionId,
        mode: state.mode,
        scope: "session",
    };
}
export function normalizePolicyDomainView(value: unknown): PolicyDomainView {
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
export function normalizePolicyRuleView(value: unknown): PolicyRuleView {
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
export function normalizePolicyToolFace(value: unknown): PolicyToolFaceView {
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
export function normalizePolicyArray<T>(
    payload: unknown,
    normalize: (value: unknown) => T,
    label: string,
): T[] {
    if (!Array.isArray(payload)) throw new Error(`Invalid ${label} response: expected an array`);
    return payload.map(normalize);
}

export const policyApi = {
    getSelfPermissions(): Promise<SelfPermissionsView> {
        return request<SelfPermissionsView>("/me/permissions");
    },
    explainAuthorization(
        actionClass: string,
        resource?: string,
    ): Promise<AuthorizationExplainView> {
        const body: Record<string, string> = { actionClass: actionClass.trim() };
        if (resource !== undefined && resource.trim().length > 0) body.resource = resource.trim();
        return request<AuthorizationExplainView>("/authorization/explain", {
            method: "POST",
            body: JSON.stringify(body),
        });
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
    async getSessionTier(sessionId: string): Promise<SessionTierState> {
        return normalizeSessionTierState(
            await request<unknown>(`/sessions/${encodeURIComponent(sessionId)}/tier`),
        );
    },
    async setSessionTier(sessionId: string, tier: SessionTier): Promise<SessionTierState> {
        return normalizeSessionTierState(
            await request<unknown>(`/sessions/${encodeURIComponent(sessionId)}/tier`, {
                method: "PATCH",
                body: JSON.stringify({ tier }),
            }),
        );
    },
    async listPolicyDomains(): Promise<PolicyDomainView[]> {
        return normalizePolicyArray(
            await request<unknown>("/policy/domains"),
            normalizePolicyDomainView,
            "policy domains",
        );
    },
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
    async listPolicyRuleConflicts(layer: PolicyRuleLayer): Promise<PolicyRuleView[]> {
        const query = new URLSearchParams({ layer }).toString();
        return normalizePolicyArray(
            await request<unknown>(`/policy/rules/conflicts?${query}`),
            normalizePolicyRuleView,
            "policy rule conflicts",
        );
    },
    async listPolicyToolFaces(scope: PolicyToolFaceQueryScope): Promise<PolicyToolFaceView[]> {
        const query = new URLSearchParams({ scope }).toString();
        return normalizePolicyArray(
            await request<unknown>(`/policy/tool-faces?${query}`),
            normalizePolicyToolFace,
            "policy tool-faces",
        );
    },
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
};
