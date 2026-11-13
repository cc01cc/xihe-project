<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { useCodeMirror } from "../../../composables/useCodeMirror";

const props = defineProps<{
    modelValue: string;
    language: string;
    readonly?: boolean;
}>();

const emit = defineEmits<{
    "update:modelValue": [value: string];
}>();

const host = ref<HTMLElement | null>(null);
const { doc, mount } = useCodeMirror({
    modelValue: computed(() => props.modelValue),
    readonly: computed(() => props.readonly ?? false),
    extensions: [lineNumbers(), history(), keymap.of([...defaultKeymap, ...historyKeymap])],
    onChange: (value) => emit("update:modelValue", value),
});

onMounted(() => mount(host.value));

/** 代码编辑不接语言包（现状 textarea 也无语法高亮）；`language` 仅用于头部标签。 */
const languageLabel = computed(() => props.language);
</script>

<template>
    <div data-testid="workspace-code-editor" class="flex flex-col h-full">
        <div class="flex items-center justify-between px-3 py-1 border-b bg-muted/30 shrink-0">
            <span class="text-xs font-mono text-muted-foreground">{{ languageLabel }}</span>
            <span class="text-xs text-muted-foreground">{{ doc.split("\n").length }} lines</span>
        </div>
        <div ref="host" class="flex-1 overflow-auto" />
    </div>
</template>
