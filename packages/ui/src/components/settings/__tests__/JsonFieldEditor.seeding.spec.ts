/**
 * task-34：`JsonFieldEditor` 的**格式化时机**判据（两条，各自被一个变异钉住）。
 *
 * <p>为什么单开一个 spec：这两条判的是组件的**时机语义**，与任何调用方无关。
 * 放进面板 spec 会被「面板怎么装配」的细节掩埋。</p>
 *
 * <p>**第二条为什么必须用「回声宿主」**（D-1494）：格式化是发生在
 * `watch(() => props.modelValue)` 里的 —— 只有**父级把值回灌**时那条分支才会走到。
 * 用静态 props 挂载（本文件最初就是这么写的）时，用户输入只到 emit 就断了，
 * 于是「每次值变化都格式化」这个变异**观测不到**、断言假绿。所以这里用一个内联宿主
 * 真 `v-model` 绑住编辑器，等价于面板里的 `v-model="selected.bodySource"`。</p>
 */
import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { createI18n } from "vue-i18n";
import JsonFieldEditor from "../JsonFieldEditor.vue";
import { jsonDocText, setJsonDoc } from "./jsonEditorAsserts";

function testI18n() {
    return createI18n({
        legacy: false,
        locale: "zh-Hans",
        missingWarn: false,
        fallbackWarn: false,
        messages: {
            "zh-Hans": {
                settings: {
                    jsonValid: "合法",
                    jsonInvalid: "非法",
                    jsonFieldInvalid: "非法",
                    jsonFieldInvalidDetail: "详情",
                    jsonFormat: "格式化",
                },
            },
        },
    });
}

function mountEditor(modelValue: string) {
    return mount(JsonFieldEditor, {
        props: { modelValue, controlId: "json-host", testId: "json-field" },
        global: { plugins: [testI18n()] },
    });
}

/** 回声宿主：`v-model` 真的把值回灌给编辑器（静态 props 挂载做不到这一点）。 */
function mountWithEcho(initial: string) {
    const host = defineComponent({
        components: { JsonFieldEditor },
        setup() {
            const value = ref(initial);
            return { value };
        },
        template: '<JsonFieldEditor v-model="value" control-id="json-host" test-id="json-field" />',
    });
    return mount(host, { global: { plugins: [testI18n()] } });
}

describe("JsonFieldEditor 格式化时机", () => {
    /**
     * 判据 ①（D-1455 缺口）：**首次拿到非空值即格式化**。
     * 变异：`seedOnce` 里加 `return`（关掉首次格式化）⇒ 本条必须红。
     */
    it("首次拿到非空值即按 2 空格格式化", async () => {
        const compact = '{"b":1,"a":[1,2]}';
        const wrapper = mountEditor(compact);
        await flushPromises();

        const text = jsonDocText(wrapper, "json-field");
        expect(text).toBe(JSON.stringify(JSON.parse(compact), null, 2));
        expect(text.split("\n")[1]).toMatch(/^ {2}"/);
        // 格式化结果必须**上行**给调用方，否则保存的还是压成一行的原文。
        const emitted = wrapper.emitted("update:modelValue");
        expect(emitted?.[0]?.[0]).toBe(JSON.stringify(JSON.parse(compact), null, 2));
    });

    /**
     * 判据 ②：用户手工排版后**不被重写**（区分「格式化一次」与「格式化每次」）。
     *
     * <p>变异：去掉 `seedOnce` 的 seeded 短路 + watch 恒调 seedOnce（= 每次值变化都格式化）
     * ⇒ 本条必须红。**必须用回声宿主**，否则变异落在一条本用例走不到的分支上（假绿，D-1494）。</p>
     */
    it("首次格式化之后，用户手动排版的内容经父级回灌仍不被重写", async () => {
        const wrapper = mountWithEcho('{"b":1,"a":[1,2]}');
        await flushPromises();
        // 首屏已被格式化，说明 seeding 确实发生过（否则下面「没被重写」是因为压根没格式化过）。
        expect(jsonDocText(wrapper, "json-field")).toBe(
            JSON.stringify({ b: 1, a: [1, 2] }, null, 2),
        );

        // 用户按自己的习惯排（空行 + 奇数缩进 + 行尾空格），这不是 2 空格缩进态。
        const handcrafted = '{\n\n   "b": 1 ,\n   "a": [1, 2]   \n}';
        setJsonDoc(wrapper, "json-field", handcrafted);
        await flushPromises();
        await flushPromises();

        expect(jsonDocText(wrapper, "json-field")).toBe(handcrafted);
    });
});
