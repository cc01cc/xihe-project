import { flushPromises, mount } from "@vue/test-utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { computed, defineComponent, nextTick, ref } from "vue";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

/**
 * BL-476 L1 pilot contract for the vendored reka `Select`
 * (src/components/ui/select, provenance in src/components/ui/VENDOR.md).
 *
 * What this pins down — and what the native `<select>` this pilot replaced
 * could not give us:
 *  1. the trigger is a `role="combobox"` with `aria-expanded`, i.e. the
 *     collapsed/expanded state is machine readable;
 *  2. opening renders a real `role="listbox"` whose children are `role="option"`;
 *  3. Enter opens, `ArrowDown` moves the highlight, `Enter` commits, `Escape`
 *     closes without touching the value — the keyboard path is exercised here
 *     instead of a browser walkthrough (L0 tier: no stack, no host E2E).
 *
 * Note the `SelectValue` slot: reka 2.10.5 resolves the closed-state label from
 * `SelectItemText` nodes, which only exist once the popup has been mounted, so
 * call sites must feed the label themselves (ProviderHub does it from the same
 * option list). The harness mirrors that contract on purpose.
 */
const OPTIONS = [
    { value: "remote-models", label: "Provider /models" },
    { value: "litellm-catalog", label: "LiteLLM Catalog" },
    { value: "manual", label: "Manual" },
] as const;

const Harness = defineComponent({
    components: { Select, SelectContent, SelectItem, SelectTrigger, SelectValue },
    setup() {
        const value = ref<string>("remote-models");
        const label = computed(
            () => OPTIONS.find((option) => option.value === value.value)?.label ?? "",
        );
        return { label, value };
    },
    template: `
        <Select v-model="value">
            <SelectTrigger data-testid="select-trigger" aria-label="Model discovery">
                <SelectValue>
                    <span>{{ label }}</span>
                </SelectValue>
            </SelectTrigger>
            <SelectContent>
                <SelectItem v-for="option in OPTIONS" :key="option.value" :value="option.value">
                    {{ option.label }}
                </SelectItem>
            </SelectContent>
        </Select>
    `,
    data: () => ({ OPTIONS }),
});

function mountHarness() {
    return mount(Harness, { attachTo: document.body });
}

// jsdom has no layout engine: reka's scroll buttons call `scrollIntoView` on the
// highlighted option. Stub it for this file only and restore afterwards.
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn<(argCount?: number) => void>();
});

afterAll(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe("ui/select (vendored reka Select, BL-476 L1 pilot)", () => {
    it("renders a combobox trigger with collapsed ARIA state and the selected label", () => {
        const wrapper = mountHarness();
        const trigger = wrapper.get('[data-testid="select-trigger"]');

        expect(trigger.attributes("role")).toBe("combobox");
        expect(trigger.attributes("aria-expanded")).toBe("false");
        expect(trigger.attributes("aria-label")).toBe("Model discovery");
        expect(trigger.text()).toContain("Provider /models");
        // Closed: no listbox in the DOM yet.
        expect(wrapper.find('[role="listbox"]').exists()).toBe(false);

        wrapper.unmount();
    });

    it("opens the listbox with Enter and closes it again with Escape", async () => {
        const wrapper = mountHarness();
        const trigger = wrapper.get('[data-testid="select-trigger"]');

        await trigger.trigger("keydown", { key: "Enter" });

        const listbox = wrapper.find('[role="listbox"]');
        expect(listbox.exists()).toBe(true);
        expect(wrapper.get('[data-testid="select-trigger"]').attributes("aria-expanded")).toBe(
            "true",
        );
        expect(wrapper.findAll('[role="option"]')).toHaveLength(OPTIONS.length);

        await listbox.trigger("keydown", { key: "Escape" });

        expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="select-trigger"]').attributes("aria-expanded")).toBe(
            "false",
        );
        // Escape discarded the interaction: the selection is untouched.
        expect(wrapper.get('[data-testid="select-trigger"]').text()).toContain("Provider /models");

        wrapper.unmount();
    });

    it("moves the highlight with ArrowDown and commits it with Enter", async () => {
        const wrapper = mountHarness();
        const trigger = wrapper.get('[data-testid="select-trigger"]');

        await trigger.trigger("keydown", { key: "Enter" });
        const listbox = wrapper.get('[role="listbox"]');

        await listbox.trigger("keydown", { key: "ArrowDown" });
        // reka moves focus to the next option inside a `setTimeout`.
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
        await nextTick();

        const highlighted = wrapper.get('[role="option"][data-highlighted]');
        const highlightedLabel = highlighted.text();
        expect(highlightedLabel).not.toBe("");

        // Enter is handled by the focused option, exactly like a real keyboard user.
        await highlighted.trigger("keydown", { key: "Enter" });
        await flushPromises();
        await nextTick();

        expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="select-trigger"]').text()).toContain(highlightedLabel);

        wrapper.unmount();
    });
});
