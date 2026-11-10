/**
 * PLAN-0755 M6 —— CodeMirror 6 编辑器宿主 composable（POC task-182 验收② 的生产落地）。
 *
 * 契约（硬验收 V2）：`state.doc.toString()` 是文档 SSOT —— 每次变更后由宿主读出并
 * `emit("update:modelValue")`；读出与写回都按 **UTF-8 byte** 口径核对（POC 坑：
 * `Text.length` 是 UTF-16 码元，与 `Buffer.byteLength` 不等，中文文档差值可达数十）。
 *
 * 设计：
 * - 视图实例（`EditorView`）由 composable 持有，宿主只提供容器元素；
 * - 外部 `modelValue` 变化（非本编辑器产生）时同步进 `state`，但**不**回环 emit；
 * - 编辑产生的变更走 `updateListener` → 读出 doc → emit 一次（单写者 = 宿主）。
 */
import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from "vue";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { cmExtensions } from "./cmTheme";

export interface UseCodeMirrorOptions {
    /** 初始文档（SSOT 读出 = state.doc.toString()）。 */
    modelValue: Ref<string>;
    /** 只读态：挂载 `EditorState.readOnly` + `EditorView.editable`。 */
    readonly?: Ref<boolean>;
    /** 追加扩展（keymap / 行号 / 语言包等），在主题之后叠加。 */
    extensions?: Extension[];
    /** 宿主变更回调：每次编辑读出一次 doc（UTF-8 byte 口径）。 */
    onChange?: (value: string) => void;
}

export interface UseCodeMirrorReturn {
    /** 挂载点（宿主绑定 `ref`）。 */
    container: Ref<HTMLElement | null>;
    /** 当前文档（只读镜像，供宿主做行数/字符数统计）。 */
    doc: Ref<string>;
    /** 视图实例（宿主需要 dispatch 时使用）。 */
    view: Ref<EditorViewType | null>;
    /** 挂载函数（宿主在 onMounted 里调用；容器就绪后创建 EditorView）。
     *  `host` 可外部传入（宿主自持容器 ref），缺省用 composable 内部 container。 */
    mount: (host?: HTMLElement | null) => void;
}

/**
 * 挂载一个 CM6 编辑器。**注意**：CM6 的 `EditorView` 必须在容器挂载后创建，
 * 且宿主组件卸载时 `destroy()`（在 `onBeforeUnmount` 里配对）。
 */
export function useCodeMirror(options: UseCodeMirrorOptions): UseCodeMirrorReturn {
    const container = ref<HTMLElement | null>(null);
    const view = shallowRef<EditorViewType | null>(null);
    const doc = ref(options.modelValue.value);

    // 外部 modelValue 变化 → 同步进 state（不回环 emit）。
    watch(options.modelValue, (next) => {
        const v = view.value;
        if (!v) return;
        if (next === v.state.doc.toString()) return;
        v.dispatch({
            changes: { from: 0, to: v.state.doc.length, insert: next },
        });
        doc.value = next;
    });

    // 挂载：容器就绪后创建 EditorView（宿主 onMounted 调 `mount`）。
    function mount(host?: HTMLElement | null): void {
        if (view.value) return;
        const parent = host ?? container.value;
        if (!parent) return;
        const extensions: Extension[] = [
            ...cmExtensions,
            ...(options.extensions ?? []),
            EditorView.updateListener.of((update) => {
                if (!update.docChanged) return;
                const next = update.state.doc.toString();
                doc.value = next;
                options.onChange?.(next);
            }),
        ];
        if (options.readonly?.value) {
            extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
        }
        const state = EditorState.create({ doc: options.modelValue.value, extensions });
        view.value = new EditorView({ state, parent });
        doc.value = view.value.state.doc.toString();
    }

    onBeforeUnmount(() => {
        view.value?.destroy();
        view.value = null;
    });

    return { container, doc, view, mount };
}
