<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { logger } from "../../lib/logger";
import SettingsNav from "../../components/settings/SettingsNav.vue";
import BackToChatButton from "../../components/settings/BackToChatButton.vue";
import ImportPreview, { type ImportData } from "../../components/settings/ImportPreview.vue";
import { apiRaw, api, ApiError } from "../../composables/api";
import { useAuthStore } from "../../stores/auth";
import { useCheckpointStore } from "../../stores/checkpoint";
import type { CheckpointRetention } from "../../types";

const { t } = useI18n();
const authStore = useAuthStore();
const checkpointStore = useCheckpointStore();
const exporting = ref(false);
const importing = ref(false);
const importFile = ref<File | null>(null);
const showImportPreview = ref(false);
const result = ref<string | null>(null);

// PLAN-0339: informational retention view + explicit workspace shadow cleanup.
// Constants are server-reported (N=50 / TTL 30d); the UI never invents them.
const workspaceId = computed(() => authStore.currentWorkspaceId);
const retention = ref<CheckpointRetention | null>(null);
const retentionLoading = ref(false);
const retentionError = ref<string | null>(null);
const cleanupConfirming = ref(false);
const cleanupBusy = ref(false);
const cleanupResult = ref<string | null>(null);

function errorText(cause: unknown, fallback: string): string {
    return cause instanceof ApiError
        ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
        : fallback;
}

async function loadRetention() {
    const wsId = workspaceId.value;
    if (!wsId) {
        retention.value = null;
        return;
    }
    retentionLoading.value = true;
    retentionError.value = null;
    try {
        retention.value = await api.getWorkspaceCheckpointRetention(wsId);
    } catch (cause) {
        retentionError.value = errorText(cause, t("settings.checkpointLoadFailed"));
        logger.warn("Failed to load checkpoint retention", cause);
    } finally {
        retentionLoading.value = false;
    }
}

async function cleanupCheckpoints() {
    const wsId = workspaceId.value;
    if (!wsId || cleanupBusy.value) return;
    cleanupBusy.value = true;
    cleanupResult.value = null;
    try {
        const outcome = await api.cleanupWorkspaceCheckpoints(wsId);
        checkpointStore.clearWorkspace(wsId);
        cleanupResult.value = outcome.removed
            ? t("settings.checkpointCleanupDone")
            : t("settings.checkpointCleanupEmpty");
        cleanupConfirming.value = false;
        await loadRetention();
    } catch (cause) {
        cleanupResult.value = `${t("settings.checkpointCleanupFailed")}: ${errorText(cause, "")}`;
        logger.warn("Failed to clean workspace checkpoints", cause);
    } finally {
        cleanupBusy.value = false;
    }
}

onMounted(loadRetention);
watch(workspaceId, () => {
    cleanupConfirming.value = false;
    cleanupResult.value = null;
    void loadRetention();
});

async function exportSettings() {
    exporting.value = true;
    try {
        const res = await apiRaw("/config/export");
        const blob = await res.blob();
        downloadBlob(blob, "xihe-settings.json");
    } catch (e) {
        logger.error(`Settings export failed: ${e instanceof Error ? e.message : String(e)}`);
        result.value = "Export failed";
    }
    exporting.value = false;
}

async function exportChats() {
    exporting.value = true;
    try {
        const res = await apiRaw("/config/export");
        const blob = await res.blob();
        downloadBlob(blob, "xihe-chats.json");
    } catch (e) {
        logger.error(`Chats export failed: ${e instanceof Error ? e.message : String(e)}`);
        result.value = "Export failed";
    }
    exporting.value = false;
}

function handleFileSelected(e: Event) {
    const files = (e.target as HTMLInputElement).files;
    if (!files?.length) return;
    importFile.value = files[0];
    showImportPreview.value = true;
}

async function handleConfirmImport(data: ImportData) {
    importing.value = true;
    try {
        const text = await data.file.text();
        const res = await apiRaw("/config/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: text,
        });
        const resultData = await res.json();
        result.value = `Imported: ${resultData.imported}, Skipped: ${resultData.skipped}`;
    } catch (e) {
        logger.error(`Chats import failed: ${e instanceof Error ? e.message : String(e)}`);
        result.value = "Import failed";
    }
    importing.value = false;
    showImportPreview.value = false;
}

function handleCancelImport() {
    showImportPreview.value = false;
}

function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
</script>

<template>
    <BackToChatButton />
    <SettingsNav />
    <div class="space-y-4">
        <h3 data-testid="settings-data-heading" class="font-medium">
            {{ t("settings.dataControls") }}
        </h3>

        <div class="space-y-2">
            <button
                class="w-full px-3 py-2 rounded text-xs border bg-background hover:bg-muted text-left transition-colors"
                :disabled="exporting"
                @click="exportSettings"
            >
                {{ t("settings.exportSettings") }}
            </button>
            <button
                class="w-full px-3 py-2 rounded text-xs border bg-background hover:bg-muted text-left transition-colors"
                :disabled="exporting"
                @click="exportChats"
            >
                {{ t("settings.exportChats") }}
            </button>
        </div>

        <div class="border-t pt-3 space-y-2">
            <button
                class="px-3 py-2 rounded text-xs border bg-background hover:bg-muted transition-colors"
                @click="($refs.fileInput as HTMLInputElement)?.click()"
            >
                {{ t("settings.import") }}
            </button>
            <input
                ref="fileInput"
                type="file"
                accept=".json"
                class="hidden"
                @change="handleFileSelected"
            />

            <ImportPreview
                v-if="showImportPreview"
                :file="importFile"
                @confirm="handleConfirmImport"
                @cancel="handleCancelImport"
            />
        </div>

        <div class="border-t pt-3 space-y-2" data-testid="settings-checkpoint-retention">
            <h4 class="text-xs font-medium">{{ t("settings.checkpointRetention") }}</h4>
            <p class="text-xs text-muted-foreground">{{ t("settings.checkpointRetentionDesc") }}</p>

            <p
                v-if="retentionLoading"
                data-testid="settings-checkpoint-loading"
                class="text-xs text-muted-foreground"
            >
                {{ t("common.loading") }}
            </p>
            <div
                v-else-if="retentionError"
                data-testid="settings-checkpoint-error"
                class="space-y-1"
            >
                <p class="text-xs text-destructive" role="alert">{{ retentionError }}</p>
                <button
                    type="button"
                    data-testid="settings-checkpoint-retry"
                    class="px-2 py-1 rounded text-xs border bg-background hover:bg-muted transition-colors"
                    @click="loadRetention"
                >
                    {{ t("common.retry") }}
                </button>
            </div>
            <p
                v-else-if="!workspaceId"
                data-testid="settings-checkpoint-no-workspace"
                class="text-xs text-muted-foreground"
            >
                {{ t("settings.checkpointNoWorkspace") }}
            </p>
            <template v-else-if="retention">
                <dl
                    data-testid="settings-checkpoint-constants"
                    class="grid grid-cols-2 gap-2 text-xs"
                >
                    <div class="flex justify-between gap-2 rounded border bg-muted/20 px-2 py-1">
                        <dt class="text-muted-foreground">{{ t("settings.checkpointMaxRuns") }}</dt>
                        <dd data-testid="settings-checkpoint-max-runs" class="font-medium">
                            {{ retention.maxRuns }}
                        </dd>
                    </div>
                    <div class="flex justify-between gap-2 rounded border bg-muted/20 px-2 py-1">
                        <dt class="text-muted-foreground">{{ t("settings.checkpointTtlDays") }}</dt>
                        <dd data-testid="settings-checkpoint-ttl-days" class="font-medium">
                            {{ retention.ttlDays }}
                        </dd>
                    </div>
                    <div class="flex justify-between gap-2 rounded border bg-muted/20 px-2 py-1">
                        <dt class="text-muted-foreground">
                            {{ t("settings.checkpointCurrentRuns") }}
                        </dt>
                        <dd data-testid="settings-checkpoint-current-runs" class="font-medium">
                            {{ retention.currentRuns }}
                        </dd>
                    </div>
                    <div class="flex justify-between gap-2 rounded border bg-muted/20 px-2 py-1">
                        <dt class="text-muted-foreground">
                            {{ t("settings.checkpointCurrentRefs") }}
                        </dt>
                        <dd data-testid="settings-checkpoint-current-refs" class="font-medium">
                            {{ retention.currentRefs }}
                        </dd>
                    </div>
                </dl>
            </template>

            <div v-if="!cleanupConfirming">
                <button
                    type="button"
                    data-testid="settings-checkpoint-cleanup"
                    class="px-3 py-2 rounded text-xs border bg-background hover:bg-muted transition-colors disabled:opacity-50"
                    :disabled="!workspaceId || cleanupBusy"
                    @click="cleanupConfirming = true"
                >
                    {{ t("settings.checkpointCleanup") }}
                </button>
            </div>
            <div
                v-else
                data-testid="settings-checkpoint-cleanup-confirm-box"
                class="space-y-2 rounded border border-amber-500/40 bg-amber-500/10 p-2"
            >
                <p class="text-xs">{{ t("settings.checkpointCleanupWarning") }}</p>
                <div class="flex flex-wrap gap-2">
                    <button
                        type="button"
                        data-testid="settings-checkpoint-cleanup-cancel"
                        class="px-2 py-1 rounded text-xs border bg-background hover:bg-muted transition-colors"
                        :disabled="cleanupBusy"
                        @click="cleanupConfirming = false"
                    >
                        {{ t("common.cancel") }}
                    </button>
                    <button
                        type="button"
                        data-testid="settings-checkpoint-cleanup-confirm"
                        class="px-2 py-1 rounded text-xs border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
                        :disabled="cleanupBusy"
                        @click="cleanupCheckpoints"
                    >
                        {{ t("settings.checkpointCleanupConfirm") }}
                    </button>
                </div>
            </div>
            <p
                v-if="cleanupResult"
                data-testid="settings-checkpoint-cleanup-result"
                class="text-xs text-muted-foreground"
            >
                {{ cleanupResult }}
            </p>
        </div>

        <p v-if="result" class="text-xs text-muted-foreground">{{ result }}</p>
    </div>
</template>
