<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { LoaderCircle } from "@lucide/vue";
import { useAuthStore } from "../../../stores/auth";
import { useSessionStore } from "../../../stores/session";
import { api, ApiError } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { clearTabWorkspace, writeTabWorkspace } from "../../../lib/workspaceContext";
import { workspacePath } from "../../../lib/routes";
import WorkspaceMcpPanel from "../components/WorkspaceMcpPanel.vue";
import WorkspaceMembersPanel from "../components/WorkspaceMembersPanel.vue";
import CredentialsPanel from "../../../components/settings/credentials/CredentialsPanel.vue";
import KnowledgeBaseView from "../../../views/settings/KnowledgeBaseView.vue";
import Input from "../../../components/ui/input/Input.vue";
import { Button } from "../../../components/ui/button";
import AlertDialog from "../../../components/ui/alert-dialog/AlertDialog.vue";
import AlertDialogContent from "../../../components/ui/alert-dialog/AlertDialogContent.vue";
import AlertDialogHeader from "../../../components/ui/alert-dialog/AlertDialogHeader.vue";
import AlertDialogTitle from "../../../components/ui/alert-dialog/AlertDialogTitle.vue";
import AlertDialogDescription from "../../../components/ui/alert-dialog/AlertDialogDescription.vue";
import AlertDialogFooter from "../../../components/ui/alert-dialog/AlertDialogFooter.vue";
import AlertDialogCancel from "../../../components/ui/alert-dialog/AlertDialogCancel.vue";

// PLAN-0560：每工作区设置页（常规/MCP）。MCP 复用 WorkspaceMcpPanel，常规区 OWNER 可编辑/删除。
// PLAN-0565：「成员」tab（裁定 #2——EDITOR 只读可见、VIEWER 不渲染）。
// PLAN-0752 T4.2/T4.3：工作区层的资源入口按 tab 承载 —— MCP（绑定/启用）、凭据（归属本工作区）、
// 知识库（按工作区分区的文档）。三者后端都已实现，所以都是**真入口**，不是缺口位；实例/用户层
// 没有对应承载才在外层左栏标 G2/G3（D7 口径：只给真缺的能力标缺口）。
//
// task-253（用户 2026-11-10 裁定）：**移除「配置」tab 与域段路由**
// （/workspace/:id/settings/:domain）。全局 config 的 workspace 层已在 UI 侧失效（契约侧由
// task-250 只标 deprecated），工作区内部设置面本轮不重新设计 ⇒ 这里只保留不依赖该层的资源
// tab。删除理由不是「看起来多余」：留着它就会继续 PUT/GET /config/workspace/**，而这层已废弃。
type SettingsTab = "general" | "mcp" | "members" | "credentials" | "knowledge";

const route = useRoute(),
    router = useRouter(),
    auth = useAuthStore(),
    sessionStore = useSessionStore(),
    { t } = useI18n();

const workspaceId = computed(() => String(route.params.workspaceId ?? "").trim());

/** `?tab=` 的唯一解析口径（读与写都走它，避免两处各写一份白名单）。 */
function tabFromQuery(q: unknown): SettingsTab {
    return q === "mcp" ||
        q === "members" ||
        q === "credentials" ||
        q === "knowledge" ||
        q === "general"
        ? q
        : "general";
}
const activeTab = ref<SettingsTab>(tabFromQuery(route.query.tab));

// 外部 query 变化要能回到页面状态（深链、浏览器前进/后退、别人贴过来的链接）。
watch(
    () => route.query.tab,
    (q) => {
        const next = tabFromQuery(q);
        if (next !== activeTab.value) activeTab.value = next;
    },
);

// task-253：域段模式（/workspace/:id/settings/:domain）随工作区配置层一起移除 ——
// 该模式下唯一的域内页签「工具分类」也就没有宿主了（G9/task-153 的工作区入口在本轮消失，
// 已作为「产品面减少」报 Lead 裁定；ToolFacesView 本身与实例层入口不受影响）。
const tabs = computed<{ key: SettingsTab; label: string }[]>(() => {
    const base: { key: SettingsTab; label: string }[] = [
        { key: "general", label: t("workspace.settingsTabGeneral") },
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
    loading = ref(false);

function switchTab(tab: SettingsTab) {
    if (activeTab.value === tab) return;
    activeTab.value = tab;
    // PLAN-0772 M2（design.md 决策 9）：页签切换**写回 URL**。改前全仓 6 处读 `?tab=`、只有 2 处写，
    // 本组件一个都不写 ⇒ 「切到 MCP 后复制链接」打开的是常规页（典型的"看着像有深链其实没有"）。
    // `general` 是默认页签，落 URL 时省略它（否则同一页有两个地址）。
    const { tab: _ignored, ...rest } = route.query;
    void router.push({ query: tab === "general" ? rest : { ...rest, tab } });
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
    <section class="min-h-full" data-testid="workspace-settings-page">
        <!-- task-253：工作区设置不再是「设置区的一层」（全局设置只有实例/用户两层），
             所以不再复用 SettingsLayerHeader 的「设置 › 工作区层」面包屑，页面自带标题头。
             工作区配置 tab 与域段路由同时移除 —— 那块面走的是已废弃的 /config/workspace/**。 -->
        <header
            data-testid="workspace-settings-header"
            class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur"
        >
            <div class="mx-auto w-full max-w-6xl px-6 pt-4 pb-3">
                <h1
                    data-testid="workspace-settings-title"
                    class="text-2xl leading-tight font-semibold tracking-tight"
                >
                    {{ t("workspace.settingsTitle") }}
                </h1>
                <p class="mt-1 max-w-3xl text-sm text-muted-foreground">
                    {{ t("workspace.settingsDesc") }}
                </p>
            </div>
        </header>
        <div>
            <div class="mx-auto w-full max-w-6xl px-6 py-6">
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
                                    ? 'border-primary text-foreground font-medium'
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
                                            class="text-xs text-primary underline"
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
