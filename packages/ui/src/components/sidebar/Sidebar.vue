<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import {
    CircleUser,
    FolderTree,
    LogOut,
    PanelLeftClose,
    Plus,
    Search,
    Settings,
    X,
} from "@lucide/vue";
import { useAuthStore } from "../../stores/auth";
import { toast } from "vue-sonner";
import SessionList from "../../features/workspace/chat/components/SessionList.vue";
import NavRail from "./NavRail.vue";
import { workspacePath } from "../../lib/routes";
import {
    NAV_WIDTH_KEYBOARD_STEP,
    NAV_WIDTH_MAX,
    NAV_WIDTH_MIN,
    RAIL_WIDTH_COLLAPSED,
    RAIL_WIDTH_EXPANDED,
    clampNavWidth,
} from "../../composables/useWorkspaceLayout";
import { useSessionStore } from "../../stores/session";

const props = defineProps<{
    open: boolean;
    width: number;
    isMobile: boolean;
    railCollapsed: boolean;
}>();

const emit = defineEmits<{
    "update:open": [value: boolean];
    "update:width": [value: number];
    "update:railCollapsed": [value: boolean];
}>();

const router = useRouter(),
    route = useRoute();
const { t } = useI18n();
const auth = useAuthStore();
const sessionStore = useSessionStore();

const workspaceLabel = computed(() => {
    const id = auth.currentWorkspaceId;
    return auth.workspace?.name || (id ? `Workspace ${id.slice(0, 6)}` : t("sidebar.workspace"));
});

const isWorkspacePage = computed(() => {
    const workspaceId = auth.currentWorkspaceId;
    if (!workspaceId) return false;
    if (route?.name === "workspace" || route?.name === "workspace-home") return true;
    return (route?.path ?? "") === workspacePath(workspaceId);
});

const railWidth = computed(() =>
    props.railCollapsed ? RAIL_WIDTH_COLLAPSED : RAIL_WIDTH_EXPANDED,
);

const asideStyle = computed(() => {
    if (props.isMobile) {
        return { width: props.open ? `min(${props.width}px, calc(100vw - 1rem))` : "0px" };
    }
    const total = railWidth.value + (props.open ? props.width : 0);
    return { width: `${total}px` };
});

const panelStyle = computed(() => {
    if (props.isMobile) return { width: "100%" };
    return { width: props.open ? `${props.width}px` : "0px" };
});

async function startNewChat() {
    if (!auth.currentWorkspaceId) {
        await auth.hydrateWorkspace();
    }
    if (!auth.currentWorkspaceId) {
        toast.error(t("sidebar.noWorkspace"));
        return;
    }
    const workspaceId = auth.currentWorkspaceId;
    await router.push({ path: workspacePath(workspaceId), query: { newChat: "1" } });
}

function toggleSidebar() {
    emit("update:open", !props.open);
}

function handleResizeStart(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX,
        startWidth = props.width;

    function onMouseMove(ev: MouseEvent) {
        emit("update:width", clampNavWidth(startWidth + (ev.clientX - startX)));
    }

    function onMouseUp() {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
}

function handleResizeKeydown(e: KeyboardEvent) {
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = props.width - NAV_WIDTH_KEYBOARD_STEP;
    else if (e.key === "ArrowRight") next = props.width + NAV_WIDTH_KEYBOARD_STEP;
    else if (e.key === "Home") next = NAV_WIDTH_MIN;
    else if (e.key === "End") next = NAV_WIDTH_MAX;
    if (next === null) return;
    e.preventDefault();
    emit("update:width", clampNavWidth(next));
}

async function navigateToWorkspace() {
    if (!auth.currentWorkspaceId) {
        await auth.hydrateWorkspace();
    }
    const workspaceId = auth.currentWorkspaceId;
    if (!workspaceId) {
        toast.error(t("sidebar.noWorkspace"));
        return;
    }
    void router.push(workspacePath(workspaceId));
}

function clearSearch() {
    sessionStore.searchQuery = "";
}

function navigateSettings() {
    void router.push("/settings/config");
}

function handleLogout() {
    auth.logout();
    void router.push("/login");
}
</script>

<template>
    <aside
        data-testid="sidebar"
        :aria-hidden="isMobile && !open ? 'true' : undefined"
        :inert="isMobile && !open ? true : undefined"
        class="fixed left-0 top-0 z-40 flex h-full overflow-hidden bg-sidebar-background border-r border-sidebar-border transition-[width] duration-300"
        :class="{ 'shadow-lg': isMobile && open }"
        :style="asideStyle"
    >
        <NavRail
            v-if="!isMobile"
            :collapsed="railCollapsed"
            :nav-open="open"
            @toggle-rail="emit('update:railCollapsed', !railCollapsed)"
            @toggle-nav="toggleSidebar"
        />
        <div
            data-testid="sidebar-panel"
            :aria-hidden="!isMobile && !open ? 'true' : undefined"
            :inert="!isMobile && !open ? true : undefined"
            class="relative flex h-full min-w-0 flex-col overflow-hidden"
            :style="panelStyle"
        >
            <div class="flex h-14 shrink-0 items-center gap-1 px-2">
                <button
                    type="button"
                    data-testid="sidebar-workspace"
                    class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
                    :class="{ 'bg-sidebar-accent': isWorkspacePage }"
                    :aria-current="isWorkspacePage ? 'page' : undefined"
                    :title="workspaceLabel"
                    @click="navigateToWorkspace"
                >
                    <FolderTree class="size-4 shrink-0" aria-hidden="true" />
                    <span class="truncate font-medium">{{ workspaceLabel }}</span>
                </button>
                <button
                    v-if="isMobile"
                    type="button"
                    data-testid="sidebar-close"
                    :aria-label="t('sidebar.collapse')"
                    :title="t('sidebar.collapse')"
                    class="shrink-0 rounded-md p-1.5 text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
                    @click="toggleSidebar"
                >
                    <PanelLeftClose class="size-4" aria-hidden="true" />
                </button>
            </div>

            <div class="px-3 pb-2">
                <button
                    data-testid="sidebar-new-chat"
                    class="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-sidebar-border text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                    @click="startNewChat"
                >
                    <Plus class="size-4" aria-hidden="true" />
                    {{ t("sidebar.newChat") }}
                </button>
            </div>

            <div class="px-3 pb-2">
                <div class="relative">
                    <Search
                        class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <input
                        v-model="sessionStore.searchQuery"
                        data-testid="sidebar-session-search"
                        type="text"
                        autocomplete="off"
                        class="w-full rounded-md border border-sidebar-border bg-background py-1.5 pl-7 pr-7 text-sm text-sidebar-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        :placeholder="t('sidebar.search')"
                        :aria-label="t('sidebar.search')"
                    />
                    <button
                        v-if="sessionStore.searchQuery"
                        type="button"
                        data-testid="sidebar-search-clear"
                        class="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent"
                        :aria-label="t('sidebar.clearSearch')"
                        :title="t('sidebar.clearSearch')"
                        @click="clearSearch"
                    >
                        <X class="size-3.5" aria-hidden="true" />
                    </button>
                </div>
            </div>

            <SessionList />

            <div
                v-if="isMobile"
                class="shrink-0 space-y-1 border-t border-sidebar-border px-3 py-3"
            >
                <div class="flex items-center gap-2 px-3 py-2 text-sm text-sidebar-foreground/70">
                    <CircleUser class="size-4" aria-hidden="true" />
                    <span class="truncate">{{ auth.userName }}</span>
                </div>
                <button
                    data-testid="sidebar-settings"
                    class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                    @click="navigateSettings"
                >
                    <Settings class="size-4" aria-hidden="true" />
                    {{ t("sidebar.settings") }}
                </button>
                <button
                    data-testid="sidebar-logout"
                    class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                    @click="handleLogout"
                >
                    <LogOut class="size-4" aria-hidden="true" />
                    {{ t("sidebar.logout") }}
                </button>
            </div>

            <div
                v-if="!isMobile && open"
                role="separator"
                aria-orientation="vertical"
                :aria-label="t('sidebar.resize')"
                :aria-valuenow="width"
                :aria-valuemin="NAV_WIDTH_MIN"
                :aria-valuemax="NAV_WIDTH_MAX"
                tabindex="0"
                data-testid="sidebar-resizer"
                class="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:outline-none"
                @mousedown="handleResizeStart"
                @keydown="handleResizeKeydown"
            />
        </div>
    </aside>

    <Teleport to="body">
        <div
            v-if="isMobile && open"
            class="fixed inset-0 z-30 bg-black/50"
            @click="emit('update:open', false)"
        />
    </Teleport>
</template>
