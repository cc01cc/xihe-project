<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { ExternalLink } from "@lucide/vue";
import { Badge } from "../../../../components/ui/badge";

/**
 * task-188 S3（MVP⑤）：steer 来源徽标（child 侧读面）。steer 复用 V49 队列后，
 * follow-up item 带 sourceKind/fromSessionId（cp-1 W0 对齐 ②）：
 * sourceKind === "agent_steer" ⇒ 渲染「来自 Lead」+ 源会话跳转；其余（human/缺省/未知值）
 * ⇒ **不渲染**（S4 反假绿钉死：null 不渲染徽标）。
 *
 * <p>只读导航：跳转 emit 给父组件接 router，本组件不碰路由。</p>
 */
const props = withDefaults(
    defineProps<{
        sourceKind?: string | null;
        fromName?: string | null;
    }>(),
    { sourceKind: null, fromName: null },
);

const emit = defineEmits<{
    /** 跳转到来源会话（Lead 侧）。 */
    navigate: [];
}>();

const { t } = useI18n();
</script>

<template>
    <span
        v-if="sourceKind === 'agent_steer'"
        class="inline-flex items-center gap-1"
        data-testid="steer-source-badge"
    >
        <Badge variant="outline" data-testid="steer-source-label">
            {{ fromName ? t("steer.fromLeadNamed", { name: fromName }) : t("steer.fromLead") }}
        </Badge>
        <button
            type="button"
            class="inline-flex size-4 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="t('steer.jumpToSource')"
            data-testid="steer-source-jump"
            @click="emit('navigate')"
        >
            <ExternalLink class="size-3" aria-hidden="true" />
        </button>
    </span>
</template>
