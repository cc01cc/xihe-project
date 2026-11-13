/**
 * task-286 · json 字段断言的**新入口**（供旧的 `textarea` 断言翻面用）。
 *
 * ## 为什么需要这个文件
 *
 * `approval-policy.askActionClasses` 是 `type: "json"` 字段，原先渲染成裸 `<textarea>`，
 * 于是旧断言统一写成 `wrapper.find('[data-testid="config-field-…"] textarea').setValue(…)`。
 * task-286 把这个字段换成 **CodeMirror 6**（`JsonFieldEditor`）之后：
 *
 * | 旧 | 新 |
 * | --- | --- |
 * | testid `config-field-<domain>-<key>` | testid `config-json-<domain>-<key>`（挂在**外层容器**上） |
 * | `<textarea>` 元素 | `.cm-editor` 子树 |
 * | `el.value`（可读可写） | **没有这个属性** —— 文档是 `EditorState.doc` |
 * | `setValue()` | `view.dispatch({ changes })` |
 *
 * ## 为什么是「翻面」而不是「放松」
 *
 * 断言强度**没有变**：原来断言的是「往这个字段写进去的值，会原样进 PUT body」，
 * 现在断言的是**同一件事**，只是入口从 `textarea.value` 换成 `EditorState.doc`。
 * 两者的共同性质是「**用户实际键入的内容**」—— 换成更弱的写法（比如只断言编辑器存在、
 * 或者用 `getByRole("textbox")` 泛化匹配）会让「写进去的值对不对」这条判据消失，
 * 那才是削弱（判据见 `internal/A03-xihe/docs/spec-assertion-strength.md` 的 C1 类）。
 *
 * ## 为什么用 `EditorView.findFromDOM`
 *
 * 这是 `@codemirror/view` 的**官方**反查入口（不是 DOM hack、不是给产品组件开测试专用 prop）。
 * 备选方案都被否决：
 * - 给 `JsonFieldEditor` 加 `defineExpose({ view })` ⇒ 产品代码为测试开后门；
 * - 手动派发 `beforeinput`/`input` 事件 ⇒ CM6 的输入处理要 selection/Range 几何，jsdom 下不稳；
 * - 读 `.cm-content` 的 `textContent` ⇒ **行与行之间的换行会丢**（每行是独立 `div`），
 *   实测 `{\n  "a": 1\n}` 的 `textContent` 是 `{  "a": 1}` —— 用它断言格式会被静默骗过。
 */
import type { VueWrapper } from "@vue/test-utils";
import { EditorView } from "@codemirror/view";

/** 取 json 字段的 CodeMirror `EditorView`；找不到就抛（不许静默返回 undefined 让后续断言变成假绿）。 */
export function jsonEditorView(wrapper: VueWrapper, testId: string): EditorView {
    const host = wrapper.find(`[data-testid="${testId}"]`);
    if (!host.exists()) throw new Error(`找不到 json 字段容器 [data-testid="${testId}"]`);
    const view = EditorView.findFromDOM(host.element as HTMLElement);
    if (!view) throw new Error(`[data-testid="${testId}"] 里没有挂载 CodeMirror EditorView`);
    return view;
}

/**
 * 断言编辑器当前**文档文本**（= 用户敲进去的内容，也是会进 PUT body 的那个字符串）。
 *
 * 注意比对的是**完整文档字符串**（含换行与缩进），不是 `textContent`：
 * 格式化后的文档是 `{\n  "x": 1\n}`，用 `textContent` 会被压成 `{  "x": 1}`。
 */
export function jsonDocText(wrapper: VueWrapper, testId: string): string {
    return jsonEditorView(wrapper, testId).state.doc.toString();
}

/**
 * 把字段内容替换成 `text`（等价于旧 `textarea.setValue(text)`）。
 *
 * 用一次 `changes` 事务整段替换，而不是模拟逐字键入：本组 spec 判的是
 * 「写进去的值会不会原样进 PUT body」，不是输入法/组合键行为（那要 Playwright）。
 */
export function setJsonDoc(wrapper: VueWrapper, testId: string, text: string): void {
    const view = jsonEditorView(wrapper, testId);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}
