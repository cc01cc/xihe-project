<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useStorage } from "@vueuse/core";
import { Briefcase, LogOut, Settings } from "@lucide/vue";
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
 * <p>主区只留一个模块：工作台（D-924 命名修正：模块名是「工作台」，工作区只是工作台
 * 模块内的对象，不是模块名）。D-933（用户 2026-11-11 裁定）：「管理」按钮直接移除、
 * 不设替代入口 —— config-locks/roles 本就是设置区安全组的 ADMIN-only 条目（导航已按
 * 能力过滤，PLAN-0556/0585 语义不变）；「设置」移到 footer、登出上方。</p>
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
/** D-933：config-locks / roles 归设置模块 —— /settings 前缀即激活，不再有 admin 子态。 */
const settingsActive = computed(() => (route.path ?? "").startsWith("/settings"));

function goWorkbench() {
    void router.push("/workspace");
}

function goSettings() {
    void router.push(defaultLayerPath("instance"));
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
                <!--
                    task-50 B2：折起态（icon 栏）内距 14px =（56 − 28）/ 2。
                    为什么不是 `p-3`：本仓 `--spacing` 是 **3.5px 步进**（`main.css:302` `0.21875rem`），
                    `p-3`=10.5px 会留 3.5px 偏移；按钮是 vendor `size-8!` = 8 步 = **28px**。
                    为什么要改：vendor 的 `p-2` 是给 48px 栏设计的常量，我们覆盖成 56px 后
                    「宽度」和「内距」各自合理、相乘才错 ⇒ 图标中心偏 −5px（改前实测）。
                -->
                <SidebarGroup class="group-data-[collapsible=icon]:p-4">
                    <SidebarGroupContent>
                        <SidebarMenu>
                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    data-testid="global-rail-module-workbench"
                                    :is-active="workbenchActive"
                                    :aria-current="workbenchActive ? 'page' : undefined"
                                    class="data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-medium"
                                    :tooltip="t('sidebar.workbench')"
                                    @click="goWorkbench"
                                >
                                    <Briefcase class="size-4 shrink-0" aria-hidden="true" />
                                    <span class="truncate group-data-[collapsible=icon]:hidden">{{
                                        t("sidebar.workbench")
                                    }}</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
            <!-- task-50 B2：footer 与顶部组同一内距，折起态两个图标各自居中，不出现「一个偏左一个居中」。 -->
            <SidebarFooter class="group-data-[collapsible=icon]:p-4">
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            data-testid="global-rail-module-settings"
                            :is-active="settingsActive"
                            :aria-current="settingsActive ? 'page' : undefined"
                            class="data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-medium"
                            :tooltip="t('sidebar.settings')"
                            @click="goSettings"
                        >
                            <Settings class="size-4 shrink-0" aria-hidden="true" />
                            <span class="truncate group-data-[collapsible=icon]:hidden">{{
                                t("sidebar.settings")
                            }}</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            data-testid="global-rail-logout"
                            :tooltip="t('sidebar.logout')"
                            @click="handleLogout"
                        >
                            <LogOut class="size-4 shrink-0" aria-hidden="true" />
                            <span class="truncate group-data-[collapsible=icon]:hidden">{{
                                t("sidebar.logout")
                            }}</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    </SidebarProvider>
</template>
