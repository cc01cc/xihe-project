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
import { clearTabWorkspace, readTabWorkspaceId, writeTabWorkspace } from "../lib/workspaceContext";
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
    // BL-172: this view must never be able to sit on the loading state forever.
    // The old early-return branch below redirected and returned *before* the `finally`
    // that clears `loading`, so a bounce-back (WorkspaceView answers 400
    // WORKSPACE_CONTEXT_CONFLICT / fails its authorization check and returns here per
    // PLAN-0608 C′) showed "正在加载工作区…" indefinitely — an empty picker with a
    // perfectly healthy `GET /workspaces`. Clearing the context before redirecting also
    // matters: `readTabWorkspaceId()` would still be set, so the next mount would take
    // the same branch again (bounce loop).
    const existing = readTabWorkspaceId();
    if (existing) {
        clearTabWorkspace();
        try {
            await router.replace({ name: "workspace", params: { workspaceId: existing } });
            return;
        } catch (cause) {
            logger.error(
                "Workspace picker redirect failed: " +
                    (cause instanceof Error ? cause.message : String(cause)),
            );
            // Fall through to the list: the redirect target was unusable.
        }
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
