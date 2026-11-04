<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { useMediaQuery, useWindowSize } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { FolderTree, GripVertical } from "@lucide/vue";
import {
    DOCK_WIDTH_DEFAULT,
    TREE_COLLAPSED_WIDTH,
    TREE_WIDTH_DEFAULT,
    TREE_WIDTH_KEYBOARD_STEP,
    TREE_WIDTH_MAX,
    TREE_WIDTH_MIN,
    canOpenDockTab,
    clampDockWidth,
    clampTreeWidth,
    WORKSPACE_LAYOUT_KEY,
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
    type WorkbenchSqueezeDemand,
    type WorkbenchSqueezeResult,
    type WorkspaceLayoutState,
} from "../../../composables/useWorkspaceLayout";
import { useLiveResize } from "../../../composables/useLiveResize";
import { useWorkspaceStore } from "../stores/workspace";
import WorkspaceToolbar from "./WorkspaceToolbar.vue";
import WorkspaceDock from "./WorkspaceDock.vue";
import FileTreePanel from "./FileTreePanel.vue";
import FileEditor from "./FileEditor.vue";
import WorkspaceChangesPanel from "./WorkspaceChangesPanel.vue";
import SessionMonitorPanel from "../monitor/SessionMonitorPanel.vue";
import SessionParticipantsPanel from "./SessionParticipantsPanel.vue";
import SessionContextPanel from "./SessionContextPanel.vue";
import WorkspaceAgentsPanel from "./WorkspaceAgentsPanel.vue";
import DelegationDagPanel from "../chat/components/DelegationDagPanel.vue";
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
    /** PLAN-0623：参与者面板的「提及」冒泡到页面层，由它转给 composer。 */
    mention: [name: string];
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
    // "≥1800 opens the monitor" is a **first-run** policy: it only applies while no
    // geometry is stored. S3b P1-1 (audit): there is deliberately no dismissal latch
    // — a stored `dockCollapsed` is already the user's own choice, and a latch would
    // keep overriding an explicit re-open on every reload.
    if (!hasWorkspaceLayout(workspaceId)) {
        return defaultWorkspaceLayoutForViewport(viewportWidth.value);
    }
    return readWorkspaceLayout(workspaceId);
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
if (typeof window !== "undefined") {
    // S3b P2 (audit): a reload/close within the coalescing window would drop the last
    // write, which reads as "my close was treated as the default". Mirror the
    // `beforeunload` flush pattern used for the logger (main.ts).
    window.addEventListener("pagehide", () => layoutWriter.flush());
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") layoutWriter.flush();
    });
}

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
/** PLAN-0623 U1：参与者面板与 monitor 同构（按会话挂载），tab 默认不打开。 */
const membersOpen = computed(() => dockOpen.value && activeDockTab.value === "members");
/** PLAN-0659 T1.4：委派 DAG 面板（同样按会话挂载，tab 默认不打开）。 */
const delegationOpen = computed(() => dockOpen.value && activeDockTab.value === "delegation");

const dockTabs = computed<DockTab[]>(() =>
    layout.value.dockTabs.map((id) => ({ id, label: t(DOCK_TAB_LABEL_KEYS[id]) })),
);

const narrowViewport = useMediaQuery("(max-width: 1439px)");
const treeExpandedManually = ref(false);

const dockMode = computed<DockMode>(() =>
    layout.value.dockModeManual ? layout.value.dockMode : deriveDockMode(viewportWidth.value),
);

/**
 * S3b P1-2 (audit): the squeeze must consume the tree state **as rendered**. The
 * previous version fed the persisted `treeCollapsed` while the manual expansion
 * short-circuited outside of it, so the computed `mainWidth` assumed a 40px rail
 * that was actually 240px — the toast lied and the 640 floor could be breached.
 */
const treeCollapsedForSqueeze = computed(() =>
    treeExpandedManually.value ? false : layout.value.treeCollapsed || narrowViewport.value,
);

/**
 * S5-W2: the squeeze itself is owned by `useWorkspaceLayout` (single geometry
 * truth: it knows the viewport, the rail/panel offset and therefore whether the
 * navigation panel has to yield). This component only publishes the workbench-side
 * demand and reads the result back. When no layout provider exists (isolated unit
 * tests), it falls back to the same pure function with no nav panel to yield.
 */
const layoutOwner = inject(WORKSPACE_LAYOUT_KEY, null);

/**
 * PLAN-0626 D26-04: in focus mode the main column is not laid out at all (it stays
 * mounted but hidden), so there is nothing to protect. Publishing a demand would let
 * the anti-squeeze rules collapse the tree or force the dock back to floating for a
 * column nobody can see; `null` means "this workbench needs no width arbitration".
 */
const demand = computed<WorkbenchSqueezeDemand | null>(() => {
    if (layout.value.dockFocus && dockOpen.value) return null;
    return {
        treeWidth: layout.value.treeWidth,
        treeCollapsed: treeCollapsedForSqueeze.value,
        dockWidth: layout.value.dockWidth,
        dockOpen: dockOpen.value,
        dockMode: dockMode.value,
        // A manual expansion is an explicit choice: no automatic yielding, the dock
        // goes floating instead (the hard floor still overrides if that is not enough).
        allowTreeYield: !treeExpandedManually.value,
    };
});

watch(demand, (value) => layoutOwner?.setWorkbenchDemand(value), { immediate: true });
onBeforeUnmount(() => layoutOwner?.setWorkbenchDemand(null));

const squeeze = computed<WorkbenchSqueezeResult>(() => {
    if (layoutOwner) return layoutOwner.squeeze.value;
    const offset = viewportWidth.value || 0,
        currentDemand = demand.value;
    if (!currentDemand) {
        // Focus: nothing to squeeze (mirrors the owner's "no demand" result).
        return { mainWidth: offset, treeYielded: false, navYielded: false, forceFloating: false };
    }
    return computeWorkbenchSqueeze({
        workbenchWidth: offset,
        ...currentDemand,
        navPanelWidth: 0,
    });
});

/** Rendered dock mode: forced floating wins over the user's pinned choice. */
const renderedDockMode = computed<DockMode>(() =>
    squeeze.value.forceFloating ? "floating" : dockMode.value,
);
/** True when the pinned choice is being overruled so the UI can say why. */
const dockModeOverruled = computed(
        () => squeeze.value.forceFloating && dockMode.value === "pinned",
    ),
    /**
     * D26-04: the render projection of the focus flag. It only holds while the dock is
     * actually rendered — a stored `dockFocus` without an open dock cannot hide the main
     * column (that would be an empty workbench).
     */
    dockFocus = computed(() => dockOpen.value && layout.value.dockFocus);

const effectiveTreeCollapsed = computed(
    () => treeCollapsedForSqueeze.value || squeeze.value.treeYielded,
);

const treeWidth = computed(() => layout.value.treeWidth);
const treeRailRef = ref<HTMLElement | null>(null);
const treeBubbleRef = ref<HTMLElement | null>(null);

function setTreeWidth(width: number): void {
    layout.value.treeWidth = clampTreeWidth(width);
}

/** Resize-follow fix: the rail follows the pointer directly; the store sees one write. */
const { resizingWidth: treeResizingWidth, start: handleTreeResizeStart } = useLiveResize({
    clamp: clampTreeWidth,
    currentWidth: () => layout.value.treeWidth,
    grow: "right",
    commit: (width) => setTreeWidth(width),
    panel: treeRailRef,
    bubble: treeBubbleRef,
});

/** P2-1 (tree): double-clicking the handle restores the default width. */
function resetTreeWidth(): void {
    setTreeWidth(TREE_WIDTH_DEFAULT);
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

/**
 * Escape typed into a field belongs to that field (rename, search, composer), not to
 * the dock; an open dialog likewise owns Escape for its own dismissal.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Floating is not a modal (Lead ruling 2026-10-31): no backdrop, dismiss with Esc
// or by clicking the main column instead.
function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // An open dialog closes itself on Escape; do not also collapse the dock behind it.
    if (document.querySelector('[data-testid="modal-backdrop"]')) return;
    // Escape in a text field cancels that field's interaction, not the dock.
    if (isTextEntryTarget(event.target)) return;
    // PLAN-0626 D26-04: focus fills the row, so it needs a keyboard exit even though it
    // is laid out as a flex child (the floating-only rule below would ignore it).
    // Esc restores the previous layout instead of rolling the dock up.
    if (dockFocus.value) {
        exitDockFocus();
        return;
    }
    // A pinned panel is a deliberate layout choice: Escape must not close it, and a
    // squeeze-forced floating panel keeps the same body of behaviour (rendered mode).
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
        // PLAN-0626 D26-06: the cap is a visible refusal, never a silent no-op.
        if (!canOpenDockTab(tabs.length)) {
            toast.warning(t("workspace.dockTabsFull"));
            return;
        }
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

/**
 * Closing the last tab collapses the dock (ruling: closing the last one rolls it up).
 *
 * PLAN-0626 D26-13: closing the *active* tab activates its **nearest neighbour** (right
 * first, then left) — the browser-tab convention. Falling back to the first tab made
 * "close the 5th of 6" snap the dock back to the far left of the strip.
 */
function closeDockTab(id: string): void {
    const tabs = layout.value.dockTabs,
        // An unknown id stays a no-op (the dock renders string-generic ids).
        closingIndex = isDockTabId(id) ? tabs.indexOf(id) : -1,
        remaining = tabs.filter((tab) => tab !== id);
    if (closingIndex < 0) return;
    layout.value.dockTabs = remaining;
    if (layout.value.activeDockTab === id) {
        // After the filter `remaining[closingIndex]` is the tab that used to sit on the
        // right of the closed one; it is absent only when the closed tab was last.
        layout.value.activeDockTab = remaining[closingIndex] ?? remaining[closingIndex - 1] ?? null;
    }
    if (remaining.length === 0) {
        layout.value.dockCollapsed = true;
        layout.value.dockFocus = false;
    }
}

/** Collapse keeps the tab set and the width: collapse and width are independent. */
function collapseDock(): void {
    // Collapsing is itself the stored truth: `initialLayout` only applies the
    // "≥1800 opens the monitor" default while no geometry exists (S3b P1-1).
    layout.value.dockCollapsed = true;
    // D26-05/D26-04: collapsing the dock also leaves focus — one action, never a
    // half state where "focused" survives a hidden panel.
    layout.value.dockFocus = false;
}

/**
 * PLAN-0626 D26-04: expand/restore the dock across the whole workbench row.
 * Orthogonal to pinned/floating and to the width: both keep their values and simply
 * become visible again on restore.
 */
function toggleDockFocus(): void {
    if (!dockOpen.value) return;
    layout.value.dockFocus = !layout.value.dockFocus;
}

/** Esc/restore path: leaves focus only (never collapses the dock). */
function exitDockFocus(): void {
    layout.value.dockFocus = false;
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

/**
 * PLAN-0626 M2: the chat column is rendered by the page (this component's `#center`
 * slot), so the "open the settings panel" entry has to reach the dock from outside.
 * The page calls this through a template ref — the same shape it already uses in the
 * opposite direction (`ChatPanel` exposes `insertMention`).
 */
defineExpose({ openDockTab });
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
            :members-open="isMobile ? false : membersOpen"
            :delegation-open="isMobile ? false : delegationOpen"
            @import-source="emit('importSource')"
            @agents="emit('agents')"
            @add-workspace="emit('addWorkspace')"
            @files="emit('files')"
            @toggle-code="handleToggleCode"
            @toggle-changes="handleToggleChanges"
            @toggle-monitor="handleToggleMonitor"
            @toggle-members="toggleDockTab('members')"
            @toggle-delegation="toggleDockTab('delegation')"
        />

        <!-- Mobile keeps the editor-first body with files/chat as sheets (ruling #9). -->
        <div v-if="isMobile" class="flex min-h-0 min-w-0 flex-1 flex-col">
            <FileEditor />
        </div>

        <div v-else class="relative flex min-h-0 min-w-0 flex-1" data-testid="workspace-workbench">
            <!-- Left column: the file tree. S3b: draggable 200-320 + keyboard + dblclick. -->
            <div
                ref="treeRailRef"
                data-testid="workspace-file-rail"
                class="relative flex shrink-0 flex-col border-r border-border-subtle bg-surface-canvas"
                :class="{ 'is-resizing': treeResizingWidth !== null }"
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
                    ref="treeBubbleRef"
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

            <!--
                Center: the routed main content (chat / environment / settings).
                D26-04: focus hides this column with `v-show` (never `v-if`) — unmounting
                ChatPanel would drop its SSE subscription and the streaming state mid-run
                (`useSSE.ts:555-557`), so the column stays mounted and merely stops taking
                layout space.
            -->
            <div
                v-show="!dockFocus"
                class="flex min-w-0 flex-1 flex-col bg-surface-content"
                :data-main-hidden="dockFocus ? 'true' : 'false'"
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
                :focus="dockFocus"
                @update:active-tab="setActiveDockTab"
                @close-tab="closeDockTab"
                @close="collapseDock"
                @update:width="setDockWidth"
                @toggle-mode="toggleDockMode"
                @toggle-focus="toggleDockFocus"
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
                <template #members>
                    <!-- PLAN-0623 U1：按会话挂载；无会话时面板自身渲染 participants-empty。 -->
                    <SessionParticipantsPanel
                        :session-id="sessionId ?? null"
                        @mention="emit('mention', $event)"
                    />
                </template>
                <template #context>
                    <!-- PLAN-0626 M2：会话设置（粘性面板，无会话时面板自身给空态）。 -->
                    <SessionContextPanel :session-id="sessionId ?? null" />
                </template>
                <template #delegation>
                    <!-- PLAN-0659 T1.4：委派 DAG（父→子会话，状态/深度/预算）。 -->
                    <DelegationDagPanel v-if="sessionId" :session-id="sessionId" />
                    <div v-else class="p-4 text-xs text-muted-foreground">
                        {{ t("workspace.noSession") }}
                    </div>
                </template>
                <template #agents>
                    <!--
                        PLAN-0626 M3 (D26-05)：工作区 Agent 管理。`key` forces a remount when the
                        workspace changes, so the list/capability projection is never carried over
                        (the old dialog reloaded on every open).
                    -->
                    <WorkspaceAgentsPanel :key="workspaceId" :workspace-id="workspaceId" />
                </template>
            </WorkspaceDock>
        </div>
    </div>
</template>

<style scoped>
/*
 * Resize-follow fix for the file rail: same contract as the dock/sidebar — the rail
 * follows the pointer via a direct width write and its content stops hit-testing.
 */
.is-resizing {
    will-change: width;
}

.is-resizing :deep(*) {
    pointer-events: none;
}
</style>
