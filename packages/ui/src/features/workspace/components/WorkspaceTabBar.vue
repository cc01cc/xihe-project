<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { X } from "@lucide/vue";
import {
    WORKSPACE_TAB_IDS,
    defaultOpenTabs,
    readWorkspaceLayout,
    writeWorkspaceLayout,
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
    // Keep the design order regardless of the order they were opened in.
    for (const id of WORKSPACE_TAB_IDS) {
        if (!openTabs.value.includes(id)) continue;
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
    const isDefaultSet =
        next.length === defaults.length && defaults.every((id) => next.includes(id));
    openTabs.value = next;
    if (!props.workspaceId || isDefaultSet) return;
    const layout = readWorkspaceLayout(props.workspaceId);
    writeWorkspaceLayout(props.workspaceId, { ...layout, openTabs: next });
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

function selectTab(tab: RouteTab): void {
    if (tab.id === activeId.value && route.fullPath === tab.path) return;
    void router.push(tab.path);
}

function closeTab(tab: RouteTab): void {
    if (!tab.closable) return;
    const next = openTabs.value.filter((id) => id !== tab.id);
    persistOpenTabs(next);
    // Closing the active tab falls back to the chat tab via a normal navigation.
    if (activeId.value === tab.id) void router.push(chatPath.value);
}
</script>

<template>
    <nav
        data-testid="workspace-tab-bar"
        :aria-label="t('workspace.tabBarLabel')"
        class="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b bg-surface-content px-2"
    >
        <div role="tablist" class="flex min-w-0 items-center gap-1">
            <div
                v-for="tab in tabs"
                :key="tab.id"
                class="group inline-flex shrink-0 items-center rounded-md"
                :class="
                    tab.id === activeId
                        ? 'bg-brand/10 text-brand'
                        : 'text-muted-foreground hover:bg-accent'
                "
            >
                <button
                    type="button"
                    role="tab"
                    :data-testid="tab.testid"
                    :data-tab-id="tab.id"
                    :aria-selected="tab.id === activeId"
                    :title="tab.label"
                    class="inline-flex max-w-52 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    :class="tab.id === activeId ? 'font-medium' : ''"
                    @click="selectTab(tab)"
                >
                    <span class="truncate">{{ tab.label }}</span>
                </button>
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
        </div>
    </nav>
</template>
