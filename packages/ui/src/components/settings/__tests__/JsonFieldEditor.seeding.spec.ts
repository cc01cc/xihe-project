/**
 * task-34：`JsonFieldEditor` 的**格式化时机**判据（两条，各自被一个变异钉住）。
 *
 * <p>为什么单开一个 spec：这两条判的是组件的**时机语义**，与任何调用方无关。
 * 放进面板 spec 会被「面板怎么装配」的细节掩埋；这也正是 Lead 指出的缺口 ——
 * 原状是「格式化一次」这条规则**没有任何用例**，删掉它、或改成「每次都格式化」都不会红。</p>
 */
import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import JsonFieldEditor from "../JsonFieldEditor.vue";
import { jsonDocText, setJsonDoc } from "./jsonEditorAsserts";

function mountEditor(modelValue: string) {
    const i18n = createI18n({
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
    return mount(JsonFieldEditor, {
        props: { modelValue, controlId: "json-host", testId: "json-field" },
        global: { plugins: [i18n] },
    });
}

describe("JsonFieldEditor 格式化时机", () => {
    /**
     * 判据 ①（D-1455 缺口）：**首次拿到非空值即格式化**。
     * 变异：把 `seedOnce` 的 seeded 判断变成直接 return ⇒ 本条必须红。
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
     * 判据 ②（防止「每次变化都格式化」把它改坏）：用户手工排版后**不被重写**。
     * 变异：让 watch 每次都调 seedOnce（去掉 seeded 短路）⇒ 本条必须红。
     */
    it("首次格式化之后，用户手动排版的内容不被重写", async () => {
        const raw = '{"b":1,"a":[1,2]}';
        const wrapper = mountEditor(raw);
        await flushPromises();

        // 用户按自己的习惯排（空行 + 奇数缩进 + 行尾空格），这不是 2 空格缩进态。
        const handcrafted = '{\n\n   "b": 1 ,\n   "a": [1, 2]   \n}';
        setJsonDoc(wrapper, "json-field", handcrafted);
        await flushPromises();
        await flushPromises();

        expect(jsonDocText(wrapper, "json-field")).toBe(handcrafted);
    });
});
