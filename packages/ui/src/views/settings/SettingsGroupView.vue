<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "../../stores/auth";
import type { ConfigLayer } from "../../stores/config";
import ConfigLayerPanels from "../../components/settings/ConfigLayerPanels.vue";
import LayerPrecedenceBadges from "../../components/settings/LayerPrecedenceBadges.vue";
import SettingsForbiddenView from "./SettingsForbiddenView.vue";
import InstanceReadonlyNotice from "./InstanceReadonlyNotice.vue";
import {
    DOMAIN_LABEL_KEY,
    WORKSPACE_DEFAULT_CONFIG_ATOM,
    groupDefFor,
    groupDomainsForLayer,
    type SettingsLayer,
} from "../../lib/settingsIa";

/**
 * 设置区**组页**的通用壳（task-227 立「合页，不合域」，task-485 泛化成多组共用）。
 *
 * <p><b>判据是「同一对象的相关配置一屏可达、零路由跳转」，不是「少点两次」</b>。所以本页：
 * 各段**同时挂载**（不用 tab —— 用 tab 就得额外证明「切 tab 不产生路由变化、不重载数据」，
 * 而这里连"切"这个动作都没有），页内只给**锚点导航**（`#settings-domain-<域>`）负责跳位置：
 * 锚点只改 location.hash，不触发路由，因此**不算路由跳转**。</p>
 *
 * <p><b>保存仍然按域</b>：每段各自有保存按钮（`ConfigLayerPanels.handleSave(domain)`
 * → 每域一次 PUT）。本页**不**提供「保存全部」——那要么变成合域事务（卡片明令禁止），
 * 要么一次点击扇出 N 个 PUT：后者部分失败时无法解释「哪段成了、哪段没成」，按域保存天然
 * 把结果与错误都落在该段自己的位置。</p>
 *
 * <p><b>层只认矩阵</b>：本页承载哪些段由 `groupDomainsForLayer(groupId, layer)` 从
 * `LAYER_DOMAINS` 求交集得出（`model-config`：instance 3 段 / user 3 段；`agent-config`：
 * instance 2 段 / user 2 段，工作区层只剩 `agent-runtime` 一段 ⇒ 不成组、路由不注册）。</p>
 *
 * <p><b>testid 前缀随组 id</b>（`settings-<组id>-view|title|desc|nav|nav-<域>`）：
 * 既有 e2e 对模型组断言 `settings-model-config-*` 不变；智能体组是新的
 * `settings-agent-config-*`，两组的断言互不串味。</p>
 */
const props = defineProps<{ layer: ConfigLayer; groupId: string }>();

/** 实例层写面原子（`ConfigController.java:384/392/572`），与域页同一对之一。 */
const INSTANCE_WRITE_ATOM = "WRITE_INSTANCE_CONTENT";

// 一个声明链（one-var）：后面的 computed 引用前面的，顺序即依赖顺序。
const { t } = useI18n(),
    auth = useAuthStore(),
    settingsLayer = computed(() => props.layer as SettingsLayer),
    group = computed(() => groupDefFor(props.groupId)),
    /** 本层实际承载的段（派生，不写第二份域名单）。 */
    domains = computed(() => groupDomainsForLayer(props.groupId, settingsLayer.value)),
    /** testid 前缀（随组 id，而不是写死 model-config）。 */
    testIdPrefix = computed(() => "settings-" + props.groupId),
    /**
     * 三态（task-420 / D-1254）：原子投影异步 ⇒ idle/loading 既不 403 也不放行。
     * 与 `SettingsDomainView` 同一判据（`stores/auth.ts:102-110`），不在此另立一套。
     */
    projectionPending = computed(
        () => auth.selfPermissionsStatus === "idle" || auth.selfPermissionsStatus === "loading",
    ),
    /**
     * task-5（D-1521 M-1=B）：实例层读面 = CP 的动作原子 `READ_INSTANCE_CONTENT`
     * （`ConfigController.java:89-90`），**不是** `cap:instance:admin`。
     */
    forbidden = computed(
        () =>
            props.layer === "instance" &&
            auth.selfPermissionsStatus === "ready" &&
            !auth.canReadInstanceContent,
    ),
    /** task-5（D-1521 M-2=B）：缺写原子 ⇒ 只读 + 信息条（不是 403）。 */
    instanceWriteReadonly = computed(
        () =>
            props.layer === "instance" &&
            (projectionPending.value || !auth.hasInstanceAtom?.(INSTANCE_WRITE_ATOM)),
    ),
    showInstanceReadonlyNotice = computed(
        () => instanceWriteReadonly.value && !projectionPending.value,
    ),
    /** `workspace-default` 层：可读人人、可写仅原子持有者（与域页同一判据，不在此另立一套）。 */
    panelReadonly = computed(() =>
        props.layer === "instance"
            ? instanceWriteReadonly.value
            : props.layer === "workspace-default" &&
              !auth.hasInstanceAtom?.(WORKSPACE_DEFAULT_CONFIG_ATOM),
    );

/**
 * 组页可能被直链挂载（不经过左栏）⇒ 自己取一次原子投影；缺投影时上面按"未落定"处理。
 * 与 `SettingsDomainView.onMounted` 同源，单飞由 store 负责。
 */
onMounted(() => {
    void auth.ensureSelfPermissions?.();
});

function anchorHref(domain: string): string {
    return "#settings-domain-" + domain;
}
</script>

<template>
    <SettingsForbiddenView v-if="forbidden" />
    <!-- 三态：投影未落定 ⇒ 骨架，既不 403 也不渲染可编辑面。 -->
    <div
        v-else-if="projectionPending"
        data-testid="settings-group-permission-pending"
        class="h-16 animate-pulse rounded-md bg-muted/40"
    />
    <section v-else-if="group" :data-testid="testIdPrefix + '-view'">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 :data-testid="testIdPrefix + '-title'" class="text-lg font-medium">
                {{ t(group.labelKey) }}
            </h2>
        </div>
        <p :data-testid="testIdPrefix + '-desc'" class="mt-1 text-xs text-muted-foreground">
            {{ t(group.descKey) }}
        </p>

        <LayerPrecedenceBadges class="mt-3" :layer="layer" />

        <!-- task-5（D-1521 M-2=B）：实例层缺写原子 ⇒ 只读 + 点名原子（不是 403，读面另有一个原子）。 -->
        <InstanceReadonlyNotice
            v-if="showInstanceReadonlyNotice"
            atom="WRITE_INSTANCE_CONTENT"
            :label="t('settings.permissionAtom.writeInstanceContent')"
        />

        <!--
            页内锚点导航：只用于"跳位置"，**不切换内容**。各段始终同时在 DOM 里 ⇒ 不存在
            「先点导航才看得到内容」的形态（那正是卡片禁止的「把切换路由换成切换 tab」）。
        -->
        <nav
            :data-testid="testIdPrefix + '-nav'"
            :aria-label="t(group.labelKey)"
            class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-2 text-xs"
        >
            <span class="text-muted-foreground">{{ t(group.jumpKey) }}</span>
            <a
                v-for="domain in domains"
                :key="domain"
                :data-testid="testIdPrefix + '-nav-' + domain"
                :href="anchorHref(domain)"
                class="rounded px-1 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
                {{ t(DOMAIN_LABEL_KEY[domain]) }}
            </a>
        </nav>

        <div class="mt-4">
            <ConfigLayerPanels :layer="layer" :domains="domains" :readonly="panelReadonly" />
        </div>
    </section>
</template>
