<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { Menu, X } from "@lucide/vue";
import SettingsResourceNav from "../components/settings/SettingsResourceNav.vue";
import ResourceLayerTabs from "../components/resources/ResourceLayerTabs.vue";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "../components/ui/breadcrumb";
import { useMediaQuery } from "@vueuse/core";
import { provideSidebarContext } from "../components/ui/sidebar/utils";
import { useAuthStore } from "../stores/auth";
import { readTabWorkspaceId } from "../lib/workspaceContext";
import {
    isResourceId,
    layersForResource,
    resolveResourceLayer,
    resourceDef,
    resourceGroups,
    resourcePath,
    type ResourceId,
    type ResourceLayer,
} from "../lib/settingsIa";

/**
 * PLAN-0772 M2（设计决策 8）：资源模块独立布局（`/resources/*`）。
 *
 * <p>为什么必须新布局（`task-181` 盘点实测，不是猜）：资源页原来挂在 `/settings` 的子路由上，
 * 层头/层身份来自 `SettingsLayout.vue:144-170` 对 `SettingsLayerHeader` 的渲染；**搬出 `/settings`
 * 就同时丢掉层头**（`git grep -n "SettingsLayerHeader" -- src/views` ⇒ 0 命中）⇒ 本布局自带
 * ①资源左栏 ②面包屑 + 标题 ③层 tab（`ResourceLayerTabs`），三者都在这里装配一次，
 * 页面组件只负责内容。</p>
 *
 * <p>层从哪来（唯一口径）：`?layer=`（大写 wire 值）+ `RESOURCE_DEFS[].layerRules`。
 * 缺省/非法值落到该资源的默认层（`resolveResourceLayer`）——**不给 404**，因为层 tab 是本页
 * 主要交互，手输大小写不该把用户踢到错误页；资源 id 非法才 404（由路由段兜底）。</p>
 */
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const auth = useAuthStore();

const resourceId = computed<ResourceId | null>(() => {
    const meta = route.meta.resourceId;
    return isResourceId(meta) ? meta : null;
});

const def = computed(() => (resourceId.value ? resourceDef(resourceId.value) : null));
const layers = computed<readonly ResourceLayer[]>(() =>
    resourceId.value ? layersForResource(resourceId.value) : [],
);
const active = computed<ResourceLayer>(() =>
    resourceId.value ? resolveResourceLayer(resourceId.value, route.query.layer) : "USER",
);
const title = computed(() => (def.value ? t(def.value.labelKey) : ""));

const WORKSPACE_ID = computed(() => readTabWorkspaceId());

/**
 * 各层为什么不可用 —— 只认两类来源，全部由 `RESOURCE_DEFS` 声明，组件里不许再写死一层一层判断：
 * ①该层按工作区归属但当前没有工作区上下文；②CP 自己守卫的门槛（`capability:instance:admin` /
 * action atom）当前账号不具备。
 *
 * <p>`T2b.3` 删掉了第三类 `pendingBackend`：技能个人层后端已实现（`V156` / `SkillLibraryService`），
 * 而它的读面**不挂原子**（P-189-3）⇒ 「后端未实现」这条门已无任何资源命中，留着就是给下一个读者
 * 一个能把 tab 误置灰的开关。</p>
 */
const disabledReason = computed<Partial<Record<ResourceLayer, string>>>(() => {
    const out: Partial<Record<ResourceLayer, string>> = {};
    if (!resourceId.value) return out;
    for (const rule of resourceDef(resourceId.value).layerRules) {
        // PLAN-0772 M2 / Lead 2026-11-12 裁定 c：**当前层**的不可用理由由页面正文承担（技能个人层/无工作区
        // 上下文都各有自己的说明卡）—— 页头再列一遍就是同一句话说两遍。所以理由只给"非当前层"的 tab：
        // 用户看到「这一层置灰」时立刻知道原因，进到那层后又只从正文读一次。
        if (rule.layer === active.value) continue;
        if (rule.needsWorkspace && !WORKSPACE_ID.value) {
            out[rule.layer] = t("resources.reasonNoWorkspace");
            continue;
        }
        const requires = rule.requires;
        if (!requires) continue;
        const denied =
            "capability" in requires
                ? !auth.hasInstanceAdminCapability
                : !auth.hasInstanceAtom(requires.atom);
        if (denied) out[rule.layer] = t("resources.reasonCapability");
    }
    return out;
});

const navItems = computed(() => resourceGroups());

function selectLayer(layer: ResourceLayer) {
    if (!resourceId.value) return;
    // 写回 URL（决策 9）：每个层 tab 都是可分享的深链（`/resources/skills?layer=WORKSPACE`）。
    void router.push({
        path: resourcePath(resourceId.value),
        query: { ...route.query, layer },
    });
}

const drawerOpen = ref(false);

/**
 * vendor `SidebarMenuButton` 在 setup 里直接 `useSidebar()`（reka `createContext` 无 fallback）⇒
 * 任何用到 `SettingsResourceNav` 的布局都**必须**提供 context。这里手工 provide（与 `SettingsSidebar.vue:118`
 * 同一手法），**不挂第二个 `SidebarProvider`** —— 它自带 ⌘B 监听与宽度副作用，设置区已经吃过一次亏
 * （`SettingsSidebar.vue:66-76` 的逐条实证）。本布局的宽度口径只有一个：`--resources-sidebar-width`。
 */
const sidebarOpen = ref(true);
const sidebarOpenMobile = ref(false);
const isMobile = useMediaQuery("(max-width: 1023px)");
provideSidebarContext({
    state: computed(() => (sidebarOpen.value ? "expanded" : "collapsed")),
    open: sidebarOpen,
    setOpen: (value: boolean) => {
        sidebarOpen.value = value;
    },
    isMobile,
    openMobile: sidebarOpenMobile,
    setOpenMobile: (value: boolean) => {
        sidebarOpenMobile.value = value;
    },
    toggleSidebar: () => {
        sidebarOpen.value = !sidebarOpen.value;
    },
});
watch(
    () => route.fullPath,
    () => {
        drawerOpen.value = false;
    },
);
</script>

<template>
    <div
        class="flex h-full min-h-0 bg-background text-foreground"
        :style="{
            '--resources-sidebar-width': '300px',
            '--sidebar-width': 'var(--resources-sidebar-width)',
        }"
    >
        <aside
            data-testid="resources-sidebar-scope"
            data-variant="sidebar"
            data-collapsible="offcanvas"
            data-state="expanded"
            class="hidden shrink-0 border-r lg:block"
            :style="{ width: 'var(--resources-sidebar-width)' }"
        >
            <div class="sticky top-0 h-full overflow-y-auto">
                <div class="px-3 pt-4 pb-1 text-sm font-semibold">
                    {{ t("resources.navGroup") }}
                </div>
                <SettingsResourceNav
                    group-label-key="resources.navGroup"
                    :items="navItems"
                    :active-id="resourceId ?? undefined"
                />
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
                data-testid="resources-drawer"
                class="absolute inset-y-0 left-0 flex w-72 flex-col border-r bg-background shadow-lg"
            >
                <div class="flex items-center justify-between border-b px-3 py-2">
                    <span class="text-sm font-medium">{{ t("resources.navGroup") }}</span>
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
                    <div class="px-3 pt-3 pb-1 text-sm font-semibold">
                        {{ t("resources.navGroup") }}
                    </div>
                    <SettingsResourceNav
                        group-label-key="resources.navGroup"
                        :items="navItems"
                        :active-id="resourceId ?? undefined"
                    />
                </div>
            </div>
        </div>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
            <header
                data-testid="resources-header"
                class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur"
            >
                <div class="mx-auto w-full max-w-6xl px-6 pt-3 pb-3">
                    <div class="flex items-center gap-2 lg:hidden">
                        <button
                            type="button"
                            data-testid="resources-drawer-toggle"
                            class="inline-flex min-h-[36px] items-center gap-1 rounded-md border px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                            :aria-expanded="drawerOpen"
                            @click="drawerOpen = true"
                        >
                            <Menu class="size-4" />
                            {{ t("resources.navGroup") }}
                        </button>
                    </div>
                    <Breadcrumb
                        data-testid="resources-breadcrumb"
                        :aria-label="t('resources.breadcrumbLabel')"
                        class="text-muted-foreground"
                    >
                        <BreadcrumbList class="gap-1 text-xs">
                            <BreadcrumbItem>
                                <BreadcrumbLink
                                    as-child
                                    class="underline-offset-4 hover:text-foreground hover:underline"
                                >
                                    <router-link
                                        :to="
                                            resourcePath(
                                                (resourceId ?? 'credentials') as ResourceId,
                                            )
                                        "
                                    >
                                        {{ t("resources.breadcrumbRoot") }}
                                    </router-link>
                                </BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator class="text-border [&>svg]:size-3" />
                            <BreadcrumbItem>
                                <BreadcrumbPage class="font-medium">{{ title }}</BreadcrumbPage>
                            </BreadcrumbItem>
                        </BreadcrumbList>
                    </Breadcrumb>
                    <!--
                        PLAN-0772 M2 / Lead 裁定（双标题）：这里**不再渲染 h1**。

                        资源页的标题已由各面板自带（`CredentialsPanel` 等的 `settings-page-title`、
                        缺口页/未接线页自己的 h2）—— 布局再放一个 h1 会让同一屏出现两个同级标题，
                        读屏会把同一个名字念两遍，aria 结构也自相矛盾。面包屑保留（它不是标题，
                        承担的是"我在哪一层"的定位），页名由面包屑末级 + 面板标题共同表达。
                    -->
                    <div v-if="layers.length" class="mt-3">
                        <ResourceLayerTabs
                            :resource-id="(resourceId ?? 'credentials') as ResourceId"
                            :layers="layers"
                            :active="active"
                            :disabled-reason="disabledReason"
                            @select="selectLayer"
                        />
                    </div>
                </div>
            </header>

            <main class="mx-auto min-h-0 w-full max-w-6xl flex-1 overflow-y-auto px-6 py-6">
                <router-view />
            </main>
        </div>
    </div>
</template>
