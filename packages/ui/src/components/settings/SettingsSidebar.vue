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
    SidebarGroup,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useAuthStore } from "../../stores/auth";
import {
    DOMAIN_LABEL_KEY,
    domainsForLayer,
    instanceOpsGroups,
    instanceResourceGroup,
    settingsDomainPath,
    userResourceGroup,
    type SettingsNavItem,
} from "../../lib/settingsIa";
import SettingsResourceNav from "./SettingsResourceNav.vue";

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
 * - **组成部分**：参考 components/ui/sidebar 的 SidebarGroup / SidebarGroupLabel /
 *   SidebarMenu / SidebarMenuItem 语义结构（非整壳复用；不引入第二个 SidebarProvider，
 *   宽度/折叠持久化仍归 useWorkspaceLayout）。
 *
 * 权限面（V15）：实例块（域 + 实例资源）可见性来自 CP 投影的 cap:instance:admin 能力位
 * （auth.hasInstanceAdminCapability），不是角色名判断；ops/安全组另按 canSeeInstanceOps
 * 渲染（BL-552）——roles 项要求 MANAGE_ROLES 原子，atom-only 用户无能力位也须看到该入口。
 * 两者都 fail-closed：投影没回来就不显示。
 */
const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();

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

const activeDomain = computed(() =>
    typeof route.meta.settingsDomain === "string" ? route.meta.settingsDomain : "",
);

/** 当前层默认展开、另一层默认收起；跨层导航时跟着路由翻。 */
const instanceOpen = ref(activeLayer.value === "instance");
const workspaceDefaultOpen = ref(activeLayer.value === "workspace-default");
const userOpen = ref(activeLayer.value === "user");
watch(activeLayer, (layer) => {
    instanceOpen.value = layer === "instance";
    workspaceDefaultOpen.value = layer === "workspace-default";
    userOpen.value = layer === "user";
});

const instanceDomains = computed<SettingsNavItem[]>(() =>
    domainsForLayer("instance").map((domain) => ({
        id: domain,
        labelKey: DOMAIN_LABEL_KEY[domain],
        path: settingsDomainPath("instance", domain),
    })),
);

const workspaceDefaultDomains = computed<SettingsNavItem[]>(() =>
    domainsForLayer("workspace-default").map((domain) => ({
        id: domain,
        labelKey: DOMAIN_LABEL_KEY[domain],
        path: settingsDomainPath("workspace-default", domain),
    })),
);

const userDomains = computed<SettingsNavItem[]>(() =>
    domainsForLayer("user").map((domain) => ({
        id: domain,
        labelKey: DOMAIN_LABEL_KEY[domain],
        path: settingsDomainPath("user", domain),
    })),
);

/**
 * PLAN-0752 T4.0：资源组。实例层 4 条全缺口（G1/G2/G3/G4）、用户层 1 条真（我的凭据）+ 2 条缺口，
 * 按 D7 留位标缺口——具体呈现与点击行为在 SettingsResourceNav。
 */
const instanceResources = computed(() => instanceResourceGroup());
const userResources = computed(() => userResourceGroup());

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
        instanceResources.value.length +
        opsGroups.value.reduce((sum, group) => sum + group.items.length, 0),
);
const userEntryCount = computed(() => userDomains.value.length + userResources.value.length);
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
        "ml-auto shrink-0 rounded px-1.5 py-px font-mono text-xs font-normal ring-1 ring-border ring-inset",
    /** 二级组标签（域 / 资源 / 运维·安全）：12px，与层组标题、条目三级可辨。 */
    sectionLabelClass = "h-auto px-0 pb-1 pl-4 pr-2 pt-2 text-xs font-medium text-muted-foreground",
    /** 条目：pl-6 三级缩进；选中 = 左侧 2px 指示条 + 浅底（透明 border 保底防跳动）。 */
    itemBaseClass =
        "flex min-h-[32px] items-center gap-2 truncate rounded-md border-l-2 border-l-transparent py-1.5 pl-6 pr-2 text-sm",
    itemIdleClass = "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
    itemActiveClass = "border-l-primary bg-muted font-medium text-foreground",
    itemIconClass = "size-4 shrink-0";
</script>

<template>
    <nav
        data-testid="settings-sidebar"
        class="flex h-full flex-col gap-2 overflow-y-auto px-3 py-4"
    >
        <!-- H4 图例：首次出现处说明徽标量纲，避免「17 个入口 vs 14 项字段」被读成同一件事。
             task-175：辅助文字按 DEV-011 提到 12px。 -->
        <p
            data-testid="settings-nav-count-legend"
            class="px-2 text-xs leading-tight text-muted-foreground/70"
        >
            {{ t("settings.ia.countLegend") }}
        </p>
        <!-- 实例层：当前层默认展开 -->
        <Collapsible v-if="canSeeInstanceLayer || canSeeInstanceOps" v-model:open="instanceOpen">
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
                    <span class="truncate">{{ t("settings.ia.layerInstance") }}</span>
                    <span data-testid="settings-nav-count-instance" :class="countBadgeClass">
                        {{ t("settings.ia.entryCount", { count: instanceEntryCount }) }}
                    </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <template v-if="canSeeInstanceLayer">
                        <SidebarGroupLabel
                            as="p"
                            data-testid="settings-nav-group-secondary"
                            :class="sectionLabelClass"
                        >
                            {{ t("settings.ia.groupDomains") }}
                        </SidebarGroupLabel>
                        <SidebarMenu data-testid="settings-nav-group-items" class="gap-0.5">
                            <SidebarMenuItem v-for="item in instanceDomains" :key="item.id">
                                <router-link
                                    :to="item.path"
                                    :data-testid="'settings-nav-domain-instance-' + item.id"
                                    :class="[
                                        itemBaseClass,
                                        isDomainActive('instance', item.id)
                                            ? itemActiveClass
                                            : itemIdleClass,
                                    ]"
                                >
                                    <component
                                        :is="iconFor(DOMAIN_ICONS, item.id)"
                                        :class="itemIconClass"
                                        aria-hidden="true"
                                    />
                                    <span class="min-w-0 truncate">{{ t(item.labelKey) }}</span>
                                </router-link>
                            </SidebarMenuItem>
                        </SidebarMenu>
                        <SettingsResourceNav
                            :group-label-key="'settings.ia.groupInstanceResources'"
                            :items="instanceResources"
                        />
                    </template>

                    <!-- BL-552：ops/安全组按 canSeeInstanceOps 渲染，不被实例层能力位整段遮住。 -->
                    <template v-if="canSeeInstanceOps">
                        <div v-for="group in opsGroups" :key="group.id" class="mt-1">
                            <SidebarGroupLabel
                                as="p"
                                data-testid="settings-nav-group-secondary"
                                :class="sectionLabelClass"
                            >
                                {{ t(group.labelKey) }}
                            </SidebarGroupLabel>
                            <SidebarMenu class="gap-0.5">
                                <SidebarMenuItem v-for="item in group.items" :key="item.id">
                                    <router-link
                                        :to="item.path"
                                        :data-testid="'settings-nav-ops-' + item.id"
                                        :class="[
                                            itemBaseClass,
                                            isOpsActive(item.path)
                                                ? itemActiveClass
                                                : itemIdleClass,
                                        ]"
                                    >
                                        <component
                                            :is="iconFor(OPS_ICONS, item.id)"
                                            :class="itemIconClass"
                                            aria-hidden="true"
                                        />
                                        <span class="min-w-0 truncate">{{ t(item.labelKey) }}</span>
                                    </router-link>
                                </SidebarMenuItem>
                            </SidebarMenu>
                        </div>
                    </template>
                </CollapsibleContent>
            </SidebarGroup>
        </Collapsible>

        <!-- PLAN-0766（task-160）：共享工作区默认层。它不是"某个工作区"的设置，而是对所有
             没有显式 workspace 覆盖的工作区生效的部署级默认值；入口形态与实例/用户层一致。 -->
        <Collapsible v-model:open="workspaceDefaultOpen">
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
                    <span class="truncate">{{ t("settings.ia.layerWorkspaceDefault") }}</span>
                    <span
                        data-testid="settings-nav-count-workspace-default"
                        :class="countBadgeClass"
                    >
                        {{ t("settings.ia.entryCount", { count: workspaceDefaultEntryCount }) }}
                    </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <SidebarGroupLabel
                        as="p"
                        data-testid="settings-nav-group-secondary"
                        :class="sectionLabelClass"
                    >
                        {{ t("settings.ia.groupWorkspaceDefaultDomains") }}
                    </SidebarGroupLabel>
                    <SidebarMenu data-testid="settings-nav-group-items" class="gap-0.5">
                        <SidebarMenuItem v-for="item in workspaceDefaultDomains" :key="item.id">
                            <router-link
                                :to="item.path"
                                :data-testid="'settings-nav-domain-workspace-default-' + item.id"
                                :class="[
                                    itemBaseClass,
                                    isDomainActive('workspace-default', item.id)
                                        ? itemActiveClass
                                        : itemIdleClass,
                                ]"
                            >
                                <component
                                    :is="iconFor(DOMAIN_ICONS, item.id)"
                                    :class="itemIconClass"
                                    aria-hidden="true"
                                />
                                <span class="min-w-0 truncate">{{ t(item.labelKey) }}</span>
                            </router-link>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </CollapsibleContent>
            </SidebarGroup>
        </Collapsible>
        <!-- 用户层：非当前层默认收起，「看一眼」时点条目才导航 -->
        <Collapsible v-model:open="userOpen">
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
                    <span class="truncate">{{ t("settings.ia.layerUser") }}</span>
                    <span data-testid="settings-nav-count-user" :class="countBadgeClass">
                        {{ t("settings.ia.entryCount", { count: userEntryCount }) }}
                    </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <SidebarGroupLabel
                        as="p"
                        data-testid="settings-nav-group-secondary"
                        :class="sectionLabelClass"
                    >
                        {{ t("settings.ia.groupDomains") }}
                    </SidebarGroupLabel>
                    <SidebarMenu data-testid="settings-nav-group-items" class="gap-0.5">
                        <SidebarMenuItem v-for="item in userDomains" :key="item.id">
                            <router-link
                                :to="item.path"
                                :data-testid="'settings-nav-domain-user-' + item.id"
                                :class="[
                                    itemBaseClass,
                                    isDomainActive('user', item.id)
                                        ? itemActiveClass
                                        : itemIdleClass,
                                ]"
                            >
                                <component
                                    :is="iconFor(DOMAIN_ICONS, item.id)"
                                    :class="itemIconClass"
                                    aria-hidden="true"
                                />
                                <span class="min-w-0 truncate">{{ t(item.labelKey) }}</span>
                            </router-link>
                        </SidebarMenuItem>
                    </SidebarMenu>
                    <SettingsResourceNav
                        :group-label-key="'settings.ia.groupMyResources'"
                        :items="userResources"
                    />
                </CollapsibleContent>
            </SidebarGroup>
        </Collapsible>
    </nav>
</template>
