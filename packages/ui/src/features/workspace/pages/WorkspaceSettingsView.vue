<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { LoaderCircle } from "@lucide/vue";
import { useAuthStore } from "../../../stores/auth";
import { useConfigStore } from "../../../stores/config";
import { useSessionStore } from "../../../stores/session";
import { api, ApiError } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { clearTabWorkspace, writeTabWorkspace } from "../../../lib/workspaceContext";
import { workspacePath } from "../../../lib/routes";
import ConfigLayerPanels from "../../../components/settings/ConfigLayerPanels.vue";
import WorkspaceMcpPanel from "../components/WorkspaceMcpPanel.vue";
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
type SettingsTab = "general" | "config" | "mcp";

const route = useRoute(),
    router = useRouter(),
    auth = useAuthStore(),
    configStore = useConfigStore(),
    sessionStore = useSessionStore(),
    { t } = useI18n();

const workspaceId = computed(() => String(route.params.workspaceId ?? "").trim());

const initialTab = ((): SettingsTab => {
    const q = route.query.tab;
    return q === "config" || q === "mcp" || q === "general" ? q : "general";
})();
const activeTab = ref<SettingsTab>(initialTab);

const tabs = computed<{ key: SettingsTab; label: string }[]>(() => [
    { key: "general", label: t("workspace.settingsTabGeneral") },
    { key: "config", label: t("workspace.settingsTabConfig") },
    { key: "mcp", label: t("workspace.settingsTabMcp") },
]);

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
    if (activeTab.value === "config") await loadConfig();
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
        <div class="mx-auto w-full max-w-6xl px-6 py-6">
            <div
                class="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1"
                data-testid="workspace-settings-kicker"
            >
                {{ t("workspace.settingsKicker") }}
            </div>
            <h2 class="text-lg font-semibold mb-1" data-testid="workspace-settings-heading">
                {{ t("workspace.settingsTitle") }}
            </h2>
            <p class="text-sm text-muted-foreground mb-4 max-w-3xl">
                {{ t("workspace.settingsDesc") }}
            </p>

            <div class="flex flex-wrap items-center gap-2 mb-4" data-testid="ws-settings-actions">
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
                    <LoaderCircle v-if="loading" class="mr-1 inline-block size-3 animate-spin" />
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
                                <span class="font-mono text-xs break-all">{{ workspaceId }}</span>
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
                                <span class="font-mono text-xs break-all">{{ workspaceId }}</span>
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

                <div v-else data-testid="ws-settings-mcp">
                    <WorkspaceMcpPanel
                        :workspace-id="workspaceId"
                        :readonly="!auth.canWriteWorkspace"
                    />
                </div>
            </template>
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
