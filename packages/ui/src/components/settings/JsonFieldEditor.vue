<script setup lang="ts">
/**
 * task-286 —— JSON 字段编辑器：**加载即格式化 + 语法高亮**（判据 ①③）。
 *
 * 选型：**CodeMirror 6**。不是新引入 —— 本包已在生产用 CM6
 * （`composables/useCodeMirror.ts` + `cmTheme.ts` token 主题 + `CodeEditor.vue` /
 * `MarkdownEditor.vue`），此处只补同族唯一缺的 `@codemirror/lang-json`（6.0.2，MIT）。
 * 逐项对比与「开放性/可替换性」见 `docs/QaJsonEditorSelection.md`。
 *
 * 判据分工（关键）：
 * - **格式化决策在纯函数 `jsonFieldFormat.ts` 里**，可被单测逐字节钉住（判据 ②④）；
 * - **本组件只负责渲染与事件接线**，不含任何「怎么算合法 JSON」的判断。
 *   这样「非法原文不被改写」不是靠组件实现者的自觉，而是被 24 条单测锁住的。
 *
 * 「加载即格式化」的**时机**（易错点）：不是在 `onMounted` 里做。
 * `ConfigDomainPanel` 的草稿 `editing` 由 `watch(expanded, {immediate:true})` 初始化，
 * 而层数据是异步到达的 —— 挂载瞬间 `modelValue` 往往是 `""`（BL-625 已登记：
 * `ConfigDomainPanel` 无 `watch(props.entries)`，且父级用 `v-show` 保持挂载）。
 * 所以在 `onMounted` 格式化只会格式化一个空串。正确判据是**第一次拿到非空值的那一刻**
 * 格式化一次，之后不再自动重排（否则用户每敲一个字符都被重排 + 报错刷屏）。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { useCodeMirror } from "../../composables/useCodeMirror";
import { formatJsonText } from "./jsonFieldFormat";
import { jsonHighlighting } from "./jsonFieldHighlight";

const props = defineProps<{
    /** 字段当前草稿值（由父组件 `editing[key]` 提供）。 */
    modelValue: string;
    /** 控件 id（与 `controlId(field)` 一致，保持 label 关联）。 */
    controlId: string;
    /** 测试 id 前缀，形如 `config-json-<domain>-<key>`。 */
    testId: string;
    /** 禁用态（只读 / 无权限 / 层只读）。 */
    disabled?: boolean;
}>();

const emit = defineEmits<{
    "update:modelValue": [value: string];
}>();

const { t } = useI18n();

const host = ref<HTMLElement | null>(null);
/** 非法 JSON 的解析错误（判据 ②：提示，但**绝不改写原文**）。 */
const error = ref<string | null>(null);
/** 已经做过「加载即格式化」的那一次（只做一次，见文件头）。 */
let seeded = false;

/** 把 CM6 的当前文档整体替换成 `text`（不动外部 modelValue 的话由调用方决定）。 */
function replaceDoc(text: string): void {
    const v = view.value;
    if (!v) return;
    if (v.state.doc.toString() === text) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
}

/**
 * 判据 ①：**首次**拿到值 → 格式化成缩进态。
 * 判据 ②：解析失败 ⇒ `formatJsonText` 返回原文，这里把原文写进编辑器 + 显示错误，
 *          **一个字都不改**。
 */
function seedOnce(raw: string): void {
    if (seeded) return;
    if (raw === "") return; // 数据还没到（BL-625），等下一次
    seeded = true;
    const result = formatJsonText(raw);
    error.value = result.error;
    if (result.text !== raw) {
        replaceDoc(result.text);
        emit("update:modelValue", result.text);
    }
}

const { view, mount } = useCodeMirror({
    modelValue: computed(() => props.modelValue),
    readonly: computed(() => props.disabled ?? false),
    extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        json(),
        // task-286：lang-json 只负责解析，上色要主题给（cmTheme 是 Markdown 调的，
        // 与 @lezer/json 的 tag 只交集一个 `string`）。此处补 JSON 专用两级样式。
        jsonHighlighting,
        EditorView.lineWrapping,
    ],
    onChange: (value: string) => emit("update:modelValue", value),
});

onMounted(() => {
    mount(host.value);
    seedOnce(props.modelValue);
});

/** 外部值变化：首次非空即格式化；之后只同步错误态，不重排用户正在编辑的内容。 */
watch(
    () => props.modelValue,
    (next) => {
        if (!seeded) {
            seedOnce(next);
            return;
        }
        // 已被清空（handleReset）⇒ 错误一并清掉。
        if (next.trim() === "") error.value = null;
    },
);

/** 用户显式点「格式化」：失败仍保留原文 + 提示（判据 ②）。 */
function formatNow(): void {
    const v = view.value;
    const raw = v ? v.state.doc.toString() : props.modelValue;
    const result = formatJsonText(raw);
    error.value = result.error;
    if (result.error === null && v && result.text !== raw) {
        replaceDoc(result.text);
        emit("update:modelValue", result.text);
    }
}
</script>

<template>
    <div class="min-w-0 flex-1 flex flex-col gap-1">
        <div
            :id="controlId"
            ref="host"
            :data-testid="testId"
            class="min-w-0 border border-foreground/50 rounded bg-background overflow-auto max-h-64 text-sm"
            :aria-invalid="error ? 'true' : undefined"
        ></div>
        <div class="flex items-center gap-2">
            <p
                v-if="error"
                :data-testid="`${testId}-error`"
                class="min-w-0 flex-1 truncate text-xs text-destructive"
                :title="`${t('settings.jsonFieldInvalidDetail')}: ${error}`"
            >
                {{ t("settings.jsonFieldInvalid") }}
            </p>
            <p v-else class="min-w-0 flex-1 text-xs text-muted-foreground">
                {{ t("settings.jsonValid") }}
            </p>
            <button
                type="button"
                :data-testid="`${testId}-format`"
                class="shrink-0 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                :disabled="disabled"
                @click="formatNow"
            >
                {{ t("settings.jsonFormat") }}
            </button>
        </div>
    </div>
</template>
