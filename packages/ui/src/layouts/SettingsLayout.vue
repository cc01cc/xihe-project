<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { Menu, Search, X } from "@lucide/vue";
import BackToChatButton from "../components/settings/BackToChatButton.vue";
import SettingsCommandPalette from "../components/settings/SettingsCommandPalette.vue";
import SettingsLayerHeader from "../components/settings/SettingsLayerHeader.vue";
import SettingsSidebar from "../components/settings/SettingsSidebar.vue";
import { Button } from "../components/ui/button";
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
/**
 * PLAN-0762 T3.4：⌘K 面板的开合状态归布局（**唯一实例**）—— 面板自己注册 ⌘K 监听并
 * 通过 `update:open` 回报；不要在任何子组件里再挂第二份，否则同一个键会被处理两次。
 */
const paletteOpen = ref(false);
watch(
    () => route.fullPath,
    () => {
        drawerOpen.value = false;
        paletteOpen.value = false;
    },
);
</script>

<template>
    <!--
        task-257 B①：宽度只有**一个口径** = `--settings-sidebar-width`（H3 单一口径的落地）。
        设置左栏固定 264（不做 220–360 拖拽：那是工作区三栏的模型，设置区无 handle 也从无此需求），
        但宽度必须变量化 —— 否则下次又要出现 920/1010 那类各自算一个数的局部字面量。
        悬停/折叠状态用 data-* 属性表达（vendor Sidebar 的 ③ 模式），CSS 侧可据此选择器化。

        PLAN-0762 T3.1（(A) 方案）追加：`--sidebar-width` 只是上面这个单一口径的**别名** ——
        vendor `Sidebar` 读它（`ui/sidebar/Sidebar.vue:28/:70/:84`），而**不**取
        `useWorkspaceLayout.navWidth`（工作区导航 220–360 的模型，设置区无拖拽 handle）。
        `SettingsSidebar` 现在用 `collapsible="none"` + `w-full`，该变量尚未被消费；留着是为了
        将来切 `offcanvas`/`icon` 折叠时只改一个 prop，而不是再去引第二个宽度数字。
    -->
    <div
        class="flex h-full min-h-0 bg-background text-foreground"
        :style="{
            '--settings-sidebar-width': '264px',
            '--sidebar-width': 'var(--settings-sidebar-width)',
        }"
    >
        <!--
            PLAN-0762 T2.1（task-253 的进一步收敛）：全局 rail 已提升到 App.vue 的全局层
            （GlobalRail，所有模块常驻、可折叠），本布局不再自带 NavRail —— 设置页只保留
            「设置模块内的左导航（SettingsSidebar）+ 内容列」，不把工作区侧栏带回来（V10 仍成立）。
        -->

        <aside
            data-testid="settings-sidebar-scope"
            data-variant="sidebar"
            data-collapsible="offcanvas"
            data-state="expanded"
            class="hidden shrink-0 border-r lg:block"
            :style="{ width: 'var(--settings-sidebar-width)' }"
        >
            <div class="sticky top-0 h-full">
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
                data-variant="sheet"
                data-collapsible="offcanvas"
                data-state="open"
                class="absolute inset-y-0 left-0 flex flex-col border-r bg-background shadow-lg"
                :style="{
                    width: 'var(--settings-sidebar-width)',
                    '--settings-sidebar-width': '280px',
                }"
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

        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
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
                <div class="mt-2 flex flex-wrap items-center gap-2">
                    <!-- T3.4：可见入口（键盘 ⌘K 之外的那条路；触屏/鼠标用户也够得到）。
                         按钮与 ⌘K 都只改同一个 `paletteOpen`。 -->
                    <Button
                        variant="outline"
                        size="sm"
                        data-testid="settings-commandk-trigger"
                        class="h-7 gap-1.5 text-xs font-normal"
                        :aria-label="t('settings.commandk.trigger')"
                        @click="paletteOpen = true"
                    >
                        <Search class="size-3.5" aria-hidden="true" />
                        {{ t("settings.commandk.trigger") }}
                        <kbd
                            class="ml-1 rounded border px-1 font-mono text-[10px] text-muted-foreground"
                            aria-hidden="true"
                            >⌘K</kbd
                        >
                    </Button>
                    <!-- task-156：桌面（lg+）rail 已有「工作台」同动作 ⇒ 页内返回聊天只留移动端
                         （移动端 rail 不渲染，没有第二个入口）。 -->
                    <div class="lg:hidden">
                        <BackToChatButton />
                    </div>
                </div>
            </SettingsLayerHeader>

            <!-- 全局层把 100vh 收走了：设置内容列自己滚动，页面（含长域页）不被裁切。 -->
            <main class="mx-auto min-h-0 w-full max-w-6xl flex-1 overflow-y-auto px-6 py-6">
                <router-view />
            </main>
        </div>

        <SettingsCommandPalette v-model:open="paletteOpen" :layer="layer" />
    </div>
</template>
