import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import RecipientField from "../components/RecipientField.vue";
import type { SessionParticipantView } from "../../../../types/participant";

/**
 * 2026-11-04 用户裁定（五裁落地）：composer 的 TO/CC 从原生 select 改为「输入 + 候选浮层」。
 * 本文件钉 RecipientField 的三条交互契约：
 * ① typeahead 选择（过滤 → 点选 / ↑↓+Enter，Tab 补全，Esc 关闭）；
 * ② chips 单选上限（发送栏 multiple=false：新提交替换旧值，× 与 Backspace 可移除）；
 * ③ 自由输入兜底（解析不到的名字留在输入框 + 提示，**绝不静默丢弃**）。
 *
 * 空格结束一个名字（可连续输入多个）也是输入面的一部分，落在③ 的分词路径。
 */
const i18n = createI18n({
    legacy: false,
    locale: "zh",
    messages: {
        zh: {
            chat: {
                input: {
                    recipientRemove: "移除",
                    recipientUnknown: "没有找到这个成员",
                    recipientHint: "↑↓ 选择 · Enter 确认 · Tab 补全 · Esc 关闭",
                },
            },
            workspace: { participantUnknownName: "未知成员" },
        },
    },
});

function candidate(id: string, name: string): SessionParticipantView {
    return { participantId: id, displayName: name, role: "MEMBER" } as SessionParticipantView;
}

const ROSTER = [candidate("id-lin", "林可"), candidate("id-zhou", "周衡")];

function mountField(
    props: {
        modelValue?: string[];
        multiple?: boolean;
        candidates?: SessionParticipantView[];
    } = {},
) {
    return mount(RecipientField, {
        props: {
            label: "发送",
            modelValue: props.modelValue ?? [],
            candidates: props.candidates ?? ROSTER,
            multiple: props.multiple ?? false,
            testid: "cc",
            placeholder: "输入名字…",
        },
        global: { plugins: [i18n] },
    });
}

describe("RecipientField — typeahead 选择", () => {
    it("filters candidates while typing and commits the clicked option", async () => {
        const wrapper = mountField();
        const input = wrapper.get('[data-testid="cc-input"]');

        await input.setValue("林");
        const menu = wrapper.get('[data-testid="cc-menu"]');
        expect(menu.findAll('[data-testid="cc-option"]')).toHaveLength(1);
        expect(menu.text()).toContain("林可");

        await menu.get('[data-testid="cc-option"]').trigger("click");
        expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([["id-lin"]]);
        // 提交后查询清空、浮层关闭（chip 接管展示）。
        expect((input.element as HTMLInputElement).value).toBe("");
        expect(wrapper.find('[data-testid="cc-menu"]').exists()).toBe(false);
    });

    it("supports the keyboard contract: ↓+Enter commits, Tab completes, Esc closes", async () => {
        const wrapper = mountField();
        const input = wrapper.get('[data-testid="cc-input"]');

        await input.setValue("林");
        await input.trigger("keydown", { key: "ArrowDown" });
        await input.trigger("keydown", { key: "Enter" });
        expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([["id-lin"]]);

        await input.setValue("周");
        await input.trigger("keydown", { key: "Tab" });
        // Tab 补全把选中项名字写进输入框（不提交）。
        expect((input.element as HTMLInputElement).value).toBe("周衡");
        expect(wrapper.find('[data-testid="cc-menu"]').exists()).toBe(true);

        await input.trigger("keydown", { key: "Escape" });
        expect(wrapper.find('[data-testid="cc-menu"]').exists()).toBe(false);
    });
});

describe("RecipientField — chips 上限与移除", () => {
    it("single-select (发送栏) replaces the previous chip instead of accumulating", async () => {
        const wrapper = mountField({ modelValue: ["id-zhou"] });
        const input = wrapper.get('[data-testid="cc-input"]');

        await input.setValue("林");
        await input.trigger("keydown", { key: "Enter" });

        // 上限 = 1：新提交是替换，不是追加。
        expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([["id-lin"]]);
    });

    it("removes a chip with × and with Backspace on an empty input", async () => {
        const wrapper = mountField({ modelValue: ["id-lin", "id-zhou"] });
        expect(wrapper.findAll('[data-testid="cc-chip"]')).toHaveLength(2);

        await wrapper.findAll('[data-testid="cc-chip-remove"]')[0]!.trigger("click");
        expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([["id-zhou"]]);

        // 测试宿主不会自动把 emit 回流进 props，先 setProps 跟上（真实父组件会）。
        await wrapper.setProps({ modelValue: ["id-zhou"] });
        const input = wrapper.get('[data-testid="cc-input"]');
        await input.trigger("keydown", { key: "Backspace" });
        expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([[]]);
    });
});

describe("RecipientField — 自由输入兜底", () => {
    it("keeps an unresolved name in the input and shows the hint instead of dropping it", async () => {
        const wrapper = mountField();
        const input = wrapper.get('[data-testid="cc-input"]');

        await input.setValue("张三");
        await input.trigger("keydown", { key: "Enter" });

        // 没有 chip 被提交 —— 打错的名字绝不能看起来像已发送。
        expect(wrapper.emitted("update:modelValue")).toBeUndefined();
        expect((input.element as HTMLInputElement).value).toBe("张三");
        expect(wrapper.get('[data-testid="cc-unknown"]').text()).toContain("没有找到这个成员");
    });

    it("space commits resolved tokens and keeps the unresolved ones", async () => {
        const wrapper = mountField({ multiple: true });
        const input = wrapper.get('[data-testid="cc-input"]');

        await input.setValue("林可 张三");
        await input.trigger("keydown", { key: " " });

        // 解析到的进了 chips，没解析到的留在输入框（绝不静默丢弃）。
        // 注：多 token 重放后 query 变化会触发 watch(query) 清掉 unknownHint，提示的
        // "驻留"契约由上面的单 token 用例钉住；这里只钉分词与不丢字。
        expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([["id-lin"]]);
        expect((input.element as HTMLInputElement).value).toBe("张三");
        await flushPromises();
    });
});
