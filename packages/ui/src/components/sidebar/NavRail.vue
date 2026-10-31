<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import {
    ChevronsLeft,
    ChevronsRight,
    FolderTree,
    LogOut,
    PanelLeftClose,
    PanelLeftOpen,
    Settings,
    ShieldCheck,
} from "@lucide/vue";
import { useAuthStore } from "../../stores/auth";
import { workspacePath } from "../../lib/routes";

const props = defineProps<{
    collapsed: boolean;
    navOpen: boolean;
}>();

const emit = defineEmits<{
    "toggle-rail": [];
    "toggle-nav": [];
}>();

const router = useRouter(),
    route = useRoute();
const { t } = useI18n();
const auth = useAuthStore();

const currentPath = computed(() => route?.path ?? "");
const isWorkspaceRoute = computed(() => currentPath.value.startsWith("/workspace"));
const isAdminRoute = computed(
    () =>
        currentPath.value.startsWith("/settings/config-locks") ||
        currentPath.value.startsWith("/settings/principal-grants"),
);
const isSettingsRoute = computed(
    () => currentPath.value.startsWith("/settings") && !isAdminRoute.value,
);

const itemClass =
    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const activeClass = "bg-sidebar-accent font-medium";
const labelClass = computed(() => (props.collapsed ? "sr-only" : "truncate"));

async function navigateToWorkspace() {
    if (!auth.currentWorkspaceId) {
        await auth.hydrateWorkspace();
    }
    const workspaceId = auth.currentWorkspaceId;
    if (!workspaceId) return;
    void router.push(workspacePath(workspaceId));
}

function navigateSettings() {
    void router.push("/settings/config");
}

function navigateAdmin() {
    void router.push("/settings/config-locks");
}

function handleLogout() {
    auth.logout();
    void router.push("/login");
}
</script>

<template>
    <nav
        data-testid="nav-rail"
        class="flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar-background"
        :class="collapsed ? 'w-12' : 'w-44'"
    >
        <div class="flex h-14 shrink-0 items-center gap-2 px-2">
            <span
                aria-hidden="true"
                class="grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-accent text-xs font-semibold text-sidebar-foreground"
            >
                xh
            </span>
            <span v-if="!collapsed" class="truncate text-sm font-semibold text-sidebar-foreground">
                xihe
            </span>
        </div>

        <div class="flex flex-col gap-1 px-2">
            <button
                type="button"
                data-testid="nav-rail-panel-toggle"
                :class="itemClass"
                :aria-label="navOpen ? t('sidebar.collapse') : t('sidebar.expand')"
                :title="navOpen ? t('sidebar.collapse') : t('sidebar.expand')"
                :aria-pressed="navOpen"
                @click="emit('toggle-nav')"
            >
                <PanelLeftClose v-if="navOpen" class="size-4 shrink-0" aria-hidden="true" />
                <PanelLeftOpen v-else class="size-4 shrink-0" aria-hidden="true" />
                <span :class="labelClass">{{
                    navOpen ? t("sidebar.collapse") : t("sidebar.expand")
                }}</span>
            </button>
            <button
                type="button"
                data-testid="nav-rail-workspace"
                :class="[itemClass, isWorkspaceRoute ? activeClass : '']"
                :aria-current="isWorkspaceRoute ? 'page' : undefined"
                :title="t('sidebar.workspace')"
                @click="navigateToWorkspace"
            >
                <FolderTree class="size-4 shrink-0" aria-hidden="true" />
                <span :class="labelClass">{{ t("sidebar.workspace") }}</span>
            </button>
            <button
                v-if="auth.isAdmin"
                type="button"
                data-testid="nav-rail-admin"
                :class="[itemClass, isAdminRoute ? activeClass : '']"
                :aria-current="isAdminRoute ? 'page' : undefined"
                :title="t('sidebar.admin')"
                @click="navigateAdmin"
            >
                <ShieldCheck class="size-4 shrink-0" aria-hidden="true" />
                <span :class="labelClass">{{ t("sidebar.admin") }}</span>
            </button>
        </div>

        <div class="mt-auto flex flex-col gap-1 px-2 pb-3">
            <button
                type="button"
                data-testid="nav-rail-settings"
                :class="[itemClass, isSettingsRoute ? activeClass : '']"
                :aria-current="isSettingsRoute ? 'page' : undefined"
                :title="t('sidebar.settings')"
                @click="navigateSettings"
            >
                <Settings class="size-4 shrink-0" aria-hidden="true" />
                <span :class="labelClass">{{ t("sidebar.settings") }}</span>
            </button>
            <button
                type="button"
                data-testid="nav-rail-logout"
                :class="itemClass"
                :title="t('sidebar.logout')"
                @click="handleLogout"
            >
                <LogOut class="size-4 shrink-0" aria-hidden="true" />
                <span :class="labelClass">{{ t("sidebar.logout") }}</span>
            </button>
            <button
                type="button"
                data-testid="nav-rail-toggle"
                :class="itemClass"
                :aria-pressed="collapsed"
                :aria-label="collapsed ? t('sidebar.expandRail') : t('sidebar.collapseRail')"
                :title="collapsed ? t('sidebar.expandRail') : t('sidebar.collapseRail')"
                @click="emit('toggle-rail')"
            >
                <ChevronsRight v-if="collapsed" class="size-4 shrink-0" aria-hidden="true" />
                <ChevronsLeft v-else class="size-4 shrink-0" aria-hidden="true" />
            </button>
        </div>
    </nav>
</template>
