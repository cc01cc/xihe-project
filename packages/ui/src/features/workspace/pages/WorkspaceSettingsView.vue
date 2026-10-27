<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useAuthStore } from "../../../stores/auth";
import { useConfigStore } from "../../../stores/config";
import { ApiError } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import ConfigLayerPanels from "../../../components/settings/ConfigLayerPanels.vue";
import WorkspaceMcpPanel from "../components/WorkspaceMcpPanel.vue";

// PLAN-0560：每工作区设置页（常规/配置/MCP）。配置区复用 ConfigLayerPanels
// （layer=workspace），MCP 复用 WorkspaceMcpPanel；角色只读态见 T2.5/T3.6。
type SettingsTab = "general" | "config" | "mcp";

const route = useRoute(),
    router = useRouter(),
    auth = useAuthStore(),
    configStore = useConfigStore(),
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
    configLoaded = ref(false);

async function loadConfig() {
    if (configLoaded.value || !workspaceId.value) return;
    try {
        await configStore.loadLayerDomains("workspace", workspaceId.value);
        configLoaded.value = true;
    } catch (e) {
        logger.warn("Failed to load workspace config domains", e);
        toast.error(t("settings.saveFailed"));
    }
}

function switchTab(tab: SettingsTab) {
    if (activeTab.value === tab) return;
    activeTab.value = tab;
    if (tab === "config") void loadConfig();
}

onMounted(async () => {
    if (!workspaceId.value) {
        await router.replace({ name: "workspace-home" });
        return;
    }
    try {
        await auth.selectWorkspace(workspaceId.value);
    } catch (cause) {
        const code = cause instanceof ApiError ? cause.problem.code : "";
        if (code === "WORKSPACE_FORBIDDEN" || code === "WORKSPACE_NOT_FOUND") {
            await router.replace({ name: "workspace-home" });
            return;
        }
        const message = cause instanceof Error ? cause.message : "Failed to load workspace";
        logger.error("Load workspace failed", cause);
        loadError.value = message;
        toast.error(message);
        return;
    }
    if (activeTab.value === "config") await loadConfig();
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

            <div
                v-if="loadError"
                class="mb-3 px-3 py-2 text-sm bg-red-100 text-red-800 rounded"
                data-testid="workspace-settings-error"
            >
                {{ t("common.error") }}: {{ loadError }}
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
                        <div class="px-4 py-3 space-y-2 text-sm">
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
                                <span class="font-mono text-xs">{{ workspaceId }}</span>
                            </div>
                            <div class="flex justify-between gap-3">
                                <span class="text-muted-foreground">{{
                                    t("workspace.settingsStorageRef")
                                }}</span>
                                <span class="font-mono text-xs">{{
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
                    <ConfigLayerPanels layer="workspace" :workspace-id="workspaceId" />
                </div>

                <div v-else data-testid="ws-settings-mcp">
                    <WorkspaceMcpPanel :workspace-id="workspaceId" />
                </div>
            </template>
        </div>
    </section>
</template>
