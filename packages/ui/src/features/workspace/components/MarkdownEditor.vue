<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Bold, Code, Heading, Italic, Link, List } from "@lucide/vue";
import MarkdownRender from "markstream-vue";
import { useCodeMirror } from "../../../composables/useCodeMirror";

const props = defineProps<{
    modelValue: string;
    readonly?: boolean;
}>();

const emit = defineEmits<{
    "update:modelValue": [value: string];
}>();

const showSource = ref(true);

const extensions = computed(() => [
    lineNumbers(),
    history(),
    markdown(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
]);

const host = ref<HTMLElement | null>(null);
const { doc, view, mount } = useCodeMirror({
    modelValue: computed(() => props.modelValue),
    readonly: computed(() => props.readonly ?? false),
    extensions: extensions.value,
    onChange: (value) => emit("update:modelValue", value),
});

onMounted(() => mount(host.value));

/** 工具条动作：在文档末尾追加片段（与旧 textarea 行为一致）。 */
function append(snippet: string) {
    const v = view.value;
    if (!v) return;
    const end = v.state.doc.length;
    v.dispatch({ changes: { from: end, insert: snippet } });
    v.focus();
}
</script>

<template>
    <div class="flex flex-col h-full">
        <div class="flex items-center gap-1 px-2 py-1.5 border-b bg-muted/30 shrink-0">
            <button
                class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
                :disabled="readonly"
                title="粗体"
                @click="append('**bold**')"
            >
                <Bold class="size-3.5" aria-hidden="true" />
            </button>
            <button
                class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
                :disabled="readonly"
                title="斜体"
                @click="append('*italic*')"
            >
                <Italic class="size-3.5" aria-hidden="true" />
            </button>
            <button
                class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
                :disabled="readonly"
                title="标题"
                @click="append('\n## heading')"
            >
                <Heading class="size-3.5" aria-hidden="true" />
            </button>
            <button
                class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
                :disabled="readonly"
                title="代码"
                @click="append('\n```\ncode\n```')"
            >
                <Code class="size-3.5" aria-hidden="true" />
            </button>
            <button
                class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
                :disabled="readonly"
                title="链接"
                @click="append('[text](url)')"
            >
                <Link class="size-3.5" aria-hidden="true" />
            </button>
            <button
                class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
                :disabled="readonly"
                title="列表"
                @click="append('\n- item')"
            >
                <List class="size-3.5" aria-hidden="true" />
            </button>
            <div class="flex-1" />
            <button
                class="p-1 rounded hover:bg-accent text-muted-foreground text-xs"
                @click="showSource = !showSource"
            >
                {{ showSource ? "预览" : "源码" }}
            </button>
        </div>

        <!-- CM6 容器常驻（挂载后不销毁）；预览用 v-show 切换，避免视图重建。 -->
        <div v-show="showSource" ref="host" class="flex-1 overflow-auto" />
        <div v-if="!showSource" class="flex-1 overflow-y-auto p-4 prose prose-sm max-w-none">
            <MarkdownRender mode="chat" :content="doc" :final="true" custom-id="xihe" />
        </div>

        <div class="px-3 py-1 text-xs text-muted-foreground border-t shrink-0 flex justify-between">
            <span>{{ doc.split("\n").length }} lines</span>
            <span>{{ doc.length }} chars</span>
        </div>
    </div>
</template>
