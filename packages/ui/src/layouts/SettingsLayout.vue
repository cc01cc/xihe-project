<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { Menu, X } from "@lucide/vue";
import BackToChatButton from "../components/settings/BackToChatButton.vue";
import SettingsLayerHeader from "../components/settings/SettingsLayerHeader.vue";
import SettingsSidebar from "../components/settings/SettingsSidebar.vue";
import NavRail from "../components/sidebar/NavRail.vue";
import {
    DOMAIN_LABEL_KEY,
    isConfigDomain,
    isSettingsLayer,
    settingsLayerForPath,
} from "../lib/settingsIa";

/**
 * PLAN-0752 T1.1：设置区独立布局（**不**复用 layouts/AppLayout.vue）。
 *
 * <p>为什么必须独立（design.md S1/S2）：AppLayout 的首个子节点就是工作区 Sidebar，
 * 设置区复用它 ⇒ 左栏永远是"工作区侧栏"，层与域的二级关系无处安放。本布局只保留
 * 「左栏（层内二级）+ sticky 层标题与面包屑 + 内容区」，DOM 里不再出现工作区侧栏（V10）。</p>
 */
const route = useRoute();
const { t } = useI18n();

// 层是外框：这里决定它。路由 meta 有层就用 meta；兜底路由（404）没有 meta，按路径推导。
const layer = computed(() =>
    isSettingsLayer(route.meta.settingsLayer)
        ? route.meta.settingsLayer
        : settingsLayerForPath(route.path),
);

const domainLabel = computed(() => {
    const domain = route.meta.settingsDomain;
    if (!isConfigDomain(domain)) return undefined;
    return t(DOMAIN_LABEL_KEY[domain]);
});

const drawerOpen = ref(false);
watch(
    () => route.fullPath,
    () => {
        drawerOpen.value = false;
    },
);
</script>

<template>
    <div class="flex min-h-screen bg-background text-foreground">
        <!--
            task-253（用户 2026-11-10 裁定 ①）：**全局 rail 在所有页面常驻，设置页也不例外**。
            旧实现刻意不复用 AppLayout（顶注 V10 的理由仍成立：工作区 Sidebar 不该出现在设置区），
            但连带把 56px 全局 rail 也省掉了 —— 于是「设置」成了唯一没有模块导航的页面。
            修法只搬 rail（NavRail 自带 设置/管理员/语言/登出），不搬工作区导航面板：与工作区页
            的读法一致，也不把工作区侧栏带回来。桌面才显示（与 AppLayout 里 NavRail 的 isMobile
            判定同一口径），移动端设置区走自己的抽屉。
        -->
        <div class="sticky top-0 hidden h-screen shrink-0 lg:block">
            <NavRail :show-expand="false" />
        </div>

        <aside class="hidden w-[264px] shrink-0 border-r lg:block">
            <div class="sticky top-0 h-screen">
                <SettingsSidebar />
            </div>
        </aside>

        <div v-if="drawerOpen" class="fixed inset-0 z-40 lg:hidden">
            <div
                class="absolute inset-0 bg-background/70 backdrop-blur-sm"
                @click="drawerOpen = false"
            />
            <div
                role="dialog"
                aria-modal="true"
                data-testid="settings-drawer"
                class="absolute inset-y-0 left-0 flex w-[280px] flex-col border-r bg-background shadow-lg"
            >
                <div class="flex items-center justify-between border-b px-3 py-2">
                    <span class="text-sm font-medium">{{ t("settings.ia.menuButton") }}</span>
                    <button
                        type="button"
                        class="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        :aria-label="t('settings.ia.closeMenu')"
                        @click="drawerOpen = false"
                    >
                        <X class="size-4" />
                    </button>
                </div>
                <div class="min-h-0 flex-1 overflow-y-auto">
                    <SettingsSidebar />
                </div>
            </div>
        </div>

        <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 px-4 pt-3 lg:hidden">
                <button
                    type="button"
                    data-testid="settings-drawer-toggle"
                    class="inline-flex min-h-[36px] items-center gap-1 rounded-md border px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                    :aria-expanded="drawerOpen"
                    @click="drawerOpen = true"
                >
                    <Menu class="size-4" />
                    {{ t("settings.ia.menuButton") }}
                </button>
            </div>

            <SettingsLayerHeader :layer="layer" :domain="domainLabel">
                <div class="mt-2">
                    <BackToChatButton />
                </div>
            </SettingsLayerHeader>

            <main class="mx-auto w-full max-w-6xl px-6 py-6">
                <router-view />
            </main>
        </div>
    </div>
</template>
