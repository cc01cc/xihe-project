import { defineStore } from "pinia";
import { ref } from "vue";
import { ApiError, api } from "../composables/api";
import { i18n } from "../i18n";
import { presentCauseError } from "../lib/errorMessages";
import { logger } from "../lib/logger";
import type {
    ApprovalPolicyEffect,
    ApprovalPolicyShape,
    PolicyDomainView,
    PolicyRuleLayer,
    PolicyRuleView,
    PolicyToolFaceQueryScope,
    PolicyToolFaceView,
} from "../types";

export interface PolicyRuleDraft {
    layer: PolicyRuleLayer;
    actionClass: string;
    resource: string;
    effect: ApprovalPolicyEffect;
    priority: number;
    locked: boolean;
}

export interface ToolFaceClassificationDraft {
    scope: PolicyToolFaceQueryScope;
    tool: string;
    actionClass: string;
    shape: ApprovalPolicyShape;
}

function createLayerRecord<T>(create: () => T): Record<PolicyRuleLayer, T> {
    return { instance: create(), user: create(), workspace: create() };
}

/**
 * task-45：只产出**可读文案**（改前拼 `CODE: english detail` 直出）。
 * 其中 `toolFacesError` 有屏面消费者（工具面页），所以那一路同时落
 * `toolFacesErrorDetail`（原始 detail，诊断面折叠显示）；其余四个错误位
 * （domains/rules/conflicts）当前没有渲染消费者，只留文案 —— 无消费者的字段会漂移。
 */
function errorCopy(cause: unknown, fallback: string): string {
    return presentCauseError(i18n.global.t, cause, fallback).copy;
}

function errorDetailOf(cause: unknown): string | null {
    return presentCauseError(i18n.global.t, cause, "").technicalDetail;
}

/** 403 means the authenticated user lacks the layer's write authority (server is authoritative). */
function isForbidden(cause: unknown): boolean {
    return cause instanceof ApiError && cause.problem.status === 403;
}

export const usePolicyAdminStore = defineStore("policyAdmin", () => {
    const domains = ref<PolicyDomainView[]>([]),
        domainsLoading = ref(false),
        domainsError = ref<string | null>(null),
        rulesByLayer = ref<Record<PolicyRuleLayer, PolicyRuleView[]>>(createLayerRecord(() => [])),
        rulesLoading = ref<Record<PolicyRuleLayer, boolean>>(createLayerRecord(() => false)),
        rulesError = ref<Record<PolicyRuleLayer, string | null>>(createLayerRecord(() => null)),
        rulesForbidden = ref<Record<PolicyRuleLayer, boolean>>(createLayerRecord(() => false)),
        conflictsByLayer = ref<Record<PolicyRuleLayer, PolicyRuleView[]>>(
            createLayerRecord(() => []),
        ),
        conflictsError = ref<Record<PolicyRuleLayer, string | null>>(createLayerRecord(() => null)),
        creatingRule = ref(false),
        deletingRuleId = ref<string | null>(null),
        toolFaces = ref<PolicyToolFaceView[]>([]),
        toolFacesScope = ref<PolicyToolFaceQueryScope>("workspace"),
        toolFacesLoading = ref(false),
        toolFacesError = ref<string | null>(null),
        /** task-45：原始 detail（仅工具面页的诊断折叠区使用；默认不渲染）。 */
        toolFacesErrorDetail = ref<string | null>(null),
        toolFacesForbidden = ref(false),
        classifyingTool = ref(false);

    async function loadDomains(): Promise<void> {
        domainsLoading.value = true;
        domainsError.value = null;
        try {
            domains.value = await api.listPolicyDomains();
        } catch (cause) {
            domainsError.value = errorCopy(cause, i18n.global.t("errors.requestFailed"));
            logger.warn("Failed to load policy domains", cause);
        } finally {
            domainsLoading.value = false;
        }
    }

    async function loadRules(layer: PolicyRuleLayer): Promise<void> {
        rulesLoading.value[layer] = true;
        rulesError.value[layer] = null;
        rulesForbidden.value[layer] = false;
        try {
            rulesByLayer.value[layer] = await api.listPolicyRules(layer);
        } catch (cause) {
            rulesError.value[layer] = errorCopy(cause, i18n.global.t("errors.requestFailed"));
            rulesForbidden.value[layer] = isForbidden(cause);
            logger.warn(`Failed to load ${layer}-layer policy rules`, cause);
        } finally {
            rulesLoading.value[layer] = false;
        }
    }

    async function loadConflicts(layer: PolicyRuleLayer): Promise<void> {
        conflictsError.value[layer] = null;
        try {
            conflictsByLayer.value[layer] = await api.listPolicyRuleConflicts(layer);
        } catch (cause) {
            // The per-row `conflict` field from the list response remains authoritative for display;
            // a failed summary request must not be presented as "no conflicts found".
            conflictsByLayer.value[layer] = [];
            conflictsError.value[layer] = errorCopy(cause, i18n.global.t("errors.requestFailed"));
            logger.warn(`Failed to load ${layer}-layer policy conflicts`, cause);
        }
    }

    async function refreshLayer(layer: PolicyRuleLayer): Promise<void> {
        await Promise.all([loadRules(layer), loadConflicts(layer), loadDomains()]);
    }

    async function createRule(draft: PolicyRuleDraft): Promise<PolicyRuleView> {
        creatingRule.value = true;
        rulesForbidden.value[draft.layer] = false;
        try {
            const created = await api.createPolicyRule({
                layer: draft.layer,
                actionClass: draft.actionClass,
                resource: draft.resource,
                effect: draft.effect,
                priority: draft.priority,
                locked: draft.locked,
            });
            await refreshLayer(draft.layer);
            return created;
        } catch (cause) {
            // The caller owns the failure message (inline form); the store only tracks authority.
            rulesForbidden.value[draft.layer] = isForbidden(cause);
            throw cause;
        } finally {
            creatingRule.value = false;
        }
    }

    async function deleteRule(id: string, layer: PolicyRuleLayer): Promise<void> {
        deletingRuleId.value = id;
        try {
            await api.deletePolicyRule(id, layer);
            await refreshLayer(layer);
        } catch (cause) {
            rulesForbidden.value[layer] = isForbidden(cause);
            throw cause;
        } finally {
            deletingRuleId.value = null;
        }
    }

    async function loadToolFaces(scope: PolicyToolFaceQueryScope): Promise<void> {
        toolFacesScope.value = scope;
        toolFacesLoading.value = true;
        toolFacesError.value = null;
        toolFacesErrorDetail.value = null;
        toolFacesForbidden.value = false;
        try {
            toolFaces.value = await api.listPolicyToolFaces(scope);
        } catch (cause) {
            toolFacesError.value = errorCopy(cause, i18n.global.t("errors.requestFailed"));
            toolFacesErrorDetail.value = errorDetailOf(cause);
            toolFacesForbidden.value = isForbidden(cause);
            logger.warn(`Failed to load ${scope}-scope tool faces`, cause);
        } finally {
            toolFacesLoading.value = false;
        }
    }

    async function classifyTool(draft: ToolFaceClassificationDraft): Promise<PolicyToolFaceView> {
        classifyingTool.value = true;
        toolFacesError.value = null;
        toolFacesErrorDetail.value = null;
        toolFacesForbidden.value = false;
        try {
            const face = await api.upsertPolicyToolFace(draft);
            await loadToolFaces(draft.scope);
            return face;
        } catch (cause) {
            toolFacesError.value = errorCopy(cause, i18n.global.t("errors.requestFailed"));
            toolFacesErrorDetail.value = errorDetailOf(cause);
            toolFacesForbidden.value = isForbidden(cause);
            throw cause;
        } finally {
            classifyingTool.value = false;
        }
    }

    function reset() {
        domains.value = [];
        domainsError.value = null;
        rulesByLayer.value = createLayerRecord(() => [] as PolicyRuleView[]);
        rulesError.value = createLayerRecord(() => null);
        rulesForbidden.value = createLayerRecord(() => false);
        conflictsByLayer.value = createLayerRecord(() => [] as PolicyRuleView[]);
        conflictsError.value = createLayerRecord(() => null);
        toolFaces.value = [];
        toolFacesError.value = null;
        toolFacesErrorDetail.value = null;
        toolFacesForbidden.value = false;
    }

    return {
        domains,
        domainsLoading,
        domainsError,
        rulesByLayer,
        rulesLoading,
        rulesError,
        rulesForbidden,
        conflictsByLayer,
        conflictsError,
        creatingRule,
        deletingRuleId,
        toolFaces,
        toolFacesScope,
        toolFacesLoading,
        toolFacesError,
        toolFacesErrorDetail,
        toolFacesForbidden,
        classifyingTool,
        loadDomains,
        loadRules,
        loadConflicts,
        createRule,
        deleteRule,
        loadToolFaces,
        classifyTool,
        reset,
    };
});
