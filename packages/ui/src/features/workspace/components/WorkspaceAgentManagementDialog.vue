<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import BaseModal from "../../../components/shared/BaseModal.vue";
import { useAuthStore } from "../../../stores/auth";
import {
    ApiError,
    api,
    type AgentModelRef,
    type AgentPrincipalCreateResponse,
    type AgentPrincipalScope,
    type AgentTemplateSummary,
    type SelfPermissionsView,
    type WorkspaceAgentBinding,
    type WorkspaceAgentPermission,
} from "../../../composables/api";

const props = defineProps<{
    open: boolean;
    workspaceId: string;
}>();

const emit = defineEmits<{
    close: [];
}>();

const { t } = useI18n();
const authStore = useAuthStore(),
    actionClasses = ["read", "write", "delete", "exec", "network", "credential"] as const;
const agents = ref<WorkspaceAgentBinding[]>([]);
const templates = ref<Array<{ layer: string; template: AgentTemplateSummary }>>([]),
    loading = ref(false);
const saving = ref(false),
    error = ref(""),
    status = ref(""),
    name = ref(""),
    templateId = ref("");
const createdPrincipal = ref<AgentPrincipalCreateResponse | null>(null);
const permissions = ref<WorkspaceAgentPermission[]>([]),
    editingPrincipalId = ref<string | null>(null);
const unbindConfirmationId = ref<string | null>(null);
const disableConfirmationId = ref<string | null>(null);
/**
 * PLAN-0622：写操作的可用性**只看 CP 权威能力投影** `GET /me/permissions` 的原子：
 * - `CREATE_OWN_AGENT`（user 层）→ 能建 PERSONAL；
 * - `MANAGE_WORKSPACE_AGENTS`（workspace 层、resource=本工作区 UUID）→ 能建 WORKSPACE / 绑定 / 禁用；
 * - `CREATE_ACCOUNT`（instance 层、resource `*`）→ 能建 INSTANCE。
 *
 * `capabilityState`：`loading` 时按钮保持禁用（fail-closed），`failed` 时同样禁用并显示原因——
 * 绝不出现"点了才发现没权限"。
 */
const capabilityState = ref<"loading" | "ready" | "failed">("loading");
const instanceAtoms = ref<string[]>([]);
const workspaceAtoms = ref<string[]>([]);

const SCOPE_ORDER: AgentPrincipalScope[] = ["PERSONAL", "WORKSPACE", "INSTANCE"];
// Lead 术语对账（2026-11-02）：UI 里 `scope` 已被"连接作用域"占用，agent 侧文案必须自带
// `agent` 限定，且 key 不复用 `scopeUserTitle`/`scopeWorkspaceTitle`。
const scopeLabels: Record<AgentPrincipalScope, string> = {
    PERSONAL: "workspace.agentScopePersonalTitle",
    WORKSPACE: "workspace.agentScopeWorkspaceTitle",
    INSTANCE: "workspace.agentScopeInstanceTitle",
};
const scopeHintKeys: Record<AgentPrincipalScope, string> = {
    PERSONAL: "workspace.agentScopeHintPersonal",
    WORKSPACE: "workspace.agentScopeHintWorkspace",
    INSTANCE: "workspace.agentScopeHintInstance",
};

function scopeRequiredAtom(scope: AgentPrincipalScope): string | null {
    if (scope === "PERSONAL") return "CREATE_OWN_AGENT";
    if (scope === "WORKSPACE") return "MANAGE_WORKSPACE_AGENTS";
    return "CREATE_ACCOUNT";
}

/** 单个 scope 是否可用；`null` = 投影还没回来（未知）。 */
function scopeAvailability(scope: AgentPrincipalScope): boolean | null {
    if (capabilityState.value === "loading") return null;
    if (capabilityState.value === "failed") return false;
    const atom = scopeRequiredAtom(scope);
    if (!atom) return false;
    if (scope === "WORKSPACE") return workspaceAtoms.value.includes(atom);
    return instanceAtoms.value.includes(atom);
}

const availableScopes = computed(() =>
    SCOPE_ORDER.filter((scope) => scopeAvailability(scope) === true),
);

/** 创建入口是否可用：`null` = 未知（禁用但不算"无权限"）。 */
const canCreatePrincipal = computed<boolean | null>(() => {
    if (capabilityState.value === "loading") return null;
    if (capabilityState.value === "failed") return false;
    return availableScopes.value.length > 0;
});

/** 绑定 / 编辑 cap / 禁用都需要工作区级 MANAGE_WORKSPACE_AGENTS（个人 agent 的属主另论）。 */
const canManageWorkspaceAgents = computed<boolean | null>(() => {
    if (capabilityState.value === "loading") return null;
    if (capabilityState.value === "failed") return false;
    return workspaceAtoms.value.includes("MANAGE_WORKSPACE_AGENTS");
});

const selectedScope = ref<AgentPrincipalScope | null>(null);
const defaultModelProvider = ref("");
const defaultModelName = ref("");
const allowedModels = ref<AgentModelRef[]>([]);

/** 允许模型集校验：两项都填、且 (provider, model) 不重复。 */
const allowedModelsError = computed(() => {
    const seen = new Set<string>();
    for (const entry of allowedModels.value) {
        const provider = entry.provider.trim(),
            model = entry.model.trim();
        if (!provider || !model) return t("workspace.agentAllowedModelsIncomplete");
        const key = `${provider}::${model}`;
        if (seen.has(key)) return t("workspace.agentAllowedModelsDuplicate");
        seen.add(key);
    }
    return "";
});

/** 默认模型：要么两项都填，要么都留空（只填一半是配置错误）。 */
const defaultModelError = computed(() => {
    const provider = defaultModelProvider.value.trim(),
        model = defaultModelName.value.trim();
    if (provider === model) return ""; // 都空 / 都非空且相等都是合法态
    if (!provider || !model) return t("workspace.agentDefaultModelIncomplete");
    return "";
});

const createBlocked = computed(
    () =>
        !name.value.trim() ||
        saving.value ||
        !!createdPrincipal.value ||
        canCreatePrincipal.value !== true ||
        !selectedScope.value ||
        !!allowedModelsError.value ||
        !!defaultModelError.value,
);

watch(
    () => props.open,
    (open) => {
        if (open) {
            void loadAgents();
            void loadTemplates();
            void loadCreateCapability();
        }
    },
);

watch(availableScopes, (scopes) => {
    if (scopes.length === 0) {
        selectedScope.value = null;
        return;
    }
    if (!selectedScope.value || !scopes.includes(selectedScope.value)) {
        selectedScope.value = scopes[0];
    }
});

async function loadCreateCapability() {
    capabilityState.value = "loading";
    try {
        const self: SelfPermissionsView = await api.getSelfPermissions();
        instanceAtoms.value = (self.instancePermissions ?? []).map((atom) => atom.actionClass);
        // 实例 `*` 级原子同时覆盖所有工作区（管理员）。
        const workspace = (self.workspaces ?? []).find(
            (item) => item.workspaceId === props.workspaceId,
        );
        const scoped = (workspace?.permissions ?? []).map((atom) => atom.actionClass),
            hasWildcard = (self.instancePermissions ?? []).some((atom) => atom.resource === "*");
        workspaceAtoms.value = scoped.length > 0 ? scoped : hasWildcard ? instanceAtoms.value : [];
        capabilityState.value = "ready";
    } catch (cause) {
        // 投影拿不到就 fail-closed，并保留原因（不静默）。
        capabilityState.value = "failed";
        error.value = cause instanceof ApiError ? cause.message : t("workspace.agentLoadFailed");
    }
}

/** 列表行上的来源标签（本工作区/个人/实例）。 */
function agentSourceLabel(agent: WorkspaceAgentBinding): string {
    const source = agent.source;
    return t(`workspace.agentSource${source[0].toUpperCase()}${source.slice(1)}`);
}

function agentDefaultModel(agent: WorkspaceAgentBinding): string {
    const provider = agent.defaultModelProvider,
        model = agent.defaultModelName;
    if (!provider && !model) return "";
    return `${provider ?? "—"} / ${model ?? "—"}`;
}

/** 个人 agent 的属主本人可以自己禁用；其余行需要工作区级 MANAGE_WORKSPACE_AGENTS。 */
function canDisable(agent: WorkspaceAgentBinding): boolean {
    if (canManageWorkspaceAgents.value === null) return false;
    if (canManageWorkspaceAgents.value) return true;
    if (agent.source !== "personal") return false;
    return Boolean(agent.ownerUserId) && agent.ownerUserId === authStore.user?.id;
}

function addAllowedModel() {
    allowedModels.value = [...allowedModels.value, { provider: "", model: "" }];
}

function removeAllowedModel(index: number) {
    allowedModels.value = allowedModels.value.filter((_, current) => current !== index);
}

function setAllowedModel(index: number, field: "provider" | "model", value: string) {
    allowedModels.value = allowedModels.value.map((entry, current) =>
        current === index ? { ...entry, [field]: value } : entry,
    );
}

async function loadAgents() {
    loading.value = true;
    error.value = "";
    status.value = "";
    try {
        agents.value = await api.getWorkspaceAgents(props.workspaceId);
    } catch (cause) {
        error.value = cause instanceof ApiError ? cause.message : t("workspace.agentLoadFailed");
    } finally {
        loading.value = false;
    }
}

async function loadTemplates() {
    templates.value = [];
    try {
        const layers = authStore.isAdmin
            ? (["instance", "user", "workspace"] as const)
            : (["user", "workspace"] as const);
        const results = await Promise.all(
            layers.map((layer) => api.getAgentTemplates(layer, props.workspaceId)),
        );
        templates.value = results.flatMap((result) =>
            result.templates.map((template) => ({ layer: result.layer, template })),
        );
    } catch (cause) {
        error.value =
            cause instanceof ApiError ? cause.message : t("workspace.agentTemplateLoadFailed");
    }
}

function actionLabel(actionClass: string): string {
    const key = `workspace.agentAction${actionClass[0]?.toUpperCase()}${actionClass.slice(1)}`;
    const label = t(key);
    return label === key ? actionClass : label;
}

function hasPermission(actionClass: string): boolean {
    return permissions.value.some((permission) => permission.actionClass === actionClass);
}

function permissionResource(actionClass: string): string {
    return (
        permissions.value.find((permission) => permission.actionClass === actionClass)?.resource ??
        "*"
    );
}

function togglePermission(actionClass: string, checked: boolean) {
    const current = permissions.value.filter(
        (permission) => permission.actionClass !== actionClass,
    );
    if (checked) current.push({ actionClass, resource: "*" });
    permissions.value = current;
}

function setPermissionResource(actionClass: string, resource: string) {
    permissions.value = permissions.value.map((permission) =>
        permission.actionClass === actionClass
            ? { ...permission, resource: resource.trim() || "*" }
            : permission,
    );
}

/**
 * PLAN-0585 M2 / F-02: a missing grant must read as an actionable localized hint that points at
 * the admin grant panel, never as the CP's raw English detail (`CREATE_ACCOUNT permission is
 * required`).
 */
function agentErrorMessage(cause: unknown, forbiddenKey: string, fallbackKey: string): string {
    if (cause instanceof ApiError && cause.problem.code === "FORBIDDEN") {
        return t(forbiddenKey);
    }
    return t(fallbackKey);
}

async function createPrincipal() {
    if (createBlocked.value) return;
    saving.value = true;
    error.value = "";
    try {
        const allowed = allowedModels.value
            .map((entry) => ({ provider: entry.provider.trim(), model: entry.model.trim() }))
            .filter((entry) => entry.provider && entry.model);
        createdPrincipal.value = await api.createAgentPrincipal({
            name: name.value.trim(),
            ...(templateId.value ? { templateId: templateId.value } : {}),
            ...(selectedScope.value ? { scope: selectedScope.value } : {}),
            ...(defaultModelProvider.value.trim()
                ? { defaultModelProvider: defaultModelProvider.value.trim() }
                : {}),
            ...(defaultModelName.value.trim()
                ? { defaultModelName: defaultModelName.value.trim() }
                : {}),
            ...(allowed.length > 0 ? { allowedModels: allowed } : {}),
        });
        name.value = "";
        templateId.value = "";
        defaultModelProvider.value = "";
        defaultModelName.value = "";
        allowedModels.value = [];
        permissions.value = [];
        status.value = t("workspace.agentPrincipalCreated");
    } catch (cause) {
        error.value = agentErrorMessage(
            cause,
            "workspace.agentCreateForbidden",
            "workspace.agentCreateFailed",
        );
    } finally {
        saving.value = false;
    }
}

/** PLAN-0622：禁用是两步确认（第一步只换文案），并要求调用方先看清后果。 */
async function disableAgent(agent: WorkspaceAgentBinding) {
    if (!canDisable(agent) || saving.value) return;
    if (disableConfirmationId.value !== agent.principalId) {
        disableConfirmationId.value = agent.principalId;
        unbindConfirmationId.value = null;
        return;
    }
    saving.value = true;
    error.value = "";
    try {
        await api.disableAgentPrincipal(agent.principalId);
        disableConfirmationId.value = null;
        await loadAgents();
        status.value = t("workspace.agentDisabledSuccess");
    } catch (cause) {
        error.value = agentErrorMessage(
            cause,
            "workspace.agentDisableForbidden",
            "workspace.agentDisableFailed",
        );
    } finally {
        saving.value = false;
    }
}

async function bindCreatedPrincipal() {
    const principal = createdPrincipal.value;
    if (!principal || saving.value) return;
    saving.value = true;
    error.value = "";
    try {
        await api.updateWorkspaceAgentCap(
            props.workspaceId,
            principal.principalId,
            permissions.value,
        );
        createdPrincipal.value = null;
        permissions.value = [];
        await loadAgents();
        status.value = t("workspace.agentBound");
    } catch (cause) {
        error.value = agentErrorMessage(
            cause,
            "workspace.agentBindForbidden",
            "workspace.agentBindFailed",
        );
    } finally {
        saving.value = false;
    }
}

function startEditing(agent: WorkspaceAgentBinding) {
    editingPrincipalId.value = agent.principalId;
    permissions.value = agent.permissionsSnapshot.map((permission) => ({ ...permission }));
    error.value = "";
}

async function saveCap(agent: WorkspaceAgentBinding) {
    if (saving.value) return;
    saving.value = true;
    error.value = "";
    try {
        await api.updateWorkspaceAgentCap(props.workspaceId, agent.principalId, permissions.value);
        editingPrincipalId.value = null;
        await loadAgents();
        status.value = t("workspace.agentCapSaved");
    } catch (cause) {
        error.value = cause instanceof ApiError ? cause.message : t("workspace.agentSaveFailed");
    } finally {
        saving.value = false;
    }
}

async function unbind(agent: WorkspaceAgentBinding) {
    if (unbindConfirmationId.value !== agent.principalId || saving.value) {
        unbindConfirmationId.value = agent.principalId;
        return;
    }
    saving.value = true;
    error.value = "";
    try {
        await api.deleteWorkspaceAgent(props.workspaceId, agent.principalId);
        unbindConfirmationId.value = null;
        await loadAgents();
        status.value = t("workspace.agentUnboundSuccess");
    } catch (cause) {
        error.value = cause instanceof ApiError ? cause.message : t("workspace.agentUnbindFailed");
    } finally {
        saving.value = false;
    }
}
</script>

<template>
    <BaseModal :show="open" :title="t('workspace.agentManagement')" @close="emit('close')">
        <div
            class="max-h-[72vh] space-y-5 overflow-y-auto pr-1"
            data-testid="workspace-agent-management-dialog"
        >
            <p class="text-sm text-muted-foreground">
                {{ t("workspace.agentManagementDescription") }}
            </p>

            <form
                class="space-y-3 rounded-lg border p-3"
                data-testid="agent-principal-create-form"
                @submit.prevent="createPrincipal"
            >
                <div>
                    <h3 class="text-sm font-semibold">{{ t("workspace.createAgentPrincipal") }}</h3>
                    <p class="mt-1 text-xs text-muted-foreground">
                        {{ t("workspace.agentCreatePermissionNote") }}
                    </p>
                    <!-- PLAN-0610 W5c: the principal-grant page is retired. Granting
                         CREATE_ACCOUNT / MANAGE_WORKSPACE_AGENTS now means binding a role that carries
                         those atoms, so the affordance points at the role/binding surface (F-02: an
                         admin must never hit a dead end).
                         PLAN-0621 F-01：没有 CREATE_ACCOUNT 的普通用户同样要看到这条路（原先只有
                         admin 能看到链接），并且创建按钮在**点击之前**就禁用——不要让人点完才吃 403。 -->
                    <router-link
                        v-if="authStore.isAdmin || canCreatePrincipal === false"
                        to="/settings/roles"
                        data-testid="agent-grant-panel-link"
                        class="mt-1 inline-block text-xs text-primary underline"
                    >
                        {{ t("workspace.agentGrantPanelLink") }}
                    </router-link>
                    <p
                        v-if="canCreatePrincipal === false"
                        data-testid="agent-create-forbidden-hint"
                        class="mt-1 text-xs text-muted-foreground"
                    >
                        {{ t("workspace.agentCreateForbidden") }}
                    </p>
                </div>
                <label class="block space-y-1 text-sm">
                    <span>{{ t("workspace.agentName") }}</span>
                    <input
                        v-model="name"
                        required
                        maxlength="120"
                        data-testid="agent-principal-name"
                        class="w-full rounded-md border bg-background px-3 py-2"
                    />
                </label>
                <label class="block space-y-1 text-sm">
                    <span>{{ t("workspace.agentTemplateChoice") }}</span>
                    <select
                        v-model="templateId"
                        data-testid="agent-principal-template"
                        class="w-full rounded-md border bg-background px-3 py-2"
                    >
                        <option value="">{{ t("workspace.defaultAgentTemplate") }}</option>
                        <option
                            v-for="item in templates"
                            :key="`${item.layer}:${item.template.id}`"
                            :value="item.template.id"
                        >
                            {{ item.template.name }} · {{ item.layer }}
                        </option>
                    </select>
                    <span v-if="templateId" class="block text-xs text-muted-foreground">
                        {{
                            templates.find((item) => item.template.id === templateId)?.template
                                .roleId ?? t("workspace.defaultAgentTemplate")
                        }}
                        ·
                        {{
                            templates.find((item) => item.template.id === templateId)?.template
                                .toolMode
                        }}
                        ·
                        {{
                            templates.find((item) => item.template.id === templateId)?.template
                                .provider ?? t("settings.notSet")
                        }}
                        /
                        {{
                            templates.find((item) => item.template.id === templateId)?.template
                                .model ?? t("settings.notSet")
                        }}
                    </span>
                </label>
                <label class="block space-y-1 text-sm">
                    <span>{{ t("workspace.agentScopeTitle") }}</span>
                    <!-- PLAN-0622：scope 按 CP 能力投影显隐（4 态：personal/workspace/instance/都不可用）。 -->
                    <select
                        v-if="availableScopes.length > 0"
                        v-model="selectedScope"
                        data-testid="agent-principal-scope"
                        class="w-full rounded-md border bg-background px-3 py-2"
                    >
                        <option v-for="scope in availableScopes" :key="scope" :value="scope">
                            {{ t(scopeLabels[scope]) }}
                        </option>
                    </select>
                    <p
                        v-else
                        data-testid="agent-scope-unavailable"
                        class="text-xs text-muted-foreground"
                    >
                        {{
                            capabilityState === "loading"
                                ? t("workspace.agentScopeLoading")
                                : t("workspace.agentScopeNone")
                        }}
                    </p>
                    <span v-if="selectedScope" class="block text-xs text-muted-foreground">
                        {{ t(scopeHintKeys[selectedScope]) }}
                    </span>
                </label>
                <div class="grid grid-cols-2 gap-2">
                    <label class="block space-y-1 text-sm">
                        <span>{{ t("workspace.agentDefaultModelProvider") }}</span>
                        <input
                            v-model="defaultModelProvider"
                            data-testid="agent-default-model-provider"
                            :placeholder="t('workspace.agentModelProviderPlaceholder')"
                            class="w-full rounded-md border bg-background px-3 py-2"
                        />
                    </label>
                    <label class="block space-y-1 text-sm">
                        <span>{{ t("workspace.agentDefaultModelName") }}</span>
                        <input
                            v-model="defaultModelName"
                            data-testid="agent-default-model-name"
                            :placeholder="t('workspace.agentModelNamePlaceholder')"
                            class="w-full rounded-md border bg-background px-3 py-2"
                        />
                    </label>
                </div>
                <p
                    v-if="defaultModelError"
                    data-testid="agent-default-model-error"
                    class="text-xs text-destructive"
                >
                    {{ defaultModelError }}
                </p>
                <div class="space-y-2">
                    <div class="flex items-center justify-between">
                        <span class="text-sm">{{ t("workspace.agentAllowedModels") }}</span>
                        <button
                            type="button"
                            data-testid="agent-allowed-model-add"
                            class="text-xs underline"
                            @click="addAllowedModel"
                        >
                            {{ t("workspace.agentAllowedModelAdd") }}
                        </button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        {{ t("workspace.agentAllowedModelsHint") }}
                    </p>
                    <div
                        v-for="(entry, index) in allowedModels"
                        :key="`allowed-${index}`"
                        class="grid grid-cols-[1fr_1fr_auto] items-center gap-2"
                    >
                        <input
                            :value="entry.provider"
                            :data-testid="`agent-allowed-model-provider-${index}`"
                            :placeholder="t('workspace.agentModelProviderPlaceholder')"
                            :aria-label="t('workspace.agentAllowedModelProviderAria')"
                            class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                            @input="
                                setAllowedModel(
                                    index,
                                    'provider',
                                    ($event.target as HTMLInputElement).value,
                                )
                            "
                        />
                        <input
                            :value="entry.model"
                            :data-testid="`agent-allowed-model-name-${index}`"
                            :placeholder="t('workspace.agentModelNamePlaceholder')"
                            :aria-label="t('workspace.agentAllowedModelNameAria')"
                            class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                            @input="
                                setAllowedModel(
                                    index,
                                    'model',
                                    ($event.target as HTMLInputElement).value,
                                )
                            "
                        />
                        <button
                            type="button"
                            :data-testid="`agent-allowed-model-remove-${index}`"
                            :aria-label="t('workspace.agentAllowedModelRemove')"
                            class="rounded-md border px-2 py-1 text-xs"
                            @click="removeAllowedModel(index)"
                        >
                            ×
                        </button>
                    </div>
                    <p
                        v-if="allowedModelsError"
                        data-testid="agent-allowed-model-error"
                        class="text-xs text-destructive"
                    >
                        {{ allowedModelsError }}
                    </p>
                </div>
                <button
                    type="submit"
                    data-testid="agent-principal-create"
                    class="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                    :disabled="createBlocked"
                >
                    {{ t("workspace.createAgentPrincipal") }}
                </button>
            </form>

            <section
                v-if="createdPrincipal"
                class="space-y-3 rounded-lg border border-amber-500/40 p-3"
                data-testid="unbound-agent-principal"
            >
                <div>
                    <h3 class="text-sm font-semibold">{{ t("workspace.agentCreatedUnbound") }}</h3>
                    <p class="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {{ createdPrincipal.principalId }}
                    </p>
                    <p class="mt-1 text-xs text-muted-foreground">
                        {{ createdPrincipal.templateName ?? t("workspace.defaultAgentTemplate") }} ·
                        {{ t("workspace.agentTemplateId") }}:
                        {{ createdPrincipal.templateId ?? "—" }} ·
                        {{ t("workspace.agentCreatedAt") }}:
                        {{ new Date(createdPrincipal.createdAt).toLocaleString() }}
                    </p>
                </div>
                <p class="text-xs text-muted-foreground">{{ t("workspace.agentCapNote") }}</p>
                <div class="space-y-2">
                    <div
                        v-for="actionClass in actionClasses"
                        :key="actionClass"
                        class="grid grid-cols-[1fr_1fr] items-center gap-2"
                    >
                        <label class="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                :checked="hasPermission(actionClass)"
                                :data-testid="`agent-cap-${actionClass}`"
                                @change="
                                    togglePermission(
                                        actionClass,
                                        ($event.target as HTMLInputElement).checked,
                                    )
                                "
                            />
                            {{ actionLabel(actionClass) }}
                        </label>
                        <input
                            v-if="hasPermission(actionClass)"
                            :value="permissionResource(actionClass)"
                            :data-testid="`agent-resource-${actionClass}`"
                            :aria-label="
                                t('workspace.agentResourceFor', {
                                    action: actionLabel(actionClass),
                                })
                            "
                            class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                            @input="
                                setPermissionResource(
                                    actionClass,
                                    ($event.target as HTMLInputElement).value,
                                )
                            "
                        />
                    </div>
                </div>
                <button
                    type="button"
                    data-testid="agent-principal-bind"
                    class="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                    :disabled="saving || canManageWorkspaceAgents !== true"
                    @click="bindCreatedPrincipal"
                >
                    {{ t("workspace.bindAgent") }}
                </button>
                <p
                    v-if="canManageWorkspaceAgents === false"
                    data-testid="agent-bind-forbidden-hint"
                    class="text-xs text-muted-foreground"
                >
                    {{ t("workspace.agentBindForbidden") }}
                </p>
            </section>

            <section class="space-y-3" aria-labelledby="workspace-agent-list-title">
                <div class="flex items-center justify-between">
                    <h3 id="workspace-agent-list-title" class="text-sm font-semibold">
                        {{ t("workspace.boundAgents") }}
                    </h3>
                    <button
                        type="button"
                        data-testid="workspace-agent-refresh"
                        class="text-xs text-muted-foreground underline"
                        :disabled="loading"
                        @click="loadAgents"
                    >
                        {{ t("workspace.refreshAgents") }}
                    </button>
                </div>
                <p v-if="loading" class="text-sm text-muted-foreground" role="status">
                    {{ t("workspace.loadingAgents") }}
                </p>
                <p
                    v-else-if="agents.length === 0"
                    class="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
                >
                    {{ t("workspace.noBoundAgent") }}
                </p>
                <article
                    v-for="agent in agents"
                    :key="agent.principalId"
                    class="space-y-3 rounded-lg border p-3"
                    :data-testid="`workspace-agent-${agent.principalId}`"
                >
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                            <h4 class="truncate text-sm font-semibold">{{ agent.name }}</h4>
                            <p class="mt-1 flex flex-wrap items-center gap-1.5">
                                <!-- PLAN-0622：来源与 scope 徽标（本工作区/个人/实例）。 -->
                                <span
                                    class="rounded border px-1.5 py-0.5 text-[11px]"
                                    :data-testid="`agent-scope-badge-${agent.principalId}`"
                                    :data-agent-scope="agent.source"
                                >
                                    {{ agentSourceLabel(agent) }}
                                </span>
                                <span
                                    v-if="agent.disabled"
                                    class="rounded border border-destructive/40 px-1.5 py-0.5 text-[11px] text-destructive"
                                    :data-testid="`agent-disabled-badge-${agent.principalId}`"
                                >
                                    {{ t("workspace.agentDisabledBadge") }}
                                </span>
                            </p>
                            <p
                                v-if="agentDefaultModel(agent)"
                                class="mt-1 text-xs text-muted-foreground"
                                :data-testid="`agent-default-model-${agent.principalId}`"
                            >
                                {{ t("workspace.agentDefaultModelLabel") }}:
                                {{ agentDefaultModel(agent) }}
                            </p>
                            <p class="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                                {{ agent.principalId }}
                            </p>
                            <p class="mt-1 text-xs text-muted-foreground">
                                {{ agent.templateName ?? t("workspace.defaultAgentTemplate") }} ·
                                {{ t("workspace.agentTemplateId") }}:
                                {{ agent.templateId ?? "—" }} ·
                                {{ t("workspace.agentWorkspaceId") }}: {{ workspaceId }} ·
                                {{ new Date(agent.createdAt).toLocaleString() }}
                            </p>
                        </div>
                        <div class="flex shrink-0 flex-col items-end gap-1">
                            <button
                                type="button"
                                class="rounded-md border px-2 py-1 text-xs"
                                :data-testid="`workspace-agent-unbind-${agent.principalId}`"
                                @click="unbind(agent)"
                            >
                                {{
                                    unbindConfirmationId === agent.principalId
                                        ? t("workspace.confirmAgentUnbind")
                                        : t("workspace.unbindAgent")
                                }}
                            </button>
                            <!-- PLAN-0622：禁用需二次确认；无权限/投影未就绪时**点击前**就禁用。 -->
                            <button
                                type="button"
                                class="rounded-md border px-2 py-1 text-xs text-destructive disabled:opacity-50"
                                :data-testid="`workspace-agent-disable-${agent.principalId}`"
                                :disabled="saving || !canDisable(agent) || agent.disabled === true"
                                @click="disableAgent(agent)"
                            >
                                {{
                                    disableConfirmationId === agent.principalId
                                        ? t("workspace.confirmAgentDisable")
                                        : t("workspace.disableAgent")
                                }}
                            </button>
                            <p class="max-w-[12rem] text-right text-[11px] text-muted-foreground">
                                {{ t("workspace.agentDisableConsequence") }}
                            </p>
                        </div>
                    </div>
                    <div
                        v-if="editingPrincipalId !== agent.principalId"
                        class="flex flex-wrap gap-1.5"
                        data-testid="workspace-agent-cap"
                    >
                        <span
                            v-for="permission in agent.permissionsSnapshot"
                            :key="`${permission.actionClass}:${permission.resource ?? '*'}`"
                            class="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                        >
                            {{ actionLabel(permission.actionClass) }} ·
                            {{ permission.resource ?? "*" }}
                        </span>
                        <span
                            v-if="agent.permissionsSnapshot.length === 0"
                            class="text-xs text-muted-foreground"
                        >
                            {{ t("workspace.noAgentCapabilities") }}
                        </span>
                        <button
                            type="button"
                            class="ml-auto text-xs underline"
                            :data-testid="`workspace-agent-edit-cap-${agent.principalId}`"
                            @click="startEditing(agent)"
                        >
                            {{ t("workspace.editAgentCap") }}
                        </button>
                    </div>
                    <div v-else class="space-y-2 border-t pt-3">
                        <div
                            v-for="actionClass in actionClasses"
                            :key="actionClass"
                            class="grid grid-cols-[1fr_1fr] items-center gap-2"
                        >
                            <label class="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    :checked="hasPermission(actionClass)"
                                    :data-testid="`agent-cap-${actionClass}`"
                                    @change="
                                        togglePermission(
                                            actionClass,
                                            ($event.target as HTMLInputElement).checked,
                                        )
                                    "
                                />
                                {{ actionLabel(actionClass) }}
                            </label>
                            <input
                                v-if="hasPermission(actionClass)"
                                :value="permissionResource(actionClass)"
                                :data-testid="`agent-resource-${actionClass}`"
                                :aria-label="
                                    t('workspace.agentResourceFor', {
                                        action: actionLabel(actionClass),
                                    })
                                "
                                class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                                @input="
                                    setPermissionResource(
                                        actionClass,
                                        ($event.target as HTMLInputElement).value,
                                    )
                                "
                            />
                        </div>
                        <div class="flex justify-end gap-2">
                            <button
                                type="button"
                                class="rounded-md border px-2 py-1 text-xs"
                                @click="editingPrincipalId = null"
                            >
                                {{ t("workspace.cancel") }}
                            </button>
                            <button
                                type="button"
                                :data-testid="`workspace-agent-save-cap-${agent.principalId}`"
                                class="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground"
                                :disabled="saving || canManageWorkspaceAgents !== true"
                                @click="saveCap(agent)"
                            >
                                {{ t("workspace.saveAgentCap") }}
                            </button>
                        </div>
                    </div>
                </article>
            </section>

            <p
                v-if="error"
                role="alert"
                data-testid="agent-error"
                class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
            >
                {{ error }}
            </p>
            <p v-if="status" role="status" class="text-sm text-emerald-700 dark:text-emerald-300">
                {{ status }}
            </p>
        </div>
    </BaseModal>
</template>
