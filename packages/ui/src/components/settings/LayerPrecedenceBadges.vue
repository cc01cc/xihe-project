<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ConfigLayer } from "../../stores/config";
import { SETTINGS_LAYERS } from "../../lib/settingsIa";

/**
 * PLAN-0766 T3.2：四层来源徽标 + 覆盖顺序说明。
 *
 * <p>层序（**高 → 低**，与左栏组顺序同源 = `SETTINGS_LAYERS`）：工作区 → 工作区默认 → 个人 → 实例；
 * env 覆盖与管理员钉在所有 DB 层之上。徽标在这里只做**解释**（不是过滤控件）：用户要能一眼看出
 * 「这条默认值现在会被谁覆盖」，而不是只知道自己在编辑第几层。`workspace` 虽已从全局设置 UI 退役
 * （task-253），但它仍是层序里的最高 DB 优先级，所以四层徽标必须画它，否则
 * 「工作区默认会被工作区覆盖」这件事就没有承载面。</p>
 *
 * <p>task-77：**层顺序只许有一份真相** —— 中间三层从 `SETTINGS_LAYERS` 派生（高 → 低），
 * 禁止在这里再手写一份顺序数组；`workspace` 因为不在全局设置层枚举里，单独前置并注明理由。</p>
 */
const props = defineProps<{ layer: ConfigLayer }>();
const { t } = useI18n();

const LAYER_LABEL_KEY: Record<"workspace-default" | "user" | "instance", string> = {
    "workspace-default": "settings.ia.fourLayerWorkspaceDefault",
    user: "settings.ia.fourLayerUser",
    instance: "settings.ia.fourLayerInstance",
};

const badges = computed(() =>
    [
        { id: "workspace", label: t("settings.ia.fourLayerWorkspace") },
        ...[...SETTINGS_LAYERS]
            .reverse()
            .map((layer) => ({ id: layer, label: t(LAYER_LABEL_KEY[layer]) })),
    ].map((badge) => ({ ...badge, active: badge.id === props.layer })),
);
</script>

<template>
    <div data-testid="layer-precedence" class="rounded-md border bg-muted/20 px-3 py-2">
        <div class="flex flex-wrap items-center gap-1.5">
            <span class="mr-1 text-xs text-muted-foreground">
                {{ t("settings.ia.fourLayerOrderLabel") }}
            </span>
            <template v-for="(badge, index) in badges" :key="badge.id">
                <!--
                    task-138：层序箭头原为 `text-muted-foreground/60` —— 单层 color alpha .6 叠在
                    `bg-muted/20` 的合成底上，实测浅 2.36 / 深 3.314（need 4.5，**两侧都不达**）。
                    修法 = **撤掉那一层 alpha**（不是换 token）：实色 `text-muted-foreground` 实测
                    浅 5.031 / 深 6.736，且与左右徽标文字同色 —— 箭头本来只是分隔符，比徽标更淡没有信息含义。
                    可点态/禁用态：本元素无 button 祖先、无 aria-disabled（探针 disabled=false）；
                    即便按 `aria-hidden` 论成装饰（1.4.11 3:1 已过），也不拿装饰口径当 1.4.3 的逃生门
                    （contrast-probe 第 28-32 行明令），故按 4.5 判。
                -->
                <span v-if="index > 0" class="text-xs text-muted-foreground" aria-hidden="true"
                    >→</span
                >
                <span
                    :data-testid="'layer-badge-' + badge.id"
                    :data-active="badge.active ? 'true' : undefined"
                    class="rounded px-1.5 py-0.5 text-xs ring-1 ring-border ring-inset"
                    :class="
                        badge.active
                            ? 'bg-background font-medium text-foreground'
                            : 'text-muted-foreground'
                    "
                >
                    {{ badge.label }}
                </span>
            </template>
            <span class="ml-1 text-xs text-muted-foreground">{{
                t("settings.ia.fourLayerLowToHigh")
            }}</span>
        </div>
        <p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {{ t("settings.ia.fourLayerDetail") }}
        </p>
    </div>
</template>
