<script setup lang="ts">
/**
 * PLAN-0608 (T1.5 / review P0-2): the explicit workspace picker.
 *
 * Before this view the UI had no way to express "open THIS workspace": login
 * wrote the fallback into the tab context and every request followed it, while
 * a 409 had nowhere to go but a toast. The picker makes "not chosen yet" a real
 * state and gives the user a working path to any workspace they belong to.
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { api, ApiError, type ApiWorkspace } from "../composables/api";
import { readTabWorkspaceId, writeTabWorkspace } from "../lib/workspaceContext";
import { logger } from "../lib/logger";

const { t } = useI18n();
const router = useRouter();

const workspaces = ref<ApiWorkspace[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const selecting = ref<string | null>(null);

async function openWorkspace(workspace: ApiWorkspace): Promise<void> {
    if (selecting.value) return;
    selecting.value = workspace.id;
    try {
        writeTabWorkspace(workspace);
        await router.push({ name: "workspace", params: { workspaceId: workspace.id } });
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Failed to open workspace";
        logger.error("Open workspace failed: " + message);
        error.value = message;
    } finally {
        selecting.value = null;
    }
}

onMounted(async () => {
    // A tab that already has a context goes straight to it (the router guard
    // normally does this, but a deep link can construct this view directly).
    const existing = readTabWorkspaceId();
    if (existing) {
        await router.replace({ name: "workspace", params: { workspaceId: existing } });
        return;
    }
    try {
        workspaces.value = await api.listWorkspaces();
    } catch (cause) {
        const message = cause instanceof ApiError ? cause.message : "Failed to load workspaces";
        logger.error("Load workspaces failed: " + message);
        error.value = message;
    } finally {
        loading.value = false;
    }
});
</script>

<template>
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6" data-testid="workspace-picker">
        <header class="space-y-1">
            <h1 class="text-lg font-semibold">{{ t("workspacePicker.title") }}</h1>
            <p class="text-sm text-muted-foreground">{{ t("workspacePicker.subtitle") }}</p>
        </header>

        <p v-if="loading" class="text-sm text-muted-foreground">
            {{ t("workspacePicker.loading") }}
        </p>
        <p v-else-if="error" class="text-sm text-destructive" role="alert">{{ error }}</p>
        <p v-else-if="workspaces.length === 0" class="text-sm text-muted-foreground">
            {{ t("workspacePicker.empty") }}
        </p>

        <ul v-else class="flex flex-col gap-2">
            <li v-for="workspace in workspaces" :key="workspace.id">
                <button
                    type="button"
                    class="flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors hover:bg-accent disabled:opacity-50"
                    :disabled="selecting !== null"
                    :data-testid="`workspace-picker-item-${workspace.id}`"
                    @click="openWorkspace(workspace)"
                >
                    <span class="flex flex-col">
                        <span class="text-sm font-medium">{{
                            workspace.name || workspace.id
                        }}</span>
                        <span class="text-xs text-muted-foreground">{{ workspace.id }}</span>
                    </span>
                    <span v-if="workspace.workspaceRole" class="text-xs text-muted-foreground">
                        {{ workspace.workspaceRole }}
                    </span>
                </button>
            </li>
        </ul>
    </div>
</template>
