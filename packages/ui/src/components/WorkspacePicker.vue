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
import WorkspaceCreateDialog from "../features/workspace/components/WorkspaceCreateDialog.vue";

const { t } = useI18n();
const router = useRouter();

const workspaces = ref<ApiWorkspace[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const selecting = ref<string | null>(null);
/** PLAN-0614 T2.1: 空态直接给"创建你的第一个工作区"入口（复用既有对话框，不新增页面/路由）。 */
const createOpen = ref(false);

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

/** 重新拉取列表（空态建完后要让新工作区出现在列表里，再进入它）。 */
async function refreshWorkspaces(): Promise<void> {
    try {
        workspaces.value = await api.listWorkspaces();
    } catch (cause) {
        const message = cause instanceof ApiError ? cause.message : "Failed to load workspaces";
        logger.error("Load workspaces failed: " + message);
        error.value = message;
    }
}

/**
 * PLAN-0614 T2.1：刚在工作区对话框里建成 → 刷新列表 → 直接进入新工作区。
 * 进入失败（比如 CP 还不可用）时保留列表态，用户可以再点一次，而不是白屏。
 */
async function handleCreated(workspaceId: string): Promise<void> {
    createOpen.value = false;
    await refreshWorkspaces();
    const created: ApiWorkspace =
        workspaces.value.find((item) => item.id === workspaceId) ??
        ({ id: workspaceId } as ApiWorkspace);
    await openWorkspace(created);
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
        await refreshWorkspaces();
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
        <div
            v-else-if="workspaces.length === 0"
            class="flex flex-col items-start gap-3"
            data-testid="workspace-picker-empty"
        >
            <p class="text-sm text-muted-foreground">{{ t("workspacePicker.empty") }}</p>
            <button
                type="button"
                class="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                data-testid="workspace-picker-create"
                @click="createOpen = true"
            >
                {{ t("workspacePicker.createFirst") }}
            </button>
        </div>

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

        <!-- PLAN-0614 T2.1：空态入口复用既有创建对话框（不新增页面/路由）。 -->
        <WorkspaceCreateDialog
            :open="createOpen"
            @close="createOpen = false"
            @created="handleCreated"
        />
    </div>
</template>
