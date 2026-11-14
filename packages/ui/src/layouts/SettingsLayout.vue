<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { Menu, Search, X } from "@lucide/vue";
import BackToChatButton from "../components/settings/BackToChatButton.vue";
import SettingsCommandPalette from "../components/settings/SettingsCommandPalette.vue";
import SettingsLayerHeader from "../components/settings/SettingsLayerHeader.vue";
import SettingsSidebar from "../components/settings/SettingsSidebar.vue";
import { Button } from "../components/ui/button";
// task-510：移动抽屉换成 vendor Sheet（reka Dialog 自带焦点陷阱 + Esc）。
import Sheet from "../components/ui/sheet/Sheet.vue";
import SheetClose from "../components/ui/sheet/SheetClose.vue";
import SheetContent from "../components/ui/sheet/SheetContent.vue";
import SheetDescription from "../components/ui/sheet/SheetDescription.vue";
import SheetHeader from "../components/ui/sheet/SheetHeader.vue";
import SheetTitle from "../components/ui/sheet/SheetTitle.vue";
import { useAuthStore } from "../stores/auth";
import {
    DOMAIN_LABEL_KEY,
    groupDefFor,
    isConfigDomain,
    isSettingsGroup,
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
const auth = useAuthStore();

// 层是外框：这里决定它。路由 meta 有层就用 meta；兜底路由（404）没有 meta，按路径推导。
const layer = computed(() =>
    isSettingsLayer(route.meta.settingsLayer)
        ? route.meta.settingsLayer
        : settingsLayerForPath(route.path),
);

/**
 * 面包屑末段：域页取域名；**组页**取组名（`meta.settingsGroup`）。
 *
 * <p>为什么不给组页也塞一个假 `settingsDomain`：那个字段的语义是"这一页是某个**配置域**"，
 * 而组 id（`model-config` / `agent-config`）不是域（不在 `INSTANCE_DOMAINS` 里、CP 也没有
 * 它们的 `/config/meta`）；塞进去会让所有读 `meta.settingsDomain` 的地方（面包屑、左栏高亮、
 * e2e 断言）都开始说谎。</p>
 *
 * <p>task-485：组名不再写死 `model-config` 一个，改为查组注册表（`groupDefFor`）——
 * 新增组只加注册表一行，面包屑自动跟上。</p>
 */
const domainLabel = computed(() => {
    const group = isSettingsGroup(route.meta.settingsGroup)
        ? groupDefFor(route.meta.settingsGroup)
        : undefined;
    if (group) return t(group.labelKey);
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

/**
 * task-341 ②：与 `ResourcesLayout` 同款、同理由 —— 设置区也**不是** `AppLayout`，
 * 而工作区层的域页（`meta.settingsLayer === "workspace"`）要读 `auth.workspace` 的投影。
 * 不取就只剩页签缓存，缓存不全时权限位会回落成默认值。幂等：已加载则不发请求。
 */
onMounted(() => {
    void auth.hydrateWorkspace();
});
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
            '--settings-sidebar-width': '300px',
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

        <!--
            task-510（G-08 + H-01）：移动抽屉必须是**真的 Sheet**（reka Dialog 原语），不是手搓 div。

            修前这里自己写了 `role="dialog" aria-modal="true" data-variant="sheet"` 加一个遮罩
            `@click` —— 看起来像 vendor 件，**却没有它的行为**：Esc 关不掉、按 Tab 焦点跑到背后
            正文（读屏/键盘用户在抽屉里没有出口，只有点遮罩一条路）。判据是行为不是外形：
            `SettingsLayout.backToChat.spec.ts` 里两条 —— Esc ⇒ 抽屉消失、打开后焦点在抽屉内。

            宽度走内联 style 而不是 class：SheetContent 被 teleport 到 body，容器上的
            `--settings-sidebar-width` 不随 DOM 继承 ⇒ 必须自带一份（与修前同一处理）。
        -->
        <Sheet :open="drawerOpen" @update:open="(open: boolean) => (drawerOpen = open)">
            <SheetContent
                side="left"
                :show-close-button="false"
                data-testid="settings-drawer"
                data-variant="sheet"
                data-collapsible="offcanvas"
                class="gap-0 p-0 lg:hidden"
                :style="{
                    width: 'var(--settings-sidebar-width)',
                    '--settings-sidebar-width': '300px',
                }"
            >
                <SheetHeader
                    class="flex flex-row items-center justify-between space-y-0 border-b px-3 py-2"
                >
                    <SheetTitle class="text-sm font-medium">
                        {{ t("settings.ia.menuButton") }}
                    </SheetTitle>
                    <SheetDescription class="sr-only">
                        {{ t("settings.ia.menuButton") }}
                    </SheetDescription>
                    <SheetClose as-child>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            :aria-label="t('settings.ia.closeMenu')"
                        >
                            <X class="size-4" />
                        </Button>
                    </SheetClose>
                </SheetHeader>
                <div class="min-h-0 flex-1 overflow-y-auto">
                    <SettingsSidebar />
                </div>
            </SheetContent>
        </Sheet>

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
                            class="ml-1 rounded border px-1 font-mono text-xs text-muted-foreground"
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
