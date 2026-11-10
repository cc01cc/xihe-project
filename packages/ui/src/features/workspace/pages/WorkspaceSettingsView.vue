<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { LoaderCircle } from "@lucide/vue";
import { useAuthStore } from "../../../stores/auth";
import { useConfigStore, type ConfigDomain } from "../../../stores/config";
import { useSessionStore } from "../../../stores/session";
import { api, ApiError } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { clearTabWorkspace, writeTabWorkspace } from "../../../lib/workspaceContext";
import { workspacePath } from "../../../lib/routes";
import ConfigLayerPanels from "../../../components/settings/ConfigLayerPanels.vue";
import SettingsLayerHeader from "../../../components/settings/SettingsLayerHeader.vue";
import WorkspaceMcpPanel from "../components/WorkspaceMcpPanel.vue";
import WorkspaceMembersPanel from "../components/WorkspaceMembersPanel.vue";
import CredentialsPanel from "../../../components/settings/credentials/CredentialsPanel.vue";
import KnowledgeBaseView from "../../../views/settings/KnowledgeBaseView.vue";
import SettingsNotFoundView from "../../../views/settings/SettingsNotFoundView.vue";
import ToolFacesView from "../../../views/settings/ToolFacesView.vue";
import { DOMAIN_LABEL_KEY, domainsForLayer } from "../../../lib/settingsIa";
import Input from "../../../components/ui/input/Input.vue";
import { Button } from "../../../components/ui/button";
import AlertDialog from "../../../components/ui/alert-dialog/AlertDialog.vue";
import AlertDialogContent from "../../../components/ui/alert-dialog/AlertDialogContent.vue";
import AlertDialogHeader from "../../../components/ui/alert-dialog/AlertDialogHeader.vue";
import AlertDialogTitle from "../../../components/ui/alert-dialog/AlertDialogTitle.vue";
import AlertDialogDescription from "../../../components/ui/alert-dialog/AlertDialogDescription.vue";
import AlertDialogFooter from "../../../components/ui/alert-dialog/AlertDialogFooter.vue";
import AlertDialogCancel from "../../../components/ui/alert-dialog/AlertDialogCancel.vue";

// PLAN-0560：每工作区设置页（常规/配置/MCP）。配置区复用 ConfigLayerPanels
// （layer=workspace），MCP 复用 WorkspaceMcpPanel；常规区 OWNER 可编辑/删除（T2.6）。
// PLAN-0565：新增「成员」tab（裁定 #2——EDITOR 只读可见、VIEWER 不渲染）。
// PLAN-0752 T4.2/T4.3：工作区层的资源入口按 tab 承载 —— MCP（绑定/启用）、凭据（归属本工作区）、
// 知识库（按工作区分区的文档）。三者后端都已实现，所以都是**真入口**，不是缺口位；实例/用户层
// 没有对应承载才在外层左栏标 G2/G3（D7 口径：只给真缺的能力标缺口）。
type SettingsTab = "general" | "config" | "mcp" | "members" | "credentials" | "knowledge";

const route = useRoute(),
    router = useRouter(),
    auth = useAuthStore(),
    configStore = useConfigStore(),
    sessionStore = useSessionStore(),
    { t } = useI18n();

const workspaceId = computed(() => String(route.params.workspaceId ?? "").trim());

/**
 * PLAN-0752 M1：工作区层也进域段（/workspace/:id/settings/:domain）。工作区层矩阵是 9 域
 * （logging 只有实例层），不在矩阵里的 :domain 直链 ⇒ 404 视图（V3/V25），而不是静默忽略。
 */
const domainParam = computed(() => {
    const value = route.params.domain;
    return typeof value === "string" ? value : "";
});
const domainInvalid = computed(
    () =>
        domainParam.value !== "" &&
        !domainsForLayer("workspace").includes(domainParam.value as ConfigDomain),
);

/**
 * PLAN-0752 M2 B4：带域段时按**单域**渲染（与实例/用户层域页同构：域标题 18px + 该域面板），
 * 不再把「整个工作区层 9 域」平铺在 tab 里。可写域白名单仍是 `domainsForLayer("workspace")`
 * 的 9 域 —— 矩阵口径：approval-policy / job-policy 在工作区层可写，logging 不在该层（域段直接 404）。
 */
const domainLabel = computed(() =>
    domainParam.value ? t(DOMAIN_LABEL_KEY[domainParam.value as ConfigDomain]) : "",
);
const domainKeyCount = computed(() =>
    domainParam.value
        ? Object.keys(configStore.layerConfig.workspace?.[domainParam.value as ConfigDomain] ?? {})
              .length
        : 0,
);

const initialTab = ((): SettingsTab => {
    const q = route.query.tab;
    return q === "config" ||
        q === "mcp" ||
        q === "members" ||
        q === "credentials" ||
        q === "knowledge" ||
        q === "general"
        ? q
        : "general";
})();
const activeTab = ref<SettingsTab>(initialTab);

/**
 * G9（PLAN-0752 / task-153）：工作区层也挂出「工具分类」入口。
 *
 * <p>**缺口**：工具分类的唯一挂载点是 approval-policy 域页内的页签，而旧判据只认实例层
 * （`SettingsDomainView.vue:89-94` 的 `toolFacesTab` 限定 layer === "instance"）⇒
 * **工作区 OWNER 能改却点不到**，能点到的实例 ADMIN 又不以工作区口径改。</p>
 *
 * <p>**不动后端**：`POST /api/v1/policy/tool-faces` 只校验已登录
 * （`PolicyController.java:71-83`），scope 语义在 `ToolFaceService.java:149-169` ——
 * workspace scope 写入要求 workspace OWNER 或实例 ADMIN，读取只要求带工作区上下文
 * （`ownerFor(..., requireOwner=false)`）。</p>
 *
 * <p>**权限面按能力求值，不按角色名特判**：页签对「能进入该域页的成员」可见；能否分类由
 * `useAuthStore().canClassifyTools`（实例 admin 或工作区 OWNER，`stores/auth.ts:213-216`）
 * 在 `ToolFacesView` 内部求值 ⇒ 非 OWNER 看到只读列表（`settings-tool-faces-forbidden`
 * 信息条 + 无分类按钮），与「工作区设置页对非写角色只读」的既有语义一致。</p>
 */
const toolFacesTab = computed(() => domainParam.value === "approval-policy");
const activeDomainTab = ref<"policy" | "tool-faces">("policy");

function syncDomainTab(): void {
    activeDomainTab.value =
        toolFacesTab.value && route.query.tab === "tool-faces" ? "tool-faces" : "policy";
}
syncDomainTab();
// `?tab=` 只表达**域内视图**（同实例层口径 `SettingsDomainView.vue:97-112`），层仍在 URL 域段里。
watch(() => [route.query.tab, toolFacesTab.value] as const, syncDomainTab);

function selectDomainTab(tab: "policy" | "tool-faces"): void {
    activeDomainTab.value = tab;
    void router.replace({
        query: { ...route.query, tab: tab === "tool-faces" ? "tool-faces" : undefined },
    });
}

const tabs = computed<{ key: SettingsTab; label: string }[]>(() => {
    const base: { key: SettingsTab; label: string }[] = [
        { key: "general", label: t("workspace.settingsTabGeneral") },
        { key: "config", label: t("workspace.settingsTabConfig") },
    ];
    // BL-344：`canViewMembers` 是三态 —— 未知（`undefined`）时**保留**成员 tab，
    // 只有确定无权（`false`）才隐藏；否则能力位一抖动 tab 就会消失再回来。
    if (auth.canViewMembers !== false) {
        base.push({ key: "members", label: t("workspace.settingsTabMembers") });
    }
    base.push({ key: "mcp", label: t("workspace.settingsTabMcp") });
    base.push({ key: "credentials", label: t("workspace.settingsTabCredentials") });
    base.push({ key: "knowledge", label: t("workspace.settingsTabKnowledge") });
    return base;
});

// PLAN-0565: VIEWER 若直接落在已隐藏的成员 tab（含 ?tab=members 直链与载入后
// 角色刷新），回退到常规 tab；载入前 workspaceRole 为空视为可见，由面板自行处理 403。
// BL-344：回退判据从 `!visible` 收紧为 `visible === false` —— 未知不回落（否则面板
// 会被卸载重挂，`addUsername` 里用户已经输入的内容会丢）。
watch(
    () => auth.canViewMembers,
    (visible) => {
        if (visible === false && activeTab.value === "members") activeTab.value = "general";
    },
    { immediate: true },
);

const loadError = ref(""),
    loading = ref(false),
    configLoaded = ref(false);

async function loadConfig() {
    if (configLoaded.value || !workspaceId.value) return;
    try {
        await configStore.loadLayerDomains("workspace", workspaceId.value);
        configLoaded.value = true;
    } catch (e) {
        logger.warn("Failed to load workspace config domains", e);
        toast.error(t("workspace.settingsLoadFailed"));
    }
}

function switchTab(tab: SettingsTab) {
    if (activeTab.value === tab) return;
    activeTab.value = tab;
    if (tab === "config") void loadConfig();
}

/** 域段模式下「切到配置总览」= 回到不带域段的旧入口（保留 tab 形态）。 */
function goConfigOverview() {
    if (!workspaceId.value) return;
    void router.push({
        name: "workspace-settings",
        params: { workspaceId: workspaceId.value },
        query: { tab: "config" },
    });
}

// T3.7 头部动作组：新建对话复用 ?newChat=1 语义（Sidebar.startNewChat 同口径）。
function newChat() {
    if (!workspaceId.value) return;
    void router.push({ path: workspacePath(workspaceId.value), query: { newChat: "1" } });
}

function goEnvironment() {
    if (!workspaceId.value) return;
    void router.push({
        name: "workspace-environment",
        params: { workspaceId: workspaceId.value },
    });
}

function goBackToWorkspace() {
    if (!workspaceId.value) return;
    void router.push(workspacePath(workspaceId.value));
}

async function loadWorkspace() {
    if (!workspaceId.value) {
        await router.replace({ name: "workspace-home" });
        return;
    }
    loading.value = true;
    loadError.value = "";
    try {
        await auth.selectWorkspace(workspaceId.value);
    } catch (cause) {
        const code = cause instanceof ApiError ? cause.problem.code : "";
        if (code === "WORKSPACE_FORBIDDEN" || code === "WORKSPACE_NOT_FOUND") {
            await router.replace({ name: "workspace-home" });
            return;
        }
        const message = cause instanceof Error ? cause.message : t("workspace.settingsLoadFailed");
        logger.error("Load workspace failed", cause);
        loadError.value = message;
        toast.error(message);
        return;
    } finally {
        loading.value = false;
    }
    // 域段模式（/workspace/:id/settings/:domain）不经过 tab，同样要装载该层 9 域配置；
    // 但矩阵里不存在的域段（如 logging）先 404，不该顺带发一整层配置请求（V4 同口径）。
    if (activeTab.value === "config" || (domainParam.value !== "" && !domainInvalid.value)) {
        await loadConfig();
    }
}

async function retryLoad() {
    await loadWorkspace();
}

// T2.6 常规编辑（OWNER）
const editName = ref(""),
    editDescription = ref(""),
    saving = ref(false),
    editError = ref("");

function startEdit() {
    editName.value = auth.workspace?.name ?? "";
    editDescription.value = auth.workspace?.description ?? "";
    editError.value = "";
}

async function handleSave() {
    const ws = auth.workspace;
    if (!ws || saving.value) return;
    saving.value = true;
    editError.value = "";
    try {
        const updated = await api.updateWorkspace(ws.id, {
            name: editName.value.trim() || undefined,
            description: editDescription.value.trim(),
        });
        auth.workspace = updated;
        writeTabWorkspace(updated);
        toast.success(t("workspace.settingsUpdated"));
    } catch (cause) {
        const message =
            cause instanceof ApiError ? cause.message : t("workspace.settingsSaveFailed");
        logger.error("Update workspace failed", cause);
        editError.value = message;
        toast.error(message);
    } finally {
        saving.value = false;
    }
}

// T2.6 删除（OWNER）：逻辑删除 + 名称确认，成功后回 workspace-home。
const confirmDeleteOpen = ref(false),
    deleteConfirmName = ref(""),
    deleting = ref(false),
    deleteError = ref("");

async function handleDelete() {
    const ws = auth.workspace;
    if (!ws || deleting.value) return;
    if (deleteConfirmName.value.trim() !== (ws.name ?? "")) {
        deleteError.value = t("workspace.settingsDeleteNameMismatch");
        return;
    }
    deleting.value = true;
    deleteError.value = "";
    try {
        await api.deleteWorkspace(ws.id);
        auth.workspace = null;
        clearTabWorkspace();
        confirmDeleteOpen.value = false;
        toast.success(t("workspace.settingsDeleted", { name: ws.name }));
        sessionStore.resetForUserSwitch();
        await router.replace({ name: "workspace-home" });
    } catch (cause) {
        const message =
            cause instanceof ApiError ? cause.message : t("workspace.settingsDeleteFailed");
        logger.error("Delete workspace failed", cause);
        deleteError.value = message;
        toast.error(message);
    } finally {
        deleting.value = false;
    }
}

onMounted(() => {
    startEdit();
    void loadWorkspace();
});
</script>

<template>
    <SettingsNotFoundView v-if="domainInvalid" />
    <section v-else class="min-h-full" data-testid="workspace-settings-page">
        <!-- 域段模式（PLAN-0752 M2 B4）：/workspace/:id/settings/:domain 只渲染该域。
             T1.1b（task-179 案A 裁定）：层头归一到 SettingsLayerHeader —— 面包屑
             「设置 › 工作区层 › {域}」+ text-2xl 层标题，旧手写 kicker（第二套实现）退役。 -->
        <div v-if="domainParam" data-testid="ws-settings-domain-page">
            <SettingsLayerHeader layer="workspace" :domain="domainLabel" />
            <div class="mx-auto w-full max-w-6xl px-6 py-6">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <h2 class="text-lg font-medium" data-testid="ws-settings-domain-title">
                        {{ domainLabel }}
                    </h2>
                    <p
                        class="text-[11px] text-muted-foreground"
                        data-testid="ws-settings-domain-summary"
                    >
                        {{ t("settings.ia.domainKeysCount", { count: domainKeyCount }) }}
                    </p>
                    <button
                        type="button"
                        class="ml-auto rounded px-1 text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                        data-testid="ws-settings-domain-overview"
                        @click="goConfigOverview"
                    >
                        {{ t("workspace.settingsDomainBackToOverview") }}
                    </button>
                </div>
                <div
                    v-if="toolFacesTab"
                    data-testid="ws-settings-domain-tabs"
                    role="tablist"
                    :aria-label="domainLabel"
                    class="mt-3 flex items-center gap-1 border-b"
                >
                    <button
                        v-for="tab in ['policy', 'tool-faces'] as const"
                        :key="tab"
                        type="button"
                        role="tab"
                        :data-testid="'settings-domain-tab-' + tab"
                        :aria-selected="activeDomainTab === tab"
                        class="-mb-px min-h-8 border-b-2 px-2 text-xs transition-colors"
                        :class="
                            activeDomainTab === tab
                                ? 'border-foreground font-medium text-foreground'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                        "
                        @click="selectDomainTab(tab)"
                    >
                        {{
                            tab === "policy"
                                ? t("settings.ia.approvalTabPolicy")
                                : t("settings.ia.navToolFaces")
                        }}
                    </button>
                </div>

                <p
                    v-if="!auth.canWriteWorkspace"
                    class="mt-1 text-[11px] text-muted-foreground"
                    data-testid="ws-settings-domain-readonly"
                >
                    {{ t("workspace.settingsConfigNote") }}
                </p>

                <!-- 策略面板用 `v-show` 保留挂载（切页签不重挂、不重复拉层配置），工具分类按需挂载
                 —— 与实例层域页同一口径：按需挂载 `SettingsDomainView.vue:230-232`，
                 常挂隐藏 `:239-241`。 -->
                <div v-show="activeDomainTab === 'policy'" class="mt-4">
                    <ConfigLayerPanels
                        layer="workspace"
                        :workspace-id="workspaceId"
                        :domain="domainParam as ConfigDomain"
                        :readonly="!auth.canWriteWorkspace"
                    />
                </div>
                <div
                    v-if="activeDomainTab === 'tool-faces' && toolFacesTab"
                    class="mt-4"
                    data-testid="ws-settings-tool-faces"
                >
                    <ToolFacesView embedded scope-lock="workspace" />
                </div>
            </div>
        </div>

        <!-- T1.1b（task-179 案A 裁定）：层头归一 —— 旧手写 kicker + text-lg 标题退役；
             层标题文案不变（settings.ia.layerWorkspace 与 workspace.settingsTitle 同为「工作区设置」），
             面包屑按 design.md:98 模板「设置 › 工作区层」。 -->
        <div v-else>
            <SettingsLayerHeader layer="workspace" />
            <div class="mx-auto w-full max-w-6xl px-6 py-6">
                <p class="text-sm text-muted-foreground mb-4 max-w-3xl">
                    {{ t("workspace.settingsDesc") }}
                </p>

                <div
                    class="flex flex-wrap items-center gap-2 mb-4"
                    data-testid="ws-settings-actions"
                >
                    <Button size="sm" data-testid="ws-settings-new-chat" @click="newChat">
                        {{ t("sidebar.newChat") }}
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        data-testid="ws-settings-environment"
                        @click="goEnvironment"
                    >
                        {{ t("workspace.settingsGoEnvironment") }}
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        data-testid="ws-settings-back"
                        @click="goBackToWorkspace"
                    >
                        {{ t("workspace.settingsBack") }}
                    </Button>
                </div>

                <div
                    v-if="loadError"
                    class="mb-3 flex flex-wrap items-center gap-2 px-3 py-2 text-sm bg-red-100 text-red-800 rounded"
                    data-testid="workspace-settings-error"
                >
                    <span>{{ t("common.error") }}: {{ loadError }}</span>
                    <Button
                        variant="outline"
                        size="sm"
                        data-testid="ws-settings-retry"
                        :disabled="loading"
                        @click="() => void retryLoad()"
                    >
                        <LoaderCircle
                            v-if="loading"
                            class="mr-1 inline-block size-3 animate-spin"
                        />
                        {{ t("workspace.settingsRetry") }}
                    </Button>
                </div>

                <template v-else>
                    <div class="flex gap-1 border-b mb-4">
                        <button
                            v-for="tab in tabs"
                            :key="tab.key"
                            :data-testid="`ws-settings-tab-${tab.key}`"
                            class="px-4 py-2 text-sm border-b-2 transition-colors"
                            :class="
                                activeTab === tab.key
                                    ? 'border-brand text-foreground font-medium'
                                    : 'border-transparent text-muted-foreground hover:text-foreground'
                            "
                            @click="switchTab(tab.key)"
                        >
                            {{ tab.label }}
                        </button>
                    </div>

                    <div v-if="activeTab === 'general'" data-testid="ws-settings-general">
                        <div class="border rounded-lg mb-2 overflow-hidden">
                            <div class="px-4 py-3 text-sm font-medium bg-muted/30">
                                {{ t("workspace.settingsGeneralTitle") }}
                            </div>

                            <div
                                v-if="auth.canManageWorkspace"
                                class="px-4 py-3 space-y-3 text-sm"
                                data-testid="ws-settings-edit"
                            >
                                <div class="grid gap-2">
                                    <label class="text-sm font-medium" for="ws-settings-name-input">
                                        {{ t("workspace.settingsName") }}
                                    </label>
                                    <Input
                                        id="ws-settings-name-input"
                                        v-model="editName"
                                        maxlength="120"
                                        data-testid="ws-settings-name-input"
                                    />
                                </div>
                                <div class="grid gap-2">
                                    <label
                                        class="text-sm font-medium"
                                        for="ws-settings-description-input"
                                    >
                                        {{ t("workspace.settingsDescription") }}
                                    </label>
                                    <Input
                                        id="ws-settings-description-input"
                                        v-model="editDescription"
                                        maxlength="500"
                                        data-testid="ws-settings-description-input"
                                    />
                                </div>
                                <div class="grid gap-2 sm:grid-cols-2">
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsId")
                                    }}</span>
                                    <span class="font-mono text-xs break-all">{{
                                        workspaceId
                                    }}</span>
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsStorageRef")
                                    }}</span>
                                    <span class="font-mono text-xs break-all">
                                        {{ auth.workspace?.storageRef || "—" }}
                                    </span>
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsExecutionMode")
                                    }}</span>
                                    <span class="flex items-center gap-2">
                                        {{ auth.workspace?.executionMode || "—" }}
                                        <RouterLink
                                            class="text-xs text-link underline"
                                            :to="{
                                                name: 'workspace-environment',
                                                params: { workspaceId },
                                            }"
                                            data-testid="ws-settings-go-environment"
                                        >
                                            {{ t("workspace.settingsGoEnvironment") }}
                                        </RouterLink>
                                    </span>
                                </div>
                                <p v-if="editError" class="text-sm text-destructive">
                                    {{ editError }}
                                </p>
                                <div class="flex flex-wrap gap-2">
                                    <Button
                                        :disabled="saving"
                                        data-testid="ws-settings-save"
                                        @click="() => void handleSave()"
                                    >
                                        <LoaderCircle
                                            v-if="saving"
                                            class="mr-1 inline-block size-3 animate-spin"
                                        />
                                        {{ saving ? t("common.saving") : t("common.save") }}
                                    </Button>
                                    <Button
                                        variant="destructive"
                                        data-testid="ws-settings-delete"
                                        @click="confirmDeleteOpen = true"
                                    >
                                        {{ t("workspace.settingsDeleteTitle") }}
                                    </Button>
                                </div>
                            </div>

                            <div v-else class="px-4 py-3 space-y-2 text-sm">
                                <div class="flex justify-between gap-3">
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsName")
                                    }}</span>
                                    <span data-testid="ws-settings-name">{{
                                        auth.workspace?.name ?? "—"
                                    }}</span>
                                </div>
                                <div class="flex justify-between gap-3">
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsDescription")
                                    }}</span>
                                    <span>{{ auth.workspace?.description || "—" }}</span>
                                </div>
                                <div class="flex justify-between gap-3">
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsId")
                                    }}</span>
                                    <span class="font-mono text-xs break-all">{{
                                        workspaceId
                                    }}</span>
                                </div>
                                <div class="flex justify-between gap-3">
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsStorageRef")
                                    }}</span>
                                    <span class="font-mono text-xs break-all">{{
                                        auth.workspace?.storageRef || "—"
                                    }}</span>
                                </div>
                                <div class="flex justify-between gap-3">
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsExecutionMode")
                                    }}</span>
                                    <span>{{ auth.workspace?.executionMode || "—" }}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div v-else-if="activeTab === 'config'" data-testid="ws-settings-config">
                        <p class="text-xs text-muted-foreground mb-2">
                            {{ t("workspace.settingsConfigNote") }}
                        </p>
                        <ConfigLayerPanels
                            layer="workspace"
                            :workspace-id="workspaceId"
                            :readonly="!auth.canWriteWorkspace"
                        />
                    </div>

                    <div
                        v-else-if="activeTab === 'members' && auth.canViewMembers !== false"
                        data-testid="ws-settings-members"
                    >
                        <WorkspaceMembersPanel
                            :workspace-id="workspaceId"
                            :readonly="
                                auth.workspace?.workspaceRole === undefined
                                    ? undefined
                                    : !auth.canManageWorkspace
                            "
                        />
                    </div>

                    <div v-else-if="activeTab === 'mcp'" data-testid="ws-settings-mcp">
                        <WorkspaceMcpPanel
                            :workspace-id="workspaceId"
                            :readonly="!auth.canWriteWorkspace"
                        />
                    </div>

                    <div
                        v-else-if="activeTab === 'credentials'"
                        data-testid="ws-settings-credentials"
                    >
                        <CredentialsPanel :owner-type="'WORKSPACE'" />
                    </div>

                    <div v-else data-testid="ws-settings-knowledge">
                        <KnowledgeBaseView />
                    </div>
                </template>
            </div>
        </div>

        <AlertDialog :open="confirmDeleteOpen" @update:open="(v) => (confirmDeleteOpen = v)">
            <AlertDialogContent data-testid="workspace-delete-confirm">
                <AlertDialogHeader>
                    <AlertDialogTitle class="text-destructive">
                        {{ t("workspace.settingsDeleteConfirmTitle") }}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {{
                            t("workspace.settingsDeleteConfirmDesc", { name: auth.workspace?.name })
                        }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <div
                    class="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-6 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100"
                >
                    · {{ t("workspace.settingsDeleteImpactRuntime") }}<br />
                    · {{ t("workspace.settingsDeleteImpactStorage") }}<br />
                    · {{ t("workspace.settingsDeleteImpactSessions") }}
                </div>
                <div class="grid gap-2">
                    <label class="text-sm font-medium" for="ws-delete-confirm-input">
                        {{ t("workspace.settingsDeleteInputLabel") }}
                    </label>
                    <Input
                        id="ws-delete-confirm-input"
                        v-model="deleteConfirmName"
                        :placeholder="auth.workspace?.name ?? ''"
                        data-testid="ws-delete-confirm-input"
                    />
                    <p v-if="deleteError" class="text-sm text-destructive">{{ deleteError }}</p>
                </div>
                <AlertDialogFooter>
                    <AlertDialogCancel>{{ t("common.cancel") }}</AlertDialogCancel>
                    <Button
                        variant="destructive"
                        :disabled="deleting"
                        data-testid="ws-delete-confirm-btn"
                        @click="() => void handleDelete()"
                    >
                        <LoaderCircle
                            v-if="deleting"
                            class="mr-1 inline-block size-3 animate-spin"
                        />
                        {{ t("workspace.settingsDeleteConfirmBtn") }}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </section>
</template>
