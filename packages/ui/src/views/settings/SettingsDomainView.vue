<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { Info } from "@lucide/vue";
import { useAuthStore } from "../../stores/auth";
import { useConfigStore, type ConfigLayer } from "../../stores/config";
import ConfigLayerPanels from "../../components/settings/ConfigLayerPanels.vue";
import ColorSchemePanel from "../../components/settings/ColorSchemePanel.vue";
import SettingsForbiddenView from "./SettingsForbiddenView.vue";
import SettingsNotFoundView from "./SettingsNotFoundView.vue";
import ToolFacesView from "./ToolFacesView.vue";
import {
    DOMAIN_LABEL_KEY,
    WORKSPACE_DEFAULT_CONFIG_ATOM,
    isInstanceOnlyForUser,
    resolveLayerRoute,
} from "../../lib/settingsIa";
import LayerPrecedenceBadges from "../../components/settings/LayerPrecedenceBadges.vue";
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
    layer: ConfigLayer;
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

/**
 * task-170（用户审阅补充）：内部术语域（如 agent-runtime）只靠域名读不出「这页是干嘛的」，
 * 给一句白话副标题；只登记确实需要解释的域，其余域不加噪声。
 */
const DOMAIN_HINT_KEY: Record<string, string> = {
    "agent-runtime": "settings.domainAgentRuntimeHint",
};
const domainHintKey = computed(() =>
    resolved.value.ok ? DOMAIN_HINT_KEY[resolved.value.domain] : undefined,
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
 * PLAN-0766 T3.3：workspace-default 层**可读人人、可写仅原子持有者**。没有
 * `MANAGE_WORKSPACE_DEFAULT_CONFIG` 时不是 403 死页（CP 仍允许读），而是「只读 + 说明」：
 * 页面照常取数，控件禁用，信息条点名缺哪个原子。权限判据只认原子投影
 * （auth.hasInstanceAtom），**不写 isInstanceAdmin 之类的角色名特判**。
 */
const workspaceDefaultReadonly = computed(
    () =>
        resolved.value.ok &&
        resolved.value.layer === "workspace-default" &&
        !auth.hasInstanceAtom?.(WORKSPACE_DEFAULT_CONFIG_ATOM),
);
const panelReadonly = computed(
    () =>
        resolved.value.ok && resolved.value.layer !== "instance" && workspaceDefaultReadonly.value,
);

/**
 * 三态而不是两态（task-112）：数据回来前 `keyCount` 必然是 0，若照常渲染「本域 0 项配置」+ 空表单，
 * 就是把 unknown 折成结论 —— **「还没回来」≠「没有配置」**（同族前例：无 atom ≠ 403、未落定 ≠ 拒绝）。
 *
 * 判据必须**单调**，所以用的不是 `configStore.layerLoading`（瞬时标志）而是「该层是否已有任何域载荷」
 * —— `layerConfig[layer]` 非空 ⇐ `loadLayerDomains` 成功写入（`stores/config.ts:299`），一旦落定就不会退回。
 *
 * **为什么不能用 `layerLoading`（task-121 回归）**：`ProviderHub.load()` 在面板挂载时也会调
 * `loadLayerDomains`（`ProviderHub.vue:763`）⇒ 「面板挂载 → 触发 load → `layerLoading` 真 → pending 真
 * → 面板卸载 → 取数结束 → 面板重挂」自持循环（dev-3 e2e 实测：5.357 s 内 672 次 `/provider-catalog`、
 * 9 个域各 337 次）。单调判据下，重挂后的那次 load 不改变 pending，循环不成立。
 */
const layerSettled = computed(
    () => Object.keys(configStore.layerConfig[layer.value] ?? {}).length > 0,
);
const pending = computed(() => !layerSettled.value && !fetchError.value);
/**
 * 失败时同样不渲染计数——「取数失败」也不是「没有配置」。
 *
 * task-157 两量纲（D-926 E 维）：页头主文案只陈述「本域 N 个配置键」（N = 本层 entries 键数，
 * 不含继承/生效值）；可编辑字段数 M 由面板上报（M = 本页允许编辑的**字段**数）。
 * N=0 时连主文案也不显示（DEV-011 §1 P0-C-01：不再出现「本域 0 项配置」与说明卡并存的矛盾）。
 *
 * task-78：M 从「右侧整句次量纲」降级为**标题右侧极小号徽标**（用户点名第 5 条）。
 * 保留而不删的理由 = 字段行只在域卡展开后存在（`ConfigDomainPanel.vue:462`），默认折叠 ⇒
 * 用户看不见也数不出，M 是唯一线索。
 */
const showSummary = computed(
    () => activeTab.value === "policy" && !pending.value && !fetchError.value && keyCount.value > 0,
);
/** M>0 才显示；纯引导页/连接管理页没有可编辑字段 ⇒ 不显示徽标（task-78）。 */
const editableCount = ref(0);
/**
 * task-285：计数的口径附注（`ConfigLayerPanels` 用第二个事件给）。只有「静态字段数 != 全部可编辑项」
 * 的域才非空（目前是 `context-policy`：`models` 是行数随数据变化的按模型覆盖子表）。
 * 为什么不写成「N 项」的一部分：句子由子表所在组件算（它才知道有几行），这里只负责显示。
 */
const editableCountNote = ref("");
const showEditableCount = computed(
    () =>
        activeTab.value === "policy" &&
        !pending.value &&
        !fetchError.value &&
        editableCount.value > 0,
);

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
    // 原子投影按会话取一次；缺投影时 fail-closed（readonly 生效），CP 仍是权威。
    void auth.ensureSelfPermissions?.();
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
            <!--
                task-78（用户点名的第 5 条）：这句「本页 N 个可编辑字段」原来是一整句元信息放在
                右侧，用户不会因为知道"共有 3 个"而改变操作 ⇒ 降级为**标题右侧的极小号计数徽标**。
                为什么不整句删：`ConfigDomainPanel` 的字段行只在**展开后**存在（`:462 v-if="expanded"`），
                默认折叠 ⇒ 用户**默认看不见**字段、数不出来，"这一域有多少可编辑字段"就只剩这一处
                线索（判据按"用户实际能看到什么"算，不按 DOM 里有没有算）。分类与证据见
                `evidence/2026-11-12-copy-sweep/domain-editable-count.md`。
                量纲保留「可编辑 N 项」而不是裸数字：域卡标题上的徽标数的是**该卡字段数**（含锁定的），
                两者量纲不同，裸数字会读成同一件事。
            -->
            <span
                v-if="showEditableCount"
                data-testid="settings-domain-editable-count"
                class="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs leading-none tabular-nums text-muted-foreground"
            >
                {{ t("settings.ia.domainEditableCount", { count: editableCount }) }}
            </span>
            <!-- task-285：计数只数静态可枚举字段；子表行数另计，必须在计数旁自述口径。 -->
            <span
                v-if="showEditableCount && editableCountNote"
                data-testid="settings-domain-editable-count-note"
                class="shrink-0 text-xs leading-none text-muted-foreground"
            >
                {{ editableCountNote }}
            </span>
            <p
                v-if="showSummary"
                data-testid="settings-domain-summary"
                class="text-xs text-muted-foreground"
            >
                {{ t("settings.ia.domainKeysCount", { count: keyCount }) }}
            </p>
            <!-- 右侧只留层切换入口（task-78：可编辑字段数已降级为标题徽标） -->
            <div class="ml-auto flex items-center gap-3">
                <button
                    v-if="instanceOnly"
                    type="button"
                    data-testid="settings-switch-layer"
                    class="rounded px-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    @click="blocked = true"
                >
                    {{ t("settings.ia.switchToUserLayer") }}
                </button>
            </div>
        </div>
        <p
            v-if="domainHintKey"
            data-testid="settings-domain-hint"
            class="mt-2 text-xs text-muted-foreground"
        >
            {{ t(domainHintKey) }}
        </p>

        <div
            v-if="blocked && instanceOnly"
            data-testid="settings-layer-block-notice"
            class="mt-3 flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs"
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

        <!-- PLAN-0766 T3.2：四层徽标 + 覆盖顺序说明（存量工作区即时生效）。 -->
        <LayerPrecedenceBadges v-if="resolved.ok" class="mt-3" :layer="layer" />

        <!--
            task-31：本信息条**不是** `SettingsPermissionGate` 的 `no-atom`，两者语义相反，故 testid 必须分开：
              · Gate `settings-no-atom-notice` ＝「CP 侧本页**根本没有**权限原子」（audit / monitoring /
                knowledge 这类页）⇒ 本页不做额外权限筛选，也不会出现 403；
              · 本处 `settings-ws-default-readonly-notice` ＝「原子**存在**，但当前账号未持有
                `MANAGE_WORKSPACE_DEFAULT_CONFIG`」⇒ 只读 + 点名缺哪个原子，同样不是 403。
            路由层面两者互斥（本页只服务 `/settings/{instance,user,workspace-default}/{配置域}`，
            而 Gate 的 no-atom 挂在 `/settings/{audit,monitoring,knowledge}` 等独立视图），
            但**互斥只是路由的偶然结果，不是可依赖的不变式**；要守的是「一个 testid 只表达一种语义」——
            否则 e2e 里 `getByTestId("settings-no-atom-notice")` 命中的可能是相反的含义。
        -->
        <div
            v-if="workspaceDefaultReadonly"
            data-testid="settings-ws-default-readonly-notice"
            class="mt-3 flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs"
        >
            <Info class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
                <p class="font-medium">{{ t("settings.ia.wsDefaultReadonlyTitle") }}</p>
                <p class="mt-0.5 leading-relaxed text-muted-foreground">
                    {{ t("settings.ia.wsDefaultReadonlyDetail") }}
                </p>
            </div>
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
            class="mt-4 text-xs text-muted-foreground"
        >
            {{ t("common.loading") }}
        </p>
        <div v-if="activeTab === 'tool-faces' && toolFacesTab" class="mt-4">
            <ToolFacesView embedded />
        </div>
        <!--
            task-121：面板树用 `v-show` 而不是 `v-if`/`v-else` —— 加载态**只切换可见性，不卸载面板**。
            `v-if` 会让「面板挂载 ⇒ 有组件回写 `layerLoading`（如旧 ProviderHub.vue:763）⇒ pending 真 ⇒
            面板卸载 ⇒ 重挂」形成自持循环（dev-3 实测 63 轮/秒）；卸载闸门一旦存在，任何回写方都会复现，
            所以这一层用「常挂 + 隐藏」把该类缺陷整体挡掉。
        -->
        <!--
            task-48 M2：配色方案（5 个 shadcn-vue base color + 明暗）挂在「用户偏好」域页。
            它是**纯客户端偏好**（localStorage `xihe-color-scheme` + `<html data-xh-color>`），
            不是 CP 配置键，所以不进 `ConfigLayerPanels` 的字段树（那里每个字段都要有
            GET /config/{domain}/meta 的 source 与 PUT 通道；硬塞进去会让「未保存/继承」语义说谎）。
        -->
        <ColorSchemePanel v-if="resolved.domain === 'user-preference'" />

        <div
            v-show="!pending && !(activeTab === 'tool-faces' && toolFacesTab)"
            class="mt-4"
            data-testid="settings-domain-panels"
            :aria-busy="pending"
            :inert="pending || undefined"
        >
            <ConfigLayerPanels
                :layer="layer"
                :domain="resolved.domain"
                :readonly="panelReadonly"
                @editable-count="editableCount = $event"
                @editable-count-note="editableCountNote = $event"
            />
        </div>
    </section>
</template>
