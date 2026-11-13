<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";

import { api } from "../../composables/api";
import {
    isResourceId,
    layersForResource,
    resolveResourceLayer,
    resourceDef,
    resourceLayerPath,
    type ResourceId,
    type ResourceLayer,
} from "../../lib/settingsIa";
import { shouldUseBrowserBack } from "../../lib/resourceDetail";
import { readTabWorkspaceId } from "../../lib/workspaceContext";
import { useCredentialsStore } from "../../stores/credentials";
import { logger } from "../../lib/logger";
import {
    listInstanceAgents,
    listInstanceCredentials,
    listInstanceMcpServers,
} from "../../services/instanceResources";
import { collectFields, type BooleanLabels, type DetailFields } from "./detailFields";
import type { AgentRoleBinding, AgentSkillBinding } from "../../composables/api";
import type { CredentialEventView, CredentialReference } from "../../types";
import { Button } from "../../components/ui/button";

/**
 * 资源**详情单页**（`/resources/<id>/:pk`，PLAN-0772 M2 / task-228）。
 *
 * <p>本文件只做两件事：**读已接线的数据** + **诚实呈现四种状态**。它不做写操作、不做权限判断
 * （写面与授权本来就在各自面板/CP 里），也不新写层口径 —— 层来自 `?layer=` 并经
 * `settingsIa.resolveResourceLayer` 解析（路由 `beforeEnter` 已把缺省/非法值规范化写回 URL）。</p>
 *
 * ## 数据边界（口径 3：只接已接线读面）
 *
 * 页面出现的每个字段都必须来自下列**已实现**读面之一；拿不到的字段**整行不渲染**
 * （不是 `—`、不是 `0`、不是编一个"看起来有数据"的占位）：
 *
 * | 资源 | 层 | 读面（file:line） |
 * | --- | --- | --- |
 * | credentials | USER / WORKSPACE | `api.listCredentials`（`composables/api.ts:4939`）+ `getCredentialReferences`（`:4975`）+ `getCredentialEvents`（`:5029`） |
 * | credentials | INSTANCE | `listInstanceCredentials`（`services/instanceResources.ts:114`）；该层**没有**引用/审计读面 ⇒ 不显示这两个区块，并明写原因 |
 * | mcp | WORKSPACE | `api.getStdioServers`（`:4096`）+ `getMcpServerStatus`（`:4104`） |
 * | mcp | INSTANCE | `listInstanceMcpServers`（`instanceResources.ts:301`） |
 * | skills | WORKSPACE | `api.getWorkspaceSkills`（`:3678`）；该层**没有**单条正文读面 ⇒ 明写原因 |
 * | skills | INSTANCE | `api.getSkillDefinition`（`:3698`，`includeBody=true`）—— 单条定义读面自带正文，**不再**多打一次列表请求 |
 * | skills | USER | `api.getSkillDefinition`（`:3698`，`includeBody=true`）—— CP 只返回**调用者自己的**个人定义（`openapi:5465`「takes no id (the caller is the owner)」），所以他人个人技能不可见是同一条契约；`T2b.3` 起不再是「未接线」态 |
 * | agents | USER | `api.listMyAgentPrincipals`（`:3408`） |
 * | agents | WORKSPACE | `api.getWorkspaceAgents`（`:3438`）+ `getAgentRoles`（`:3511`）+ `getAgentSkills`（`:3602`） |
 * | agents | INSTANCE | `listInstanceAgents`（`instanceResources.ts:222`） |
 * | knowledge | （0 层，G3） | 无实体 ⇒ 未接线诚实态 |
 * | 全部 | — | 诊断读面 `api.getHealth`（`:4268`，**只在错误态**用它区分"后端不健康"与"这一条读不到"） |
 *
 * ## 四态
 *
 * `loading` / `ready` / `not-found`（读面成功但 pk 不在该层）/ `unwired`（该资源+层根本没有详情读面），
 * 外加一个 `error`（读面本身失败，带 `getHealth` 诊断与重试）。**not-found 与 unwired 必须分开**：
 * 前者是"这条不存在"（可能是删了/拼错），后者是"产品没有这个面"（用户不该去找别的地方）。
 */
const route = useRoute();
const router = useRouter();
const { t, te } = useI18n();

const resourceId = computed<ResourceId | null>(() => {
    const meta = route.meta.resourceId;
    return isResourceId(meta) ? meta : null;
});
const layer = computed<ResourceLayer>(() =>
    resourceId.value ? resolveResourceLayer(resourceId.value, route.query.layer) : "USER",
);
const pk = computed(() => String(route.params.pk ?? ""));
const workspaceId = computed(() => readTabWorkspaceId());

interface SectionItem {
    name: string;
    meta: string[];
}

interface DetailSection {
    titleKey: string;
    emptyKey: string;
    items: SectionItem[];
}

interface DetailModel {
    title: string;
    /** 副标题 = 层名（"我的 / 本工作区 / 全平台"），从 tab 文案同源取。 */
    subtitle: string;
    /** 三态装配结果：`rows` 是画出来的行，`absentKeyList` 是读面没有返回的字段。 */
    fields: DetailFields;
    sections: DetailSection[];
    /** 已接线的整块文本（技能正文 / MCP 配置 JSON）；没有就不渲染。 */
    blockText?: string;
    blockTitleKey?: string;
    /** "这个层没有某读面"的如实说明（不是字段、不是 0）。 */
    noteKey?: string;
}

type Phase = "loading" | "ready" | "not-found" | "unwired" | "error";

const phase = ref<Phase>("loading");
const model = ref<DetailModel | null>(null);
const unwiredReasonKey = ref("");
const errorMessage = ref("");
const healthStatus = ref<string | null>(null);

let loadToken = 0;

function layerLabel(value: ResourceLayer): string {
    const key = `resources.layerTab.${resourceId.value ?? "credentials"}.${value}`;
    // `te()` 判存在而不是"t() 返回的是否等于键"：后者在真 vue-i18n 下会先打一条
    // "Not found … key" 警告再回落，日志里的噪声会让人以为缺键。
    if (te(key)) return t(key);
    const generic: Record<ResourceLayer, string> = {
        USER: "resources.layerUser",
        WORKSPACE: "resources.layerWorkspace",
        INSTANCE: "resources.layerInstance",
    };
    return t(generic[value]);
}

/**
 * 布尔值文案（`pushField` 时代由组件内联，现在下传给 `collectFields`）。
 *
 * <p>task-42：字段装配挪到 `detailFields.ts`（三态判定是纯函数，要能单测），本组件只提供文案。</p>
 */
function boolLabels(): BooleanLabels {
    return {
        true: t("resources.detail.boolean.true"),
        false: t("resources.detail.boolean.false"),
    };
}

/** 字段行的 testid：取文案键末段（`resources.detail.fields.fingerprint` ⇒ `fingerprint`）。 */
function fieldTestId(labelKey: string): string {
    return `resource-detail-field-${labelKey.split(".").slice(-1)[0]}`;
}

function isoTime(ms: number): string {
    return new Date(ms).toISOString();
}

function findOrNull<T>(rows: readonly T[], predicate: (row: T) => boolean): T | null {
    return rows.find((row) => predicate(row)) ?? null;
}

/** credentials：USER / WORKSPACE 共用同一读面，INSTANCE 走 `/instance/credentials`。 */
async function loadCredentials(): Promise<void> {
    if (layer.value === "INSTANCE") {
        const { credentials } = await listInstanceCredentials();
        const row = findOrNull(credentials, (entry) => entry.id === pk.value);
        if (!row) {
            phase.value = "not-found";
            return;
        }
        const fields = collectFields(
            row,
            [
                ["label", row.label],
                ["kind", row.kind],
                ["deliveryTier", row.deliveryTier],
                ["status", row.status],
                ["fingerprint", row.fingerprint],
                ["revision", row.revision],
                ["references", row.referenceCount],
                ["createdAt", row.createdAt],
                ["replacedAt", row.replacedAt],
            ],
            boolLabels(),
            row.states,
        );
        model.value = {
            title: row.label,
            subtitle: layerLabel(layer.value),
            fields,
            sections: [],
            // 实例层凭据没有 references/events 读面 —— 明写，不用空表冒充"没有引用"。
            noteKey: "resources.detail.notes.instanceCredential",
        };
        phase.value = "ready";
        return;
    }

    /**
     * task-254：USER / WORKSPACE 两层的列表读面**统一走凭据 store**（`stores/credentials.ts`）。
     *
     * <p>为什么不再自己拼参数：`ownerId: layer === "WORKSPACE" ? workspaceId : undefined` 在
     * `workspaceId` 为空时等于发"**无 `ownerId` 的 WORKSPACE 请求**" —— 契约要求 WORKSPACE/USER
     * 都带 `ownerId`，CP 缺省会把它回落成调用者自己的 user id，随后 membership 恒 false ⇒
     * `403 "Workspace membership is required"`（`task-237` 真栈实测，`task-239` 治本）。更坏的是
     * 它可以被静默退化成"无参调用"，把工作区凭据读成个人凭据 —— 那正是本坑的反面。
     * 所以这条"缺上下文就不请求"的判断只允许存在**一处**（`store.load` 里"层是 WORKSPACE 且
     * 没有 `ownerId`"那条分支 ⇒ `scopeMissing`），详情页**消费裁决**，不复制口径（同文件
     * `loadSkills`/`loadMcp` 已有"无上下文走 `unwired`"的先例）。</p>
     *
     * <p>（本条注释刻意不写那段判断的可复制字面量：`git grep` 的"守卫定义点"判据要能数到
     * **代码**，注释里复述一遍会让它误报。）</p>
     *
     * <p>状态归属：store 写它自己那份 `credentials/loading/error/scopeMissing`；本页 `phase` 仍
     * **只由本页读数驱动**（`scopeMissing` ⇒ `unwired`、`store.error` ⇒ `error`、row 命中 ⇒
     * `ready`/`not-found`），不把 `store.loading` 当 phase，也不在加载前重置别处的 `error`。</p>
     */
    const store = useCredentialsStore();
    // 两层都把工作区 id 直接传下去（USER 层传 undefined）；空值由 store 的守卫解释，本页不判。
    await store.load(layer.value, workspaceId.value ?? undefined);
    if (store.scopeMissing) {
        // 缺工作区上下文 = "这一层现在没有可读的归属范围"，不是"0 条"，更不是"请求成功但空"。
        unwiredReasonKey.value = "resources.detail.unwired.reasons.noWorkspace";
        phase.value = "unwired";
        return;
    }
    if (store.error) throw store.error;
    const row = findOrNull(store.credentials, (entry) => entry.id === pk.value);
    if (!row) {
        phase.value = "not-found";
        return;
    }

    const fields = collectFields(
        row,
        [
            ["label", row.label],
            ["kind", row.kind],
            ["deliveryTier", row.deliveryTier],
            ["status", row.status],
            ["owner", row.ownerType],
            ["fingerprint", row.fingerprint],
            ["revision", row.revision],
            ["references", row.referenceCount],
            ["createdAt", row.createdAt],
            ["replacedAt", row.replacedAt],
        ],
        boolLabels(),
    );

    // 引用与审计是**两条独立读面**：一条失败不该把整页打红（元数据已经拿到了）。
    const [references, events] = await Promise.allSettled([
        api.getCredentialReferences(pk.value),
        api.getCredentialEvents(pk.value),
    ]);
    const sections: DetailSection[] = [];
    if (references.status === "fulfilled") {
        sections.push({
            titleKey: "resources.detail.sections.references",
            emptyKey: "resources.detail.empty.references",
            items: references.value.references.map((reference: CredentialReference) => ({
                name: `${reference.subjectType} · ${reference.subjectId}`,
                meta: [reference.actionClass, reference.resource, reference.source],
            })),
        });
    }
    if (events.status === "fulfilled") {
        sections.push({
            titleKey: "resources.detail.sections.events",
            emptyKey: "resources.detail.empty.events",
            items: events.value.events.map((event: CredentialEventView) => ({
                name: event.eventType,
                meta: [event.actor, event.createdAt],
            })),
        });
    }
    model.value = {
        title: row.label,
        subtitle: layerLabel(layer.value),
        fields,
        sections,
        noteKey:
            references.status === "rejected" || events.status === "rejected"
                ? "resources.detail.notes.partialRead"
                : undefined,
    };
    phase.value = "ready";
}

async function loadSkills(): Promise<void> {
    if (layer.value === "WORKSPACE") {
        if (!workspaceId.value) {
            unwiredReasonKey.value = "resources.detail.unwired.reasons.noWorkspace";
            phase.value = "unwired";
            return;
        }
        const rows = await api.getWorkspaceSkills(workspaceId.value);
        const row = findOrNull(rows, (entry) => entry.skillId === pk.value);
        if (!row) {
            phase.value = "not-found";
            return;
        }
        const fields = collectFields(
            row,
            [
                ["skillId", row.skillId],
                ["name", row.name],
                ["scope", row.definitionScope?.type],
                ["workspace", row.definitionScope?.workspaceId],
            ],
            boolLabels(),
        );
        model.value = {
            title: row.name || row.skillId,
            subtitle: layerLabel(layer.value),
            fields,
            sections: [],
            // 工作区层没有单条正文读面（`getSkillDefinition` 只服务实例层定义）。
            noteKey: "resources.detail.notes.workspaceSkillBody",
        };
        phase.value = "ready";
        return;
    }

    const detail = await api.getSkillDefinition(pk.value, true);
    if (!detail) {
        phase.value = "not-found";
        return;
    }
    const fields = collectFields(
        detail,
        [
            ["skillId", detail.skillId],
            ["name", detail.name],
            ["description", detail.description],
            ["scope", detail.definitionScope?.type],
            ["version", detail.version],
            ["trusted", detail.trusted],
            ["oversize", detail.oversize],
            ["bodyTokens", detail.bodyTokensEst],
            ["sourcePath", detail.sourcePath],
            ["contentHash", detail.contentHash],
            ["updatedAt", detail.updatedAt],
        ],
        boolLabels(),
    );
    model.value = {
        title: detail.name || detail.skillId,
        subtitle: layerLabel(layer.value),
        fields,
        sections: [
            {
                titleKey: "resources.detail.sections.attachments",
                emptyKey: "resources.detail.empty.attachments",
                items: detail.attachments.map((attachment) => ({
                    name: attachment.path,
                    meta: [
                        `${attachment.sizeBytes} B`,
                        attachment.sha256,
                        attachment.kind ?? "",
                    ].filter(Boolean),
                })),
            },
        ],
        blockText: detail.body ?? undefined,
        blockTitleKey: "resources.detail.sections.body",
    };
    phase.value = "ready";
}

async function loadAgents(): Promise<void> {
    if (layer.value === "WORKSPACE") {
        if (!workspaceId.value) {
            unwiredReasonKey.value = "resources.detail.unwired.reasons.noWorkspace";
            phase.value = "unwired";
            return;
        }
        const binding = findOrNull(
            await api.getWorkspaceAgents(workspaceId.value),
            (entry) => entry.principalId === pk.value,
        );
        if (!binding) {
            phase.value = "not-found";
            return;
        }
        const fields = collectFields(
            binding,
            [
                ["principalId", binding.principalId],
                ["name", binding.name],
                ["template", binding.templateName],
                ["bound", binding.bound],
                ["disabled", binding.disabled],
                ["defaultModel", binding.defaultModelName],
                ["allowedModels", binding.allowedModels?.length],
                ["hooks", binding.hooks],
                ["contextPolicy", binding.contextPolicy],
                ["createdAt", binding.createdAt],
            ],
            boolLabels(),
        );

        const [roles, skills] = await Promise.allSettled([
            api.getAgentRoles(workspaceId.value, pk.value),
            api.getAgentSkills(workspaceId.value, pk.value),
        ]);
        const sections: DetailSection[] = [];
        if (roles.status === "fulfilled") {
            sections.push({
                titleKey: "resources.detail.sections.roles",
                emptyKey: "resources.detail.empty.roles",
                items: roles.value.map((role: AgentRoleBinding) => ({
                    name: role.displayName || role.name,
                    meta: [role.scopeType, role.roleId, `${role.atomCount}`],
                })),
            });
        }
        if (skills.status === "fulfilled") {
            sections.push({
                titleKey: "resources.detail.sections.skills",
                emptyKey: "resources.detail.empty.skills",
                items: skills.value.map((bindingSkill: AgentSkillBinding) => ({
                    name: bindingSkill.name,
                    meta: [bindingSkill.skillId, bindingSkill.scopeType ?? ""].filter(Boolean),
                })),
            });
        }
        model.value = {
            title: binding.name || binding.principalId,
            subtitle: layerLabel(layer.value),
            fields,
            sections,
            noteKey:
                roles.status === "rejected" || skills.status === "rejected"
                    ? "resources.detail.notes.partialRead"
                    : undefined,
        };
        phase.value = "ready";
        return;
    }

    if (layer.value === "INSTANCE") {
        const rows = await listInstanceAgents();
        const row = findOrNull(rows.agents, (entry) => entry.id === pk.value);
        if (!row) {
            phase.value = "not-found";
            return;
        }
        const fields = collectFields(
            row,
            [
                ["name", row.name],
                ["template", row.templateName],
                ["modelProvider", row.modelProvider],
                ["modelName", row.modelName],
                ["disabled", row.disabled],
                ["createdAt", row.createdAt],
            ],
            boolLabels(),
            row.states,
        );
        model.value = {
            title: row.name,
            subtitle: layerLabel(layer.value),
            fields,
            sections: [],
        };
        phase.value = "ready";
        return;
    }

    // USER：个人智能体主体（`created_by=self`）。
    const principal = findOrNull(
        await api.listMyAgentPrincipals(),
        (entry) => entry.principalId === pk.value,
    );
    if (!principal) {
        phase.value = "not-found";
        return;
    }
    const fields = collectFields(
        principal,
        [
            ["principalId", principal.principalId],
            ["name", principal.name],
            ["template", principal.templateName],
            ["disabled", principal.disabled],
            ["defaultModel", principal.defaultModelName],
            ["createdAt", principal.createdAt],
        ],
        boolLabels(),
    );
    const noteKey = workspaceId.value
        ? undefined
        : "resources.detail.notes.needWorkspaceForBindings";
    model.value = {
        title: principal.name || principal.principalId,
        subtitle: layerLabel(layer.value),
        fields,
        sections: [],
        noteKey,
    };
    phase.value = "ready";
}

async function loadMcp(): Promise<void> {
    if (layer.value === "INSTANCE") {
        const { servers } = await listInstanceMcpServers();
        const row =
            findOrNull(servers, (entry) => entry.id === pk.value) ??
            findOrNull(servers, (entry) => entry.name === pk.value);
        if (!row) {
            phase.value = "not-found";
            return;
        }
        const fields = collectFields(
            row,
            [
                ["name", row.name],
                ["transport", row.transport],
                ["url", row.url],
                ["enabled", row.enabled],
                ["credentialId", row.credentialId],
                ["createdAt", row.createdAt],
            ],
            boolLabels(),
            row.states,
        );
        model.value = {
            title: row.name,
            subtitle: layerLabel(layer.value),
            fields,
            sections: [],
        };
        phase.value = "ready";
        return;
    }

    if (!workspaceId.value) {
        unwiredReasonKey.value = "resources.detail.unwired.reasons.noWorkspace";
        phase.value = "unwired";
        return;
    }
    // WORKSPACE：pk = stdio server 名（`servers` 映射的键），运行状态在另一条读面里。
    const [config, status] = await Promise.allSettled([
        api.getStdioServers(workspaceId.value),
        api.getMcpServerStatus(workspaceId.value),
    ]);
    const servers = config.status === "fulfilled" ? (config.value.servers ?? {}) : {};
    const statuses = status.status === "fulfilled" ? status.value.servers : [];
    const serverConfig = servers[pk.value];
    const serverStatus = findOrNull(statuses, (entry) => entry.serverId === pk.value);
    if (serverConfig === undefined && !serverStatus) {
        phase.value = "not-found";
        return;
    }
    const fields = collectFields(
        serverStatus,
        [
            ["state", serverStatus?.state],
            ["attempt", serverStatus?.attempt],
            ["lastError", serverStatus?.lastError],
            ["since", serverStatus && isoTime(serverStatus.sinceMs)],
            ["epoch", serverStatus?.epoch],
        ],
        boolLabels(),
    );
    model.value = {
        title: pk.value,
        subtitle: layerLabel(layer.value),
        fields,
        sections: [],
        blockText: serverConfig === undefined ? undefined : JSON.stringify(serverConfig, null, 2),
        blockTitleKey: "resources.detail.sections.mcpConfig",
        noteKey:
            config.status === "rejected" || status.status === "rejected"
                ? "resources.detail.notes.partialRead"
                : undefined,
    };
    phase.value = "ready";
}

async function load(): Promise<void> {
    const token = ++loadToken;
    phase.value = "loading";
    model.value = null;
    unwiredReasonKey.value = "";
    errorMessage.value = "";
    healthStatus.value = null;

    const id = resourceId.value;
    if (!id) {
        // `meta.resourceId` 缺失 = 路由表装配错（资源区 404 兜底视图走的是别的组件）。
        phase.value = "not-found";
        return;
    }
    if ((resourceDef(id).gaps ?? []).length > 0) {
        // knowledge：0 层 + G3 缺口，**不放行**详情（口径 4）。
        unwiredReasonKey.value = "resources.detail.unwired.reasons.knowledgeGap";
        phase.value = "unwired";
        return;
    }
    if (!layersForResource(id).includes(layer.value)) {
        // 层不存在于该资源（例如 mcp 的 USER 层）：层解析已回落默认层，走到这里说明状态自相矛盾。
        unwiredReasonKey.value = "resources.detail.unwired.reasons.layerMissing";
        phase.value = "unwired";
        return;
    }

    try {
        switch (id) {
            case "credentials": {
                await loadCredentials();
                break;
            }
            case "skills": {
                await loadSkills();
                break;
            }
            case "agents": {
                await loadAgents();
                break;
            }
            case "mcp": {
                await loadMcp();
                break;
            }
            default: {
                unwiredReasonKey.value = "resources.detail.unwired.reasons.knowledgeGap";
                phase.value = "unwired";
            }
        }
    } catch (cause) {
        logger.error("resource detail load failed: " + String(cause));
        errorMessage.value = cause instanceof Error ? cause.message : String(cause);
        phase.value = "error";
        // 只在这一态调用诊断读面：区分"后端不健康"与"这一条读不到"。
        try {
            healthStatus.value = (await api.getHealth()).status;
        } catch (healthCause) {
            logger.error("health probe failed: " + String(healthCause));
            healthStatus.value = null;
        }
    }
    if (token !== loadToken) return;
}

watch(
    () => [route.fullPath, workspaceId.value] as const,
    () => void load(),
    { immediate: true },
);

/**
 * 返回栈（口径 2）：**后退优先**；没有应用内历史时回落该层列表页。
 *
 * 判据只用 `history.state.back`（vue-router 写的上一个内部路由）：直接粘贴 URL / 新标签页时为
 * `null`，此时 `router.back()` 会把人送出应用。E2E 的两条断言分别对应这两支。
 */
function goBack(): void {
    const back = (router.options.history.state as { back?: unknown }).back;
    if (shouldUseBrowserBack(back)) {
        router.back();
        return;
    }
    if (!resourceId.value) {
        void router.push("/workspace");
        return;
    }
    void router.push(resourceLayerPath(resourceId.value, layer.value));
}
</script>

<template>
    <section data-testid="resource-detail" class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" size="sm" data-testid="resource-detail-back" @click="goBack">
                ← {{ t("resources.detail.backToList") }}
            </Button>
            <span
                data-testid="resource-detail-layer"
                class="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
            >
                {{ layerLabel(layer) }}
            </span>
        </div>

        <p
            v-if="phase === 'loading'"
            data-testid="resource-detail-loading"
            class="text-sm text-muted-foreground"
        >
            {{ t("resources.detail.loading") }}
        </p>

        <div
            v-else-if="phase === 'unwired'"
            data-testid="resource-detail-unwired"
            class="rounded-md border border-dashed bg-muted/30 px-4 py-6"
        >
            <h1 class="text-lg font-semibold">{{ t("resources.detail.unwired.title") }}</h1>
            <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
                {{ t(unwiredReasonKey) }}
            </p>
            <p class="mt-2 text-sm text-muted-foreground">
                {{ t("resources.detail.unwired.body") }}
            </p>
        </div>

        <div
            v-else-if="phase === 'not-found'"
            data-testid="resource-detail-not-found"
            class="rounded-md border border-dashed bg-muted/30 px-4 py-6"
        >
            <h1 class="text-lg font-semibold">{{ t("resources.detail.notFound.title") }}</h1>
            <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
                {{ t("resources.detail.notFound.body") }}
            </p>
        </div>

        <div
            v-else-if="phase === 'error'"
            data-testid="resource-detail-error"
            class="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-6"
        >
            <h1 class="text-lg font-semibold">{{ t("resources.detail.error.title") }}</h1>
            <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
                {{ t("resources.detail.error.body") }}
            </p>
            <p data-testid="resource-detail-error-message" class="mt-1 text-sm text-destructive">
                {{ errorMessage }}
            </p>
            <p data-testid="resource-detail-health" class="mt-1 text-xs text-muted-foreground">
                {{
                    healthStatus === null
                        ? t("resources.detail.health.unreachable")
                        : t("resources.detail.health.ok", { status: healthStatus })
                }}
            </p>
            <Button class="mt-3" size="sm" variant="outline" @click="load">
                {{ t("resources.detail.error.retry") }}
            </Button>
        </div>

        <div v-else-if="model" data-testid="resource-detail-body" class="space-y-4">
            <div>
                <h1 data-testid="resource-detail-title" class="text-xl font-semibold">
                    {{ model.title }}
                </h1>
                <p class="text-sm text-muted-foreground">{{ model.subtitle }}</p>
            </div>

            <dl
                v-if="model.fields.rows.length"
                data-testid="resource-detail-fields"
                class="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,12rem)_1fr]"
            >
                <template v-for="field in model.fields.rows" :key="field.labelKey">
                    <dt class="text-muted-foreground">{{ t(field.labelKey) }}</dt>
                    <dd
                        :data-testid="fieldTestId(field.labelKey)"
                        :data-field-state="field.state"
                        class="break-words"
                        :class="field.state === 'empty' ? 'text-muted-foreground' : ''"
                    >
                        {{
                            field.state === "empty" ? t("resources.detail.emptyValue") : field.value
                        }}
                    </dd>
                </template>
            </dl>

            <!--
                task-42：「字段不存在」与「字段存在但为空」在界面上原本长得一模一样（都整行消失）。
                空值现在画成显式的「（空）」（数据问题：这条没填）；没有返回的字段在这里**点名**
                （契约问题：读面没给这个键），两件事分开说，谁也不冒充谁。
            -->
            <section
                v-if="model.fields.absentKeyList.length"
                data-testid="resource-detail-absent-fields"
                class="space-y-1"
            >
                <h2 class="text-base font-medium">{{ t("resources.detail.absent.title") }}</h2>
                <p class="text-sm leading-relaxed text-muted-foreground">
                    {{ t("resources.detail.absent.body") }}
                </p>
                <ul class="flex flex-wrap gap-1 text-xs">
                    <li
                        v-for="key in model.fields.absentKeyList"
                        :key="key"
                        data-testid="resource-detail-absent-field"
                        class="rounded-full border border-dashed px-2 py-0.5 text-muted-foreground"
                    >
                        {{ t(key) }}
                    </li>
                </ul>
            </section>

            <section v-if="model.blockText" data-testid="resource-detail-block" class="space-y-1">
                <h2 class="text-base font-medium">
                    {{ model.blockTitleKey ? t(model.blockTitleKey) : "" }}
                </h2>
                <pre
                    class="max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap"
                    >{{ model.blockText }}</pre>
            </section>

            <section
                v-for="section in model.sections"
                :key="section.titleKey"
                :data-testid="`resource-detail-section-${section.titleKey.split('.').slice(-1)[0]}`"
                class="space-y-1"
            >
                <h2 class="text-base font-medium">{{ t(section.titleKey) }}</h2>
                <p v-if="!section.items.length" class="text-sm text-muted-foreground">
                    {{ t(section.emptyKey) }}
                </p>
                <ul v-else class="divide-y divide-border rounded-md border text-sm">
                    <li
                        v-for="(item, index) in section.items"
                        :key="`${section.titleKey}-${index}`"
                        class="px-3 py-2"
                    >
                        <div class="font-medium break-words">{{ item.name }}</div>
                        <div class="text-xs text-muted-foreground break-words">
                            {{ item.meta.join(" · ") }}
                        </div>
                    </li>
                </ul>
            </section>

            <p
                v-if="model.noteKey"
                data-testid="resource-detail-note"
                class="text-sm leading-relaxed text-muted-foreground"
            >
                {{ t(model.noteKey) }}
            </p>
        </div>
    </section>
</template>
