<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import type { ResourceId, ResourceLayer } from "../../lib/settingsIa";

/**
 * PLAN-0772 M2（设计决策 8）：资源页的**层 tab** —— 新建组件，不是复用既有切换器。
 *
 * <p>为什么必须新建（`task-181` 只读盘点，`design.md` 决策 8）：全仓没有层切换器；层是路由属性
 * （`meta.settingsLayer`），`SettingsLayerHeader` **只显示不切换**且只由 `SettingsLayout` 渲染
 * ⇒ 资源页搬出 `/settings` 之后，层身份只能靠本组件 + `ResourcesLayout` 自带。</p>
 *
 * <p>三条硬口径：</p>
 * <ul>
 *   <li><b>文案写所属主体</b>（我的 / 本工作区 / 全平台），不写「用户层 / 工作区层 / 实例层」
 *       —— 用户 2026-11-12 逐屏表态的口径，也是本计划唯一被驳回重画的一条（Q4）。</li>
 *   <li><b>无权/未实现的层留在 DOM</b>：`disabled` + 理由文案（D7「留位不隐藏」；隐藏会让人
 *       以为产品没这个能力）。<b>当前层不 disabled</b> —— 否则深链进来会出现"选中的 tab 点不动"。</li>
 *   <li><b>不自己算权限</b>：`disabledReason` 由 `ResourcesLayout` 传进来（那里才拿得到 auth 与
 *       路由上下文），本组件只负责呈现。</li>
 * </ul>
 */
const props = defineProps<{
    /** 该资源**真实存在**的层（`RESOURCE_DEFS[].layerRules`，不是全三层）。 */
    resourceId: ResourceId;
    layers: readonly ResourceLayer[];
    active: ResourceLayer;
    /** 该层不可进入的一句话理由；有值的 tab 仍渲染（disabled），当前层除外。 */
    disabledReason?: Partial<Record<ResourceLayer, string>>;
}>();

const emit = defineEmits<{ select: [layer: ResourceLayer] }>();

const { t } = useI18n();

/**
 * 每个 (资源, 层) 的 tab 文案都不同（凭据 = 我的凭据 / 技能 = 我的技能 / 智能体 = 我的主体…），
 * 所以键必须带资源段；`resources.layerTab` 里按资源分组，缺键时回落到通用层名。
 */
function labelOf(layer: ResourceLayer): string {
    const tabKey = `resources.layerTab.${props.resourceId}.${layer}`;
    if (t(tabKey) !== tabKey) return t(tabKey);
    const generic: Record<ResourceLayer, string> = {
        USER: "resources.layerUser",
        WORKSPACE: "resources.layerWorkspace",
        INSTANCE: "resources.layerInstance",
    };
    return t(generic[layer]);
}

const reasons = computed(() =>
    props.layers
        .map((layer) => ({ layer, text: props.disabledReason?.[layer] }))
        .filter((entry): entry is { layer: ResourceLayer; text: string } => !!entry.text),
);

function select(value: string | number | undefined) {
    if (typeof value !== "string") return;
    if (!props.layers.includes(value as ResourceLayer)) return;
    emit("select", value as ResourceLayer);
}
</script>

<template>
    <div data-testid="resource-layer-tabs" class="flex flex-col gap-1.5">
        <Tabs :model-value="active" @update:model-value="select">
            <TabsList variant="line" :aria-label="t('resources.tabsLabel')">
                <!--
                    task-124：禁用态对比度（浅深不同案，一个类自动分叉）。vendor TabsTrigger 的禁用观感 =
                    整行 disabled:opacity-50(.5) × 文字自身 alpha。light 基色 text-foreground/60(.6) 与 .5
                    相乘 = 有效 .30、实测 2.03 FAIL（天花板 2.101 数学不可达）⇒ 撤**文字 alpha** 这层
                    （disabled:text-foreground 顶成实色），.5 整行 opacity 保留为唯一单层（有效 .5 → 约 3.55
                    PASS）。dark 基色 dark:text-muted-foreground 本就是实色（单层 2.671 FAIL）⇒ dark 侧顶成
                    text-foreground（0.985，比 0.708 亮一档）、.5 不动（单层 → 约 5.15 PASS）。注意 dark 变体
                    是 @custom-variant dark (&:is(.dark *))（main.css:71）——:is() 取内部最高特异性 ⇒
                    dark:text-muted-foreground 实为 0,2,0，与 disabled:text-foreground（0,2,0）打平后凭源码序
                    胜出 ⇒ dark 侧必须再叠一层 dark:disabled:text-foreground（0,3,0）才压得住（实测教训）。
                    旧的自加 opacity-60 是死代码：vendor disabled:opacity-50（0,2,0）特异性压过裸
                    opacity-60（0,1,0），删掉对比度不变。hover 安全：vendor disabled:pointer-events-none
                    ⇒ 禁用 tab 不接收指针，hover:text-foreground 永不触发（实测悬停三项全不变）。
                    非颜色通道不动：disabled 属性 / title / 光标类 / 下方可见理由列表全保留。
                -->
                <TabsTrigger
                    v-for="layer in layers"
                    :key="layer"
                    :value="layer"
                    :data-testid="`resource-layer-tab-${layer}`"
                    :disabled="layer !== active && !!disabledReason?.[layer]"
                    :title="disabledReason?.[layer] ?? undefined"
                    :class="
                        disabledReason?.[layer] && layer !== active
                            ? 'cursor-not-allowed disabled:text-foreground dark:disabled:text-foreground'
                            : undefined
                    "
                >
                    {{ labelOf(layer) }}
                </TabsTrigger>
            </TabsList>
        </Tabs>
        <!--
            理由必须**可读**而不只躺在 title 里（N-09：悬停才看得到的信息对键盘/触屏用户等于没有）。
            列表跟着 tab 条走，一行说完：哪个层、为什么不可用。
        -->
        <!-- 每层一条独立成行：多层的理由拼成一行会糊成一团（实测宽屏下「技能」页同时禁用两层时读不动）。 -->
        <ul
            v-if="reasons.length"
            data-testid="resource-layer-disabled-reasons"
            class="space-y-1 text-xs leading-relaxed text-muted-foreground"
        >
            <li class="sr-only">
                {{ t("resources.disabledHint") }}
            </li>
            <li v-for="entry in reasons" :key="entry.layer">
                <span class="font-medium text-foreground/80">{{ labelOf(entry.layer) }}</span
                >：{{ entry.text }}
            </li>
        </ul>
    </div>
</template>
