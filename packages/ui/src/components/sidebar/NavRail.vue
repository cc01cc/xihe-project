<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { Languages, LogOut, PanelLeftOpen, Settings, ShieldCheck } from "@lucide/vue";
import { useAuthStore } from "../../stores/auth";
import { defaultLayerPath } from "../../lib/settingsIa";
import { SUPPORTED_LOCALES } from "../../i18n/locale";
import type { Language } from "../../types";
import { useSettingsStore } from "../../stores/settings";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "../ui/dropdown-menu";

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
const settings = useSettingsStore();

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
const activeClass = "bg-primary/10 font-medium text-primary";

/**
 * task-113：不再 push 旧入口 `/settings/config`（它只剩 redirect，且 redirect 会丢 query）。
 * 目标由 `lib/settingsIa` 的 `defaultLayerPath("instance")` 算出 —— 与 redirect 用**同一个**
 * 事实源（实例层默认域页 `/settings/instance/llm-provider`），不在调用点再写一份字面量。
 */
function navigateSettings() {
    void router.push(defaultLayerPath("instance"));
}

function navigateAdmin() {
    void router.push("/settings/config-locks");
}

/**
 * D-896（用户 2026-11-11 裁定）：折叠态只剩图标时，必须让人知道「这是什么、下面有什么」。
 *
 * <p>做法：语言切换同时提供 **compact 控件（已修）+ 一个带「语言」标签的二级菜单**，
 * 两条都可达 —— hover/点击开，**键盘 Tab+Enter 也开**（reka 的 DropdownMenuTrigger 原生支持），
 * Esc 关闭；触屏走 tap（折叠态下就是点一下图标）。</p>
 *
 * <p>菜单内容**从 SSOT 派生**：`SUPPORTED_LOCALES`（`i18n/locale.ts:12`），不写死「中 / EN」两条 ——
 * 用户原话「以后又不一定只有一种语言」。文案走 `t()`，切语言仍只调 `settings.setLanguage()`。</p>
 *
 * <p>用 DropdownMenu 而非 NavigationMenu：后者是站内导航范式，语义是「站点地图」，
 * 与「语言偏好」不匹配（D-896 点名不用 NavigationMenu）。</p>
 */
const LANGUAGE_LABELS: Record<Language, string> = {
    "zh-CN": "settings.languageZh",
    "en-US": "settings.languageEn",
};

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
                task-36 ③ 引入的紧凑语言开关：**已移除**（D-899，用户 2026-11-11：
                「语言切换放到设置里吧」；task-125 ①）。唯一入口 = 设置页 ConfigSettings
                的 bar 变体（settings-language-*）+ user-preference 面板 language 键（薄皮肤，
                同一条 setLanguage 状态机，PLAN-0602）。rail 只保留 设置/退出（/管理员）。
            -->
            <DropdownMenu>
                <DropdownMenuTrigger
                    :class="[itemClass, inactiveClass]"
                    data-testid="nav-rail-language-menu"
                    :aria-label="
                        t('sidebar.languageMenu') + '：' + t(LANGUAGE_LABELS[settings.language])
                    "
                    :title="t('sidebar.languageMenu')"
                >
                    <Languages class="size-4" aria-hidden="true" />
                    <span class="sr-only">{{ t("sidebar.languageMenu") }}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start" class="w-40">
                    <DropdownMenuItem
                        v-for="locale in SUPPORTED_LOCALES"
                        :key="locale"
                        :data-testid="`nav-rail-language-${locale}`"
                        @click="settings.setLanguage(locale)"
                    >
                        <span>{{ t(LANGUAGE_LABELS[locale]) }}</span>
                        <span v-if="settings.language === locale" class="ml-auto" aria-label="当前">
                            ✓
                        </span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
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
