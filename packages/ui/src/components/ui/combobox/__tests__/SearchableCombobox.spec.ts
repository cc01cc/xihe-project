import { flushPromises, mount } from "@vue/test-utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defineComponent, nextTick, ref } from "vue";

import { SearchableCombobox, type SearchableComboboxOption } from "../index";

/**
 * task-152：>8 项选择器统一载体的契约测试。
 *
 * 覆盖四件本卡真正承诺的事：
 *  1. 收起态是「触发器 + 当前标签」，和 Select 的观感一致（调用点不需要自己拼 label）；
 *  2. 展开后渲染全部选项（24 项这类长列表不再靠调用点 `min-w-*` 撑宽）；
 *  3. 面板自带搜索框，输入即收敛（这是它替代 Select + min-w 覆写的理由）；
 *  4. 点选后 emits update:modelValue 并收起，触发器显示新标签。
 */
const OPTIONS: SearchableComboboxOption[] = Array.from({ length: 24 }, (_, index) => ({
    value: `status-${index}`,
    label: `状态 ${index + 1}`,
}));

const Harness = defineComponent({
    components: { SearchableCombobox },
    setup() {
        const value = ref<string>("status-0");
        return { OPTIONS, value };
    },
    template: `
        <SearchableCombobox
            v-model="value"
            :options="OPTIONS"
            placeholder="全部状态"
            empty-text="没有匹配项"
            search-placeholder="搜索状态"
            testid="searchable-combobox"
        />
    `,
});

function mountHarness() {
    return mount(Harness, { attachTo: document.body });
}

// jsdom 没有布局引擎：reka 在展开/高亮时会调 scrollIntoView。
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn<(argCount?: number) => void>();
});

afterAll(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
});

function bodyQuery(selector: string): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(selector);
}

function bodyQueryAll(selector: string): HTMLElement[] {
    return Array.from(document.body.querySelectorAll<HTMLElement>(selector));
}

async function openPanel(wrapper: ReturnType<typeof mountHarness>) {
    await wrapper.get('[data-testid="searchable-combobox"]').trigger("click");
    await flushPromises();
    await nextTick();
}

describe("ui/combobox SearchableCombobox (task-152)", () => {
    it("renders the collapsed trigger with the selected label", () => {
        const wrapper = mountHarness();
        const trigger = wrapper.get('[data-testid="searchable-combobox"]');

        expect(trigger.attributes("aria-expanded")).toBe("false");
        expect(trigger.text()).toContain("状态 1");
        expect(bodyQuery('[role="listbox"]')).toBeNull();

        wrapper.unmount();
    });

    it("opens a searchable panel listing every option, including long lists", async () => {
        const wrapper = mountHarness();
        await openPanel(wrapper);

        expect(bodyQuery('[role="listbox"]')).not.toBeNull();
        expect(bodyQueryAll('[role="option"]')).toHaveLength(OPTIONS.length);
        expect(bodyQuery('[data-testid="searchable-combobox-input"]')).not.toBeNull();

        wrapper.unmount();
    });

    it("filters the list as the user types in the panel search box", async () => {
        const wrapper = mountHarness();
        await openPanel(wrapper);

        const input = bodyQuery('[data-testid="searchable-combobox-input"]') as HTMLInputElement;
        input.value = "状态 24";
        input.dispatchEvent(new Event("input"));
        await flushPromises();
        await nextTick();

        const options = bodyQueryAll('[role="option"]');
        expect(options).toHaveLength(1);
        expect(options[0]?.textContent).toContain("状态 24");

        wrapper.unmount();
    });

    it("emits update:modelValue on select, closes the panel and shows the new label", async () => {
        const wrapper = mountHarness();
        await openPanel(wrapper);

        const target = bodyQueryAll('[role="option"]').find((option) =>
            (option.textContent ?? "").includes("状态 7"),
        );
        expect(target).toBeTruthy();
        target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flushPromises();
        await nextTick();

        const inner = wrapper.findComponent(SearchableCombobox);
        expect(inner.emitted("update:modelValue")?.at(-1)).toEqual(["status-6"]);
        expect(bodyQuery('[role="listbox"]')).toBeNull();
        expect(wrapper.get('[data-testid="searchable-combobox"]').text()).toContain("状态 7");

        wrapper.unmount();
    });

    it("shows the empty state when the search matches nothing", async () => {
        const wrapper = mountHarness();
        await openPanel(wrapper);

        const input = bodyQuery('[data-testid="searchable-combobox-input"]') as HTMLInputElement;
        input.value = "不存在的状态";
        input.dispatchEvent(new Event("input"));
        await flushPromises();
        await nextTick();

        expect(bodyQueryAll('[role="option"]')).toHaveLength(0);
        expect(document.body.textContent ?? "").toContain("没有匹配项");

        wrapper.unmount();
    });
});
