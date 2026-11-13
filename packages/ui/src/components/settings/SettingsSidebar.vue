<script setup lang="ts">
import { computed, onMounted, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import {
    Activity,
    Bot,
    Brain,
    ChevronRight,
    Circle,
    CircleUserRound,
    Database,
    FileCode,
    FileSearch,
    Fingerprint,
    KeyRound,
    LayoutTemplate,
    Lock,
    ScrollText,
    Search,
    Layers,
    Server,
    Settings2,
    ShieldCheck,
    SlidersHorizontal,
    Timer,
    User,
} from "@lucide/vue";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
    Sidebar,
    SidebarGroup,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar";
import { provideSidebarContext } from "@/components/ui/sidebar/utils";
import { useMediaQuery } from "@vueuse/core";
import { useAuthStore } from "../../stores/auth";
import { readGlobalLayout, writeGlobalLayout } from "../../composables/useWorkspaceLayout";
import { instanceOpsGroups, navItemsForLayer, type SettingsNavItem } from "../../lib/settingsIa";

/**
 * 设置区左栏（**不**复用工作区 Sidebar）。task-253 起按用户 2026-11-10 裁定改为
 * **两个可折叠层分组**；task-175（2026-11-11 用户审阅「导航栏糟糕透顶」）在不动
 * 层×域矩阵与权限面的前提下重做**视觉层级**：
 *
 * - **字阶**（DEV-011）：层组标题 14px semibold（原 11px uppercase 过小）；二级组标签
 *   12px（原 11px）；条目维持 14px。组标题 ≥12px 且与条目有明确阶差。
 * - **三级缩进可辨**：层组标题 pl-2 → 组标签 pl-4 → 条目 pl-6（8px 步进），
 *   层组 / 域组·资源组·运维组 / 条目三层不再挤在同一缩进。
 * - **选中态**：条目左侧 2px 指示条 + 浅底（DEV-011 §10 注意力预算：selected 不整行重染），
 *   idle 态保留透明 border 避免切换跳动。
 * - **图标**（skill A13：左栏 0 图标是已知缺陷）：层组头 + 每条目配 @lucide/vue 图标。
 * - **组成部分**（PLAN-0762 T3.1，(A) 方案，用户 2026-11-11 裁定）：从「参考语义结构」升级为
 *   **真用** `components/ui/sidebar` 组件族 —— `Sidebar`（`collapsible="none"`，只做族外壳，
 *   **不接管列宽/定位**）+ `SidebarGroup` / `SidebarGroupLabel` / `SidebarMenu` /
 *   `SidebarMenuItem` / `SidebarMenuButton`（条目、选中态、hover 都走 vendor）。
 *   **但绝不注册第二个 `SidebarProvider`** —— 它自带三件我们不想要的副作用（逐条实证，
 *   读数见 `internal/A03-xihe/evidence/2026-11-11-t31-spike/README.md`）：
 *   ① **单键 cookie**：`SIDEBAR_COOKIE_NAME = "sidebar_state"`（`ui/sidebar/utils.ts:4`），
 *      provider 每次 `setOpen` 覆写它（`SidebarProvider.vue:45`）且默认值也从同一键读（`:24`）；
 *      全局条已有一个 provider，第二个会与它**共用同一键**互相覆写；
 *   ② **document 级 ⌘/Ctrl+B**：每个 provider 各注册一份监听（`SidebarProvider.vue:57-62`），
 *      多一个 provider 就多一次「按 ⌘B 把别处也翻了」（实测：手工子树 `setOpen` 调用数 0，
 *      provider 子树照常翻）；
 *   ③ **wrapper 写死宽度与高地**：`--sidebar-width: 16rem` + `flex min-h-svh w-full`
 *      （`SidebarProvider.vue:80-97`），会把设置左栏拉成整屏高地并顶掉本布局的单一宽度口径。
 *   因此本组件**手工** `provideSidebarContext`（形状见 `ui/sidebar/utils.ts:12-20` 的 7 字段），
 *   列宽由调用方注入（`SettingsLayout.vue` 的 `--sidebar-width`，本组件只读不写）。折叠态沿用
 *   全局布局键 `xihe-layout-global`（`useWorkspaceLayout` 是它的唯一 owner），这里**不新建第二份
 *   布局状态**。**条目不启用 tooltip**（代价见模板注释：`as-child` + tooltip 会丢
 *   `data-slot="sidebar-menu-button"` 这族标记，而 `collapsible="none"` 也用不到 tooltip）。
 *   vendor 升级时按 spike 文档 §「vendor 升级耦合点」五处 grep + 跑 `settings-sidebar-context.spec.ts`。
 *
 * 权限面（V15）：实例块（域 + 实例资源）可见性来自 CP 投影的 cap:instance:admin 能力位
 * （auth.hasInstanceAdminCapability），不是角色名判断；ops/安全组另按 canSeeInstanceOps
 * 渲染（BL-552）——roles 项要求 MANAGE_ROLES 原子，atom-only 用户无能力位也须看到该入口。
 * 两者都 fail-closed：投影没回来就不显示。
 */
const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();

/**
 * (A) 方案的手工侧栏 context（见文件头注释的三条副作用依据）。
 *
 * <p>`Sidebar` 在 setup 里就 `useSidebar()`（`Sidebar.vue:20`），reka 的 `createContext`
 * **没有 fallback** ⇒ 不 provide 直接抛 `Injection "Sidebar" not found`。这里按
 * `ui/sidebar/utils.ts:12-20` 的 7 字段形状自建：</p>
 * - `open`：**不新建第二份布局状态** —— 初值取全局布局键 `xihe-layout-global`
 *   （`useWorkspaceLayout` 是它唯一 owner），`setOpen` 写回同一个键；
 * - `state` 由 `open` 派生（`expanded` / `collapsed`）；`Sidebar` 的 `collapsible="none"`
 *   分支不渲染它（`Sidebar.vue:24-33`），`SidebarMenuButton` 只在传 `tooltip` 时才消费它
 *   （`SidebarMenuButton.vue:42`）——本栏两者都不走，所以它是给下一档（icon 折叠）预置的合同字段；
 * - `isMobile` / `openMobile`：`Sidebar` 只在 `collapsible !== 'none'` 时才走移动 Sheet 分支
 *   （`Sidebar.vue:35`）。本栏用 `collapsible="none"`（列宽与定位归 `SettingsLayout` 的
 *   `<aside>`），所以这两个字段当前是**合同占位**，但按真实断点接好，将来换 `icon` 折叠时无需再改；
 * - `toggleSidebar`：与 `setOpen` 同一写手，保证 cookie/快捷键两条旁路都不存在。
 */
const isMobile = useMediaQuery("(max-width: 1023px)");
const sidebarOpen = ref(!isMobile.value && readGlobalLayout().navOpen);
const sidebarOpenMobile = ref(false);

function setSidebarOpen(value: boolean): void {
    sidebarOpen.value = value;
    // 写回同一持久键（只改 navOpen，不碰 navWidth —— 宽度归 SettingsLayout 的单一口径）。
    writeGlobalLayout({ ...readGlobalLayout(), navOpen: value });
}

provideSidebarContext({
    state: computed(() => (sidebarOpen.value ? "expanded" : "collapsed")),
    open: sidebarOpen,
    setOpen: setSidebarOpen,
    isMobile,
    openMobile: sidebarOpenMobile,
    setOpenMobile: (value: boolean) => {
        sidebarOpenMobile.value = value;
    },
    toggleSidebar: () => {
        setSidebarOpen(!sidebarOpen.value);
    },
});

onMounted(() => {
    void auth.ensureSelfPermissions();
});

const canSeeInstanceLayer = computed(() => auth.hasInstanceAdminCapability);

/**
 * BL-552：ops/安全组不能整体挂在能力位下 —— roles 项的唯一门是 MANAGE_ROLES 原子
 * （PLAN-0651 T4.2 / Lead ruling ①）。atom-only 用户（有原子、无 cap:instance:admin）
 * 必须仍能看到该入口；域与实例资源保持能力位门不变。
 */
const canSeeInstanceOps = computed(() => canSeeInstanceLayer.value || auth.canManageRoles);

const activeLayer = computed(() => {
    const layer = route.meta.settingsLayer;
    return layer === "instance" || layer === "user" || layer === "workspace-default"
        ? layer
        : "instance";
});

/**
 * 高亮口径：**组页用 `meta.settingsGroup`**，域页用 `meta.settingsDomain`。
 *
 * <p>组条目在左栏的 `id` 就是组 id（`model-config`），与 `settingsGroup` 同一个常量 ⇒ 这里把两者
 * 收成一个"当前条目 id"，否则组页打开时左栏一条都不亮（那会让用户以为自己在"没在设置区里"）。</p>
 */
const activeDomain = computed(() => {
    if (typeof route.meta.settingsGroup === "string") return route.meta.settingsGroup;
    return typeof route.meta.settingsDomain === "string" ? route.meta.settingsDomain : "";
});

/** 当前层默认展开、另一层默认收起；跨层导航时跟着路由翻。 */
const instanceOpen = ref(activeLayer.value === "instance");
const workspaceDefaultOpen = ref(activeLayer.value === "workspace-default");
const userOpen = ref(activeLayer.value === "user");
watch(activeLayer, (layer) => {
    instanceOpen.value = layer === "instance";
    workspaceDefaultOpen.value = layer === "workspace-default";
    userOpen.value = layer === "user";
});

// task-227：左栏条目**统一由 settingsIa.navItemsForLayer 派生**（组折叠只在那一个函数里发生），
// 三个层都走同一条，避免"某层折叠了、某层没折叠"这类不一致。
const instanceDomains = computed<SettingsNavItem[]>(() => navItemsForLayer("instance"));

const workspaceDefaultDomains = computed<SettingsNavItem[]>(() =>
    navItemsForLayer("workspace-default"),
);

const userDomains = computed<SettingsNavItem[]>(() => navItemsForLayer("user"));

/**
 * PLAN-0772 M2（design.md 目标 1）：**资源组已整体搬出设置区**，左栏只剩「配置域 + 实例运维与安全」。
 *
 * <p>为什么不再保留资源组：资源条目现在挂在顶层「资源」入口（`/resources/*`，层由页内 tab 表达），
 * 留在设置区会让同一个「凭据」出现两次（task-88 修掉的重名病会以另一种形式回来）。
 * 计数也随之变化：实例层 22 → **17**（12 域 + 5 运维安全），用户层 12 → **9**（只剩 9 域）。</p>
 */

const opsGroups = computed(() =>
    instanceOpsGroups()
        .map((group) => ({
            ...group,
            items: group.items.filter((item) => {
                if (item.id === "config-locks") return auth.hasInstanceAdminCapability;
                if (item.id === "roles") return auth.canManageRoles;
                return true;
            }),
        }))
        .filter((group) => group.items.length > 0),
);

/**
 * H4（.agents/skills/xh-settings-ui-design）：组徽标数**入口数**，行徽标才数**字段数** ——
 * 同一列出现两个量纲时必须靠量词区分，否则「17 / 14」读者无法判断谁在数什么。
 * 字段数需要 per-domain meta（GET /config/<domain>/meta 的 keys），本组件不取数 ⇒ 本轮只落
 * 组级入口数 + 图例；行级字段徽标留给持有 meta 的域页（AGENTS: 不猜数据）。
 */
const instanceEntryCount = computed(
    () =>
        instanceDomains.value.length +
        opsGroups.value.reduce((sum, group) => sum + group.items.length, 0),
);
const userEntryCount = computed(() => userDomains.value.length);
const workspaceDefaultEntryCount = computed(() => workspaceDefaultDomains.value.length);

/** task-175：条目图标（skill A13）。键 = 域 id / ops id；未知项回落 Circle。 */
const DOMAIN_ICONS: Record<string, Component> = {
    "llm-provider": Brain,
    "context-policy": SlidersHorizontal,
    embedding: Fingerprint,
    rag: Search,
    "agent-runtime": Bot,
    "agent-profile": CircleUserRound,
    "user-preference": Settings2,
    logging: ScrollText,
    "approval-policy": ShieldCheck,
    "agent-templates": LayoutTemplate,
    "api-request-templates": FileCode,
    "job-policy": Timer,
};
const OPS_ICONS: Record<string, Component> = {
    monitoring: Activity,
    data: Database,
    "config-locks": Lock,
    roles: KeyRound,
    audit: FileSearch,
};
const LAYER_ICONS: Record<string, Component> = {
    instance: Server,
    // PLAN-0766：共享层用 Layers（"层的默认值"语义，与 Server/User 两个具体归属区分）。
    "workspace-default": Layers,
    user: User,
};

function iconFor(map: Record<string, Component>, id: string): Component {
    return map[id] ?? Circle;
}

function isDomainActive(layer: "instance" | "workspace-default" | "user", domain: string): boolean {
    return activeLayer.value === layer && activeDomain.value === domain;
}

function isOpsActive(path: string): boolean {
    return route.path === path;
}

/**
 * 组标题就是折叠开关。刻意**不**在 CollapsibleTrigger 上再绑 click —— reka 的 trigger 自带
 * 切换行为，绑第二次会双重翻转（packages/ui/AGENTS.md「Reka UI 交互陷阱」）。
 * task-175：层组标题 14px semibold（原 11px uppercase），与 12px 组标签、14px 条目形成阶差。
 */
const layerHeaderClass =
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-semibold text-foreground hover:bg-muted/60",
    countBadgeClass =
        "shrink-0 rounded px-1.5 py-px font-mono text-xs font-normal ring-1 ring-border ring-inset",
    /** 二级组标签（域 / 资源 / 运维·安全）：12px + uppercase + tracking（task-50 C1）。 */
    sectionLabelClass =
        "h-auto px-0 pb-1 pl-4 pr-2 pt-2 text-xs font-medium uppercase tracking-wider text-muted-foreground",
    /**
     * 条目：`pl-6` 三级缩进；13px（task-50 C1：与 14px 层组标题拉开一档）。
     * task-50：删掉 `border-l-2 border-l-transparent` —— 6px 圆角 + 2px 竖线 = 用户看到的「半截括号」。
     * 选中态不再靠边框：vendor `SidebarMenuButton` 自带 `data-active:bg-sidebar-accent`
     * `data-active:text-sidebar-accent-foreground` `data-active:font-medium`（`[实测]` 注入判别色后
     * 选中行背景确为 `--sidebar-accent`），因此本栏只需要补一个 shadcn 原生维度：选中图标上 `--sidebar-primary`。
     */
    itemBaseClass =
        "flex min-h-[32px] items-center gap-2 truncate rounded-md py-1.5 pl-6 pr-2 text-[13px]",
    itemIdleClass =
        "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
    itemActiveClass =
        "bg-sidebar-accent font-medium text-sidebar-accent-foreground [&_svg]:text-sidebar-primary",
    itemIconClass = "size-4 shrink-0";
</script>

<template>
    <!--
        为什么这里**不**自包 `TooltipProvider`、条目也**不**传 `tooltip`（实测，2026-11-11）：
        `SidebarMenuButton[tooltip]` 会走 `Tooltip > TooltipTrigger(asChild) > Primitive(asChild)`，
        两层 asChild 克隆同一个 router-link，**外层 `TooltipTrigger` 的 `data-slot` 会顶掉
        `SidebarMenuButton` 自己的** —— 实测 17 个条目里 13 个（带 tooltip 的那些）只剩
        `data-slot="tooltip-trigger"`，`data-sidebar="menu-button"` / `data-active` 标记也一起丢；
        去掉 tooltip 后 21 个菜单项全部保留 `data-slot="sidebar-menu-button"`。
        加上本栏是 `collapsible="none"`（永远不折成图标条，没有 tooltip 的用武之地），
        所以选择**保 vendor 标记、不启用 tooltip**。将来真要 tooltip，先自包
        `TooltipProvider`（reka `TooltipRoot` 注入无 fallback，不包直接抛错，
        原本由 `SidebarProvider.vue:80` 替我们包），再解决上面这个标记覆盖问题。

        `Sidebar` 用 `collapsible="none"`：列宽（`--settings-sidebar-width` 单一口径）与定位
        （`<aside>` 的 `hidden lg:block` + sticky）仍归 `SettingsLayout`，这里只要族外壳与
        `bg-sidebar text-sidebar-foreground` 主题；`w-full` 覆盖 vendor 的 `w-(--sidebar-width)`。
    -->
    <Sidebar collapsible="none" class="h-full w-full">
        <nav
            data-testid="settings-sidebar"
            class="flex h-full flex-col gap-2 overflow-y-auto px-3 py-4"
        >
            <!-- 实例层：当前层默认展开 -->
            <Collapsible
                v-if="canSeeInstanceLayer || canSeeInstanceOps"
                v-model:open="instanceOpen"
            >
                <SidebarGroup class="p-0">
                    <CollapsibleTrigger
                        id="settings-nav-instance"
                        data-testid="settings-nav-group-primary"
                        :class="layerHeaderClass"
                    >
                        <ChevronRight
                            class="size-4 shrink-0 transition-transform"
                            :class="instanceOpen ? 'rotate-90' : ''"
                            aria-hidden="true"
                        />
                        <component
                            :is="LAYER_ICONS.instance"
                            class="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <span class="min-w-0 flex-1 truncate">{{
                            t("settings.ia.layerInstance")
                        }}</span>
                        <span data-testid="settings-nav-count-instance" :class="countBadgeClass">
                            {{ t("settings.ia.entryCount", { count: instanceEntryCount }) }}
                        </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                        <template v-if="canSeeInstanceLayer">
                            <SidebarGroupLabel
                                as="p"
                                data-testid="settings-nav-group-domains-instance"
                                :class="sectionLabelClass"
                            >
                                {{ t("settings.ia.groupDomains") }}
                            </SidebarGroupLabel>
                            <SidebarMenu data-testid="settings-nav-group-items" class="gap-0.5">
                                <SidebarMenuItem v-for="item in instanceDomains" :key="item.id">
                                    <SidebarMenuButton
                                        as-child
                                        :is-active="isDomainActive('instance', item.id)"
                                        :class="[
                                            itemBaseClass,
                                            isDomainActive('instance', item.id)
                                                ? itemActiveClass
                                                : itemIdleClass,
                                        ]"
                                    >
                                        <router-link
                                            :to="item.path"
                                            :data-testid="'settings-nav-domain-instance-' + item.id"
                                        >
                                            <component
                                                :is="iconFor(DOMAIN_ICONS, item.id)"
                                                :class="itemIconClass"
                                                aria-hidden="true"
                                            />
                                            <span class="min-w-0 truncate">{{
                                                t(item.labelKey)
                                            }}</span>
                                        </router-link>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            </SidebarMenu>
                        </template>

                        <!-- BL-552：ops/安全组按 canSeeInstanceOps 渲染，不被实例层能力位整段遮住。 -->
                        <template v-if="canSeeInstanceOps">
                            <div v-for="group in opsGroups" :key="group.id" class="mt-1">
                                <SidebarGroupLabel
                                    as="p"
                                    :data-testid="'settings-nav-group-ops-' + group.id"
                                    :class="sectionLabelClass"
                                >
                                    {{ t(group.labelKey) }}
                                </SidebarGroupLabel>
                                <SidebarMenu class="gap-0.5">
                                    <SidebarMenuItem v-for="item in group.items" :key="item.id">
                                        <SidebarMenuButton
                                            as-child
                                            :is-active="isOpsActive(item.path)"
                                            :class="[
                                                itemBaseClass,
                                                isOpsActive(item.path)
                                                    ? itemActiveClass
                                                    : itemIdleClass,
                                            ]"
                                        >
                                            <router-link
                                                :to="item.path"
                                                :data-testid="'settings-nav-ops-' + item.id"
                                            >
                                                <component
                                                    :is="iconFor(OPS_ICONS, item.id)"
                                                    :class="itemIconClass"
                                                    aria-hidden="true"
                                                />
                                                <span class="min-w-0 truncate">{{
                                                    t(item.labelKey)
                                                }}</span>
                                            </router-link>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                </SidebarMenu>
                            </div>
                        </template>
                    </CollapsibleContent>
                </SidebarGroup>
            </Collapsible>

            <!-- PLAN-0766（task-160）：共享工作区默认层。它不是"某个工作区"的设置，而是对所有
             没有显式 workspace 覆盖的工作区生效的部署级默认值；入口形态与实例/用户层一致。 -->
            <!-- 层序：左栏按高 → 低显示（instance → personal → workspace default），故个人层排在默认层之前。 -->
            <Collapsible v-model:open="userOpen" class="mt-[16px]">
                <SidebarGroup class="p-0">
                    <CollapsibleTrigger
                        id="settings-nav-user"
                        data-testid="settings-nav-group-primary"
                        :class="layerHeaderClass"
                    >
                        <ChevronRight
                            class="size-4 shrink-0 transition-transform"
                            :class="userOpen ? 'rotate-90' : ''"
                            aria-hidden="true"
                        />
                        <component
                            :is="LAYER_ICONS.user"
                            class="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <span class="min-w-0 flex-1 truncate">{{
                            t("settings.ia.layerUser")
                        }}</span>
                        <span data-testid="settings-nav-count-user" :class="countBadgeClass">
                            {{ t("settings.ia.entryCount", { count: userEntryCount }) }}
                        </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                        <SidebarGroupLabel
                            as="p"
                            data-testid="settings-nav-group-domains-user"
                            :class="sectionLabelClass"
                        >
                            {{ t("settings.ia.groupDomains") }}
                        </SidebarGroupLabel>
                        <SidebarMenu data-testid="settings-nav-group-items" class="gap-0.5">
                            <SidebarMenuItem v-for="item in userDomains" :key="item.id">
                                <SidebarMenuButton
                                    as-child
                                    :is-active="isDomainActive('user', item.id)"
                                    :class="[
                                        itemBaseClass,
                                        isDomainActive('user', item.id)
                                            ? itemActiveClass
                                            : itemIdleClass,
                                    ]"
                                >
                                    <router-link
                                        :to="item.path"
                                        :data-testid="'settings-nav-domain-user-' + item.id"
                                    >
                                        <component
                                            :is="iconFor(DOMAIN_ICONS, item.id)"
                                            :class="itemIconClass"
                                            aria-hidden="true"
                                        />
                                        <span class="min-w-0 truncate">{{ t(item.labelKey) }}</span>
                                    </router-link>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </CollapsibleContent>
                </SidebarGroup>
            </Collapsible>

            <!-- 层序：同上，默认层排在个人层之后；顺序真相见 lib/settingsIa.ts 的 SETTINGS_LAYERS_LOW_TO_HIGH。 -->
            <Collapsible v-model:open="workspaceDefaultOpen" class="mt-[16px]">
                <SidebarGroup class="p-0">
                    <CollapsibleTrigger
                        id="settings-nav-workspace-default"
                        data-testid="settings-nav-group-workspace-default"
                        :class="layerHeaderClass"
                    >
                        <ChevronRight
                            class="size-4 shrink-0 transition-transform"
                            :class="workspaceDefaultOpen ? 'rotate-90' : ''"
                            aria-hidden="true"
                        />
                        <component
                            :is="LAYER_ICONS['workspace-default']"
                            class="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <span class="min-w-0 flex-1 truncate">{{
                            t("settings.ia.layerWorkspaceDefault")
                        }}</span>
                        <span
                            data-testid="settings-nav-count-workspace-default"
                            :class="countBadgeClass"
                        >
                            {{
                                t("settings.ia.entryCount", {
                                    count: workspaceDefaultEntryCount,
                                })
                            }}
                        </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                        <SidebarGroupLabel
                            as="p"
                            data-testid="settings-nav-group-domains-workspace-default"
                            :class="sectionLabelClass"
                        >
                            {{ t("settings.ia.groupWorkspaceDefaultDomains") }}
                        </SidebarGroupLabel>
                        <SidebarMenu data-testid="settings-nav-group-items" class="gap-0.5">
                            <SidebarMenuItem v-for="item in workspaceDefaultDomains" :key="item.id">
                                <SidebarMenuButton
                                    as-child
                                    :is-active="isDomainActive('workspace-default', item.id)"
                                    :class="[
                                        itemBaseClass,
                                        isDomainActive('workspace-default', item.id)
                                            ? itemActiveClass
                                            : itemIdleClass,
                                    ]"
                                >
                                    <router-link
                                        :to="item.path"
                                        :data-testid="
                                            'settings-nav-domain-workspace-default-' + item.id
                                        "
                                    >
                                        <component
                                            :is="iconFor(DOMAIN_ICONS, item.id)"
                                            :class="itemIconClass"
                                            aria-hidden="true"
                                        />
                                        <span class="min-w-0 truncate">{{ t(item.labelKey) }}</span>
                                    </router-link>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </CollapsibleContent>
                </SidebarGroup>
            </Collapsible>
        </nav>
    </Sidebar>
</template>
