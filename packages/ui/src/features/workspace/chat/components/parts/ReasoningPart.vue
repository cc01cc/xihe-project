<script setup lang="ts">
/**
 * 2026-11-04 用户裁定（DSH 式过程渲染）：推理与思考/工具调用/refusal 同一渲染语言 ——
 * 单行可折叠 chip（icon + label + 首行摘要 + chevron），展开看全文。
 */
import { computed } from "vue";
import { Brain } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import ProcessRow from "../ProcessRow.vue";

const props = defineProps<{
    content: string;
}>();

const { t } = useI18n();

/** 折叠行摘要 = 第一段非空文本（再截断，交给 ProcessRow 的 truncate）。 */
const summary = computed(() => {
    const line = props.content.split("\n").find((item) => item.trim());
    return line ? line.trim().slice(0, 80) : "";
});
</script>

<template>
    <ProcessRow
        kind="reasoning"
        :icon="Brain"
        :label="t('chat.reasoning')"
        :summary="summary"
        expandable
        testid="process-reasoning"
    >
        <div class="whitespace-pre-wrap leading-relaxed text-muted-foreground">{{ content }}</div>
    </ProcessRow>
</template>
