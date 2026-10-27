<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { useConfigStore } from "../../stores/config";
import ConfigLayerPanels from "../../components/settings/ConfigLayerPanels.vue";
import SettingsNav from "../../components/settings/SettingsNav.vue";
import BackToChatButton from "../../components/settings/BackToChatButton.vue";
import { logger } from "../../lib/logger";
import { useAuthStore } from "../../stores/auth";
import { workspaceSettingsPath } from "../../lib/routes";

const { t } = useI18n(),
    configStore = useConfigStore(),
    authStore = useAuthStore(),
    router = useRouter();

// PLAN-0560：全局设置只保留 Instance/User 两层；Workspace 配置移至各工作区
// 设置页（/workspace/:workspaceId/settings）。旧 ?tab=workspace 不做兼容（决策 #6）。
type LayerTab = "instance" | "user";
const activeTab = ref<LayerTab>(authStore.isAdmin ? "instance" : "user");

const tabs = computed<{ key: LayerTab; label: string }[]>(() => {
    const list: { key: LayerTab; label: string }[] = [];
    if (authStore.isAdmin) list.push({ key: "instance", label: t("settings.tabInstance") });
    list.push({ key: "user", label: t("settings.tabUser") });
    return list;
});

function currentWorkspaceId(): string {
    return authStore.currentWorkspaceId ?? "";
}

function goWorkspaceSettings() {
    const workspaceId = currentWorkspaceId();
    if (!workspaceId) return;
    void router.push(workspaceSettingsPath(workspaceId));
}

const fetchError = ref(false);
// Only the first load of a layer shows the full-page loading state. Reloads
// after a save must keep the panels mounted (otherwise the expanded domain
// panel and its save button unmount mid-interaction).
const hasLayerData = computed(
    () => Object.keys(configStore.layerConfig[activeTab.value] ?? {}).length > 0,
);
const showInitialLoading = computed(() => configStore.layerLoading && !hasLayerData.value);
const exporting = ref(false),
    importing = ref(false),
    importWarnings = ref<string[]>([]),
    includeSecrets = ref(true);

const showImportExport = computed(() => activeTab.value === "instance");

onMounted(async () => {
    fetchError.value = false;
    try {
        await configStore.loadLayerDomains(activeTab.value);
    } catch (e) {
        logger.warn("Failed to load config domains", e);
        fetchError.value = true;
        toast.error("Failed to load configuration");
    }
});

async function switchTab(tab: LayerTab) {
    if (activeTab.value === tab) return;
    activeTab.value = tab;
    fetchError.value = false;
    try {
        await configStore.loadLayerDomains(tab);
    } catch (e) {
        logger.warn("Failed to load config domains for layer " + tab, e);
        fetchError.value = true;
        toast.error(t("settings.saveFailed"));
    }
}

async function reloadActiveLayer() {
    await configStore.loadLayerDomains(activeTab.value);
}

async function handleExport() {
    exporting.value = true;
    try {
        const content = await configStore.exportConfig(includeSecrets.value),
            blob = new Blob([content], { type: "application/json" }),
            url = URL.createObjectURL(blob),
            anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "config.import.local.jsonc";
        anchor.click();
        URL.revokeObjectURL(url);
        toast.success(t("settings.exportDone"));
    } catch (e) {
        logger.warn("Config export failed", e);
        toast.error(t("settings.exportFailed"));
    } finally {
        exporting.value = false;
    }
}

async function handleImportFile(event: Event) {
    const input = event.target as HTMLInputElement,
        file = input.files?.[0];
    if (!file) return;
    importing.value = true;
    importWarnings.value = [];
    try {
        const content = await file.text(),
            report = await configStore.importConfig(content);
        importWarnings.value = report.warnings ?? [];
        toast.success(`${t("settings.importDone")}: +${report.imported} / skip ${report.skipped}`);
        if (importWarnings.value.length) toast.warning(importWarnings.value[0]);
        await reloadActiveLayer();
    } catch (e) {
        logger.warn("Config import failed", e);
        toast.error(t("settings.importFailed"));
    } finally {
        importing.value = false;
        input.value = "";
    }
}
</script>

<template>
    <div>
        <BackToChatButton />
        <SettingsNav />
        <div class="mx-auto w-full max-w-6xl space-y-2 px-6 py-6">
            <h2 data-testid="settings-config-heading" class="text-lg font-semibold mb-4">
                {{ t("settings.configTab") }}
            </h2>

            <div
                class="mb-3 flex flex-wrap items-center justify-between gap-2 rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                data-testid="config-workspace-moved"
            >
                <span>{{ t("settings.workspaceConfigMovedNotice") }}</span>
                <button
                    data-testid="config-go-workspace-settings"
                    class="px-3 py-1 text-xs border rounded hover:bg-muted disabled:opacity-50"
                    :disabled="!currentWorkspaceId()"
                    :title="
                        currentWorkspaceId()
                            ? undefined
                            : t('settings.workspaceConfigMovedNoWorkspace')
                    "
                    @click="goWorkspaceSettings"
                >
                    {{ t("settings.workspaceConfigMovedGo") }}
                </button>
            </div>

            <div v-if="fetchError" class="mb-3 px-3 py-2 text-sm bg-red-100 text-red-800 rounded">
                {{ t("common.error") }}: {{ t("settings.saveFailed") }}
            </div>

            <div v-if="showInitialLoading" class="text-sm text-muted-foreground">
                {{ t("common.loading") }}
            </div>

            <template v-else>
                <div class="flex gap-1 border-b mb-4">
                    <button
                        v-for="tab in tabs"
                        :key="tab.key"
                        :data-testid="`config-tab-${tab.key}`"
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

                <div class="space-y-1">
                    <div
                        v-if="showImportExport"
                        class="border rounded-lg mb-2 overflow-hidden"
                        data-testid="config-import-export"
                    >
                        <div class="px-4 py-3 text-sm font-medium bg-muted/30">
                            {{ t("settings.importExport") }}
                        </div>
                        <div class="px-4 pb-3 space-y-2">
                            <div class="flex flex-wrap items-center gap-3">
                                <button
                                    data-testid="config-export-button"
                                    class="px-3 py-1 text-xs border rounded hover:bg-muted disabled:opacity-50"
                                    :disabled="exporting"
                                    @click="handleExport"
                                >
                                    {{
                                        exporting ? t("common.loading") : t("settings.exportConfig")
                                    }}
                                </button>
                                <label
                                    class="flex items-center gap-1 text-xs text-muted-foreground"
                                >
                                    <input
                                        v-model="includeSecrets"
                                        data-testid="config-export-secrets"
                                        type="checkbox"
                                    />
                                    {{ t("settings.exportIncludeSecrets") }}
                                </label>
                                <label
                                    class="px-3 py-1 text-xs border rounded cursor-pointer hover:bg-muted"
                                    :class="{ 'opacity-50': importing }"
                                >
                                    {{
                                        importing ? t("common.loading") : t("settings.importConfig")
                                    }}
                                    <input
                                        data-testid="config-import-input"
                                        type="file"
                                        accept=".jsonc,.json,application/json"
                                        class="hidden"
                                        :disabled="importing"
                                        @change="handleImportFile"
                                    />
                                </label>
                            </div>
                            <ul
                                v-if="importWarnings.length"
                                class="text-xs text-amber-600 list-disc pl-4"
                                data-testid="config-import-warnings"
                            >
                                <li v-for="(warning, index) in importWarnings" :key="index">
                                    {{ warning }}
                                </li>
                            </ul>
                        </div>
                    </div>

                    <ConfigLayerPanels
                        :layer="activeTab"
                        :workspace-id="currentWorkspaceId() || undefined"
                        @switch-layer="switchTab"
                        @go-workspace="goWorkspaceSettings"
                    />
                </div>
            </template>
        </div>
    </div>
</template>
