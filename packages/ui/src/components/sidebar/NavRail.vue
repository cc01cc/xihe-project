<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { LogOut, PanelLeftOpen, Settings, ShieldCheck } from "@lucide/vue";
import { useAuthStore } from "../../stores/auth";
import LanguageSwitcher from "../settings/LanguageSwitcher.vue";

/**
 * PLAN-0582 S2 ruling #1/#2: the icon rail is a fixed 56px icon-only column.
 * It carries global modules only — the workspace entry (switch / new / import /
 * members) lives in the navigation panel head, and collapsing the navigation
 * panel is a panel-head control, not a rail control.
 *
 * P-class fix: collapsing used to leave no way back on desktop, because the
 * collapse control sits in the very panel that becomes 0px + inert and the
 * mobile re-open control is mobile-only. The rail survives every collapse, so it
 * now also hosts the re-open control — shown only while the panel is collapsed,
 * i.e. it never duplicates the panel-head collapse button.
 */
defineProps<{
    showExpand: boolean;
}>();

const emit = defineEmits<{
    expand: [];
}>();

const router = useRouter(),
    route = useRoute();
const { t } = useI18n();
const auth = useAuthStore();

const currentPath = computed(() => route?.path ?? "");
const isAdminRoute = computed(
    () =>
        currentPath.value.startsWith("/settings/config-locks") ||
        // PLAN-0610 W5c: `/settings/principal-grants` is retired (it now redirects to `/settings/roles`).
        currentPath.value.startsWith("/settings/roles"),
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
    // BL-150 B: hand the post-logout decision to the router guard instead of hard-coding `/login`.
    // On a local (loopback single-user) instance the guard re-enters passwordlessly and stays on the
    // workspace; on a normal deployment there is no token, so the guard lands on `/login` exactly as
    // before. The store does not know the bootstrap mode, so it must not decide here.
    void router.push("/workspace");
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
            v-if="showExpand"
            type="button"
            data-testid="nav-rail-expand"
            :class="[itemClass, inactiveClass]"
            aria-controls="sidebar-panel"
            aria-expanded="false"
            :aria-label="t('sidebar.expand')"
            :title="t('sidebar.expand')"
            @click="emit('expand')"
        >
            <PanelLeftOpen class="size-4" aria-hidden="true" />
            <span class="sr-only">{{ t("sidebar.expand") }}</span>
        </button>

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
            <!--
                task-36 ③：语言切换原本只在设置页的配置 tab 里（ConfigSettings.vue），
                用户在聊天里没有任何入口。导航栏是每条路由都可见的「用户区」（设置/退出也在这里），
                所以把紧凑变体放进同一组：不改 locale 状态机，只换一个用户可达的位置。
            -->
            <LanguageSwitcher variant="compact" />
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
