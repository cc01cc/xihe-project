<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useStorage } from "@vueuse/core";
import { Briefcase, LogOut, Settings, ShieldCheck } from "@lucide/vue";
import { useAuthStore } from "../../stores/auth";
import { defaultLayerPath } from "../../lib/settingsIa";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarRail,
} from "../ui/sidebar";

/**
 * PLAN-0762 T2.1/T2.3 —— 全局导航条（GlobalRail，DEV-010 §10.1 的唯一正名）。
 *
 * <p>只放两个模块：工作台（会话 + 工作区）/ 设置页（D-924 命名修正：模块名是「工作台」，
 * 工作区只是工作台模块内的对象，不是模块名）。管理员 / 登出属于模块之外的工具面，
 * 放 footer，不作为第三个模块。</p>
 *
 * <p>双态是对 PLAN-0582 S2 的 supersede：56px 图标 ↔ 图标+文字（Sidebar 的
 * collapsible="icon" + SidebarRail hover + ⌘/Ctrl+B）。与工作区内部的 navOpen 是两条
 * 独立状态：本组件的持久化键是 xihe-global-rail-open，不写 xihe-layout-global
 * （后者仍由 useWorkspaceLayout 单一 owner 管工作区几何）。</p>
 */
const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

/** 双态持久化：独立 key，不与 xihe-layout-global / xihe-layout-ws:* 串味。 */
const railOpen = useStorage("xihe-global-rail-open", false);

const workbenchActive = computed(() => (route.path ?? "").startsWith("/workspace"));
const adminRouteActive = computed(
    () =>
        (route.path ?? "").startsWith("/settings/config-locks") ||
        // PLAN-0610 W5c：/settings/principal-grants 已退役（重定向到 /settings/roles）。
        (route.path ?? "").startsWith("/settings/roles"),
);
const settingsActive = computed(
    () => (route.path ?? "").startsWith("/settings") && !adminRouteActive.value,
);

function goWorkbench() {
    void router.push("/workspace");
}

function goSettings() {
    void router.push(defaultLayerPath("instance"));
}

function goAdmin() {
    void router.push("/settings/config-locks");
}

function handleLogout() {
    auth.logout();
    void router.push("/login");
}
</script>

<template>
    <SidebarProvider
        v-model:open="railOpen"
        class="h-full w-auto min-h-0 shrink-0"
        :style="{ '--sidebar-width': '12rem', '--sidebar-width-icon': '3.5rem' }"
    >
        <Sidebar
            collapsible="icon"
            data-testid="global-rail"
            class="border-r border-sidebar-border"
        >
            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    data-testid="global-rail-module-workbench"
                                    :is-active="workbenchActive"
                                    :aria-current="workbenchActive ? 'page' : undefined"
                                    class="border-l-2 border-transparent data-[active=true]:border-brand"
                                    :tooltip="t('sidebar.workbench')"
                                    @click="goWorkbench"
                                >
                                    <Briefcase class="size-4 shrink-0" aria-hidden="true" />
                                    <span class="truncate">{{ t("sidebar.workbench") }}</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    data-testid="global-rail-module-settings"
                                    :is-active="settingsActive"
                                    :aria-current="settingsActive ? 'page' : undefined"
                                    class="border-l-2 border-transparent data-[active=true]:border-brand"
                                    :tooltip="t('sidebar.settings')"
                                    @click="goSettings"
                                >
                                    <Settings class="size-4 shrink-0" aria-hidden="true" />
                                    <span class="truncate">{{ t("sidebar.settings") }}</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                            <SidebarMenuItem v-if="auth.isAdmin">
                                <SidebarMenuButton
                                    data-testid="global-rail-admin"
                                    :is-active="adminRouteActive"
                                    :aria-current="adminRouteActive ? 'page' : undefined"
                                    class="border-l-2 border-transparent data-[active=true]:border-brand"
                                    :tooltip="t('sidebar.admin')"
                                    @click="goAdmin"
                                >
                                    <ShieldCheck class="size-4 shrink-0" aria-hidden="true" />
                                    <span class="truncate">{{ t("sidebar.admin") }}</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            data-testid="global-rail-logout"
                            :tooltip="t('sidebar.logout')"
                            @click="handleLogout"
                        >
                            <LogOut class="size-4 shrink-0" aria-hidden="true" />
                            <span class="truncate">{{ t("sidebar.logout") }}</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    </SidebarProvider>
</template>
