import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import { i18n } from "../../../i18n";
import DelegationPolicyFields from "../DelegationPolicyFields.vue";
import { Input } from "../../ui/input";
import type { DelegationPolicyValue } from "../delegationPolicyValue";

/**
 * task-45：委派预算输入在真栈不可编辑（setter 收到 number/null 却直接 `raw.trim()`）。
 *
 * <p>崩溃链：宿主 `Input.vue` 是 `useVModel(passive)` + `<input type="number" v-model>`，
 * Vue 的 vModelText 对 number 输入 `looseToNumber` 后**回灌 number**（清空时为 null）；
 * `DelegationPolicyFields` 的两个 v-model 中介却按 string 处理。真栈表现是输入框里有值、
 * 但每次键入都抛 `TypeError: raw.trim is not a function`，`data-dirty` 恒 false、保存键恒禁。</p>
 *
 * <p>所以这里不测「字段渲没渲染」，而是按**入参三态**（number / string / null）咬住归一：
 * 前两态必须落成数字，null 必须落成未设置（空串）。number 态在修复前会直接抛异常。</p>
 */

function mountFields(modelValue: DelegationPolicyValue) {
    return mount(DelegationPolicyFields, {
        props: { modelValue },
        global: { plugins: [i18n] },
    });
}

function lastEmitted(wrapper: ReturnType<typeof mountFields>): DelegationPolicyValue {
    const events = wrapper.emitted("update:modelValue");
    expect(events).toBeTruthy();
    return events![events!.length - 1]![0] as DelegationPolicyValue;
}

describe("DelegationPolicyFields 输入归一（task-45）", () => {
    it("number 回灌：键入被 Vue 转成 number 时不得抛 TypeError，且落成数字", async () => {
        const wrapper = mountFields({ maxCount: null, maxDepth: null });
        const input = wrapper.find("#delegation-policy-max-count");
        (input.element as HTMLInputElement).value = "3";
        // 修复前：setter 收到 3（number）→ raw.trim() 抛 TypeError，测试在此变红
        await input.trigger("input");
        expect(lastEmitted(wrapper).maxCount).toBe(3);
        expect(typeof lastEmitted(wrapper).maxCount).toBe("number");
    });

    it("string 入参：带空白的字符串按 trim 归一后再转数字", async () => {
        const wrapper = mountFields({ maxCount: null, maxDepth: null });
        // 模拟宿主把原始 string 透传上来（例如 text 型 Input 的复用）
        await wrapper.findComponent(Input).vm.$emit("update:modelValue", " 7 ");
        expect(lastEmitted(wrapper).maxCount).toBe(7);
    });

    it("null 入参（清空）：落成未设置，输入框回空串", async () => {
        const wrapper = mountFields({ maxCount: 5, maxDepth: 2 });
        await wrapper.findComponent(Input).vm.$emit("update:modelValue", null);
        expect(lastEmitted(wrapper).maxCount).toBeNull();
        await wrapper.setProps({ modelValue: { maxCount: null, maxDepth: 2 } });
        expect(
            (wrapper.find("#delegation-policy-max-count").element as HTMLInputElement).value,
        ).toBe("");
    });

    it("两半同填同清：清空一半后校验转红（契约不变）", async () => {
        const wrapper = mountFields({ maxCount: 5, maxDepth: 2 });
        expect(wrapper.find('[data-testid="delegation-policy-invalid"]').exists()).toBe(false);
        await wrapper.findComponent(Input).vm.$emit("update:modelValue", null);
        await wrapper.setProps({ modelValue: { maxCount: null, maxDepth: 2 } });
        expect(wrapper.find('[data-testid="delegation-policy-invalid"]').exists()).toBe(true);
    });
});
