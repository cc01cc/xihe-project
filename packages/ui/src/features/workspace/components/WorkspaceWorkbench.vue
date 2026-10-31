<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useMediaQuery, useWindowSize } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { FolderTree, GripVertical } from "@lucide/vue";
import {
    DOCK_MAX_TABS,
    DOCK_WIDTH_DEFAULT,
    TREE_COLLAPSED_WIDTH,
    TREE_WIDTH_DEFAULT,
    TREE_WIDTH_KEYBOARD_STEP,
    TREE_WIDTH_MAX,
    TREE_WIDTH_MIN,
    clampDockWidth,
    clampTreeWidth,
    computeWorkbenchSqueeze,
    createWorkspaceLayoutWriter,
    defaultWorkspaceLayout,
    defaultWorkspaceLayoutForViewport,
    deriveDockMode,
    hasWorkspaceLayout,
    isDockTabId,
    readWorkspaceLayout,
    type DockMode,
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
    importSource: [];
    agents: [];
    addWorkspace: [];
    files: [];
    "mobile-toggle-changes": [];
    "mobile-toggle-monitor": [];
}>();

const { t } = useI18n();
const ws = useWorkspaceStore();

const { width: viewportWidth } = useWindowSize();

/**
 * P1-1 (S2 audit): a workspace that has no stored layout yet opens `monitor` by
 * default on wide screens (≥1800); once the user collapses or switches, the
 * persisted state wins and this default never overrides it again.
 */
function initialLayout(workspaceId: string): WorkspaceLayoutState {
    if (!workspaceId) return defaultWorkspaceLayout();
    if (!hasWorkspaceLayout(workspaceId)) {
        return defaultWorkspaceLayoutForViewport(viewportWidth.value);
    }
    const stored = readWorkspaceLayout(workspaceId);
    // "≥1800 opens the monitor" is a first-run policy only: once the user closed the
    // dock themselves the stored state is the truth (S2 audit P1-1).
    return stored.dockPolicyDismissed ? { ...stored, dockCollapsed: true } : stored;
}

const layout = ref<WorkspaceLayoutState>(initialLayout(props.workspaceId));
let layoutWriter = createWorkspaceLayoutWriter(props.workspaceId || "");

// Switching workspace swaps the whole per-workspace set (V11: "切 workspace 换一套").
watch(
    () => props.workspaceId,
    (workspaceId) => {
        // Persist the outgoing workspace's pending drag before rebinding the writer.
        layoutWriter.flush();
        layoutWriter = createWorkspaceLayoutWriter(workspaceId || "");
        layout.value = initialLayout(workspaceId);
        // P0-1/P1-2 (S2 audit): never carry open file buffers or a stale tree
        // across workspaces. S3a audit P0: this reset must run on mobile too — the
        // mobile sheet renders the tree and the editor, so skipping it would save
        // workspace A's buffer into workspace B. Only the tree prefetch is
        // desktop-only (the mobile sheet loads the tree on demand).
        ws.resetWorkspaceScoped();
        if (props.isMobile) return;
        void ws.loadTree();
    },
);

watch(
    layout,
    (value) => {
        if (!props.workspaceId || props.isMobile) return;
        // P2-9: coalesce drag writes; `flush()` on unmount/switch keeps the last one.
        layoutWriter.schedule(value);
    },
    { deep: true },
);

onBeforeUnmount(() => layoutWriter.flush());

/**
 * Yield order dock → file tree → nav panel (S2 ruling #3). The dock never takes
 * flex space below 1800px (CSS overlay in `WorkspaceDock`), so the first column
 * that has to give room is the file tree: below 1440px it starts collapsed and
 * the user can still expand it manually (a manual choice wins over the default).
 */

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

const narrowViewport = useMediaQuery("(max-width: 1439px)");
const treeExpandedManually = ref(false);

// S3b §4: the anti-squeeze rules need the real row width, so measure the workbench
// element instead of re-deriving it from the viewport (the nav panel offset is
// owned by AppLayout and the dock width is user-dragged).
const workbenchEl = ref<HTMLElement | null>(null);
const workbenchWidth = ref(0);
let workbenchObserver: ResizeObserver | null = null;

watch(
    workbenchEl,
    (element) => {
        workbenchObserver?.disconnect();
        workbenchObserver = null;
        if (!element || typeof ResizeObserver === "undefined") return;
        workbenchObserver = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry) workbenchWidth.value = entry.contentRect.width;
        });
        workbenchObserver.observe(element);
        workbenchWidth.value = element.getBoundingClientRect().width;
    },
    { immediate: true },
);

onBeforeUnmount(() => workbenchObserver?.disconnect());

const dockMode = computed<DockMode>(() =>
    layout.value.dockModeManual ? layout.value.dockMode : deriveDockMode(viewportWidth.value),
);

const squeeze = computed(() =>
    computeWorkbenchSqueeze({
        workbenchWidth: workbenchWidth.value || viewportWidth.value,
        treeWidth: layout.value.treeWidth,
        treeCollapsed: layout.value.treeCollapsed,
        dockWidth: layout.value.dockWidth,
        dockOpen: dockOpen.value,
        dockMode: dockMode.value,
    }),
);

/** Rendered dock mode: forced floating wins over the user's pinned choice. */
const renderedDockMode = computed<DockMode>(() =>
    squeeze.value.forceFloating ? "floating" : dockMode.value,
);
/** True when the pinned choice is being overruled so the UI can say why. */
const dockModeOverruled = computed(
    () => squeeze.value.forceFloating && dockMode.value === "pinned",
);

const effectiveTreeCollapsed = computed(() => {
    if (treeExpandedManually.value) return false;
    if (squeeze.value.treeYielded) return true;
    return layout.value.treeCollapsed || narrowViewport.value;
});

const treeWidth = computed(() => layout.value.treeWidth);
const treeResizingWidth = ref<number | null>(null);

function setTreeWidth(width: number): void {
    layout.value.treeWidth = clampTreeWidth(width);
}

/** P2-1 (tree): double-clicking the handle restores the default width. */
function resetTreeWidth(): void {
    setTreeWidth(TREE_WIDTH_DEFAULT);
}

function handleTreeResizeStart(event: MouseEvent): void {
    event.preventDefault();
    const startX = event.clientX,
        startWidth = layout.value.treeWidth;
    treeResizingWidth.value = startWidth;

    function onMouseMove(moveEvent: MouseEvent) {
        const next = clampTreeWidth(startWidth + (moveEvent.clientX - startX));
        treeResizingWidth.value = next;
        setTreeWidth(next);
    }

    function onMouseUp() {
        treeResizingWidth.value = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
}

function handleTreeResizeKeydown(event: KeyboardEvent): void {
    let next: number | null = null;
    if (event.key === "ArrowRight") next = layout.value.treeWidth + TREE_WIDTH_KEYBOARD_STEP;
    else if (event.key === "ArrowLeft") next = layout.value.treeWidth - TREE_WIDTH_KEYBOARD_STEP;
    else if (event.key === "Home") next = TREE_WIDTH_MIN;
    else if (event.key === "End") next = TREE_WIDTH_MAX;
    if (next === null) return;
    event.preventDefault();
    setTreeWidth(next);
}

/** Pin/unpin is an explicit user choice: it wins over the breakpoint derivation. */
function toggleDockMode(): void {
    layout.value.dockMode = dockMode.value === "pinned" ? "floating" : "pinned";
    layout.value.dockModeManual = true;
}

// §4 rule 3 must not be silent: one toast per transition into forced floating.
// `immediate` matters — a window that is already too narrow on first paint would
// otherwise be forced floating without any explanation.
let squeezeToastShown = false;
watch(
    dockModeOverruled,
    (overruled) => {
        if (overruled && !squeezeToastShown) {
            squeezeToastShown = true;
            toast.warning(t("workspace.squeezeFloatingNotice"));
            return;
        }
        if (!overruled) squeezeToastShown = false;
    },
    { immediate: true },
);

// Floating is not a modal (Lead ruling 2026-10-31): no backdrop, dismiss with Esc
// or by clicking the main column instead.
function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (!dockOpen.value || renderedDockMode.value !== "floating") return;
    collapseDock();
}

if (typeof window !== "undefined") {
    window.addEventListener("keydown", handleWindowKeydown);
    onBeforeUnmount(() => window.removeEventListener("keydown", handleWindowKeydown));
}

/** Clicking the main column dismisses a floating dock (no overlay to click). */
function handleMainColumnPointerDown(): void {
    if (!dockOpen.value || renderedDockMode.value !== "floating") return;
    collapseDock();
}

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
        layout.value.dockPolicyDismissed = true;
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
    if (remaining.length === 0) {
        layout.value.dockCollapsed = true;
        layout.value.dockPolicyDismissed = true;
    }
}

/** Collapse keeps the tab set and the width: collapse and width are independent. */
function collapseDock(): void {
    layout.value.dockCollapsed = true;
    // S2 audit P1-1: an explicit close wins over "≥1800 opens monitor by default".
    layout.value.dockPolicyDismissed = true;
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
            :code-open="isMobile ? false : codeOpen"
            :changes-open="
                isMobile ? (mobileChangesOpen ?? false) && mobileAuxTab === 'changes' : changesOpen
            "
            :monitor-open="
                isMobile ? (mobileChangesOpen ?? false) && mobileAuxTab === 'monitor' : monitorOpen
            "
            @import-source="emit('importSource')"
            @agents="emit('agents')"
            @add-workspace="emit('addWorkspace')"
            @files="emit('files')"
            @toggle-code="handleToggleCode"
            @toggle-changes="handleToggleChanges"
            @toggle-monitor="handleToggleMonitor"
        />

        <!-- Mobile keeps the editor-first body with files/chat as sheets (ruling #9). -->
        <div v-if="isMobile" class="flex min-h-0 min-w-0 flex-1 flex-col">
            <FileEditor />
        </div>

        <div
            v-else
            ref="workbenchEl"
            class="relative flex min-h-0 min-w-0 flex-1"
            data-testid="workspace-workbench"
        >
            <!-- Left column: the file tree. S3b: draggable 200-320 + keyboard + dblclick. -->
            <div
                data-testid="workspace-file-rail"
                class="relative flex shrink-0 flex-col border-r border-border-subtle bg-surface-canvas"
                :style="{
                    width: `${effectiveTreeCollapsed ? TREE_COLLAPSED_WIDTH : treeWidth}px`,
                }"
            >
                <div v-if="effectiveTreeCollapsed" class="flex flex-col items-center gap-1 py-2">
                    <button
                        type="button"
                        data-testid="workspace-tree-expand"
                        class="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        :title="t('workspace.expandFiles')"
                        :aria-label="t('workspace.expandFiles')"
                        :aria-pressed="false"
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
                    <!-- S3a: tree panel head (workspace name / file actions / collapse). -->
                    <FileTreePanel @collapse="toggleTree" />
                </div>

                <!-- P2-2: live width bubble (display-only; the write is throttled). -->
                <span
                    v-if="treeResizingWidth !== null"
                    data-testid="tree-resize-bubble"
                    aria-hidden="true"
                    class="pointer-events-none absolute -right-1 top-1/2 z-30 translate-x-full -translate-y-1/2 rounded bg-foreground/85 px-1.5 py-0.5 text-[11px] tabular-nums text-background"
                >
                    {{ treeResizingWidth }}px
                </span>
                <div
                    v-if="!effectiveTreeCollapsed"
                    role="separator"
                    aria-orientation="vertical"
                    :aria-label="t('workspace.treeResize')"
                    :aria-valuenow="treeWidth"
                    :aria-valuemin="TREE_WIDTH_MIN"
                    :aria-valuemax="TREE_WIDTH_MAX"
                    tabindex="0"
                    data-testid="tree-resizer"
                    class="absolute -right-0.5 top-0 bottom-0 w-1 cursor-col-resize transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:outline-none"
                    @mousedown="handleTreeResizeStart"
                    @dblclick="resetTreeWidth"
                    @keydown="handleTreeResizeKeydown"
                >
                    <span
                        class="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-muted-foreground/40"
                        aria-hidden="true"
                    >
                        <GripVertical class="size-3" />
                    </span>
                </div>
            </div>

            <!-- Center: the routed main content (chat / environment / settings). -->
            <div
                class="flex min-w-0 flex-1 flex-col bg-surface-content"
                @mousedown="handleMainColumnPointerDown"
            >
                <slot name="center" />
            </div>

            <WorkspaceDock
                v-if="dockOpen && activeDockTab"
                :tabs="dockTabs"
                :active-tab="activeDockTab"
                :width="layout.dockWidth"
                :mode="renderedDockMode"
                :default-width="DOCK_WIDTH_DEFAULT"
                @update:active-tab="setActiveDockTab"
                @close-tab="closeDockTab"
                @close="collapseDock"
                @update:width="setDockWidth"
                @toggle-mode="toggleDockMode"
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
