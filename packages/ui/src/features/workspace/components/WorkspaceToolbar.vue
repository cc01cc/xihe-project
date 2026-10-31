<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useWorkspaceStore } from "../stores/workspace";
import { useAuthStore } from "../../../stores/auth";
import {
    Activity,
    Bot,
    Code,
    FileDiff,
    FolderOpen,
    FolderTree,
    MoreHorizontal,
    PanelLeft,
    Plus,
} from "@lucide/vue";
import {
    workspacePath,
    workspaceScheduledTasksPath,
    workspaceSettingsPath,
} from "../../../lib/routes";

/**
 * PLAN-0582 S3a (review P1-1): this row keeps only controls that belong here —
 * the dock toggles and the workspace-level dialog entries. Page tabs moved to
 * `WorkspaceTabBar`, file actions moved to the file-tree panel head, and the
 * workspace name is no longer repeated here (P1-2).
 */
const props = defineProps<{
    workspaceId: string;
    agentPrincipalId?: string | null;
    codeOpen?: boolean;
    changesOpen?: boolean;
    monitorOpen?: boolean;
}>();

const emit = defineEmits<{
    importSource: [];
    agents: [];
    addWorkspace: [];
    files: [];
    toggleCode: [];
    toggleChanges: [];
    toggleMonitor: [];
}>();

const { t } = useI18n();
const router = useRouter(),
    ws = useWorkspaceStore(),
    auth = useAuthStore();

const breadcrumb = computed(() => {
    const active = ws.activeFilePath;
    if (!active) return [] as Array<{ label: string; path: string; isLast: boolean }>;
    return active.split("/").map((part, i, arr) => ({
        label: part,
        path: arr.slice(0, i + 1).join("/"),
        isLast: i === arr.length - 1,
    }));
});

function openEnvironment() {
    const id = props.workspaceId || auth.currentWorkspaceId;
    if (id) router.push(`/workspace/${id}/environment`);
}

function openScheduledTasks() {
    const id = props.workspaceId || auth.currentWorkspaceId;
    if (id) router.push(workspaceScheduledTasksPath(id));
}

function openSettings() {
    const id = props.workspaceId || auth.currentWorkspaceId;
    if (id) router.push(workspaceSettingsPath(id));
}

// PLAN-0560 T3.7：移动端工具条收敛为 ＋ 新建对话 + ⋯ 溢出菜单。
const overflowOpen = ref(false);

function newChat() {
    const id = props.workspaceId || auth.currentWorkspaceId;
    overflowOpen.value = false;
    if (id) router.push({ path: workspacePath(id), query: { newChat: "1" } });
}

function overflowNav(navigate: () => void) {
    overflowOpen.value = false;
    navigate();
}
</script>

<template>
    <div class="flex items-center gap-2 px-3 h-10 border-b shrink-0 bg-background/80">
        <button
            class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors md:hidden"
            title="Files"
            aria-label="Files"
            data-testid="workspace-toolbar-files-mobile"
            @click="emit('files')"
        >
            <PanelLeft class="size-3.5" />
        </button>
        <button
            type="button"
            data-testid="workspace-toolbar-new-chat-mobile"
            class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors md:hidden"
            :title="t('sidebar.newChat')"
            :aria-label="t('sidebar.newChat')"
            @click="newChat"
        >
            <Plus class="size-3.5" />
        </button>
        <div class="relative md:hidden">
            <button
                type="button"
                data-testid="workspace-toolbar-more-mobile"
                class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
                :title="t('workspace.toolbarMore')"
                :aria-label="t('workspace.toolbarMore')"
                :aria-expanded="overflowOpen"
                @click="overflowOpen = !overflowOpen"
            >
                <MoreHorizontal class="size-3.5" />
            </button>
            <div
                v-if="overflowOpen"
                class="absolute right-0 top-full mt-1 z-50 w-44 rounded-md border bg-popover p-1 shadow-md text-sm"
                data-testid="workspace-toolbar-more-menu"
            >
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-agents"
                    @click="overflowNav(() => emit('agents'))"
                >
                    {{ t("workspace.agentManagement") }}
                </button>
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-changes"
                    @click="overflowNav(() => emit('toggleChanges'))"
                >
                    {{ t("workspace.panelChanges") }}
                </button>
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-monitor"
                    @click="overflowNav(() => emit('toggleMonitor'))"
                >
                    {{ t("workspace.panelMonitor") }}
                </button>
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-environment"
                    @click="overflowNav(openEnvironment)"
                >
                    {{ t("workspace.environmentState") }}
                </button>
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-scheduled"
                    @click="overflowNav(openScheduledTasks)"
                >
                    {{ t("workspace.scheduledTasks.nav") }}
                </button>
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-settings"
                    @click="overflowNav(openSettings)"
                >
                    {{ t("workspace.settingsTitle") }}
                </button>
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-add-workspace"
                    @click="overflowNav(() => emit('addWorkspace'))"
                >
                    {{ t("workspace.addWorkspace") }}
                </button>
            </div>
        </div>
        <div
            class="flex min-w-0 items-center gap-1 pr-12 text-xs text-muted-foreground flex-1"
            :title="props.workspaceId"
        >
            <FolderTree class="size-3.5" />
            <template v-if="breadcrumb.length > 0">
                <span v-for="(part, i) in breadcrumb" :key="i" class="flex items-center gap-1">
                    <span v-if="i > 0" class="text-muted-foreground/50">/</span>
                    <span
                        class="hover:text-foreground cursor-pointer"
                        :class="{ 'text-foreground font-medium': part.isLast }"
                    >
                        {{ part.label }}
                    </span>
                </span>
            </template>
            <span v-else class="truncate text-muted-foreground/70">{{
                t("workspace.noActiveFile")
            }}</span>
            <span
                v-if="agentPrincipalId"
                data-testid="workspace-active-agent"
                class="max-w-24 shrink-0 truncate rounded border px-1 py-0.5 text-[10px] text-muted-foreground"
                :title="`${t('workspace.activeAgent')}: ${agentPrincipalId}`"
                :aria-label="`${t('workspace.activeAgent')}: ${agentPrincipalId}`"
            >
                {{ t("workspace.activeAgent") }} · {{ agentPrincipalId.slice(0, 8) }}
            </span>
        </div>

        <div class="flex items-center gap-1 max-md:hidden">
            <button
                type="button"
                data-testid="workspace-toolbar-code"
                class="p-1.5 rounded transition-colors"
                :class="
                    codeOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent'
                "
                :title="t('workspace.toggleCode')"
                :aria-label="t('workspace.toggleCode')"
                :aria-pressed="codeOpen === true"
                @click="emit('toggleCode')"
            >
                <Code class="size-3.5" />
            </button>
            <button
                type="button"
                data-testid="workspace-toolbar-changes"
                class="p-1.5 rounded transition-colors"
                :class="
                    changesOpen
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                "
                :title="t('workspace.toggleDiff')"
                :aria-label="t('workspace.toggleDiff')"
                :aria-pressed="changesOpen === true"
                @click="emit('toggleChanges')"
            >
                <FileDiff class="size-3.5" />
            </button>
            <button
                type="button"
                data-testid="workspace-toolbar-monitor"
                class="p-1.5 rounded transition-colors"
                :class="
                    monitorOpen
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                "
                :title="t('workspace.toggleMonitor')"
                :aria-label="t('workspace.toggleMonitor')"
                :aria-pressed="monitorOpen === true"
                @click="emit('toggleMonitor')"
            >
                <Activity class="size-3.5" />
            </button>
            <button
                type="button"
                data-testid="workspace-toolbar-agents"
                class="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
                :title="t('workspace.agentManagement')"
                @click="emit('agents')"
            >
                <Bot class="size-3.5" aria-hidden="true" />
                {{ t("workspace.agentManagement") }}
            </button>
            <button
                data-testid="workspace-toolbar-add"
                class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
                :title="t('workspace.addWorkspace')"
                :aria-label="t('workspace.addWorkspace')"
                @click="emit('addWorkspace')"
            >
                <Plus class="size-3.5" />
            </button>
            <button
                data-testid="workspace-toolbar-import-source"
                class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
                :title="t('workspace.importSource')"
                :aria-label="t('workspace.importSource')"
                @click="emit('importSource')"
            >
                <FolderOpen class="size-3.5" />
            </button>
        </div>
    </div>
</template>
