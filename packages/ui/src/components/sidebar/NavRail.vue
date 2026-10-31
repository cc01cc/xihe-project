<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { LogOut, Settings, ShieldCheck } from "@lucide/vue";
import { useAuthStore } from "../../stores/auth";

/**
 * PLAN-0582 S2 ruling #1/#2: the icon rail is a fixed 56px icon-only column.
 * It carries global modules only — the workspace entry (switch / new / import /
 * members) lives in the navigation panel head, and collapsing the navigation
 * panel is a panel-head control, not a rail control.
 */
const router = useRouter(),
    route = useRoute();
const { t } = useI18n();
const auth = useAuthStore();

const currentPath = computed(() => route?.path ?? "");
const isAdminRoute = computed(
    () =>
        currentPath.value.startsWith("/settings/config-locks") ||
        currentPath.value.startsWith("/settings/principal-grants"),
);
const isSettingsRoute = computed(
    () => currentPath.value.startsWith("/settings") && !isAdminRoute.value,
);

const itemClass =
    "flex size-10 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
// Ruling P2-1: the current module is the only rail state that carries the accent.
const inactiveClass = "text-sidebar-foreground hover:bg-sidebar-accent";
const activeClass = "bg-brand/10 font-medium text-brand";

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
        class="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-sidebar-border bg-surface-canvas py-2"
    >
        <span
            aria-hidden="true"
            class="mb-1 grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-accent text-xs font-semibold text-sidebar-foreground"
        >
            xh
        </span>

        <button
            v-if="auth.isAdmin"
            type="button"
            data-testid="nav-rail-admin"
            :class="[itemClass, isAdminRoute ? activeClass : inactiveClass]"
            :aria-current="isAdminRoute ? 'page' : undefined"
            :aria-label="t('sidebar.admin')"
            :title="t('sidebar.admin')"
            @click="navigateAdmin"
        >
            <ShieldCheck class="size-4" aria-hidden="true" />
            <span class="sr-only">{{ t("sidebar.admin") }}</span>
        </button>

        <div class="mt-auto flex flex-col items-center gap-1">
            <button
                type="button"
                data-testid="nav-rail-settings"
                :class="[itemClass, isSettingsRoute ? activeClass : inactiveClass]"
                :aria-current="isSettingsRoute ? 'page' : undefined"
                :aria-label="t('sidebar.settings')"
                :title="t('sidebar.settings')"
                @click="navigateSettings"
            >
                <Settings class="size-4" aria-hidden="true" />
                <span class="sr-only">{{ t("sidebar.settings") }}</span>
            </button>
            <button
                type="button"
                data-testid="nav-rail-logout"
                :class="[itemClass, inactiveClass]"
                :aria-label="t('sidebar.logout')"
                :title="t('sidebar.logout')"
                @click="handleLogout"
            >
                <LogOut class="size-4" aria-hidden="true" />
                <span class="sr-only">{{ t("sidebar.logout") }}</span>
            </button>
        </div>
    </nav>
</template>
