<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { escapeHtml } from "@/lib/escapeHtml";
import { highlightCodeBlock } from "@/composables/useShiki";
import CodeBlock from "../CodeBlock.vue";

export interface CodeToken {
    lang: string;
    text: string;
}

const props = defineProps<{
    token: CodeToken;
}>();

const lang = computed(() => props.token.lang ?? "text"),
    code = computed(() => props.token.text ?? "");
const highlightedHtml = ref("");

// PLAN-0750 M1 → PLAN-0753 M1 (F1/F3, task-167 matrix): ONE highlight path for streaming and
// final states alike — the shiki singleton handles both; the per-token highlight.js streaming
// branch is gone (F3), so there is no mid-stream engine switch and no second highlighter
// lifecycle (F1). The request guard keeps a slow in-flight highlight from painting over a
// newer token state; a failure falls back to escaped plain text (shared F10 escape).
let requestSeq = 0;
watch(
    [code, lang],
    async ([nextCode, nextLang]) => {
        const seq = ++requestSeq;
        const html = await highlightCodeBlock(nextCode, nextLang);
        if (seq !== requestSeq) return;
        highlightedHtml.value = html ?? escapeHtml(nextCode);
    },
    { immediate: true },
);
</script>

<template>
    <CodeBlock :code="code" :lang="lang" :highlighted-html="highlightedHtml" />
</template>
