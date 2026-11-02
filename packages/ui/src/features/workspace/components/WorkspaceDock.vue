<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, Pin, PinOff, X } from "@lucide/vue";
import {
    DOCK_WIDTH_DEFAULT,
    DOCK_WIDTH_KEYBOARD_STEP,
    DOCK_WIDTH_MAX,
    DOCK_WIDTH_MIN,
    clampDockWidth,
} from "../../../composables/useWorkspaceLayout";
import type { DockTab } from "./workspaceDockTabs";

/**
 * PLAN-0582 S2: the right dock. Presentation only — the open tab set, the active
 * tab, the width and the collapsed flag are owned by `WorkspaceWorkbench`
 * (single writer), so this component never persists anything itself.
 *
 * PLAN-0582 S3b: the pinned/floating mode is a prop (derived + user override live
 * in the workbench/layout composable), so the `min-[1800px]:*` Tailwind classes are
 * gone — the single source of truth for the breakpoint is
 * `DOCK_INLINE_MIN_VIEWPORT`, and this component only renders its projection.
 *
 * Floating is deliberately **not** a modal: no backdrop (it would block the main
 * column the user is editing), only a shadow, Esc and click-outside to dismiss.
 *
 * PLAN-0626 D26-10: every tab chip is a wrapper holding two sibling controls (the
 * `role=tab` button and its close button). Nothing interactive is nested inside a
 * tab any more, so Enter/Space work through native button semantics instead of
 * hand-rolled keydown handlers (a11y spec §基线 1, `spec/ui/accessibility.md:11-15`).
 */
const props = withDefaults(
    defineProps<{
        tabs: DockTab[];
        activeTab: string;
        width: number;
        /** Pinned = flex child (never covers content); floating = overlay. */
        mode?: "pinned" | "floating";
        /** Width restored by the resizer double-click (P2-1). */
        defaultWidth?: number;
        /** Tabs rendered in the strip before they move into the overflow menu. */
        maxVisibleTabs?: number;
    }>(),
    { maxVisibleTabs: 3, mode: "floating", defaultWidth: DOCK_WIDTH_DEFAULT },
);

const emit = defineEmits<{
    "update:activeTab": [id: string];
    "close-tab": [id: string];
    close: [];
    "update:width": [width: number];
    "toggle-mode": [];
}>();

const { t } = useI18n();
const overflowOpen = ref(false);
/** Live width shown in the drag bubble; never persisted (the write is throttled). */
const resizingWidth = ref<number | null>(null);

const isPinned = computed(() => props.mode === "pinned");
const modeLabel = computed(() =>
    isPinned.value ? t("workspace.dockModePinned") : t("workspace.dockModeFloating"),
);
const panelClass = computed(() => [
    "flex h-full shrink-0 flex-col border-l border-border-subtle bg-surface-canvas",
    isPinned.value ? "relative z-auto shadow-none" : "absolute inset-y-0 right-0 z-20 shadow-xl",
]);

const visibleTabs = computed(() => props.tabs.slice(0, props.maxVisibleTabs));
const overflowTabs = computed(() => props.tabs.slice(props.maxVisibleTabs));
const hasOverflow = computed(() => overflowTabs.value.length > 0);

function selectTab(id: string) {
    overflowOpen.value = false;
    emit("update:activeTab", id);
}

function closeTab(id: string) {
    overflowOpen.value = false;
    emit("close-tab", id);
}

/**
 * Middle click closes a tab (ruling from the S2 brief). `auxclick` covers mouse
 * middle button; `button === 1` guards against right-click click events.
 */
function handleTabAuxClick(event: MouseEvent, id: string) {
    if (event.button !== 1) return;
    event.preventDefault();
    closeTab(id);
}

function handleResizeStart(event: MouseEvent) {
    event.preventDefault();
    const startX = event.clientX,
        startWidth = props.width;

    resizingWidth.value = startWidth;

    function onMouseMove(moveEvent: MouseEvent) {
        // The dock sits on the right edge: dragging left widens it.
        const next = clampDockWidth(startWidth - (moveEvent.clientX - startX));
        resizingWidth.value = next;
        emit("update:width", next);
    }

    function onMouseUp() {
        resizingWidth.value = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
}

/** P2-1: double-clicking the handle restores the default width. */
function resetWidth() {
    emit("update:width", clampDockWidth(props.defaultWidth));
}

function handleResizeKeydown(event: KeyboardEvent) {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = props.width + DOCK_WIDTH_KEYBOARD_STEP;
    else if (event.key === "ArrowRight") next = props.width - DOCK_WIDTH_KEYBOARD_STEP;
    else if (event.key === "Home") next = DOCK_WIDTH_MIN;
    else if (event.key === "End") next = DOCK_WIDTH_MAX;
    if (next === null) return;
    event.preventDefault();
    emit("update:width", clampDockWidth(next));
}
</script>

<template>
    <aside
        data-testid="workspace-aux-panel"
        :data-dock-mode="mode"
        :aria-label="t('workspace.dockTabs')"
        :class="panelClass"
        :style="{ width: `${width}px` }"
    >
        <div
            role="separator"
            aria-orientation="vertical"
            :aria-label="t('workspace.dockResize')"
            :aria-valuenow="width"
            :aria-valuemin="DOCK_WIDTH_MIN"
            :aria-valuemax="DOCK_WIDTH_MAX"
            tabindex="0"
            data-testid="dock-resizer"
            class="absolute left-0 top-0 bottom-0 w-1 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:outline-none"
            @dblclick="resetWidth"
            @mousedown="handleResizeStart"
            @keydown="handleResizeKeydown"
        />

        <!-- P2-2: the live width bubble; display-only, never persisted. -->
        <span
            v-if="resizingWidth !== null"
            data-testid="dock-resize-bubble"
            aria-hidden="true"
            class="pointer-events-none absolute left-0 top-1/2 z-30 -translate-x-full -translate-y-1/2 rounded bg-foreground/85 px-1.5 py-0.5 text-[11px] tabular-nums text-background"
        >
            {{ resizingWidth }}px
        </span>

        <div class="flex h-9 shrink-0 items-center gap-1 border-b pl-2 pr-1 text-xs">
            <div
                role="tablist"
                :aria-label="t('workspace.dockTabs')"
                class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
            >
                <!--
                    PLAN-0626 D26-10: the chip is a wrapper because a tab and its close
                    affordance are two sibling controls. Nesting a `role=button` span (or a
                    second `<button>`) inside `role=tab` produced a nested-interactive element
                    with hand-rolled Enter/Space handlers; the same shape already exists in
                    `WorkspaceTabBar.vue`, so this is a reuse, not a new pattern.
                -->
                <div
                    v-for="tab in visibleTabs"
                    :key="tab.id"
                    class="inline-flex shrink-0 items-center rounded transition-colors"
                    :class="
                        tab.id === activeTab
                            ? 'bg-accent text-foreground'
                            : 'text-muted-foreground hover:bg-accent'
                    "
                >
                    <button
                        type="button"
                        role="tab"
                        :data-testid="`dock-tab-${tab.id}`"
                        :aria-selected="tab.id === activeTab"
                        class="inline-flex min-w-0 items-center gap-1 rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        :class="tab.id === activeTab ? 'font-medium' : ''"
                        @click="selectTab(tab.id)"
                        @auxclick="handleTabAuxClick($event, tab.id)"
                    >
                        <span class="max-w-28 truncate">{{ tab.label }}</span>
                    </button>
                    <button
                        v-if="tab.id === activeTab"
                        type="button"
                        :data-testid="`dock-tab-close-${tab.id}`"
                        :aria-label="t('workspace.dockCloseTab')"
                        :title="t('workspace.dockCloseTab')"
                        class="mr-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        @click.stop="closeTab(tab.id)"
                    >
                        <X class="size-3" aria-hidden="true" />
                    </button>
                </div>
            </div>

            <div v-if="hasOverflow" class="relative shrink-0">
                <button
                    type="button"
                    data-testid="dock-overflow-trigger"
                    class="inline-flex items-center gap-0.5 rounded px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent"
                    :aria-label="t('workspace.dockOverflow')"
                    :title="t('workspace.dockOverflow')"
                    :aria-expanded="overflowOpen"
                    @click="overflowOpen = !overflowOpen"
                >
                    <ChevronDown class="size-3.5" aria-hidden="true" />
                    <span class="tabular-nums">{{ overflowTabs.length }}</span>
                </button>
                <div
                    v-if="overflowOpen"
                    data-testid="dock-overflow-menu"
                    class="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border bg-popover p-1 text-sm shadow-md"
                >
                    <div
                        v-for="tab in overflowTabs"
                        :key="tab.id"
                        class="flex w-full items-center justify-between gap-1 rounded hover:bg-accent"
                    >
                        <button
                            type="button"
                            :data-testid="`dock-overflow-item-${tab.id}`"
                            class="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            @click="selectTab(tab.id)"
                        >
                            {{ tab.label }}
                        </button>
                        <button
                            type="button"
                            :data-testid="`dock-overflow-close-${tab.id}`"
                            :aria-label="t('workspace.dockCloseTab')"
                            :title="t('workspace.dockCloseTab')"
                            class="mr-1 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            @click.stop="closeTab(tab.id)"
                        >
                            <X class="size-3" aria-hidden="true" />
                        </button>
                    </div>
                </div>
            </div>

            <button
                type="button"
                data-testid="dock-mode-toggle"
                class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :class="isPinned ? 'text-brand' : ''"
                :aria-pressed="isPinned"
                :aria-label="modeLabel"
                :title="`${modeLabel} · ${t('workspace.dockModeToggleHint')}`"
                @click="emit('toggle-mode')"
            >
                <Pin v-if="isPinned" class="size-3.5" aria-hidden="true" />
                <PinOff v-else class="size-3.5" aria-hidden="true" />
            </button>
            <button
                type="button"
                data-testid="workspace-aux-close"
                class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :aria-label="t('workspace.closePanel')"
                :title="t('workspace.closePanel')"
                @click="emit('close')"
            >
                <X class="size-3.5" aria-hidden="true" />
            </button>
        </div>

        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
            <slot :name="activeTab" />
        </div>
    </aside>
</template>
