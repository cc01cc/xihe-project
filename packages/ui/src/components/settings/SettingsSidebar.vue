<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { ChevronRight } from "@lucide/vue";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
 * **两个可折叠层分组**：
 *
 * - **层由路由决定，左栏不提供切换器**：/settings/instance/** 与 /settings/user/** 各自是
 *   独立页面，URL 可分享、浏览器后退可用。左栏只做两件与「层」有关的事：① 当前层默认展开、
 *   另一层默认收起（展开只是「看一眼」，点其中条目才发生导航）；② 组内仍按「域 / 实例运维 /
 *   安全与权限」做第二维分段。
 * - 「实例运维 / 安全与权限」属于**实例层**，所以它们现在收在实例分组内部；用户层不再顺带
 *   看到它们（旧实现是并列 section，切到用户层也照显示）。
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
    return layer === "instance" || layer === "user" ? layer : "instance";
});

const activeDomain = computed(() =>
    typeof route.meta.settingsDomain === "string" ? route.meta.settingsDomain : "",
);

/** 当前层默认展开、另一层默认收起；跨层导航时跟着路由翻。 */
const instanceOpen = ref(activeLayer.value === "instance");
const userOpen = ref(activeLayer.value === "user");
watch(activeLayer, (layer) => {
    instanceOpen.value = layer === "instance";
    userOpen.value = layer === "user";
});

const instanceDomains = computed<SettingsNavItem[]>(() =>
    domainsForLayer("instance").map((domain) => ({
        id: domain,
        labelKey: DOMAIN_LABEL_KEY[domain],
        path: settingsDomainPath("instance", domain),
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

function isDomainActive(layer: "instance" | "user", domain: string): boolean {
    return activeLayer.value === layer && activeDomain.value === domain;
}

function isOpsActive(path: string): boolean {
    return route.path === path;
}

/**
 * 组标题就是折叠开关。刻意**不**在 CollapsibleTrigger 上再绑 click —— reka 的 trigger 自带
 * 切换行为，绑第二次会双重翻转（packages/ui/AGENTS.md「Reka UI 交互陷阱」）。
 */
const primaryClass =
    "flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:bg-muted/60";
const itemBaseClass = "block min-h-[32px] truncate rounded-md px-2 py-1.5 text-sm";
const itemIdleClass = "text-muted-foreground hover:bg-muted/60 hover:text-foreground";
const itemActiveClass = "bg-muted font-medium text-foreground";
</script>

<template>
    <nav
        data-testid="settings-sidebar"
        class="flex h-full flex-col gap-2 overflow-y-auto px-3 py-4"
    >
        <!-- H4 图例：首次出现处说明徽标量纲，避免「17 个入口 vs 14 项字段」被读成同一件事。 -->
        <p
            data-testid="settings-nav-count-legend"
            class="px-2 text-[10px] leading-tight text-muted-foreground/70"
        >
            {{ t("settings.ia.countLegend") }}
        </p>
        <!-- 实例层：当前层默认展开 -->
        <Collapsible v-if="canSeeInstanceLayer || canSeeInstanceOps" v-model:open="instanceOpen">
            <section aria-labelledby="settings-nav-instance">
                <CollapsibleTrigger
                    id="settings-nav-instance"
                    data-testid="settings-nav-group-primary"
                    :class="primaryClass"
                >
                    <ChevronRight
                        class="size-3 shrink-0 transition-transform"
                        :class="instanceOpen ? 'rotate-90' : ''"
                        aria-hidden="true"
                    />
                    <span class="truncate">{{ t("settings.ia.layerInstance") }}</span>
                    <span
                        data-testid="settings-nav-count-instance"
                        class="ml-auto shrink-0 rounded px-1.5 py-px font-mono text-[10px] font-normal ring-1 ring-border ring-inset"
                    >
                        {{ t("settings.ia.entryCount", { count: instanceEntryCount }) }}
                    </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <template v-if="canSeeInstanceLayer">
                        <p
                            data-testid="settings-nav-group-secondary"
                            class="px-2 pb-1 text-[11px] text-muted-foreground"
                        >
                            {{ t("settings.ia.groupDomains") }}
                        </p>
                        <div data-testid="settings-nav-group-items" class="space-y-0.5">
                            <router-link
                                v-for="item in instanceDomains"
                                :key="item.id"
                                :to="item.path"
                                :data-testid="'settings-nav-domain-instance-' + item.id"
                                :class="[
                                    itemBaseClass,
                                    isDomainActive('instance', item.id)
                                        ? itemActiveClass
                                        : itemIdleClass,
                                ]"
                            >
                                {{ t(item.labelKey) }}
                            </router-link>
                        </div>
                        <SettingsResourceNav
                            :group-label-key="'settings.ia.groupInstanceResources'"
                            :items="instanceResources"
                        />
                    </template>

                    <!-- BL-552：ops/安全组按 canSeeInstanceOps 渲染，不被实例层能力位整段遮住。 -->
                    <template v-if="canSeeInstanceOps">
                        <div v-for="group in opsGroups" :key="group.id" class="mt-3">
                            <p
                                data-testid="settings-nav-group-secondary"
                                class="px-2 pb-1 text-[11px] text-muted-foreground"
                            >
                                {{ t(group.labelKey) }}
                            </p>
                            <div class="space-y-0.5">
                                <router-link
                                    v-for="item in group.items"
                                    :key="item.id"
                                    :to="item.path"
                                    :data-testid="'settings-nav-ops-' + item.id"
                                    :class="[
                                        itemBaseClass,
                                        isOpsActive(item.path) ? itemActiveClass : itemIdleClass,
                                    ]"
                                >
                                    {{ t(item.labelKey) }}
                                </router-link>
                            </div>
                        </div>
                    </template>
                </CollapsibleContent>
            </section>
        </Collapsible>

        <!-- 用户层：非当前层默认收起，「看一眼」时点条目才导航 -->
        <Collapsible v-model:open="userOpen">
            <section aria-labelledby="settings-nav-user">
                <CollapsibleTrigger
                    id="settings-nav-user"
                    data-testid="settings-nav-group-primary"
                    :class="primaryClass"
                >
                    <ChevronRight
                        class="size-3 shrink-0 transition-transform"
                        :class="userOpen ? 'rotate-90' : ''"
                        aria-hidden="true"
                    />
                    <span class="truncate">{{ t("settings.ia.layerUser") }}</span>
                    <span
                        data-testid="settings-nav-count-user"
                        class="ml-auto shrink-0 rounded px-1.5 py-px font-mono text-[10px] font-normal ring-1 ring-border ring-inset"
                    >
                        {{ t("settings.ia.entryCount", { count: userEntryCount }) }}
                    </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <p
                        data-testid="settings-nav-group-secondary"
                        class="px-2 pb-1 text-[11px] text-muted-foreground"
                    >
                        {{ t("settings.ia.groupDomains") }}
                    </p>
                    <div data-testid="settings-nav-group-items" class="space-y-0.5">
                        <router-link
                            v-for="item in userDomains"
                            :key="item.id"
                            :to="item.path"
                            :data-testid="'settings-nav-domain-user-' + item.id"
                            :class="[
                                itemBaseClass,
                                isDomainActive('user', item.id) ? itemActiveClass : itemIdleClass,
                            ]"
                        >
                            {{ t(item.labelKey) }}
                        </router-link>
                    </div>
                    <SettingsResourceNav
                        :group-label-key="'settings.ia.groupMyResources'"
                        :items="userResources"
                    />
                </CollapsibleContent>
            </section>
        </Collapsible>
    </nav>
</template>
