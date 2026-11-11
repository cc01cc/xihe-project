<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { VueDraggable } from "vue-draggable-plus";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { X } from "@lucide/vue";
// BL-476 L1 pilot: the hand-rolled `role="tablist"` markup is replaced by the
// vendored reka `Tabs` primitives (see src/components/ui/VENDOR.md); reka owns
// role/aria-selected/roving-focus, the bar keeps owning navigation + persistence.
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import {
    WORKSPACE_TAB_IDS,
    defaultOpenTabs,
    readWorkspaceLayout,
    writeWorkspaceOpenTabs,
    type WorkspaceTabId,
} from "../../../composables/useWorkspaceLayout";
import { useSessionStore } from "../../../stores/session";
import { workspaceChatPath, workspacePath } from "../../../lib/routes";

/**
 * PLAN-0582 S3a: the middle tab bar is a **pure projection of the existing
 * routes** — `/workspace/:ws`, `/chat/:sid`, `/environment`, `/scheduled-tasks`,
 * `/settings`. No new routes, no `beforeEach` interception: clicking a tab only
 * calls `router.push`, so deep links, back/forward and bookmarks stay the truth.
 *
 * The chat tab is always present (it is the fallback when a tab is closed); the
 * other three form an "open set" persisted per workspace. Visiting a route adds
 * its tab, closing it removes it and falls back to the chat tab.
 */
const props = defineProps<{
    workspaceId: string;
    sessionId: string | null;
}>();

const route = useRoute(),
    router = useRouter(),
    sessionStore = useSessionStore();
const { t } = useI18n();

interface RouteTab {
    id: "chat" | WorkspaceTabId;
    label: string;
    path: string;
    testid: string;
    closable: boolean;
}

const tabPaths = computed<Record<WorkspaceTabId, string>>(() => ({
    environment: `/workspace/${props.workspaceId}/environment`,
    "scheduled-tasks": `/workspace/${props.workspaceId}/scheduled-tasks`,
    settings: `/workspace/${props.workspaceId}/settings`,
}));

const chatPath = computed(() =>
    props.sessionId
        ? workspaceChatPath(props.workspaceId, props.sessionId)
        : workspacePath(props.workspaceId),
);

const sessionTitle = computed(() => {
    const session = sessionStore.currentSession;
    if (session && props.sessionId && session.id === props.sessionId) return session.title;
    return t("workspace.tabChatFallback");
});

const openTabs = ref<WorkspaceTabId[]>(
    props.workspaceId ? readWorkspaceLayout(props.workspaceId).openTabs : [],
);

const tabs = computed<RouteTab[]>(() => {
    const list: RouteTab[] = [
        {
            id: "chat",
            label: sessionTitle.value,
            path: chatPath.value,
            testid: "workspace-tab-chat",
            closable: false,
        },
    ];
    const labels: Record<WorkspaceTabId, string> = {
        environment: t("workspace.environmentState"),
        "scheduled-tasks": t("workspace.scheduledTasks.nav"),
        settings: t("workspace.settingsTitle"),
    };
    // PLAN-0753 T5: render the open set in the persisted user order (the chat
    // tab stays first — it is the fallback and is not closable). Unknown ids are
    // dropped so a corrupt payload can never render a dead tab.
    for (const id of openTabs.value) {
        if (!WORKSPACE_TAB_IDS.includes(id)) continue;
        list.push({
            id,
            label: labels[id],
            path: tabPaths.value[id],
            // The S2/S3 contract keeps the historic toolbar ids on these tab
            // buttons so the 20 affected specs keep working.
            testid:
                id === "environment"
                    ? "workspace-toolbar-environment"
                    : id === "scheduled-tasks"
                      ? "workspace-toolbar-scheduled-tasks"
                      : "workspace-toolbar-settings",
            closable: true,
        });
    }
    return list;
});

const activeId = computed<"chat" | WorkspaceTabId>(() => {
    const name = route?.name;
    if (name === "workspace-environment") return "environment";
    if (name === "workspace-scheduled-tasks") return "scheduled-tasks";
    if (name === "workspace-settings") return "settings";
    return "chat";
});

function currentTabId(): WorkspaceTabId | null {
    const name = route?.name;
    if (name === "workspace-environment") return "environment";
    if (name === "workspace-scheduled-tasks") return "scheduled-tasks";
    if (name === "workspace-settings") return "settings";
    return null;
}

/**
 * Persist the open set. S3a audit P1-1: the workbench distinguishes "no stored
 * layout yet" (apply the ≥1800 first-run policy) from "user already chose", so this
 * writer must never fabricate the key just because a route was visited — only a
 * real change of the open set (i.e. closing a tab) may create it.
 */
function persistOpenTabs(next: WorkspaceTabId[]): void {
    const defaults = defaultOpenTabs();
    // PLAN-0753 T5: order is now user-owned, so "default" means the default
    // **sequence** — a permutation of the defaults (e.g. after a drag/keyboard
    // move) is a real choice and must be persisted, or the next mount silently
    // reverts the user's order.
    const isDefaultSet =
        next.length === defaults.length && defaults.every((id, index) => next[index] === id);
    openTabs.value = next;
    if (!props.workspaceId || isDefaultSet) return;
    // Only the tab slice is written: re-writing the whole layout from a
    // default-valued read would clobber the workbench's stored geometry and silently
    // disable the ≥1800 "open monitor on first run" policy (S3a audit P1-1).
    writeWorkspaceOpenTabs(props.workspaceId, next);
}

/** Visiting a route through any means (tab, deep link, history) opens its tab. */
watch(
    () => currentTabId(),
    (tabId) => {
        if (!tabId) return;
        const current = openTabs.value;
        if (current.includes(tabId)) return;
        persistOpenTabs([...current, tabId]);
    },
    { immediate: true },
);

watch(
    () => props.workspaceId,
    (workspaceId) => {
        openTabs.value = workspaceId ? readWorkspaceLayout(workspaceId).openTabs : [];
        const tabId = currentTabId();
        if (tabId && !openTabs.value.includes(tabId)) {
            persistOpenTabs([...openTabs.value, tabId]);
        }
    },
);

/**
 * reka `TabsTrigger` selects on `mousedown` (not `click`), so a real mouse
 * gesture reaches `selectTab` twice: once through the v-model setter and once
 * through the click handler that keeps programmatic `.click()` (jsdom specs,
 * Playwright `click()`) working. Collapse the pair into a single
 * `router.push`; the guard resets when the route actually changes.
 */
const requestedPath = ref<string | null>(null);

watch(
    () => route.fullPath,
    () => {
        requestedPath.value = null;
    },
);

function selectTab(tab: RouteTab): void {
    if (tab.id === activeId.value && route.fullPath === tab.path) return;
    if (requestedPath.value === tab.path) return;
    requestedPath.value = tab.path;
    void router.push(tab.path);
}

/**
 * `Tabs` v-model bridge: reka emits `update:modelValue` on click / arrow keys,
 * the setter only navigates — the route stays the single source of truth, so
 * deep links, back/forward and bookmarks keep working exactly as before.
 */
const activeTab = computed<"chat" | WorkspaceTabId>({
    get: () => activeId.value,
    set: (id) => {
        const tab = tabs.value.find((item) => item.id === id);
        if (tab) selectTab(tab);
    },
});

function closeTab(tab: RouteTab): void {
    if (!tab.closable) return;
    const next = openTabs.value.filter((id) => id !== tab.id);
    persistOpenTabs(next);
    // Closing the active tab falls back to the chat tab via a normal navigation.
    if (activeId.value === tab.id) void router.push(chatPath.value);
}

/**
 * PLAN-0753 T5 (M5): the tab order is now user-owned. `tabs` renders the open
 * set in the persisted order (the chat tab stays first because it is the fallback
 * and is not closable); `VueDraggable` owns the drag, and this handler is the
 * **keyboard-equivalent path** — ArrowLeft/ArrowRight on a focused tab moves it
 * one slot (Shift for the start/end), persists the new order and keeps focus.
 *
 * The drag itself reorders the DOM via Sortable; `onUpdate` is wired to the
 * same `persistOpenTabs` so the store and the DOM never diverge (PLAN-0753
 * "拖拽必须有键盘替代：聚焦 + 方向键移动").
 */
function moveTab(id: "chat" | WorkspaceTabId, delta: number): void {
    const list = tabs.value;
    const from = list.findIndex((tab) => tab.id === id);
    if (from < 0) return;
    const to = Math.min(list.length - 1, Math.max(0, from + delta));
    if (to === from) return;
    const nextIds = list.map((tab) => tab.id);
    nextIds.splice(to, 0, nextIds.splice(from, 1)[0]);
    // Persist only the open (non-chat) slice: the chat tab is always first.
    persistOpenTabs(nextIds.slice(1) as WorkspaceTabId[]);
}

function onDragUpdate(event: { oldIndex?: number; newIndex?: number }): void {
    const { oldIndex, newIndex } = event;
    if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
    const list = tabs.value;
    if (oldIndex >= list.length || newIndex >= list.length) return;
    const nextIds = list.map((tab) => tab.id);
    nextIds.splice(newIndex, 0, nextIds.splice(oldIndex, 1)[0]);
    persistOpenTabs(nextIds.slice(1) as WorkspaceTabId[]);
}

function onTabKeydown(event: KeyboardEvent, tab: RouteTab): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // Only move when the tab bar is horizontal; the chat tab never moves.
    if (tab.id === "chat") return;
    event.preventDefault();
    moveTab(tab.id, event.key === "ArrowLeft" ? -1 : 1);
}
</script>

<template>
    <nav
        data-testid="workspace-tab-bar"
        :aria-label="t('workspace.tabBarLabel')"
        class="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b bg-card px-2"
    >
        <Tabs v-model="activeTab" class="min-w-0 flex-1">
            <TabsList variant="line" class="p-0">
                <!--
                  PLAN-0753 T5: `VueDraggable` wraps the tab rows and owns the mouse
                  drag (Sortable). It renders a plain div, so the reka TabsList
                  markup/aria is unchanged; the drag handle is the whole tab row
                  and onDragUpdate mirrors the DOM reorder into the store.
                -->
                <VueDraggable
                    v-model="openTabs"
                    :animation="150"
                    class="contents"
                    @update="onDragUpdate"
                >
                    <div
                        v-for="tab in tabs"
                        :key="tab.id"
                        class="group inline-flex shrink-0 items-center rounded-md"
                        :class="
                            tab.id === activeId
                                ? 'bg-primary/10 text-primary'
                                : 'text-muted-foreground hover:bg-accent'
                        "
                    >
                        <TabsTrigger
                            :value="tab.id"
                            :data-testid="tab.testid"
                            :data-tab-id="tab.id"
                            :title="tab.label"
                            class="h-auto max-w-52 flex-none rounded-md px-2 py-1 text-xs after:hidden data-active:bg-transparent data-active:text-inherit dark:data-active:border-transparent dark:data-active:bg-transparent"
                            :class="tab.id === activeId ? 'font-medium' : ''"
                            @click="selectTab(tab)"
                            @keydown="onTabKeydown($event, tab)"
                        >
                            <span class="truncate">{{ tab.label }}</span>
                        </TabsTrigger>
                        <button
                            v-if="tab.closable"
                            type="button"
                            :data-testid="`workspace-tab-close-${tab.id}`"
                            :aria-label="t('workspace.tabClose')"
                            :title="t('workspace.tabClose')"
                            class="mr-1 rounded p-0.5 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            @click.stop="closeTab(tab)"
                        >
                            <X class="size-3" aria-hidden="true" />
                        </button>
                    </div>
                </VueDraggable>
            </TabsList>
        </Tabs>
    </nav>
</template>
