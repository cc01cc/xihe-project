<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMediaQuery } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { FolderTree } from "@lucide/vue";
import {
    DOCK_MAX_TABS,
    clampDockWidth,
    defaultWorkspaceLayout,
    isDockTabId,
    readWorkspaceLayout,
    writeWorkspaceLayout,
    type DockTabId,
    type WorkspaceLayoutState,
} from "../../../composables/useWorkspaceLayout";
import { useWorkspaceStore } from "../stores/workspace";
import WorkspaceToolbar from "./WorkspaceToolbar.vue";
import WorkspaceDock from "./WorkspaceDock.vue";
import FileTreePanel from "./FileTreePanel.vue";
import FileEditor from "./FileEditor.vue";
import WorkspaceChangesPanel from "./WorkspaceChangesPanel.vue";
import SessionMonitorPanel from "../monitor/SessionMonitorPanel.vue";
import { DOCK_TAB_LABEL_KEYS, type DockTab } from "./workspaceDockTabs";

/**
 * PLAN-0582 S2: the workspace workbench skeleton. It owns the workspace-scoped
 * layout state (file tree collapse + right dock tabs/active/width/collapsed) and
 * renders the three columns; `WorkspaceView` stays a data-assembly layer.
 *
 * Invariants:
 * - one writer: this component is the only place that mutates and persists the
 *   per-workspace layout (`xihe-layout-ws:<workspaceId>`);
 * - dock state is per workspace and survives session switches (ruling: switching
 *   sessions no longer resets the auxiliary panel);
 * - the dock is closed by default and never takes flex space below 1800px
 *   (see `WorkspaceDock`); the file tree yields first, then the nav panel.
 */
const props = defineProps<{
    workspaceId: string;
    sessionId: string | null;
    agentPrincipalId?: string | null;
    isMobile: boolean;
    mobileChangesOpen?: boolean;
    mobileAuxTab?: "monitor" | "changes";
}>();

const emit = defineEmits<{
    upload: [];
    importSource: [];
    agents: [];
    addWorkspace: [];
    files: [];
    "mobile-toggle-changes": [];
    "mobile-toggle-monitor": [];
}>();

const { t } = useI18n();
const ws = useWorkspaceStore();

const layout = ref<WorkspaceLayoutState>(
    props.workspaceId ? readWorkspaceLayout(props.workspaceId) : defaultWorkspaceLayout(),
);

// Switching workspace swaps the whole per-workspace set (V11: "切 workspace 换一套").
watch(
    () => props.workspaceId,
    (workspaceId) => {
        layout.value = workspaceId ? readWorkspaceLayout(workspaceId) : defaultWorkspaceLayout();
    },
);

watch(
    layout,
    (value) => {
        if (!props.workspaceId || props.isMobile) return;
        writeWorkspaceLayout(props.workspaceId, value);
    },
    { deep: true },
);

/**
 * Yield order dock → file tree → nav panel (S2 ruling #3). The dock never takes
 * flex space below 1800px (CSS overlay in `WorkspaceDock`), so the first column
 * that has to give room is the file tree: below 1440px it starts collapsed and
 * the user can still expand it manually (a manual choice wins over the default).
 */
const narrowViewport = useMediaQuery("(max-width: 1439px)");
const treeExpandedManually = ref(false);
const effectiveTreeCollapsed = computed(() => {
    if (treeExpandedManually.value) return false;
    return layout.value.treeCollapsed || narrowViewport.value;
});

const dockOpen = computed(
    () =>
        !layout.value.dockCollapsed &&
        layout.value.dockTabs.length > 0 &&
        layout.value.activeDockTab !== null,
);
const activeDockTab = computed(() => layout.value.activeDockTab);
const codeOpen = computed(() => dockOpen.value && activeDockTab.value === "code");
const changesOpen = computed(() => dockOpen.value && activeDockTab.value === "changes");
const monitorOpen = computed(() => dockOpen.value && activeDockTab.value === "monitor");

const dockTabs = computed<DockTab[]>(() =>
    layout.value.dockTabs.map((id) => ({ id, label: t(DOCK_TAB_LABEL_KEYS[id]) })),
);

function toggleTree(): void {
    // Below 1440px the tree yields by default; an explicit expand is session-scoped
    // and does not overwrite the user's persisted preference.
    if (narrowViewport.value) {
        treeExpandedManually.value = !treeExpandedManually.value;
        return;
    }
    layout.value.treeCollapsed = !layout.value.treeCollapsed;
}

/** Opening a tab that is already open keeps it, activates it and expands the dock. */
function openDockTab(id: DockTabId): void {
    const tabs = layout.value.dockTabs;
    if (!tabs.includes(id)) {
        if (tabs.length >= DOCK_MAX_TABS) return;
        layout.value.dockTabs = [...tabs, id];
    }
    layout.value.activeDockTab = id;
    layout.value.dockCollapsed = false;
}

/** Toolbar toggles: pressing the active tab collapses the dock but keeps tabs/width. */
function toggleDockTab(id: DockTabId): void {
    if (dockOpen.value && activeDockTab.value === id) {
        layout.value.dockCollapsed = true;
        return;
    }
    openDockTab(id);
}

function setActiveDockTab(id: string): void {
    if (!isDockTabId(id) || !layout.value.dockTabs.includes(id)) return;
    layout.value.activeDockTab = id;
    layout.value.dockCollapsed = false;
}

/** Closing the last tab collapses the dock (ruling: closing the last one rolls it up). */
function closeDockTab(id: string): void {
    const remaining = layout.value.dockTabs.filter((tab) => tab !== id);
    layout.value.dockTabs = remaining;
    if (layout.value.activeDockTab === id) {
        layout.value.activeDockTab = remaining[0] ?? null;
    }
    if (remaining.length === 0) layout.value.dockCollapsed = true;
}

/** Collapse keeps the tab set and the width: collapse and width are independent. */
function collapseDock(): void {
    layout.value.dockCollapsed = true;
}

function setDockWidth(width: number): void {
    layout.value.dockWidth = clampDockWidth(width);
}

function handleToggleCode(): void {
    if (props.isMobile) return;
    toggleDockTab("code");
}

function handleToggleChanges(): void {
    if (props.isMobile) {
        emit("mobile-toggle-changes");
        return;
    }
    toggleDockTab("changes");
}

function handleToggleMonitor(): void {
    if (props.isMobile) {
        emit("mobile-toggle-monitor");
        return;
    }
    toggleDockTab("monitor");
}

// PLAN-0365 (root cause B): selecting a file must surface the editor. The editor
// now lives in the dock's `code` tab, which is closed by default.
watch(
    () => ws.activeFilePath,
    (path) => {
        if (!path || props.isMobile) return;
        openDockTab("code");
    },
);
</script>

<template>
    <div class="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceToolbar
            :workspace-id="workspaceId"
            :agent-principal-id="agentPrincipalId"
            :tree-collapsed="effectiveTreeCollapsed"
            :code-open="isMobile ? false : codeOpen"
            :changes-open="
                isMobile ? (mobileChangesOpen ?? false) && mobileAuxTab === 'changes' : changesOpen
            "
            :monitor-open="
                isMobile ? (mobileChangesOpen ?? false) && mobileAuxTab === 'monitor' : monitorOpen
            "
            @upload="emit('upload')"
            @import-source="emit('importSource')"
            @agents="emit('agents')"
            @add-workspace="emit('addWorkspace')"
            @files="emit('files')"
            @toggle-tree="toggleTree"
            @toggle-code="handleToggleCode"
            @toggle-changes="handleToggleChanges"
            @toggle-monitor="handleToggleMonitor"
        />

        <!-- Mobile keeps the editor-first body with files/chat as sheets (ruling #9). -->
        <div v-if="isMobile" class="flex min-h-0 min-w-0 flex-1 flex-col">
            <FileEditor />
        </div>

        <div v-else class="relative flex min-h-0 min-w-0 flex-1" data-testid="workspace-workbench">
            <!-- Left column: file tree (S3 moves this inside the workbench header). -->
            <div
                data-testid="workspace-file-rail"
                class="flex shrink-0 flex-col border-r bg-muted/10 transition-[width] duration-200"
                :class="effectiveTreeCollapsed ? 'w-10' : 'w-60'"
            >
                <div v-if="effectiveTreeCollapsed" class="flex flex-col items-center gap-1 py-2">
                    <button
                        type="button"
                        data-testid="workspace-tree-expand"
                        class="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        :title="t('workspace.expandFiles')"
                        :aria-label="t('workspace.expandFiles')"
                        @click="toggleTree"
                    >
                        <FolderTree class="size-4" aria-hidden="true" />
                    </button>
                </div>
                <div
                    v-else
                    class="flex h-full min-h-0 flex-1 flex-col"
                    data-testid="workspace-file-tree"
                >
                    <FileTreePanel />
                </div>
            </div>

            <!-- Center: the routed main content (chat / environment / settings). -->
            <div class="flex min-w-0 flex-1 flex-col">
                <slot name="center" />
            </div>

            <WorkspaceDock
                v-if="dockOpen && activeDockTab"
                :tabs="dockTabs"
                :active-tab="activeDockTab"
                :width="layout.dockWidth"
                @update:active-tab="setActiveDockTab"
                @close-tab="closeDockTab"
                @close="collapseDock"
                @update:width="setDockWidth"
            >
                <template #code>
                    <FileEditor />
                </template>
                <template #changes>
                    <WorkspaceChangesPanel
                        :session-id="sessionId"
                        :workspace-id="workspaceId"
                        @close="collapseDock"
                    />
                </template>
                <template #monitor>
                    <SessionMonitorPanel v-if="sessionId" :session-id="sessionId" />
                    <div v-else class="p-4 text-xs text-muted-foreground">
                        {{ t("workspace.noSession") }}
                    </div>
                </template>
            </WorkspaceDock>
        </div>
    </div>
</template>
