<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
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
 * PLAN-0752 T1.4：设置区左栏（**不**复用工作区 Sidebar）。
 *
 * <p>两层结构：L1 分组标题 = 层（实例配置 / 用户配置），L2 分组 = 域 / 实例运维 / 安全与权限。
 * 同一时刻只展开路由所在的那一层——「层是外框、域是二级」这条视觉读法靠它成立。</p>
 *
 * <p>权限面（V15）：实例块可见性来自 CP 投影的 cap:instance:admin 能力位
 * （auth.hasInstanceAdminCapability），不是角色名判断；roles 项要求 MANAGE_ROLES 原子。
 * 两者都 fail-closed：投影没回来就不显示。</p>
 */
const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();

onMounted(() => {
    void auth.ensureSelfPermissions();
});

const canSeeInstanceLayer = computed(() => auth.hasInstanceAdminCapability);

const activeLayer = computed(() => {
    const layer = route.meta.settingsLayer;
    return layer === "instance" || layer === "user" ? layer : "instance";
});

const activeDomain = computed(() =>
    typeof route.meta.settingsDomain === "string" ? route.meta.settingsDomain : "",
);

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

/** 运维/安全两组按能力收敛：config-locks 与 roles 各自有前置条件（详见顶注）。 */
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

function isDomainActive(layer: "instance" | "user", domain: string): boolean {
    return activeLayer.value === layer && activeDomain.value === domain;
}

function isOpsActive(path: string): boolean {
    return route.path === path;
}
</script>

<template>
    <nav
        data-testid="settings-sidebar"
        class="flex h-full flex-col gap-4 overflow-y-auto px-3 py-4"
    >
        <section v-if="canSeeInstanceLayer" aria-labelledby="settings-nav-instance">
            <p
                id="settings-nav-instance"
                data-testid="settings-nav-group-primary"
                class="px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
            >
                {{ t("settings.ia.layerInstance") }}
            </p>
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
                    data-testid="settings-nav-domain"
                    class="block min-h-[32px] truncate rounded-md px-2 py-1.5 text-sm"
                    :class="
                        isDomainActive('instance', item.id)
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    "
                >
                    {{ t(item.labelKey) }}
                </router-link>
            </div>
            <SettingsResourceNav
                :group-label-key="'settings.ia.groupInstanceResources'"
                :items="instanceResources"
            />
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
                        class="block min-h-[32px] truncate rounded-md px-2 py-1.5 text-sm"
                        :class="
                            isOpsActive(item.path)
                                ? 'bg-muted font-medium text-foreground'
                                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                        "
                    >
                        {{ t(item.labelKey) }}
                    </router-link>
                </div>
            </div>
        </section>

        <section aria-labelledby="settings-nav-user">
            <p
                id="settings-nav-user"
                data-testid="settings-nav-group-primary"
                class="px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
            >
                {{ t("settings.ia.layerUser") }}
            </p>
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
                    data-testid="settings-nav-domain"
                    class="block min-h-[32px] truncate rounded-md px-2 py-1.5 text-sm"
                    :class="
                        isDomainActive('user', item.id)
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    "
                >
                    {{ t(item.labelKey) }}
                </router-link>
            </div>
            <SettingsResourceNav
                :group-label-key="'settings.ia.groupMyResources'"
                :items="userResources"
            />
        </section>
    </nav>
</template>
