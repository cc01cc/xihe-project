<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { Info } from "@lucide/vue";
import { useAuthStore } from "../../stores/auth";
import { useConfigStore, type ConfigLayer } from "../../stores/config";
import ConfigLayerPanels from "../../components/settings/ConfigLayerPanels.vue";
import SettingsForbiddenView from "./SettingsForbiddenView.vue";
import SettingsNotFoundView from "./SettingsNotFoundView.vue";
import ToolFacesView from "./ToolFacesView.vue";
import { DOMAIN_LABEL_KEY, isInstanceOnlyForUser, resolveLayerRoute } from "../../lib/settingsIa";
import { logger } from "../../lib/logger";

/**
 * PLAN-0752 T1.2 / M1 骨架：一个域页（后续 M3 按批铺其余域，不在此一次铺开）。
 *
 * <p>层的入口三分支（verify.md「入口分层」）：矩阵里没有该组合 ⇒ 404 视图；层存在但当前
 * 账号无 cap:instance:admin ⇒ 403 视图且**不请求数据**；否则渲染域页。</p>
 *
 * <p>V26：实例独占域（logging / approval-policy / job-policy）给「切到用户层」入口，点击
 * 只出提示不跳转——即使用户手滑，也不会被 404 吓一跳；直链 404 由路由兜底（V3/V25）。</p>
 */
const props = defineProps<{
    /** 路由 props：只在矩阵里存在的组合才会挂上这个组件（router/index.ts 逐域注册）。 */
    layer: "instance" | "user";
    domain: string;
}>();

const { t } = useI18n();
const auth = useAuthStore();
const configStore = useConfigStore();

const resolved = computed(() => resolveLayerRoute(props.layer, props.domain));

const layer = computed<ConfigLayer>(() => (resolved.value.ok ? resolved.value.layer : "user"));

const domainLabel = computed(() =>
    resolved.value.ok ? t(DOMAIN_LABEL_KEY[resolved.value.domain]) : "",
);

/** 实例层需要 CP 的 cap:instance:admin（auth.hasInstanceAdminCapability），不是角色名判断。 */
const forbidden = computed(
    () =>
        resolved.value.ok &&
        resolved.value.layer === "instance" &&
        !auth.hasInstanceAdminCapability,
);

const instanceOnly = computed(
    () =>
        resolved.value.ok &&
        resolved.value.layer === "instance" &&
        isInstanceOnlyForUser(resolved.value.domain),
);

const blocked = ref(false);
const fetchError = ref(false);

/**
 * 三态而不是两态（task-112）：loading 期间 `keyCount` 必然是 0，若照常渲染「本域 0 项配置」
 * 加空表单，就是把 unknown 折成结论 —— **「还没回来」≠「没有配置」**（同族前例：无 atom ≠ 403、
 * 未落定 ≠ 拒绝）。`configStore.layerLoading` 是唯一进度事实源
 * （`stores/config.ts:139` 定义、`:262` 置真、`:306` 复位），域页此前零引用。
 */
const pending = computed(() => configStore.layerLoading);

/**
 * PLAN-0752 T3.3 / design 决策 #7 + D2：工具分类归入 approval-policy 域，**不单独占顶级设置页**。
 * 形态是「域页内二级页签（一域两视图）」，不是独立子路由——所以 `?tab=` 只表达**域内视图**，
 * 不表达层（层仍然只在 URL 的 `/settings/{layer}/{domain}` 段里，V25 不变）。
 * 旧书签 `/settings/tool-faces` 由 router 重定向到这里并带上 `?tab=tool-faces`。
 */
const route = useRoute();
const router = useRouter();
const toolFacesTab = computed(
    () =>
        resolved.value.ok &&
        resolved.value.layer === "instance" &&
        resolved.value.domain === "approval-policy",
);
const activeTab = ref<"policy" | "tool-faces">("policy");

function syncTabFromQuery(): void {
    activeTab.value =
        toolFacesTab.value && route.query.tab === "tool-faces" ? "tool-faces" : "policy";
}

function selectTab(tab: "policy" | "tool-faces"): void {
    activeTab.value = tab;
    void router.replace({
        query:
            tab === "tool-faces"
                ? { ...route.query, tab: "tool-faces" }
                : { ...route.query, tab: undefined },
    });
}

watch(() => route.query.tab, syncTabFromQuery);

const keyCount = computed(() => {
    if (!resolved.value.ok) return 0;
    return Object.keys(configStore.layerConfig[layer.value]?.[resolved.value.domain] ?? {}).length;
});

async function load() {
    if (!resolved.value.ok || forbidden.value) return;
    fetchError.value = false;
    try {
        await configStore.loadLayerDomains(layer.value);
    } catch (e) {
        logger.warn("Failed to load settings domain layer " + layer.value, e);
        fetchError.value = true;
    }
}

onMounted(() => {
    syncTabFromQuery();
    void load();
});
watch(
    () => [layer.value, resolved.value.ok ? resolved.value.domain : ""],
    () => {
        void load();
    },
);
</script>

<template>
    <SettingsNotFoundView v-if="!resolved.ok" />
    <SettingsForbiddenView v-else-if="forbidden" />
    <section v-else data-testid="settings-domain-view">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 data-testid="settings-domain-title" class="text-lg font-medium">
                {{ domainLabel }}
            </h2>
            <p
                v-if="activeTab === 'policy' && !pending"
                data-testid="settings-domain-summary"
                class="text-[11px] text-muted-foreground"
            >
                {{ t("settings.ia.domainKeysCount", { count: keyCount }) }}
            </p>
            <button
                v-if="instanceOnly"
                type="button"
                data-testid="settings-switch-layer"
                class="ml-auto rounded px-1 text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                @click="blocked = true"
            >
                {{ t("settings.ia.switchToUserLayer") }}
            </button>
        </div>

        <div
            v-if="blocked && instanceOnly"
            data-testid="settings-layer-block-notice"
            class="mt-3 flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-[11px]"
        >
            <Info class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
                <p class="font-medium">{{ t("settings.ia.layerOnlyInstance") }}</p>
                <p class="mt-0.5 leading-relaxed text-muted-foreground">
                    {{ t("settings.ia.layerOnlyInstanceDetail", { domain: domainLabel }) }}
                </p>
            </div>
            <button
                type="button"
                class="rounded px-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                @click="blocked = false"
            >
                {{ t("settings.ia.dismiss") }}
            </button>
        </div>

        <p v-if="fetchError" class="mt-3 text-sm text-muted-foreground">
            {{ t("settings.saveFailed") }}
        </p>

        <div
            v-if="toolFacesTab"
            data-testid="settings-domain-tabs"
            role="tablist"
            :aria-label="domainLabel"
            class="mt-3 flex items-center gap-1 border-b"
        >
            <button
                v-for="tab in ['policy', 'tool-faces'] as const"
                :key="tab"
                type="button"
                role="tab"
                :data-testid="'settings-domain-tab-' + tab"
                :aria-selected="activeTab === tab"
                class="-mb-px min-h-8 border-b-2 px-2 text-xs transition-colors"
                :class="
                    activeTab === tab
                        ? 'border-foreground font-medium text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                "
                @click="selectTab(tab)"
            >
                {{
                    tab === "policy"
                        ? t("settings.ia.approvalTabPolicy")
                        : t("settings.ia.navToolFaces")
                }}
            </button>
        </div>

        <p
            v-if="pending"
            data-testid="settings-domain-loading"
            class="mt-4 text-[11px] text-muted-foreground"
        >
            {{ t("common.loading") }}
        </p>
        <div v-else-if="activeTab === 'tool-faces' && toolFacesTab" class="mt-4">
            <ToolFacesView embedded />
        </div>
        <div v-else class="mt-4">
            <ConfigLayerPanels :layer="layer" :domain="resolved.domain" />
        </div>
    </section>
</template>
