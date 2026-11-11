<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ConfigLayer } from "../../stores/config";

/**
 * PLAN-0766 T3.2：四层来源徽标 + 覆盖顺序说明。
 *
 * <p>层序（从低到高）：工作区 → 工作区默认 → 个人 → 实例；env 覆盖与管理员钉在所有
 * DB 层之上。徽标在这里只做**解释**（不是过滤控件）：用户要能一眼看出「这条默认值现在
 * 会被谁覆盖」，而不是只知道自己在编辑第几层。`workspace` 虽已从全局设置 UI 退役
 * （task-253），但它仍是层序里的最高 DB 优先级，所以四层徽标必须画它，否则
 * 「工作区默认会被工作区覆盖」这件事就没有承载面。</p>
 */
const props = defineProps<{ layer: ConfigLayer }>();
const { t } = useI18n();

const badges = computed(() =>
    [
        { id: "workspace", label: t("settings.ia.fourLayerWorkspace") },
        { id: "workspace-default", label: t("settings.ia.fourLayerWorkspaceDefault") },
        { id: "user", label: t("settings.ia.fourLayerUser") },
        { id: "instance", label: t("settings.ia.fourLayerInstance") },
    ].map((badge) => ({ ...badge, active: badge.id === props.layer })),
);
</script>

<template>
    <div data-testid="layer-precedence" class="rounded-md border bg-muted/20 px-3 py-2">
        <div class="flex flex-wrap items-center gap-1.5">
            <span class="mr-1 text-[11px] text-muted-foreground">
                {{ t("settings.ia.fourLayerOrderLabel") }}
            </span>
            <template v-for="(badge, index) in badges" :key="badge.id">
                <span v-if="index > 0" class="text-muted-foreground/60" aria-hidden="true">→</span>
                <span
                    :data-testid="'layer-badge-' + badge.id"
                    :data-active="badge.active ? 'true' : undefined"
                    class="rounded px-1.5 py-0.5 text-[11px] ring-1 ring-border ring-inset"
                    :class="
                        badge.active
                            ? 'bg-background font-medium text-foreground'
                            : 'text-muted-foreground'
                    "
                >
                    {{ badge.label }}
                </span>
            </template>
            <span class="ml-1 text-[11px] text-muted-foreground">{{
                t("settings.ia.fourLayerLowToHigh")
            }}</span>
        </div>
        <p class="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {{ t("settings.ia.fourLayerDetail") }}
        </p>
    </div>
</template>
